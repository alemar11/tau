import { randomUUID } from "node:crypto";
import { OpenspaceClient, ClientError, type ClientMembership } from "./client.ts";
import { session } from "./responses.ts";
import { checkMessageFrame, parseBody, parseMessage, parseRef, refKey, RECEIPTS, type Attachment, type DeliveryResult, type Message,
  type MessageRef, type Provenance, type Receipt, type ReceiptStatus, type SendBody } from "../protocol/delivery.ts";
import { object, type SessionInfo } from "../registry/session.ts";

function deliveryResult(value: unknown, id: string, group: string): DeliveryResult {
  if (!object(value) || value.messageId !== id || value.workgroup !== group
    || !["socket_delivered", "queued", "failed", "unknown"].includes(value.delivery as string)
    || typeof value.outcomeKnown !== "boolean" || typeof value.retryable !== "boolean"
    || value.code !== undefined && (typeof value.code !== "string" || value.code.length > 128)) throw new ClientError("invalid_response");
  return structuredClone(value) as unknown as DeliveryResult;
}
function receiptResult(value: unknown, ref: MessageRef, status: ReceiptStatus): Receipt {
  if (!object(value) || value.status !== status && !(value.status === "cancellation_requested" && ["cancelled", "superseded", "expired"].includes(status))
    || refKey(parseRef(value.ref)) !== refKey(ref)
    || !Number.isSafeInteger(value.timestamp) || (value.timestamp as number) < 0) throw new ClientError("invalid_response");
  return structuredClone(value) as unknown as Receipt;
}

export interface TargetSelector { to?: string; cwd?: string; workgroup?: string }
export interface ResolvedRecipient {
  session: SessionInfo; workgroup: string; connected: boolean;
  membershipEpoch: string; senderMembershipEpoch: string; stamp: ClientMembership;
}
export interface SendOptions {
  text: string; workgroup?: string; cwd?: string; attachments?: Attachment[]; messageId?: string;
  supersedes?: string; retryOf?: string; replyTo?: MessageRef; expectsReply?: boolean; provenance?: Provenance;
  signal?: AbortSignal;
}
export type MessageEvent = { type: "message"; message: Message } | { type: "receipt"; receipt: Receipt }
  | { type: "ask_closed"; ref: MessageRef; code: string }
  | { type: "control"; ref: MessageRef; action: "cancelled" | "superseded"; replacement?: string };

