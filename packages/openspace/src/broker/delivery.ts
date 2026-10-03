import type { AskService } from "./asks.ts";
import { envelope } from "../protocol/messages.ts";
import { checkMessageFrame, fingerprint, parseBody, parseRef, RECEIPTS, refKey,
  type DeliveryResult, type Message, type MessageRef, type Receipt, type ReceiptStatus } from "../protocol/delivery.ts";
import { SessionRegistry, type MembershipStamp, type Transition } from "../registry/registry.ts";
import { object, RegistryError, type SessionInfo } from "../registry/session.ts";

export const DELIVERY_LIMITS = { replayCount: 4096, replayBytes: 16 * 1024 * 1024, replayMs: 60 * 60_000,
  mailboxCount: 256, mailboxBytes: 16 * 1024 * 1024, mailboxMs: 24 * 60 * 60_000 };
interface RecordEntry {
  ref: MessageRef; fingerprint: string; target: { id: string; name?: string; cwd: string };
  sender: MembershipStamp; receiver: MembershipStamp; actualRecipientId: string;
  result: DeliveryResult; replayUntil: number; mailboxUntil: number;
  queued?: Message; bytes: number; metadataBytes: number; terminal?: boolean;
  control?: "cancelled" | "superseded"; replacement?: string; terminalStatus?: ReceiptStatus; injected?: boolean;
}
export type Forward = (endpoint: string, message: unknown) => "written" | "offline" | "unknown";
export interface DeliveryOptions { now?: () => number; limits?: Partial<typeof DELIVERY_LIMITS> }

