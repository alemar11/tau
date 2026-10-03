import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AgentSessionRuntime, createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { OPENSPACE_OUTBOX_REQUEST_EVENT as REQUEST, OPENSPACE_OUTBOX_RESULT_EVENT as RESULT, OPENSPACE_SESSION_IDENTITY_EVENT as IDENTITY } from "openspace/extension-api";
import { startBroker } from "../src/broker/server.ts";
import { OpenspaceClient } from "../src/client/client.ts";
import { Messenger } from "../src/client/messenger.ts";
import { outboxRequest } from "../src/protocol/outbox.ts";
import { MAX_FRAME_BYTES } from "../src/protocol/framing.ts";
import { fixture, until } from "./fixtures/broker-helpers.mjs";
import { piSession as pi } from "./fixtures/pi-session.mjs";
import { installOpenspace } from "../extensions/openspace/index.ts";
import example from "../examples/outbox.ts";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function setup(t) { const f = fixture(t), broker = await startBroker(f.paths); f.cleanup(() => broker.stop()); return { ...f, broker }; }
async function actor(f, id, groups = [], name) {
  const client = new OpenspaceClient({ socketPath: f.paths.socketPath, session: { id, cwd: f.root, model: "fixture", pid: process.pid, ...(name ? { name } : {}) }, workgroups: groups });
  const messenger = new Messenger(client), received = []; messenger.subscribe((event) => { if (event.type === "message") received.push(event.message); });
  f.cleanup(async () => { messenger.dispose(); await client.disconnect(); }); await client.connect(); return { client, messenger, received };
}
function watch(p) {
  const results = []; p.api.events.on(RESULT, (result) => { results.push(result); });
  return { results, emit(request) { p.api.events.emit(REQUEST, request); }, async send(request) {
    const before = results.length; this.emit(request); await until(() => results.length > before); return results.at(-1);
  } };
}
const request = (to, fields = {}) => ({ version: 1, requestId: randomUUID(), extensionId: "example", extensionName: "Example", to, message: "nota originale 世界", ...fields });
const messages = (p) => p.session.messages.filter((message) => message.role === "custom" && message.customType === "openspace_message");

test("real Pi outbox preserves sender, structured attribution, exact body and sender trace without running the sender model", async (t) => {
  const f = await setup(t), sender = await pi(f), receiver = await pi(f, { config: { inboundTrigger: "never" } }), outbox = watch(sender);
  const input = request(receiver.runtime.client.info.id), result = await outbox.send(input);
  assert.equal(result.status, "sent"); assert.equal(result.delivery, "socket_delivered"); assert.equal(result.outcomeKnown, true);
  await until(() => messages(receiver).length === 1);
  const delivered = messages(receiver)[0].details.message;
  assert.equal(delivered.sender.id, sender.runtime.client.info.id); assert.equal(delivered.text, input.message); assert.equal(delivered.id, result.messageId);
  assert.deepEqual(delivered.provenance, { kind: "extension_outbox", extensionId: "example", extensionName: "Example" });
  assert.equal(delivered.replyTo, undefined); assert.equal(delivered.expectsReply, undefined); assert.equal(delivered.attachments, undefined);
  const trace = sender.manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "openspace_outbox_result");
  assert.equal(trace.data.request.requestId, input.requestId); assert.equal(trace.data.senderId, delivered.sender.id); assert.equal(trace.data.result.status, "sent");
  assert.deepEqual(trace.data.provenance, delivered.provenance); assert.equal(sender.requests.length, 0); assert.equal(receiver.requests.length, 0);
  assert.equal(messages(sender).length, 0); assert.deepEqual(sender.errors, []); assert.ok(Object.isFrozen(result));
});

