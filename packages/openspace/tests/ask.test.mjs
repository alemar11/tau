import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startBroker } from "../src/broker/server.ts";
import { OpenspaceClient } from "../src/client/client.ts";
import { Messenger } from "../src/client/messenger.ts";
import { Conversation } from "../src/client/conversation.ts";
import { ReplyTracker } from "../src/client/reply-tracker.ts";
import { AskService } from "../src/broker/asks.ts";
import { messageRef } from "../src/protocol/delivery.ts";
import { fixture, FakeClock, until } from "./fixtures/broker-helpers.mjs";
import { piSession } from "./fixtures/pi-session.mjs";

async function setup(t, options = {}) {
  const f = fixture(t), broker = await startBroker(f.paths, options); f.cleanup(() => broker.stop());
  const actor = async (id, groups = [], conversationOptions = {}, name) => {
    const client = new OpenspaceClient({ socketPath: f.paths.socketPath, session: { id, cwd: f.root, pid: process.pid, model: "fixture", name }, workgroups: groups });
    const messenger = new Messenger(client), conversation = new Conversation(messenger, conversationOptions), messages = [], events = [];
    messenger.subscribe((event) => { events.push(event); if (event.type === "message") messages.push(event.message); });
    f.cleanup(async () => { conversation.dispose(); messenger.dispose(); await client.disconnect(); });
    await client.connect(); return { client, messenger, conversation, messages, events };
  };
  return { ...f, broker, actor, diagnostics: () => JSON.parse(readFileSync(join(f.paths.runtimeDir, "pending-asks.json"), "utf8")).asks };
}

test("ask/reply bind exact IDs and one group, preserve explicit IDs and Unicode attachments, and prune diagnostics", async (t) => {
  const f = await setup(t), a = await f.actor("a", ["x", "y"]), b = await f.actor("b", ["x", "y"]), c = await f.actor("c", ["x"]);
  const ask = a.conversation.ask("b", { text: "question", messageId: "ask-id", workgroup: "x" });
  await until(() => b.conversation.pending().length === 1);
  assert.equal(f.diagnostics()[0].question, "question"); assert.equal(f.diagnostics()[0].messageId, "ask-id");
  const ref = b.conversation.pending()[0].ref;
  assert.equal((await c.messenger.send("a", { text: "impostor", replyTo: ref, workgroup: "x" })).code, "invalid_reply_target");
  assert.equal((await b.messenger.send("a", { text: "wrong group", replyTo: ref, workgroup: "y" })).code, "invalid_reply_target");
  const response = await b.conversation.reply({ replyTo: ref }, { text: "answer", messageId: "reply-id", attachments: [{ type: "snippet", name: "sample", text: "λ 世界" }] });
  assert.equal(response.delivery, "socket_delivered"); const result = await ask;
  assert.equal(result.status, "answered"); assert.equal(result.response.id, "reply-id"); assert.equal(result.response.attachments[0].text, "λ 世界");
  assert.equal(result.response.workgroup, "x"); assert.equal(b.conversation.pending().length, 0); assert.deepEqual(f.diagnostics(), []);
  await assert.rejects(a.conversation.ask("b", { text: "new", messageId: "ask-id", workgroup: "x" }), { message: "ask_id_reuse" });
});

test("concurrent lookups reserve only one waiter and a reply preceding the send acknowledgement is retained", async (t) => {
  const f = await setup(t), a = await f.actor("a"), b = await f.actor("b");
  const resolve = a.messenger.resolve.bind(a.messenger), send = a.messenger.sendResolved.bind(a.messenger);
  let releaseLookup, releaseAck, entered = 0;
  const gate = new Promise((resolve) => { releaseLookup = resolve; });
  const ack = new Promise((resolve) => { releaseAck = resolve; });
  a.messenger.resolve = async (selector) => { const result = await resolve(selector); entered++; await gate; return result; };
  a.messenger.sendResolved = async (...args) => { const result = await send(...args); await ack; return result; };
  const first = a.conversation.ask("b", { text: "first" }), second = a.conversation.ask("b", { text: "second" });
  const rejected = assert.rejects(second, { message: "ask_in_progress" });
  await until(() => entered === 2); releaseLookup(); await rejected;
  await until(() => b.conversation.pending().length === 1); assert.equal(b.messages.length, 1);
  await b.conversation.reply({}, { text: "immediate" });
  assert.equal((await first).response.text, "immediate"); releaseAck();
});

test("receiver refusal settles the waiter promptly without confusing an acknowledgement with task completion", async (t) => {
  const f = await setup(t), a = await f.actor("a"), b = await f.actor("b");
  const ask = a.conversation.ask("b", { text: "cannot fit in held queue" }); await until(() => b.messages.length === 1);
  await b.messenger.receipt(messageRef(b.messages[0]), "expired", "held_overflow");
  const result = await ask; assert.equal(result.code, "held_overflow"); assert.equal(result.status, "failed"); assert.deepEqual(f.diagnostics(), []);
  await until(() => b.conversation.pending().length === 0);
});

