import { randomUUID } from "node:crypto";
import { constants, chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { check, fail, fits, hash, integer, keys, object, safeEnd, text, WebError, type Diagnostic } from "./core.ts";

export const REFERENCE_TYPE = "web-cache-reference";
export const TTL = 3600000, MAX_ENTRIES = 128, MAX_BYTES = 128 * 1024 ** 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type Kind = "search" | "content";
export interface Document { itemIndex: number; text: string; documentHash: string; metadata: Record<string, unknown>; status: "ok" | "error"; error?: Diagnostic }
// Keep the retired record kind readable for existing branch references until expiry.
export interface Reference { version: 1; responseId: string; kind: Kind | "evidence"; createdAt: string; expiresAt: string; itemCount: number }
export interface RecordData extends Reference { documents: Document[]; payload: unknown; integrityHash: string }
export function document(itemIndex: number, value: string, metadata: Record<string, unknown> = {}, error?: Diagnostic): Document {
  return { itemIndex, text: value, documentHash: hash(value), metadata, status: error ? "error" : "ok", ...(error ? { error } : {}) };
}
export function validReference(raw: unknown): raw is Reference {
  const v = raw as Reference;
  return !!v && v.version === 1 && UUID.test(v.responseId) && ["search", "content", "evidence"].includes(v.kind) && Number.isFinite(Date.parse(v.createdAt)) && Date.parse(v.expiresAt) - Date.parse(v.createdAt) === TTL && Number.isSafeInteger(v.itemCount) && v.itemCount >= 1;
}
function regular(path: string, maxBytes = MAX_BYTES): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw Error("Unsafe cache file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (info.dev !== before.dev || info.ino !== before.ino || info.size > maxBytes) throw Error("Changed cache file");
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) throw Error("Truncated cache file");
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset)) throw Error("Changed cache size");
    return buffer;
  } finally { closeSync(fd); }
}
function directory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("CACHE_WRITE_FAILED", "Cache directory is not a regular directory.");
  chmodSync(path, 0o700);
}
export class Cache {
  readonly dir: string;
  readonly now: () => number;
  constructor(agentDir: string, now = Date.now) { this.dir = join(agentDir, "web", "cache"); this.now = now; }
  private secure() { directory(join(this.dir, "..")); directory(this.dir); }
  private reapDeadLock(path: string): void {
    let owner: { pid: number; token: string };
    try { owner = JSON.parse(regular(path, 512).toString()); } catch { return; }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !UUID.test(owner.token)) return;
    try { process.kill(owner.pid, 0); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return; }
    // One reaper per lock generation. A live owner is never evicted by elapsed time;
    // another contender cannot replace this generation between the check and unlink.
    const claim = join(this.dir, `${owner.token}.reap`);
    let claimed = false;
    try {
      const fd = openSync(claim, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      closeSync(fd); claimed = true;
      const current = JSON.parse(regular(path, 512).toString());
      if (current.token === owner.token && current.pid === owner.pid) unlinkSync(path);
    } catch { /* Incomplete owners/reapers require explicit recovery, never unsafe takeover. */ }
    finally { if (claimed) { try { unlinkSync(claim); } catch {} } }
  }
  private async lock(signal: AbortSignal): Promise<() => void> {
    this.secure();
    const path = join(this.dir, ".lock"), token = randomUUID();
    const until = Date.now() + 1000;
    while (true) {
      check(signal);
      try {
        const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { closeSync(fd); }
        return () => {
          try { if (JSON.parse(regular(path, 512).toString()).token === token) unlinkSync(path); } catch { /* A changed lock is never removed. */ }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        this.reapDeadLock(path);
        if (Date.now() >= until) fail("CACHE_BUSY", "Cache is locked. Stop all Pi processes before removing an incomplete web/cache/.lock or .reap file.");
        await sleep(20, undefined, { signal }).catch(() => check(signal));
      }
    }
  }
  async save(kind: Kind, documents: Document[], payload: unknown, signal: AbortSignal, publish: (ref: Reference) => void): Promise<RecordData> {
    const created = this.now(), responseId = randomUUID();
    const ref: Reference = { version: 1, responseId, kind, createdAt: new Date(created).toISOString(), expiresAt: new Date(created + TTL).toISOString(), itemCount: documents.length };
    const base = { ...ref, documents, payload };
    const record: RecordData = { ...base, integrityHash: hash(JSON.stringify(base)) };
    const serialized = JSON.stringify(record), size = Buffer.byteLength(serialized);
    if (size > MAX_BYTES) fail("CACHE_WRITE_FAILED", "Record exceeds the cache budget.");
    let release: (() => void) | undefined;
    const final = join(this.dir, `${responseId}.json`), temp = join(this.dir, `${responseId}.tmp`);
    let committed = false;
    try {
      release = await this.lock(signal);
      check(signal);
      const files: { path: string; size: number; created: number }[] = [];
      for (const name of readdirSync(this.dir)) {
        if (!/^[0-9a-f-]{36}\.(json|tmp)$/.test(name)) continue;
        const path = join(this.dir, name), info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink()) fail("CACHE_WRITE_FAILED", "Unsafe cache entry prevents pruning.");
        if (name.endsWith(".tmp")) { unlinkSync(path); continue; }
        let timestamp = info.mtimeMs;
        try { timestamp = Date.parse(JSON.parse(regular(path).toString()).createdAt) || timestamp; } catch { /* Corrupt files still count toward quota. */ }
        if (this.now() - timestamp >= TTL) unlinkSync(path);
        else files.push({ path, size: info.size, created: timestamp });
      }
      files.sort((a, b) => a.created - b.created || a.path.localeCompare(b.path));
      let used = files.reduce((total, f) => total + f.size, 0);
      while (files.length >= MAX_ENTRIES || used + size > MAX_BYTES) {
        const oldest = files.shift();
        if (!oldest) fail("CACHE_WRITE_FAILED", "Cannot reserve cache space.");
        unlinkSync(oldest!.path); used -= oldest!.size;
      }
      check(signal);
      const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, serialized); } finally { closeSync(fd); }
      renameSync(temp, final);
      if (hash(regular(final).toString()) !== hash(serialized)) throw Error("Cache verification failed");
      check(signal);
      publish(ref); // Synchronous append plus epoch check while eviction is locked out.
      committed = true;
      return record;
    } catch (error) {
      if (error instanceof WebError) throw error;
      throw new WebError("CACHE_WRITE_FAILED", "Could not persist web content and its session reference.");
    } finally {
      if (!committed) for (const path of [temp, final]) { try { unlinkSync(path); } catch { /* Orphans cannot be accessed without a branch reference. */ } }
      release?.();
    }
  }
  read(id: string, refs: ReadonlyMap<string, Reference>): RecordData {
    if (!UUID.test(id)) fail("INVALID_INPUT", "responseId must be a canonical UUID.");
    const ref = refs.get(id);
    if (!ref) return fail("CACHE_NOT_IN_BRANCH", "This responseId is not in the active branch.");
    if (this.now() >= Date.parse(ref.expiresAt)) return fail("CACHE_EXPIRED", "Cached content has expired. Fetch it again explicitly.");
    try {
      for (const path of [join(this.dir, ".."), this.dir]) {
        const info = lstatSync(path);
        if (!info.isDirectory() || info.isSymbolicLink()) throw Error();
      }
      const data = JSON.parse(regular(join(this.dir, `${id}.json`)).toString()) as RecordData;
      if (data.version !== 1) fail("CACHE_VERSION_UNSUPPORTED", "Cache version is unsupported.");
      const { integrityHash, ...base } = data;
      if (!validReference(data) || data.responseId !== id || data.kind !== ref.kind || data.expiresAt !== ref.expiresAt || data.itemCount !== ref.itemCount || !Array.isArray(data.documents) || data.documents.length !== data.itemCount || hash(JSON.stringify(base)) !== integrityHash) throw Error();
      for (const [index, doc] of data.documents.entries()) {
        if (doc.itemIndex !== index || typeof doc.text !== "string" || doc.documentHash !== hash(doc.text) || !["ok", "error"].includes(doc.status)) throw Error();
      }
      if (this.now() >= Date.parse(data.expiresAt)) fail("CACHE_EXPIRED", "Cached content has expired.");
      return data;
    } catch (error) {
      if (error instanceof WebError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fail("CACHE_MISSING", "Cached content was removed. Fetch it again explicitly.");
      return fail("CACHE_CORRUPT", "Cache record is unsafe or corrupt.");
    }
  }
}
export function readCached(cache: Cache, refs: ReadonlyMap<string, Reference>, raw: unknown, maxChars: number): Record<string, unknown> {
  const input = object(raw);
  keys(input, ["responseId", "itemIndex", "offset", "limit", "findText", "matchOffset", "maxMatches"]);
  const id = text(input.responseId, 36, "responseId");
  const itemIndex = integer(input.itemIndex, 0, 0, 1000), limit = integer(input.limit, 12000, 1, 30000);
  if (input.findText !== undefined && input.offset !== undefined || input.findText === undefined && (input.matchOffset !== undefined || input.maxMatches !== undefined)) fail("INVALID_INPUT", "Page and finder parameters cannot be combined.");
  const record = cache.read(id, refs), doc = record.documents[itemIndex];
  if (!doc || doc.status !== "ok") fail("INVALID_INPUT", "Selected document does not contain readable content.");
  const content = doc!.text;
  const base = { responseId: id, kind: record.kind, itemIndex, totalChars: content.length, expiresAt: record.expiresAt, untrusted: true };
  if (input.findText !== undefined) {
    if (typeof input.findText !== "string" || !input.findText.length || input.findText.length > 500) fail("INVALID_INPUT", "findText must contain one to 500 UTF-16 units.");
    const needle = input.findText as string, skip = integer(input.matchOffset, 0, 0, Number.MAX_SAFE_INTEGER), max = integer(input.maxMatches, 5, 1, 20);
    const positions: number[] = [];
    for (let index = content.indexOf(needle); index !== -1; index = content.indexOf(needle, index + needle.length)) positions.push(index);
    const matches: Record<string, unknown>[] = [];
    for (const start of positions.slice(skip, skip + max)) {
      const from = safeEnd(content, Math.max(0, start - 200)), to = safeEnd(content, Math.min(content.length, start + needle.length + 200));
      const match = { start, end: start + needle.length, contextStart: from, contextEnd: to, text: content.slice(from, to) };
      if (!fits({ ...base, matches: [...matches, match], totalMatches: positions.length, nextMatchOffset: skip + matches.length + 1, truncated: true }, Math.min(maxChars, limit))) break;
      matches.push(match);
    }
    if (!matches.length && skip < positions.length) fail("OUTPUT_LIMIT_TOO_SMALL", "Increase limit to fit a complete match and its context.");
    const next = skip + matches.length < positions.length ? skip + matches.length : null;
    return { ...base, matches, totalMatches: positions.length, nextMatchOffset: next, truncated: next !== null };
  }
  const offset = integer(input.offset, 0, 0, content.length);
  if (safeEnd(content, offset) !== offset) fail("INVALID_INPUT", "Offset splits a Unicode code point.");
  let end = safeEnd(content, Math.min(content.length, offset + limit));
  const result = () => ({ ...base, offset, endOffset: end, text: content.slice(offset, end), truncated: end < content.length, nextOffset: end < content.length ? end : null });
  while (end > offset && !fits(result(), maxChars)) end = safeEnd(content, offset + Math.floor((end - offset) * 0.8));
  if (end === offset && offset < content.length) fail("OUTPUT_LIMIT_TOO_SMALL", "Increase limit to fit the next code point and metadata.");
  return result();
}
