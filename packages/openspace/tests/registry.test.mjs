import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LeaseStore, ADMISSION_MS, LEASE_RETENTION_MS, atomicLeaseWrite } from "../src/registry/leases.ts";
import { SessionRegistry } from "../src/registry/registry.ts";
import { MAX_SESSION_BYTES } from "../src/registry/session.ts";
import { prepareRuntime } from "../src/broker/runtime-files.ts";
import { fixture } from "./fixtures/broker-helpers.mjs";

function setup(t, options = {}) {
  const f = fixture(t);
  prepareRuntime(f.paths);
  let time = 1700000000000;
  const now = () => time;
  const store = new LeaseStore(f.paths.runtimeDir, { now, ...options });
  const registry = new SessionRegistry(store, f.paths.runtimeDir, now);
  const metadata = (id, extra = {}) => ({ id, cwd: f.root, model: "test", pid: 1, startedAt: 1, ...extra });
  const claim = (endpoint, id, workgroups = [], extra = {}) => {
    const lease = store.prepare(id), session = metadata(id, extra);
    return { lease, input: session, ...registry.register(endpoint, session, workgroups, lease, "claim") };
  };
  return { ...f, store, registry, now, metadata, claim, advance: (ms) => { time += ms; } };
}
const code = (expected) => (error) => error.code === expected;

test("leases fence replay and resume after lost revocation, restart and tombstone collection", (t) => {
  const { store, paths, now, advance } = setup(t);
  const a = store.prepare("shared"), b = store.prepare("shared");
  store.accept("shared", a, "claim", new Set());
  const bHash = store.accept("shared", b, "claim", new Set());
  for (const mode of ["claim", "resume"]) assert.throws(() => store.inspect("shared", a, mode), code("endpoint_revoked"));
  const restarted = new LeaseStore(paths.runtimeDir, { now });
  assert.equal(restarted.inspect("shared", b, "resume").current, true);
  assert.throws(() => restarted.inspect("shared", a, "resume"), code("endpoint_revoked"));
  advance(ADMISSION_MS + 1);
  restarted.checkpoint(new Set([bHash]));
  assert.equal(Object.keys(JSON.parse(readFileSync(join(paths.runtimeDir, "leases.json"), "utf8")).body.retired).length, 0);
  assert.throws(() => restarted.inspect("shared", a, "claim"), code("lease_expired"));
  assert.throws(() => restarted.inspect("shared", a, "resume"), code("lease_unknown"));
  assert.equal(restarted.inspect("shared", b, "resume").current, true);
  advance(-2 * ADMISSION_MS);
  const rolledBack = new LeaseStore(paths.runtimeDir, { now });
  assert.throws(() => rolledBack.inspect("shared", a, "claim"), code("lease_expired"));
  assert.equal(rolledBack.inspect("shared", b, "resume").current, true);
  assert.throws(() => restarted.inspect("other", b, "resume"), code("lease_invalid"));
  assert.throws(() => restarted.inspect("shared", b.slice(0, -1) + (b.endsWith("0") ? "1" : "0"), "resume"), code("lease_invalid"));
});

test("lease capacity is atomic, active checkpoints renew retention, expired owners never become fresh", (t) => {
  const { store, registry, claim, advance, paths, now } = setup(t, { maxCurrent: 2, maxRetired: 0 });
  const a = claim("a", "a"), b = claim("b", "b");
  const replacement = store.prepare("a");
  assert.throws(() => registry.register("other", a.input, [], replacement, "claim"), code("lease_capacity"));
  assert.equal(registry.session("a").id, "a");
  assert.throws(() => claim("c", "c"), code("lease_capacity"));
  for (let i = 0; i < 3; i++) { advance(LEASE_RETENTION_MS / 2); registry.checkpoint(); }
  const reopened = new LeaseStore(paths.runtimeDir, { now });
  assert.equal(reopened.inspect("a", a.lease, "resume").current, true);
  registry.disconnect("a"); registry.disconnect("b");
  advance(LEASE_RETENTION_MS + 1); registry.checkpoint();
  assert.throws(() => store.inspect("a", a.lease, "resume"), code("lease_unknown"));
  assert.throws(() => store.inspect("a", a.lease, "claim"), code("lease_expired"));
  assert.equal(claim("c", "c").session.id, "c");
});

test("fencing persistence fails closed on corruption and uncertain post-rename writes", (t) => {
  let fail = false;
  const f = setup(t, { write(path, data) { atomicLeaseWrite(path, data); if (fail) throw new Error("directory sync failed"); } });
  const a = f.claim("a", "same");
  const b = f.store.prepare("same");
  fail = true;
  assert.throws(() => f.registry.register("b", a.input, [], b, "claim"), /must stop/);
  assert.throws(() => f.store.inspect("same", a.lease, "resume"), /requires restart/);
  const recovered = new LeaseStore(f.paths.runtimeDir, { now: f.now });
  assert.equal(recovered.inspect("same", b, "resume").current, true);
  assert.throws(() => recovered.inspect("same", a.lease, "resume"), code("endpoint_revoked"));
  writeFileSync(join(f.paths.runtimeDir, "leases.json"), "corrupt");
  assert.throws(() => new LeaseStore(f.paths.runtimeDir), /refusing to discard fencing/);
});

