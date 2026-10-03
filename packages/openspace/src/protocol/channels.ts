import { types } from "node:util";
import type { ChannelEvent, ChannelOwner, ChannelState, JsonValue, PublishResult } from "../../extension-api.mjs";
import { session } from "../client/responses.ts";
import { normalizeSpecificWorkgroups } from "../workgroups.ts";
import { keys, object, RegistryError, text } from "../registry/session.ts";

export const CHANNEL_LIMITS = { capabilities: 32, publishBytes: 16 * 1024, stateBytes: 64 * 1024, depth: 64 } as const;
export const channelKey = (workgroup: string, namespace: string): string => JSON.stringify([workgroup, namespace]);
export function namespace(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) throw new RegistryError("invalid_namespace");
  return value;
}
export function channelGroup(value: unknown): string {
  if (value === "default") return value;
  try { const result = normalizeSpecificWorkgroups([value as string])[0]; if (result !== value) throw new Error(); return result!; }
  catch { throw new RegistryError("invalid_workgroup"); }
}
/** Strict JSON values, captured once; no dropped functions, NaN, accessors, cycles or implicit toJSON. */
export function jsonPayload(input: unknown, limit: number): { value: JsonValue; json: string; bytes: number } {
  const ancestors = new Set<object>(); let roughBytes = 0, nodes = 0;
  function walk(value: unknown, depth: number): JsonValue {
    if (depth > CHANNEL_LIMITS.depth || ++nodes > 65536) throw new RegistryError("payload_too_complex");
    if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) {
      roughBytes += JSON.stringify(value).length;
    } else if (typeof value === "string") roughBytes += Buffer.byteLength(value) + 2;
    else if (typeof value === "object" && value !== null) roughBytes += 2;
    else throw new RegistryError("invalid_payload");
    if (roughBytes > limit) throw new RegistryError("payload_too_large");
    if (value === null || typeof value !== "object") return value as JsonValue;
    if (types.isProxy(value)) throw new RegistryError("invalid_payload");
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value), ownKeys = Reflect.ownKeys(value);
    if ((proto !== (array ? Array.prototype : Object.prototype) && proto !== null) || ownKeys.some((key) => typeof key !== "string") || ancestors.has(value)) throw new RegistryError("invalid_payload");
    ancestors.add(value);
    let result: JsonValue;
    if (Array.isArray(value)) {
      if (ownKeys.length !== value.length + 1) throw new RegistryError("invalid_payload");
      result = [];
      for (let i = 0; i < value.length; i++) {
        const item = Object.getOwnPropertyDescriptor(value, String(i));
        if (!item?.enumerable || !("value" in item)) throw new RegistryError("invalid_payload");
        result.push(walk(item.value, depth + 1));
      }
    } else {
      const record: Record<string, JsonValue> = Object.create(null);
      for (const key of ownKeys as string[]) {
        const item = Object.getOwnPropertyDescriptor(value, key)!;
        if (!item.enumerable || !("value" in item)) throw new RegistryError("invalid_payload");
        roughBytes += Buffer.byteLength(key) + 3;
        record[key] = walk(item.value, depth + 1);
      }
      result = record;
    }
    ancestors.delete(value); return result;
  }
  try {
    const captured = walk(input, 0), json = JSON.stringify(captured), bytes = Buffer.byteLength(json);
    if (bytes > limit) throw new RegistryError("payload_too_large");
    return { value: JSON.parse(json) as JsonValue, json, bytes };
  } catch (error) { if (error instanceof RegistryError) throw error; throw new RegistryError("invalid_payload"); }
}
export function revision(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new RegistryError("invalid_revision");
  return value as number;
}
export function channelEpoch(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new RegistryError("invalid_channel_epoch");
  return value;
}
export function channelOwner(value: unknown): ChannelOwner | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) throw new RegistryError("invalid_channel_owner");
  keys(value, ["id", "endpointEpoch", "epoch"]);
  const id = text(value.id);
  if (Buffer.byteLength(JSON.stringify(id)) > 6144) throw new RegistryError("invalid_channel_owner");
  return { id, endpointEpoch: channelEpoch(value.endpointEpoch), epoch: channelEpoch(value.epoch) };
}
export function publishResult(value: unknown): PublishResult {
  if (!object(value)) throw new RegistryError("invalid_publish_result");
  keys(value, ["written", "failed", "unknown"]);
  const result = { written: revision(value.written), failed: revision(value.failed), unknown: revision(value.unknown) };
  if (result.written + result.failed + result.unknown > 128) throw new RegistryError("invalid_publish_result");
  return result;
}
export function channelPacket(value: Record<string, unknown>): { workgroup: string; namespace: string; bindingEpoch: string; event: ChannelEvent } {
  keys(value, ["type", "protocol", "version", "workgroup", "namespace", "bindingEpoch", "event"]);
  const group = channelGroup(value.workgroup), ns = namespace(value.namespace), epoch = channelEpoch(value.bindingEpoch), raw = value.event;
  if (!object(raw)) throw new RegistryError("invalid_channel_event");
  let event: ChannelEvent;
  if (raw.type === "owner") { keys(raw, ["type", "owner"]); event = { type: "owner", owner: channelOwner(raw.owner) }; }
  else if (raw.type === "state") {
    keys(raw, ["type", "state"]); const state = channelState(raw.state); if (!state) throw new RegistryError("invalid_channel_state"); event = { type: "state", state };
  } else if (raw.type === "message") {
    keys(raw, ["type", "sender", "payload"]); const sender = session(raw.sender);
    if (sender.workgroups.length !== 1 || sender.workgroups[0] !== group) throw new RegistryError("invalid_channel_event");
    event = { type: "message", sender, payload: jsonPayload(raw.payload, CHANNEL_LIMITS.publishBytes).value };
  } else if (raw.type === "peer") {
    keys(raw, ["type", "change", "session"]); const peer = session(raw.session);
    if (raw.change !== "joined" && raw.change !== "updated" && raw.change !== "left" || peer.workgroups.length !== 1 || peer.workgroups[0] !== group) throw new RegistryError("invalid_channel_event");
    event = { type: "peer", change: raw.change as "joined" | "updated" | "left", session: peer };
  } else throw new RegistryError("invalid_channel_event");
  return { workgroup: group, namespace: ns, bindingEpoch: epoch, event };
}
export function channelState(value: unknown): ChannelState | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) throw new RegistryError("invalid_channel_state");
  keys(value, ["revision", "updatedAt", "payload", "recovered"]);
  if (value.recovered !== undefined && value.recovered !== true) throw new RegistryError("invalid_channel_state");
  return { revision: revision(value.revision, 1), updatedAt: revision(value.updatedAt), payload: jsonPayload(value.payload, CHANNEL_LIMITS.stateBytes).value,
    ...(value.recovered ? { recovered: true } : {}) };
}