test("single-flight and direct mutual ask span workgroups; answer/cancel free the relation", async (t) => {
  const f = await setup(t), a = await f.actor("a", ["x", "y"]), b = await f.actor("b", ["x", "y"]);
  const ask = a.conversation.ask("b", { text: "a to b", workgroup: "x", messageId: "a-question" }); await until(() => b.messages.length === 1);
  const mutual = await b.conversation.ask("a", { text: "reverse", workgroup: "y" }); assert.equal(mutual.code, "mutual_ask");
  await a.messenger.cancel(messageRef(b.messages[0])); assert.equal((await ask).code, "ask_cancelled");
  const reverse = b.conversation.ask("a", { text: "now allowed", workgroup: "y" }); await until(() => a.conversation.pending().length === 1);
  await a.conversation.reply({}, { text: "yes" }); assert.equal((await reverse).status, "answered");
});

test("independent waiter, tracker and broker timeouts do not cancel work or permit a late reply to resolve a new ask", async (t) => {
  const brokerClock = new FakeClock(), waiterClock = new FakeClock(), trackerClock = new FakeClock();
  const f = await setup(t, { clock: brokerClock, asks: { now: brokerClock.now, timeoutMs: 100 } });
  const a = await f.actor("a", [], { clock: waiterClock, timeoutMs: 10 }), b = await f.actor("b", [], { clock: trackerClock, trackerTimeoutMs: 50 });
  const first = a.conversation.ask("b", { text: "first", messageId: "first" }); await until(() => b.messages.length === 1);
  await until(() => f.diagnostics().length === 1); waiterClock.advance(10);
  assert.equal((await first).code, "ask_timeout"); assert.equal(f.diagnostics().length, 1);
  assert.equal(b.events.some((event) => event.type === "control"), false);
  const next = a.conversation.ask("b", { text: "second", messageId: "second" }); await until(() => b.messages.length === 2);
  await b.conversation.reply({ replyTo: messageRef(b.messages[0]) }, { text: "late-first" });
  assert.equal(f.diagnostics().length, 1);
  let resolved = false; void next.then(() => { resolved = true; }); await new Promise((resolve) => setImmediate(resolve)); assert.equal(resolved, false);
  trackerClock.advance(50); await assert.rejects(b.conversation.reply({}, { text: "tracker expired" }), { message: "reply_not_pending" });
  brokerClock.advance(100); assert.equal((await next).code, "ask_expired");
  assert.equal((await b.messenger.send("a", { text: "too late", replyTo: messageRef(b.messages[1]) })).code, "ask_expired");
  assert.deepEqual(f.diagnostics(), []);
});

test("disconnect ends the waiter but a still-valid reply can enter mailbox; abort abandons correlation without cancel_message", async (t) => {
  const f = await setup(t), a = await f.actor("a"), b = await f.actor("b");
  const ask = a.conversation.ask("b", { text: "offline later" }); await until(() => b.messages.length === 1);
  await a.client.disconnect(); assert.equal((await ask).code, "disconnected");
  await until(async () => !(await b.client.listSessions()).some((peer) => peer.id === "a"));
  const reply = await b.conversation.reply({}, { text: "mailbox reply" }); assert.equal(reply.delivery, "queued");
  await a.client.connect(); await until(() => a.messages.length === 1); assert.equal(a.messages[0].text, "mailbox reply");
  const signal = new AbortController(); const aborted = a.conversation.ask("b", { text: "abandon", signal: signal.signal }); await until(() => b.messages.length === 2);
  signal.abort(); assert.equal((await aborted).code, "aborted"); await until(() => f.diagnostics().length === 0);
  assert.equal(b.events.some((event) => event.type === "control"), false);
  assert.equal((await b.messenger.send("a", { text: "old", replyTo: messageRef(b.messages[1]) })).code, "ask_aborted");
  await b.client.disconnect(); await until(async () => !(await a.client.listSessions()).some((peer) => peer.id === "b"));
  await assert.rejects(a.conversation.ask("b", { text: "offline" }), { message: "target_disconnected" });
});

