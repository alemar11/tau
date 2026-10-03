import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPENSPACE_EXTENSION_REGISTER_EVENT, OPENSPACE_EXTENSION_FEATURE } from "openspace/extension-api";
import { startBroker } from "../src/broker/server.ts";
import { ensureBroker } from "../src/broker/spawn.ts";
import { ChannelStateStore } from "../src/broker/channel-state.ts";
import { atomicLeaseWrite } from "../src/registry/leases.ts";
import { OpenspaceClient } from "../src/client/client.ts";
import { ChannelManager } from "../src/client/channels.ts";
import { CHANNEL_LIMITS } from "../src/protocol/channels.ts";
import { FrameDecoder, encodeFrame } from "../src/protocol/framing.ts";
import { fixture, until, terminate, FakeClock } from "./fixtures/broker-helpers.mjs";
import { piSession } from "./fixtures/pi-session.mjs";
import consumer from "./fixtures/channel-consumer.ts";

const code = (code) => (error) => error.code === code;
async function actor(f, id, groups = [], options = {}) {
  const client = new OpenspaceClient({ socketPath: options.socketPath ?? f.paths.socketPath, session: { id, cwd: f.root, model: "fixture", pid: process.pid, ...options.session }, workgroups: groups, clock: options.clock, requestTimeoutMs: options.requestTimeoutMs });
  const manager = new ChannelManager(client, options.clock); f.cleanup(async () => { manager.dispose(); await client.disconnect(); });
  if (options.connect !== false) await client.connect(); return { client, manager };
}
async function setup(t, options = {}) { const f = fixture(t), broker = await startBroker(f.paths, options); f.cleanup(() => broker.stop()); return { ...f, broker }; }
function bind(actor, ns = "example", workgroup, eligible = true, options = {}) {
  const events = []; let ready = 0;
  const channel = actor.manager.register({ namespace: ns, workgroup, ownerEligible: eligible,
    onReady(value) { ready++; return options.onReady?.(value); }, onEvent(event) { events.push(event); return options.onEvent?.(event); } });
  return { channel, events, get ready() { return ready; } };
}
const connected = (binding) => until(() => binding.channel.snapshot().connected);
async function commit(binding, payload, expected) {
  const id = binding.channel.commitState(payload, expected);
  await until(() => binding.events.some((event) => event.type === "state_result" && event.requestId === id));
  return binding.events.find((event) => event.type === "state_result" && event.requestId === id);
}
const messages = (binding) => binding.events.filter((event) => event.type === "message");

test("registration before/after connect admits immediate onReady publishes; capable includes self and owner election ignores claimed start time", async (t) => {
  const f = await setup(t), a = await actor(f, "a", [], { connect: false, session: { startedAt: 1000 } }); let immediate;
  const first = bind(a, "same", undefined, true, { onReady(channel) { immediate = channel.publish({ startup: true }, { audience: "capable" }); } });
  assert.equal(first.ready, 0); await a.client.connect(); await connected(first); assert.deepEqual(await immediate, { written: 1, failed: 0, unknown: 0 });
  const b = await actor(f, "b", [], { session: { startedAt: 0 } }), second = bind(b, "same"); await connected(second);
  assert.equal(second.channel.snapshot().owner.id, "a");
  const result = await second.channel.publish({ text: "世界" }, { audience: "capable" }); assert.equal(result.written, 2);
  await until(() => messages(first).length === 2 && messages(second).length === 1);
  assert.equal(messages(second)[0].sender.id, "b"); assert.deepEqual(messages(second)[0].sender.workgroups, ["default"]);
  await second.channel.publish("only owner", { audience: "owner" }); await until(() => messages(first).length === 3); assert.equal(messages(second).length, 1);
  await assert.rejects(second.channel.publish("forged owner", { audience: "capable", ownerOnly: true }), code("not_channel_owner"));
  assert.equal((await commit(second, "not mine", 0)).code, "not_channel_owner");
});

