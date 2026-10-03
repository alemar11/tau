import { types } from "node:util";
import { OPENSPACE_OUTBOX_CODES, type OutboxRequest } from "../../extension-api.mjs";
import { MAX_FRAME_BYTES } from "./framing.ts";
import { object, text, MAX_SESSION_BYTES, RegistryError } from "../registry/session.ts";
import { requestId } from "./messages.ts";
import { channelGroup } from "./channels.ts";

/** Extract only a safe correlation ID, even when the rest of a local bus request is invalid. */
export function outboxId(input: unknown): string | undefined {
  if (!object(input) || types.isProxy(input)) return undefined;
  const field = Object.getOwnPropertyDescriptor(input, "requestId");
  return field && "value" in field ? requestId(field.value) : undefined;
}
export function outboxRequest(input: unknown): { request: OutboxRequest; bytes: number } {
  try {
    if (!object(input) || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(input), allowed = ["version", "requestId", "extensionId", "extensionName", "to", "workgroup", "message"];
    if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !allowed.includes(key))
      || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) throw new Error();
    const id = outboxId(input);
    if (!id || input.version !== 1 || typeof input.message !== "string" || !input.message) throw new Error();
    const extensionId = text(input.extensionId), extensionName = text(input.extensionName), to = text(input.to);
    if (Buffer.byteLength(extensionId) > 128 || Buffer.byteLength(extensionName) > 256 || Buffer.byteLength(JSON.stringify(to)) > MAX_SESSION_BYTES) throw new Error();
    const request: OutboxRequest = { version: 1, requestId: id, extensionId, extensionName, to, message: input.message,
      ...(input.workgroup === undefined ? {} : { workgroup: channelGroup(input.workgroup) }) };
    const bytes = Buffer.byteLength(JSON.stringify(request));
    if (bytes > MAX_FRAME_BYTES) throw new Error();
    return { request, bytes };
  } catch { throw new RegistryError(OPENSPACE_OUTBOX_CODES.invalidRequest); }
}