test("global takeover in disjoint groups fences old mutations and late close, not the new owner", (t) => {
  const { registry, claim } = setup(t);
  const a = claim("a", "same", ["left"]);
  const stamp = registry.membership("a", "left");
  const b = claim("b", "same", ["right"]);
  assert.equal(registry.size, 1);
  assert.equal(b.transition.kind, "takeover");
  assert.deepEqual(b.transition.left, ["left"]);
  assert.notEqual(a.session.endpointEpoch, b.session.endpointEpoch);
  assert.equal(registry.isMembershipCurrent(stamp), false);
  assert.throws(() => registry.update("a", 1, { name: "stale" }), code("endpoint_revoked"));
  assert.throws(() => registry.setWorkgroups("a", 1, ["right"]), code("endpoint_revoked"));
  assert.equal(registry.disconnect("a"), undefined);
  assert.equal(registry.session("b").id, "same");
  assert.throws(() => registry.register("stale", a.input, ["left"], a.lease, "resume"), code("endpoint_revoked"));
});

test("reconnect retains newer groups, revisions and membership epochs; explicit leave/rejoin does not", (t) => {
  const { registry, claim } = setup(t);
  const a = claim("a", "id", ["one", "two"]);
  const one = registry.membership("a", "one"), two = registry.membership("a", "two");
  const changed = registry.setWorkgroups("a", 1, ["two"]);
  assert.deepEqual(changed.transition.left, ["one"]);
  assert.equal(registry.isMembershipCurrent(one), false);
  assert.equal(registry.isMembershipCurrent(two), true);
  assert.deepEqual(registry.disconnect("a").left, []);
  assert.equal(registry.isMembershipCurrent(two), true);
  const resumed = registry.register("a2", a.input, ["one", "two"], a.lease, "resume");
  assert.deepEqual(resumed.session.workgroups, ["two"]);
  assert.equal(resumed.session.revision, 2);
  assert.deepEqual(resumed.transition.left, []);
  assert.equal(registry.isMembershipCurrent(two), true);
  registry.setWorkgroups("a2", 2, ["one", "two"]);
  assert.equal(registry.isMembershipCurrent(one), false);
  assert.equal(registry.isMembershipCurrent(two), true);
  assert.notEqual(registry.membership("a2", "one").epoch, one.epoch);
});

test("default is exclusive, normalized sets have no-op updates, CAS rejects stale writes", (t) => {
  const { registry, claim } = setup(t);
  claim("a", "id");
  const original = registry.session("a");
  for (const groups of [["default"], ["a", "default"], [""], ["a\0b"], [1]]) {
    assert.throws(() => registry.setWorkgroups("a", 1, groups), code("invalid_workgroups"));
    assert.deepEqual(registry.session("a"), original);
  }
  const changed = registry.setWorkgroups("a", 1, ["z", "a", "a"]);
  assert.deepEqual(changed.transition.left, ["default"]);
  assert.deepEqual(changed.session.workgroups, ["a", "z"]);
  assert.equal(registry.setWorkgroups("a", 2, ["z", "a"]).transition, undefined);
  assert.throws(() => registry.setWorkgroups("a", 1, []), code("revision_conflict"));
  const fallback = registry.setWorkgroups("a", 2, []);
  assert.deepEqual(fallback.session.workgroups, ["default"]);
  assert.deepEqual(fallback.transition.joined, ["default"]);
});

test("discovery deduplicates, hides foreign groups, and uses exact ID / name / prefix / cwd without fallback", (t) => {
  const { registry, claim, root } = setup(t);
  const other = join(root, "other"); mkdirSync(other);
  claim("viewer", "viewer", ["a", "b"]);
  claim("p1", "peer-1", ["a", "b", "secret"], { name: "Builder" });
  claim("p2", "peer-2", ["a"], { name: "builder", cwd: other });
  claim("p3", "hidden", ["secret"], { name: "unique-private-name" });
  claim("p4", "other-id", ["a"], { name: "peer-1", cwd: other });
  const roster = registry.list("viewer");
  assert.equal(roster.length, 4);
  assert.deepEqual(roster.find((peer) => peer.id === "peer-1").workgroups, ["a", "b"]);
  for (const to of ["hidden", "unique-private-name", "not-found"]) assert.throws(() => registry.resolve("viewer", { to }), code("target_not_found"));
  assert.throws(() => registry.resolve("viewer", { to: "builder" }), code("target_ambiguous"));
  assert.throws(() => registry.resolve("viewer", { to: "peer-" }), code("target_ambiguous"));
  assert.throws(() => registry.resolve("viewer", { to: "peer-1" }), code("workgroup_ambiguous"));
  assert.equal(registry.resolve("viewer", { to: "BUILDER", cwd: other }).session.id, "peer-2");
  assert.equal(registry.resolve("viewer", { to: "peer-1", workgroup: "b" }).session.id, "peer-1");
  assert.throws(() => registry.resolve("viewer", { to: "peer-1", cwd: other }), code("target_not_found"));
  assert.throws(() => registry.resolve("viewer", { to: "viewer" }), code("self_target"));
  assert.throws(() => registry.list("viewer", { workgroup: "secret" }), code("workgroup_not_shared"));
  roster[1].workgroups.push("injected");
  assert.equal(registry.list("viewer")[1].workgroups.includes("injected"), false);
});

