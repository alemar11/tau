import { applyPatch, assertRecord, groups, object, type SessionInfo } from "../registry/session.ts";
import { requestId } from "../protocol/messages.ts";

export class ClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly outcomeKnown: boolean;
  constructor(code: string, options: { retryable?: boolean; outcomeKnown?: boolean; cause?: unknown } = {}) {
    super(code, { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? ["disconnected", "connect_failed", "timeout", "session_limit", "lease_capacity", "storage_failed", "connection_replaced", "write_failed", "outcome_unknown"].includes(code);
    this.outcomeKnown = options.outcomeKnown ?? true;
  }
}
export const REVOKED = new Set(["endpoint_replaced", "endpoint_revoked", "lease_unknown", "lease_expired", "lease_invalid"]);
export function response(value: unknown): Record<string, unknown> {
  if (!object(value) || value.protocol !== "openspace" || value.version !== 1 || typeof value.type !== "string"
    || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.type) || value.requestId !== undefined && !requestId(value.requestId)) throw new ClientError("invalid_response");
  return value;
}
export function features(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16 || value.some((item) => typeof item !== "string" || !item || item.length > 64)) throw new ClientError("invalid_response");
  return [...value];
}
/** Validate the complete wire record without filesystem access or trusting its TS cast. */
export function session(value: unknown): SessionInfo {
  try {
    if (!object(value) || typeof value.id !== "string" || !value.id || typeof value.endpointEpoch !== "string"
      || !/^[a-f0-9-]{36}$/.test(value.endpointEpoch) || value.trustedLocal !== true || typeof value.cwd !== "string" || !value.cwd
      || typeof value.model !== "string" || !value.model) throw new Error();
    for (const field of ["revision", "membershipRevision", "pid"]) if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 1) throw new Error();
    for (const field of ["startedAt", "lastActivity"]) if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) throw new Error();
    const memberships = value.workgroups;
    if (!Array.isArray(memberships) || !memberships.length) throw new Error();
    if (!(memberships.length === 1 && memberships[0] === "default") && JSON.stringify(groups(memberships)) !== JSON.stringify(memberships)) throw new Error();
    for (const field of ["name", "runtimeFallbackAlias", "status", "contextUsage", "tmuxPane"]) {
      if (Object.hasOwn(value, field) && value[field] === null) throw new Error();
    }
    if (value.name === undefined && (typeof value.runtimeFallbackAlias !== "string" || !value.runtimeFallbackAlias)) throw new Error();
    const patch = Object.fromEntries(["name", "model", "status", "contextUsage", "tmuxPane"].filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
    applyPatch(value as unknown as SessionInfo, patch, String(value.runtimeFallbackAlias ?? ""));
    assertRecord(value as unknown as SessionInfo);
    return structuredClone(value) as unknown as SessionInfo;
  } catch { throw new ClientError("invalid_response"); }
}
