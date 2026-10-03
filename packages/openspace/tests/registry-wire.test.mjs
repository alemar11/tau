import assert from "node:assert/strict";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { encodeFrame, MAX_FRAME_BYTES } from "../src/protocol/framing.ts";
import { MAX_SESSION_BYTES } from "../src/registry/session.ts";
import { atomicLeaseWrite } from "../src/registry/leases.ts";
import { startBroker } from "../src/broker/server.ts";
import { ensureBroker } from "../src/broker/spawn.ts";
import { processAlive } from "../src/broker/runtime-files.ts";
import { fixture, raw, terminate, until } from "./fixtures/broker-helpers.mjs";

async function setup(t) {
  const f = fixture(t);
  const broker = await startBroker(f.paths);
  f.cleanup(() => broker.stop());
  return { ...f, broker, connect: () => raw(t, f.paths.socketPath) };
}

test("wire registry deduplicates multigroup peers, projects memberships and correlates lookup errors", async (t) => {
  const { connect } = await setup(t);
  const a = await connect(), b = await connect(), hidden = await connect();
  await a.register("a", { session: { id: "a" }, workgroups: ["x", "y"] });
  await b.register("b", { session: { id: "b", name: "Builder" }, workgroups: ["x", "y", "private"] });
  await hidden.register("h", { session: { id: "hidden" }, workgroups: ["private"] });
  const result = await a.request("list", "list");
  assert.equal(result.type, "sessions");
  assert.deepEqual(result.sessions.map((peer) => peer.id), ["a", "b"]);
  assert.deepEqual(result.sessions[1].workgroups, ["x", "y"]);
  assert.equal((await a.request("resolve", "resolve", { to: "BUILDER" })).code, "workgroup_ambiguous");
  const resolved = await a.request("resolve", "grouped", { to: "b", workgroup: "y" });
  assert.equal(resolved.workgroup, "y");
  for (const to of ["hidden", "absent"]) assert.equal((await a.request("resolve", to, { to })).code, "target_not_found");
  assert.equal((await a.request("list", "private", { workgroup: "private" })).code, "workgroup_not_shared");
  assert.equal((await a.request("send", "missing-fields")).code, "invalid_message");
  assert.ok(!JSON.stringify(result).includes("lease"));
});

test("membership deltas update both sides once, acknowledgements precede events, no-ops publish nothing", async (t) => {
  const { connect } = await setup(t);
  const a = await connect(), b = await connect(), c = await connect();
  await a.register("a", { session: { id: "a" }, workgroups: ["x"] });
  await b.register("b", { session: { id: "b" }, workgroups: ["x", "y"] });
  await c.register("c", { session: { id: "c" }, workgroups: ["z"] });
  await a.request("ping", "barrier-a"); await b.request("ping", "barrier-b");
  a.messages.length = 0; b.messages.length = 0; c.messages.length = 0;
  a.send("set-workgroups", "change", { expectedRevision: 1, workgroups: ["z"] });
  const ack = await a.receive();
  assert.equal(ack.type, "session_updated");
  assert.equal(ack.requestId, "change");
  const aEvents = [await a.receive(), await a.receive()];
  assert.deepEqual(aEvents.map((event) => event.event).sort(), ["joined", "left"]);
  assert.equal((await b.receive()).event, "left");
  assert.equal((await c.receive()).session.id, "a");
  const noOp = await a.request("set-workgroups", "noop", { expectedRevision: 2, workgroups: ["z", "z"] });
  assert.equal(noOp.changed, false);
  await c.request("ping", "barrier");
  assert.equal(c.messages.length, 0);
  assert.equal((await a.request("set-workgroups", "stale", { expectedRevision: 1, workgroups: [] })).code, "revision_conflict");
  assert.deepEqual((await a.request("list", "after-error")).sessions.map((peer) => peer.id), ["a", "c"]);
});

test("lost revocation cannot reclaim an ID after real process SIGKILL/restart, even with claim replay", { timeout: 20_000 }, async (t) => {
  const { paths, env, cleanup } = fixture(t);
  const first = await ensureBroker(paths, { brokerArgs: [] }, { env });
  cleanup(() => terminate(first.pid));
  const old = await raw(t, paths.socketPath);
  const oldFields = await old.registration({ session: { id: "shared" }, workgroups: ["old"] });
  const oldAck = await old.request("register", "old", oldFields);
  old.socket.removeAllListeners("data"); // The replaced runtime never sees the terminal notice.
  const current = await raw(t, paths.socketPath);
  const fields = await current.registration({ session: { id: "shared" }, workgroups: ["new"] });
  const ack = await current.request("register", "new", fields);
  assert.notEqual(ack.session.endpointEpoch, oldAck.session.endpointEpoch);
  await old.closed;
  assert.equal(old.messages.some((message) => message.code === "endpoint_replaced"), false);
  assert.equal((await current.request("list", "one")).sessions.length, 1);
  process.kill(first.pid, "SIGKILL");
  await until(() => !processAlive(first.pid));
  const second = await ensureBroker(paths, { brokerArgs: [] }, { env });
  cleanup(() => terminate(second.pid));
  assert.notEqual(first.instanceId, second.instanceId);
  for (const mode of ["resume", "claim"]) {
    const stale = await raw(t, paths.socketPath);
    assert.equal((await stale.request("register", mode, { ...oldFields, mode })).code, "endpoint_revoked");
    await stale.closed;
  }
  const restored = await raw(t, paths.socketPath);
  const resumed = await restored.request("register", "resume-current", { ...fields, mode: "resume" });
  assert.equal(resumed.type, "registered");
  assert.notEqual(resumed.session.endpointEpoch, ack.session.endpointEpoch);
  assert.deepEqual(resumed.session.workgroups, ["new"]);
  assert.equal((await restored.request("ping", "alive")).type, "pong");
  const ledger = join(paths.runtimeDir, "leases.json");
  assert.equal(lstatSync(ledger).mode & 0o777, 0o600);
  assert.ok(!readFileSync(ledger, "utf8").includes('"shared"'));
  await terminate(second.pid);
  assert.deepEqual(readdirSync(paths.runtimeDir), ["leases.json"]);
});

