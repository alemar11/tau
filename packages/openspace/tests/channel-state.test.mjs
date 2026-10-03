import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ChannelStateStore, STATE_LIMITS, stateHash } from "../src/broker/channel-state.ts";
import { atomicLeaseWrite } from "../src/registry/leases.ts";
import { CHANNEL_LIMITS, jsonPayload } from "../src/protocol/channels.ts";
import { fixture } from "./fixtures/broker-helpers.mjs";

const primary = (root, group = "default", ns = "example") => join(root, "state", `${stateHash(group, ns)}.json`);
const backup = (root, group = "default", ns = "example") => join(root, "state", `${stateHash(group, ns)}.bak`);

test("revisioned state survives restart with private files, detached payloads and independent group/namespace keys", (t) => {
  const f = fixture(t), store = new ChannelStateStore(f.root, { now: () => 123 });
  assert.equal(store.get("default", "example"), undefined); const payload = { __proto__: null, content: "世界" };
  const first = store.commit("default", "example", payload, 0); payload.content = "changed";
  assert.deepEqual(first, { revision: 1, updatedAt: 123, payload: { content: "世界" } });
  assert.equal(store.commit("default", "example", { changed: true }, 1).revision, 2);
  store.commit("other", "example", "independent", 0); store.commit("default", "another", "also independent", 0);
  first.payload.content = "mutated";
  const restarted = new ChannelStateStore(f.root);
  assert.equal(restarted.get("default", "example").revision, 2); assert.equal(restarted.get("other", "example").payload, "independent");
  assert.equal(restarted.get("default", "example").recovered, undefined);
  assert.equal(lstatSync(join(f.root, "state")).mode & 0o777, 0o700);
  for (const name of readdirSync(join(f.root, "state"))) assert.equal(lstatSync(join(f.root, "state", name)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(backup(f.root), "utf8")).body.revision, 1);
  assert.throws(() => restarted.commit("default", "example", "stale", 0), { code: "revision_conflict" });
});

test("a corrupt or missing primary recovers exactly the previous valid revision; double corruption fails closed", (t) => {
  const f = fixture(t); let store = new ChannelStateStore(f.root); store.commit("default", "example", "first"); store.commit("default", "example", "second");
  writeFileSync(primary(f.root), "{corrupt"); store = new ChannelStateStore(f.root);
  assert.deepEqual(store.get("default", "example").payload, "first"); assert.equal(store.get("default", "example").recovered, true); assert.equal(store.get("default", "example").revision, 1);
  assert.equal(new ChannelStateStore(f.root).get("default", "example").revision, 1);
  assert.equal(new ChannelStateStore(f.root).get("default", "example").recovered, true);
  assert.equal(store.commit("default", "example", "after recovery", 1).revision, 2); assert.equal(store.get("default", "example").recovered, undefined);
  rmSync(primary(f.root)); store = new ChannelStateStore(f.root); assert.equal(store.get("default", "example").recovered, true); assert.equal(store.get("default", "example").payload, "first");
  writeFileSync(primary(f.root), "broken"); writeFileSync(backup(f.root), "broken too");
  assert.throws(() => new ChannelStateStore(f.root), /no valid backup/);
});

test("backup uses verified memory, never copies later disk corruption over the last valid state", (t) => {
  const f = fixture(t); const store = new ChannelStateStore(f.root); store.commit("default", "example", "one"); store.commit("default", "example", "two");
  writeFileSync(primary(f.root), "corrupt after load"); store.commit("default", "example", "three");
  assert.equal(JSON.parse(readFileSync(backup(f.root), "utf8")).body.payload, "two");
  writeFileSync(primary(f.root), "corrupt again"); assert.equal(new ChannelStateStore(f.root).get("default", "example").payload, "two");
});

