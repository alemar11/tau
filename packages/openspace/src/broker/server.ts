import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, lstatSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { OpenspacePaths } from "../paths.ts";
import { FrameDecoder, MAX_OUTPUT_BYTES, writeFrame } from "../protocol/framing.ts";
import { envelope, FEATURES, MAX_REGISTRATION_BYTES, parseRequest, ProtocolError } from "../protocol/messages.ts";
import { acquireClaim, identity, prepareRuntime, privateSocket, sameFile, unlinkOwned } from "./runtime-files.ts";
import { probeBroker } from "./probe.ts";

export interface Clock {
  now(): number;
  after(ms: number, callback: () => void): () => void;
}
export const systemClock: Clock = {
  now: () => performance.now(),
  after: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
};

export const BROKER_LIMITS = {
  idleMs: 5_000, registrationMs: 1_000, unregistered: 32, registered: 128,
  rateCapacity: 240, ratePerSecond: 120, outputBytes: MAX_OUTPUT_BYTES,
};
export interface BrokerOptions { clock?: Clock; limits?: Partial<typeof BROKER_LIMITS> }
export interface Broker { readonly instanceId: string; readonly closed: Promise<void>; stop(): Promise<void> }

/** Transport registration only: no routing identity, registry or delivery is exposed yet. */
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
  const peers = new Set<Socket>();
  let registered = 0;
  let unregistered = 0;
  let cancelIdle: (() => void) | undefined;
  let stopping = false;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  // Startup can fail before a caller receives the handle.
  void closed.catch(() => {});
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    if (stopping || unregistered >= limits.unregistered) { socket.destroy(); return; }
    peers.add(socket);
    unregistered++;
    let active = false;
    let closing = false;
    let cancelClose: (() => void) | undefined;
    const cancelRegistration = clock.after(limits.registrationMs, () => socket.destroy());
    let tokens = limits.rateCapacity;
    let lastRefill = clock.now();
    const decoder = new FrameDecoder();
    const send = (value: unknown) => writeFrame(socket, value, limits.outputBytes);
    function reject(code: string, requestId?: string) {
      if (closing) return;
      closing = true;
      try { send({ ...envelope("error", requestId), code }); socket.end(); }
      catch { socket.destroy(); }
      cancelClose = clock.after(100, () => socket.destroy());
    }
    socket.on("close", () => {
      peers.delete(socket);
      cancelRegistration();
      cancelClose?.();
      if (active) { registered--; armIdle(); }
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
          if (request.type === "health") {
            send({ ...envelope("health_result", request.requestId), pid: process.pid,
              instanceId: claim.owner.token, features: FEATURES });
          } else if (request.type === "register") {
            if (active) { reject("already_registered", request.requestId); return false; }
            if (registered >= limits.registered) { reject("session_limit", request.requestId); return false; }
            const reply = { ...envelope("registered", request.requestId), connectionId: randomUUID(),
              workgroups: request.workgroups, features: FEATURES };
            if (Buffer.byteLength(JSON.stringify(reply)) > MAX_REGISTRATION_BYTES) {
              reject("registration_too_large", request.requestId); return false;
            }
            // This acknowledgement precedes any future application callbacks/events.
            send(reply);
            active = true;
            registered++;
            unregistered--;
            cancelRegistration();
            cancelIdle?.();
            cancelIdle = undefined;
          } else if (!active) {
            reject("registration_required", request.requestId); return false;
          } else if (request.type === "ping") {
            send(envelope("pong", request.requestId));
          } else {
            send({ ...envelope("error", request.requestId), code: "unsupported_operation" });
          }
          return !socket.destroyed;
        });
      } catch (error) {
        if (error instanceof ProtocolError) reject(error.code, error.requestId);
        else socket.destroy();
      }
    });
  });

  function armIdle() {
    if (!stopping && registered === 0 && !cancelIdle) {
      cancelIdle = clock.after(limits.idleMs, () => { void stop(); });
    }
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
    for (const peer of peers) peer.destroy();
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
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(ownedSocket, () => { server.off("error", reject); resolve(); });
    });
    socketIdentity = identity(ownedSocket)!;
    chmodSync(ownedSocket, 0o600);
    // link() publishes without replacing an endpoint that won a concurrent start.
    linkSync(ownedSocket, paths.socketPath);
    armIdle();
    return { instanceId: claim.owner.token, closed, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
