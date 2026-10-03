import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { milliseconds, systemClock, type Clock } from "../clock.ts";
import { parseMessage, parseRef, RECEIPTS } from "../protocol/delivery.ts";
import { encodeFrame, FrameDecoder, writeEncodedFrame } from "../protocol/framing.ts";
import { envelope, isHealth, requestId } from "../protocol/messages.ts";
import { normalizeSpecificWorkgroups } from "../workgroups.ts";
import { text, type SessionInfo } from "../registry/session.ts";
import { ClientError, features, response, REVOKED, session } from "./responses.ts";
export { ClientError } from "./responses.ts";
export interface ClientMembership { workgroup: string; epoch: string }
export type ClientState = "disconnected" | "connecting" | "registered" | "revoked" | "closing";
export type Registration = Pick<SessionInfo, "id" | "cwd" | "model" | "pid"> & Partial<Pick<SessionInfo, "name" | "startedAt" | "status" | "contextUsage" | "tmuxPane">>;
export type ClientEvent = { type: "state"; state: ClientState; error?: ClientError }
  | { type: "session"; session: SessionInfo; left: string[]; joined: string[]; connectionChanged: boolean }
  | { type: "wire"; message: Record<string, unknown> };
export interface ClientOptions {
  socketPath: string; session: Registration; workgroups?: string[];
  clock?: Clock; transport?: (path: string) => Socket;
  connectTimeoutMs?: number; requestTimeoutMs?: number; heartbeatMs?: number; heartbeatTimeoutMs?: number;
}
export interface RequestOptions {
  response: string; timeoutMs?: number; requestId?: string; signal?: AbortSignal;
  /** Synchronous: install state before later events in the same decoded chunk. */
  accept?: (message: Record<string, unknown>) => void;
}
interface Pending { finish(error?: ClientError, value?: Record<string, unknown>): void; options: RequestOptions }

/** One runtime identity and lease; reusing this instance never issues a fresh claim after resume rejection. */
export class OpenspaceClient {
  private readonly options: ClientOptions;
  private readonly clock: Clock;
  private readonly pending = new Map<string, Pending>();
  private readonly usedIds = new Set<string>();
  private readonly prefix = `${randomUUID()}:`;
  private sequence = 0;
  private generation = 0;
  private socket?: Socket;
  private connecting?: Promise<void>;
  private cancelConnect?: (error?: ClientError) => void;
  private cancelHeartbeat?: () => void;
  private lease?: string;
  private attempted = false;
  private current?: SessionInfo;
  private registration: Registration;
  private memberships: string[];
  private negotiated: string[] = [];
  private instance?: string;
  private membershipInstance?: string;
  private readonly epochs = new Map<string, string>();
  private stateValue: ClientState = "disconnected";
  private terminal?: ClientError;
  private readonly listeners = new Set<(event: ClientEvent) => void>();
  private serial: Promise<unknown> = Promise.resolve();
  private reconcileNeeded = false;
  private readonly heartbeatMs: number;
  private readonly heartbeatTimeoutMs: number;

