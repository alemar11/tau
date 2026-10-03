import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, lstatSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { OpenspacePaths } from "../paths.ts";
import { FrameDecoder, MAX_OUTPUT_BYTES, writeFrame } from "../protocol/framing.ts";
import { envelope, FEATURES, parseRequest, ProtocolError } from "../protocol/messages.ts";
import { LEASE_CHECKPOINT_MS, LeaseStorageError, LeaseStore, type LeaseOptions } from "../registry/leases.ts";
import { SessionRegistry, type Mutation, type Transition } from "../registry/registry.ts";
import { project, RegistryError, type SessionInfo } from "../registry/session.ts";
import { acquireClaim, identity, prepareRuntime, privateSocket, sameFile, unlinkOwned } from "./runtime-files.ts";
import { probeBroker } from "./probe.ts";

import { systemClock, type Clock } from "../clock.ts";
export { systemClock, type Clock } from "../clock.ts";
export const BROKER_LIMITS = {
  idleMs: 5_000, registrationMs: 1_000, unregistered: 32, registered: 128,
  rateCapacity: 240, ratePerSecond: 120, outputBytes: MAX_OUTPUT_BYTES,
};
export interface BrokerOptions { clock?: Clock; limits?: Partial<typeof BROKER_LIMITS>; leases?: LeaseOptions }
export interface Broker { readonly instanceId: string; readonly closed: Promise<void>; stop(): Promise<void> }
interface Peer { socket: Socket; active: boolean; close(): void; reject(code: string, requestId?: string): void }