test("confirmation identifies extension, full recipient, workgroup and text; refusal and missing/broken UI never send", async (t) => {
  const f = await setup(t), receiver = await actor(f, "recipient");
  for (const options of [{ confirm: async (_title, text) => { assert.match(text, /Example \(example\).*\nA recipient \[recipient\] · default\n\nnota originale 世界/); return false; }, code: "confirmation_cancelled", status: "rejected" },
    { mode: "json", code: "confirmation_unavailable", status: "blocked" },
    { mode: "print", code: "confirmation_unavailable", status: "blocked" },
    { confirm: async () => { throw new Error("frontend unavailable"); }, code: "confirmation_unavailable", status: "blocked" },
    { confirm: async () => "not a boolean", code: "confirmation_cancelled", status: "rejected" }]) {
    const sender = await pi(f, { ...options, config: { confirmSend: true } }), result = await watch(sender).send(request("recipient"));
    assert.equal(result.status, options.status); assert.equal(result.code, options.code); assert.equal(receiver.received.length, 0); await sender.close();
  }
  const rpc = await pi(f, { mode: "rpc", config: { confirmSend: true }, confirm: async () => true });
  assert.equal((await watch(rpc).send(request("recipient"))).status, "sent"); await until(() => receiver.received.length === 1);
});

test("runtime-wide duplicate IDs preserve the pending original across producers, and bounded budgets never forget IDs", async (t) => {
  const f = await setup(t), receiver = await actor(f, "recipient"), gate = deferred(); let dialogs = 0;
  const sender = await pi(f, { config: { confirmSend: true }, confirm: () => { dialogs++; return gate.promise; }, outbox: { limits: { pending: 1, ids: 3 } } }), outbox = watch(sender);
  const original = request("recipient"); outbox.emit(original); await until(() => dialogs === 1);
  assert.equal((await outbox.send({ ...original, extensionId: "second-producer" })).code, "duplicate_request");
  const overflow = request("recipient"); assert.equal((await outbox.send(overflow)).code, "outbox_pending_capacity");
  assert.equal((await outbox.send(overflow)).code, "duplicate_request"); assert.equal(receiver.received.length, 0);
  gate.resolve(true); await until(() => outbox.results.some((result) => result.status === "sent")); await until(() => receiver.received.length === 1);
  assert.deepEqual(outbox.results.filter((result) => result.requestId === original.requestId).map((result) => result.status), ["rejected", "sent"]);
  assert.equal((await outbox.send(original)).code, "duplicate_request");
  assert.equal((await outbox.send(request("recipient"))).status, "sent");
  assert.equal((await outbox.send(request("recipient"))).code, "outbox_id_capacity");
  assert.equal((await outbox.send(original)).code, "duplicate_request"); await until(() => receiver.received.length === 2); assert.equal(dialogs, 2);
});

test("aggregate pending bytes are bounded and request snapshots cannot be edited during confirmation", async (t) => {
  const f = await setup(t), receiver = await actor(f, "recipient"), gate = deferred(); let dialogs = 0;
  const sender = await pi(f, { config: { confirmSend: true }, outbox: { limits: { bytes: 500 } }, confirm: () => { dialogs++; return gate.promise; } }), outbox = watch(sender);
  const input = request("recipient", { message: "x".repeat(200) }), original = structuredClone(input); outbox.emit(input); input.message = "edited"; input.to = "elsewhere";
  await until(() => dialogs === 1); assert.equal((await outbox.send(request("recipient", { message: "x".repeat(200) }))).code, "outbox_pending_capacity");
  gate.resolve(true); await until(() => receiver.received.length === 1); assert.equal(receiver.received[0].text, original.message);
  assert.equal((await outbox.send(request("recipient"))).status, "sent");
});

