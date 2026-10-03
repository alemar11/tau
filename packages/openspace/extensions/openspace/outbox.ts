import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPENSPACE_OUTBOX_CODES as CODES, OPENSPACE_OUTBOX_REQUEST_EVENT, OPENSPACE_OUTBOX_RESULT_EVENT, type OutboxRequest, type OutboxResult } from "../../extension-api.mjs";
import { ClientError, type ClientMembership } from "../../src/client/client.ts";
import { outboxId, outboxRequest } from "../../src/protocol/outbox.ts";
import { checkMessageFrame } from "../../src/protocol/delivery.ts";
import type { PiRuntime } from "./runtime.ts";
import { singleLine, terminalSafe } from "./ui/render.ts";

export const OUTBOX_LIMITS = { pending: 32, bytes: 8 * 1024 * 1024, ids: 4096 };
export interface OutboxOptions { limits?: Partial<typeof OUTBOX_LIMITS> }
interface Pending {
  request: OutboxRequest; bytes: number; messageId: string; controller: AbortController;
  done: boolean; sending: boolean; endpoint?: string; senderId?: string;
  stamps?: ClientMembership[]; group?: string; to?: string;
}
function emit(pi: ExtensionAPI, result: OutboxResult): void {
  // Results contain primitives only. One consumer cannot mutate another consumer's correlation ID.
  pi.events.emit(OPENSPACE_OUTBOX_RESULT_EVENT, Object.freeze(result));
}
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}
function attribution(request: OutboxRequest) { return { extensionId: request.extensionId, extensionName: request.extensionName }; }
export function registerOutbox(pi: ExtensionAPI, current: () => PiRuntime | undefined): () => void {
  return pi.events.on(OPENSPACE_OUTBOX_REQUEST_EVENT, (input) => {
    const runtime = current();
    if (runtime) { runtime.outbox.request(input); return; }
    const id = outboxId(input); if (!id) { console.error(`Openspace outbox: ${CODES.invalidRequest}`); return; }
    let request: OutboxRequest;
    try { request = outboxRequest(input).request; }
    catch { emit(pi, { version: 1, requestId: id, status: "rejected", code: CODES.invalidRequest }); return; }
    emit(pi, { version: 1, requestId: id, status: "failed", code: CODES.unavailable, ...attribution(request) });
  });
}