test("record and aggregate disk quotas count the backup and never delete acknowledged state", (t) => {
  const f = fixture(t), store = new ChannelStateStore(f.root, { maxRecords: 1 }); store.commit("default", "example", "one");
  assert.throws(() => store.commit("other", "example", "two"), { code: "state_capacity" }); assert.equal(store.get("default", "example").payload, "one");
  const bytes = lstatSync(primary(f.root)).size, limited = new ChannelStateStore(f.root, { maxBytes: bytes });
  assert.throws(() => limited.commit("default", "example", "one"), { code: "state_capacity" });
  assert.equal(limited.get("default", "example").revision, 1); assert.equal(existsSync(backup(f.root)), false);
  store.commit("default", "example", "two");
  assert.throws(() => new ChannelStateStore(f.root, { maxBytes: bytes }), /storage capacity/);
  for (const option of [{ maxRecords: 0 }, { maxRecords: STATE_LIMITS.records + 1 }, { maxBytes: 0 }, { maxBytes: STATE_LIMITS.bytes + 1 }, { maxBytes: NaN }]) assert.throws(() => new ChannelStateStore(f.root, option), /Invalid channel state capacity/);
});

test("unsafe files/directories and unknown entries are never followed or overwritten during recovery", (t) => {
  const f = fixture(t), outside = join(f.root, "outside"); writeFileSync(outside, "untouched", { mode: 0o600 });
  let store = new ChannelStateStore(f.root); store.commit("default", "example", "one"); store.commit("default", "example", "two");
  rmSync(primary(f.root)); symlinkSync(outside, primary(f.root)); assert.throws(() => new ChannelStateStore(f.root), /safely read|Unsafe/); assert.equal(readFileSync(outside, "utf8"), "untouched");
  rmSync(primary(f.root)); writeFileSync(primary(f.root), "bad", { mode: 0o644 }); assert.throws(() => new ChannelStateStore(f.root), /Unsafe/);
  chmodSync(primary(f.root), 0o600); store = new ChannelStateStore(f.root); assert.equal(store.get("default", "example").recovered, true);
  writeFileSync(join(f.root, "state", "unexpected"), "do not delete", { mode: 0o600 }); assert.throws(() => new ChannelStateStore(f.root), /Unknown file/); assert.equal(readFileSync(join(f.root, "state", "unexpected"), "utf8"), "do not delete");
  rmSync(join(f.root, "state", "unexpected")); chmodSync(join(f.root, "state"), 0o755); new ChannelStateStore(f.root); assert.equal(lstatSync(join(f.root, "state")).mode & 0o777, 0o700);
  renameSync(join(f.root, "state"), join(f.root, "saved")); mkdirSync(join(f.root, "state"), { mode: 0o700 });
  assert.throws(() => store.commit("default", "example", "must not write"), /requires restart/); assert.deepEqual(readdirSync(join(f.root, "state")), []);
});

test("known crash temporaries are bounded and removed without discarding primary/backup; unsafe or oversized temporaries block startup", (t) => {
  const f = fixture(t), store = new ChannelStateStore(f.root); store.commit("default", "example", "saved");
  const temp = `${primary(f.root)}.${randomUUID()}.tmp`; writeFileSync(temp, "partial", { mode: 0o600 });
  assert.equal(new ChannelStateStore(f.root).get("default", "example").payload, "saved"); assert.equal(existsSync(temp), false);
  writeFileSync(temp, "x".repeat(STATE_LIMITS.fileBytes + 1), { mode: 0o600 }); assert.throws(() => new ChannelStateStore(f.root), /Unsafe.*temporary/);
  rmSync(temp); symlinkSync(primary(f.root), temp); assert.throws(() => new ChannelStateStore(f.root), /Unsafe.*temporary/); assert.equal(existsSync(primary(f.root)), true);
  rmSync(temp); const unknown = `${primary(f.root)}.${"-".repeat(36)}.tmp`; writeFileSync(unknown, "untouched", { mode: 0o600 });
  assert.throws(() => new ChannelStateStore(f.root), /Unknown file/); assert.equal(readFileSync(unknown, "utf8"), "untouched");
});

