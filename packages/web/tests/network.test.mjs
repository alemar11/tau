import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { createTransport, resolvePublic } from "../extensions/web/network.ts";

async function server(t, handler) {
  const sockets = new Set(); const http = createServer(handler);
  http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => http.close(resolve)); });
  const port = http.address().port, calls = [];
  const transport = createTransport(async (url) => {
    calls.push(url.href);
    if (url.hostname !== "public.test") return resolvePublic(url);
    return [{ address: "127.0.0.1", family: 4 }];
  });
  const options = { signal: new AbortController().signal, timeoutMs: 1000, maxBytes: 1000 };
  return { transport, calls, options, url: `http://public.test:${port}` };
}
test("real HTTP transport pins the validated answer and checks redirect destinations", async (t) => {
  let hits = 0;
  const h = await server(t, (req, res) => {
    hits++;
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://127.0.0.1/private" }); res.end(); }
    else { res.writeHead(200, { "content-type": "text/plain" }); res.end("Pinned connection"); }
  });
  const result = await h.transport(h.url, h.options); assert.equal(Buffer.from(result.body).toString(), "Pinned connection");
  assert.equal(h.calls.length, 1); // A system DNS lookup for public.test could not have connected.
  await assert.rejects(h.transport(`${h.url}/redirect`, h.options), (e) => e.code === "URL_BLOCKED");
  assert.equal(hits, 2);
});
test("real chunked and gzip responses are bounded while streaming", async (t) => {
  const h = await server(t, (req, res) => {
    if (req.url === "/gzip") { res.writeHead(200, { "content-encoding": "gzip" }); res.end(gzipSync("a".repeat(100000))); }
    else { res.writeHead(200); res.write("a".repeat(800)); res.end("b".repeat(800)); }
  });
  for (const suffix of ["/gzip", "/chunked"]) await assert.rejects(h.transport(h.url + suffix, h.options), (e) => e.code === "DOWNLOAD_TOO_LARGE");
});
test("slow responses time out and cancellation aborts open streams", async (t) => {
  const h = await server(t, (_req, res) => { res.writeHead(200); res.write("begin"); });
  await assert.rejects(h.transport(h.url, { ...h.options, timeoutMs: 50 }), (e) => e.code === "REQUEST_TIMEOUT");
  const controller = new AbortController(), pending = h.transport(h.url, { ...h.options, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (e) => e.code === "CANCELLED");
});
test("redirect loops stop and POST bodies are not replayed", async (t) => {
  let count = 0;
  const h = await server(t, (_req, res) => { count++; res.writeHead(302, { location: "/loop" }); res.end(); });
  await assert.rejects(h.transport(h.url, h.options), (e) => e.code === "REDIRECT_LIMIT"); assert.equal(count, 6);
  await assert.rejects(h.transport(h.url, { ...h.options, method: "POST", body: "sensitive", headers: { "content-type": "application/json" } }), (e) => e.code === "URL_BLOCKED"); assert.equal(count, 7);
});