test("routing is live-only, exact/name/prefix and one fixed shared group, never implicit additional memberships", async (t) => {
  const f = await setup(t), sender = await pi(f, { env: { PI_OPENSPACE_WORKGROUPS: "x,y" } }), outbox = watch(sender);
  const target = await actor(f, "target-unique", ["x", "y"], "Worker"), hidden = await actor(f, "hidden", ["z"]);
  for (const [to, fields, code] of [["missing", {}, "target_not_found"], [hidden.client.info.id, {}, "target_not_found"],
    [sender.runtime.client.info.id, {}, "self_target"], ["Worker", {}, "workgroup_ambiguous"], ["Worker", { workgroup: "z" }, "workgroup_not_shared"]]) {
    const result = await outbox.send(request(to, fields)); assert.equal(result.status, "failed"); assert.equal(result.code, code);
  }
  assert.equal((await outbox.send(request("worker", { workgroup: "y" }))).workgroup, "y");
  await target.client.setWorkgroups(["x"]); assert.equal((await outbox.send(request("target-u"))).workgroup, "x");
  const duplicate = await actor(f, "other-id", ["x"], "Worker"); assert.equal((await outbox.send(request("Worker"))).code, "target_ambiguous");
  await duplicate.client.disconnect(); await until(async () => !(await sender.runtime.client.listSessions()).some((peer) => peer.id === "other-id"));
  assert.equal((await outbox.send(request("Worker"))).status, "sent");
  assert.equal((await outbox.send(request("other-id"))).code, "target_not_found");
  await until(() => target.received.length === 3); assert.deepEqual(target.received.map((message) => message.workgroup), ["y", "x", "x"]);
  assert.deepEqual(sender.runtime.client.info.workgroups, ["x", "y"]); assert.equal(hidden.received.length, 0);
});

test("leaving/rejoining the selected group during confirmation terminates once and cannot fall back to another group", async (t) => {
  const f = await setup(t), target = await actor(f, "target", ["x", "y"]), gate = deferred(); let opened = false;
  const sender = await pi(f, { env: { PI_OPENSPACE_WORKGROUPS: "x,y" }, config: { confirmSend: true }, confirm: () => { opened = true; return gate.promise; } }), outbox = watch(sender);
  outbox.emit(request("target", { workgroup: "x" })); await until(() => opened);
  await sender.runtime.client.setWorkgroups(["y"]); await until(() => outbox.results.length === 1);
  assert.equal(outbox.results[0].code, "workgroup_left"); await sender.runtime.client.setWorkgroups(["x", "y"]);
  gate.resolve(true); await delay(30); assert.equal(outbox.results.length, 1); assert.equal(target.received.length, 0);
  assert.equal(sender.requests.length, 0);
});

test("leaving during live lookup fences the returned selection even after rejoin", async (t) => {
  const f = await setup(t), target = await actor(f, "target", ["x"]), sender = await pi(f, { env: { PI_OPENSPACE_WORKGROUPS: "x,y" } }), outbox = watch(sender), gate = deferred(); let looked;
  const wireRequest = sender.runtime.client.request.bind(sender.runtime.client);
  sender.runtime.client.request = async (type, ...args) => { const response = await wireRequest(type, ...args); if (type === "resolve") { looked = response; await gate.promise; } return response; };
  outbox.emit(request("target")); await until(() => looked);
  await sender.runtime.client.setWorkgroups(["y"]); await sender.runtime.client.setWorkgroups(["x", "y"]); gate.resolve();
  await until(() => outbox.results.length === 1); assert.equal(outbox.results[0].code, "workgroup_left"); assert.equal(target.received.length, 0); assert.equal(sender.runtime.client.isConnected, true);
});

test("a delayed result cannot retarget a previously resolved name after another session assumes that name", async (t) => {
  const f = await setup(t), first = await actor(f, "first", [], "Worker"), second = await actor(f, "second", [], "Other"), gate = deferred(); let opened = false;
  const sender = await pi(f, { config: { confirmSend: true }, confirm: () => { opened = true; return gate.promise; } }), outbox = watch(sender);
  outbox.emit(request("Worker")); await until(() => opened); await first.client.updatePresence({ name: "Old" }); await second.client.updatePresence({ name: "Worker" });
  gate.resolve(true); await until(() => outbox.results.length === 1); assert.equal(outbox.results[0].to, "first");
  await until(() => first.received.length === 1); assert.equal(second.received.length, 0);
});

