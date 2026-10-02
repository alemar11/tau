import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import calm from "../extensions/calm/index.ts";
import { MONSTER_COUNT, renderMonster } from "../extensions/calm/monster.ts";

initTheme();
const stateEntry = (enabled) => ({ type: "custom", customType: "tau:calm", data: { enabled } });
const plain = (lines) => lines.map((line) => line.replace(/(first|second):[A-Za-z/]+:/g, ""));

function setup(t, { mode = "tui", entries = [], thinkingLevel } = {}) {
  const events = new Map();
  const notifications = [];
  const uiCalls = [];
  const statuses = new Map();
  let command;
  let widget;
  let draws = 0;
  let disposals = 0;
  let color = "first";
  let idle = true;
  let saveError;
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    isIdle: () => idle,
    sessionManager: { getBranch: () => entries },
    thinkingLevel,
    ui: {
      theme: {
        colors: {
          accent: "accent", text: "text", muted: "muted", dim: "dim",
          thinkingOff: "thinkingOff", thinkingMinimal: "thinkingMinimal", thinkingLow: "thinkingLow",
          thinkingMedium: "thinkingMedium", thinkingHigh: "thinkingHigh", thinkingXhigh: "thinkingXhigh",
          thinkingMax: "thinkingMax",
        },
        fg: (token, text) => `${color}:${token}:${text}`,
        style: (text, { fg, bg }) => `${color}:${fg}/${bg}:${text}`,
      },
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: (key, text) => {
        uiCalls.push(["status", key, text]);
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
      setHiddenThinkingLabel: (label) => uiCalls.push(["thinking", label]),
      setWorkingVisible: (visible) => uiCalls.push(["working", visible]),
      setWidget: (key, factory) => {
        uiCalls.push(["widget", key, !!factory]);
        if (widget) { widget.dispose(); disposals++; }
        widget = factory?.({ requestRender: () => draws++ });
      },
    },
  };
  calm({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, definition) => { assert.equal(name, "calm"); command = definition.handler; },
    appendEntry: (customType, data) => {
      if (saveError) throw saveError;
      entries.push({ type: "custom", customType, data });
    },
  });
  const emit = (name) => {
    if (name === "agent_start") idle = false;
    else if (["agent_settled", "session_start", "session_tree", "session_shutdown"].includes(name)) idle = true;
    return events.get(name)({ type: name }, ctx);
  };
  t.after(() => emit("session_shutdown"));
  emit("session_start");
  return {
    events, notifications, uiCalls, entries, emit, statuses,
    command: (args = "") => command(args, ctx),
    widget: () => widget,
    draws: () => draws,
    disposals: () => disposals,
    tuiTheme: () => ctx.ui.theme,
    theme: (next) => { color = next; widget?.invalidate(); },
    failSave: () => { saveError = new Error("session write failed"); },
  };
}

test("off by default; status, invalid input, and idempotent off do not write or customize UI", async (t) => {
  const app = setup(t);
  await app.command("status");
  assert.equal(app.notifications.at(-1).message, "Calm: off.");
  await app.command("banana");
  assert.equal(app.notifications.at(-1).level, "warning");
  await app.command("off");
  assert.deepEqual(app.entries, []);
  assert.deepEqual(app.uiCalls, []);
  assert.deepEqual([...app.events.keys()], ["session_start", "session_tree", "agent_start", "agent_settled", "session_shutdown"]);
});

test("toggle and explicit commands save only changed choices in the session branch", async (t) => {
  const app = setup(t);
  await app.command();
  assert.deepEqual(app.entries, [stateEntry(true)]);
  assert.equal(app.notifications.at(-1).message, "Calm: on.");
  assert.equal(app.widget(), undefined);
  assert.deepEqual(app.uiCalls.slice(0, 2), [["thinking", ""], ["working", false]]);
  const calls = app.uiCalls.length;
  await app.command(" ON ");
  await app.command("status");
  assert.equal(app.uiCalls.length, calls);
  assert.equal(app.entries.length, 1);
  await app.command("toggle");
  assert.deepEqual(app.entries, [stateEntry(true), stateEntry(false)]);
  assert.deepEqual(app.uiCalls.slice(-2), [["thinking", undefined], ["working", true]]);
});