export class Messenger {
  readonly client: OpenspaceClient;
  private sequence = 0;
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  private readonly unsubscribe: () => void;
  constructor(client: OpenspaceClient) {
    this.client = client;
    this.unsubscribe = client.subscribe((event) => {
      if (event.type !== "wire") return;
      const value = event.message;
      let notification: MessageEvent | undefined;
      if (value.type === "message") notification = { type: "message", message: parseMessage(value.message) };
      else if (value.type === "receipt") notification = { type: "receipt", receipt: structuredClone(value.receipt) as Receipt };
      else if (value.type === "ask_closed") notification = { type: "ask_closed", ref: parseRef(value.ref), code: value.code as string };
      else if (value.type === "message_control") notification = { type: "control", ref: parseRef(value.ref), action: value.action as "cancelled" | "superseded",
        ...(typeof value.replacement === "string" ? { replacement: value.replacement } : {}) };
      if (notification) for (const listener of this.listeners) {
        try { void Promise.resolve(listener(structuredClone(notification))).catch(() => {}); } catch { /* Consumer isolation. */ }
      }
    });
  }
  subscribe(listener: (event: MessageEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dispose(): void { this.unsubscribe(); this.listeners.clear(); }
  async resolve(selector: TargetSelector): Promise<ResolvedRecipient> {
    if (!this.client.isConnected) throw new ClientError("disconnected");
    if (!this.client.supports("exact-send-v1")) throw new ClientError("unsupported_broker");
    const stamps = this.client.info!.workgroups.map((group) => this.client.membership(group));
    const response = await this.client.request("resolve-send", { ...selector }, { response: "resolved" });
    const info = session(response.session);
    const group = response.workgroup;
    if (typeof group !== "string" || !info.workgroups.includes(group) || typeof response.connected !== "boolean"
      || typeof response.membershipEpoch !== "string" || typeof response.senderMembershipEpoch !== "string") throw new ClientError("invalid_response");
    const stamp = stamps.find((stamp) => stamp.workgroup === group);
    if (!stamp || !this.client.hasMembership(stamp)) throw new ClientError("workgroup_left");
    if (!this.client.isConnected) throw new ClientError("disconnected");
    if (info.id === this.client.info!.id) throw new ClientError("self_target");
    return { session: info, workgroup: group, connected: response.connected, membershipEpoch: response.membershipEpoch,
      senderMembershipEpoch: response.senderMembershipEpoch, stamp };
  }
  async send(to: string | undefined, options: SendOptions): Promise<DeliveryResult> {
    const messageId = options.messageId ?? randomUUID();
    try {
      const { signal, ...payload } = options;
      const snapshot = structuredClone(payload);
      const target = await this.resolve({ to, cwd: snapshot.cwd, workgroup: snapshot.workgroup });
      return await this.sendResolved(target, { ...snapshot, signal, messageId });
    } catch (error) { return this.failure(messageId, options.workgroup, error); }
  }
  async sendResolved(selected: ResolvedRecipient, options: SendOptions): Promise<DeliveryResult> {
    const id = options.messageId ?? randomUUID();
    let target = structuredClone(selected);
    const signal = options.signal;
    try {
      const body: SendBody = parseBody({ id, text: options.text, sequence: ++this.sequence, sentAt: Date.now(),
        ...(options.attachments ? { attachments: options.attachments } : {}), ...(options.replyTo ? { replyTo: options.replyTo } : {}),
        ...(options.expectsReply ? { expectsReply: true } : {}), ...(options.supersedes ? { supersedes: options.supersedes } : {}),
        ...(options.retryOf ? { retryOf: options.retryOf } : {}), provenance: options.provenance ?? { kind: "local" } });
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal?.aborted) throw new ClientError("aborted");
        if (!this.client.isConnected) throw new ClientError("disconnected");
        if (!this.client.hasMembership(selected.stamp)) throw new ClientError("workgroup_left");
        const sender = this.client.info!;
        checkMessageFrame({ ...body, sender: { id: sender.id, ...(sender.name ? { name: sender.name } : {}) }, recipientId: target.session.id,
          workgroup: target.workgroup, brokerReceivedAt: Date.now() });
        const response = await this.client.request("send", { to: target.session.id, endpointEpoch: target.session.endpointEpoch,
          membershipEpoch: target.membershipEpoch, senderMembershipEpoch: target.senderMembershipEpoch, workgroup: target.workgroup, message: body },
        { response: "delivery_result", timeoutMs: 10_000, signal, accept: (response) => { deliveryResult(response.result, id, target.workgroup); } });
        const result = deliveryResult(response.result, id, target.workgroup);
        if (result.code !== "endpoint_rebound" || !result.outcomeKnown || attempt > 0) return structuredClone(result);
        // Only this explicit, known-not-delivered response permits one retry. Never repeat an uncertain write.
        target = await this.resolve({ to: selected.session.id, workgroup: selected.workgroup });
        if (target.session.id !== selected.session.id || target.workgroup !== selected.workgroup) throw new ClientError("target_not_found");
      }
      throw new ClientError("endpoint_rebound");
    } catch (error) { return this.failure(id, selected.workgroup, error); }
  }
  private failure(messageId: string, workgroup: string | undefined, error: unknown): DeliveryResult {
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "invalid_message";
    const known = !(error instanceof ClientError) || error.outcomeKnown;
    return { messageId, ...(workgroup ? { workgroup } : {}), delivery: known ? "failed" : "unknown", code,
      retryable: false, outcomeKnown: known };
  }
  async receipt(ref: MessageRef, status: ReceiptStatus, code?: string): Promise<Receipt> {
    const result = await this.client.request("receipt", { receipt: { ref, status, ...(code ? { code } : {}) } }, { response: "receipt_result", accept: (response) => { receiptResult(response.receipt, ref, status); } });
    return receiptResult(result.receipt, ref, status);
  }
  async cancel(ref: MessageRef): Promise<{ ref: MessageRef; status: ReceiptStatus }> {
    const result = await this.client.request("cancel", { ref }, { response: "control_result", accept: (response) => {
      if (refKey(parseRef(response.ref)) !== refKey(ref) || !RECEIPTS.includes(response.status as ReceiptStatus)) throw new ClientError("invalid_response");
    } });
    return { ref: parseRef(result.ref), status: result.status as ReceiptStatus };
  }
}
