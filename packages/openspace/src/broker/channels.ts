import { randomUUID } from "node:crypto";
import type { ChannelEvent, ChannelOwner, ChannelState, PublishResult } from "../../extension-api.mjs";
import { CHANNEL_LIMITS, channelEpoch, channelGroup, channelKey, jsonPayload, namespace } from "../protocol/channels.ts";
import { envelope } from "../protocol/messages.ts";
import type { MembershipStamp, SessionRegistry, Transition } from "../registry/registry.ts";
import { RegistryError, type SessionInfo } from "../registry/session.ts";
import type { ChannelStateStore } from "./channel-state.ts";

type Forward = (endpoint: string, value: unknown) => "written" | "offline" | "unknown";
interface Binding { endpoint: string; token: string; eligible: boolean; order: bigint; stamp: MembershipStamp }
interface Cohort { workgroup: string; namespace: string; bindings: Map<string, Binding>; owner?: ChannelOwner; ownerToken?: string }
export interface ChannelRegistrationResult { workgroup: string; namespace: string; bindingEpoch: string; owner?: ChannelOwner; state?: ChannelState; announce(): void }
const scoped = (session: SessionInfo, group: string): SessionInfo => ({ ...structuredClone(session), workgroups: [group] });

/** Capabilities are connection-owned. No channel data is passed to the conversational delivery service. */
export class ChannelService {
  private readonly registry: SessionRegistry;
  private readonly state: ChannelStateStore;
  private readonly forward: Forward;
  private readonly cohorts = new Map<string, Cohort>();
  private readonly byEndpoint = new Map<string, Set<string>>();
  private order = 0n;
  constructor(registry: SessionRegistry, state: ChannelStateStore, forward: Forward) { this.registry = registry; this.state = state; this.forward = forward; }
  private valid(binding: Binding): boolean { return this.registry.endpoint(binding.stamp.id) === binding.endpoint && this.registry.isMembershipCurrent(binding.stamp); }
  private send(cohort: Cohort, binding: Binding, event: ChannelEvent): "written" | "offline" | "unknown" {
    if (!this.valid(binding)) return "offline";
    return this.forward(binding.endpoint, { ...envelope("channel_event"), workgroup: cohort.workgroup, namespace: cohort.namespace, bindingEpoch: binding.token, event });
  }
  private broadcast(cohort: Cohort, event: ChannelEvent): void { for (const binding of cohort.bindings.values()) this.send(cohort, binding, event); }
  private elect(cohort: Cohort): boolean {
    const winner = [...cohort.bindings.values()].filter((binding) => binding.eligible && this.valid(binding)).sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : 0)[0];
    if (winner?.token === cohort.ownerToken) return false;
    cohort.ownerToken = winner?.token;
    cohort.owner = winner ? { id: winner.stamp.id, endpointEpoch: this.registry.session(winner.endpoint).endpointEpoch, epoch: randomUUID() } : undefined;
    return true;
  }
  register(endpoint: string, input: Record<string, unknown>): ChannelRegistrationResult {
    const ns = namespace(input.namespace), group = channelGroup(input.workgroup), key = channelKey(group, ns);
    if (typeof input.ownerEligible !== "boolean") throw new RegistryError("invalid_capability");
    const stamp = this.registry.membership(endpoint, group);
    const saved = this.state.get(group, ns); // Preflight before mutating capability ownership.
    const cohort = this.cohorts.get(key) ?? { workgroup: group, namespace: ns, bindings: new Map<string, Binding>() };
    let binding = cohort.bindings.get(endpoint);
    if (binding && binding.eligible !== input.ownerEligible) throw new RegistryError("duplicate_capability");
    if (!binding) {
      const owned = this.byEndpoint.get(endpoint) ?? new Set<string>();
      if (owned.size >= CHANNEL_LIMITS.capabilities) throw new RegistryError("capability_capacity");
      binding = { endpoint, token: randomUUID(), eligible: input.ownerEligible, order: ++this.order, stamp };
      cohort.bindings.set(endpoint, binding); owned.add(key); this.byEndpoint.set(endpoint, owned); this.cohorts.set(key, cohort);
    }
    const changed = this.elect(cohort);
    return { workgroup: group, namespace: ns, bindingEpoch: binding.token, owner: cohort.owner && structuredClone(cohort.owner), state: saved,
      announce: () => { if (changed) this.broadcast(cohort, { type: "owner", owner: cohort.owner }); } };
  }
  private bound(endpoint: string, input: Record<string, unknown>): { cohort: Cohort; binding: Binding } {
    const group = channelGroup(input.workgroup), ns = namespace(input.namespace);
    const cohort = this.cohorts.get(channelKey(group, ns)), binding = cohort?.bindings.get(endpoint);
    this.registry.membership(endpoint, group);
    if (!cohort || !binding || binding.token !== channelEpoch(input.bindingEpoch)) throw new RegistryError("channel_not_registered");
    if (!this.valid(binding)) throw new RegistryError("workgroup_left");
    return { cohort, binding };
  }
  private owner(cohort: Cohort, binding: Binding, epoch: unknown): void {
    const info = this.registry.session(binding.endpoint);
    if (cohort.ownerToken !== binding.token || cohort.owner?.id !== info.id || cohort.owner.endpointEpoch !== info.endpointEpoch) throw new RegistryError("not_channel_owner");
    if (cohort.owner.epoch !== epoch) throw new RegistryError("owner_revoked");
  }
  publish(endpoint: string, input: Record<string, unknown>): PublishResult {
    const { cohort, binding } = this.bound(endpoint, input);
    if (input.audience !== "owner" && input.audience !== "capable" || input.ownerOnly !== undefined && typeof input.ownerOnly !== "boolean") throw new RegistryError("invalid_publish");
    if (input.ownerOnly) this.owner(cohort, binding, input.ownerEpoch);
    const payload = jsonPayload(input.payload, CHANNEL_LIMITS.publishBytes).value;
    const recipients = input.audience === "capable" ? [...cohort.bindings.values()]
      : [...cohort.bindings.values()].filter((peer) => peer.token === cohort.ownerToken);
    if (!recipients.length) throw new RegistryError("owner_unavailable");
    const event: ChannelEvent = { type: "message", sender: scoped(this.registry.session(endpoint), cohort.workgroup), payload };
    const result: PublishResult = { written: 0, failed: 0, unknown: 0 };
    for (const peer of recipients) { const outcome = this.send(cohort, peer, event); result[outcome === "offline" ? "failed" : outcome]++; }
    return result;
  }
  commit(endpoint: string, input: Record<string, unknown>): { state: ChannelState; announce(): void } {
    const { cohort, binding } = this.bound(endpoint, input); this.owner(cohort, binding, input.ownerEpoch);
    const payload = jsonPayload(input.payload, CHANNEL_LIMITS.stateBytes).value;
    const state = this.state.commit(cohort.workgroup, cohort.namespace, payload, input.expectedRevision as number | undefined);
    return { state, announce: () => this.broadcast(cohort, { type: "state", state }) };
  }
  transition(change: Transition): void {
    for (const [key, cohort] of this.cohorts) {
      for (const [endpoint, binding] of cohort.bindings) {
        if (this.valid(binding)) continue;
        cohort.bindings.delete(endpoint);
        const owned = this.byEndpoint.get(endpoint); owned?.delete(key); if (!owned?.size) this.byEndpoint.delete(endpoint);
      }
      if (this.elect(cohort)) this.broadcast(cohort, { type: "owner", owner: cohort.owner });
      if (!cohort.bindings.size) { this.cohorts.delete(key); continue; }
      const before = change.previousEndpoint && change.before?.workgroups.includes(cohort.workgroup) ? change.before : undefined;
      const after = change.endpoint && change.after?.workgroups.includes(cohort.workgroup) ? change.after : undefined;
      if (!before && !after) continue;
      this.broadcast(cohort, { type: "peer", change: after ? before ? "updated" : "joined" : "left", session: scoped((after ?? before)!, cohort.workgroup) });
    }
  }
}
