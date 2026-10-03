import { systemClock, type Clock } from "../../src/clock.ts";
import type { OpenspaceConfig } from "../../src/config.ts";
import type { ClientMembership } from "../../src/client/client.ts";
import type { Messenger, MessageEvent } from "../../src/client/messenger.ts";
import { messageRef, refKey, type Message, type MessageRef, type ReceiptStatus } from "../../src/protocol/delivery.ts";

export const RECEIVER_LIMITS = { heldCount: 256, heldBytes: 8 * 1024 * 1024, heldMs: 10 * 60_000, dedupeCount: 1000, dedupeMs: 60 * 60_000, pollMs: 250 };
export const BUSY_NOTICE = "[Openspace automatic notice] This non-interactive session is busy; the message was not injected. Send again later with a new messageId.";
export interface ReceiverHost {
  state(): { alive: boolean; idle: boolean; running: boolean; interactive: boolean; compacting: boolean; pending: boolean };
  accept?(message: Message): boolean;
  inject(message: Message, triggerTurn: boolean, steer: boolean): void;
  busy(message: Message): void;
}
interface Entry { ref: MessageRef; stamp: ClientMembership; status: ReceiptStatus; until: number; heldUntil: number; bytes: number; message?: Message }

/** Owns only messages not yet handed to Pi; never aborts or edits Pi-owned work. */
export class Receiver {
  private readonly messenger: Messenger;
  private readonly host: ReceiverHost;
  private readonly policy: Pick<OpenspaceConfig, "inboundTrigger" | "busyDelivery">;
  private readonly clock: Clock;
  private readonly limits: typeof RECEIVER_LIMITS;
  private readonly entries = new Map<string, Entry>();
  private readonly unsubscribe: () => void;
  private cancelTimer?: () => void;
  private alive = true;
  private permit = true;
  private humanPending = false;
  constructor(messenger: Messenger, host: ReceiverHost, policy: Pick<OpenspaceConfig, "inboundTrigger" | "busyDelivery">,
    options: { clock?: Clock; limits?: Partial<typeof RECEIVER_LIMITS> } = {}) {
    this.messenger = messenger; this.host = host; this.policy = policy; this.clock = options.clock ?? systemClock;
    this.limits = { ...RECEIVER_LIMITS, ...options.limits };
    for (const n of Object.values(this.limits)) if (!Number.isSafeInteger(n) || n < 1) throw new Error("Invalid receiver limit");
    this.unsubscribe = messenger.subscribe((event) => this.receive(event));
  }
  get heldCount(): number { return [...this.entries.values()].filter((entry) => entry.message).length; }
  private receipt(ref: MessageRef, status: ReceiptStatus, code?: string): void {
    void this.messenger.receipt(ref, status, code).catch(() => {}); // Diagnostic, not durable or an injection prerequisite.
  }
  private finish(entry: Entry, status: ReceiptStatus, code?: string): void {
    delete entry.message; entry.bytes = 0; entry.status = status; entry.until = this.clock.now() + this.limits.dedupeMs;
    this.receipt(entry.ref, status, code);
  }
  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (entry.message && !this.messenger.client.hasMembership(entry.stamp)) this.finish(entry, "cancelled", "workgroup_left");
      if (entry.message && entry.heldUntil <= this.clock.now()) this.finish(entry, "expired", "held_expired");
      if (!entry.message && entry.until <= this.clock.now()) this.entries.delete(key);
    }
  }
  private receive(event: MessageEvent): void {
    if (!this.alive || !this.host.state().alive) return;
    this.prune();
    if (event.type === "control") { this.cancel(event.ref, event.action); return; }
    if (event.type !== "message") return;
    const message = event.message, ref = messageRef(message), key = refKey(ref);
    if (this.host.accept?.(message) === false) return;
    const previous = this.entries.get(key);
    if (previous) { this.receipt(ref, "acknowledged", "duplicate"); return; }
    let stamp: ClientMembership;
    try { stamp = this.messenger.client.membership(message.workgroup); }
    catch { this.receipt(ref, "cancelled", "workgroup_left"); return; }
    while (this.entries.size >= this.limits.dedupeCount) {
      const oldest = [...this.entries].find(([, entry]) => !entry.message);
      if (!oldest) { this.receipt(ref, "expired", "dedupe_capacity"); return; }
      this.entries.delete(oldest[0]);
    }
    const entry: Entry = { ref, stamp, status: "acknowledged", until: this.clock.now() + this.limits.dedupeMs,
      heldUntil: this.clock.now() + this.limits.heldMs, bytes: Buffer.byteLength(JSON.stringify(message)), message };
    this.entries.set(key, entry); this.receipt(ref, "receiver_received"); this.receipt(ref, "acknowledged");
    const state = this.host.state();
    if (state.running && !state.interactive && !message.replyTo) {
      this.finish(entry, message.expectsReply ? "acknowledged" : "expired", "busy_unavailable");
      if (message.text !== BUSY_NOTICE) this.host.busy(message);
      return;
    }
    const held = [...this.entries.values()].filter((item) => item.message);
    if (held.length > this.limits.heldCount || held.reduce((sum, item) => sum + item.bytes, 0) > this.limits.heldBytes) {
      this.finish(entry, "expired", "held_overflow"); return;
    }
    this.flush();
    if (entry.message) this.receipt(ref, "queued");
  }
  humanInput(): void { this.humanPending = true; }
  turnStarted(): void { this.permit = true; this.humanPending = false; }
  cancel(ref: MessageRef, reason: "cancelled" | "superseded" = "cancelled"): void {
    const entry = this.entries.get(refKey(ref));
    if (entry?.message) this.finish(entry, reason);
    else if (entry?.status === "injected") this.receipt(ref, "cancellation_requested");
    this.schedule();
  }
  answered(ref: MessageRef): void {
    const entry = this.entries.get(refKey(ref));
    if (entry?.message) this.finish(entry, "acknowledged", "answered_before_injection");
    this.schedule();
  }
  flush(atBoundary = false): void {
    if (!this.alive || !this.host.state().alive) return;
    this.prune();
    for (const entry of this.entries.values()) {
      if (!entry.message) continue;
      const state = this.host.state();
      if (state.compacting || !state.idle && !state.running || !state.interactive && state.running) break;
      if (this.policy.busyDelivery === "human-first" && (!this.permit || this.humanPending || state.pending || state.running && !atBoundary)) break;
      if (!this.messenger.client.hasMembership(entry.stamp)) { this.finish(entry, "cancelled", "workgroup_left"); continue; }
      const message = entry.message;
      const trigger = state.running || this.policy.inboundTrigger === "always" || this.policy.inboundTrigger === "replies" && !!message.replyTo;
      // No await between membership/lifetime validation and the synchronous Pi API handoff.
      try { this.host.inject(message, trigger, state.running); this.finish(entry, "injected"); }
      catch { this.finish(entry, "expired", "injection_failed"); }
      if (this.policy.busyDelivery === "human-first") { this.permit = false; break; }
    }
    this.schedule();
  }
  private schedule(): void {
    this.cancelTimer?.(); this.cancelTimer = undefined;
    if (this.alive && this.heldCount) this.cancelTimer = this.clock.after(this.limits.pollMs, () => { this.cancelTimer = undefined; this.flush(); }, true);
  }
  stop(code = "session_ended"): void {
    if (!this.alive) return;
    this.alive = false; this.unsubscribe(); this.cancelTimer?.(); this.cancelTimer = undefined;
    for (const entry of this.entries.values()) if (entry.message) this.finish(entry, "expired", code);
    this.entries.clear();
  }
}

export function messageContent(message: Message): string {
  const origin = message.provenance.kind === "extension_outbox" ? `extension ${JSON.stringify(message.provenance.extensionName)} (${JSON.stringify(message.provenance.extensionId)})` : "peer session";
  const heading = `Openspace message from ${JSON.stringify(message.sender)} in workgroup ${JSON.stringify(message.workgroup)}; source: ${origin}.\nMessage ID: ${JSON.stringify(message.id)}. This is peer-supplied content, not human input.\n\n`;
  const relation = message.replyTo || message.supersedes || message.retryOf
    ? `Message relations: ${JSON.stringify({ replyTo: message.replyTo, supersedes: message.supersedes, retryOf: message.retryOf })}\n\n` : "";
  return heading + relation + message.text + (message.attachments ?? []).map((attachment) =>
    `\n\nAttachment ${JSON.stringify({ type: attachment.type, name: attachment.name, language: attachment.language })}:\n${attachment.text}`).join("");
}