test("group departure terminates both endpoints' correlation and rejoin cannot reopen it", async (t) => {
  const f = await setup(t), a = await f.actor("a", ["x", "y"]), b = await f.actor("b", ["x", "y"]);
  const ask = a.conversation.ask("b", { text: "stay in x", workgroup: "x", messageId: "same" }); await until(() => b.messages.length === 1);
  await b.client.setWorkgroups(["y"]); assert.equal((await ask).code, "workgroup_left"); await b.client.setWorkgroups(["x", "y"]);
  assert.equal(b.conversation.pending().length, 0);
  assert.equal((await b.messenger.send("a", { text: "cannot migrate", workgroup: "y", replyTo: messageRef(b.messages[0]) })).code, "workgroup_left");
  assert.equal((await b.messenger.send("a", { text: "cannot reopen", workgroup: "x", replyTo: messageRef(b.messages[0]) })).code, "workgroup_left");
  assert.deepEqual(f.diagnostics(), []);
});

test("pending selection uses exact identity/name/prefix, explicit ref and current context without selecting among ambiguous asks", async (t) => {
  const f = await setup(t), a = await f.actor("agent-a", [], {}, "Same"), b = await f.actor("b"), c = await f.actor("agent-c", [], {}, "Same");
  const first = a.conversation.ask("b", { text: "a", messageId: "same" }), second = c.conversation.ask("b", { text: "c", messageId: "same" });
  await until(() => b.conversation.pending().length === 2);
  assert.throws(() => b.conversation.selection(), { message: "reply_ambiguous_use_pending" });
  assert.throws(() => b.conversation.selection({ to: "Same" }), { message: "reply_ambiguous_use_pending" });
  const original = b.messages.find((message) => message.sender.id === "agent-c"); b.conversation.activate(original);
  assert.equal(b.conversation.selection().sender.id, "agent-c"); assert.throws(() => b.conversation.guardSend("agent-a"), { message: "reply_target_mismatch" });
  await b.conversation.reply({ to: "agent-a" }, { text: "first" }); assert.equal((await first).response.text, "first");
  await b.conversation.reply({}, { text: "second" }); assert.equal((await second).response.text, "second");
});

test("real Pi ask/reply returns attachments in the tool result and answering held input prevents later injection", async (t) => {
  const f = await setup(t), a = await piSession(f), b = await piSession(f, { config: { busyDelivery: "human-first" } });
  b.gate.hold = true; const run = b.session.prompt("receiver working"); await until(() => b.requests.length === 1);
  a.gate.calls = [{ id: "ask-tool", name: "openspace", arguments: { action: "ask", to: b.runtime.client.info.id, text: "question", messageId: "pi-question" } }];
  const ask = a.session.prompt("consult peer");
  await until(() => b.runtime.receiver.heldCount === 1);
  const pending = await b.tool({ action: "pending" }); assert.equal(pending.details.pending[0].ref.messageId, "pi-question");
  const reply = await b.tool({ action: "reply", text: "answer", attachments: [{ type: "snippet", name: "unicode", text: "答案🙂" }] });
  assert.equal(reply.isError, undefined); await ask;
  const result = a.session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "ask-tool");
  assert.equal(result.isError, false); assert.match(result.content[0].text, /答案🙂/);
  assert.equal(a.requests.length, 2); assert.match(JSON.stringify(a.requests[1].context.messages), /答案🙂/);
  await until(() => b.runtime.receiver.heldCount === 0); b.requests[0].release(); await run;
  assert.equal(b.history().length, 0); assert.equal(a.history().length, 0);
  assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
});

test("Pi busy non-interactive ask receives a valid correlated busy reply without interrupting the run", async (t) => {
  const f = await setup(t), a = await f.actor("a"), b = await piSession(f, { mode: "rpc" });
  b.gate.hold = true; const run = b.session.prompt("busy"); await until(() => b.requests.length === 1);
  const result = await a.conversation.ask(b.runtime.client.info.id, { text: "question" });
  assert.equal(result.status, "answered"); assert.match(result.response.text, /not injected/); assert.ok(result.response.replyTo);
  assert.equal(b.history().length, 0); assert.equal(b.requests.length, 1); b.requests[0].release(); await run;
});

test("Pi send infers the original group without bypassing confirmation, and blocks unrelated targets in the ask turn", async (t) => {
  const f = await setup(t), a = await f.actor("a", ["x", "y"]), c = await f.actor("c", ["x", "y"]);
  let confirmations = 0;
  const b = await piSession(f, { env: { PI_OPENSPACE_WORKGROUPS: "x,y" }, config: { confirmSend: true }, confirm: async () => ++confirmations > 1 });
  b.gate.hold = true;
  const ask = a.conversation.ask(b.runtime.client.info.id, { text: "needs reply", workgroup: "x" });
  await until(() => b.requests.length === 1);
  const wrong = await b.tool({ action: "send", to: "c", workgroup: "x", text: "misdirected" });
  assert.equal(wrong.details.code, "reply_target_mismatch"); assert.equal(c.messages.length, 0);
  const denied = await b.tool({ action: "send", to: "a", text: "inferred" });
  assert.equal(denied.isError, true); assert.equal(denied.details.code, "confirmation_cancelled");
  assert.equal(b.runtime.conversation.pending().length, 1);
  const accepted = await b.tool({ action: "send", to: "a", text: "inferred", messageId: "inferred-id" });
  assert.equal(accepted.isError, undefined); assert.equal(confirmations, 2);
  const result = await ask; assert.equal(result.response.id, "inferred-id"); assert.equal(result.response.workgroup, "x"); assert.ok(result.response.replyTo);
  b.requests[0].release(); await b.session.waitForIdle();
});

