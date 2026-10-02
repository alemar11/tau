import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../extensions/web/config.ts";
import { domainAllowed, parseDuckDuckGo, parseOpenAI, parseSearchInput, parseExaContent } from "../extensions/web/search.ts";
import { WebError } from "../extensions/web/core.ts";
import { harness, hosted, mcpTransport, registry, reply } from "./helpers.mjs";

test("strict config and inputs reject unknown fields, mixed singular/plural and unsupported filters", () => {
  for (const raw of [{ x: true }, { version: 2 }, { openai: { auth: "automatic" } }, { limits: { concurrency: "3" } }, { limits: { toolTimeoutMs: 1000 } }]) assert.throws(() => parseConfig(raw), /Invalid/);
  const config = parseConfig();
  for (const raw of [{}, { query: "a", queries: ["b"] }, { queries: [] }, { query: "a", domainFilter: ["https://example.com"] }, { query: "a", provider: "duckduckgo", recencyFilter: "week" }]) assert.throws(() => parseSearchInput(raw, config));
  assert.equal(domainAllowed(new URL("https://a.example.com"), ["example.com"]), true);
  assert.equal(domainAllowed(new URL("https://notexample.com"), ["example.com"]), false);
  assert.equal(domainAllowed(new URL("https://a.example.com"), ["example.com", "-a.example.com"]), false);
});
test("OAuth does not use an ambient API key; search and cache preserve sources without a page fetch", async (t) => {
  const h = harness(t, { env: { OPENAI_API_KEY: "paid-key-sentinel" }, transport: async () => reply(hosted()) });
  const result = await h.call("web_search", { query: "energy" });
  assert.equal(result.isError, undefined);
  const data = result.structuredContent.data;
  assert.equal(data.queries[0].providerUsed, "openai");
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(h.requests[0].headers.authorization, "Bearer secret-oauth-sentinel");
  const cached = await h.call("get_cached_web_content", { responseId: data.responseId });
  assert.equal(cached.isError, undefined);
  assert.equal(h.requests.length, 1);
  assert.ok(!JSON.stringify(result).includes("sentinel"));
});
for (const code of ["RATE_LIMIT", "NETWORK_ERROR", "REQUEST_TIMEOUT", "PROVIDER_UNAVAILABLE", "AUTH_FAILED", "AUTH_REQUIRED", "RESPONSE_INVALID", "URL_BLOCKED", "PROVIDER_REQUEST_FAILED"]) {
  test(`automatic routing handles ${code} without undocumented fallbacks`, async (t) => {
    const mcp = mcpTransport();
    const h = harness(t, { transport: async (url, options) => { if (url.includes("chatgpt.com")) throw new WebError(code, "Fixture failure"); return mcp(url, options); } });
    const result = await h.call("web_search", { query: "energy" });
    const transient = ["RATE_LIMIT", "NETWORK_ERROR", "REQUEST_TIMEOUT", "PROVIDER_UNAVAILABLE"].includes(code);
    assert.equal(result.isError === true, !transient);
    assert.equal(h.requests.some((r) => r.url === "https://mcp.exa.ai/mcp"), transient);
    if (transient) {
      assert.equal(result.structuredContent.data.queries[0].providerUsed, "exa");
      assert.equal(result.structuredContent.data.partial, false);
      assert.equal(result.structuredContent.data.queries[0].attempts.length, 2);
    }
    assert.ok(h.requests.every((r) => !r.url.includes("api.exa.ai") && !r.url.includes("duckduckgo")));
  });
}
test("explicit OpenAI never switches provider, and MCP never consumes EXA_API_KEY", async (t) => {
  const h = harness(t, { env: { EXA_API_KEY: "not-authorized" }, transport: async () => reply({}, { status: 429 }) });
  assert.equal((await h.call("web_search", { query: "x", provider: "openai" })).isError, true);
  assert.equal(h.requests.length, 1);
  assert.equal((await h.call("web_search", { query: "x", provider: "exa" })).isError, true);
  assert.ok(h.requests.every((r) => !Object.values(r.headers ?? {}).includes("not-authorized")));
});
for (const overrides of [
  { isUsingOAuth: () => false },
  { getProviderAuthStatus: () => ({ source: "runtime" }) },
  { find: () => ({ provider: "openai-codex", id: "gpt-5.6-terra", api: "openai-codex-responses", baseUrl: "https://evil.example" }) },
  { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret", baseUrl: "https://evil.example" }) },
  { getApiKeyAndHeaders: async () => ({ ok: false, error: "secret should never appear" }) },
]) test("invalid OAuth sources and endpoints fail before search traffic", async (t) => {
  const h = harness(t, { registry: registry(overrides) });
  const result = await h.call("web_search", { query: "x" });
  assert.equal(result.isError, true); assert.equal(h.requests.length, 0); assert.ok(!JSON.stringify(result).includes("secret"));
});
test("explicit API modes use only their configured key and official endpoint", async (t) => {
  const h = harness(t, { config: { openai: { auth: "api-key" }, exa: { transport: "api" } }, env: { OPENAI_API_KEY: "paid-openai", EXA_API_KEY: "paid-exa" }, transport: async (url) => reply(url.includes("exa.ai") ? { results: [{ url: "https://example.com" }] } : hosted()) });
  await h.call("web_search", { query: "x", provider: "openai" });
  await h.call("web_search", { query: "x", provider: "exa" });
  assert.equal(h.requests[0].url, "https://api.openai.com/v1/responses");
  assert.equal(h.requests[0].headers.authorization, "Bearer paid-openai");
  assert.equal(h.requests[1].headers["x-api-key"], "paid-exa");
});
test("SSE requires completed response and actual web search; invalid citations do not become zero results", () => {
  const good = hosted();
  assert.equal(parseOpenAI(reply(`data: ${JSON.stringify({ type: "response.completed", response: good })}\n\n`, { type: "text/event-stream" })).results.length, 1);
  for (const body of ["data: {broken}\n\n", `data: ${JSON.stringify({ type: "response.output_item.done", item: good.output[0] })}\n\n`, JSON.stringify({ status: "completed", output: [] }), JSON.stringify({ ...good, status: "incomplete" })]) assert.throws(() => parseOpenAI(reply(body)), /search|response|SSE/);
  const invalid = hosted("file:///etc/passwd"); assert.throws(() => parseOpenAI(reply(invalid)), /citation/);
});
const streamReply = (events) => reply(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { type: "text/event-stream" });
for (const type of ["response.completed", "response.done"]) {
  for (const output of [[], undefined]) test(`SSE restores streamed items for ${type} with ${output ? "empty" : "omitted"} final output`, () => {
    const good = hosted();
    good.output.push(hosted("https://second.example/", "Second answer paragraph.").output[1]);
    const items = good.output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item }));
    const parsed = parseOpenAI(streamReply([
      ...items.reverse(),
      { type, response: { ...good, output } },
      // Items after completion cannot supply sources to the finished response.
      { type: "response.output_item.done", output_index: 3, item: hosted("https://late.example/").output[0] },
    ]));
    assert.deepEqual(parsed, parseOpenAI(reply(good)));
  });
}
test("SSE keeps nonempty final output authoritative without duplicating answers or usage", () => {
  const good = hosted(), stale = hosted("https://stale.example/", "Stale answer");
  const parsed = parseOpenAI(streamReply([
    ...stale.output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
    { type: "response.completed", response: good },
  ]));
  assert.deepEqual(parsed, parseOpenAI(reply(good)));
});
test("SSE reconstruction still rejects interrupted, failed and malformed responses", () => {
  const good = hosted();
  const items = good.output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item }));
  const terminal = { type: "response.completed", response: { ...good, output: [] } };
  const invalid = [
    items,
    [...items, { ...terminal, response: { ...terminal.response, status: "incomplete" } }],
    [...items, { ...terminal, response: { ...terminal.response, output: {} } }],
    ...["error", "response.failed", "response.incomplete"].map((type) => [...items, { type }, terminal]),
    [{ ...items[0], item: { ...items[0].item, status: "in_progress" } }, terminal],
    ...[-1, 0.5, "0", undefined].map((output_index) => [{ ...items[0], output_index }, terminal]),
    [items[0], items[0], terminal],
    [{ ...items[0], item: null }, terminal],
    [{ ...items[0], item: {} }, terminal],
  ];
  for (const events of invalid) assert.throws(() => parseOpenAI(streamReply(events)), (error) => error.code === "RESPONSE_INVALID");
});
test("streamed OpenAI results reach the tool preview and cache without fallback or another request", async (t) => {
  const good = hosted();
  const h = harness(t, { transport: async () => streamReply([
    ...good.output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
    { type: "response.completed", response: { ...good, output: [] } },
  ]) });
  const result = await h.call("web_search", { query: "energy" });
  assert.equal(result.isError, undefined);
  const data = result.structuredContent.data, query = data.queries[0];
  assert.equal(query.providerUsed, "openai");
  assert.equal(query.attempts.length, 1);
  assert.equal(query.answer, good.output[1].content[0].text);
  assert.equal(query.results[0].url, "https://example.com/doc");
  assert.equal(query.usage.totalTokens, 30);
  const cached = await h.call("get_cached_web_content", { responseId: data.responseId });
  assert.equal(cached.isError, undefined);
  assert.deepEqual(JSON.parse(cached.structuredContent.data.text), query);
  assert.equal(h.requests.length, 1);
});
test("domain filters omit nonconforming sources and the associated generated answer", async (t) => {
  const h = harness(t, { transport: async () => reply(hosted("https://excluded.example/doc")) });
  const result = await h.call("web_search", { query: "x", domainFilter: ["example.com"] });
  const query = result.structuredContent.data.queries[0];
  assert.deepEqual(query.results, []); assert.equal(query.answer, undefined); assert.ok(query.warnings.length);
});
test("MCP capability selects the base tool transparently; labelled text and error formats are distinct", async (t) => {
  const h = harness(t, { transport: mcpTransport({ advanced: false }) });
  const result = await h.call("web_search", { query: "x", provider: "exa" });
  assert.equal(result.structuredContent.data.queries[0].attempts[0].tool, "web_search_exa");
  assert.equal(parseExaContent({ content: [{ type: "text", text: "Title: Energy\nURL: https://example.com\nText: Solar increased." }] }).length, 1);
  assert.throws(() => parseExaContent({ isError: true, content: [] }));
  assert.throws(() => parseExaContent({ content: [{ type: "text", text: "Unrecognized" }] }));
});
test("DDG result wrappers, authentic empty results and challenges remain distinguishable", () => {
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F">Title</a><span class="result__snippet">Snippet</span></div>`;
  assert.equal(parseDuckDuckGo(html)[0].url, "https://example.com/");
  assert.deepEqual(parseDuckDuckGo('<div class="no-results"></div>'), []);
  assert.throws(() => parseDuckDuckGo('<form id="challenge-form"></form>'), /challenge/);
  assert.throws(() => parseDuckDuckGo("new unexplained layout"), /unrecognized/);
});
test("batch deduplicates queries and preserves partial failures", async (t) => {
  const h = harness(t, { transport: async (_url, options) => JSON.parse(options.body).input[0].content[0].text === "bad" ? reply({}, { status: 400 }) : reply(hosted()) });
  const result = await h.call("web_search", { queries: ["good", "bad", "good"], provider: "openai" });
  assert.equal(h.requests.length, 2); assert.equal(result.structuredContent.data.partial, true);
  assert.deepEqual(result.structuredContent.data.queries[0].inputIndices, [0, 2]);
});
test("slow OAuth cancellation does not send a late request or fall back", async (t) => {
  let resolve;
  const h = harness(t, { registry: registry({ getApiKeyAndHeaders: () => new Promise((done) => { resolve = done; }) }) });
  const controller = new AbortController();
  const pending = h.call("web_search", { query: "x" }, controller.signal);
  await new Promise((done) => setImmediate(done)); controller.abort();
  assert.equal((await pending).isError, true);
  resolve({ ok: true, apiKey: "late", headers: { "chatgpt-account-id": "a" } });
  await new Promise((done) => setImmediate(done)); assert.equal(h.requests.length, 0);
});
