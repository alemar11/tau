import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch } from "undici";
import ipaddr from "ipaddr.js";
import { abortable, canonicalUrl, check, deadline, fail, WebError } from "./core.ts";

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  authenticated?: boolean;
}
export interface Reply { status: number; headers: Record<string, string>; body: Uint8Array; url: string }
export type Transport = (url: string, options: RequestOptions) => Promise<Reply>;
const AUTH_ENDPOINTS = new Set(["https://chatgpt.com/backend-api/codex/responses", "https://api.openai.com/v1/responses", "https://api.exa.ai/search"]);
export function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch { return false; }
}
export async function resolvePublic(url: URL, resolver = lookup): Promise<{ address: string; family: number }[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".localhost")) fail("URL_BLOCKED", "Local destinations are not allowed.");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolver(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) fail("URL_BLOCKED", "Destination does not resolve exclusively to public addresses.");
  return addresses;
}
// Dependency seam for local protocol fixtures; never exposed as a user setting.
export const createTransport = (resolve: typeof resolvePublic = resolvePublic): Transport => async (raw, options) => {
  const scope = deadline(options.signal, options.timeoutMs, "REQUEST_TIMEOUT");
  try {
    let url = new URL(canonicalUrl(raw));
    for (let hop = 0; hop <= 5; hop++) {
      check(scope.signal);
      if (options.authenticated && !AUTH_ENDPOINTS.has(url.href)) fail("URL_BLOCKED", "Credential destination is not allowed.");
      // The connector receives the already-validated addresses, never a second DNS answer.
      const addresses = await abortable(resolve(url), scope.signal);
      check(scope.signal);
      const agent = new Agent({ connect: { lookup: (_hostname, opts, callback) => {
        const selected = addresses.filter((a) => !opts.family || opts.family === a.family);
        if (!selected.length) { callback(new Error("No validated address"), "", 4); return; }
        if (opts.all) callback(null, selected);
        else callback(null, selected[0].address, selected[0].family);
      } } });
      try {
        const response = await fetch(url, { method: options.method ?? "GET", headers: options.headers, body: options.body, redirect: "manual", dispatcher: agent, signal: scope.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          if (options.authenticated) fail("URL_BLOCKED", "Authenticated redirects are not supported.");
          const location = response.headers.get("location");
          if (!location) fail("RESPONSE_INVALID", "Redirect has no location.");
          if (hop === 5) fail("REDIRECT_LIMIT", "Too many redirects.");
          const next = new URL(canonicalUrl(new URL(location!, url).href));
          if (url.protocol === "https:" && next.protocol !== "https:") fail("URL_BLOCKED", "HTTPS downgrade is not allowed.");
          // MCP sessions and other POST bodies are never replayed to a redirect target.
          if (options.method && options.method !== "GET") fail("URL_BLOCKED", "Protocol redirects are not supported.");
          url = next;
          continue;
        }
        const length = Number(response.headers.get("content-length"));
        if (Number.isFinite(length) && length > options.maxBytes) {
          await response.body?.cancel();
          fail("DOWNLOAD_TOO_LARGE", "Response exceeds the transfer limit.");
        }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const reader = response.body?.getReader();
        if (reader) {
          try {
            while (true) {
              check(scope.signal);
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > options.maxBytes) fail("DOWNLOAD_TOO_LARGE", "Response exceeds the transfer limit.");
              chunks.push(value);
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
        check(scope.signal);
        return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.concat(chunks), url: url.href };
      } finally { await agent.destroy(); }
    }
    return fail("REDIRECT_LIMIT", "Too many redirects.");
  } catch (error) {
    check(scope.signal);
    if (error instanceof WebError) throw error;
    const cause = (error as { cause?: { code?: string }; code?: string });
    const code = cause.cause?.code ?? cause.code ?? "";
    if (/CERT|TLS|SSL|SELF_SIGNED/.test(code)) throw new WebError("URL_BLOCKED", "TLS verification failed.");
    throw new WebError("NETWORK_ERROR", "Network request failed.");
  } finally { scope.close(); }
};
export const request = createTransport();
export function requireSuccess(reply: Reply): void {
  const s = reply.status;
  if (s >= 200 && s < 300) return;
  const code = s === 401 || s === 403 ? "AUTH_FAILED" : s === 429 ? "RATE_LIMIT" : s >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_REQUEST_FAILED";
  throw new WebError(code, `Remote request failed (HTTP ${s}).`, s);
}
export const decode = (reply: Reply) => new TextDecoder().decode(reply.body);
export function jsonReply(reply: Reply): any {
  requireSuccess(reply);
  try { return JSON.parse(decode(reply)); } catch { return fail("RESPONSE_INVALID", "Remote response is not valid JSON."); }
}