test("CAS results correlate concurrent commits and snapshots are detached; listener failures do not break other channels", async (t) => {
  const f = await setup(t), a = await actor(f, "a"), b = await actor(f, "b"), owner = bind(a), listener = bind(b, "example", undefined, false, { onEvent(event) { if (event.type === "message") return Promise.reject(new Error("async consumer failure")); throw new Error("consumer failure"); } });
  await connected(owner); await connected(listener);
  const ids = [owner.channel.commitState({ count: 1 }, 0), owner.channel.commitState({ count: 2 }, 0)];
  await until(() => ids.every((id) => owner.events.some((event) => event.type === "state_result" && event.requestId === id)));
  const results = ids.map((id) => owner.events.find((event) => event.type === "state_result" && event.requestId === id));
  assert.deepEqual(results.map((event) => event.status), ["committed", "rejected"]); assert.equal(results[1].code, "revision_conflict");
  await until(() => listener.channel.snapshot().state?.revision === 1);
  const snapshot = listener.channel.snapshot(); snapshot.state.payload.count = 100; snapshot.owner.id = "other";
  assert.equal(listener.channel.snapshot().state.payload.count, 1); assert.equal(listener.channel.snapshot().owner.id, "a");
  assert.equal((await commit(owner, { count: 3 }, 1)).state.revision, 2);
  await owner.channel.publish({ after: true }, { audience: "capable" }); await until(() => messages(listener).length === 1);
  assert.equal((await owner.channel.listSessions()).length, 2); assert.equal(a.client.isConnected, true);
});

test("namespace/workgroup bindings isolate state, ownership and events; aggregate registration limit is not multiplied by groups", async (t) => {
  const f = await setup(t), a = await actor(f, "a", ["x", "y"]), b = await actor(f, "b", ["x", "y"]);
  assert.throws(() => bind(a), code("workgroup_ambiguous"));
  const x = bind(a, "same", "x"), y = bind(a, "same", "y"), bx = bind(b, "same", "x", false), by = bind(b, "same", "y", false), other = bind(b, "other", "x");
  for (const binding of [x, y, bx, by, other]) await connected(binding);
  assert.throws(() => bind(a, "same", "x"), code("duplicate_channel")); assert.throws(() => bind(a, "bad space", "x"), code("invalid_namespace"));
  await commit(x, { group: "x" }, 0); await commit(y, { group: "y" }, 0);
  await until(() => bx.channel.snapshot().state && by.channel.snapshot().state);
  assert.equal(bx.channel.snapshot().state.payload.group, "x"); assert.equal(by.channel.snapshot().state.payload.group, "y"); assert.equal(other.channel.snapshot().state, undefined);
  await x.channel.publish("only x", { audience: "capable" }); await until(() => messages(bx).length === 1);
  assert.equal(messages(by).length, 0); assert.equal(messages(other).length, 0);
  assert.deepEqual((await x.channel.listSessions()).map((session) => session.workgroups), [["x"], ["x"]]);
  for (let i = 0; i < 30; i++) bind(a, `n${i}`, i % 2 ? "x" : "y", false);
  assert.throws(() => bind(a, "overflow", "y"), code("capability_capacity"));
  await assert.rejects(a.client.request("channel-register", { namespace: "wire-overflow", workgroup: "x", ownerEligible: true }, { response: "channel_registered" }), code("capability_capacity"));
});

test("leave/rejoin on the same socket rotates ownership and binding epochs, preserving state but never rebinding to default", async (t) => {
  const f = await setup(t), a = await actor(f, "a", ["x", "y"]), x = bind(a, "same", "x"), y = bind(a, "same", "y"); await connected(x); await connected(y);
  await commit(x, { saved: true }, 0); const old = x.channel.snapshot().owner, other = y.channel.snapshot().owner, endpoint = a.client.info.endpointEpoch;
  await a.client.setWorkgroups(["y"]); assert.equal(x.channel.snapshot().connected, false); assert.equal(x.channel.snapshot().owner, undefined);
  assert.equal(x.channel.workgroup, "x"); assert.throws(() => { x.channel.workgroup = "y"; }, TypeError);
  await assert.rejects(x.channel.publish("must not migrate", { audience: "capable" }), code("workgroup_left"));
  assert.deepEqual(y.channel.snapshot().owner, other); await a.client.setWorkgroups(["x", "y"]); await connected(x);
  assert.equal(a.client.info.endpointEpoch, endpoint); assert.notEqual(x.channel.snapshot().owner.epoch, old.epoch); assert.equal(x.channel.snapshot().state.payload.saved, true); assert.equal(x.ready, 1);
  const binding = await a.client.request("channel-register", { namespace: "same", workgroup: "x", ownerEligible: true }, { response: "channel_registered" });
  await assert.rejects(a.client.request("channel-commit", { namespace: "same", workgroup: "x", bindingEpoch: binding.bindingEpoch, ownerEpoch: old.epoch, payload: "stale" }, { response: "channel_state_result" }), code("owner_revoked"));
  await a.client.setWorkgroups([]); assert.equal(x.channel.snapshot().connected, false); assert.equal(y.channel.snapshot().connected, false);
  assert.equal(x.channel.workgroup, "x"); assert.equal(y.channel.workgroup, "y");
});

