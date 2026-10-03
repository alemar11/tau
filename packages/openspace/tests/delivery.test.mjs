import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { OpenspaceClient } from "../src/client/client.ts";
import { Messenger } from "../src/client/messenger.ts";
import { startBroker } from "../src/broker/server.ts";
import { messageRef } from "../src/protocol/delivery.ts";
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from "../src/protocol/framing.ts";
import { envelope } from "../src/protocol/messages.ts";
import { fixture, FakeClock, until } from "./fixtures/broker-helpers.mjs";

async function setup(t, options = {}) {
  const f = fixture(t); const broker = await startBroker(f.paths, options); f.cleanup(() => broker.stop());
  async function actor(id, groups = [], metadata = {}, socketPath = f.paths.socketPath) {
    const client = new OpenspaceClient({ socketPath, session: { id, cwd: f.root, model: "test", pid: process.pid, ...metadata }, workgroups: groups });
    const messenger = new Messenger(client), events = [];
    messenger.subscribe((event) => events.push(event));
    t.after(async () => { messenger.dispose(); await client.disconnect(); });
    await client.connect();
    return { client, messenger, events, messages: () => events.filter((event) => event.type === "message").map((event) => event.message) };
  }
  return { ...f, broker, actor };
}
async function offline(actor, observer) {
  await actor.client.disconnect();
  await until(async () => !(await observer.client.listSessions()).some((peer) => peer.id === actor.client.info.id));
}
const code = (expected) => (error) => error.code === expected;

test("explicit IDs, Unicode attachments and transport-only results survive exact replay", async (t) => {
  const { actor } = await setup(t); const a = await actor("a", ["shared", "private-a"]), b = await actor("b", ["shared", "private-b"]);
  const payload = { messageId: "explicit-🙂", text: "ciao\n世界", attachments: [{ type: "snippet", name: "é.ts", text: "λ => 🙂", language: "ts" }] };
  const result = await a.messenger.send("b", payload); assert.equal(result.delivery, "socket_delivered"); assert.equal(result.workgroup, "shared");
  await until(() => b.messages().length === 1);
  assert.equal(b.messages()[0].id, payload.messageId); assert.deepEqual(b.messages()[0].attachments, payload.attachments);
  assert.equal(b.messages()[0].text, payload.text); assert.ok(!JSON.stringify(b.messages()[0]).includes("private-a"));
  const replay = await a.messenger.send("b", payload); assert.deepEqual(replay, result); assert.equal(b.messages().length, 1);
  assert.equal((await a.messenger.send("b", { ...payload, text: "changed" })).code, "E_MESSAGE_ID_REUSE");
  assert.equal((await a.messenger.send("a", { text: "self" })).code, "self_target");
  assert.equal((await a.messenger.send("b", { text: "not a valid reply", replyTo: { senderId: "b", workgroup: "shared", messageId: "absent" } })).code, "ask_not_pending");
});

test("zero/one/multiple groups, ambiguous names and colliding message references remain isolated", async (t) => {
  const { actor } = await setup(t); const a = await actor("a", ["x", "y"]), b = await actor("b", ["x", "y"], { name: "Worker" });
  const c = await actor("c", ["x", "y"], { name: "Worker" }), d = await actor("d", ["private"]);
  assert.equal((await a.messenger.send("Worker", { text: "ambiguous", workgroup: "x" })).code, "target_ambiguous");
  assert.equal((await a.messenger.send("b", { text: "group?" })).code, "workgroup_ambiguous");
  assert.equal((await d.messenger.send("b", { text: "invisible" })).code, "target_not_found");
  for (const [sender, group, text] of [[a, "x", "ax"], [a, "y", "ay"], [c, "x", "cx"]]) {
    assert.equal((await sender.messenger.send("b", { text, messageId: "same", workgroup: group })).delivery, "socket_delivered");
  }
  await until(() => b.messages().length === 3);
  const ref = messageRef(b.messages()[0]);
  await assert.rejects(c.messenger.cancel(ref), code("not_message_owner"));
  await assert.rejects(a.messenger.receipt(ref, "injected"), code("not_message_recipient"));
  await b.messenger.receipt(ref, "injected");
  await until(() => a.events.some((event) => event.type === "receipt" && event.receipt.status === "injected"));
  assert.equal(c.events.some((event) => event.type === "receipt"), false);
  assert.equal(a.events.find((event) => event.type === "receipt").receipt.ref.workgroup, "x");
});

