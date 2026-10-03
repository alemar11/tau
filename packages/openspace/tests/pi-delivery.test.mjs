import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { OpenspaceClient } from "../src/client/client.ts";
import { Messenger } from "../src/client/messenger.ts";
import { startBroker } from "../src/broker/server.ts";
import { installOpenspace } from "../extensions/openspace/index.ts";
import { WORKGROUP_ENTRY, restoredWorkgroups, WorkgroupPreferences } from "../extensions/openspace/preferences.ts";
import { fixture, until } from "./fixtures/broker-helpers.mjs";
import { piSession } from "./fixtures/pi-session.mjs";

async function setup(t) {
  const f = fixture(t), broker = await startBroker(f.paths); f.cleanup(() => broker.stop());
  const client = new OpenspaceClient({ socketPath: f.paths.socketPath, session: { id: "sender", cwd: f.root, model: "test", pid: process.pid } });
  const sender = new Messenger(client), events = [];
  sender.subscribe((event) => events.push(event));
  f.cleanup(async () => { sender.dispose(); await client.disconnect(); }); await client.connect();
  return { ...f, sender, events };
}
const sees = (request, text) => JSON.stringify(request.context.messages).includes(text);
const sent = (f, session, text, extra = {}) => f.sender.send(session.runtime.client.info.id, { text, messageId: text, ...extra });
const injected = (f, id) => f.events.some((event) => event.type === "receipt" && event.receipt.ref.messageId === id && event.receipt.status === "injected");

for (const policy of ["always", "replies", "never"]) test(`real Pi idle ${policy}: message and attachments enter context with the correct turn policy`, async (t) => {
  const f = await setup(t), pi = await piSession(f, { config: { inboundTrigger: policy } });
  assert.equal((await sent(f, pi, "idle-peer", { attachments: [{ type: "context", name: "facts", text: "ATTACHMENT_世界" }] })).delivery, "socket_delivered");
  await until(() => injected(f, "idle-peer")); await until(() => pi.history().length === 1);
  assert.equal(pi.history()[0].details.message.id, "idle-peer"); assert.match(pi.history()[0].content, /workgroup "default"/);
  if (policy === "always") await until(() => pi.requests.length === 1); else { assert.equal(pi.requests.length, 0); await pi.session.prompt("human next"); }
  assert.equal(sees(pi.requests[0], "idle-peer"), true); assert.equal(sees(pi.requests[0], "ATTACHMENT_世界"), true);
  assert.deepEqual(pi.errors, []);
});

test("busy never still steers a real TUI run without aborting or duplicating", async (t) => {
  const f = await setup(t), pi = await piSession(f, { config: { inboundTrigger: "never" } }); pi.gate.hold = true;
  const run = pi.session.prompt("human-start"); await until(() => pi.requests.length === 1);
  await sent(f, pi, "peer-steer"); await until(() => injected(f, "peer-steer"));
  assert.equal(pi.requests.length, 1); assert.equal(pi.session.isIdle, false);
  await sent(f, pi, "peer-steer"); pi.requests[0].release(); await until(() => pi.requests.length === 2);
  assert.equal(sees(pi.requests[1], "peer-steer"), true); pi.requests[1].release(); await run;
  assert.equal(pi.history().length, 1); assert.deepEqual(pi.errors, []);
});

test("human-first preserves queued human steer/follow-up priority and releases only one peer per turn", async (t) => {
  const f = await setup(t), pi = await piSession(f, { config: { busyDelivery: "human-first" } }); pi.gate.hold = true;
  const run = pi.session.prompt("start"); await until(() => pi.requests.length === 1);
  await sent(f, pi, "peer-one"); await sent(f, pi, "peer-two");
  // human-first holds peer input until a boundary, so subsequent human input can overtake it.
  await pi.session.steer("human-steer"); await pi.session.followUp("human-followup");
  pi.requests[0].release(); await until(() => pi.requests.length === 2);
  assert.equal(sees(pi.requests[1], "human-steer"), true); assert.equal(sees(pi.requests[1], "peer-one"), false);
  pi.requests[1].release(); await until(() => pi.requests.length === 3);
  assert.equal(sees(pi.requests[2], "human-followup"), true); assert.equal(sees(pi.requests[2], "peer-one"), false);
  pi.requests[2].release(); await until(() => pi.requests.length === 4);
  assert.equal(sees(pi.requests[3], "peer-one"), true); assert.equal(sees(pi.requests[3], "peer-two"), false);
  pi.requests[3].release(); await until(() => pi.requests.length === 5);
  assert.equal(sees(pi.requests[4], "peer-two"), true); pi.requests[4].release(); await run;
  assert.equal(pi.history().length, 2); assert.deepEqual(pi.errors, []);
});

