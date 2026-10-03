import { ClientError, type OpenspaceClient, type ClientMembership } from "./client.ts";
import { milliseconds, systemClock, type Clock } from "../clock.ts";
import { messageRef, parseRef, refKey, type Message, type MessageRef } from "../protocol/delivery.ts";

interface Pending { message: Message; stamp: ClientMembership; receivedAt: number; expires: number; bytes: number }
export class ReplyTracker {
  private readonly client: OpenspaceClient;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly entries = new Map<string, Pending>();
  constructor(client: OpenspaceClient, timeoutMs = 600_000, clock: Clock = systemClock) {
    this.client = client; this.clock = clock; this.timeoutMs = milliseconds(timeoutMs);
  }
  prune(): void {
    for (const [key, entry] of this.entries) if (entry.expires <= this.clock.now() || !this.client.hasMembership(entry.stamp)) this.entries.delete(key);
  }
  add(message: Message): boolean {
    this.prune(); const key = refKey(messageRef(message));
    if (this.entries.has(key)) return true;
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (this.entries.size >= 256 || [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, bytes) > 8 * 1024 * 1024) return false;
    try {
      this.entries.set(key, { message: structuredClone(message), stamp: this.client.membership(message.workgroup), receivedAt: this.clock.now(), expires: this.clock.now() + this.timeoutMs, bytes });
      return true;
    } catch { return false; }
  }
  remove(ref: MessageRef): void { this.entries.delete(refKey(ref)); }
  clear(): void { this.entries.clear(); }
  has(ref: MessageRef): boolean { this.prune(); return this.entries.has(refKey(ref)); }
  list(): { ref: MessageRef; sender: Message["sender"]; ageMs: number; preview: string }[] {
    this.prune(); return [...this.entries.values()].map(({ message, receivedAt }) => ({ ref: messageRef(message), sender: structuredClone(message.sender),
      ageMs: this.clock.now() - receivedAt, preview: message.text.slice(0, 240) }));
  }
  select(selector: { replyTo?: MessageRef; to?: string; workgroup?: string; current?: MessageRef } = {}): Message {
    this.prune();
    let candidates = [...this.entries.values()].map((entry) => entry.message);
    if (selector.replyTo) {
      const ref = parseRef(selector.replyTo);
      candidates = candidates.filter((message) => refKey(messageRef(message)) === refKey(ref));
    } else if (selector.to !== undefined) {
      const exact = candidates.filter((message) => message.sender.id === selector.to);
      const named = candidates.filter((message) => message.sender.name?.toLowerCase() === selector.to!.toLowerCase());
      candidates = exact.length ? exact : named.length ? named : candidates.filter((message) => message.sender.id.startsWith(selector.to!));
    } else if (selector.current && this.has(selector.current)) candidates = candidates.filter((message) => refKey(messageRef(message)) === refKey(selector.current!));
    if (selector.workgroup !== undefined) candidates = candidates.filter((message) => message.workgroup === selector.workgroup);
    if (!candidates.length) throw new ClientError("reply_not_pending");
    if (candidates.length !== 1) throw new ClientError("reply_ambiguous_use_pending");
    const message = candidates[0];
    if (selector.replyTo && selector.to && selector.to !== message.sender.id && selector.to.toLowerCase() !== message.sender.name?.toLowerCase()
      && !message.sender.id.startsWith(selector.to)) throw new ClientError("invalid_reply_target");
    return structuredClone(message);
  }
}
