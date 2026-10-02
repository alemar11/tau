import { domainToASCII } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseHTML } from "linkedom";
import type { Config, Provider } from "./config.ts";
import { PROVIDERS } from "./config.ts";
import { abortable, canonicalUrl, check, choice, concurrent, deadline, diagnostic, fail, integer, keys, listInput, object, stopError, WebError, type Diagnostic } from "./core.ts";
import { decode, jsonReply, requireSuccess, type Reply, type Transport } from "./network.ts";

export interface SearchOptions { provider: Provider; numResults: number; recencyFilter?: string; domainFilter: string[] }
export interface Source { title?: string; url: string; domain: string; excerpt?: string; excerptOrigin?: "provider-excerpt"; publishedAt?: string }
export interface Attempt { provider: string; transport: string; outcome: "ok" | "error"; durationMs: number; error?: Diagnostic; tool?: string }
export interface SearchResult { query: string; inputIndices: number[]; providerUsed?: string; transportUsed?: string; model?: string; auth?: string; attempts: Attempt[]; results: Source[]; answer?: string; error?: Diagnostic; filterSupport?: { domains: string; recency: string }; warnings?: string[]; usage?: Record<string, unknown> }
export type Registry = Pick<ExtensionContext["modelRegistry"], "find" | "isUsingOAuth" | "getProviderAuthStatus" | "getApiKeyAndHeaders" | "getRegisteredProviderConfig" | "getRegisteredNativeProvider">;
export interface SearchDependencies { transport: Transport; registry: Registry; env?: NodeJS.ProcessEnv }
export function searchOptions(input: Record<string, unknown>, config: Config): SearchOptions {
  const provider = choice(input.provider, PROVIDERS, config.search.provider);
  const numResults = integer(input.numResults, 5, 1, 20);
  const recencyFilter = input.recencyFilter === undefined ? undefined : choice(input.recencyFilter, ["day", "week", "month", "year"], "day");
  if (provider === "duckduckgo" && recencyFilter) fail("UNSUPPORTED_FILTER", "DuckDuckGo does not support recency filtering here.");
  const domains = input.domainFilter ?? [];
  if (!Array.isArray(domains) || domains.length > 20) fail("INVALID_INPUT", "domainFilter must contain at most 20 hostnames.");
  const domainFilter = (domains as unknown[]).map((v) => {
    if (typeof v !== "string" || v.length > 254) return fail("INVALID_INPUT", "Invalid domain filter.");
    const negative = v.startsWith("-"), raw = negative ? v.slice(1) : v;
    const domain = domainToASCII(raw).toLowerCase().replace(/\.$/, "");
    if (!domain || domain.length > 253 || !domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return fail("INVALID_INPUT", "Domain filters must be hostnames without paths, ports or wildcards.");
    return `${negative ? "-" : ""}${domain}`;
  });
  return { provider, numResults, recencyFilter, domainFilter };
}
export function parseSearchInput(raw: unknown, config: Config) {
  const input = object(raw);
  keys(input, ["query", "queries", "provider", "numResults", "recencyFilter", "domainFilter"]);
  return { queries: listInput(input, "query", "queries", 2000), options: searchOptions(input, config) };
}
export function domainAllowed(url: URL, filters: string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const matches = (d: string) => host === d || host.endsWith(`.${d}`);
  const allow = filters.filter((d) => !d.startsWith("-")), deny = filters.filter((d) => d.startsWith("-")).map((d) => d.slice(1));
  return !deny.some(matches) && (!allow.length || allow.some(matches));
}
function source(raw: any): Source | undefined {
  if (!raw || typeof raw.url !== "string" || raw.url.length > 4096) return undefined;
  let url: string;
  try { url = canonicalUrl(raw.url); } catch { return undefined; }
  const result: Source = { url, domain: new URL(url).hostname };
  if (typeof raw.title === "string") result.title = raw.title.slice(0, 500);
  const excerpt = typeof raw.text === "string" ? raw.text : typeof raw.snippet === "string" ? raw.snippet : undefined;
  if (excerpt) { result.excerpt = excerpt.slice(0, 4000); result.excerptOrigin = "provider-excerpt"; }
  if (typeof raw.publishedDate === "string" && Number.isFinite(Date.parse(raw.publishedDate))) result.publishedAt = raw.publishedDate;
  return result;
}
function sources(raw: any[]): Source[] {
  const unique = new Map<string, Source>();
  for (const item of raw) {
    const value = source(item);
    if (!value) fail("RESPONSE_INVALID", "Search returned an invalid source URL.");
    if (!unique.has(value!.url)) unique.set(value!.url, value!);
  }
  return [...unique.values()];
}
export function sseObjects(body: string): any[] {
  const events: any[] = [];
  for (const frame of body.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    try { events.push(JSON.parse(data)); } catch { fail("RESPONSE_INVALID", "Invalid SSE data."); }
  }
  return events;
}
function parseHostedBody(reply: Reply): { results: Source[]; answer?: string; usage?: Record<string, unknown> } {
  const raw = decode(reply);
  let payload: any;
  if (raw.trimStart().startsWith("{")) payload = jsonReply(reply);
  else {
    const events = sseObjects(raw);
    if (events.some((e) => ["error", "response.failed", "response.incomplete"].includes(e.type))) fail("RESPONSE_INVALID", "Hosted search did not complete.");
    const terminalIndex = events.map((e) => e.type === "response.completed" || e.type === "response.done").lastIndexOf(true);
    payload = events[terminalIndex]?.response;
    // Codex can deliver completed items only in the stream, leaving the final output empty.
    if (payload?.status === "completed" && (payload.output === undefined || Array.isArray(payload.output) && !payload.output.length)) {
      const items = new Map<number, any>();
      for (const event of events.slice(0, terminalIndex)) {
        if (event.type !== "response.output_item.done") continue;
        if (!Number.isSafeInteger(event.output_index) || event.output_index < 0 || items.has(event.output_index) || !event.item || typeof event.item.type !== "string") {
          fail("RESPONSE_INVALID", "Hosted search returned malformed streamed output.");
        }
        items.set(event.output_index, event.item);
      }
      payload = { ...payload, output: [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item) };
    }
  }
  if (!payload || payload.status !== "completed" || !Array.isArray(payload.output)) fail("RESPONSE_INVALID", "Hosted search ended without a completed response.");
  const calls = payload.output.filter((v: any) => v.type === "web_search_call");
  if (!calls.length || calls.some((v: any) => v.status !== "completed")) fail("RESPONSE_INVALID", "The model did not complete a web search.");
  const found: any[] = [], answers: string[] = [];
  for (const call of calls) {
    if (Array.isArray(call.action?.sources)) found.push(...call.action.sources);
  }
  for (const output of payload.output) for (const content of output.content ?? []) {
    if (content.type !== "output_text") continue;
    if (typeof content.text === "string") answers.push(content.text);
    for (const annotation of content.annotations ?? []) {
      if (annotation.type === "url_citation") {
        const value = annotation.url_citation ?? annotation;
        if (!source(value)) fail("RESPONSE_INVALID", "Hosted search returned an invalid citation.");
        found.push(value);
      }
    }
  }
  if (!found.length && !calls.every((call: any) => Array.isArray(call.action?.sources))) fail("RESPONSE_INVALID", "Hosted search omitted its source data.");
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const usage = payload.usage && typeof payload.usage === "object" ? {
    inputTokens: count(payload.usage.input_tokens), outputTokens: count(payload.usage.output_tokens), totalTokens: count(payload.usage.total_tokens),
    cachedTokens: count(payload.usage.input_tokens_details?.cached_tokens),
    accounting: "Provider token counts; billing and web-search charges are not available.",
  } : undefined;
  return { results: sources(found), answer: answers.join("\n").slice(0, 30000) || undefined, usage };
}
export function parseOpenAI(reply: Reply) {
  requireSuccess(reply);
  try { return parseHostedBody(reply); }
  catch (error) {
    if (error instanceof WebError) throw error;
    return fail("RESPONSE_INVALID", "Hosted search returned malformed output.");
  }
}
async function openai(query: string, options: SearchOptions, config: Config, deps: SearchDependencies, signal: AbortSignal) {
  const subscription = config.openai.auth === "pi-oauth", provider = subscription ? "openai-codex" : "openai";
  const model = deps.registry.find(provider, config.openai.model);
  const api = subscription ? "openai-codex-responses" : "openai-responses";
  const base = subscription ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1";
  if (!model || model.provider !== provider || model.api !== api || model.baseUrl.replace(/\/$/, "") !== base) fail("MODEL_UNSUPPORTED", "Configure an official OpenAI model compatible with the selected authentication mode.");
  let key: string | undefined;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (subscription) {
    const state = deps.registry.getProviderAuthStatus(provider);
    if (!deps.registry.isUsingOAuth(model!) || state.source !== "stored" || deps.registry.getRegisteredProviderConfig(provider) || deps.registry.getRegisteredNativeProvider(provider)) fail("AUTH_REQUIRED", "Use Pi's official Codex OAuth login; API-key or custom-provider overrides are not accepted in pi-oauth mode.");
    const authScope = deadline(signal, config.limits.requestTimeoutMs, "AUTH_FAILED");
    let auth;
    try { auth = await abortable(deps.registry.getApiKeyAndHeaders(model!), authScope.signal); }
    catch (error) { check(signal); if (stopError(error)) throw error; throw new WebError("AUTH_FAILED", "Pi could not resolve Codex OAuth credentials."); }
    finally { authScope.close(); }
    check(signal);
    if (!deps.registry.isUsingOAuth(model!) || deps.registry.getProviderAuthStatus(provider).source !== "stored") fail("AUTH_FAILED", "Authentication mode changed while resolving credentials.");
    if (!auth.ok || !auth.apiKey) fail("AUTH_FAILED", "Pi could not resolve Codex OAuth credentials.");
    if (auth.ok) {
      if (auth.baseUrl && auth.baseUrl.replace(/\/$/, "") !== base) fail("URL_BLOCKED", "Resolved credentials target a nonofficial endpoint.");
      key = auth.apiKey;
      // Forward only protocol-owned account metadata, never arbitrary configured headers.
      for (const [name, value] of Object.entries(auth.headers ?? {})) {
        if (!["chatgpt-account-id", "openai-organization", "openai-project"].includes(name.toLowerCase()) || typeof value !== "string") continue;
        if (/[\u0000-\u001f\u007f]/u.test(value)) fail("AUTH_FAILED", "Invalid credential metadata.");
        headers[name.toLowerCase()] = value;
      }
    }
  } else {
    key = (deps.env ?? process.env)[config.openai.apiKeyEnv];
    if (!key?.trim()) fail("AUTH_REQUIRED", "Set the configured OpenAI API-key environment variable.");
  }
  if (!key || /[\s\u0000-\u001f\u007f]/u.test(key)) fail("AUTH_FAILED", "Credential contains invalid characters.");
  if (subscription) {
    if (!headers["chatgpt-account-id"]) {
      try {
        // Account metadata only: JWT contents never select a provider or credential destination.
        const claims = JSON.parse(Buffer.from(key!.split(".")[1], "base64url").toString("utf8"));
        const account = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
        if (typeof account !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(account)) throw Error();
        headers["chatgpt-account-id"] = account;
      } catch { fail("AUTH_FAILED", "Codex OAuth credential is missing account metadata."); }
    }
    headers.originator = "pi";
    headers.accept = "text/event-stream";
    headers["OpenAI-Beta"] = "responses=experimental";
  }
  headers.authorization = `Bearer ${key}`;
  const instructions = `Search the web for the user's query. Return a concise answer with source URL citations. Prefer at most ${options.numResults} sources.${options.recencyFilter ? ` Prefer sources from the past ${options.recencyFilter}.` : ""}${options.domainFilter.length ? ` Domain constraints: ${options.domainFilter.join(", ")}; minus-prefixed domains are excluded.` : ""}`;
  const body = { model: config.openai.model, instructions, input: [{ role: "user", content: [{ type: "input_text", text: query }] }], tools: [{ type: "web_search" }], tool_choice: "required", include: ["web_search_call.action.sources"], store: false, stream: subscription };
  const reply = await deps.transport(subscription ? `${base}/codex/responses` : `${base}/responses`, {
    signal, timeoutMs: config.limits.requestTimeoutMs, maxBytes: 4 * 1024 ** 2, authenticated: true,
    method: "POST", headers, body: JSON.stringify(body),
  });
  return { ...parseOpenAI(reply), model: config.openai.model, auth: config.openai.auth, filterSupport: { domains: "post", recency: options.recencyFilter ? "hint" : "none" } };
}
function recencyDate(value?: string): string | undefined {
  if (!value) return undefined;
  const days: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
  return new Date(Date.now() - days[value] * 86400000).toISOString();
}
export function parseExaContent(result: any): Source[] {
  if (result?.isError) fail("PROVIDER_REQUEST_FAILED", "Exa MCP tool reported an error.");
  const structured = result?.structuredContent;
  if (Array.isArray(structured?.results)) return sources(structured.results);
  const blocks = result?.content;
  if (!Array.isArray(blocks)) return fail("RESPONSE_INVALID", "Exa response has no supported content.");
  const value = blocks.filter((b: any) => b && b.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n");
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed.results)) return sources(parsed.results);
    if (Array.isArray(parsed)) return sources(parsed);
  } catch { /* The MCP tool may emit labelled text rather than JSON. */ }
  const entries = value.split(/(?=^Title:\s)/m).filter((v: string) => /^Title:/m.test(v));
  const parsed = entries.map((entry: string) => ({
    title: /^Title:\s*(.*)$/m.exec(entry)?.[1], url: /^URL:\s*(\S+)/m.exec(entry)?.[1],
    text: /^Text:\s*([\s\S]*)/m.exec(entry)?.[1], publishedDate: /^Published Date:\s*(.*)$/m.exec(entry)?.[1],
  }));
  const found = sources(parsed);
  if (found.length) return found;
  if (/^\s*(no (search )?results( found)?[.!]?|\[\])\s*$/i.test(value)) return [];
  return fail("RESPONSE_INVALID", "Exa MCP returned an unrecognized result format.");
}
async function exa(query: string, options: SearchOptions, config: Config, deps: SearchDependencies, signal: AbortSignal): Promise<{ results: Source[]; filterSupport: { domains: string; recency: string }; tool?: string }> {
  if (config.exa.transport === "api") {
    const key = (deps.env ?? process.env)[config.exa.apiKeyEnv];
    if (!key?.trim()) fail("AUTH_REQUIRED", "Set the configured Exa API-key environment variable.");
    if (/[\s\u0000-\u001f\u007f]/u.test(key!)) fail("AUTH_FAILED", "Exa credential contains invalid characters.");
    const body = { query, numResults: options.numResults, contents: { text: { maxCharacters: 4000 } },
      ...(options.domainFilter.some((d) => !d.startsWith("-")) ? { includeDomains: options.domainFilter.filter((d) => !d.startsWith("-")) } : {}),
      ...(options.domainFilter.some((d) => d.startsWith("-")) ? { excludeDomains: options.domainFilter.filter((d) => d.startsWith("-")).map((d) => d.slice(1)) } : {}),
      ...(options.recencyFilter ? { startPublishedDate: recencyDate(options.recencyFilter) } : {}) };
    const data = jsonReply(await deps.transport("https://api.exa.ai/search", { signal, timeoutMs: config.limits.requestTimeoutMs, maxBytes: 4 * 1024 ** 2, authenticated: true, method: "POST", headers: { "content-type": "application/json", "x-api-key": key! }, body: JSON.stringify(body) }));
    if (!Array.isArray(data.results)) fail("RESPONSE_INVALID", "Exa search response is missing results.");
    return { results: sources(data.results), filterSupport: { domains: "native+post", recency: options.recencyFilter ? "native" : "none" } };
  }
  let session: string | undefined, id = 0;
  let version = "2024-11-05";
  const rpc = async (method: string, params: unknown, notification = false) => {
    const requestId = ++id;
    const reply = await deps.transport("https://mcp.exa.ai/mcp", { signal, timeoutMs: config.limits.requestTimeoutMs, maxBytes: 4 * 1024 ** 2, method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": version, ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: requestId }), method, params }) });
    requireSuccess(reply);
    session = reply.headers["mcp-session-id"] ?? session;
    if (notification) return undefined;
    const raw = decode(reply), messages = raw.trimStart().startsWith("{") ? [jsonReply(reply)] : sseObjects(raw);
    const message = messages.find((m: any) => m.id === requestId);
    if (!message || message.error || !("result" in message)) fail("PROVIDER_REQUEST_FAILED", "Exa MCP request failed or returned an invalid response.");
    return message.result;
  };
  try {
    const init = await rpc("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "tau-web", version: "0.1.0" } });
    if (!["2024-11-05", "2025-03-26", "2025-06-18"].includes(init?.protocolVersion)) fail("PROVIDER_UNSUPPORTED", "Exa MCP protocol version is unsupported.");
    version = init.protocolVersion;
    await rpc("notifications/initialized", {}, true);
    const listed = await rpc("tools/list", {});
    if (!Array.isArray(listed?.tools)) fail("RESPONSE_INVALID", "Exa MCP did not list tools.");
    const tool = listed.tools.find((t: any) => t.name === "web_search_advanced_exa") ?? listed.tools.find((t: any) => t.name === "web_search_exa");
    if (!tool) fail("PROVIDER_UNSUPPORTED", "Exa MCP search tools are unavailable.");
    const hint = `${query}${options.recencyFilter ? ` (sources from the past ${options.recencyFilter})` : ""}${options.domainFilter.length ? ` (domain constraints: ${options.domainFilter.join(", ")})` : ""}`;
    const args: Record<string, unknown> = { query: hint, numResults: options.numResults };
    const properties = tool.inputSchema?.properties ?? {};
    // Only use advertised native filter names. Base tools retain explicit hint semantics.
    let nativeDomains = false, nativeRecency = false;
    if (properties.includeDomains && properties.excludeDomains) {
      args.includeDomains = options.domainFilter.filter((d) => !d.startsWith("-"));
      args.excludeDomains = options.domainFilter.filter((d) => d.startsWith("-")).map((d) => d.slice(1)); nativeDomains = true;
    }
    if (options.recencyFilter && properties.startPublishedDate) { args.startPublishedDate = recencyDate(options.recencyFilter); nativeRecency = true; }
    const result = await rpc("tools/call", { name: tool.name, arguments: args });
    return { results: parseExaContent(result), tool: tool.name, filterSupport: { domains: nativeDomains ? "native+post" : "post", recency: options.recencyFilter ? nativeRecency ? "native" : "hint" : "none" } };
  } finally {
    // Session deletion is cleanup only; never replace the original failure or start a new provider.
    if (session && !signal.aborted) await deps.transport("https://mcp.exa.ai/mcp", { signal, timeoutMs: Math.min(1000, config.limits.requestTimeoutMs), maxBytes: 4096, method: "DELETE", headers: { "mcp-session-id": session, "mcp-protocol-version": version } }).catch(() => {});
  }
}
export function parseDuckDuckGo(html: string): Source[] {
  const { document } = parseHTML(html);
  if (document.querySelector("#challenge-form, .anomaly-modal") || /unfortunately, bots use DuckDuckGo|select all squares containing/i.test(html)) fail("PROVIDER_UNAVAILABLE", "DuckDuckGo returned an anti-bot challenge.");
  const found: any[] = [];
  for (const result of document.querySelectorAll(".result")) {
    const link = result.querySelector(".result__a");
    const href = link?.getAttribute("href");
    if (!href) continue;
    let url: URL;
    try { url = new URL(href, "https://html.duckduckgo.com"); } catch { continue; }
    const target = (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) && url.pathname.startsWith("/l/") ? url.searchParams.get("uddg") : url.href;
    found.push({ title: link?.textContent, url: target, snippet: result.querySelector(".result__snippet")?.textContent });
  }
  const results = sources(found);
  if (!results.length && !document.querySelector(".no-results, .result--no-result")) fail("RESPONSE_INVALID", "DuckDuckGo returned an unrecognized page.");
  return results;
}
export async function searchQueries(queries: string[], options: SearchOptions, config: Config, deps: SearchDependencies, signal: AbortSignal): Promise<SearchResult[]> {
  const unique = [...new Set(queries)];
  return concurrent(unique, config.limits.concurrency, signal, async (query) => {
    const item: SearchResult = { query, inputIndices: queries.flatMap((q, i) => q === query ? [i] : []), results: [], attempts: [] };
    const providers = options.provider === "auto" ? ["openai", ...(config.search.fallbackToExa ? ["exa"] : [])] : [options.provider];
    for (const provider of providers) {
      check(signal);
      const mode = provider === "openai" ? config.openai.auth : provider === "exa" ? config.exa.transport : "html";
      const started = Date.now();
      try {
        const result = provider === "openai" ? await openai(query, options, config, deps, signal)
          : provider === "exa" ? await exa(query, options, config, deps, signal)
          : { results: parseDuckDuckGo(decode(await checkedDdg(query, config, deps.transport, signal))), filterSupport: { domains: "post", recency: "none" } };
        check(signal);
        const filtered = result.results.filter((r) => domainAllowed(new URL(r.url), options.domainFilter)).slice(0, options.numResults);
        const answer = "answer" in result && typeof result.answer === "string" ? result.answer : undefined;
        const omitAnswer = options.domainFilter.length > 0 && (!result.results.length || result.results.some((r) => !domainAllowed(new URL(r.url), options.domainFilter)));
        item.attempts.push({ provider, transport: mode, outcome: "ok", durationMs: Date.now() - started, ...("tool" in result ? { tool: result.tool } : {}) });
        return { ...item, ...result, error: undefined, answer: omitAnswer ? undefined : answer, results: filtered, providerUsed: provider, transportUsed: mode, warnings: [ ...(omitAnswer ? ["Answer omitted because its sources do not satisfy the domain filter."] : []), ...(options.recencyFilter && result.filterSupport.recency === "hint" ? ["Recency is a preference, not a guaranteed filter."] : []) ] };
      } catch (error) {
        check(signal);
        if (stopError(error)) throw error;
        const detail = diagnostic(error);
        item.attempts.push({ provider, transport: mode, outcome: "error", durationMs: Date.now() - started, error: detail });
        item.error = detail;
        if (provider !== "openai" || !["RATE_LIMIT", "NETWORK_ERROR", "REQUEST_TIMEOUT", "PROVIDER_UNAVAILABLE"].includes(detail.code)) break;
      }
    }
    return item;
  });
}
async function checkedDdg(query: string, config: Config, transport: Transport, signal: AbortSignal): Promise<Reply> {
  const reply = await transport(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal, timeoutMs: config.limits.requestTimeoutMs, maxBytes: 4 * 1024 ** 2 });
  requireSuccess(reply); return reply;
}