test("exact rebound permits one retry, while leave/rejoin during lookup never rebinds a group", async (t) => {
  const { actor } = await setup(t); const a = await actor("a", ["x", "y"]), b = await actor("b", ["x", "y"]);
  const old = await a.messenger.resolve({ to: "b", workgroup: "x" });
  await b.client.disconnect(); await b.client.connect();
  assert.equal((await a.messenger.sendResolved(old, { text: "new socket", messageId: "rebound" })).delivery, "socket_delivered");
  await until(() => b.messages().length === 1);
  const staleTarget = await a.messenger.resolve({ to: "b", workgroup: "x" });
  await b.client.setWorkgroups(["y"]); await b.client.setWorkgroups(["x", "y"]);
  await b.client.disconnect(); await b.client.connect();
  assert.equal((await a.messenger.sendResolved(staleTarget, { text: "stale target membership" })).code, "workgroup_left");
  const staleSender = await a.messenger.resolve({ to: "b", workgroup: "x" });
  await a.client.setWorkgroups(["y"]); await a.client.setWorkgroups(["x", "y"]);
  assert.equal((await a.messenger.sendResolved(staleSender, { text: "stale sender membership" })).code, "workgroup_left");
  assert.equal(b.messages().length, 1);
  const initial = await a.messenger.resolve({ to: "b", workgroup: "x" });
  await b.client.disconnect(); await b.client.connect();
  const resolve = a.messenger.resolve.bind(a.messenger); let resolves = 0;
  a.messenger.resolve = async (selector) => {
    resolves++; const binding = await resolve(selector);
    await b.client.disconnect(); await b.client.connect(); return binding;
  };
  assert.equal((await a.messenger.sendResolved(initial, { text: "only one retry" })).code, "endpoint_rebound");
  assert.equal(resolves, 1); assert.equal(b.messages().length, 1);
});

test("membership cannot be reacquired between a rebound response and its one permitted lookup retry", async (t) => {
  const { actor } = await setup(t), a = await actor("a", ["x", "y"]), b = await actor("b", ["x", "y"]);
  const selected = await a.messenger.resolve({ to: "b", workgroup: "x" });
  await b.client.disconnect(); await b.client.connect();
  const resolve = a.messenger.resolve.bind(a.messenger);
  a.messenger.resolve = async (selector) => { await b.client.setWorkgroups(["y"]); await b.client.setWorkgroups(["x", "y"]); return resolve(selector); };
  const result = await a.messenger.sendResolved(selected, { text: "do not revive old membership" });
  assert.equal(result.code, "workgroup_left"); assert.equal(result.outcomeKnown, true); assert.equal(b.messages().length, 0);
});

test("mailbox survives disconnect, but explicit leave cancels queued data and replay cannot revive it", async (t) => {
  const { actor } = await setup(t); const a = await actor("a", ["x"]), b = await actor("b", ["x"]);
  await offline(b, a);
  const queued = await a.messenger.send("b", { text: "offline", messageId: "queued" }); assert.equal(queued.delivery, "queued");
  await b.client.connect(); await until(() => b.messages().length === 1); assert.equal(b.messages()[0].id, "queued");
  await offline(b, a);
  assert.equal((await a.messenger.send("b", { text: "cancel on leave", messageId: "left" })).delivery, "queued");
  // The sender leaves too: no late delivery can be authorized by a later rejoin.
  await a.client.setWorkgroups([]); await a.client.setWorkgroups(["x"]);
  await b.client.connect();
  assert.equal((await a.messenger.send("b", { text: "cancel on leave", messageId: "left" })).code, "workgroup_left");
  assert.equal(b.messages().length, 1);
});

test("mailbox recovers exact IDs and explicit unique name/cwd, never aliases, self or foreign cwd/groups", async (t) => {
  const { actor, root } = await setup(t); const a = await actor("a", ["g"]);
  const b = await actor("old", ["g"], { name: "Named" }); await offline(b, a);
  assert.equal((await a.messenger.send("old", { text: "named recovery", messageId: "named" })).delivery, "queued");
  const wrong = await actor("wrong", ["g"], { name: "Named", cwd: join(root, "other") }); assert.equal(wrong.messages().length, 0);
  const foreign = await actor("foreign", ["elsewhere"], { name: "Named" }); assert.equal(foreign.messages().length, 0);
  const recovered = await actor("new", ["g"], { name: "Named" }); await until(() => recovered.messages().length === 1);
  assert.equal(recovered.messages()[0].recipientId, "new");
  const anonymous = await actor("anonymous", ["g"]); const alias = anonymous.client.info.runtimeFallbackAlias; await offline(anonymous, a);
  await a.messenger.send("anonymous", { text: "not transferable" });
  const impostor = await actor("impostor", ["g"], { name: alias }); assert.equal(impostor.messages().length, 0);
  await anonymous.client.connect(); await until(() => anonymous.messages().length === 1);
  const selfName = await actor("self-name", ["g"], { name: "Sender" }); await offline(selfName, a);
  await a.messenger.send("self-name", { text: "never back to sender" }); await a.client.updatePresence({ name: "Sender" });
  assert.equal(a.messages().length, 0);
});

