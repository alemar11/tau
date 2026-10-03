import assert from "node:assert/strict";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { OpenspaceClient, ClientError } from "../src/client/client.ts";
import { ConnectionController } from "../src/client/controller.ts";
import { startBroker } from "../src/broker/server.ts";
import { ensureBroker } from "../src/broker/spawn.ts";
import { FrameDecoder, writeFrame } from "../src/protocol/framing.ts";
import { envelope, FEATURES } from "../src/protocol/messages.ts";
import { makeSession } from "../src/registry/session.ts";
import { fixture, FakeClock, until, terminate } from "./fixtures/broker-helpers.mjs";

function client(t, f, id = randomUUID(), options = {}) {
  const value = new OpenspaceClient({ socketPath: f.paths.socketPath,
    session: { id, cwd: f.root, model: "test", pid: process.pid }, ...options });
  t.after(() => value.disconnect());
  return value;
}
async function real(t) {
  const f = fixture(t); const broker = await startBroker(f.paths); f.cleanup(() => broker.stop());
  return { ...f, broker };
}
// Script the wire, not client promises, to exercise segmentation/coalescing and actual sockets.
async function scripted(t, handle) {
  const f = fixture(t); mkdirSync(f.paths.runtimeDir, { recursive: true });
  const sockets = new Set(); let latest;
  const server = createServer((socket) => {
    latest = socket; sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    const decoder = new FrameDecoder(); let record;
    socket.on("data", (bytes) => decoder.push(bytes, (request) => {
      const reply = (type, fields = {}) => writeFrame(socket, { ...envelope(type, request.requestId), ...fields });
      if (request.type === "health") reply("health_result", { pid: process.pid, instanceId: "a".repeat(32), features: FEATURES });
      else if (request.type === "prepare") reply("prepared", { lease: "test-ticket" });
      else if (request.type === "register") {
        record = makeSession(request.session, request.workgroups, f.root, randomUUID(), "unnamed", Date.now());
        reply("registered", { session: record, features: FEATURES });
      } else handle({ request, reply, record, socket, setRecord: (value) => { record = value; } });
    }));
  });
  await new Promise((resolve) => server.listen(f.paths.socketPath, resolve));
  f.cleanup(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return { ...f, socket: () => latest };
}
const code = (expected) => (error) => error.code === expected;

test("client shares connect, registers once, serializes group transforms and preserves metadata on rejection", async (t) => {
  const f = await real(t); const c = client(t, f);
  const first = c.connect(); assert.equal(c.connect(), first); await first;
  assert.equal(c.isConnected, true); assert.equal(c.supports("lease-resume-v1"), true);
  const events = []; c.subscribe((event) => events.push(event));
  c.subscribe(() => { throw new Error("broken consumer"); });
  c.subscribe(async () => { throw new Error("broken async consumer"); });
  await Promise.all([c.mutateWorkgroups((groups) => [...groups, "a"]), c.mutateWorkgroups((groups) => [...groups, "b"])]);
  assert.deepEqual(c.workgroups, ["a", "b"]);
  const stamp = c.membership("a"), retained = c.membership("b");
  await c.setWorkgroups(["b"]); await c.setWorkgroups(["a", "b"]);
  assert.equal(c.hasMembership(stamp), false); assert.equal(c.hasMembership(retained), true);
  assert.equal((await c.listSessions()).length, 1);
  const before = c.info;
  await assert.rejects(c.updatePresence({ name: "x".repeat(6144) }), code("record_too_large"));
  assert.deepEqual(c.info, before);
  c.info.workgroups.push("not-real"); assert.deepEqual(c.workgroups, ["a", "b"]);
  await c.disconnect(); await c.disconnect();
  await c.connect(); assert.deepEqual(c.workgroups, ["a", "b"]); assert.equal(c.hasMembership(retained), true);
  assert.equal(events.filter((event) => event.type === "session" && event.left.includes("default")).length, 1);
});

test("out-of-order lists correlate; timeout/duplicate IDs never settle a different request", async (t) => {
  const waiting = [];
  const f = await scripted(t, (message) => waiting.push(message));
  const clock = new FakeClock(); const c = client(t, f, "id", { clock }); await c.connect();
  const a = c.request("list", {}, { response: "sessions", requestId: "a", timeoutMs: 10 });
  const aFailed = assert.rejects(a, code("timeout"));
  const b = c.request("list", {}, { response: "sessions", requestId: "b" });
  await assert.rejects(c.request("list", {}, { response: "sessions", requestId: "a" }), code("duplicate_request"));
  await until(() => waiting.length === 2);
  waiting[1].reply("sessions", { sessions: [waiting[1].record] }); assert.equal((await b).sessions[0].id, "id");
  clock.advance(10); await aFailed;
  await assert.rejects(c.request("list", {}, { response: "sessions", requestId: "a" }), code("duplicate_request"));
  const next = c.listSessions(); await until(() => waiting.length === 3);
  waiting[0].reply("sessions", { sessions: [] });
  waiting[2].reply("sessions", { sessions: [waiting[2].record] });
  assert.equal((await next).length, 1);
  await c.disconnect(); assert.equal(clock.timers.size, 0);
});

test("independent heartbeat survives a slow list, then detects a genuinely half-open socket", async (t) => {
  let pings = 0, answer = true;
  const f = await scripted(t, ({ request, reply }) => { if (request.type === "ping") { pings++; if (answer) reply("pong"); } });
  const clock = new FakeClock(); const c = client(t, f, "id", { clock, heartbeatMs: 30, heartbeatTimeoutMs: 5 }); await c.connect();
  const slow = c.listSessions(); const rejected = assert.rejects(slow, code("timeout"));
  clock.advance(30); await until(() => pings === 1 && [...clock.timers].some((timer) => timer.at === 60));
  assert.equal(c.isConnected, true);
  answer = false; clock.advance(30); await until(() => pings === 2);
  clock.advance(5); await until(() => c.state === "disconnected"); await rejected;
  assert.equal(clock.timers.size, 0);
});

test("uncertain group mutation reconciles before the next transform instead of reverting to default", async (t) => {
  let updates = 0;
  const f = await scripted(t, ({ request, reply, record, setRecord }) => {
    if (request.type === "set-workgroups") {
      const next = { ...record, revision: record.revision + 1, membershipRevision: record.membershipRevision + 1, workgroups: request.workgroups };
      setRecord(next); updates++;
      if (updates > 1) reply("session_updated", { session: next, changed: true }); // Drop only the first ack.
    } else if (request.type === "list") reply("sessions", { sessions: [record] });
  });
  const clock = new FakeClock(); const c = client(t, f, "id", { clock, requestTimeoutMs: 20 }); await c.connect();
  const mutation = c.setWorkgroups(["a"]); const rejected = assert.rejects(mutation, code("outcome_unknown"));
  await until(() => updates === 1); clock.advance(20); await rejected;
  await c.mutateWorkgroups((groups) => [...groups, "b"]);
  assert.deepEqual(c.workgroups, ["a", "b"]);
});

test("controller clears in-flight before scheduling three failures and a successful retry", async (t) => {
  const f = await real(t); const c = client(t, f); const clock = new FakeClock(); let attempts = 0;
  const controller = new ConnectionController({ client: c, clock, ensureBroker: async () => { if (++attempts <= 3) throw new Error("transient"); } });
  t.after(() => controller.stop()); controller.start();
  for (const delay of [1000, 2000, 5000]) {
    await until(() => clock.timers.size === 1); assert.equal(clock.timers.size, 1);
    clock.advance(delay);
  }
  await until(() => c.isConnected); assert.equal(attempts, 4); assert.equal(clock.timers.size, 0);
  assert.equal(await controller.ensureConnected(), c);
  await controller.stop(); assert.equal(clock.timers.size, 0);
});

test("two live controllers do not contend after takeover, including disjoint workgroups", async (t) => {
  const f = await real(t); const a = client(t, f, "same", { workgroups: ["a"] }); const b = client(t, f, "same", { workgroups: ["b"] });
  const clock = new FakeClock(); const warnings = [];
  const first = new ConnectionController({ client: a, clock, onWarning: (error) => warnings.push(error.code) });
  const second = new ConnectionController({ client: b, clock });
  t.after(() => first.stop()); t.after(() => second.stop());
  first.start(); await until(() => a.isConnected); second.start(); await until(() => b.isConnected && a.state === "revoked");
  assert.deepEqual(warnings, ["endpoint_replaced"]);
  await assert.rejects(first.ensureConnected(), code("endpoint_replaced"));
  clock.advance(300_000); assert.equal(clock.timers.size, 0); assert.equal(b.isConnected, true);
  await a.disconnect(); await assert.rejects(a.connect(), code("endpoint_replaced"));
});

test("two live controllers recover correctly after lost revocation and real broker restart", { timeout: 20_000 }, async (t) => {
  const f = fixture(t); const clock = new FakeClock(); const warnings = [];
  const first = await ensureBroker(f.paths, { brokerArgs: [] }, { env: f.env }); f.cleanup(() => terminate(first.pid));
  const old = client(t, f, "same", { workgroups: ["old"] });
  const current = client(t, f, "same", { workgroups: ["new"] });
  const a = new ConnectionController({ client: old, clock, onWarning: (error) => warnings.push(error.code) });
  const b = new ConnectionController({ client: current, clock });
  t.after(() => a.stop()); t.after(() => b.stop());
  a.start(); await until(() => old.isConnected);
  old.socket.removeAllListeners("data"); // Fault injection: the runtime loses endpoint_replaced, not the close.
  b.start(); await until(() => current.isConnected && old.state === "disconnected");
  assert.deepEqual(warnings, []);
  const stamp = current.membership("new");
  await terminate(first.pid); await until(() => !current.isConnected);
  const second = await ensureBroker(f.paths, { brokerArgs: [] }, { env: f.env }); f.cleanup(() => terminate(second.pid));
  clock.advance(1_000); await until(() => current.isConnected && old.state === "revoked");
  assert.deepEqual(current.workgroups, ["new"]); assert.equal(current.hasMembership(stamp), false);
  assert.deepEqual(warnings, ["endpoint_revoked"]);
  await assert.rejects(a.ensureConnected(), code("endpoint_revoked"));
  clock.advance(300_000); assert.equal(clock.timers.size, 0); assert.equal(current.isConnected, true);
});

test("shutdown during startup or backoff never revives the old runtime", async (t) => {
  const f = await real(t); const c = client(t, f); const clock = new FakeClock(); let release, attempts = 0;
  const controller = new ConnectionController({ client: c, clock, ensureBroker: () => { attempts++; return new Promise((resolve) => { release = resolve; }); } });
  controller.start(); await until(() => attempts === 1);
  const pending = controller.ensureConnected(); const rejected = assert.rejects(pending, code("session_ended"));
  await controller.stop(); release(); await rejected;
  assert.equal(c.isConnected, false); assert.equal(clock.timers.size, 0);
  const next = new ConnectionController({ client: client(t, f), clock, ensureBroker: async () => { throw new Error("transient"); } });
  next.start(); await until(() => clock.timers.size === 1); await next.stop(); clock.advance(30_000);
  assert.equal(clock.timers.size, 0); assert.equal(next.isRunning, false);
  let invalidAttempts = 0;
  const invalid = new ConnectionController({ client: client(t, f), clock, ensureBroker: async () => {
    invalidAttempts++; throw new Error("Openspace requires a Node.js 22.19+ executable");
  } });
  invalid.start(); await until(() => !invalid.isRunning); clock.advance(300_000);
  assert.equal(invalidAttempts, 1); assert.equal(clock.timers.size, 0); await invalid.stop();
});

test("shutdown from a registration callback cannot publish a revived registered state", async (t) => {
  const f = await real(t); const c = client(t, f); const states = [];
  c.subscribe((event) => {
    if (event.type === "state") states.push(event.state);
    if (event.type === "session") void c.disconnect();
  });
  await assert.rejects(c.connect(), code("disconnected"));
  assert.equal(c.state, "disconnected"); assert.equal(c.isConnected, false);
  assert.equal(states.includes("registered"), false);
});

test("malformed responses close cleanly and disconnect settles all pending operations once", async (t) => {
  const messages = []; const errors = [];
  const onUnhandled = (error) => errors.push(error); process.on("unhandledRejection", onUnhandled); t.after(() => process.off("unhandledRejection", onUnhandled));
  const f = await scripted(t, (message) => messages.push(message)); const c = client(t, f); await c.connect();
  const requests = [c.listSessions(), c.listSessions()]; const settled = Promise.allSettled(requests);
  await until(() => messages.length === 2);
  f.socket().write(Buffer.from([0, 0, 0, 1, 0x7b]));
  assert.ok((await settled).every((result) => result.status === "rejected"));
  await until(() => c.state === "disconnected"); await c.disconnect(); assert.deepEqual(errors, []);
  assert.throws(() => client(t, f, "bad", { heartbeatMs: -1 }), /Timeout/);
});