test("the extension bar label follows Calm state across runs, branches, and shutdown", async (t) => {
  const app = setup(t);
  app.statuses.set("another-extension", "other");
  assert.equal(app.statuses.has("tau:calm"), false);
  await app.command("on");
  assert.equal(app.statuses.get("tau:calm"), "calm");
  app.emit("agent_start");
  app.emit("agent_settled");
  assert.equal(app.statuses.get("tau:calm"), "calm");
  await app.command("off");
  assert.equal(app.statuses.has("tau:calm"), false);
  app.entries.splice(0, app.entries.length, stateEntry(true));
  app.emit("session_tree");
  assert.equal(app.statuses.get("tau:calm"), "calm");
  app.emit("session_shutdown");
  assert.equal(app.statuses.has("tau:calm"), false);
  app.emit("session_start");
  assert.equal(app.statuses.get("tau:calm"), "calm");
  app.entries.length = 0;
  app.emit("session_start");
  assert.equal(app.statuses.has("tau:calm"), false);
  assert.equal(app.statuses.get("another-extension"), "other");
});

test("reload and resume restore the branch's last valid choice; a fresh session starts off", async (t) => {
  const entries = [stateEntry(false), stateEntry(true)];
  const app = setup(t, { entries });
  await app.command("status");
  assert.equal(app.notifications.at(-1).message, "Calm: on.");
  app.emit("session_shutdown");
  const reloaded = setup(t, { entries });
  await reloaded.command("status");
  assert.equal(reloaded.notifications.at(-1).message, "Calm: on.");
  assert.equal(entries.length, 2);
  entries.length = 0;
  reloaded.emit("session_start");
  await reloaded.command("status");
  assert.equal(reloaded.notifications.at(-1).message, "Calm: off.");
  assert.deepEqual(reloaded.uiCalls.slice(-2), [["thinking", undefined], ["working", true]]);
});

test("tree navigation restores branch state and ignores unrelated or malformed entries", async (t) => {
  const entries = [stateEntry(true)];
  const app = setup(t, { entries });
  entries.push(
    { ...stateEntry(false), type: "message" },
    { ...stateEntry(false), customType: "another-extension" },
    { type: "custom", customType: "tau:calm" },
    { type: "custom", customType: "tau:calm", data: null },
    stateEntry("false"),
  );
  app.emit("session_tree");
  await app.command("status");
  assert.equal(app.notifications.at(-1).message, "Calm: on.");
  entries.splice(0, entries.length, stateEntry(true), stateEntry(false));
  app.emit("session_tree");
  await app.command("status");
  assert.equal(app.notifications.at(-1).message, "Calm: off.");
  entries.pop();
  app.emit("session_tree");
  await app.command("status");
  assert.equal(app.notifications.at(-1).message, "Calm: on.");
  entries.length = 0;
  app.emit("session_tree");
  await app.command("status");
  assert.equal(app.notifications.at(-1).message, "Calm: off.");
});

test("an old global preference is neither honored nor rewritten", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tau-calm-legacy-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, "calm.json");
  const legacy = '{"enabled":true}\n';
  writeFileSync(path, legacy);
  const app = setup(t);
  await app.command("status");
  assert.equal(app.notifications.at(-1).message, "Calm: off.");
  await app.command("on");
  await app.command("off");
  assert.equal(readFileSync(path, "utf8"), legacy);
  assert.deepEqual(readdirSync(directory), ["calm.json"]);
});

test("a failed session write keeps the current state and UI unchanged", async (t) => {
  const app = setup(t);
  await app.command("on");
  const calls = app.uiCalls.length;
  app.failSave();
  await app.command("off");
  assert.equal(app.notifications.at(-1).level, "error");
  await app.command("status");
  assert.equal(app.notifications.at(-1).message, "Calm: on.");
  assert.deepEqual(app.entries, [stateEntry(true)]);
  assert.equal(app.uiCalls.length, calls);
});