test("fresh exact identity can recover a queue, but recipient group departure remains terminal after rejoin", async (t) => {
  const { actor } = await setup(t); const a = await actor("a", ["x"]), old = await actor("b", ["x"]);
  await offline(old, a); await a.messenger.send("b", { text: "exact claim", messageId: "exact" });
  const replacement = await actor("b", ["x"]); await until(() => replacement.messages().length === 1);
  await offline(replacement, a); await a.messenger.send("b", { text: "do not revive", messageId: "left-recipient" });
  const leaving = await actor("b", ["y"]); await leaving.client.setWorkgroups(["x"]);
  assert.equal((await a.messenger.send("b", { text: "do not revive", messageId: "left-recipient" })).code, "workgroup_left");
  assert.equal(leaving.messages().length, 0);
});

test("byte capacity rejects a single oversize message before forwarding or losing an existing queue", async (t) => {
  const { actor } = await setup(t, { delivery: { limits: { mailboxBytes: 1024 } } });
  const a = await actor("a"), b = await actor("b"); await offline(b, a);
  assert.equal((await a.messenger.send("b", { text: "kept", messageId: "kept" })).delivery, "queued");
  assert.equal((await a.messenger.send("b", { text: "x".repeat(1024) })).code, "mailbox_capacity");
  await b.client.connect(); await until(() => b.messages().length === 1); assert.equal(b.messages()[0].id, "kept");
});

test("duplicate offline names prevent ambiguous mailbox transfer", async (t) => {
  const { actor } = await setup(t); const a = await actor("a"), b = await actor("b", [], { name: "Same" }), c = await actor("c", [], { name: "Same" });
  await offline(b, a); await offline(c, a);
  await a.messenger.send("b", { text: "belongs to b" });
  const d = await actor("d", [], { name: "Same" });
  assert.equal(d.messages().length, 0);
  assert.equal((await a.messenger.send("Same", { text: "do not prefer the live duplicate" })).code, "target_ambiguous");
  await b.client.connect(); await until(() => b.messages().length === 1);
});

test("mailbox count/TTL and replay count eviction are bounded and observable", async (t) => {
  const clock = new FakeClock();
  const { actor } = await setup(t, { clock, delivery: { now: clock.now, limits: { mailboxCount: 1, mailboxMs: 20, replayCount: 3, replayMs: 100 } } });
  const a = await actor("a"), b = await actor("b"); await offline(b, a);
  await a.messenger.send("b", { text: "first", messageId: "first" });
  await a.messenger.send("b", { text: "second", messageId: "second" });
  assert.equal((await a.messenger.send("b", { text: "first", messageId: "first" })).code, "mailbox_overflow");
  clock.advance(20);
  await until(() => a.events.some((event) => event.type === "receipt" && event.receipt.code === "mailbox_expired"));
  assert.equal((await a.messenger.send("b", { text: "second", messageId: "second" })).code, "mailbox_expired");
  await b.client.connect(); assert.equal(b.messages().length, 0);
  for (let i = 0; i < 4; i++) await a.messenger.send("b", { text: "live", messageId: `live-${i}` });
  await until(() => a.events.some((event) => event.type === "receipt" && event.receipt.code === "replay_evicted"));
  await a.messenger.send("b", { text: "live", messageId: "live-0" });
  await until(() => b.messages().length === 5); // Outside retained replay capacity, not an exactly-once promise.
});