for (const mode of ["print", "json", "rpc"]) test(`busy ${mode} does not interrupt, ask for UI or invent reply correlation`, async (t) => {
  const f = await setup(t), pi = await piSession(f, { mode }); pi.gate.hold = true;
  const run = pi.session.prompt("headless-work"); await until(() => pi.requests.length === 1);
  await sent(f, pi, "busy-peer");
  await until(() => f.events.some((event) => event.type === "receipt" && event.receipt.code === "busy_unavailable"));
  await until(() => f.events.some((event) => event.type === "message"));
  const response = f.events.find((event) => event.type === "message").message;
  assert.equal(response.replyTo, undefined); assert.match(response.text, /busy/);
  assert.equal(pi.history().length, 0); assert.equal(pi.requests.length, 1);
  pi.requests[0].release(); await run; assert.deepEqual(pi.errors, []);
});

for (const outcome of ["success", "error", "abort"]) test(`real manual compaction ${outcome} holds incoming messages until Pi is safe`, async (t) => {
  const f = await setup(t); let entered = false, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pi = await piSession(f, { config: { inboundTrigger: "never" }, extend: (api) => {
    api.on("session_before_compact", async (event) => {
      entered = true; await gate;
      if (outcome === "error") return;
      if (outcome === "abort") return { cancel: true };
      return { compaction: { summary: "summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: 100 } };
    });
  } });
  await pi.session.prompt("seed".repeat(100));
  const compact = pi.session.compact().catch((error) => error); await until(() => entered);
  await sent(f, pi, "during-compaction"); await until(() => pi.runtime.receiver.heldCount === 1);
  assert.equal(pi.history().length, 0); assert.equal(injected(f, "during-compaction"), false);
  pi.gate.fail = outcome === "error";
  release(); const result = await compact; pi.gate.fail = false;
  if (outcome !== "success") assert.ok(result instanceof Error);
  await until(() => injected(f, "during-compaction")); assert.equal(pi.history().length, 1);
  if (outcome === "success") await until(() => pi.runtime.client.info.contextUsage === undefined);
  await pi.session.prompt("after compaction"); assert.equal(sees(pi.requests.at(-1), "during-compaction"), true);
});

test("leaving during real compaction cancels held content immediately and defers preference storage until safe", async (t) => {
  const f = await setup(t); let release, entered = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const pi = await piSession(f, { config: { inboundTrigger: "never" }, extend: (api) => {
    api.on("session_before_compact", async (event) => { entered = true; await gate;
      return { compaction: { summary: "summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: 100 } }; });
  } });
  await pi.session.prompt("seed".repeat(100)); const compact = pi.session.compact(); await until(() => entered);
  await sent(f, pi, "must-not-survive-leave"); await until(() => pi.runtime.receiver.heldCount === 1);
  const mutation = pi.runtime.preferences.mutate(() => ["private"]);
  await until(() => pi.runtime.client.info.workgroups.includes("private"));
  assert.equal(pi.runtime.receiver.heldCount, 0);
  assert.equal(pi.manager.getEntries().some((entry) => entry.customType === WORKGROUP_ENTRY), false);
  release(); await compact; await mutation; await pi.runtime.preferences.mutate(() => []);
  assert.equal(pi.history().length, 0); assert.equal(injected(f, "must-not-survive-leave"), false);
  await pi.session.prompt("later"); assert.equal(sees(pi.requests.at(-1), "must-not-survive-leave"), false);
});

test("held cancel/supersede and leave/rejoin prevent injection; disconnect alone preserves held work", async (t) => {
  const f = await setup(t), pi = await piSession(f, { config: { busyDelivery: "human-first" } }); pi.gate.hold = true;
  const run = pi.session.prompt("start"); await until(() => pi.requests.length === 1);
  await sent(f, pi, "cancel-this"); await sent(f, pi, "replace-this");
  await until(() => pi.runtime.receiver.heldCount === 2);
  await f.sender.cancel({ senderId: "sender", workgroup: "default", messageId: "cancel-this" });
  await sent(f, pi, "replacement", { supersedes: "replace-this" });
  await until(() => pi.runtime.receiver.heldCount === 1);
  await pi.runtime.preferences.mutate(() => ["private"]); await pi.runtime.preferences.mutate(() => []);
  assert.equal(pi.runtime.receiver.heldCount, 0);
  await sent(f, pi, "survives-disconnect"); await until(() => pi.runtime.receiver.heldCount === 1);
  await pi.runtime.client.disconnect(); await pi.runtime.controller.ensureConnected();
  pi.requests[0].release(); await until(() => pi.requests.length === 2);
  assert.equal(sees(pi.requests[1], "survives-disconnect"), true);
  for (const text of ["cancel-this", "replace-this", "replacement"]) assert.equal(sees(pi.requests[1], text), false);
  pi.requests[1].release(); await run; assert.equal(pi.history().length, 1);
});

test("workgroup preferences belong to the Pi identity, survive branch/reload and saved [] overrides changed env", async (t) => {
  const before = { ...process.env }, f = await setup(t);
  const a = await piSession(f, { env: { PI_OPENSPACE_WORKGROUPS: "seed-a" } }), b = await piSession(f, { env: { PI_OPENSPACE_WORKGROUPS: "seed-b" } });
  await a.runtime.preferences.mutate(() => []);
  assert.deepEqual(a.runtime.client.info.workgroups, ["default"]); assert.deepEqual(b.runtime.client.info.workgroups, ["seed-b"]);
  const entry = a.manager.getEntries().find((entry) => entry.customType === WORKGROUP_ENTRY);
  assert.deepEqual(entry.data.specific, []); assert.equal(a.session.messages.some((message) => JSON.stringify(message).includes(WORKGROUP_ENTRY)), false);
  a.manager.resetLeaf(); // Preferences are explicitly session-wide, unlike conversation state.
  a.env.PI_OPENSPACE_WORKGROUPS = "new-env";
  await a.session.reload(); await a.runtime.controller.ensureConnected();
  assert.deepEqual(a.runtime.client.info.workgroups, ["default"]);
  const fork = SessionManager.inMemory(f.root); fork.appendCustomEntry(WORKGROUP_ENTRY, entry.data);
  const c = await piSession(f, { manager: fork, env: { PI_OPENSPACE_WORKGROUPS: "fresh" } });
  assert.deepEqual(c.runtime.client.info.workgroups, ["fresh"]);
  assert.deepEqual(restoredWorkgroups({ sessionManager: a.manager }, ["different"]), []);
  assert.deepEqual(Object.keys(process.env).sort(), Object.keys(before).sort());
  assert.ok(Object.keys(before).every((key) => process.env[key] === before[key]), "environment unchanged");
});

test("real SDK fork/new/resume recreate routing lifetimes and only resume restores the saved preference", async (t) => {
  const f = await setup(t);
  const first = await piSession(f, { manager: SessionManager.create(f.root, `${f.root}/sessions`), cwd: f.root, cleanup: false,
    env: { PI_OPENSPACE_WORKGROUPS: "seed" } });
  let current = first;
  const host = new AgentSessionRuntime(first.session, first.result.services, async (options) => {
    current = await piSession(f, { manager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, cwd: options.cwd, cleanup: false,
      env: { PI_OPENSPACE_WORKGROUPS: "seed" } });
    return current.result;
  });
  f.cleanup(() => host.dispose());
  await first.session.prompt("persist this session");
  await first.runtime.preferences.mutate(() => ["saved"]);
  const file = first.session.sessionFile, oldId = first.runtime.sessionId, oldRuntime = first.runtime;
  await host.fork(first.manager.getLeafId(), { position: "at" });
  assert.notEqual(current.runtime.sessionId, oldId); assert.deepEqual(current.runtime.client.info.workgroups, ["seed"]);
  assert.throws(() => oldRuntime.assertCurrent(), { message: "session_ended" });
  assert.equal(current.manager.getEntries().some((entry) => entry.customType === WORKGROUP_ENTRY), true);
  await current.runtime.preferences.mutate(() => ["fork-only"]);
  await host.newSession(); assert.deepEqual(current.runtime.client.info.workgroups, ["seed"]);
  assert.equal(current.manager.getEntries().some((entry) => entry.customType === WORKGROUP_ENTRY), false);
  await host.switchSession(file);
  assert.equal(current.runtime.sessionId, oldId); assert.deepEqual(current.runtime.client.info.workgroups, ["saved"]);
  assert.deepEqual(current.errors, []);
});

test("failed preference writes report failure but retain authoritative live groups; shutdown after await cannot persist into another session", async (t) => {
  const f = await setup(t), pi = await piSession(f);
  const preferences = new WorkgroupPreferences({ appendEntry() { throw new Error("disk failed"); } }, pi.runtime.client, () => pi.runtime.context, () => pi.runtime.assertCurrent());
  await assert.rejects(preferences.mutate(() => ["changed"]), { message: "preference_save_failed" });
  assert.deepEqual(pi.runtime.client.info.workgroups, ["changed"]);
  let release, entered = false, writes = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const stale = new WorkgroupPreferences({ appendEntry() { writes++; } }, { async mutateWorkgroups() { entered = true; await gate; return { workgroups: ["late"] }; } },
    () => pi.runtime.context, () => pi.runtime.assertCurrent());
  const mutation = stale.mutate(() => ["late"]); await until(() => entered); await pi.close(); release();
  await assert.rejects(mutation, { message: "session_ended" }); assert.equal(writes, 0);
});

test("tool preserves IDs/errors and lifecycle presence preserves concurrent tools and unknown context", async (t) => {
  const f = await setup(t), pi = await piSession(f, { config: { inboundTrigger: "never" } });
  const result = await pi.tool({ action: "send", to: "sender", text: "from tool", messageId: "tool-id" });
  assert.equal(result.isError, undefined); assert.equal(result.details.messageId, "tool-id");
  await until(() => f.events.some((event) => event.type === "message" && event.message.id === "tool-id"));
  assert.equal((await pi.tool({ action: "send", to: "missing", text: "no" })).isError, true);
  pi.api.setSessionName("Named Pi"); await until(() => pi.runtime.client.info.name === "Named Pi");
  const emit = (type, fields) => pi.session.extensionRunner.emit({ type, ...fields });
  await emit("tool_execution_start", { toolCallId: "one", toolName: "read", args: {} });
  await emit("tool_execution_start", { toolCallId: "two", toolName: "write", args: {} });
  await emit("tool_execution_end", { toolCallId: "two", toolName: "write", result: {}, isError: false });
  await until(() => pi.runtime.client.info.status?.toolName === "read");
  await emit("tool_execution_end", { toolCallId: "one", toolName: "read", result: {}, isError: false });
  await until(() => pi.runtime.client.info.status.state === "idle");
  const previous = pi.runtime.client.info;
  assert.equal((await pi.tool({ action: "status", note: "🙂".repeat(257) })).isError, true);
  assert.deepEqual(pi.runtime.client.info.status, previous.status); assert.equal(pi.runtime.client.info.contextUsage.tokens, 0);
});

test("confirmation cannot silently rebind after leave/rejoin and is unavailable in print mode", async (t) => {
  const f = await setup(t); let approve, entered = false;
  const pi = await piSession(f, { config: { confirmSend: true }, confirm: async () => { entered = true; return new Promise((resolve) => { approve = resolve; }); } });
  const sending = pi.tool({ action: "send", to: "sender", text: "stale approval", messageId: "stale-approval" }); await until(() => entered);
  await pi.runtime.preferences.mutate(() => ["private"]); await pi.runtime.preferences.mutate(() => []); approve(true);
  const result = await sending; assert.equal(result.isError, true); assert.equal(result.details.code, "workgroup_left");
  assert.equal(f.events.some((event) => event.type === "message"), false);
  const headless = await piSession(f, { mode: "print", config: { confirmSend: true } });
  const blocked = await headless.tool({ action: "send", to: "sender", text: "no dialog" });
  assert.equal(blocked.isError, true); assert.equal(blocked.details.error, "confirmation_unavailable");
});

test("takeover halts the Pi controller and warns without ending Pi or reclaiming on tool calls", async (t) => {
  const f = await setup(t), a = await piSession(f, { env: { PI_OPENSPACE_STABLE_ID: "shared-id" } });
  const b = await piSession(f, { env: { PI_OPENSPACE_STABLE_ID: "shared-id", PI_OPENSPACE_WORKGROUPS: "elsewhere" } });
  await until(() => a.runtime.client.state === "revoked");
  assert.equal(a.runtime.controller.isRunning, false); assert.ok(a.notifications.some((item) => item.text.includes("endpoint_replaced")));
  assert.equal((await a.tool({ action: "list" })).isError, true);
  assert.equal(b.runtime.client.isConnected, true); await a.session.prompt("Pi still works"); assert.equal(a.requests.length, 1);
});

test("shutdown while startup is yielding cannot create a late runtime", async () => {
  const handlers = new Map(); let started = false;
  installOpenspace({ events: { on: () => () => {}, emit() {} }, on: (event, fn) => handlers.set(event, fn), registerTool() {}, registerMessageRenderer() {}, registerCommand() {} },
    { env: {}, onRuntime() { started = true; } });
  const starting = handlers.get("session_start")({}, {});
  await handlers.get("session_shutdown")({ reason: "quit" }); await starting;
  assert.equal(started, false);
});

test("shutdown during confirmation and held delivery prevents all old-runtime effects", async (t) => {
  const f = await setup(t); let approve, entered = false;
  const pi = await piSession(f, { config: { confirmSend: true, busyDelivery: "human-first" }, confirm: async () => { entered = true; return new Promise((resolve) => { approve = resolve; }); } });
  const sending = pi.tool({ action: "send", to: "sender", text: "too late" }); await until(() => entered);
  await pi.close(); approve(true);
  assert.equal((await sending).isError, true); assert.equal(f.events.some((event) => event.type === "message"), false);
});