test("the pixel monster walks, blinks, follows the live theme, and fades in place on settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.mock.method(Math, "random", () => 0);
  const app = setup(t);
  await app.command("on");
  assert.equal(app.widget(), undefined);
  app.emit("agent_start");
  const widget = app.widget();
  const initial = [
    "   ▀▄     ▄▀   ", "  ▄█▀▀███▀▀█▄  ", "▄▀███████████▀▄", "▀ ▀▀█▀▀▀▀▀█▀▀ ▀", "   ▄█     █▄   ",
  ];
  assert.deepEqual(plain(widget.render(80)), initial);
  assert.deepEqual(widget.render(0), []);
  assert.match(widget.render(80)[1], /first:accent\/text:▀/);
  t.mock.timers.tick(480);
  assert.equal(plain(widget.render(80))[1], " " + initial[1]);
  assert.equal(plain(widget.render(80))[3], " " + initial[3]);
  assert.equal(plain(widget.render(80))[4], "     █▄   ▄█    ");
  t.mock.timers.tick(36 * 240);
  assert.equal(plain(widget.render(80))[1].trimStart(), "▄█████████▄  ");
  assert.doesNotMatch(widget.render(80)[1], /accent\/text/);
  t.mock.timers.tick(480);
  assert.equal(plain(widget.render(80))[1].trimStart(), initial[1].trimStart());
  const pose = plain(widget.render(80));
  app.theme("second");
  assert.deepEqual(plain(widget.render(80)), pose);
  assert.ok(widget.render(80).every((line) => line.includes("second:accent:") && !line.includes("first:")));
  app.emit("agent_settled");
  assert.equal(app.widget(), widget);
  assert.deepEqual(plain(widget.render(80)), pose);
  assert.ok(widget.render(80).every((line) => line.includes("second:muted:") && !line.includes("accent")));
  assert.match(widget.render(80)[1], /second:muted\/muted:▀/);
  t.mock.timers.tick(240);
  assert.deepEqual(plain(widget.render(80)), pose);
  assert.ok(widget.render(80).every((line) => line.includes("second:dim:")));
  app.theme("first");
  assert.match(widget.render(80)[1], /first:dim\/dim:▀/);
  app.emit("agent_settled"); // Duplicate notifications must not restart the fade.
  t.mock.timers.tick(240);
  assert.equal(app.widget(), undefined);
  assert.equal(app.disposals(), 1);
  const draws = app.draws();
  t.mock.timers.tick(4800);
  assert.equal(app.draws(), draws);
});

test("the monster body uses the current thinking-level border color when available", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.mock.method(Math, "random", () => 0);
  const app = setup(t, { thinkingLevel: "high" });
  await app.command("on");
  app.emit("agent_start");
  assert.ok(app.widget().render(80).every((line) => line.includes("first:thinkingHigh:") && !line.includes("first:accent:")));
  assert.match(app.widget().render(80)[1], /first:thinkingHigh\/text:▀/);
});

test("each run chooses one random monster from the pool and keeps it for that widget", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.mock.method(Math, "random", () => 0.999);
  const app = setup(t);
  await app.command("on");
  app.emit("agent_start");
  const widget = app.widget();
  assert.deepEqual(plain(widget.render(80)), plain(renderMonster(80, 0, app.tuiTheme(), undefined, MONSTER_COUNT - 1)));
  t.mock.timers.tick(240);
  assert.deepEqual(plain(widget.render(80)), plain(renderMonster(80, 1, app.tuiTheme(), undefined, MONSTER_COUNT - 1)));
});