test("shutdown and reload close suspended confirmation once, ignore late consent, and reset the ID budget only in the new runtime", async (t) => {
  const f = await setup(t), target = await actor(f, "target"), gate = deferred(); let opened = 0;
  const sender = await pi(f, { config: { confirmSend: true }, confirm: () => { opened++; return gate.promise; } }), old = sender.runtime, outbox = watch(sender), input = request("target");
  outbox.emit(input); await until(() => opened === 1); await sender.session.reload(); await sender.runtime.controller.ensureConnected();
  assert.notEqual(sender.runtime, old); assert.equal(outbox.results.length, 1); assert.equal(outbox.results[0].code, "session_ended");
  gate.resolve(true); await delay(30); assert.equal(target.received.length, 0); assert.equal(outbox.results.length, 1);
  const next = watch(sender); assert.equal((await next.send(input)).status, "sent"); await until(() => target.received.length === 1);
  const anotherGate = deferred(); sender.runtime.context.ui.confirm = () => anotherGate.promise;
  next.emit(request("target")); await delay(20); await sender.close(); assert.equal(next.results.at(-1).code, "session_ended");
  anotherGate.resolve(true); await delay(30); assert.equal(target.received.length, 1); assert.deepEqual(sender.errors, []);
});

test("disconnect and takeover terminate pending consent without replay when the connection returns", async (t) => {
  const f = await setup(t), target = await actor(f, "target");
  for (const takeover of [false, true]) {
    const gate = deferred(); let opened = false;
    const sender = await pi(f, { config: { confirmSend: true }, confirm: () => { opened = true; return gate.promise; } }), outbox = watch(sender);
    outbox.emit(request("target")); await until(() => opened);
    if (takeover) await actor(f, sender.runtime.client.info.id); else await sender.runtime.client.disconnect();
    await until(() => outbox.results.length === 1); assert.equal(outbox.results[0].status, "failed");
    gate.resolve(true); await delay(30); assert.equal(outbox.results.length, 1); assert.equal(target.received.length, 0); await sender.close();
  }
});

test("shutdown during a send is explicitly uncertain, never a second terminal event or a late trace into a new session", async (t) => {
  const f = await setup(t), target = await actor(f, "target"), sender = await pi(f), outbox = watch(sender), gate = deferred(); let delivered;
  const send = sender.runtime.messenger.sendResolved.bind(sender.runtime.messenger);
  sender.runtime.messenger.sendResolved = async (...args) => { delivered = await send(...args); await gate.promise; return delivered; };
  outbox.emit(request("target")); await until(() => delivered); await sender.close();
  assert.equal(outbox.results.length, 1); assert.equal(outbox.results[0].code, "session_ended"); assert.equal(outbox.results[0].outcomeKnown, false);
  gate.resolve(); await delay(30); assert.equal(outbox.results.length, 1); assert.equal(target.received.length, 1);
  assert.equal(sender.manager.getEntries().filter((entry) => entry.customType === "openspace_outbox_result").length, 0);
});

test("ordinary broker restart settles old requests but allows new IDs on the recovered runtime", async (t) => {
  const f = await setup(t), target = await actor(f, "target"), gate = deferred(); let opened = false;
  const sender = await pi(f, { config: { confirmSend: true }, confirm: () => { opened = true; return gate.promise; } }), outbox = watch(sender), input = request("target");
  outbox.emit(input); await until(() => opened); await f.broker.stop(); await until(() => outbox.results.length === 1);
  const next = await startBroker(f.paths); f.cleanup(() => next.stop());
  await target.client.connect(); await sender.runtime.controller.ensureConnected(); gate.resolve(true); await delay(30);
  assert.equal(outbox.results.length, 1); assert.equal(outbox.results[0].status, "failed"); assert.equal(target.received.length, 0);
  assert.equal((await outbox.send(input)).code, "duplicate_request"); assert.equal((await outbox.send(request("target"))).status, "sent");
});

