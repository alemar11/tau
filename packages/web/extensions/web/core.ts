import { createHash } from "node:crypto";

export class WebError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, status?: number, details?: Record<string, unknown>) {
    super(message);
    this.name = "WebError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
export const fail = (code: string, message: string): never => { throw new WebError(code, message); };
export function diagnostic(error: unknown) {
  // Never expose arbitrary remote bodies, URLs containing keys, or registry errors.
  return error instanceof WebError
    ? { code: error.code, message: error.message, ...(error.status ? { status: error.status } : {}) }
    : { code: "INTERNAL_ERROR", message: "Web operation failed unexpectedly." };
}
export type Diagnostic = ReturnType<typeof diagnostic>;
export function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof WebError ? signal.reason : new WebError("CANCELLED", "Web operation cancelled.");
}
export function stopError(error: unknown): boolean {
  return error instanceof WebError && ["CANCELLED", "TOOL_TIMEOUT", "SESSION_CHANGED"].includes(error.code);
}
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); check(signal); }
  return new Promise((resolve, reject) => {
    const abort = () => { try { check(signal); } catch (e) { reject(e); } };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export function deadline(parent: AbortSignal | undefined, ms: number, code = "TOOL_TIMEOUT") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new WebError(code, "Web operation timed out.")), ms);
  timer.unref();
  const abort = () => controller.abort(parent?.reason ?? new WebError("CANCELLED", "Web operation cancelled."));
  if (parent?.aborted) abort(); else parent?.addEventListener("abort", abort, { once: true });
  return { signal: controller.signal, close: () => { clearTimeout(timer); parent?.removeEventListener("abort", abort); } };
}
export async function concurrent<T, R>(items: T[], count: number, signal: AbortSignal, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  // Settle every sibling before returning; failures must not leave background work publishing.
  const workers = Array.from({ length: Math.min(count, items.length) }, async () => {
    while (cursor < items.length) {
      check(signal);
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  const settled = await Promise.allSettled(workers);
  check(signal);
  const failed = settled.find((s) => s.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results;
}
export const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("INVALID_INPUT", "Expected an object.");
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[], code = "INVALID_INPUT") {
  if (Object.keys(value).some((k) => !allowed.includes(k))) fail(code, "Unknown configuration or input field.");
}
export function text(value: unknown, max: number, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) return fail("INVALID_INPUT", `${name} must be nonempty and at most ${max} UTF-16 units.`);
  return value.trim();
}
export function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return fail("INVALID_INPUT", `Expected an integer from ${min} to ${max}.`);
  return value;
}
export function choice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!choices.includes(value as T)) return fail("INVALID_INPUT", "Unsupported option.");
  return value as T;
}
export function listInput(input: Record<string, unknown>, single: string, plural: string, max: number): string[] {
  if ((input[single] === undefined) === (input[plural] === undefined)) fail("INVALID_INPUT", `Supply exactly one of ${single} or ${plural}.`);
  const list = input[single] !== undefined ? [input[single]] : input[plural];
  if (!Array.isArray(list) || !list.length || list.length > 8) return fail("INVALID_INPUT", "Supply between one and eight items.");
  return list.map((v) => text(v, max, single));
}
export function safeEnd(text: string, end: number): number {
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) return end - 1;
  return end;
}
export function canonicalUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return fail("INVALID_INPUT", "Invalid URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return fail("URL_BLOCKED", "Only HTTP(S) URLs without credentials are allowed.");
  url.hash = "";
  return url.href;
}
export function fits(value: unknown, maxChars: number): boolean {
  const serialized = JSON.stringify(value);
  return serialized.length <= maxChars && Buffer.byteLength(serialized) <= 50 * 1024 && serialized.split("\n").length <= 2000;
}
