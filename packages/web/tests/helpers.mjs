import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { installWeb } from "../extensions/web/index.ts";
import { parseConfig } from "../extensions/web/config.ts";

export const reply = (value, { status = 200, type = "application/json", url = "https://example.com/doc" } = {}) => ({ status, url, headers: { "content-type": type }, body: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)) });
export const model = (provider, id) => ({ id, provider, api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses", baseUrl: provider === "openai-codex" ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1" });
export const registry = (overrides = {}) => ({
  find: model,
  isUsingOAuth: () => true,
  getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
  getRegisteredProviderConfig: () => undefined,
  getRegisteredNativeProvider: () => undefined,
  getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret-oauth-sentinel", headers: { "chatgpt-account-id": "test-account" } }),
  ...overrides,
});
export const hosted = (url = "https://example.com/doc", answer = "An answer with a citation.") => ({ status: "completed", output: [
  { type: "web_search_call", status: "completed", action: { sources: [{ url, title: "Source" }] } },
  { type: "message", content: [{ type: "output_text", text: answer, annotations: [{ type: "url_citation", url, title: "Source" }] }] },
], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } });
export const page = `<html><head><title>Public record</title></head><body><article><h1>Energy report</h1><p>Solar energy increased in 2025. Solar energy did not decline in 2025. This official record contains measurable data about energy production.</p><p>${"Additional public data about energy production. ".repeat(20)}</p></article></body></html>`;
export function harness(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tau-web-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tools = new Map(), events = new Map(), requests = [];
  const ctx = { sessionManager: SessionManager.inMemory(dir), modelRegistry: options.registry ?? registry(), mode: "json", hasUI: false };
  const transport = async (url, opts) => { requests.push({ url, ...opts }); return options.transport ? options.transport(url, opts) : reply(page, { type: "text/html", url }); };
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (name, callback) => events.set(name, callback),
    appendEntry: (type, data) => { if (options.failAppend) throw Error("simulated disk failure"); ctx.sessionManager.appendCustomEntry(type, data); },
  };
  installWeb(pi, { agentDir: dir, config: parseConfig(options.config), transport, now: options.now, env: options.env ?? {} });
  const emit = (name) => events.get(name)?.({ type: name }, ctx);
  emit("session_start"); t.after(() => emit("session_shutdown"));
  return { dir, tools, events, requests, ctx, emit, call: (name, args, signal) => tools.get(name).execute("test", args, signal, undefined, ctx) };
}
export function mcpTransport({ advanced = true, results = [{ title: "Energy", url: "https://example.com/doc", text: "Solar energy increased." }] } = {}) {
  return async (url, opts) => {
    if (url !== "https://mcp.exa.ai/mcp") return reply(page, { type: "text/html", url });
    if (opts.method === "DELETE") return reply("", { status: 204 });
    const request = JSON.parse(opts.body);
    const result = request.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: {} }
      : request.method === "tools/list" ? { tools: [{ name: advanced ? "web_search_advanced_exa" : "web_search_exa", inputSchema: { properties: { query: {}, numResults: {} } } }] }
      : request.method === "tools/call" ? { content: [{ type: "text", text: JSON.stringify({ results }) }] } : {};
    return reply({ jsonrpc: "2.0", id: request.id, result });
  };
}
export function pdfFixture(pages = ["Solar energy increased in 2025."]) {
  const objects = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const [index, text] of pages.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    const stream = `BT /F1 12 Tf 50 700 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = "%PDF-1.4\n", offsets = [0];
  objects.forEach((value, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