/** Notify-only, per-runtime admission and settle-once. Never calls the conversational reply inference path. */
export class Outbox {
  private readonly pi: ExtensionAPI;
  private readonly runtime: PiRuntime;
  private readonly limits: typeof OUTBOX_LIMITS;
  private readonly used = new Set<string>();
  private readonly pending = new Set<Pending>();
  private bytes = 0;
  private stopped = false;
  private readonly unsubscribe: () => void;
  constructor(pi: ExtensionAPI, runtime: PiRuntime, options: OutboxOptions = {}) {
    this.pi = pi; this.runtime = runtime; this.limits = { ...OUTBOX_LIMITS, ...options.limits };
    for (const key of Object.keys(OUTBOX_LIMITS) as (keyof typeof OUTBOX_LIMITS)[]) {
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > OUTBOX_LIMITS[key]) throw new Error("Invalid outbox capacity");
    }
    this.unsubscribe = runtime.client.subscribe((event) => {
      if (this.stopped) return;
      for (const entry of [...this.pending]) {
        if (event.type === "state" && ["disconnected", "revoked", "closing"].includes(event.state)) this.fail(entry, event.error?.code ?? "disconnected");
        if (event.type === "session") {
          const group = entry.group ?? entry.request.workgroup;
          if (group && event.left.includes(group)) this.fail(entry, "workgroup_left");
          else if (entry.endpoint && event.session.endpointEpoch !== entry.endpoint) this.fail(entry, "connection_replaced");
        }
      }
    });
  }
  request(input: unknown): void {
    const id = outboxId(input); if (!id) { console.error(`Openspace outbox: ${CODES.invalidRequest}`); return; }
    const key = createHash("sha256").update(JSON.stringify(id)).digest("hex");
    if (this.used.has(key)) { emit(this.pi, { version: 1, requestId: id, status: "rejected", code: CODES.duplicateRequest }); return; }
    let captured: ReturnType<typeof outboxRequest>;
    try { captured = outboxRequest(input); }
    catch { emit(this.pi, { version: 1, requestId: id, status: "rejected", code: CODES.invalidRequest }); return; }
    const { request, bytes } = captured, base = { version: 1 as const, requestId: id, ...attribution(request) };
    if (this.stopped) { emit(this.pi, { ...base, status: "failed", code: CODES.sessionEnded }); return; }
    if (this.used.size >= this.limits.ids) { emit(this.pi, { ...base, status: "blocked", code: CODES.idCapacity }); return; }
    this.used.add(key); // Includes requests rejected by admission: never silently forget an ID and permit a later send.
    if (this.pending.size >= this.limits.pending || this.bytes + bytes > this.limits.bytes) { emit(this.pi, { ...base, status: "blocked", code: CODES.pendingCapacity }); return; }
    const info = this.runtime.client.info;
    const entry: Pending = { request, bytes, messageId: randomUUID(), controller: new AbortController(), done: false, sending: false,
      ...(this.runtime.client.isConnected && info ? { endpoint: info.endpointEpoch, senderId: info.id, stamps: info.workgroups.map((group) => this.runtime.client.membership(group)) } : {}) };
    this.pending.add(entry); this.bytes += bytes; void this.run(entry);
  }
  private check(entry: Pending, group = entry.group): void {
    if (entry.done || this.stopped) throw new ClientError(CODES.sessionEnded);
    this.runtime.assertCurrent();
    const client = this.runtime.client, info = client.info;
    if (!client.isConnected || !info) throw new ClientError("disconnected");
    if (entry.endpoint && (info.endpointEpoch !== entry.endpoint || info.id !== entry.senderId)) throw new ClientError("connection_replaced");
    if (group) {
      const stamp = entry.stamps?.find((stamp) => stamp.workgroup === group);
      if (!stamp || !client.hasMembership(stamp)) throw new ClientError("workgroup_left");
    }
  }
  private async run(entry: Pending): Promise<void> {
    const { request, controller } = entry, signal = controller.signal;
    try {
      await wait(this.runtime.ready(), signal); this.check(entry);
      const client = this.runtime.client, info = client.info!;
      entry.endpoint ??= info.endpointEpoch; entry.senderId ??= info.id; entry.stamps ??= info.workgroups.map((group) => client.membership(group));
      // First lookup is live-only. The second obtains the exact send/membership ticket for that ID and fixed group, never another name match.
      const live = await wait(client.resolve({ to: request.to, workgroup: request.workgroup }), signal); this.check(entry, live.workgroup);
      entry.group = live.workgroup; entry.to = live.session.id;
      const selected = await wait(this.runtime.messenger.resolve({ to: live.session.id, workgroup: live.workgroup }), signal); this.check(entry, live.workgroup);
      if (!selected.connected) throw new ClientError("target_disconnected");
      if (selected.session.endpointEpoch !== live.session.endpointEpoch) throw new ClientError("endpoint_rebound");
      const provenance = { kind: "extension_outbox" as const, ...attribution(request) };
      checkMessageFrame({ id: entry.messageId, text: request.message, sequence: 1, sentAt: Date.now(), brokerReceivedAt: Date.now(), provenance,
        sender: { id: info.id, ...(info.name ? { name: info.name } : {}) }, recipientId: selected.session.id, workgroup: selected.workgroup });
      if (this.runtime.config.confirmSend) {
        const ctx = this.runtime.context;
        if (!ctx.hasUI) { this.finish(entry, { status: "blocked", code: CODES.confirmationUnavailable }); return; }
        let approved: boolean;
        try { approved = await wait(ctx.ui.confirm("Openspace: invio da estensione", `${singleLine(request.extensionName)} (${singleLine(request.extensionId)})\nA ${singleLine(selected.session.name ?? selected.session.id)} [${singleLine(selected.session.id)}] · ${singleLine(selected.workgroup)}\n\n${terminalSafe(request.message)}`, { signal }), signal); }
        catch { this.check(entry); this.finish(entry, { status: "blocked", code: CODES.confirmationUnavailable }); return; }
        this.check(entry);
        if (approved !== true) { this.finish(entry, { status: "rejected", code: CODES.confirmationCancelled }); return; }
      }
      this.check(entry); entry.sending = true;
      const delivery = await wait(this.runtime.messenger.sendResolved(selected, { text: request.message, messageId: entry.messageId, provenance, signal }), signal);
      this.check(entry);
      this.finish(entry, { status: delivery.delivery === "socket_delivered" || delivery.delivery === "queued" ? "sent" : "failed",
        delivery: delivery.delivery, outcomeKnown: delivery.outcomeKnown, ...(delivery.code ? { code: delivery.code } : {}),
        detail: delivery.delivery === "unknown" ? "Esito incerto: può essere stato consegnato; nessun retry automatico." : "Esito di trasporto, non completamento del lavoro." });
    } catch (error) { if (!entry.done) this.fail(entry, error instanceof Error ? error.message : "outbox_failed"); }
  }
  private fail(entry: Pending, code: string): void {
    this.finish(entry, { status: "failed", code, ...(entry.sending ? { delivery: "unknown", outcomeKnown: false,
      detail: "Il runtime o il collegamento è cambiato durante l'invio; il messaggio può essere stato consegnato." } : { outcomeKnown: true }) });
  }
  private finish(entry: Pending, fields: Pick<OutboxResult, "status"> & Partial<OutboxResult>): void {
    if (entry.done) return;
    entry.done = true; this.pending.delete(entry); this.bytes -= entry.bytes;
    const result: OutboxResult = { ...fields, version: 1, requestId: entry.request.requestId, ...attribution(entry.request), messageId: entry.messageId,
      ...(entry.group ? { to: entry.to, workgroup: entry.group } : {}) };
    // Publish before abort cleanup: UI abort callbacks may reenter shutdown or other outbox operations.
    try { this.runtime.traceOutbox(entry.request, result); emit(this.pi, result); }
    finally { entry.controller.abort(new ClientError(fields.code ?? "outbox_settled")); }
  }
  stop(): void {
    if (this.stopped) return; this.stopped = true; this.unsubscribe();
    for (const entry of [...this.pending]) this.fail(entry, CODES.sessionEnded);
    this.used.clear();
  }
}
