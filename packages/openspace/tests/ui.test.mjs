import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { KeybindingsManager, TUI_KEYBINDINGS, getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { AgentSessionRuntime, FooterComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { OpenspaceClient } from "../src/client/client.ts";
import { Messenger } from "../src/client/messenger.ts";
import { startBroker } from "../src/broker/server.ts";
import { Picker, Compose } from "../extensions/openspace/ui/overlay.ts";
import { RenderBlock, renderMessage, renderTool, peerLabel, peerDetail } from "../extensions/openspace/ui/render.ts";
import { WORKGROUP_ENTRY } from "../extensions/openspace/preferences.ts";
import { fixture, until } from "./fixtures/broker-helpers.mjs";
import { piSession } from "./fixtures/pi-session.mjs";

function screen() {
  let color = 33, renders = 0;
  const theme = { fg: (_role, text) => `\x1b[${color}m${text}\x1b[0m` };
  const tui = { terminal: { rows: 30, columns: 80 }, requestRender: () => renders++ };
  return { theme, tui, keys: getKeybindings(), signal: new AbortController().signal, recolor: () => { color = 36; }, get renders() { return renders; } };
}
function dialogs() {
  const display = screen(), opened = [], plans = [];
  return { ...display, opened, plans, ui: { custom: (factory, options) => new Promise((done, reject) => {
    assert.equal(options.overlay, true);
    const component = factory(display.tui, display.theme, display.keys, (value) => { component.dispose(); done(value); });
    opened.push(component); component.render(80);
    Promise.resolve().then(() => plans.shift()?.(component)).catch(reject);
  }) } };
}
async function setup(t) { const f = fixture(t), broker = await startBroker(f.paths); f.cleanup(() => broker.stop()); return { ...f, broker }; }
async function peer(f, id, groups = [], name = "Stesso nome") {
  const client = new OpenspaceClient({ socketPath: f.paths.socketPath, session: { id, name, cwd: f.root, model: "fixture", pid: process.pid }, workgroups: groups });
  const messenger = new Messenger(client), events = []; messenger.subscribe((event) => events.push(event));
  f.cleanup(async () => { messenger.dispose(); await client.disconnect(); }); await client.connect(); return { client, messenger, events };
}
const command = (pi, text) => pi.session.prompt(text);
const enter = (component) => component.handleInput("\r");
const sent = (text) => ({ messageId: text, workgroup: "default", delivery: "socket_delivered", outcomeKnown: true, retryable: false });

test("roster keeps duplicate names distinct, chooses an explicit group, sends Unicode to the selected ID and leaves tool schema/loadout alone", async (t) => {
  const f = await setup(t), one = await peer(f, "abcdefgh-one", ["a", "b"]), two = await peer(f, "abcdefgh-two", ["a", "b"]), ui = dialogs();
  const pi = await piSession(f, { env: { PI_OPENSPACE_WORKGROUPS: "a,b" }, config: { confirmSend: true }, ui: ui.ui });
  const before = JSON.stringify(pi.session.agent.state.tools.map(({ name, parameters }) => ({ name, parameters })));
  ui.plans.push((picker) => { const row = picker.render(80).join("\n"); assert.match(row, /abcdefgh-o/); assert.match(row, /abcdefgh-t/); picker.handleInput("\x1b[B"); enter(picker); },
    (picker) => { picker.handleInput("\x1b[B"); enter(picker); }, (compose) => { compose.handleInput("\x1b[200~Ciao 世界 👩‍💻\x1b[201~"); enter(compose); });
  await command(pi, "/openspace"); await until(() => two.events.some((event) => event.type === "message"));
  const message = two.events.find((event) => event.type === "message").message;
  assert.equal(message.workgroup, "b"); assert.equal(message.recipientId, "abcdefgh-two"); assert.equal(message.text, "Ciao 世界 👩‍💻");
  assert.equal(one.events.some((event) => event.type === "message"), false); assert.equal(pi.requests.length, 0);
  assert.equal(JSON.stringify(pi.session.agent.state.tools.map(({ name, parameters }) => ({ name, parameters }))), before);
  assert.ok(pi.notifications.some(({ text }) => /socket \(non completamento\)/.test(text))); assert.deepEqual(pi.errors, []);
});

test("disconnect after selection queues for the same ID, never another peer with the same name", async (t) => {
  const f = await setup(t), one = await peer(f, "one"), two = await peer(f, "two"), ui = dialogs(), pi = await piSession(f, { ui: ui.ui });
  ui.plans.push(enter, async (compose) => { await one.client.disconnect(); compose.handleInput("offline draft"); enter(compose); });
  await command(pi, "/openspace"); assert.ok(pi.notifications.some(({ text }) => /mailbox RAM/.test(text)));
  assert.equal(two.events.some((event) => event.type === "message"), false);
  await one.client.connect(); await until(() => one.events.some((event) => event.type === "message"));
  assert.equal(one.events.find((event) => event.type === "message").message.text, "offline draft");
});

test("leave/rejoin while choosing or composing invalidates the original selection without changing group", async (t) => {
  const f = await setup(t), target = await peer(f, "target", ["a", "b"]), ui = dialogs();
  const pi = await piSession(f, { env: { PI_OPENSPACE_WORKGROUPS: "a,b" }, ui: ui.ui });
  ui.plans.push(async (picker) => { await pi.runtime.preferences.mutate(() => ["b"]); await pi.runtime.preferences.mutate(() => ["a", "b"]); enter(picker); }, enter);
  await command(pi, "/openspace"); assert.equal(ui.opened.length, 2); assert.ok(pi.notifications.some(({ text }) => /workgroup_left/.test(text)));
  ui.plans.push(enter, enter, async (compose) => {
    await pi.runtime.preferences.mutate(() => ["b"]); await pi.runtime.preferences.mutate(() => ["a", "b"]);
    compose.handleInput("must not migrate"); enter(compose); await until(() => /workgroup_left/.test(compose.render(200).join("\n"))); compose.handleInput("\x1b");
  });
  await command(pi, "/openspace"); assert.equal(target.events.some((event) => event.type === "message"), false);
});

test("a stale roster with no remaining common group reports an error rather than silently dismissing compose", async (t) => {
  const f = await setup(t), target = await peer(f, "target"), ui = dialogs(), pi = await piSession(f, { ui: ui.ui });
  const list = pi.runtime.client.listSessions.bind(pi.runtime.client);
  pi.runtime.client.listSessions = async (...args) => { pi.runtime.client.listSessions = list; const snapshot = await list(...args); await pi.runtime.preferences.mutate(() => ["elsewhere"]); return snapshot; };
  ui.plans.push(enter); await command(pi, "/openspace");
  assert.match(pi.notifications.at(-1).text, /workgroup_not_shared/); assert.equal(pi.notifications.at(-1).kind, "error");
  assert.equal(ui.opened.length, 1); assert.equal(target.events.some((event) => event.type === "message"), false);
});

test("existing components reflow from one column through wide, sanitize peer controls and update theme without changing model data", () => {
  const view = screen(), record = { id: "abcdefgh-一", name: "👩‍💻 世界", workgroups: ["review"], cwd: "/a\n世界", model: "model", status: { state: "tool", toolName: "read", note: "\x1b]52;secret\x07" }, contextUsage: { percent: 42 } };
  const copy = structuredClone(record);
  const picker = new Picker({ ...view, title: "Peers 👩‍💻", subtitle: peerDetail(record), items: [{ value: record.id, label: peerLabel(record, [record]), description: peerDetail(record) }], done: () => {} });
  const compose = new Compose({ ...view, title: "Compose 世界", send: async () => sent("id"), done: () => {} }); compose.focused = true; compose.editor.setText("👩‍💻 CJK 世界\nsecond line");
  const block = new RenderBlock("👩‍💻 Title", "raw \x1b]52;secret\x07\n世界", view.theme);
  for (const component of [picker, compose, block]) {
    for (const width of [1, 2, 3, 7, 20, 80, 160, 4, 80]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
    assert.match(component.render(80).join("\n"), /\x1b\[33m/);
  }
  view.recolor(); view.tui.terminal.rows = 18;
  for (const component of [picker, compose, block]) { component.invalidate(); assert.match(component.render(80).join("\n"), /\x1b\[36m/); component.dispose?.(); }
  assert.deepEqual(record, copy); assert.doesNotMatch(block.render(80).join("\n"), /\x1b\]52/);
});

test("Editor handles bracketed paste, grapheme backspace, Kitty input and focus; manual retry preserves unknown IDs and draft", async () => {
  const view = screen(), calls = []; let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const compose = new Compose({ ...view, title: "Compose", send: async (text, id) => { calls.push({ text, id }); return calls.length === 1 ? { ...sent(id), delivery: "unknown", outcomeKnown: false } : sent(id); }, done: finish });
  compose.focused = true; assert.equal(compose.editor.focused, true); compose.render(80);
  compose.handleInput("\x1b[200~世界👩‍💻\x1b[201~"); compose.handleInput("\x7f"); assert.equal(compose.editor.getText(), "世界");
  compose.handleInput("\x1b[97u"); assert.equal(compose.editor.getText(), "世界a");
  enter(compose); await until(() => /Esito incerto/.test(compose.render(100).join("\n"))); assert.equal(compose.editor.getText(), "世界a");
  enter(compose); await done; assert.equal(calls.length, 2); assert.equal(calls[0].id, calls[1].id); assert.equal(calls[0].text, calls[1].text);
});

test("known rejected manual retry gets a new ID; cancel during send aborts only the local wait and ignores late completion", async () => {
  const view = screen(), calls = []; let release, outcome;
  const compose = new Compose({ ...view, title: "Compose", send: async (text, id, signal) => {
    calls.push({ text, id, signal }); if (calls.length === 1) return { ...sent(id), delivery: "failed", code: "mailbox_full" };
    return new Promise((resolve) => { release = () => resolve(sent(id)); });
  }, done: (value) => { outcome = value; } });
  compose.handleInput("draft"); enter(compose); await until(() => /mailbox_full/.test(compose.render(100).join("\n")));
  enter(compose); assert.notEqual(calls[0].id, calls[1].id); compose.handleInput("\x1b"); assert.equal(outcome.pending, true); assert.equal(calls[1].signal.aborted, true);
  const renders = view.renders; release(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(view.renders, renders);
});

test("Picker uses injected configurable navigation and closes even with an already-aborted generation", async () => {
  const view = screen(), keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "j", "tui.select.confirm": "x" }); let value;
  const picker = new Picker({ ...view, keys, title: "pick", items: [{ value: "a", label: "a" }, { value: "b", label: "b" }], done: (next) => { value = next; } });
  picker.render(20); picker.handleInput("j"); picker.handleInput("x"); assert.equal(value, "b");
  const controller = new AbortController(); controller.abort(); let closed = false;
  new Compose({ ...view, signal: controller.signal, title: "stale", send: async () => { throw new Error("must not send"); }, done: () => { closed = true; } });
  await new Promise((resolve) => queueMicrotask(resolve)); assert.equal(closed, true);
});

test("list render is one collapsed row; expanded messages retain attachments and hints without mutating model content", async (t) => {
  const f = await setup(t), sender = await peer(f, "sender"), pi = await piSession(f, { config: { inboundTrigger: "never" } }), view = screen();
  const result = await pi.tool({ action: "list" }); const saved = JSON.stringify(result);
  assert.equal(renderTool(result.details, false, view.theme).render(80).length, 1);
  assert.match(renderTool(result.details, true, view.theme).render(80).join("\n"), /sender/); assert.equal(JSON.stringify(result), saved);
  await sender.messenger.send(pi.runtime.client.info.id, { text: "peer text", attachments: [{ type: "snippet", name: "Unicode.ts", text: "const 文 = '世界';" }] }); await until(() => pi.history().length === 1);
  const message = pi.history()[0], before = JSON.stringify(message);
  assert.match(renderMessage(message.content, message.details, false, view.theme).render(100).join("\n"), /sender.*default.*1 allegati/);
  assert.match(renderMessage(message.content, message.details, true, view.theme).render(100).join("\n"), /const 文/); assert.equal(JSON.stringify(message), before);
  const large = { ...message.details, message: { ...message.details.message, text: "x".repeat(100_000) } };
  for (const width of [1, 80]) assert.ok(renderMessage(message.content, large, false, view.theme).render(width).length <= 7);
  await pi.session.prompt("next"); assert.ok(JSON.stringify(pi.requests[0].context.messages).includes("const 文"));
});

test("workgroup commands persist first/last group transitions, reject explicit default, and restore saved empty groups over env", async (t) => {
  const f = await setup(t), pi = await piSession(f);
  await command(pi, "/openspace-workgroups"); assert.match(pi.notifications.at(-1).text, /default/);
  await command(pi, "/openspace-workgroups add progetto"); assert.deepEqual(pi.runtime.client.info.workgroups, ["progetto"]);
  await command(pi, "/openspace-workgroups add review"); await command(pi, "/openspace-workgroups remove progetto");
  assert.deepEqual(pi.runtime.client.info.workgroups, ["review"]);
  await command(pi, "/openspace-workgroups remove review"); assert.deepEqual(pi.runtime.client.info.workgroups, ["default"]);
  const entries = pi.manager.getEntries().filter((entry) => entry.customType === WORKGROUP_ENTRY); assert.deepEqual(entries.at(-1).data.specific, []);
  for (const action of ["add", "remove"]) { await command(pi, `/openspace-workgroups ${action} default`); assert.equal(pi.notifications.at(-1).kind, "error"); }
  await pi.close(); const resumed = await piSession(f, { manager: pi.manager, env: { PI_OPENSPACE_WORKGROUPS: "seed" } });
  assert.deepEqual(resumed.runtime.client.info.workgroups, ["default"]); assert.equal(pi.requests.length, 0);
});

test("commands report persistence failure honestly, rename native Pi/presence, and paste contact without replacing editor or making a turn", async (t) => {
  const f = await setup(t); let editor = "human draft ", inputs = 0;
  const pi = await piSession(f, { ui: { pasteToEditor: (text) => { editor += text; }, input: async () => { inputs++; return "名 alias"; } } });
  await command(pi, "/openspace-alias"); await until(() => pi.runtime.client.info.name === "名 alias"); assert.equal(pi.api.getSessionName(), "名 alias"); assert.equal(inputs, 1);
  await command(pi, `/openspace-alias ${"x".repeat(6144)}`); assert.equal(pi.notifications.at(-1).kind, "error"); assert.equal(pi.api.getSessionName(), "名 alias");
  await command(pi, "/openspace-id"); assert.ok(editor.startsWith("human draft ")); assert.ok(editor.includes(pi.runtime.client.info.id)); assert.equal(pi.requests.length, 0);
  const append = pi.api.appendEntry; pi.api.appendEntry = () => { throw new Error("disk failure"); };
  await command(pi, "/openspace-workgroups add live-only"); pi.api.appendEntry = append;
  assert.deepEqual(pi.runtime.client.info.workgroups, ["live-only"]); assert.equal(pi.notifications.at(-1).kind, "error"); assert.match(pi.notifications.at(-1).text, /preference_save_failed/);
  assert.equal(pi.manager.getEntries().some((entry) => entry.customType === WORKGROUP_ENTRY), false);
});

for (const mode of ["rpc", "print", "json"]) test(`${mode} commands never open overlays or manufacture model turns`, async (t) => {
  const f = await setup(t), stderr = [], old = console.error;
  console.error = (text) => { stderr.push(text); }; t.after(() => { console.error = old; });
  const pi = await piSession(f, { mode, ui: { custom: () => { throw new Error("unexpected overlay"); }, pasteToEditor: () => { throw new Error("unexpected paste"); } } });
  await command(pi, "/openspace"); await command(pi, "/openspace-alias Headless"); await command(pi, "/openspace-id"); await command(pi, "/openspace-workgroups add team");
  assert.equal(pi.api.getSessionName(), "Headless"); assert.deepEqual(pi.runtime.client.info.workgroups, ["team"]); assert.equal(pi.requests.length, 0); assert.deepEqual(pi.errors, []);
  assert.ok([...stderr, ...pi.notifications.map(({ text }) => text)].some((text) => text.includes(pi.runtime.client.info.id)));
});

test("shutdown during lookup, alias input or compose cannot send or notify through an old context", async (t) => {
  for (const phase of ["lookup", "input", "compose"]) {
    const f = await setup(t), target = await peer(f, "target"), ui = dialogs(); let release, entered = false;
    const pi = await piSession(f, { ui: { ...ui.ui, input: () => { entered = true; return new Promise((resolve) => { release = resolve; }); } } });
    if (phase === "lookup") pi.runtime.client.listSessions = () => { entered = true; return new Promise((resolve) => { release = resolve; }); };
    if (phase === "compose") ui.plans.push(enter, () => { entered = true; });
    const pending = command(pi, phase === "input" ? "/openspace-alias" : "/openspace"); await until(() => entered);
    const count = pi.notifications.length; await pi.close(); release?.(phase === "input" ? "stale alias" : []); await pending;
    assert.equal(pi.notifications.length, count); assert.equal(target.events.some((event) => event.type === "message"), false);
  }
});

test("native session replacement during an acknowledged alias operation cannot rename the replacement", async (t) => {
  const f = await setup(t), pi = await piSession(f, { cleanup: false }); let release, entered = false, current = pi;
  const host = new AgentSessionRuntime(pi.session, pi.result.services, async (options) => {
    current = await piSession(f, { manager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, cwd: options.cwd, cleanup: false });
    return current.result;
  });
  f.cleanup(() => host.dispose());
  const update = pi.runtime.client.updatePresence.bind(pi.runtime.client);
  pi.runtime.client.updatePresence = async (patch) => { const result = await update(patch); if (patch.name === "old alias") { entered = true; await new Promise((resolve) => { release = resolve; }); } return result; };
  const rename = command(pi, "/openspace-alias old alias"); await until(() => entered);
  const oldId = pi.runtime.sessionId; await host.newSession(); await current.runtime.ready();
  const notifications = pi.notifications.length; release(); await rename;
  assert.notEqual(current.runtime.sessionId, oldId); assert.equal(current.api.getSessionName(), undefined); assert.equal(current.runtime.client.info.name, undefined);
  assert.equal(pi.notifications.length, notifications); assert.deepEqual(current.errors, []);
});

test("leaving through the command terminates an affected ask and held input without deleting injected history", async (t) => {
  const f = await setup(t), target = await peer(f, "target"), pi = await piSession(f, { config: { inboundTrigger: "never", busyDelivery: "human-first" } });
  await target.messenger.send(pi.runtime.client.info.id, { text: "preserve history" }); await until(() => pi.history().length === 1);
  pi.gate.hold = true; const run = pi.session.prompt("ongoing work"); await until(() => pi.requests.length === 1);
  await target.messenger.send(pi.runtime.client.info.id, { text: "held work" }); await until(() => pi.runtime.receiver.heldCount === 1);
  const question = pi.runtime.ask("target", { text: "waiting question" }); await until(() => target.events.some((event) => event.type === "message" && event.message.expectsReply));
  await command(pi, "/openspace-workgroups add other"); const answer = await question;
  assert.equal(answer.code, "workgroup_left"); assert.equal(pi.runtime.receiver.heldCount, 0); assert.equal(pi.history().length, 1);
  assert.match(pi.history()[0].content, /preserve history/); pi.requests[0].release(); await run;
  const send = await pi.tool({ action: "send", to: "target", text: "no longer shared" }); assert.equal(send.isError, true);
});

test("Calm and Orange load together with Openspace without replacing their global UI; owned rendering uses the loaded theme", async (t) => {
  const f = await setup(t), ui = dialogs(); await peer(f, "target"); initTheme("dark");
  const originalFooter = FooterComponent.prototype.render, originalTool = ToolExecutionComponent.prototype.render;
  const widgets = new Map();
  const pi = await piSession(f, { extensionPaths: ["../../calm/extensions/calm/index.ts", "../../orange/extensions/orange.ts"].map((path) => fileURLToPath(new URL(path, import.meta.url))),
    themePaths: [fileURLToPath(new URL("../../orange/themes/tau-orange.json", import.meta.url))], ui: { ...ui.ui, theme: ui.theme,
      setWidget: (key, factory) => { widgets.get(key)?.dispose?.(); if (factory) widgets.set(key, factory(ui.tui)); else widgets.delete(key); },
      setHiddenThinkingLabel: () => {}, setWorkingVisible: () => {}, setHeader: () => { throw new Error("must not replace header"); },
      setFooter: () => { throw new Error("must not replace footer"); }, setEditorComponent: () => { throw new Error("must not replace editor"); } } });
  await command(pi, "/calm on"); const footer = FooterComponent.prototype.render, tool = ToolExecutionComponent.prototype.render;
  assert.notEqual(footer, originalFooter); assert.notEqual(tool, originalTool);
  ui.plans.push((picker) => picker.handleInput("\x1b")); await command(pi, "/openspace");
  const result = await pi.tool({ action: "list" }), orange = pi.result.services.resourceLoader.getThemes().themes.find((theme) => theme.name === "tau-orange");
  assert.ok(orange); assert.match(renderTool(result.details, false, orange).render(80).join("\n"), /Openspace/);
  assert.equal(FooterComponent.prototype.render, footer); assert.equal(ToolExecutionComponent.prototype.render, tool); assert.deepEqual(pi.errors, []);
  await pi.close(); assert.equal(FooterComponent.prototype.render, originalFooter); assert.equal(ToolExecutionComponent.prototype.render, originalTool);
});
