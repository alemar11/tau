import assert from "node:assert/strict";
import { test } from "node:test";
import { publicAddress, resolvePublic, request } from "../extensions/web/network.ts";
import { canonicalUrl } from "../extensions/web/core.ts";
import { extract } from "../extensions/web/fetch-content.ts";
import { REFERENCE_TYPE } from "../extensions/web/cache.ts";
import { harness, page, pdfFixture, reply } from "./helpers.mjs";

for (const address of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "100.64.0.1"]) test(`network blocks ${address}`, () => assert.equal(publicAddress(address), false));
test("public addresses and pinned DNS checks reject mixed answers and alternate local URL forms", async () => {
  assert.equal(publicAddress("8.8.8.8"), true); assert.equal(publicAddress("2606:4700:4700::1111"), true);
  await assert.rejects(resolvePublic(new URL("https://example.com"), async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]), (e) => e.code === "URL_BLOCKED");
  for (const raw of ["http://2130706433", "http://0x7f000001", "http://127.1", "http://[::ffff:127.0.0.1]"]) await assert.rejects(resolvePublic(new URL(canonicalUrl(raw))), (e) => e.code === "URL_BLOCKED");
  assert.throws(() => canonicalUrl("https://user:pass@example.com")); assert.throws(() => canonicalUrl("file:///etc/passwd"));
});
test("production transport never sends credentials to nonofficial origins or connects to loopback", async () => {
  const options = { signal: new AbortController().signal, timeoutMs: 1000, maxBytes: 1000 };
  await assert.rejects(request("https://evil.example", { ...options, authenticated: true, headers: { authorization: "secret" } }), (e) => e.code === "URL_BLOCKED");
  await assert.rejects(request("http://127.0.0.1", options), (e) => e.code === "URL_BLOCKED");
});
test("HTML is extracted locally with relative links and without executing or fetching subresources", async () => {
  const html = page.replace("</article>", '<p><a href="/data">Data</a></p><script>throw new Error("executed")</script><img src="https://evil.example/image"></article>');
  const result = await extract(Buffer.from(html), "text/html", "https://example.com/report", 2000000, new AbortController().signal);
  assert.match(result.text, /Solar energy/); assert.match(result.text, /https:\/\/example.com\/data/);
  assert.ok(!result.text.includes("executed")); assert.ok(!result.text.includes("evil.example")); assert.equal(result.sourceType, "html");
});
for (const mime of ["text/plain", "text/markdown", "application/json", "application/xml"]) test(`text extraction supports ${mime}`, async () => {
  const result = await extract(Buffer.from("Hello 😀\r\nworld"), mime, "https://example.com", 2000000, new AbortController().signal);
  assert.equal(result.text, "Hello 😀\nworld");
});
test("PDF pages enter the same cache, are retrieved without network, and scan-only PDFs are explicit", async (t) => {
  const body = pdfFixture(["Solar energy increased in 2025.", "Second page contains energy data."]);
  const h = harness(t, { transport: async (url) => ({ ...reply("", { type: "application/octet-stream", url }), body }) });
  const result = await h.call("fetch_web_content", { url: "https://example.com/download" });
  assert.equal(result.isError, undefined);
  const data = result.structuredContent.data, cached = await h.call("get_cached_web_content", { responseId: data.responseId });
  assert.match(cached.structuredContent.data.text, /Second page/); assert.equal(h.requests.length, 1);
  await assert.rejects(extract(pdfFixture([""]), "application/pdf", "https://example.com", 2000000, new AbortController().signal), (e) => e.code === "CONTENT_EMPTY");
  await assert.rejects(extract(Buffer.from("%PDF-broken"), "application/pdf", "https://example.com", 2000000, new AbortController().signal), (e) => e.code === "EXTRACTION_FAILED");
});
test("media, malformed encodings, challenge pages and limits produce explicit extraction errors", async () => {
  const signal = new AbortController().signal;
  for (const [body, mime, code] of [
    [Buffer.from([0, 255, 1]), "image/png", "CONTENT_UNSUPPORTED"],
    [Buffer.from([0xff]), "text/plain", "EXTRACTION_FAILED"],
    [Buffer.from("<title>Just a moment</title>"), "text/html", "CONTENT_UNSUPPORTED"],
    [Buffer.from("abc"), "text/plain", "CONTENT_TOO_LARGE"],
    [Buffer.from("not a pdf"), "application/pdf", "EXTRACTION_FAILED"],
  ]) await assert.rejects(extract(body, mime, "https://example.com", 2, signal), (e) => e.code === code);
});
test("multi-URL fetch preserves partial failures, input mapping and bounded previews", async (t) => {
  const h = harness(t, { transport: async (url) => url.endsWith("bad") ? reply({}, { status: 403, url }) : reply("Solar data. ".repeat(10000), { type: "text/plain", url }) });
  const result = await h.call("fetch_web_content", { urls: ["https://example.com/good", "https://example.com/bad", "https://example.com/good#section"], maxChars: 2000 });
  assert.equal(result.isError, undefined); assert.equal(result.structuredContent.data.partial, true); assert.equal(h.requests.length, 2);
  assert.ok(result.content[0].text.length < 2200); assert.equal(result.structuredContent.data.truncated, true);
  const read = await h.call("get_cached_web_content", { responseId: result.structuredContent.data.responseId, offset: 5000, limit: 1000 }); assert.equal(read.isError, undefined);
});
test("a session change during download never publishes into the next branch", async (t) => {
  let finish;
  const h = harness(t, { transport: (url) => new Promise((resolve) => { finish = () => resolve(reply(page, { type: "text/html", url })); }) });
  const pending = h.call("fetch_web_content", { url: "https://example.com" });
  h.emit("session_tree"); finish();
  const result = await pending; assert.equal(result.isError, true);
  assert.equal(h.ctx.sessionManager.getBranch().filter((e) => e.customType === REFERENCE_TYPE).length, 0);
});
test("parallel sibling tool publications do not falsely invalidate the same branch", async (t) => {
  const h = harness(t);
  const results = await Promise.all([h.call("fetch_web_content", { url: "https://example.com/a" }), h.call("fetch_web_content", { url: "https://example.com/b" })]);
  assert.ok(results.every((r) => !r.isError));
  assert.equal(h.ctx.sessionManager.getBranch().filter((e) => e.customType === REFERENCE_TYPE).length, 2);
});
test("worker cancellation terminates extraction and does not publish", async () => {
  const controller = new AbortController();
  const pending = extract(pdfFixture(), "application/pdf", "https://example.com", 2000000, controller.signal);
  controller.abort(); await assert.rejects(pending, (e) => e.code === "CANCELLED");
});
