import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { Cache, document, MAX_BYTES, REFERENCE_TYPE, readCached, TTL } from "../extensions/web/cache.ts";
import { harness } from "./helpers.mjs";
import { hash } from "../extensions/web/core.ts";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "tau-web-cache-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.now(); const cache = new Cache(dir, () => now), refs = new Map();
  return { dir, cache, refs, advance: (ms) => now += ms, save: (value, publish = (r) => refs.set(r.responseId, r)) => cache.save("content", [document(0, value)], {}, new AbortController().signal, publish) };
}
test("cache stores private files, paginates exact Unicode, and never splits surrogate pairs", async (t) => {
  const { save, cache, refs } = setup(t);
  const value = "a😀Solar energy\nSolar energy", record = await save(value);
  const path = join(cache.dir, `${record.responseId}.json`);
  if (process.platform !== "win32") { assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(cache.dir).mode & 0o777, 0o700); }
  let recovered = "", offset = 0;
  do {
    const result = readCached(cache, refs, { responseId: record.responseId, offset, limit: 5 }, 30000);
    recovered += result.text; offset = result.nextOffset;
  } while (offset !== null);
  assert.equal(recovered, value);
  assert.throws(() => readCached(cache, refs, { responseId: record.responseId, offset: 2 }, 30000), /Unicode/);
  assert.throws(() => readCached(cache, refs, { responseId: record.responseId, offset: 1, limit: 1 }, 30000), /code point/);
  assert.equal(readCached(cache, refs, { responseId: record.responseId, offset: value.length }, 30000).text, "");
  assert.throws(() => readCached(cache, refs, { responseId: record.responseId, offset: value.length + 1 }, 30000));
});
test("retired cached artifacts remain readable from their branch without network", async (t) => {
  const h = harness(t), cache = new Cache(h.dir);
  const value = JSON.stringify({ version: 1, claim: "Archived claim", passages: [] });
  const saved = await cache.save("content", [document(0, value)], {}, new AbortController().signal, () => {});
  const { documents, payload, integrityHash, ...reference } = saved;
  // Reproduce an existing v1 artifact rather than retaining a writer for the removed tool.
  const ref = { ...reference, kind: "evidence" }, base = { ...ref, documents, payload };
  writeFileSync(join(cache.dir, `${ref.responseId}.json`), JSON.stringify({ ...base, integrityHash: hash(JSON.stringify(base)) }));
  h.ctx.sessionManager.appendCustomEntry(REFERENCE_TYPE, ref);
  h.emit("session_start");
  const result = await h.call("get_cached_web_content", { responseId: ref.responseId });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.text, value);
  assert.equal(h.requests.length, 0);
});
test("finder uses literal case-sensitive, nonoverlapping matches and progressing cursors", async (t) => {
  const { save, cache, refs } = setup(t), record = await save("Solar. solar. Solar. 😀");
  const first = readCached(cache, refs, { responseId: record.responseId, findText: "Solar", maxMatches: 1 }, 30000);
  assert.equal(first.totalMatches, 2); assert.equal(first.nextMatchOffset, 1); assert.equal(first.matches[0].start, 0);
  const last = readCached(cache, refs, { responseId: record.responseId, findText: "Solar", matchOffset: 1 }, 30000);
  assert.equal(last.nextMatchOffset, null); assert.equal(last.matches[0].start, 14);
  assert.equal(readCached(cache, refs, { responseId: record.responseId, findText: "missing" }, 30000).totalMatches, 0);
  assert.throws(() => readCached(cache, refs, { responseId: record.responseId, findText: "Solar", offset: 0 }, 30000));
});
test("branch authorization precedes disk existence; TTL is exact and does not renew on read", async (t) => {
  const { save, cache, refs, advance } = setup(t), record = await save("Text");
  assert.throws(() => cache.read(record.responseId, new Map()), (e) => e.code === "CACHE_NOT_IN_BRANCH");
  advance(TTL - 1); assert.equal(cache.read(record.responseId, refs).documents[0].text, "Text");
  advance(1); assert.throws(() => cache.read(record.responseId, refs), (e) => e.code === "CACHE_EXPIRED");
});
test("missing, corrupt, unsupported-version and symlink records are explicit errors", async (t) => {
  const { save, cache, refs } = setup(t), record = await save("Text"), path = join(cache.dir, `${record.responseId}.json`);
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("Text", "Edit")); assert.throws(() => cache.read(record.responseId, refs), (e) => e.code === "CACHE_CORRUPT");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(original), version: 2 })); assert.throws(() => cache.read(record.responseId, refs), (e) => e.code === "CACHE_VERSION_UNSUPPORTED");
  rmSync(path); assert.throws(() => cache.read(record.responseId, refs), (e) => e.code === "CACHE_MISSING");
  const target = join(cache.dir, "outside.txt"); writeFileSync(target, original); symlinkSync(target, path);
  assert.throws(() => cache.read(record.responseId, refs), (e) => e.code === "CACHE_CORRUPT");
  assert.throws(() => cache.read("../../etc/passwd", refs), (e) => e.code === "INVALID_INPUT");
});
test("entry quota removes oldest records, accounts for crash temporaries, and preserves the new record", async (t) => {
  const { save, cache, refs, advance } = setup(t);
  const first = await save("old");
  writeFileSync(join(cache.dir, "00000000-0000-4000-8000-000000000000.tmp"), "interrupted");
  for (let i = 0; i < 128; i++) { advance(1); await save(String(i)); }
  assert.equal(readdirSync(cache.dir).filter((n) => n.endsWith(".json")).length, 128);
  assert.ok(!readdirSync(cache.dir).some((n) => n.endsWith(".tmp")));
  assert.throws(() => cache.read(first.responseId, refs), (e) => e.code === "CACHE_MISSING");
});
test("serialized byte quota prunes across record kinds", async (t) => {
  const { save, cache } = setup(t);
  for (let i = 0; i < 9; i++) await save("x".repeat(16 * 1024 ** 2));
  const bytes = readdirSync(cache.dir).filter((n) => n.endsWith(".json")).reduce((sum, n) => sum + statSync(join(cache.dir, n)).size, 0);
  assert.ok(bytes <= MAX_BYTES); assert.ok(readdirSync(cache.dir).length < 9);
});
test("failed session publication removes the new file and releases the lock", async (t) => {
  const { save, cache } = setup(t);
  await assert.rejects(save("Text", () => { throw Error("append failed"); }), (e) => e.code === "CACHE_WRITE_FAILED");
  assert.deepEqual(readdirSync(cache.dir), []);
  await save("retry");
});
test("live locks fail closed without altering ownership or cached records", async (t) => {
  const { save, cache, refs } = setup(t), initial = await save("init");
  const path = join(cache.dir, ".lock"), owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  writeFileSync(path, owner);
  const files = readdirSync(cache.dir).sort();
  await assert.rejects(save("locked"), (e) => e.code === "CACHE_BUSY");
  assert.equal(readFileSync(path, "utf8"), owner);
  assert.deepEqual(readdirSync(cache.dir).sort(), files);
  assert.equal(cache.read(initial.responseId, refs).documents[0].text, "init");
  rmSync(path); await save("after manual removal");
});
test("incomplete and malformed lock ownership requires manual recovery", async (t) => {
  const { save, cache } = setup(t); await save("init");
  const path = join(cache.dir, ".lock");
  for (const owner of ["{", JSON.stringify({ pid: process.pid, token: "owner" })]) {
    writeFileSync(path, owner);
    await assert.rejects(save("locked"), (e) => e.code === "CACHE_BUSY");
    assert.equal(readFileSync(path, "utf8"), owner);
  }
  rmSync(path); await save("after manual recovery");
});
test("a demonstrably exited owner is reclaimed without stealing a live lock", async (t) => {
  const { dir, cache, save } = setup(t); await save("init");
  const path = join(cache.dir, ".lock");
  const code = `import { writeFileSync } from 'node:fs'; import { randomUUID } from 'node:crypto'; writeFileSync(${JSON.stringify(path)}, JSON.stringify({pid:process.pid,token:randomUUID()}));`;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code]);
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(Error("fixture process failed")));
  });
  await save("after crash"); assert.ok(!readdirSync(cache.dir).some((name) => name === ".lock" || name.endsWith(".reap")));
});
test("two independent Node processes share a bounded cache near its entry quota", async (t) => {
  const { dir, cache, save } = setup(t);
  for (let i = 0; i < 120; i++) await save(String(i));
  const module = new URL("../extensions/web/cache.ts", import.meta.url).href;
  const code = `import { Cache, document } from ${JSON.stringify(module)}; const cache = new Cache(${JSON.stringify(dir)}); for (let i=0;i<12;i++) await cache.save('content',[document(0,String(i))],{},new AbortController().signal,()=>{});`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] }); let stderr = "";
    child.stderr.on("data", (data) => stderr += data); child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(Error(stderr)));
  });
  await Promise.all([run(), run()]); assert.equal(readdirSync(cache.dir).filter((n) => n.endsWith(".json")).length, 128);
});
test("real Pi branch navigation, compaction, resume and copied references enforce visibility", async (t) => {
  const h = harness(t);
  const ancestor = h.ctx.sessionManager.appendCustomEntry("root", {});
  const a = await h.call("fetch_web_content", { url: "https://example.com/a" });
  const idA = a.structuredContent.data.responseId, leafA = h.ctx.sessionManager.getLeafId();
  h.ctx.sessionManager.branch(ancestor); h.emit("session_tree");
  const denied = await h.call("get_cached_web_content", { responseId: idA }); assert.equal(denied.structuredContent.data.code, "CACHE_NOT_IN_BRANCH");
  h.ctx.sessionManager.branch(leafA); h.emit("session_start");
  assert.equal((await h.call("get_cached_web_content", { responseId: idA })).isError, undefined);
  h.ctx.sessionManager.appendCompaction("summary", leafA, 100); h.emit("session_start");
  assert.equal((await h.call("get_cached_web_content", { responseId: idA })).isError, undefined);
  const copied = h.ctx.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === REFERENCE_TYPE);
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  h.ctx.sessionManager = SessionManager.inMemory(h.dir); h.emit("session_start");
  assert.equal((await h.call("get_cached_web_content", { responseId: idA })).isError, true);
  for (const e of copied) h.ctx.sessionManager.appendCustomEntry(e.customType, e.data);
  h.emit("session_start"); assert.equal((await h.call("get_cached_web_content", { responseId: idA })).isError, undefined);
});
