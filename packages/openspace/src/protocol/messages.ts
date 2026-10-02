import { OPENSPACE_NAMESPACE, OPENSPACE_PROTOCOL_VERSION } from "../constants.ts";
import { effectiveWorkgroups, normalizeSpecificWorkgroups } from "../workgroups.ts";

export const FEATURES = ["liveness-v1"] as const;
export const MAX_REQUEST_ID_BYTES = 256;
export const MAX_REGISTRATION_BYTES = 6 * 1024;

export function envelope(type: string, requestId?: string) {
  return { type, protocol: OPENSPACE_NAMESPACE, version: OPENSPACE_PROTOCOL_VERSION,
    ...(requestId === undefined ? {} : { requestId }) };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requestId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_REQUEST_ID_BYTES
    && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
}

export class ProtocolError extends Error {
  readonly code: string;
  readonly requestId?: string;
  constructor(code: string, requestId?: string) {
    super(code);
    this.code = code;
    this.requestId = requestId;
  }
}

export interface Request {
  type: string;
  requestId: string;
  workgroups?: string[];
}

export function parseRequest(value: unknown): Request {
  if (!isObject(value)) throw new ProtocolError("invalid_request");
  const id = requestId(value.requestId);
  if (value.protocol !== OPENSPACE_NAMESPACE || value.version !== OPENSPACE_PROTOCOL_VERSION) {
    throw new ProtocolError("incompatible_protocol", id);
  }
  if (!id || typeof value.type !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.type)) {
    throw new ProtocolError("invalid_request", id);
  }
  const allowed = ["type", "protocol", "version", "requestId"];
  if (value.type === "register") allowed.push("workgroups");
  if (["health", "register", "ping"].includes(value.type) && Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ProtocolError("invalid_request", id);
  }
  if (value.type !== "register") return { type: value.type, requestId: id };
  if (!Array.isArray(value.workgroups) || value.workgroups.some((group) => typeof group !== "string")) {
    throw new ProtocolError("invalid_workgroups", id);
  }
  try {
    return { type: value.type, requestId: id, workgroups: effectiveWorkgroups(normalizeSpecificWorkgroups(value.workgroups)) };
  } catch {
    throw new ProtocolError("invalid_workgroups", id);
  }
}

export interface Health {
  type: "health_result";
  protocol: "openspace";
  version: 1;
  requestId: string;
  pid: number;
  instanceId: string;
  features: string[];
}

export function isHealth(value: unknown, id: string): value is Health {
  return isObject(value) && value.type === "health_result" && value.protocol === OPENSPACE_NAMESPACE
    && value.version === OPENSPACE_PROTOCOL_VERSION && value.requestId === id
    && Number.isSafeInteger(value.pid) && (value.pid as number) > 0
    && typeof value.instanceId === "string" && /^[a-f0-9]{32}$/.test(value.instanceId)
    && Array.isArray(value.features) && value.features.length <= 16
    && value.features.every((feature) => typeof feature === "string" && feature.length <= 64);
}
