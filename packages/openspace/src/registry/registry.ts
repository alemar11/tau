import { randomBytes, randomUUID } from "node:crypto";
import { LeaseStore } from "./leases.ts";
import { applyPatch, assertRecord, canonicalCwd, commonGroups, groups, makeSession, MAX_SESSIONS, MAX_SESSION_BYTES,
  object, project, RegistryError, text, type SessionInfo } from "./session.ts";

interface Runtime { record: SessionInfo; alias: string; leaseHash: string; endpoint?: string; groupEpochs: Map<string, string> }
export interface Transition {
  kind: "join" | "resume" | "takeover" | "update" | "workgroups" | "disconnect" | "release";
  before?: SessionInfo; after?: SessionInfo;
  previousEndpoint?: string; endpoint?: string;
  /** Disconnect/resume are not departures/rejoins. Takeover invalidates the old runtime entirely. */
  left: string[]; joined: string[];
}
export interface Mutation { session: SessionInfo; transition?: Transition }
export interface MembershipStamp { id: string; leaseHash: string; group: string; epoch: string }
export interface Selector { to?: unknown; cwd?: unknown; workgroup?: unknown }

/** State changes are synchronous. Returned transitions are detached snapshots for broker consumers. */
export class SessionRegistry {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly endpoints = new Map<string, Runtime>();
  private readonly leases: LeaseStore;
  private readonly cwd: string;
  private readonly now: () => number;
  private readonly limit: number;
  constructor(leases: LeaseStore, cwd: string, now: () => number = Date.now, limit = MAX_SESSIONS) {
    this.leases = leases; this.cwd = cwd; this.now = now; this.limit = Math.min(limit, MAX_SESSIONS);
  }
  get size(): number { return this.endpoints.size; }
  private hashes(): Set<string> { return new Set([...this.endpoints.values()].map((runtime) => runtime.leaseHash)); }
  checkpoint(): void {
    this.leases.checkpoint(this.hashes());
    this.pruneOffline();
  }
  private pruneOffline(): void {
    for (const [id, runtime] of this.runtimes) {
      if (!runtime.endpoint && !this.leases.owns(id, runtime.leaseHash)) this.runtimes.delete(id);
    }
  }
  prepare(id: unknown): string {
    const value = text(id);
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_SESSION_BYTES) throw new RegistryError("record_too_large");
    return this.leases.prepare(value);
  }
  private owned(endpoint: string): Runtime {
    const runtime = this.endpoints.get(endpoint);
    if (!runtime || runtime.endpoint !== endpoint || this.runtimes.get(runtime.record.id) !== runtime) throw new RegistryError("endpoint_revoked");
    return runtime;
  }
  session(endpoint: string): SessionInfo { return structuredClone(this.owned(endpoint).record); }
  connections(): string[] { return [...this.endpoints.keys()]; }
  endpoint(id: string): string | undefined { return this.runtimes.get(id)?.endpoint; }
  known(): SessionInfo[] {
    return [...this.runtimes.values()].filter((runtime) => runtime.endpoint || this.leases.owns(runtime.record.id, runtime.leaseHash))
      .map((runtime) => structuredClone(runtime.record));
  }
  membershipForId(id: string, group: string): MembershipStamp {
    const runtime = this.runtimes.get(id);
    const epoch = runtime?.groupEpochs.get(group);
    if (!runtime || !epoch || !runtime.endpoint && !this.leases.owns(id, runtime.leaseHash)) throw new RegistryError("workgroup_left");
    return { id, leaseHash: runtime.leaseHash, group, epoch };
  }

  register(endpoint: string, input: unknown, workgroups: unknown, lease: unknown, mode: unknown): Mutation {
    if (this.endpoints.has(endpoint)) throw new RegistryError("already_registered");
    if (!object(input)) throw new RegistryError("invalid_metadata");
    const id = text(input.id);
    const checked = this.leases.inspect(id, lease, mode);
    const old = this.runtimes.get(id);
    if (this.size >= this.limit && !old?.endpoint) throw new RegistryError("session_limit");
    const continuing = checked.current && old?.leaseHash === checked.hash;
    const alias = continuing ? old.alias : `agent-${randomBytes(12).toString("hex")}`;
    // Validate even a resumed request, but retain the broker's newer metadata/groups
    // when an earlier mutation acknowledgement was lost on this broker instance.
    const proposed = makeSession(input, workgroups, this.cwd, randomUUID(), alias, this.now());
    const record = continuing ? { ...structuredClone(old.record), endpointEpoch: proposed.endpointEpoch } : proposed;
    assertRecord(record);
    const leaseHash = this.leases.accept(id, lease as string, mode as "claim" | "resume", this.hashes());
    this.pruneOffline();
    const runtime: Runtime = { record, alias, leaseHash, endpoint,
      groupEpochs: continuing ? new Map(old.groupEpochs) : new Map(record.workgroups.map((group) => [group, randomUUID()])) };
    if (old?.endpoint) this.endpoints.delete(old.endpoint);
    this.runtimes.set(id, runtime);
    this.endpoints.set(endpoint, runtime);
    return { session: structuredClone(record), transition: {
      kind: continuing ? "resume" : old ? "takeover" : "join",
      ...(old ? { before: structuredClone(old.record), previousEndpoint: old.endpoint } : {}),
      after: structuredClone(record), endpoint,
      left: continuing ? [] : old ? [...old.record.workgroups] : [],
      joined: continuing ? [] : [...record.workgroups],
    } };
  }
  disconnect(endpoint: string): Transition | undefined {
    const runtime = this.endpoints.get(endpoint);
    if (!runtime || runtime.endpoint !== endpoint) return;
    this.endpoints.delete(endpoint);
    runtime.endpoint = undefined;
    return { kind: "disconnect", before: structuredClone(runtime.record), previousEndpoint: endpoint, left: [], joined: [] };
  }
  release(endpoint: string): Transition {
    const runtime = this.owned(endpoint);
    this.leases.release(runtime.record.id, runtime.leaseHash, this.hashes());
    this.endpoints.delete(endpoint);
    this.runtimes.delete(runtime.record.id);
    return { kind: "release", before: structuredClone(runtime.record), previousEndpoint: endpoint,
      left: [...runtime.record.workgroups], joined: [] };
  }
  private revision(runtime: Runtime, expected: unknown): void {
    if (!Number.isSafeInteger(expected) || expected !== runtime.record.revision) throw new RegistryError("revision_conflict");
    if (runtime.record.revision >= Number.MAX_SAFE_INTEGER || runtime.record.membershipRevision >= Number.MAX_SAFE_INTEGER) throw new RegistryError("revision_exhausted");
  }
  update(endpoint: string, expected: unknown, patch: unknown): Mutation {
    const runtime = this.owned(endpoint);
    this.revision(runtime, expected);
    const next = applyPatch(runtime.record, patch, runtime.alias);
    return this.replace(runtime, next, "update");
  }
  setWorkgroups(endpoint: string, expected: unknown, input: unknown): Mutation {
    const runtime = this.owned(endpoint);
    this.revision(runtime, expected);
    const next = { ...structuredClone(runtime.record), workgroups: groups(input) };
    return this.replace(runtime, next, "workgroups");
  }
  private replace(runtime: Runtime, next: SessionInfo, kind: "update" | "workgroups"): Mutation {
    const before = runtime.record;
    if (JSON.stringify(before) === JSON.stringify(next)) return { session: structuredClone(before) };
    next.revision++;
    next.lastActivity = this.now();
    const left = before.workgroups.filter((group) => !next.workgroups.includes(group));
    const joined = next.workgroups.filter((group) => !before.workgroups.includes(group));
    if (left.length || joined.length) next.membershipRevision++;
    assertRecord(next);
    // No ownership, metadata or membership mutation precedes the complete budget check.
    for (const group of left) runtime.groupEpochs.delete(group);
    for (const group of joined) runtime.groupEpochs.set(group, randomUUID());
    runtime.record = next;
    return { session: structuredClone(next), transition: { kind, before: structuredClone(before), after: structuredClone(next),
      previousEndpoint: runtime.endpoint, endpoint: runtime.endpoint, left, joined } };
  }
  list(endpoint: string, selector: Selector = {}): SessionInfo[] {
    const viewer = this.owned(endpoint).record;
    this.validateSelector(selector);
    const group = this.filterGroup(viewer, selector.workgroup);
    const cwd = selector.cwd === undefined ? undefined : canonicalCwd(selector.cwd, viewer.cwd);
    return [...this.endpoints.values()].map((runtime) => project(viewer, runtime.record))
      .filter((peer): peer is SessionInfo => !!peer && (!group || peer.workgroups.includes(group)) && (!cwd || peer.cwd === cwd));
  }
  private validateSelector(selector: Selector): void {
    if (Buffer.byteLength(JSON.stringify(selector)) > MAX_SESSION_BYTES) throw new RegistryError("invalid_selector");
  }
  private filterGroup(viewer: SessionInfo, value: unknown): string | undefined {
    if (value === undefined) return undefined;
    const group = text(value);
    if (!viewer.workgroups.includes(group)) throw new RegistryError("workgroup_not_shared");
    return group;
  }
  resolve(endpoint: string, selector: Selector, includeOffline = false): { session: SessionInfo; workgroup: string } {
    const viewer = this.owned(endpoint).record;
    this.validateSelector(selector);
    const group = this.filterGroup(viewer, selector.workgroup);
    const visible = includeOffline ? this.known().map((peer) => project(viewer, peer))
      .filter((peer): peer is SessionInfo => !!peer && (!group || peer.workgroups.includes(group))) : this.list(endpoint, { workgroup: group });
    let matches = visible;
    if (selector.to !== undefined) {
      const to = text(selector.to);
      const exact = visible.filter((peer) => peer.id === to);
      const named = visible.filter((peer) => (peer.name ?? peer.runtimeFallbackAlias)?.toLowerCase() === to.toLowerCase());
      matches = exact.length ? exact : named.length ? named : visible.filter((peer) => peer.id.startsWith(to));
    } else if (selector.cwd === undefined) throw new RegistryError("invalid_selector");
    if (selector.cwd !== undefined) {
      const cwd = canonicalCwd(selector.cwd, viewer.cwd);
      matches = matches.filter((peer) => peer.cwd === cwd);
    }
    if (selector.to === undefined) matches = matches.filter((peer) => peer.id !== viewer.id);
    if (!matches.length) throw new RegistryError("target_not_found");
    if (matches.length > 1) throw new RegistryError("target_ambiguous");
    const target = matches[0];
    if (target.id === viewer.id) throw new RegistryError("self_target");
    const common = commonGroups(viewer, target);
    if (!group && common.length > 1) throw new RegistryError("workgroup_ambiguous");
    return { session: target, workgroup: group ?? common[0] };
  }
  membership(endpoint: string, group: string): MembershipStamp {
    const runtime = this.owned(endpoint);
    const epoch = runtime.groupEpochs.get(group);
    if (!epoch) throw new RegistryError("workgroup_not_shared");
    return { id: runtime.record.id, leaseHash: runtime.leaseHash, group, epoch };
  }
  isMembershipCurrent(stamp: MembershipStamp): boolean {
    const runtime = this.runtimes.get(stamp.id);
    return !!runtime && runtime.leaseHash === stamp.leaseHash && runtime.groupEpochs.get(stamp.group) === stamp.epoch
      && (!!runtime.endpoint || this.leases.owns(stamp.id, stamp.leaseHash));
  }
}