test("the monster traverses the full width and turns at both edges without wrapping", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.mock.method(Math, "random", () => 0);
  const app = setup(t);
  await app.command("on");
  app.emit("agent_start");
  const widget = app.widget();
  const face = "  ▄█▀▀███▀▀█▄  ";
  const span = 80 - 15;
  t.mock.timers.tick(span * 480);
  assert.equal(plain(widget.render(80))[1], " ".repeat(span) + face);
  assert.equal(plain(widget.render(80))[2].at(-1), "▄");
  t.mock.timers.tick(480);
  assert.equal(plain(widget.render(80))[1], " ".repeat(span - 1) + face);
  t.mock.timers.tick((span - 1) * 480);
  assert.equal(plain(widget.render(80))[1], face);
  for (const width of [1, 2, 5, 6, 8, 14, 15, 16, 80, 160]) {
    for (let tick = 0; tick < width * 4; tick++) {
      t.mock.timers.tick(240);
      const lines = plain(widget.render(width));
      assert.equal(lines.length, width < 6 ? 2 : 5);
      for (const line of lines) assert.ok(line.length <= width);
      assert.ok(lines.some((line) => line.includes("█")));
    }
    assert.deepEqual(widget.render(0), []);
  }
});

test("a new run cancels the old fade so it cannot clear the new widget", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const app = setup(t, { entries: [stateEntry(true)] });
  app.emit("agent_start");
  app.emit("agent_settled");
  t.mock.timers.tick(240);
  const old = app.widget();
  app.emit("agent_start");
  const current = app.widget();
  assert.notEqual(current, old);
  assert.equal(app.disposals(), 1);
  t.mock.timers.tick(960);
  assert.equal(app.widget(), current);
  assert.ok(current.render(80).every((line) => line.includes("first:accent:")));
  assert.match(current.render(80)[1], /first:accent\/text:▀/);
});

test("off, reload/shutdown, and session/tree changes cancel fade timers immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const action of ["off", "session_shutdown", "session_start", "session_tree"]) {
    const app = setup(t, { entries: [stateEntry(true)] });
    app.emit("agent_start");
    app.emit("agent_settled");
    t.mock.timers.tick(240);
    if (action === "off") await app.command("off");
    else app.emit(action);
    assert.equal(app.widget(), undefined, action);
    assert.equal(app.disposals(), 1);
    const draws = app.draws();
    t.mock.timers.tick(4800);
    assert.equal(app.draws(), draws);
    app.emit("session_shutdown");
  }
});

test("toggling during a run and shutdown remove the animation without leaving timers", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const app = setup(t);
  app.emit("agent_start");
  await app.command("on");
  assert.ok(app.widget());
  await app.command("off");
  assert.equal(app.widget(), undefined);
  await app.command("on");
  assert.ok(app.widget());
  app.emit("session_shutdown");
  assert.equal(app.widget(), undefined);
  assert.equal(app.disposals(), 2);
  const draws = app.draws();
  t.mock.timers.tick(4800);
  assert.equal(app.draws(), draws);
  assert.deepEqual(app.entries, [stateEntry(true), stateEntry(false), stateEntry(true)]);
});

test("switching to a new session stops movement and does not inherit the choice", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const app = setup(t);
  await app.command("on");
  app.emit("agent_start");
  assert.ok(app.widget());
  app.entries.length = 0;
  app.emit("session_start");
  assert.equal(app.widget(), undefined);
  assert.equal(app.disposals(), 1);
  await app.command("status");
  assert.equal(app.notifications.at(-1).message, "Calm: off.");
  const draws = app.draws();
  t.mock.timers.tick(4800);
  assert.equal(app.draws(), draws);
});

test("RPC, JSON, and print modes neither customize terminal UI nor write session state", async (t) => {
  for (const mode of ["rpc", "json", "print"]) {
    const app = setup(t, { mode, entries: [stateEntry(true)] });
    await app.command("on");
    app.emit("agent_start");
    app.emit("agent_settled");
    app.emit("session_tree");
    app.emit("session_shutdown");
    assert.deepEqual(app.uiCalls, []);
    assert.deepEqual(app.entries, [stateEntry(true)]);
    assert.equal(app.notifications.length, mode === "rpc" ? 1 : 0);
  }
});
