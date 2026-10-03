import { randomUUID } from "node:crypto";
import { OPENSPACE_EXTENSION_FEATURE, type ChannelEvent, type ChannelOwner, type ChannelSnapshot, type ChannelState, type ExtensionChannel, type ExtensionRegistration, type JsonValue, type PublishResult } from "../../extension-api.mjs";
import { systemClock, type Clock } from "../clock.ts";
import { CHANNEL_LIMITS, channelEpoch, channelGroup, channelKey, channelOwner, channelPacket, channelState, jsonPayload, namespace, publishResult, revision } from "../protocol/channels.ts";
import { effectiveWorkgroups } from "../workgroups.ts";
import type { SessionInfo } from "../registry/session.ts";
import { ClientError, type ClientMembership, type OpenspaceClient } from "./client.ts";
import { RECONNECT_DELAYS } from "./controller.ts";

export function channelCallback<T>(callback: (value: T) => unknown, value: T): void {
  try { void Promise.resolve(callback(value)).catch(() => {}); } catch { /* Isolate cooperative consumer failures. */ }
}
interface Operation { generation: number; controller: AbortController; release(): void; done: boolean; reason?: string; settle?: (event: Omit<Extract<ChannelEvent, { type: "state_result" }>, "requestId">) => void }
export class ChannelManager {
  readonly client: OpenspaceClient;
  readonly clock: Clock;
  private readonly channels = new Map<string, Channel>();
  private readonly unsubscribe: () => void;
  private stopped = false;
  private pending = 0;
  constructor(client: OpenspaceClient, clock: Clock = systemClock) {
    this.client = client; this.clock = clock;
    this.unsubscribe = client.subscribe((event) => {
      if (this.stopped) return;
      if (event.type === "state") {
        for (const channel of this.channels.values()) {
          if (event.state === "registered") channel.sync();
          else channel.invalidate(event.error?.code ?? "disconnected");
        }
      } else if (event.type === "session") {
        for (const channel of this.channels.values()) {
          if (event.left.includes(channel.workgroup) || event.connectionChanged) channel.invalidate(event.left.includes(channel.workgroup) ? "workgroup_left" : "disconnected");
          if (event.joined.includes(channel.workgroup) || event.connectionChanged) channel.sync();
        }
      } else if (event.message.type === "channel_event") {
        const packet = channelPacket(event.message);
        this.channels.get(channelKey(packet.workgroup, packet.namespace))?.receive(packet.bindingEpoch, packet.event);
      }
    });
  }
  register(input: ExtensionRegistration): ExtensionChannel {
    if (this.stopped) throw new ClientError("session_ended");
    if (this.client.state === "revoked") throw new ClientError("endpoint_revoked");
    const ns = namespace(input.namespace), groups = this.client.info?.workgroups ?? effectiveWorkgroups(this.client.workgroups);
    const group = input.workgroup === undefined ? groups.length === 1 ? groups[0]! : undefined : channelGroup(input.workgroup);
    if (!group) throw new ClientError("workgroup_ambiguous");
    if (!groups.includes(group)) throw new ClientError("workgroup_not_shared");
    if (typeof input.ownerEligible !== "boolean" || typeof input.onReady !== "function" || typeof input.onEvent !== "function") throw new ClientError("invalid_registration");
    const key = channelKey(group, ns);
    if (this.channels.has(key)) throw new ClientError("duplicate_channel");
    if (this.channels.size >= CHANNEL_LIMITS.capabilities) throw new ClientError("capability_capacity");
    const channel = new Channel(this, { ...input, namespace: ns, workgroup: group }); this.channels.set(key, channel); channel.sync(); return channel;
  }
  reserve(): () => void {
    if (this.pending >= 128) throw new ClientError("channel_request_capacity");
    this.pending++; let released = false;
    return () => { if (!released) { released = true; this.pending--; } };
  }
  dispose(): void { if (this.stopped) return; this.stopped = true; this.unsubscribe(); for (const channel of this.channels.values()) channel.close(); this.channels.clear(); }
}