test("ordinary reconnect refreshes snapshot and owner epoch; takeover fences the old runtime without channel reclaim", async (t) => {
  const f = await setup(t), a = await actor(f, "a"), binding = bind(a); await connected(binding); await commit(binding, "saved", 0);
  const old = binding.channel.snapshot().owner; await a.client.disconnect(); assert.equal(binding.channel.snapshot().owner, undefined);
  await a.client.connect(); await connected(binding); assert.notEqual(binding.channel.snapshot().owner.epoch, old.epoch); assert.equal(binding.channel.snapshot().state.payload, "saved");
  assert.equal(binding.ready, 1);
  const replacement = await actor(f, "a"), fresh = bind(replacement); await connected(fresh); await until(() => a.client.state === "revoked");
  await assert.rejects(binding.channel.publish("old", { audience: "capable" }), code("endpoint_revoked")); assert.throws(() => bind(a, "new"), code("endpoint_revoked"));
  assert.equal((await commit(fresh, "new owner", 1)).status, "committed");
});

test("byte boundaries, strict JSON and detached input are enforced before publish/commit; rejected payloads keep the connection usable", async (t) => {
  const f = await setup(t), a = await actor(f, "a"), binding = bind(a); await connected(binding);
  for (const [limit, operation] of [[CHANNEL_LIMITS.publishBytes, "publish"], [CHANNEL_LIMITS.stateBytes, "commit"]]) {
    const value = "🙂".repeat(Math.floor((limit - 2) / 4)) + "ab"; assert.equal(Buffer.byteLength(JSON.stringify(value)), limit);
    if (operation === "publish") { await binding.channel.publish(value, { audience: "capable" }); await assert.rejects(binding.channel.publish(value + "x", { audience: "capable" }), code("payload_too_large")); }
    else { assert.equal((await commit(binding, value, 0)).status, "committed"); assert.throws(() => binding.channel.commitState(value + "x"), code("payload_too_large")); }
  }
  const cycle = {}; cycle.self = cycle; let read = false; const accessor = { get value() { read = true; return 1; } };
  for (const value of [undefined, () => {}, NaN, Infinity, 1n, new Date(), new Map(), cycle, accessor, [undefined]]) {
    await assert.rejects(binding.channel.publish(value, { audience: "capable" })); assert.throws(() => binding.channel.commitState(value));
  }
  assert.equal(read, false);
  const payload = { nested: { value: "original" } }, id = binding.channel.commitState(payload, 1); payload.nested.value = "changed";
  await until(() => binding.events.some((event) => event.type === "state_result" && event.requestId === id)); assert.equal(binding.channel.snapshot().state.payload.nested.value, "original");
  const wire = await a.client.request("channel-register", { namespace: "example", workgroup: "default", ownerEligible: true }, { response: "channel_registered" });
  await assert.rejects(a.client.request("channel-publish", { namespace: "example", workgroup: "default", bindingEpoch: wire.bindingEpoch, audience: "capable", payload: "x".repeat(16384) }, { response: "channel_published" }), code("payload_too_large"));
  assert.equal((await a.client.request("ping", {}, { response: "pong" })).type, "pong");
});

test("real broker SIGKILL/restart reloads state, not owner epochs, and does not replay publishes", async (t) => {
  const f = fixture(t), first = await ensureBroker(f.paths, { brokerArgs: [] }, { env: f.env }); f.cleanup(() => terminate(first.pid));
  const a = await actor(f, "a"), binding = bind(a); await connected(binding); await commit(binding, { persistent: "世界" }, 0);
  await binding.channel.publish("ephemeral", { audience: "capable" }); await until(() => messages(binding).length === 1); const old = binding.channel.snapshot().owner;
  process.kill(first.pid, "SIGKILL"); await until(() => a.client.state === "disconnected");
  const second = await ensureBroker(f.paths, { brokerArgs: [] }, { env: f.env }); f.cleanup(() => terminate(second.pid));
  await a.client.connect(); await connected(binding);
  assert.equal(binding.channel.snapshot().state.revision, 1); assert.equal(binding.channel.snapshot().state.payload.persistent, "世界"); assert.notEqual(binding.channel.snapshot().owner.epoch, old.epoch);
  assert.equal(messages(binding).length, 1);
});