export async function startBroker(paths: OpenspacePaths, options: BrokerOptions = {}): Promise<Broker> {
  prepareRuntime(paths);
  const clock = options.clock ?? systemClock;
  const limits = { ...BROKER_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 31 - 1) throw new Error(`Invalid broker limit: ${key}`);
  }
  const pidPath = join(paths.runtimeDir, "broker.pid");
  const claim = acquireClaim(pidPath);
  if (!claim) throw new Error("Openspace broker owner is still alive; refusing to replace it");
  const ownedSocket = privateSocket(paths.runtimeDir, claim.owner);
  let socketIdentity: ReturnType<typeof identity>;
  const peers = new Map<string, Peer>();
  let registry: SessionRegistry;
  let unregistered = 0;
  let cancelIdle: (() => void) | undefined;
  let cancelCheckpoint: (() => void) | undefined;
  let stopping = false;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  // Startup can fail before a caller receives the handle.
  void closed.catch(() => {});

  function presence(endpoint: string, before?: SessionInfo, after?: SessionInfo) {
    const peer = peers.get(endpoint);
    if (!peer?.active || JSON.stringify(before) === JSON.stringify(after)) return;
    const event = after ? { event: before ? "updated" : "joined", session: after }
      : before ? { event: "left", id: before.id, endpointEpoch: before.endpointEpoch } : undefined;
    if (!event) return;
    try { writeFrame(peer.socket, { ...envelope("presence"), ...event }, limits.outputBytes); }
    catch { peer.socket.destroy(); }
  }
  function publish(change?: Transition) {
    if (!change || stopping) return;
    if (change.previousEndpoint && change.endpoint && change.previousEndpoint !== change.endpoint) {
      peers.get(change.previousEndpoint)?.reject(change.kind === "resume" ? "connection_replaced" : "endpoint_replaced");
    }
    for (const endpoint of registry.connections()) {
      const viewer = registry.session(endpoint);
      if (endpoint === change.endpoint) {
        // The changing peer needs visibility deltas for all other peers. Its own
        // record already arrived in the correlated acknowledgement, before events.
        if (change.kind === "workgroups" && change.before && change.after) {
          for (const other of registry.connections()) {
            if (other === endpoint) continue;
            const info = registry.session(other);
            presence(endpoint, project(change.before, info), project(change.after, info));
          }
        }
      } else {
        presence(endpoint, change.previousEndpoint && change.before ? project(viewer, change.before) : undefined,
          change.after ? project(viewer, change.after) : undefined);
      }
    }
  }
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    if (stopping || unregistered >= limits.unregistered || peers.size >= limits.registered + limits.unregistered) {
      socket.destroy(); return;
    }
    const endpoint = randomUUID();
    let closing = false;
    let cancelClose: (() => void) | undefined;
    const send = (value: unknown) => writeFrame(socket, value, limits.outputBytes);
    const peer: Peer = { socket, active: false,
      close() {
        if (closing) return;
        closing = true;
        socket.end();
        cancelClose = clock.after(100, () => socket.destroy());
      },
      reject(code, requestId) {
        if (closing) return;
        try { send({ ...envelope("error", requestId), code }); }
        catch { socket.destroy(); }
        this.close();
      },
    };
    peers.set(endpoint, peer);
    unregistered++;
    const cancelRegistration = clock.after(limits.registrationMs, () => socket.destroy());
    let tokens = limits.rateCapacity;
    let lastRefill = clock.now();
    const decoder = new FrameDecoder();
    socket.on("close", () => {
      peers.delete(endpoint);
      cancelRegistration();
      cancelClose?.();
      if (peer.active) { publish(registry.disconnect(endpoint)); armIdle(); }
      else unregistered--;
    });
    socket.on("data", (bytes: Buffer) => {
      if (closing || stopping) return;
      try {
        decoder.push(bytes, (value) => {
          const now = clock.now();
          tokens = Math.min(limits.rateCapacity, tokens + Math.max(0, now - lastRefill) * limits.ratePerSecond / 1000);
          lastRefill = now;
          if (tokens < 1) { socket.destroy(); return false; }
          tokens--;
          const request = parseRequest(value);
          try {
            if (request.type === "health") {
              send({ ...envelope("health_result", request.requestId), pid: process.pid,
                instanceId: claim.owner.token, features: FEATURES });
            } else if (request.type === "prepare") {
              if (peer.active) { peer.reject("already_registered", request.requestId); return false; }
              send({ ...envelope("prepared", request.requestId), lease: registry.prepare(request.id) });
            } else if (request.type === "register") {
              if (peer.active) { peer.reject("already_registered", request.requestId); return false; }
              const result = registry.register(endpoint, request.session, request.workgroups, request.lease, request.mode);
              peer.active = true;
              unregistered--;
              cancelRegistration();
              cancelIdle?.(); cancelIdle = undefined;
              try { send({ ...envelope("registered", request.requestId), session: result.session, features: FEATURES }); }
              finally { publish(result.transition); }
            } else if (!peer.active) {
              peer.reject("registration_required", request.requestId); return false;
            } else {
              registry.session(endpoint); // Fence every operation against the current socket owner.
              let mutation: Mutation | undefined;
              switch (request.type) {
                case "ping": send(envelope("pong", request.requestId)); break;
                case "release": {
                  const change = registry.release(endpoint);
                  try { send(envelope("released", request.requestId)); }
                  finally { publish(change); peer.close(); armIdle(); }
                  break;
                }
                case "list": case "list-cwd":
                  if (request.type === "list-cwd" && request.cwd === undefined) throw new RegistryError("invalid_selector");
                  send({ ...envelope("sessions", request.requestId), sessions: registry.list(endpoint, { cwd: request.cwd, workgroup: request.workgroup }) }); break;
                case "resolve":
                  send({ ...envelope("resolved", request.requestId), ...registry.resolve(endpoint, { to: request.to, cwd: request.cwd, workgroup: request.workgroup }) }); break;
                case "update": mutation = registry.update(endpoint, request.expectedRevision, request.patch); break;
                case "set-workgroups": mutation = registry.setWorkgroups(endpoint, request.expectedRevision, request.workgroups); break;
                default: send({ ...envelope("error", request.requestId), code: "unsupported_operation" });
              }
              if (mutation) {
                try { send({ ...envelope("session_updated", request.requestId), session: mutation.session, changed: !!mutation.transition }); }
                finally { publish(mutation.transition); }
              }
            }
          } catch (error) {
            if (!(error instanceof RegistryError)) throw error;
            if (!peer.active || error.code === "endpoint_revoked") peer.reject(error.code, request.requestId);
            else send({ ...envelope("error", request.requestId), code: error.code });
          }
          return !socket.destroyed && !closing && !stopping;
        });
      } catch (error) {
        if (error instanceof LeaseStorageError) { peer.reject("storage_failed"); void stop(); }
        else if (error instanceof ProtocolError) peer.reject(error.code, error.requestId);
        else socket.destroy();
      }
    });
  });

  function armIdle() {
    if (!stopping && registry.size === 0 && !cancelIdle) {
      cancelIdle = clock.after(limits.idleMs, () => { void stop(); });
    }
  }
  function checkpoint() {
    if (stopping) return;
    try { registry.checkpoint(); }
    catch { void stop(); return; }
    cancelCheckpoint = clock.after(LEASE_CHECKPOINT_MS, checkpoint);
  }
  function cleanup() {
    try {
      // libuv unlinks its bind path on close. The public hard link is separately
      // checked, so a later generation's public socket is never removed by close.
      if (socketIdentity) {
        unlinkOwned(paths.socketPath, socketIdentity);
        unlinkOwned(ownedSocket, socketIdentity);
      }
      claim!.release();
      resolveClosed();
    } catch (error) { rejectClosed(error); }
  }
  function stop(): Promise<void> {
    if (stopping) return closed;
    stopping = true;
    cancelIdle?.();
    cancelCheckpoint?.();
    for (const peer of peers.values()) peer.socket.destroy();
    if (server.listening) server.close(cleanup);
    else cleanup();
    return closed;
  }
  server.on("error", () => { if (socketIdentity) void stop(); });
  try {
    if (identity(paths.socketPath)) {
      const previousSocket = claim.previous && privateSocket(paths.runtimeDir, claim.previous);
      const oldIdentity = previousSocket ? identity(previousSocket) : undefined;
      const probe = await probeBroker(paths.socketPath);
      if (probe.status !== "absent" || !oldIdentity || !sameFile(identity(paths.socketPath), oldIdentity)
        || !lstatSync(paths.socketPath).isSocket()) {
        throw new Error("Openspace socket is occupied or has unknown ownership; refusing to remove it");
      }
      unlinkOwned(paths.socketPath, oldIdentity);
      unlinkOwned(previousSocket!, oldIdentity);
    } else if (claim.previous) {
      const previousSocket = privateSocket(paths.runtimeDir, claim.previous);
      const old = identity(previousSocket);
      if (old && lstatSync(previousSocket).isSocket()) unlinkOwned(previousSocket, old);
    }
    registry = new SessionRegistry(new LeaseStore(paths.runtimeDir, options.leases), paths.runtimeDir, options.leases?.now, limits.registered);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(ownedSocket, () => { server.off("error", reject); resolve(); });
    });
    socketIdentity = identity(ownedSocket)!;
    chmodSync(ownedSocket, 0o600);
    // link() publishes without replacing an endpoint that won a concurrent start.
    linkSync(ownedSocket, paths.socketPath);
    armIdle();
    cancelCheckpoint = clock.after(LEASE_CHECKPOINT_MS, checkpoint);
    return { instanceId: claim.owner.token, closed, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