test("real native session replacement never transfers consent or preferences through a reused routing claim", async (t) => {
  const f = await setup(t), target = await actor(f, "target", ["saved"]), gate = deferred(); let opened = false;
  const settings = { cleanup: false, cwd: f.root, config: { confirmSend: true }, confirm: () => { opened = true; return gate.promise; },
    extend(api) { api.events.on(IDENTITY, (event) => event.claim("session-owner")); } };
  const first = await pi(f, settings); let current = first;
  const host = new AgentSessionRuntime(first.session, first.result.services, async (options) => {
    current = await pi(f, { ...settings, manager: options.sessionManager, sessionStartEvent: options.sessionStartEvent }); return current.result;
  }); f.cleanup(() => host.dispose());
  await first.runtime.preferences.mutate(() => ["saved"]); const outbox = watch(first); outbox.emit(request("target")); await until(() => opened);
  await host.newSession(); assert.notEqual(current.runtime.sessionId, first.runtime.sessionId); assert.equal(current.runtime.client.info.id, "session-owner");
  assert.deepEqual(current.runtime.client.info.workgroups, ["default"]); assert.equal(outbox.results.length, 1); assert.equal(outbox.results[0].code, "session_ended");
  gate.resolve(true); await delay(30); assert.equal(target.received.length, 0); assert.equal(current.manager.getEntries().some((entry) => entry.customType === "openspace_outbox_result"), false);
});

test("factory/disabled requests get explicit unavailable results and quit removes the listener without starting resources", async (t) => {
  const f = fixture(t), events = createEventBus(), handlers = new Map(), results = [];
  const api = { events, on(name, handler) { handlers.set(name, handler); }, registerTool() {}, registerCommand() {}, registerMessageRenderer() {} };
  installOpenspace(api, { env: f.env, config: { enabled: false } }); events.on(RESULT, (result) => results.push(result));
  events.emit(REQUEST, request("peer")); assert.equal(results[0].code, "openspace_unavailable");
  await handlers.get("session_start")({}, {}); events.emit(REQUEST, request("peer")); assert.equal(results[1].code, "openspace_unavailable");
  await handlers.get("session_shutdown")({ reason: "quit" }); events.emit(REQUEST, request("peer")); assert.equal(results.length, 2);
});

test("shipped example subscribes before emission, uses unique IDs and reports transport results without model calls", async (t) => {
  const f = await setup(t), target = await actor(f, "target"), sender = await pi(f, { beforeFactories: [example] });
  const command = sender.session.extensionRunner.getRegisteredCommands().find((entry) => entry.name === "openspace-example-send");
  assert.ok(command); await command.handler("target example text", sender.runtime.context);
  await until(() => target.received.length === 1); assert.equal(target.received[0].provenance.extensionId, "openspace-example");
  assert.ok(sender.notifications.some((notice) => notice.text.includes("sent"))); assert.equal(sender.requests.length, 0);
});

test("outbox remains notify-only even with a reply pending in the Pi runtime", async (t) => {
  const f = await setup(t), sender = await pi(f, { config: { inboundTrigger: "never" } }), target = await actor(f, "asker"), outbox = watch(sender);
  await target.messenger.send(sender.runtime.client.info.id, { text: "question", expectsReply: true }); await until(() => sender.runtime.conversation.tracker.list().length === 1);
  assert.equal((await outbox.send(request("asker"))).status, "sent"); await until(() => target.received.length === 1);
  assert.equal(target.received[0].replyTo, undefined); assert.equal(sender.runtime.conversation.tracker.list().length, 1);
});