  constructor(options: ClientOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.registration = { ...structuredClone(options.session), id: text(options.session.id) };
    this.registration.startedAt ??= Date.now();
    this.memberships = normalizeSpecificWorkgroups(options.workgroups ?? []);
    this.heartbeatMs = milliseconds(options.heartbeatMs ?? 30_000);
    this.heartbeatTimeoutMs = Math.min(this.heartbeatMs, milliseconds(options.heartbeatTimeoutMs ?? 5_000));
    milliseconds(options.connectTimeoutMs ?? 5_000); milliseconds(options.requestTimeoutMs ?? 5_000);
  }
  get state(): ClientState { return this.stateValue; }
  get isConnected(): boolean { return this.state === "registered" && !!this.socket && !this.socket.destroyed && this.socket.writable && !this.socket.writableEnded; }
  get info(): SessionInfo | undefined { return this.current && structuredClone(this.current); }
  get workgroups(): string[] { return [...this.memberships]; }
  get brokerInstanceId(): string | undefined { return this.instance; }
  supports(feature: string): boolean { return this.negotiated.includes(feature); }
  membership(workgroup: string): ClientMembership {
    const epoch = this.epochs.get(workgroup);
    if (!epoch || this.terminal) throw new ClientError("workgroup_left");
    return { workgroup, epoch };
  }
  hasMembership(stamp: ClientMembership): boolean { return !this.terminal && this.epochs.get(stamp.workgroup) === stamp.epoch; }
  subscribe(listener: (event: ClientEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: ClientEvent): void {
    for (const listener of this.listeners) {
      try {
        const copy = structuredClone(event);
        if (copy.type === "state" && event.type === "state" && event.error) copy.error = new ClientError(event.error.code, event.error);
        void Promise.resolve(listener(copy)).catch(() => {});
      } catch { /* Consumer isolation. */ }
    }
  }
  private setState(state: ClientState, error?: ClientError): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.emit({ type: "state", state, error });
  }
  private install(info: SessionInfo): void {
    if (info.id !== this.registration.id) throw new ClientError("invalid_response");
    const previous = this.current;
    const connectionChanged = previous?.endpointEpoch !== info.endpointEpoch;
    if (!connectionChanged && previous && info.revision < previous.revision) throw new ClientError("invalid_response");
    if (this.membershipInstance !== this.instance) { this.epochs.clear(); this.membershipInstance = this.instance; }
    for (const group of this.epochs.keys()) if (!info.workgroups.includes(group)) this.epochs.delete(group);
    for (const group of info.workgroups) if (!this.epochs.has(group)) this.epochs.set(group, randomUUID());
    this.current = structuredClone(info);
    this.memberships = info.workgroups.filter((group) => group !== "default");
    const { id, cwd, model, pid, startedAt, name, status, contextUsage, tmuxPane } = info;
    this.registration = { id, cwd, model, pid, startedAt, ...(name === undefined ? {} : { name }),
      ...(status === undefined ? {} : { status }), ...(contextUsage === undefined ? {} : { contextUsage }), ...(tmuxPane === undefined ? {} : { tmuxPane }) };
    this.emit({ type: "session", session: info, connectionChanged,
      left: previous?.workgroups.filter((group) => !info.workgroups.includes(group)) ?? [],
      joined: info.workgroups.filter((group) => !previous?.workgroups.includes(group)) });
  }
  private lose(error: ClientError): void {
    const revoked = REVOKED.has(error.code) || this.state === "revoked";
    if (revoked) this.terminal ??= error;
    this.generation++;
    this.cancelHeartbeat?.(); this.cancelHeartbeat = undefined;
    this.cancelConnect?.(error); this.cancelConnect = undefined;
    const socket = this.socket; this.socket = undefined;
    for (const pending of [...this.pending.values()]) pending.finish(new ClientError(error.code, { retryable: error.retryable, outcomeKnown: false, cause: error }));
    socket?.destroy();
    this.setState(revoked ? "revoked" : "disconnected", error);
  }
  connect(): Promise<void> {
    if (this.terminal) return Promise.reject(this.terminal);
    if (this.connecting) return this.connecting;
    if (this.isConnected) return Promise.resolve();
    const generation = ++this.generation;
    this.setState("connecting");
    const task = this.open(generation);
    this.connecting = task;
    void task.then(() => { if (this.connecting === task) this.connecting = undefined; }, () => { if (this.connecting === task) this.connecting = undefined; });
    return task;
  }
  private async open(generation: number): Promise<void> {
    let initialClaim = false;
    try {
      this.assertGeneration(generation);
      const socket = (this.options.transport ?? createConnection)(this.options.socketPath);
      this.socket = socket;
      const decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        if (generation !== this.generation) return;
        try { decoder.push(chunk, (value) => { this.receive(response(value)); return generation === this.generation; }); }
        catch (error) { if (generation === this.generation) this.lose(error instanceof ClientError ? error : new ClientError("invalid_response")); }
      });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (generation === this.generation) this.lose(new ClientError("connect_failed", { retryable: !["EACCES", "EPERM"].includes(error.code ?? ""), cause: error }));
      });
      socket.on("close", () => { if (generation === this.generation) this.lose(new ClientError("disconnected")); });
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: ClientError) => {
          if (settled) return;
          settled = true; cancel(); socket.off("connect", connected); socket.off("close", closed);
          this.cancelConnect = undefined;
          error ? reject(error) : resolve();
        };
        const connected = () => finish();
        const closed = () => finish(new ClientError("disconnected"));
        const cancel = this.clock.after(this.options.connectTimeoutMs ?? 5_000, () => finish(new ClientError("timeout")));
        this.cancelConnect = (error) => finish(error ?? this.terminal ?? new ClientError("disconnected"));
        socket.once("connect", connected); socket.once("close", closed);
      });
      this.assertGeneration(generation);
      await this.request("health", {}, { response: "health_result", accept: (value) => {
        if (!isHealth(value, String(value.requestId))) throw new ClientError("invalid_response");
        this.negotiated = features(value.features); this.instance = value.instanceId;
        if (!["session-registry-v1", "lease-resume-v1", "liveness-v1"].every((name) => this.supports(name))) throw new ClientError("unsupported_broker");
      } });
      if (!this.lease) {
        const prepared = await this.request("prepare", { id: this.registration.id }, { response: "prepared" });
        if (typeof prepared.lease !== "string" || !prepared.lease || prepared.lease.length > 512) throw new ClientError("invalid_response");
        this.lease = prepared.lease;
      }
      this.assertGeneration(generation);
      initialClaim = !this.attempted;
      this.attempted = true; // Once a register write is possible, only resume may follow an uncertain outcome.
      await this.request("register", { session: this.registration, workgroups: this.memberships, lease: this.lease,
        mode: initialClaim ? "claim" : "resume" }, { response: "registered", accept: (value) => {
        this.negotiated = features(value.features);
        this.install(session(value.session));
        this.assertGeneration(generation);
        this.reconcileNeeded = false;
        this.setState("registered");
      } });
      this.assertGeneration(generation);
      this.armHeartbeat(generation);
    } catch (error) {
      const failure = error instanceof ClientError ? error : new ClientError("connect_failed", { cause: error });
      if (initialClaim && ["session_limit", "lease_capacity", "record_too_large", "invalid_metadata", "invalid_workgroups"].includes(failure.code)) this.attempted = false;
      if (generation === this.generation) this.lose(failure);
      throw this.terminal ?? failure;
    }
  }
  private assertGeneration(generation: number): void { if (generation !== this.generation) throw this.terminal ?? new ClientError("session_ended"); }
  request(type: string, fields: Record<string, unknown>, options: RequestOptions): Promise<Record<string, unknown>> {
    if (this.terminal) return Promise.reject(this.terminal);
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable || socket.writableEnded) return Promise.reject(new ClientError("disconnected"));
    const id = options.requestId ?? `${this.prefix}${++this.sequence}`;
    if (!requestId(id) || options.requestId?.startsWith(this.prefix)) return Promise.reject(new ClientError("invalid_request_id"));
    if (this.pending.has(id) || this.usedIds.has(id)) return Promise.reject(new ClientError("duplicate_request"));
    if (this.pending.size >= 256 || options.requestId && this.usedIds.size >= 65536) return Promise.reject(new ClientError("request_capacity"));
    if (options.signal?.aborted) return Promise.reject(new ClientError("aborted"));
    let timeout: number;
    try { timeout = milliseconds(options.timeoutMs ?? this.options.requestTimeoutMs ?? 5_000); }
    catch (error) { return Promise.reject(new ClientError("invalid_timeout", { cause: error })); }
    let frame: Buffer;
    try { frame = encodeFrame({ ...fields, ...envelope(type, id) }); }
    catch (error) { return Promise.reject(new ClientError("frame_too_large", { cause: error })); }
    if (options.requestId) this.usedIds.add(id);
    return new Promise((resolve, reject) => {
      const finish = (error?: ClientError, value?: Record<string, unknown>) => {
        if (!this.pending.delete(id)) return;
        cancel(); options.signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(value!);
      };
      const abort = () => finish(new ClientError("aborted", { outcomeKnown: false }));
      const cancel = this.clock.after(timeout, () => finish(new ClientError("timeout", { outcomeKnown: false })));
      this.pending.set(id, { finish, options });
      options.signal?.addEventListener("abort", abort, { once: true });
      try { writeEncodedFrame(socket, frame); }
      catch (error) { finish(new ClientError("write_failed", { cause: error, outcomeKnown: false })); }
    });
  }
  private receive(value: Record<string, unknown>): void {
    if (value.type === "error") {
      if (typeof value.code !== "string" || value.code.length > 128) throw new ClientError("invalid_response");
      const error = new ClientError(value.code);
      if (REVOKED.has(error.code)) { this.lose(error); return; }
      if (value.requestId === undefined) { this.lose(error); return; }
      this.pending.get(String(value.requestId))?.finish(error);
      return;
    }
    if (value.requestId !== undefined) {
      const pending = this.pending.get(String(value.requestId));
      if (!pending) return; // Timed-out responses cannot settle another operation.
      if (value.type !== pending.options.response) throw new ClientError("invalid_response");
      pending.options.accept?.(value);
      pending.finish(undefined, value);
    } else {
      if (this.state !== "registered") throw new ClientError("invalid_response");
      if (value.type === "presence") {
        if (value.event === "joined" || value.event === "updated") session(value.session);
        else if (value.event !== "left" || typeof value.id !== "string" || typeof value.endpointEpoch !== "string") throw new ClientError("invalid_response");
      } else if (value.type === "message") {
        if (parseMessage(value.message).recipientId !== this.current?.id) throw new ClientError("invalid_response");
      } else if (value.type === "receipt") {
        const receipt = value.receipt as Record<string, unknown> | undefined;
        if (!receipt || !RECEIPTS.includes(receipt.status as never) || !Number.isSafeInteger(receipt.timestamp)) throw new ClientError("invalid_response");
        parseRef(receipt.ref);
      } else if (value.type === "message_control") {
        parseRef(value.ref);
        if (value.action !== "cancelled" && value.action !== "superseded") throw new ClientError("invalid_response");
      } else throw new ClientError("invalid_response");
      this.emit({ type: "wire", message: value });
    }
  }
  private armHeartbeat(generation: number): void {
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = this.clock.after(this.heartbeatMs, () => {
      this.cancelHeartbeat = undefined;
      if (generation !== this.generation || !this.isConnected) return;
      void this.request("ping", {}, { response: "pong", timeoutMs: this.heartbeatTimeoutMs }).then(() => {
        if (generation === this.generation) this.armHeartbeat(generation);
      }, (error) => { if (generation === this.generation) this.lose(error); });
    }, true);
  }
  async disconnect(): Promise<void> {
    if (this.state === "revoked") { this.lose(this.terminal!); return; }
    this.setState("closing");
    this.lose(new ClientError("disconnected"));
  }
  async listSessions(filter: { cwd?: string; workgroup?: string } = {}): Promise<SessionInfo[]> {
    if (!this.isConnected) throw this.terminal ?? new ClientError("disconnected");
    const generation = this.generation;
    const result = await this.request(filter.cwd === undefined ? "list" : "list-cwd", filter, { response: "sessions" });
    this.assertGeneration(generation);
    if (!Array.isArray(result.sessions) || result.sessions.length > 128) { this.lose(new ClientError("invalid_response")); throw new ClientError("invalid_response"); }
    try { return result.sessions.map(session); }
    catch (error) { this.lose(new ClientError("invalid_response")); throw error; }
  }
  async resolve(selector: { to?: string; cwd?: string; workgroup?: string }): Promise<{ session: SessionInfo; workgroup: string }> {
    if (!this.isConnected) throw this.terminal ?? new ClientError("disconnected");
    const generation = this.generation;
    const result = await this.request("resolve", selector, { response: "resolved" });
    this.assertGeneration(generation);
    try {
      const info = session(result.session);
      if (typeof result.workgroup !== "string" || !info.workgroups.includes(result.workgroup) || !this.current?.workgroups.includes(result.workgroup)) throw new ClientError("invalid_response");
      return { session: info, workgroup: result.workgroup };
    } catch (error) { this.lose(new ClientError("invalid_response")); throw error; }
  }
  private async reconcile(): Promise<void> {
    const generation = this.generation;
    const own = (await this.listSessions()).find((peer) => peer.id === this.registration.id && peer.endpointEpoch === this.current?.endpointEpoch);
    this.assertGeneration(generation);
    if (!own) throw new ClientError("invalid_response");
    this.install(own); this.reconcileNeeded = false;
  }
  private mutation(type: "update" | "set-workgroups", fields: () => Record<string, unknown>): Promise<SessionInfo> {
    const generation = this.generation;
    const task = this.serial.then(async () => {
      this.assertGeneration(generation);
      if (!this.isConnected) throw new ClientError("disconnected");
      if (this.reconcileNeeded) await this.reconcile();
      for (let attempt = 0; attempt < 2; attempt++) {
        this.assertGeneration(generation);
        try {
          const result = await this.request(type, { ...fields(), expectedRevision: this.current!.revision }, { response: "session_updated", accept: (value) => this.install(session(value.session)) });
          return session(result.session);
        } catch (error) {
          if (error instanceof ClientError && error.code === "revision_conflict" && attempt === 0) { await this.reconcile(); continue; }
          if (error instanceof ClientError && ["timeout", "disconnected", "connect_failed"].includes(error.code)) {
            this.reconcileNeeded = true;
            throw new ClientError("outcome_unknown", { outcomeKnown: false, cause: error });
          }
          throw error;
        }
      }
      throw new ClientError("revision_conflict");
    });
    this.serial = task.catch(() => {});
    return task;
  }
  async updatePresence(patch: Record<string, unknown>): Promise<SessionInfo> { const snapshot = structuredClone(patch); return this.mutation("update", () => ({ patch: snapshot })); }
  async setWorkgroups(workgroups: string[]): Promise<SessionInfo> { const snapshot = normalizeSpecificWorkgroups(workgroups); return this.mutateWorkgroups(() => snapshot); }
  mutateWorkgroups(change: (current: string[]) => string[]): Promise<SessionInfo> {
    return this.mutation("set-workgroups", () => ({ workgroups: normalizeSpecificWorkgroups(change(this.workgroups)) }));
  }
}