async function proxy(f, transform) {
  const path = join(f.root, "proxy.sock"), sockets = new Set(), requests = [];
  const server = createServer((downstream) => {
    const upstream = createConnection(f.paths.socketPath); sockets.add(downstream); sockets.add(upstream);
    const incoming = new FrameDecoder(), outgoing = new FrameDecoder();
    downstream.on("data", (bytes) => outgoing.push(bytes, (value) => { requests.push(value); upstream.write(encodeFrame(value)); }));
    upstream.on("data", (bytes) => incoming.push(bytes, (value) => { const changed = transform(value); if (changed) downstream.write(Array.isArray(changed) ? Buffer.concat(changed.map(encodeFrame)) : encodeFrame(changed)); }));
    for (const [socket, other] of [[downstream, upstream], [upstream, downstream]]) { socket.on("error", () => other.destroy()); socket.on("close", () => { sockets.delete(socket); other.destroy(); }); }
  });
  await new Promise((resolve) => server.listen(path, resolve)); f.cleanup(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  return { path, requests };
}

test("a broker without negotiated channel support receives no speculative channel operations", async (t) => {
  const f = await setup(t), link = await proxy(f, (value) => ({ ...value, ...(Array.isArray(value.features) ? { features: value.features.filter((feature) => feature !== OPENSPACE_EXTENSION_FEATURE) } : {}) }));
  const a = await actor(f, "a", [], { socketPath: link.path }), binding = bind(a); await until(() => binding.ready === 1);
  assert.equal(binding.channel.snapshot().supported, false); assert.equal(binding.channel.snapshot().connected, true);
  await assert.rejects(binding.channel.publish("no", { audience: "capable" }), code("unsupported_broker")); assert.throws(() => binding.channel.commitState("no"), code("unsupported_broker"));
  assert.equal(link.requests.some((request) => request.type.startsWith("channel-")), false);
});

test("lost commit acknowledgment is never reported committed; disconnect settles the request once while persisted state remains observable", async (t) => {
  const f = await setup(t), link = await proxy(f, (value) => value.type === "channel_state_result" ? undefined : value);
  const a = await actor(f, "a", [], { socketPath: link.path }), binding = bind(a); await connected(binding);
  const id = binding.channel.commitState({ persisted: true }, 0); await until(() => binding.channel.snapshot().state?.revision === 1);
  await a.client.disconnect(); await until(() => binding.events.some((event) => event.type === "state_result" && event.requestId === id));
  const results = binding.events.filter((event) => event.type === "state_result" && event.requestId === id); assert.equal(results.length, 1); assert.equal(results[0].status, "unknown");
  await a.client.connect(); await connected(binding); assert.equal(binding.channel.snapshot().state.payload.persisted, true);
  assert.equal(binding.events.filter((event) => event.type === "state_result" && event.requestId === id).length, 1);
});

function inspect(pi) { let value; pi.api.events.emit("fixture:inspect-channel", { inspect: (data) => { value = data; } }); assert.ok(value); return value; }
test("two real Pi consumer extensions load in opposite orders, exchange state/data and never invoke the model, transcript or sendMessage", async (t) => {
  const f = await setup(t); let sends = 0, appends = 0;
  const extend = (api) => { const send = api.sendMessage, append = api.appendEntry; api.sendMessage = (...args) => { sends++; return send(...args); }; api.appendEntry = (...args) => { appends++; return append(...args); }; };
  const a = await piSession(f, { extensionPaths: [fileURLToPath(new URL("./fixtures/channel-consumer.ts", import.meta.url))], extend });
  const b = await piSession(f, { factories: [consumer], extend }); const first = inspect(a), second = inspect(b);
  await until(() => first.channels.length === 1 && second.channels.length === 1 && first.published.length === 1 && second.published.length === 1);
  assert.equal(first.errors.length, 0); assert.equal(second.errors.length, 0);
  const owner = first.channels[0], id = owner.commitState({ from: "Pi" }, 0);
  await until(() => first.events.some((event) => event.type === "state_result" && event.requestId === id)); await until(() => second.channels[0].snapshot().state?.revision === 1);
  assert.equal(second.channels[0].snapshot().state.payload.from, "Pi"); assert.equal(sends, 0); assert.equal(appends, 0);
  for (const pi of [a, b]) { assert.equal(pi.requests.length, 0); assert.equal(pi.session.messages.length, 0); assert.deepEqual(pi.errors, []); }
  const duplicates = [];
  b.api.events.emit(OPENSPACE_EXTENSION_REGISTER_EVENT, { namespace: "fixture", ownerEligible: true, onReady() { throw new Error("duplicate ready"); }, onEvent: (event) => duplicates.push(event) });
  assert.deepEqual(duplicates, [{ type: "error", code: "duplicate_channel" }]);
});

test("peer lifecycle is projected to the binding group without exposing unrelated memberships", async (t) => {
  const f = await setup(t), a = await actor(f, "a", ["x"]), binding = bind(a, "example", "x"); await connected(binding);
  const b = await actor(f, "b", ["y"]);
  await b.client.setWorkgroups(["x", "y"]); await b.client.updatePresence({ name: "renamed" }); await b.client.setWorkgroups(["y"]);
  await until(() => binding.events.filter((event) => event.type === "peer" && event.session.id === "b").length === 3);
  const peers = binding.events.filter((event) => event.type === "peer" && event.session.id === "b");
  assert.deepEqual(peers.map((event) => event.change), ["joined", "updated", "left"]); for (const event of peers) assert.deepEqual(event.session.workgroups, ["x"]);
  assert.equal((await binding.channel.listSessions()).some((session) => session.id === "b"), false);
});

test("lost capability acknowledgement retries idempotently without early onReady or stale owner replay", async (t) => {
  const f = await setup(t); let drop = true;
  const link = await proxy(f, (value) => { if (value.type === "channel_registered" && drop) { drop = false; return; } return value; });
  const clock = new FakeClock(), a = await actor(f, "a", [], { socketPath: link.path, clock, requestTimeoutMs: 20 }), binding = bind(a);
  await until(() => !drop); assert.equal(binding.ready, 0); clock.advance(20);
  await until(() => binding.events.some((event) => event.type === "error" && event.code === "timeout")); clock.advance(1000); await connected(binding);
  assert.equal(binding.ready, 1); assert.equal(link.requests.filter((request) => request.type === "channel-register").length, 2);
  assert.equal((await binding.channel.publish("after retry", { audience: "capable" })).written, 1);
});

test("pending commits have a session-wide bound and all settle once on group departure; rejoin never replays them", async (t) => {
  const f = await setup(t, { limits: { rateCapacity: 1000 } }); let drop = true;
  const link = await proxy(f, (value) => drop && value.type === "channel_state_result" ? undefined : value);
  const a = await actor(f, "a", ["x", "y"], { socketPath: link.path }), binding = bind(a, "example", "x"); await connected(binding);
  const ids = Array.from({ length: 128 }, (_, index) => binding.channel.commitState({ index }));
  assert.throws(() => binding.channel.commitState("overflow"), code("channel_request_capacity"));
  await a.client.setWorkgroups(["y"]);
  await until(() => binding.events.filter((event) => event.type === "state_result").length === 128);
  for (const id of ids) { const result = binding.events.filter((event) => event.type === "state_result" && event.requestId === id); assert.equal(result.length, 1); assert.equal(result[0].status, "unknown"); assert.equal(result[0].code, "workgroup_left"); }
  drop = false; await a.client.setWorkgroups(["x", "y"]); await connected(binding);
  assert.equal(binding.channel.snapshot().state.revision, 128); assert.equal((await commit(binding, "after rejoin", 128)).status, "committed");
  assert.equal(binding.events.filter((event) => event.type === "state_result").length, 129);
});

test("uncertain disk write stops the real broker and emits unknown, never rejected or committed", async (t) => {
  let fail = false;
  const f = await setup(t, { channelState: { write(path, data) { atomicLeaseWrite(path, data); if (fail && path.endsWith(".json")) throw new Error("uncertain persistence"); } } });
  const a = await actor(f, "a"), binding = bind(a); await connected(binding); await commit(binding, "old", 0); fail = true;
  const id = binding.channel.commitState("possibly persisted", 1); await f.broker.closed;
  await until(() => binding.events.some((event) => event.type === "state_result" && event.requestId === id));
  const results = binding.events.filter((event) => event.type === "state_result" && event.requestId === id); assert.equal(results.length, 1); assert.equal(results[0].status, "unknown");
  assert.equal(new ChannelStateStore(f.paths.runtimeDir).get("default", "example").payload, "possibly persisted");
});

test("a publish acknowledged before leave in the same input chunk retains its known result", async (t) => {
  const f = await setup(t); let held;
  const link = await proxy(f, (value) => {
    if (value.type === "channel_published") { held = value; return; }
    if (value.type === "session_updated" && held) { const pair = [held, value]; held = undefined; return pair; }
    return value;
  });
  const a = await actor(f, "a", ["x", "y"], { socketPath: link.path }), binding = bind(a, "example", "x"); await connected(binding);
  const published = binding.channel.publish("before leaving", { audience: "capable" }); await a.client.setWorkgroups(["y"]);
  assert.deepEqual(await published, { written: 1, failed: 0, unknown: 0 }); assert.equal(binding.channel.snapshot().connected, false);
});

test("Pi runtime replacement retains factory registrations but invalidates every old handle", async (t) => {
  const f = await setup(t), pi = await piSession(f, { factories: [consumer] }), state = inspect(pi);
  await until(() => state.channels.length === 1); const old = state.channels[0], epoch = old.snapshot().owner.epoch;
  await pi.session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
  assert.equal(old.snapshot().connected, false); await assert.rejects(old.publish("too late", { audience: "capable" }), code("session_ended"));
  await pi.session.extensionRunner.emit({ type: "session_start", reason: "new" }); await pi.runtime.ready(); await until(() => state.channels.length === 2);
  assert.notEqual(state.channels[1], old); assert.notEqual(state.channels[1].snapshot().owner.epoch, epoch); assert.equal(old.snapshot().owner, undefined);
  const second = state.channels[1]; await pi.session.reload(); await pi.runtime.ready(); const reloaded = inspect(pi);
  await until(() => reloaded.channels.length === 1); assert.notEqual(reloaded, state); assert.equal(second.snapshot().connected, false);
  assert.equal(reloaded.events.some((event) => event.type === "error"), false);
  await pi.close(); const notifications = reloaded.events.length;
  assert.throws(() => pi.api.events.emit(OPENSPACE_EXTENSION_REGISTER_EVENT, { namespace: "after-quit" }), /ctx is stale/);
  assert.equal(reloaded.events.length, notifications); assert.equal(pi.requests.length, 0); assert.deepEqual(pi.errors, []);
});

test("disposing from an owner callback suppresses the following initial state event", async (t) => {
  const f = await setup(t), seed = await actor(f, "seed"), saved = bind(seed); await connected(saved); await commit(saved, "saved", 0); await seed.client.disconnect();
  const next = await actor(f, "next"), binding = bind(next, "example", undefined, true, { onEvent(event) { if (event.type === "owner") next.manager.dispose(); } });
  await until(() => binding.events.some((event) => event.type === "connection" && event.code === "session_ended"));
  assert.equal(binding.events.some((event) => event.type === "state"), false); assert.equal(binding.channel.snapshot().connected, false);
});

test("disposing from a failed registration callback cannot install a late retry timer", async (t) => {
  const f = await setup(t), link = await proxy(f, (value) => value.type === "channel_registered" ? undefined : value), clock = new FakeClock();
  const a = await actor(f, "a", [], { socketPath: link.path, clock, requestTimeoutMs: 20 });
  const binding = bind(a, "example", undefined, true, { onEvent(event) { if (event.type === "error") a.manager.dispose(); } });
  await until(() => link.requests.some((request) => request.type === "channel-register")); clock.advance(20);
  await until(() => binding.events.some((event) => event.type === "error")); assert.equal([...clock.timers].some((timer) => timer.at === 1020), false);
  clock.advance(1000); assert.equal(link.requests.filter((request) => request.type === "channel-register").length, 1);
});
