import { createHash } from "node:crypto";
import { join } from "node:path";
import { milliseconds } from "../clock.ts";
import { envelope } from "../protocol/messages.ts";
import { parseRef, refKey, type MessageRef, type SendBody } from "../protocol/delivery.ts";
import { atomicLeaseWrite } from "../registry/leases.ts";
import { RegistryError } from "../registry/session.ts";
import type { MembershipStamp, SessionRegistry } from "../registry/registry.ts";
import type { Forward } from "./delivery.ts";
import { identity, unlinkOwned } from "./runtime-files.ts";

export interface AskOptions { timeoutMs?: number; now?: () => number }
interface Edge { ref: MessageRef; sender: MembershipStamp; receiver: MembershipStamp; question: string; created: number; expires: number }
const digest = (ref: MessageRef) => createHash("sha256").update(refKey(ref)).digest("hex");
/** Independent broker retention. Diagnostics are snapshots, never recovery input. */
export class AskService {
  private readonly edges = new Map<string, Edge>();
  private readonly closed = new Map<string, string>();
  private readonly registry: SessionRegistry;
  private readonly forward: Forward;
  private readonly path: string;
  private readonly now: () => number;
  private file?: ReturnType<typeof identity>;
  readonly timeoutMs: number;
  constructor(registry: SessionRegistry, forward: Forward, runtimeDir: string, options: AskOptions = {}) {
    this.registry = registry; this.forward = forward; this.path = join(runtimeDir, "pending-asks.json");
    this.now = options.now ?? Date.now; this.timeoutMs = milliseconds(options.timeoutMs ?? 600_000); this.persist();
  }
  private persist(): void {
    const records = [...this.edges.values()].map(({ ref, receiver, question, created, expires }) => ({ ...ref, target: receiver.id, question, created, expires }));
    try { atomicLeaseWrite(this.path, JSON.stringify({ version: 1, durable: false, brokerPid: process.pid, asks: records })); this.file = identity(this.path); }
    catch { console.error("Openspace: unable to update non-durable pending-asks diagnostics"); }
  }
  prune(): void {
    for (const edge of this.edges.values()) {
      if (edge.expires <= this.now()) this.close(edge.ref, "ask_expired");
      else if (!this.registry.isMembershipCurrent(edge.sender) || !this.registry.isMembershipCurrent(edge.receiver)) this.close(edge.ref, "workgroup_left");
    }
  }
  /** Validation/preflight returns a commit with no remaining fallible validation, before any transport write. */
  prepare(body: SendBody, sender: MembershipStamp, receiver: MembershipStamp): () => void {
    this.prune();
    if (body.replyTo && body.expectsReply) throw new RegistryError("invalid_ask_reply");
    if (body.replyTo) {
      const edge = this.edges.get(refKey(body.replyTo));
      if (!edge) throw new RegistryError(this.closed.get(digest(body.replyTo)) ?? "ask_not_pending");
      if (edge.receiver.id !== sender.id || edge.sender.id !== receiver.id || edge.ref.workgroup !== sender.group
        || edge.receiver.epoch !== sender.epoch || edge.sender.epoch !== receiver.epoch) throw new RegistryError("invalid_reply_target");
      return () => {};
    }
    if (!body.expectsReply) return () => {};
    if (!body.text.trim()) throw new RegistryError("empty_question");
    if (!this.registry.endpoint(receiver.id)) throw new RegistryError("target_disconnected");
    if ([...this.edges.values()].some((edge) => edge.sender.id === receiver.id && edge.receiver.id === sender.id)) throw new RegistryError("mutual_ask");
    const ref = { workgroup: sender.group, senderId: sender.id, messageId: body.id };
    if (this.edges.has(refKey(ref)) || this.closed.has(digest(ref))) throw new RegistryError("ask_id_reuse");
    const edge = { ref, sender, receiver, question: body.text, created: this.now(), expires: this.now() + this.timeoutMs };
    const bytes = [...this.edges.values()].reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), Buffer.byteLength(JSON.stringify(edge)));
    if (this.edges.size >= 256 || bytes > 4 * 1024 * 1024) throw new RegistryError("ask_capacity");
    return () => { this.edges.set(refKey(ref), edge); this.persist(); };
  }
  close(ref: MessageRef, code: string): void {
    const edge = this.edges.get(refKey(ref)); if (!edge) return;
    this.edges.delete(refKey(ref)); this.closed.set(digest(ref), code);
    if (this.closed.size > 512) this.closed.delete(this.closed.keys().next().value!);
    this.persist();
    for (const stamp of [edge.sender, edge.receiver]) {
      const endpoint = this.registry.endpoint(stamp.id);
      if (endpoint && this.registry.isMembershipCurrent(stamp)) this.forward(endpoint, { ...envelope("ask_closed"), ref: edge.ref, code });
    }
  }
  abandon(endpoint: string, value: unknown): void {
    const ref = parseRef(value), actor = this.registry.session(endpoint), edge = this.edges.get(refKey(ref));
    if (actor.id !== ref.senderId || !edge || !this.registry.isMembershipCurrent(edge.sender)) throw new RegistryError("not_ask_owner");
    this.close(ref, "ask_aborted");
  }
  stop(): void {
    this.edges.clear();
    try { if (this.file) unlinkOwned(this.path, this.file); }
    catch { console.error("Openspace: unable to remove non-durable pending-asks diagnostics"); }
  }
}
