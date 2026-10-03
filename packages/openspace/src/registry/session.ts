import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { effectiveWorkgroups } from "../workgroups.ts";
import type { SessionInfo, SessionStatus } from "../../extension-api.mjs";
export type { SessionInfo, SessionStatus, ContextUsage } from "../../extension-api.mjs";

export const MAX_SESSION_BYTES = 6 * 1024;
export const MAX_SESSIONS = 128;
export class RegistryError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new RegistryError("invalid_metadata");
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new RegistryError("invalid_metadata");
  return value.trim();
}
function integer(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new RegistryError("invalid_metadata");
  return value as number;
}
export function groups(value: unknown): string[] {
  if (!Array.isArray(value)) throw new RegistryError("invalid_workgroups");
  try { return effectiveWorkgroups(value).sort(); }
  catch { throw new RegistryError("invalid_workgroups"); }
}
function cwdText(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new RegistryError("invalid_cwd");
  return value;
}
export function canonicalCwd(value: unknown, base: string): string {
  const path = cwdText(value);
  // Resolve existing symlinks before lexical '..'; preserve significant spaces.
  const candidate = isAbsolute(path) ? path : `${base}/${path}`;
  try { return realpathSync.native(candidate); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return resolve(base, path);
    throw new RegistryError("invalid_cwd");
  }
}
function status(value: unknown): SessionStatus {
  if (!object(value)) throw new RegistryError("invalid_status");
  keys(value, value.state === "tool" ? ["state", "toolName", "note"] : ["state", "note"]);
  if (!["idle", "thinking", "tool"].includes(value.state as string)) throw new RegistryError("invalid_status");
  if (value.note !== undefined && (typeof value.note !== "string" || Buffer.byteLength(value.note) > 1024)) {
    throw new RegistryError("invalid_status");
  }
  const note = value.note === undefined ? {} : { note: value.note as string };
  if (value.state !== "tool") return { state: value.state as "idle" | "thinking", ...note };
  if (typeof value.toolName !== "string" || !value.toolName.trim() || Buffer.byteLength(value.toolName) > 256) {
    throw new RegistryError("invalid_status");
  }
  return { state: "tool", toolName: value.toolName, ...note };
}
const PATCH_FIELDS = ["name", "model", "status", "contextUsage", "tmuxPane"] as const;
export function applyPatch(record: SessionInfo, input: unknown, alias: string): SessionInfo {
  if (!object(input)) throw new RegistryError("invalid_metadata");
  keys(input, PATCH_FIELDS);
  const result = structuredClone(record);
  for (const key of ["name", "tmuxPane"] as const) {
    if (!Object.hasOwn(input, key)) continue;
    if (input[key] === null) delete result[key]; else result[key] = text(input[key]);
  }
  if (Object.hasOwn(input, "model")) result.model = text(input.model);
  if (Object.hasOwn(input, "status")) {
    if (input.status === null) delete result.status; else result.status = status(input.status);
  }
  if (Object.hasOwn(input, "contextUsage")) {
    if (input.contextUsage === null) delete result.contextUsage;
    else {
      const usage = input.contextUsage;
      if (!object(usage)) throw new RegistryError("invalid_metadata");
      keys(usage, ["tokens", "contextWindow", "percent"]);
      if (usage.percent !== null && (typeof usage.percent !== "number" || !Number.isFinite(usage.percent) || usage.percent < 0)) {
        throw new RegistryError("invalid_metadata");
      }
      result.contextUsage = { tokens: usage.tokens === null ? null : integer(usage.tokens),
        contextWindow: integer(usage.contextWindow), percent: usage.percent as number | null };
    }
  }
  if (result.name) delete result.runtimeFallbackAlias; else result.runtimeFallbackAlias = alias;
  return result;
}
export function assertRecord(record: SessionInfo): void {
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_SESSION_BYTES) throw new RegistryError("record_too_large");
}
export function makeSession(input: unknown, workgroups: unknown, base: string, epoch: string, alias: string, now: number): SessionInfo {
  if (!object(input)) throw new RegistryError("invalid_metadata");
  keys(input, ["id", "cwd", "model", "pid", "startedAt", ...PATCH_FIELDS]);
  const metadata = Object.fromEntries(PATCH_FIELDS.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
  const record = applyPatch({ id: text(input.id), endpointEpoch: epoch, revision: 1, membershipRevision: 1,
    workgroups: groups(workgroups), cwd: cwdText(input.cwd), model: text(input.model), pid: integer(input.pid, 1),
    startedAt: input.startedAt === undefined ? now : integer(input.startedAt), lastActivity: now, trustedLocal: true }, metadata, alias);
  // Check before filesystem operations as well as after symlink expansion.
  assertRecord(record);
  record.cwd = canonicalCwd(record.cwd, base);
  assertRecord(record);
  return record;
}
export function commonGroups(a: SessionInfo, b: SessionInfo): string[] {
  return a.workgroups.filter((group) => b.workgroups.includes(group));
}
export function project(viewer: SessionInfo, peer: SessionInfo): SessionInfo | undefined {
  const workgroups = commonGroups(viewer, peer);
  return workgroups.length ? { ...structuredClone(peer), workgroups } : undefined;
}