test("pre/post-rename write failures poison storage until restart and never manufacture persistence success", (t) => {
  for (const afterRename of [false, true]) {
    const f = fixture(t), seed = new ChannelStateStore(f.root); seed.commit("default", "example", "old");
    const faulty = new ChannelStateStore(f.root, { write(path, contents) {
      if (path.endsWith(".json") && !afterRename) throw new Error("before rename");
      atomicLeaseWrite(path, contents); if (path.endsWith(".json")) throw new Error("after rename");
    } });
    assert.throws(() => faulty.commit("default", "example", "new", 1), /broker must stop/);
    assert.throws(() => faulty.get("default", "example"), /requires restart/); assert.throws(() => faulty.commit("default", "example", "next"), /requires restart/);
    const restarted = new ChannelStateStore(f.root).get("default", "example"); assert.equal(restarted.payload, afterRename ? "new" : "old"); assert.equal(restarted.revision, afterRename ? 2 : 1);
  }
});

test("SIGKILL between backup and primary replacement leaves the last acknowledged state recoverable", (t) => {
  const f = fixture(t), store = new ChannelStateStore(f.root); store.commit("default", "example", "old");
  const worker = fileURLToPath(new URL("./fixtures/state-crash-worker.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [worker, f.root], { env: f.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.signal, "SIGKILL", child.stderr); const restored = new ChannelStateStore(f.root).get("default", "example"); assert.equal(restored.payload, "old"); assert.equal(restored.revision, 1);
});

test("strict JSON capture rejects cycles, prototypes, accessors, sparse arrays and excessive depth without invoking user code", () => {
  let invoked = 0; const symbol = Symbol("key"), hiddenSymbol = { [symbol]: "hidden" }, ownToJson = { toJSON() { invoked++; return "hidden"; } };
  const custom = Object.create({ inherited: true }); custom.value = 1; const accessor = Object.defineProperty({}, "get", { get() { invoked++; return 1; } });
  const proxy = new Proxy({}, { ownKeys() { invoked++; return []; } }), extraArray = []; extraArray.custom = true;
  for (const input of [custom, hiddenSymbol, ownToJson, accessor, proxy, extraArray, new Array(3), [, 1], { x: undefined }, /regexp/]) assert.throws(() => jsonPayload(input, CHANNEL_LIMITS.stateBytes));
  assert.equal(invoked, 0); let deep = null; for (let i = 0; i < 66; i++) deep = [deep]; assert.throws(() => jsonPayload(deep, CHANNEL_LIMITS.stateBytes), /payload_too_complex/);
  const special = JSON.parse('{"__proto__":{"safe":true},"constructor":"value"}'), cloned = jsonPayload(special, 1000).value;
  assert.equal(Object.hasOwn(cloned, "__proto__"), true); assert.equal(Object.getPrototypeOf(cloned), Object.prototype); assert.equal({}.safe, undefined);
});

test("the crash-safe backup stage also fits the aggregate quota, even when a requested new payload is smaller", (t) => {
  const f = fixture(t), store = new ChannelStateStore(f.root); store.commit("default", "example", "x".repeat(2000));
  const size = lstatSync(primary(f.root)).size, limited = new ChannelStateStore(f.root, { maxBytes: size + 512 });
  assert.throws(() => limited.commit("default", "example", null, 1), { code: "state_capacity" });
  assert.equal(limited.get("default", "example").revision, 1); assert.equal(existsSync(backup(f.root)), false);
});

test("file hash and checksum corruption cannot silently import a state under another key", (t) => {
  const f = fixture(t), store = new ChannelStateStore(f.root); store.commit("default", "example", "valid");
  const other = join(f.root, "state", `${"0".repeat(64)}.json`); renameSync(primary(f.root), other);
  assert.throws(() => new ChannelStateStore(f.root), /no valid backup/); renameSync(other, primary(f.root));
  const original = readFileSync(primary(f.root), "utf8"), envelope = JSON.parse(original); envelope.body.payload = "corrupt";
  writeFileSync(primary(f.root), JSON.stringify(envelope)); assert.throws(() => new ChannelStateStore(f.root), /no valid backup/);
  writeFileSync(primary(f.root), original); assert.equal(new ChannelStateStore(f.root).get("default", "example").payload, "valid");
});