test("schema rejects authority overrides, unsupported features, invalid IDs and byte overflow without executing accessors", async (t) => {
  const f = await setup(t), target = await actor(f, "target"), sender = await pi(f), outbox = watch(sender);
  for (const fields of [{ senderId: "forged" }, { attachments: [] }, { expectsReply: true }, { cwd: "/tmp" }, { provenance: { kind: "local" } }, { version: 2 }, { message: "" }, { workgroup: " x " }, { extensionId: "x".repeat(129) }, { extensionName: "é".repeat(129) }]) {
    assert.equal((await outbox.send(request("target", fields))).code, "invalid_outbox_request");
  }
  const value = request("target"); let executed = false;
  Object.defineProperty(value, "message", { enumerable: true, get() { executed = true; throw new Error("accessor"); } });
  assert.equal((await outbox.send(value)).code, "invalid_outbox_request"); assert.equal(executed, false);
  const base = request("target", { message: "x" }), bytes = Buffer.byteLength(JSON.stringify(base));
  const exact = { ...base, message: "x".repeat(MAX_FRAME_BYTES - bytes + 1) }; assert.equal(outboxRequest(exact).bytes, MAX_FRAME_BYTES);
  assert.throws(() => outboxRequest({ ...exact, message: `${exact.message}x` }), /invalid_outbox_request/);
  assert.throws(() => outboxRequest(request("target", { requestId: "control\n" })), /invalid_outbox_request/);
  assert.equal(target.received.length, 0); assert.equal((await outbox.send(request("target", { workgroup: undefined }))).status, "sent");
});

test("identity claims are synchronous, first valid wins ahead of env/config, and never rename the native Pi session", async (t) => {
  const f = await setup(t), inherited = process.env.PI_OPENSPACE_STABLE_ID;
  const cases = [
    { claim: true, env: "env-a", config: "config-a", expected: "claimed" },
    { env: "env-b", config: "config-b", expected: "env-b" },
    { config: "config-c", expected: "config-c" },
    { late: true }, {},
  ];
  for (const [index, scenario] of cases.entries()) {
    const manager = SessionManager.inMemory(f.root); manager.appendSessionInfo(`original-${index}`);
    const attempts = []; let late;
    const sender = await pi(f, { manager, env: { PI_OPENSPACE_STABLE_ID: scenario.env }, config: { stableId: scenario.config }, extend(api) {
      api.events.on(IDENTITY, (event) => {
        assert.equal(event.version, 1); assert.equal(Object.isFrozen(event), true);
        if (scenario.claim) { attempts.push(event.claim(" "), event.claim("claimed"), event.claim("later")); }
        late = event.claim;
        if (scenario.late) return Promise.resolve().then(() => { attempts.push(event.claim("async-ignored")); });
      });
    } });
    assert.equal(sender.runtime.client.info.id, scenario.expected ?? manager.getSessionId()); assert.equal(sender.runtime.client.info.name, `original-${index}`);
    assert.equal(sender.runtime.sessionId, manager.getSessionId()); assert.equal(late("too-late"), false);
    if (scenario.claim) assert.deepEqual(attempts, [false, true, false]); if (scenario.late) assert.deepEqual(attempts, [false]);
    await sender.close();
  }
  assert.equal(process.env.PI_OPENSPACE_STABLE_ID, inherited);
});

test("session-local identity buses work in both factory orders; two in-process sessions and their preferences stay independent", async (t) => {
  const f = await setup(t), before = (api) => api.events.on(IDENTITY, (event) => event.claim("before-owner")), after = (api) => api.events.on(IDENTITY, (event) => event.claim("after-owner"));
  const a = await pi(f, { beforeFactories: [before] }), b = await pi(f, { factories: [after] });
  assert.equal(a.runtime.client.info.id, "before-owner"); assert.equal(b.runtime.client.info.id, "after-owner"); assert.notEqual(a.runtime.sessionId, b.runtime.sessionId);
  await a.runtime.preferences.mutate(() => ["saved"]); assert.deepEqual(a.runtime.client.info.workgroups, ["saved"]); assert.deepEqual(b.runtime.client.info.workgroups, ["default"]);
  await a.session.reload(); await a.runtime.controller.ensureConnected(); assert.equal(a.runtime.client.info.id, "before-owner"); assert.deepEqual(a.runtime.client.info.workgroups, ["saved"]);
  await b.close(); assert.equal(a.runtime.client.isConnected, true); await a.close(); assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
});