/** Broker-owned RAM only. No model, filesystem payload reads or unbounded application write queue. */
export class DeliveryService {
  private readonly records = new Map<string, RecordEntry>();
  private readonly registry: SessionRegistry;
  private readonly forward: Forward;
  private readonly now: () => number;
  private readonly limits: typeof DELIVERY_LIMITS;
  private readonly asks: AskService;
  constructor(registry: SessionRegistry, forward: Forward, asks: AskService, options: DeliveryOptions = {}) {
    this.registry = registry; this.forward = forward; this.asks = asks; this.now = options.now ?? Date.now;
    this.limits = { ...DELIVERY_LIMITS, ...options.limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid delivery limit");
  }
  get size(): number { return this.records.size; }
  private notify(record: RecordEntry, status: ReceiptStatus, code?: string): void {
    const receipt: Receipt = { ref: record.ref, status, timestamp: this.now(), ...(code ? { code } : {}) };
    const endpoint = this.registry.endpoint(record.ref.senderId);
    if (endpoint && this.registry.isMembershipCurrent(record.sender)) this.forward(endpoint, { ...envelope("receipt"), receipt });
  }
  private terminal(record: RecordEntry, status: "expired" | "cancelled" | "superseded", code: string): void {
    const wasQueued = !!record.queued;
    delete record.queued; record.bytes = 0; record.terminal = true;
    record.result = { ...record.result, ...(wasQueued ? { delivery: "failed" as const, outcomeKnown: true } : {}), code, retryable: false };
    record.terminalStatus = status;
    record.replayUntil = this.now() + this.limits.replayMs;
    this.notify(record, status, code);
    this.asks.close(record.ref, `ask_delivery_${status}`);
  }
  prune(): void {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (record.queued && record.mailboxUntil <= now) this.terminal(record, "expired", "mailbox_expired");
      if (record.queued && (!this.registry.isMembershipCurrent(record.sender) || !this.registry.isMembershipCurrent(record.receiver))) {
        this.terminal(record, "cancelled", "workgroup_left");
      }
      if (!record.queued && record.replayUntil <= now) this.records.delete(key);
    }
  }
  private metadataSize(record: RecordEntry): number {
    const { queued: _queued, metadataBytes: _size, ...metadata } = record;
    return Buffer.byteLength(JSON.stringify(metadata)) + 1024;
  }
  private reserve(metadataBytes: number, additionalCount = 1): void {
    let size = [...this.records.values()].reduce((total, record) => total + record.metadataBytes, 0);
    if (metadataBytes > this.limits.replayBytes) throw new RegistryError("replay_capacity");
    while (this.records.size + additionalCount > this.limits.replayCount || size + metadataBytes > this.limits.replayBytes) {
      const oldest = [...this.records].find(([, record]) => !record.queued);
      if (!oldest) throw new RegistryError("replay_capacity");
      this.notify(oldest[1], "expired", "replay_evicted");
      size -= oldest[1].metadataBytes; this.records.delete(oldest[0]);
    }
  }
  private queue(record: RecordEntry, message: Message): void {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > this.limits.mailboxBytes) throw new RegistryError("mailbox_capacity");
    const queued = [...this.records.values()].filter((entry) => entry.queued);
    let size = queued.reduce((total, entry) => total + entry.bytes, 0);
    while (queued.length >= this.limits.mailboxCount || size + bytes > this.limits.mailboxBytes) {
      const oldest = queued.shift()!; size -= oldest.bytes;
      this.terminal(oldest, "expired", "mailbox_overflow");
    }
    record.queued = message; record.bytes = bytes;
    record.result.delivery = "queued";
    this.notify(record, "queued");
  }
  send(endpoint: string, input: unknown): DeliveryResult {
    this.prune();
    if (!object(input) || typeof input.to !== "string" || typeof input.workgroup !== "string" || typeof input.endpointEpoch !== "string" || typeof input.senderMembershipEpoch !== "string" || typeof input.membershipEpoch !== "string") throw new RegistryError("invalid_message");
    const sender = this.registry.session(endpoint), body = parseBody(input.message);
    if (sender.id === input.to) throw new RegistryError("self_target");
    const ref: MessageRef = { workgroup: input.workgroup, senderId: sender.id, messageId: body.id };
    const hash = fingerprint(body, input.to, input.workgroup);
    const previous = this.records.get(refKey(ref));
    if (previous) {
      if (previous.fingerprint !== hash) throw new RegistryError("E_MESSAGE_ID_REUSE");
      return structuredClone(previous.result);
    }
    const selected = this.registry.resolve(endpoint, { to: input.to, workgroup: input.workgroup }, true);
    if (selected.session.id !== input.to) throw new RegistryError("target_not_found"); // Exact-send never follows aliases.
    if (selected.session.endpointEpoch !== input.endpointEpoch) return { messageId: body.id, workgroup: input.workgroup,
      delivery: "failed", code: "endpoint_rebound", retryable: true, outcomeKnown: true };
    const target = selected.session;
    const senderStamp = this.registry.membership(endpoint, input.workgroup);
    const receiverStamp = this.registry.membershipForId(target.id, input.workgroup);
    if (senderStamp.epoch !== input.senderMembershipEpoch || receiverStamp.epoch !== input.membershipEpoch) throw new RegistryError("workgroup_left");
    const message: Message = { ...body, sender: { id: sender.id, ...(sender.name ? { name: sender.name } : {}) },
      recipientId: target.id, workgroup: input.workgroup, brokerReceivedAt: this.now() };
    checkMessageFrame(message);
    let superseded: RecordEntry | undefined;
    if (body.supersedes) {
      superseded = this.controlled(endpoint, { ...ref, messageId: body.supersedes });
      if (superseded.actualRecipientId !== target.id || body.supersedes === body.id) throw new RegistryError("invalid_supersedes");
    }
    const record: RecordEntry = { ref, fingerprint: hash, target: { id: target.id, cwd: target.cwd, ...(target.name ? { name: target.name } : {}) },
      sender: senderStamp, receiver: receiverStamp, actualRecipientId: target.id,
      result: { messageId: body.id, workgroup: input.workgroup, delivery: "socket_delivered", retryable: false, outcomeKnown: true },
      replayUntil: this.now() + this.limits.replayMs, mailboxUntil: this.now() + this.limits.mailboxMs, bytes: 0, metadataBytes: 0 };
    record.metadataBytes = this.metadataSize(record);
    // Preflight before evicting or writing; a live socket can close before forwarding.
    if (Buffer.byteLength(JSON.stringify(message)) > this.limits.mailboxBytes) throw new RegistryError("mailbox_capacity");
    const commitAsk = this.asks.prepare(body, senderStamp, receiverStamp);
    this.reserve(record.metadataBytes);
    commitAsk(); this.records.set(refKey(ref), record);
    const targetEndpoint = this.registry.endpoint(target.id);
    const forwarded = targetEndpoint ? this.forward(targetEndpoint, { ...envelope("message"), message }) : "offline";
    if (forwarded === "offline" && body.expectsReply) {
      record.result = { ...record.result, delivery: "failed", code: "target_disconnected" }; record.terminal = true;
      this.asks.close(ref, "target_disconnected");
    } else if (forwarded === "offline") this.queue(record, message);
    else if (forwarded === "unknown") record.result = { ...record.result, delivery: "unknown", code: "socket_write_failed", outcomeKnown: false };
    if (body.replyTo && ["socket_delivered", "queued"].includes(record.result.delivery)) this.asks.close(body.replyTo, "answered");
    if (superseded && record.result.delivery !== "unknown") this.cancelRecord(superseded, "superseded", body.id);
    return structuredClone(record.result);
  }
  private controlled(endpoint: string, value: unknown): RecordEntry {
    const actor = this.registry.session(endpoint), ref = parseRef(value);
    const record = this.records.get(refKey(ref));
    if (!record || actor.id !== ref.senderId || !this.registry.isMembershipCurrent(record.sender)
      || !actor.workgroups.includes(ref.workgroup)) throw new RegistryError("not_message_owner");
    return record;
  }
  cancel(endpoint: string, value: unknown): { ref: MessageRef; status: ReceiptStatus } {
    this.prune(); const record = this.controlled(endpoint, value);
    return { ref: record.ref, status: this.cancelRecord(record, "cancelled") };
  }
  private cancelRecord(record: RecordEntry, reason: "cancelled" | "superseded", replacement?: string): ReceiptStatus {
    if (record.terminal) return record.terminalStatus ?? record.control ?? "cancelled";
    this.asks.close(record.ref, reason === "cancelled" ? "ask_cancelled" : "ask_superseded");
    record.control = reason; record.replacement = replacement;
    if (record.queued) { this.terminal(record, reason, reason); return reason; }
    const endpoint = this.registry.endpoint(record.actualRecipientId);
    if (endpoint && this.registry.isMembershipCurrent(record.receiver)) this.forward(endpoint,
      { ...envelope("message_control"), ref: record.ref, action: reason, ...(replacement ? { replacement } : {}) });
    this.notify(record, "cancellation_requested");
    return "cancellation_requested";
  }
  receipt(endpoint: string, value: unknown): Receipt {
    this.prune();
    if (!object(value) || !RECEIPTS.includes(value.status as ReceiptStatus)
      || value.code !== undefined && (typeof value.code !== "string" || !/^[a-z0-9_]{1,128}$/.test(value.code))) throw new RegistryError("invalid_receipt");
    const ref = parseRef(value.ref), receiver = this.registry.session(endpoint), record = this.records.get(refKey(ref));
    if (!record || record.actualRecipientId !== receiver.id || !this.registry.isMembershipCurrent(record.receiver)
      || !receiver.workgroups.includes(ref.workgroup)) throw new RegistryError("not_message_recipient");
    if (record.terminal || record.queued) throw new RegistryError(record.terminal ? "message_terminal" : "message_not_delivered");
    let status = value.status as ReceiptStatus;
    if (status === "injected") record.injected = true;
    if (record.injected && ["cancelled", "superseded", "expired"].includes(status)) status = "cancellation_requested";
    if (status === "cancelled" || status === "superseded" || status === "expired") this.terminal(record, status, value.code as string ?? status);
    else {
      if (record.result.delivery === "unknown") record.result = { messageId: ref.messageId, workgroup: ref.workgroup, delivery: "socket_delivered", retryable: false, outcomeKnown: true };
      this.notify(record, status, value.code as string | undefined);
    }
    return { ref, status, timestamp: this.now(), ...(value.code ? { code: value.code as string } : {}) };
  }
  transition(change: Transition): void {
    // Takeover may recover queued data by exact routing identity, but never a group the new owner lacks.
    if (change.after && change.endpoint && ["join", "resume", "takeover"].includes(change.kind)) {
      for (const record of this.records.values()) {
        if (record.queued && record.actualRecipientId === change.after.id && change.after.workgroups.includes(record.ref.workgroup)) {
          record.receiver = this.registry.membership(change.endpoint, record.ref.workgroup);
        }
      }
    }
    for (const record of this.records.values()) {
      if (record.terminal) continue;
      const affected = (change.before?.id === record.ref.senderId || change.before?.id === record.actualRecipientId)
        && change.left.includes(record.ref.workgroup);
      const exactRecovery = !!record.queued && change.after?.id === record.actualRecipientId && change.after.workgroups.includes(record.ref.workgroup)
        && change.kind === "takeover" && change.before?.id !== record.ref.senderId;
      if (affected && !exactRecovery) {
        if (record.queued) this.terminal(record, "cancelled", "workgroup_left");
        else { this.cancelRecord(record, "cancelled"); record.terminal = true; record.result = { ...record.result, code: "workgroup_left", retryable: false }; }
      }
    }
    this.prune();
    if (change.after && change.endpoint) this.drain(change.endpoint, change.after);
  }
  private drain(endpoint: string, peer: SessionInfo): void {
    let known: SessionInfo[] | undefined;
    const namedCandidates = new Map<string, SessionInfo[]>();
    for (const record of this.records.values()) {
      if (record.terminal || !peer.workgroups.includes(record.ref.workgroup) || peer.id === record.ref.senderId) continue;
      if (!record.queued) {
        if (record.control && peer.id === record.actualRecipientId && this.registry.isMembershipCurrent(record.receiver)) this.cancelRecord(record, record.control, record.replacement);
        continue;
      }
      if (record.actualRecipientId !== peer.id) {
        if (this.registry.endpoint(record.target.id) || !record.target.name || record.target.cwd !== peer.cwd
          || record.target.name.toLowerCase() !== peer.name?.toLowerCase()) continue;
        let candidates = namedCandidates.get(record.ref.workgroup);
        if (!candidates) {
          known ??= this.registry.known();
          candidates = known.filter((candidate) => candidate.name?.toLowerCase() === peer.name?.toLowerCase()
            && candidate.cwd === peer.cwd && candidate.workgroups.includes(record.ref.workgroup));
          namedCandidates.set(record.ref.workgroup, candidates);
        }
        candidates = candidates.filter((candidate) => candidate.id !== record.target.id);
        if (candidates.length !== 1 || candidates[0].id !== peer.id) continue;
      }
      if (!this.registry.isMembershipCurrent(record.sender)) { this.terminal(record, "cancelled", "workgroup_left"); continue; }
      const message = { ...record.queued, recipientId: peer.id };
      const receiver = this.registry.membership(endpoint, record.ref.workgroup);
      const metadataBytes = this.metadataSize({ ...record, receiver, actualRecipientId: peer.id });
      try { checkMessageFrame(message); this.reserve(Math.max(0, metadataBytes - record.metadataBytes), 0); }
      catch { this.terminal(record, "expired", "recovery_capacity"); continue; }
      const result = this.forward(endpoint, { ...envelope("message"), message });
      if (result === "offline") continue;
      record.receiver = receiver; record.actualRecipientId = peer.id; record.metadataBytes = metadataBytes;
      delete record.queued; record.bytes = 0; record.replayUntil = this.now() + this.limits.replayMs;
      record.result = { ...record.result, delivery: result === "written" ? "socket_delivered" : "unknown",
        ...(result === "unknown" ? { code: "socket_write_failed" } : {}), outcomeKnown: result === "written" };
    }
  }
}