test("an unobserved registration acknowledgement resumes with its original ticket, not a new takeover", async (t) => {
  const { connect } = await setup(t);
  const observer = await connect(); await observer.register("observer");
  const first = await connect();
  const fields = await first.registration({ session: { id: "unconfirmed" } });
  first.socket.removeAllListeners("data");
  first.send("register", "lost-ack", fields);
  const joined = await observer.receive();
  assert.equal(joined.session.id, "unconfirmed");
  first.socket.destroy(); await first.closed;
  const next = await connect();
  const resumed = await next.request("register", "retry", { ...fields, mode: "resume" });
  assert.equal(resumed.type, "registered");
  assert.equal(resumed.session.runtimeFallbackAlias, joined.session.runtimeFallbackAlias);
  assert.equal((await next.request("list", "roster")).sessions.length, 2);
});

test("explicit release retires the lease while ordinary disconnect does not", async (t) => {
  const { connect } = await setup(t);
  const peer = await connect();
  const fields = await peer.registration({ session: { id: "released" } });
  await peer.request("register", "reg", fields);
  assert.equal((await peer.request("release", "release")).type, "released");
  await peer.closed;
  const stale = await connect();
  assert.equal((await stale.request("register", "resume", { ...fields, mode: "resume" })).code, "endpoint_revoked");
  const fresh = await connect();
  assert.equal((await fresh.register("fresh", { session: { id: "released" } })).type, "registered");
});

test("uncertain durable ownership writes stop every peer before further operations are served", async (t) => {
  const { paths, cleanup } = fixture(t);
  let fail = false;
  const broker = await startBroker(paths, { leases: { write(path, data) {
    atomicLeaseWrite(path, data);
    if (fail) throw new Error("injected post-rename failure");
  } } });
  cleanup(() => broker.stop());
  const a = await raw(t, paths.socketPath), b = await raw(t, paths.socketPath);
  const first = await a.registration({ session: { id: "same" } });
  await a.request("register", "a", first);
  const second = await b.registration({ session: { id: "same" } });
  fail = true;
  b.send("register", "uncertain", second);
  await broker.closed; await a.closed; await b.closed;
  assert.equal(b.messages.some((message) => message.type === "registered"), false);
  const restarted = await startBroker(paths); cleanup(() => restarted.stop());
  const stale = await raw(t, paths.socketPath), current = await raw(t, paths.socketPath);
  assert.equal((await stale.request("register", "stale", { ...first, mode: "resume" })).code, "endpoint_revoked");
  assert.equal((await current.request("register", "current", { ...second, mode: "resume" })).type, "registered");
});

test("128 fully budgeted records plus maximal correlation fit a single real socket frame", { timeout: 60_000 }, async (t) => {
  const { connect } = await setup(t);
  const peers = [];
  for (let i = 0; i < 128; i++) {
    const peer = await connect(); peers.push(peer);
    const ack = await peer.register(`register-${i}`, { session: { id: `session-${i}`, name: "n" } });
    const fill = MAX_SESSION_BYTES - Buffer.byteLength(JSON.stringify(ack.session));
    const updated = await peer.request("update", `update-${i}`, { expectedRevision: 1, patch: { name: "n" + "x".repeat(fill) } });
    assert.equal(updated.type, "session_updated");
    assert.equal(Buffer.byteLength(JSON.stringify(updated.session)), MAX_SESSION_BYTES);
    peer.messages.length = 0;
  }
  const roster = await peers[0].request("list", "\\".repeat(256));
  assert.equal(roster.sessions.length, 128);
  assert.ok(roster.sessions.every((record) => Buffer.byteLength(JSON.stringify(record)) === MAX_SESSION_BYTES));
  assert.ok(encodeFrame(roster).length <= MAX_FRAME_BYTES + 4);
  const extra = await connect();
  assert.equal((await extra.register("full", { session: { id: "extra" } })).code, "session_limit");
  await extra.closed;
  const takeover = await connect();
  assert.equal((await takeover.register("takeover-at-capacity", { session: { id: "session-0" }, workgroups: ["isolated"] })).type, "registered");
  const visible = await peers[1].request("list", "after-takeover");
  assert.equal(visible.sessions.length, 127);
});