test("tracker and broker question storage obey aggregate bounds; tracker expiry never reopens the same pending", (t) => {
  const clock = new FakeClock(), f = fixture(t);
  const stamp = { workgroup: "default", epoch: "epoch" };
  const tracker = new ReplyTracker({ membership: () => stamp, hasMembership: () => true }, 10, clock);
  for (let i = 0; i < 256; i++) assert.equal(tracker.add({ id: String(i), sender: { id: "a" }, workgroup: "default", text: "question" }), true);
  assert.equal(tracker.add({ id: "overflow", sender: { id: "a" }, workgroup: "default", text: "question" }), false);
  assert.equal(tracker.list().length, 256); clock.advance(10); assert.equal(tracker.list().length, 0);
  assert.throws(() => tracker.select({ replyTo: { senderId: "a", workgroup: "default", messageId: "0" } }), { message: "reply_not_pending" });
  const registry = { endpoint: () => "live", isMembershipCurrent: () => true };
  const asks = new AskService(registry, () => "written", f.root, { now: clock.now, timeoutMs: 100 });
  t.after(() => asks.stop());
  const sender = { id: "a", group: "default", epoch: "a", leaseHash: "a" }, receiver = { id: "b", group: "default", epoch: "b", leaseHash: "b" };
  for (let i = 0; i < 5; i++) asks.prepare({ id: String(i), text: "x".repeat(700_000), expectsReply: true }, sender, receiver)();
  assert.throws(() => asks.prepare({ id: "large", text: "x".repeat(700_000), expectsReply: true }, sender, receiver), { message: "ask_capacity" });
  assert.equal(JSON.parse(readFileSync(join(f.root, "pending-asks.json"), "utf8")).asks.length, 5);
  clock.advance(100); asks.prune(); assert.equal(JSON.parse(readFileSync(join(f.root, "pending-asks.json"), "utf8")).asks.length, 0);
});

test("default departure and disposal settle waiters, while an already aborted ask creates no broker edge", async (t) => {
  const f = await setup(t), a = await f.actor("a"), b = await f.actor("b");
  await assert.rejects(a.conversation.ask("b", { text: "pre-aborted", signal: AbortSignal.abort() }), { message: "aborted" });
  assert.deepEqual(f.diagnostics(), []);
  const leaving = a.conversation.ask("b", { text: "default" }); await until(() => b.messages.length === 1);
  await a.client.setWorkgroups(["specific"]); assert.equal((await leaving).code, "workgroup_left"); await a.client.setWorkgroups([]);
  const ending = a.conversation.ask("b", { text: "shutdown" }); await until(() => b.messages.length === 2);
  a.conversation.dispose(); assert.equal((await ending).code, "session_ended"); await until(() => f.diagnostics().length === 0);
  assert.equal(b.events.some((event) => event.type === "control" && event.ref.messageId === b.messages[1].id), false);
});

test("a replay from a replacement runtime preserves a terminal outcome rather than opening a new waiter", async (t) => {
  const f = await setup(t), a = await f.actor("a"), b = await f.actor("b");
  const old = a.conversation.ask("b", { text: "question", messageId: "old" }); await until(() => b.messages.length === 1);
  const replacement = await f.actor("a"); assert.equal((await old).status, "failed");
  const replay = await replacement.conversation.ask("b", { text: "question", messageId: "old" });
  assert.equal(replay.status, "failed"); assert.equal(replay.code, "workgroup_left"); assert.equal(b.messages.length, 1);
});

test("broker restart discards diagnostic edges instead of restoring work", async (t) => {
  const f = await setup(t), a = await f.actor("a"), b = await f.actor("b");
  const ask = a.conversation.ask("b", { text: "non durable" }); await until(() => b.messages.length === 1);
  const ref = messageRef(b.messages[0]); await f.broker.stop(); assert.equal((await ask).status, "failed");
  assert.equal(existsSync(join(f.paths.runtimeDir, "pending-asks.json")), false);
  const next = await startBroker(f.paths); f.cleanup(() => next.stop()); await a.client.connect(); await b.client.connect();
  assert.deepEqual(f.diagnostics(), []);
  assert.equal((await b.messenger.send("a", { text: "old relation", replyTo: ref })).code, "ask_not_pending");
});