test("cancel and supersede enforce sender/target ownership without claiming to abort injected work", async (t) => {
  const { actor } = await setup(t); const a = await actor("a"), b = await actor("b"), c = await actor("c");
  await a.messenger.send("b", { text: "held", messageId: "held" }); await until(() => b.messages().length === 1);
  const ref = messageRef(b.messages()[0]);
  assert.equal((await a.messenger.cancel(ref)).status, "cancellation_requested");
  await until(() => b.events.some((event) => event.type === "control"));
  await b.messenger.receipt(ref, "cancelled", "cancelled_before_injection");
  assert.equal((await a.messenger.send("b", { text: "held", messageId: "held" })).code, "cancelled_before_injection");
  await a.messenger.send("b", { text: "injected", messageId: "injected" }); await until(() => b.messages().length === 2);
  const injected = messageRef(b.messages()[1]); await b.messenger.receipt(injected, "injected");
  assert.equal((await a.messenger.cancel(injected)).status, "cancellation_requested");
  await b.messenger.receipt(injected, "cancellation_requested");
  assert.equal((await b.messenger.receipt(injected, "cancelled")).status, "cancellation_requested");
  assert.equal((await a.messenger.send("b", { text: "replacement", messageId: "replacement", supersedes: "injected" })).delivery, "socket_delivered");
  assert.equal((await a.messenger.send("c", { text: "wrong target", supersedes: "replacement" })).code, "invalid_supersedes");
  assert.equal((await c.messenger.send("b", { text: "not owner", supersedes: "replacement" })).code, "not_message_owner");
  await offline(b, a); await a.messenger.send("b", { text: "queued", messageId: "queued-cancel" });
  assert.equal((await a.messenger.cancel({ workgroup: "default", senderId: "a", messageId: "queued-cancel" })).status, "cancelled");
});

test("a lost delivery acknowledgement is unknown and never retried automatically", async (t) => {
  const f = await setup(t); let drop = true, sends = 0;
  const proxyPath = join(f.root, "proxy.sock"), sockets = new Set();
  const proxy = createServer((downstream) => {
    const upstream = createConnection(f.paths.socketPath); sockets.add(downstream); sockets.add(upstream);
    for (const socket of [upstream, downstream]) { socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); upstream.destroy(); downstream.destroy(); }); }
    const requests = new FrameDecoder(), responses = new FrameDecoder();
    downstream.on("data", (chunk) => { requests.push(chunk, (value) => { if (value.type === "send") sends++; }); upstream.write(chunk); });
    upstream.on("data", (chunk) => responses.push(chunk, (value) => {
      if (value.type === "delivery_result" && drop) { drop = false; upstream.destroy(); downstream.destroy(); return false; }
      downstream.write(encodeFrame(value));
    }));
  });
  await new Promise((resolve) => proxy.listen(proxyPath, resolve));
  f.cleanup(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); proxy.close(resolve); }));
  const a = await f.actor("a", [], {}, proxyPath), b = await f.actor("b");
  const options = { messageId: "uncertain", text: "write happened" };
  const result = await a.messenger.send("b", options);
  assert.equal(result.delivery, "unknown"); assert.equal(result.outcomeKnown, false); assert.equal(sends, 1);
  await until(() => b.messages().length === 1);
  await a.client.connect(); assert.equal((await a.messenger.send("b", options)).delivery, "socket_delivered");
  assert.equal(sends, 2); assert.equal(b.messages().length, 1);
});

test("full escaped request envelope accepts exactly 1 MiB and rejects +1 without any second delivery", async (t) => {
  const { actor } = await setup(t); const a = await actor("a"), b = await actor("b");
  const target = await a.messenger.resolve({ to: "b" });
  const fields = { to: "b", endpointEpoch: target.session.endpointEpoch, membershipEpoch: target.membershipEpoch,
    senderMembershipEpoch: target.senderMembershipEpoch, workgroup: "default",
    message: { id: "boundary", text: "", sequence: 1, sentAt: 1, provenance: { kind: "local" } } };
  const remaining = MAX_FRAME_BYTES - (encodeFrame({ ...fields, ...envelope("send", "boundary-good") }).length - 4);
  fields.message.text = "\\".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
  assert.equal(encodeFrame({ ...fields, ...envelope("send", "boundary-good") }).length, MAX_FRAME_BYTES + 4);
  const response = await a.client.request("send", fields, { response: "delivery_result", requestId: "boundary-good" });
  assert.equal(response.result.delivery, "socket_delivered"); await until(() => b.messages().length === 1);
  fields.message.text += "x";
  await assert.rejects(a.client.request("send", fields, { response: "delivery_result", requestId: "boundary-over" }), code("frame_too_large"));
  assert.equal(b.messages().length, 1); assert.equal(a.client.isConnected, true);
});

test("broker restart loses RAM mailbox and replay without inventing delivery", async (t) => {
  const f = await setup(t); const a = await f.actor("a"), b = await f.actor("b"); await offline(b, a);
  await a.messenger.send("b", { text: "RAM only", messageId: "ram" }); await f.broker.stop();
  await until(() => !a.client.isConnected);
  const next = await startBroker(f.paths); f.cleanup(() => next.stop());
  await a.client.connect(); await b.client.connect();
  assert.equal(b.messages().length, 0);
  assert.equal((await a.messenger.send("b", { text: "RAM only", messageId: "ram" })).delivery, "socket_delivered");
  await until(() => b.messages().length === 1);
});