test("cwd resolves relative paths, dot segments, trailing separators and symlinks", (t) => {
  const { registry, claim, root } = setup(t);
  const project = join(root, "project"); mkdirSync(project);
  symlinkSync(project, join(root, "alias"));
  mkdirSync(join(project, "nested"));
  symlinkSync(join(project, "nested"), join(root, "via-child"));
  claim("a", "a", [], { cwd: root });
  claim("b", "b", [], { cwd: join(root, "alias", ".") + "/" });
  for (const cwd of ["project", "./alias/../project/", join(root, "alias"), "via-child/.."]) {
    assert.equal(registry.resolve("a", { cwd }).session.id, "b");
    assert.equal(registry.list("a", { cwd }).length, 1);
  }
  assert.throws(() => registry.resolve("a", { to: "b", cwd: "." }), code("target_not_found"));
  const spaced = join(root, "  spaced  "); mkdirSync(spaced);
  claim("spaced", "spaced", [], { cwd: spaced });
  assert.equal(registry.resolve("a", { cwd: "  spaced  " }).session.id, "spaced");
});

test("status UTF-8 limits, null usage and total serialized record budgets are atomic", (t) => {
  const { registry, claim } = setup(t);
  claim("a", "a", [], { name: "n" });
  let record = registry.update("a", 1, { status: { state: "tool", toolName: "🙂".repeat(64), note: "é".repeat(512) },
    contextUsage: { tokens: 1, contextWindow: 100, percent: 1 } }).session;
  for (const patch of [{ status: { state: "tool", toolName: "🙂".repeat(64) + "x" } },
    { status: { state: "idle", note: "é".repeat(512) + "x" } }, { status: { state: "tool" } },
    { status: { state: "idle", toolName: "invalid" } }, { trustedLocal: false }, { cwd: "/unowned" }]) {
    assert.throws(() => registry.update("a", record.revision, patch));
    assert.deepEqual(registry.session("a"), record);
  }
  record = registry.update("a", record.revision, { contextUsage: null, status: { state: "thinking", note: "\0".repeat(300) } }).session;
  assert.equal(record.contextUsage, undefined);
  assert.equal(registry.update("a", record.revision, { contextUsage: null }).transition, undefined);
  const available = MAX_SESSION_BYTES - Buffer.byteLength(JSON.stringify(record));
  record = registry.update("a", record.revision, { name: "n" + "x".repeat(available) }).session;
  assert.equal(Buffer.byteLength(JSON.stringify(record)), MAX_SESSION_BYTES);
  for (const patch of [{ name: record.name + "x" }, { model: "x".repeat(6000) }]) {
    assert.throws(() => registry.update("a", record.revision, patch), code("record_too_large"));
    assert.deepEqual(registry.session("a"), record);
  }
  assert.throws(() => registry.setWorkgroups("a", record.revision, ["x".repeat(6000)]), code("record_too_large"));
  assert.deepEqual(registry.session("a"), record);
});

test("oversized takeover does not revoke the owner; aliases and composite-looking identifiers stay distinct", (t) => {
  const { registry, claim, store, metadata } = setup(t);
  const a = claim("a", "__proto__", ["a:b", "a"]);
  const b = claim("b", "constructor", ["b:c", "c"]);
  assert.notEqual(a.session.runtimeFallbackAlias, b.session.runtimeFallbackAlias);
  const lease = store.prepare("__proto__");
  assert.throws(() => registry.register("bad", metadata("__proto__", { name: "x".repeat(6144) }), ["a"], lease, "claim"), code("record_too_large"));
  assert.equal(registry.session("a").endpointEpoch, a.session.endpointEpoch);
  assert.equal(store.inspect("__proto__", a.lease, "resume").current, true);
  const old = registry.membership("a", "a:b");
  registry.disconnect("a");
  const fresh = claim("new", "__proto__", ["a:b"]);
  assert.notEqual(fresh.session.runtimeFallbackAlias, a.session.runtimeFallbackAlias);
  assert.equal(registry.isMembershipCurrent(old), false);
  const surrogateA = claim("surrogate-a", "\ud800");
  const surrogateB = claim("surrogate-b", "\ud801");
  assert.equal(store.inspect(surrogateA.input.id, surrogateA.lease, "resume").current, true);
  assert.equal(store.inspect(surrogateB.input.id, surrogateB.lease, "resume").current, true);
});
