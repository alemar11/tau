import { createHash, randomUUID } from "node:crypto";
import { ClientError, type ClientMembership } from "./client.ts";
import { Messenger, type MessageEvent, type SendOptions } from "./messenger.ts";
import { ReplyTracker } from "./reply-tracker.ts";
import { milliseconds, systemClock, type Clock } from "../clock.ts";
import { messageId, messageRef, refKey, type DeliveryResult, type Message, type MessageRef } from "../protocol/delivery.ts";

export interface AskResult { messageId: string; workgroup: string; status: "answered" | "failed"; code?: string; delivery?: DeliveryResult; response?: Message }
interface Waiter { ref: MessageRef; peer: string; stamp: ClientMembership; delivery?: DeliveryResult; finish(code?: string, response?: Message): void }
export interface ConversationOptions { timeoutMs?: number; trackerTimeoutMs?: number; clock?: Clock; onAnswered?: (ref: MessageRef) => void }
/** Client-side waiter and receiver tracker have independent retention from broker edges. */
export class Conversation {
  readonly tracker: ReplyTracker;
  private readonly messenger: Messenger;
  private readonly options: ConversationOptions;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private waiter?: Waiter;
  private alive = true;
  private consumed?: string;
  private rejected?: string;
  private current?: MessageRef;
  private readonly used = new Set<string>();
  private readonly subscriptions: (() => void)[];
  constructor(messenger: Messenger, options: ConversationOptions = {}) {
    this.messenger = messenger; this.options = options; this.clock = options.clock ?? systemClock;
    this.timeoutMs = milliseconds(options.timeoutMs ?? 600_000);
    this.tracker = new ReplyTracker(messenger.client, options.trackerTimeoutMs ?? this.timeoutMs, this.clock);
    this.subscriptions = [messenger.subscribe((event) => this.receive(event)), messenger.client.subscribe((event) => {
      if (event.type === "state" && ["disconnected", "closing", "revoked"].includes(event.state)) this.waiter?.finish(event.error?.code ?? "disconnected");
      if (event.type === "session") { this.tracker.prune(); if (this.waiter && !messenger.client.hasMembership(this.waiter.stamp)) this.waiter.finish("workgroup_left"); }
    })];
  }
  private receive(event: MessageEvent): void {
    if (!this.alive) return;
    if (event.type === "ask_closed") {
      this.tracker.remove(event.ref);
      if (event.code === "answered") this.options.onAnswered?.(event.ref);
      else if (this.waiter && refKey(this.waiter.ref) === refKey(event.ref)) this.waiter.finish(event.code);
    } else if (event.type === "receipt" && this.waiter && refKey(event.receipt.ref) === refKey(this.waiter.ref)
      && ["expired", "cancelled", "superseded"].includes(event.receipt.status) && event.receipt.code !== "replay_evicted") {
      this.waiter.finish(event.receipt.code ?? `ask_${event.receipt.status}`);
    } else if (event.type === "message") {
      const message = event.message, waiter = this.waiter;
      if (message.replyTo && waiter && refKey(message.replyTo) === refKey(waiter.ref) && message.sender.id === waiter.peer
        && message.workgroup === waiter.ref.workgroup && this.messenger.client.hasMembership(waiter.stamp)) {
        this.consumed = refKey(messageRef(message));
        void this.messenger.receipt(messageRef(message), "acknowledged").catch(() => {});
        waiter.finish(undefined, message);
      }
      if (message.expectsReply) this.rejected = this.tracker.add(message) ? undefined : refKey(messageRef(message));
    }
  }
  /** Called synchronously by the Pi receiver subscribed after this conversation. */
  accept(message: Message): boolean {
    if (refKey(messageRef(message)) === this.consumed) { this.consumed = undefined; return false; }
    if (message.expectsReply && this.rejected === refKey(messageRef(message))) {
      void this.messenger.receipt(messageRef(message), "expired", "reply_tracker_capacity").catch(() => {}); return false;
    }
    return true;
  }
  activate(message?: Message): void { this.current = message?.expectsReply ? messageRef(message) : undefined; }
  pending() { return this.tracker.list(); }
  selection(selector: { replyTo?: MessageRef; to?: string; workgroup?: string } = {}): Message {
    return this.tracker.select({ ...selector, current: this.current });
  }
  infer(to: string | undefined, workgroup?: string): Message | undefined {
    if (!to) return undefined;
    try { return this.tracker.select({ to, workgroup }); }
    catch (error) { if (error instanceof ClientError && ["reply_not_pending", "reply_ambiguous_use_pending"].includes(error.code)) return undefined; throw error; }
  }
  guardSend(targetId: string): void {
    if (!this.current || !this.tracker.has(this.current)) return;
    if (this.tracker.select({ replyTo: this.current }).sender.id !== targetId) throw new ClientError("reply_target_mismatch");
  }
  private abandon(ref: MessageRef): void {
    if (this.messenger.client.isConnected) void this.messenger.client.request("abandon-ask", { ref }, { response: "ask_abandoned" }).catch(() => {});
  }
  async ask(to: string | undefined, options: SendOptions & { timeoutMs?: number }): Promise<AskResult> {
    const { signal, ...payload } = options; options = { ...structuredClone(payload), signal };
    if (!this.alive) throw new ClientError("session_ended");
    if (this.waiter) throw new ClientError("ask_in_progress");
    if (!options.text?.trim()) throw new ClientError("empty_question");
    if (options.replyTo) throw new ClientError("invalid_ask_reply");
    if (!this.messenger.client.supports("ask-reply-v1")) throw new ClientError("unsupported_broker");
    const timeout = milliseconds(options.timeoutMs ?? this.timeoutMs);
    if (options.signal?.aborted) throw new ClientError("aborted");
    const selected = await this.messenger.resolve({ to, cwd: options.cwd, workgroup: options.workgroup });
    if (!this.alive) throw new ClientError("session_ended");
    if (this.waiter) throw new ClientError("ask_in_progress");
    if (!selected.connected) throw new ClientError("target_disconnected");
    if (options.signal?.aborted) throw new ClientError("aborted");
    const id = messageId(options.messageId ?? randomUUID()), ref = { messageId: id, workgroup: selected.workgroup, senderId: this.messenger.client.info!.id };
    const key = createHash("sha256").update(refKey(ref)).digest("hex");
    if (this.used.has(key)) throw new ClientError("ask_id_reuse");
    if (this.used.size >= 4096) throw new ClientError("ask_runtime_capacity");
    this.used.add(key);
    return new Promise((resolve) => {
      const finish = (code?: string, response?: Message) => {
        if (this.waiter !== waiter) return;
        this.waiter = undefined; cancelTimer(); options.signal?.removeEventListener("abort", abort);
        resolve({ messageId: id, workgroup: ref.workgroup, status: response ? "answered" : "failed", ...(code ? { code } : {}),
          ...(waiter.delivery ? { delivery: waiter.delivery } : {}), ...(response ? { response: structuredClone(response) } : {}) });
      };
      const abort = () => { finish("aborted"); this.abandon(ref); };
      const cancelTimer = this.clock.after(timeout, () => finish("ask_timeout")); // Timeout is not cancellation or broker-edge expiry.
      const waiter: Waiter = { ref, peer: selected.session.id, stamp: selected.stamp, finish,
        delivery: { messageId: id, workgroup: ref.workgroup, delivery: "unknown", code: "awaiting_delivery_result", retryable: false, outcomeKnown: false } };
      this.waiter = waiter; options.signal?.addEventListener("abort", abort, { once: true });
      void this.messenger.sendResolved(selected, { ...options, messageId: id, expectsReply: true, replyTo: undefined }).then((delivery) => {
        if (this.waiter !== waiter) return;
        waiter.delivery = delivery;
        if (delivery.delivery !== "socket_delivered" || delivery.code) finish(delivery.code ?? "ask_not_delivered");
      }, () => finish("ask_send_failed"));
    });
  }
  async reply(selector: { replyTo?: MessageRef; to?: string; workgroup?: string }, options: SendOptions): Promise<DeliveryResult> {
    const { signal, ...payload } = options; options = { ...structuredClone(payload), signal };
    if (!this.alive) throw new ClientError("session_ended");
    if (options.cwd !== undefined) throw new ClientError("reply_does_not_accept_cwd");
    const original = this.selection(selector), ref = messageRef(original);
    const stamp = this.messenger.client.membership(original.workgroup);
    const selected = await this.messenger.resolve({ to: original.sender.id, workgroup: original.workgroup });
    if (!this.alive) throw new ClientError("session_ended");
    if (!this.tracker.has(ref)) throw new ClientError("reply_not_pending");
    if (!this.messenger.client.hasMembership(stamp)) throw new ClientError("workgroup_left");
    const result = await this.messenger.sendResolved(selected, { ...options, workgroup: original.workgroup, replyTo: ref, expectsReply: false });
    if (this.alive && ["socket_delivered", "queued"].includes(result.delivery)) { this.tracker.remove(ref); this.options.onAnswered?.(ref); }
    return result;
  }
  dispose(): void {
    if (!this.alive) return;
    this.alive = false;
    if (this.waiter) { const ref = this.waiter.ref; this.waiter.finish("session_ended"); this.abandon(ref); }
    this.tracker.clear(); for (const unsubscribe of this.subscriptions) unsubscribe();
  }
}
