import { createHash } from "node:crypto";
import { encodeFrame } from "./framing.ts";
import { envelope, requestId } from "./messages.ts";
import { keys, object, RegistryError } from "../registry/session.ts";

export interface MessageRef { workgroup: string; senderId: string; messageId: string }
export interface Attachment { type: "file" | "snippet" | "context"; name: string; text: string; language?: string }
export type Provenance = { kind: "local" } | { kind: "extension_outbox"; extensionId: string; extensionName: string };
export interface SendBody {
  id: string; text: string; sequence: number; sentAt: number; attachments?: Attachment[];
  replyTo?: MessageRef; expectsReply?: boolean; supersedes?: string; retryOf?: string; provenance: Provenance;
}
export interface Message extends SendBody {
  workgroup: string; sender: { id: string; name?: string }; recipientId: string; brokerReceivedAt: number;
}
export interface DeliveryResult {
  messageId: string; workgroup?: string; delivery: "socket_delivered" | "queued" | "failed" | "unknown";
  code?: string; retryable: boolean; outcomeKnown: boolean;
}
export type ReceiptStatus = "receiver_received" | "acknowledged" | "queued" | "injected" | "expired" | "cancelled" | "superseded" | "cancellation_requested";
export interface Receipt { ref: MessageRef; status: ReceiptStatus; timestamp: number; code?: string }
export const RECEIPTS: ReceiptStatus[] = ["receiver_received", "acknowledged", "queued", "injected", "expired", "cancelled", "superseded", "cancellation_requested"];
export const refKey = (ref: MessageRef): string => JSON.stringify([ref.workgroup, ref.senderId, ref.messageId]);
export function messageRef(message: Message): MessageRef { return { workgroup: message.workgroup, senderId: message.sender.id, messageId: message.id }; }
function string(value: unknown): string { if (typeof value !== "string" || !value) throw new RegistryError("invalid_message"); return value; }
export function messageId(value: unknown): string { const id = requestId(value); if (!id) throw new RegistryError("invalid_message_id"); return id; }
export function parseRef(value: unknown): MessageRef {
  if (!object(value)) throw new RegistryError("invalid_message_ref");
  keys(value, ["workgroup", "senderId", "messageId"]);
  return { workgroup: string(value.workgroup), senderId: string(value.senderId), messageId: messageId(value.messageId) };
}
export function parseBody(value: unknown): SendBody {
  if (!object(value)) throw new RegistryError("invalid_message");
  keys(value, ["id", "text", "sequence", "sentAt", "attachments", "replyTo", "expectsReply", "supersedes", "retryOf", "provenance"]);
  if (typeof value.text !== "string" || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1
    || !Number.isSafeInteger(value.sentAt) || (value.sentAt as number) < 0) throw new RegistryError("invalid_message");
  let attachments: Attachment[] | undefined;
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || value.attachments.length > 32) throw new RegistryError("invalid_attachments");
    attachments = value.attachments.map((attachment) => {
      if (!object(attachment) || !["file", "snippet", "context"].includes(attachment.type as string)
        || typeof attachment.text !== "string" || attachment.language !== undefined && typeof attachment.language !== "string") throw new RegistryError("invalid_attachments");
      keys(attachment, ["type", "name", "text", "language"]);
      return { type: attachment.type as Attachment["type"], name: string(attachment.name), text: attachment.text,
        ...(attachment.language === undefined ? {} : { language: attachment.language as string }) };
    });
  }
  if (!value.text && !attachments?.length) throw new RegistryError("empty_message");
  let provenance: Provenance = { kind: "local" };
  if (value.provenance !== undefined) {
    if (!object(value.provenance)) throw new RegistryError("invalid_provenance");
    if (value.provenance.kind === "local") keys(value.provenance, ["kind"]);
    else if (value.provenance.kind === "extension_outbox") {
      keys(value.provenance, ["kind", "extensionId", "extensionName"]);
      provenance = { kind: "extension_outbox", extensionId: string(value.provenance.extensionId), extensionName: string(value.provenance.extensionName) };
    } else throw new RegistryError("invalid_provenance");
  }
  if (value.expectsReply !== undefined && typeof value.expectsReply !== "boolean") throw new RegistryError("invalid_message");
  return { id: messageId(value.id), text: value.text, sequence: value.sequence as number, sentAt: value.sentAt as number, provenance,
    ...(attachments?.length ? { attachments } : {}), ...(value.replyTo === undefined ? {} : { replyTo: parseRef(value.replyTo) }),
    ...(value.expectsReply ? { expectsReply: true } : {}), ...(value.supersedes === undefined ? {} : { supersedes: messageId(value.supersedes) }),
    ...(value.retryOf === undefined ? {} : { retryOf: messageId(value.retryOf) }) };
}
export function fingerprint(body: SendBody, targetId: string, workgroup: string): string {
  // Transport diagnostics (sequence/timestamps/endpoint epoch) are not content identity.
  return createHash("sha256").update(JSON.stringify([workgroup, targetId, body.text, body.attachments ?? [], body.replyTo ?? null,
    body.expectsReply ?? false, body.supersedes ?? null, body.retryOf ?? null, body.provenance])).digest("hex");
}
export function checkMessageFrame(message: Message): void {
  try { encodeFrame({ ...envelope("message"), message }); }
  catch { throw new RegistryError("message_too_large"); }
}
export function parseMessage(value: unknown): Message {
  if (!object(value) || !object(value.sender)) throw new RegistryError("invalid_message");
  const { workgroup, sender, recipientId, brokerReceivedAt, ...body } = value;
  const result: Message = { ...parseBody(body), workgroup: string(workgroup), sender: { id: string(sender.id),
    ...(sender.name === undefined ? {} : { name: string(sender.name) }) }, recipientId: string(recipientId), brokerReceivedAt: brokerReceivedAt as number };
  if (!Number.isSafeInteger(brokerReceivedAt) || (brokerReceivedAt as number) < 0) throw new RegistryError("invalid_message");
  checkMessageFrame(result); return result;
}