class Channel implements ExtensionChannel {
  get namespace(): string { return this.registration.namespace; }
  get workgroup(): string { return this.registration.workgroup; }
  private readonly manager: ChannelManager;
  private readonly registration: ExtensionRegistration & { workgroup: string };
  private token?: string;
  private stamp?: ClientMembership;
  private owner?: ChannelOwner;
  private state?: ChannelState;
  private stateNotified?: number;
  private generation = 0;
  private ready = false;
  private stopped = false;
  private syncing?: Promise<unknown>;
  private syncController?: AbortController;
  private syncWanted = false;
  private cancelRetry?: () => void;
  private retries = 0;
  private readonly operations = new Set<Operation>();
  constructor(manager: ChannelManager, registration: ExtensionRegistration & { workgroup: string }) {
    this.manager = manager; this.registration = Object.freeze({ ...registration });
  }
  private member(): boolean { return !!this.manager.client.info?.workgroups.includes(this.workgroup); }
  snapshot(): ChannelSnapshot {
    const supported = this.manager.client.supports(OPENSPACE_EXTENSION_FEATURE);
    return structuredClone({ connected: !this.stopped && this.manager.client.isConnected && this.member() && (!supported || !!this.token), supported, owner: this.owner, state: this.state });
  }
  private notify(event: ChannelEvent): void { channelCallback(this.registration.onEvent, structuredClone(event)); }
  private announce(): void {
    const generation = this.generation;
    if (!this.ready) { this.ready = true; channelCallback(this.registration.onReady, this); }
    if (!this.stopped && generation === this.generation) this.notify({ type: "connection", snapshot: this.snapshot() });
  }
  sync(): void {
    if (this.stopped || !this.manager.client.isConnected || !this.member() || this.token) return;
    if (this.syncing) { this.syncWanted = true; return; }
    if (!this.manager.client.supports(OPENSPACE_EXTENSION_FEATURE)) { this.announce(); return; }
    this.cancelRetry?.(); this.cancelRetry = undefined;
    const generation = this.generation, stamp = this.manager.client.membership(this.workgroup), controller = new AbortController();
    this.syncController = controller; this.syncWanted = false;
    const task = this.manager.client.request("channel-register", { namespace: this.namespace, workgroup: this.workgroup, ownerEligible: this.registration.ownerEligible }, {
      response: "channel_registered", signal: controller.signal, accept: (value) => {
        if (generation !== this.generation || !this.manager.client.hasMembership(stamp)) return;
        if (value.workgroup !== this.workgroup || value.namespace !== this.namespace) throw new ClientError("invalid_response");
        const token = channelEpoch(value.bindingEpoch), owner = channelOwner(value.owner), state = channelState(value.state);
        this.token = token; this.stamp = stamp; this.owner = owner; this.state = state; this.retries = 0;
        this.announce();
        if (generation !== this.generation) return;
        this.notify({ type: "owner", owner });
        if (state && generation === this.generation && !this.stopped) { this.stateNotified = state.revision; this.notify({ type: "state", state }); }
      },
    }).catch((error: unknown) => {
      if (generation !== this.generation || this.stopped) return;
      const code = error instanceof Error ? error.message : "channel_registration_failed";
      this.notify({ type: "error", code });
      if (generation !== this.generation || this.stopped) return;
      this.notify({ type: "connection", snapshot: this.snapshot(), code });
      if (generation !== this.generation || this.stopped) return;
      if (error instanceof ClientError && error.retryable && this.manager.client.isConnected && this.member()) {
        this.cancelRetry = this.manager.clock.after(RECONNECT_DELAYS[Math.min(this.retries++, RECONNECT_DELAYS.length - 1)]!, () => { this.cancelRetry = undefined; this.sync(); }, true);
      }
    }).finally(() => {
      if (this.syncing === task) { this.syncing = undefined; this.syncController = undefined; if (this.syncWanted) this.sync(); }
    });
    this.syncing = task;
  }
  invalidate(code: string): void {
    const generation = ++this.generation; this.cancelRetry?.(); this.cancelRetry = undefined; this.syncController?.abort();
    const wasAvailable = !!this.token || !!this.owner || !!this.state;
    this.token = undefined; this.stamp = undefined; this.owner = undefined; this.state = undefined; this.stateNotified = undefined;
    for (const operation of [...this.operations]) {
      if (operation.done) continue;
      operation.reason ??= code; operation.controller.abort();
      operation.settle?.({ type: "state_result", status: "unknown", code });
    }
    if (generation === this.generation && (wasAvailable || this.ready)) this.notify({ type: "connection", snapshot: this.snapshot(), code });
  }
  close(): void { if (this.stopped) return; this.stopped = true; this.invalidate("session_ended"); }
  receive(token: string, event: ChannelEvent): void {
    if (this.stopped || this.token !== token || !this.stamp || !this.manager.client.hasMembership(this.stamp)) return;
    if (event.type === "owner") {
      if (JSON.stringify(event.owner) === JSON.stringify(this.owner)) return;
      this.owner = event.owner;
    } else if (event.type === "state") {
      if (event.state.revision < (this.state?.revision ?? 0) || event.state.revision === this.stateNotified) return;
      this.state = event.state; this.stateNotified = event.state.revision;
    }
    this.notify(event);
  }
  private guard(): void {
    if (this.stopped) throw new ClientError("session_ended");
    if (this.manager.client.state === "revoked") throw new ClientError("endpoint_revoked");
    if (!this.member()) throw new ClientError("workgroup_left");
    if (!this.manager.client.isConnected) throw new ClientError("disconnected");
    if (!this.manager.client.supports(OPENSPACE_EXTENSION_FEATURE)) throw new ClientError("unsupported_broker");
    if (!this.token || !this.stamp || !this.manager.client.hasMembership(this.stamp)) throw new ClientError("channel_not_registered");
  }
  private begin(): Operation {
    this.guard(); const operation: Operation = { generation: this.generation, controller: new AbortController(), release: this.manager.reserve(), done: false };
    this.operations.add(operation); return operation;
  }
  private finish(operation: Operation): void { if (operation.done) return; operation.done = true; this.operations.delete(operation); operation.release(); }
  private fields(): Record<string, unknown> { return { namespace: this.namespace, workgroup: this.workgroup, bindingEpoch: this.token }; }
  async publish(payload: JsonValue, options: { audience: "owner" | "capable"; ownerOnly?: boolean }): Promise<PublishResult> {
    this.guard(); const captured = jsonPayload(payload, CHANNEL_LIMITS.publishBytes).value;
    if (!options || options.audience !== "owner" && options.audience !== "capable" || options.ownerOnly !== undefined && typeof options.ownerOnly !== "boolean") throw new ClientError("invalid_publish");
    const operation = this.begin(); let accepted: PublishResult | undefined;
    try {
      await this.manager.client.request("channel-publish", { ...this.fields(), payload: captured, audience: options.audience,
        ownerOnly: options.ownerOnly, ...(options.ownerOnly ? { ownerEpoch: this.owner?.epoch } : {}) }, { response: "channel_published", signal: operation.controller.signal,
        accept: (value) => { accepted = publishResult(value.result); this.finish(operation); } });
      // Install the acknowledgement synchronously: a following leave in the same input chunk cannot erase a known transport result.
      return accepted!;
    } catch (error) { if (operation.reason) throw new ClientError(operation.reason, { outcomeKnown: false }); throw error; }
    finally { this.finish(operation); }
  }
  commitState(payload: JsonValue, expectedRevision?: number): string {
    this.guard(); const captured = jsonPayload(payload, CHANNEL_LIMITS.stateBytes).value;
    if (expectedRevision !== undefined) revision(expectedRevision);
    const operation = this.begin(), requestId = randomUUID();
    operation.settle = (event) => { if (operation.done) return; this.finish(operation); this.notify({ ...event, requestId }); };
    void this.manager.client.request("channel-commit", { ...this.fields(), ownerEpoch: this.owner?.epoch, payload: captured, expectedRevision }, {
      response: "channel_state_result", requestId, signal: operation.controller.signal, accept: (value) => {
        const state = channelState(value.state);
        if (value.status !== "committed" || !state) throw new ClientError("invalid_response");
        if (operation.generation !== this.generation || operation.done) return;
        if (state.revision >= (this.state?.revision ?? 0)) this.state = state;
        operation.settle!({ type: "state_result", status: "committed", state });
      },
    }).catch((error: unknown) => operation.settle!({ type: "state_result", status: error instanceof ClientError && !error.outcomeKnown ? "unknown" : "rejected",
      code: operation.reason ?? (error instanceof Error ? error.message : "commit_failed") }));
    return requestId;
  }
  async listSessions(): Promise<SessionInfo[]> {
    this.guard(); const generation = this.generation;
    const sessions = await this.manager.client.listSessions({ workgroup: this.workgroup });
    if (generation !== this.generation) throw new ClientError("channel_changed");
    this.guard(); return sessions.map((session) => ({ ...session, workgroups: [this.workgroup] }));
  }
}
