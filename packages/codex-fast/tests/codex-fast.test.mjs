import assert from "node:assert/strict";
import { test } from "node:test";
import codexFast from "../extensions/codex-fast.ts";

const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" };
const openai = { provider: "openai", api: "openai-responses", id: "gpt-6-astra" };
const stateEntry = (mode) => ({ type: "custom", customType: "tau:codex-fast", data: { mode } });

function setup({ model = codex, entries = [], mode = "tui" } = {}) {
  const events = new Map();
  const commands = new Map();
  const notifications = [];
  const statuses = new Map();
  const ctx = {
    model, mode, hasUI: mode === "tui" || mode === "rpc",
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: (key, text) => statuses.set(key, text),
    },
  };
  codexFast({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  });
  const emit = (name, data = {}) => events.get(name)({ type: name, ...data }, ctx);
  emit("session_start");
  return {
    ctx, entries, notifications, statuses, emit,
    command: (args = "", name = "codex-fast") => commands.get(name).handler(args, ctx),
    request: (payload) => emit("before_provider_request", { payload }),
    status: () => statuses.get("tau:codex-fast"),
    select: (model) => { ctx.model = model; emit("model_select", { model }); },
  };
}

const payload = { model: "gpt-5.4", input: [], reasoning: { effort: "high" }, stream: true };

test("fast defaults to off and toggles priority without mutating the request", async () => {
  const app = setup();
  assert.equal(app.request(payload), undefined);
  assert.equal(app.status(), undefined);
  await app.command();
  assert.deepEqual(app.request(payload), { ...payload, service_tier: "priority" });
  assert.equal(payload.service_tier, undefined);
  assert.equal(app.status(), "Codex fast: active");
  await app.command();
  assert.equal(app.request(payload), undefined);
  assert.equal(app.status(), undefined);
  assert.deepEqual(app.entries.map((entry) => entry.data.mode), ["fast", "off"]);
});

test("explicit on is idempotent; status and invalid arguments do not change state", async () => {
  const app = setup();
  await app.command("status");
  assert.match(app.notifications.at(-1).message, /off/);
  await app.command("on");
  await app.command(" ON ");
  await app.command("status");
  assert.match(app.notifications.at(-1).message, /fast \(active\)/);
  await app.command("banana");
  assert.equal(app.notifications.at(-1).level, "warning");
  assert.equal(app.entries.length, 1);
  await app.command("toggle");
  assert.equal(app.request(payload), undefined);
});

test("modern OpenAI and legacy Codex support every allowed fast model", async () => {
  const models = ["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
    "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"];
  for (const provider of [codex, openai]) {
    for (const id of models) {
      const app = setup({ model: { ...provider, id } });
      await app.command();
      assert.equal(app.request(payload).service_tier, "priority", `${provider.provider}/${id}`);
    }
  }
});

test("ultrafast toggles its own tier only on supported provider/model pairs", async () => {
  for (const model of [openai, { ...openai, id: "gpt-5.6-sol" }, { ...codex, id: "gpt-6-astra" }]) {
    const app = setup({ model });
    await app.command("", "codex-ultrafast");
    assert.deepEqual(app.request(payload), { ...payload, service_tier: "ultrafast" });
    assert.equal(app.status(), "Codex ultrafast: active");
    await app.command("", "codex-ultrafast");
    assert.equal(app.request(payload), undefined);
    assert.equal(app.status(), undefined);
  }
  for (const model of [codex, { ...codex, id: "gpt-5.6-sol" }, { ...openai, id: "gpt-6-sol" }]) {
    const app = setup({ model });
    await app.command("on", "codex-ultrafast");
    assert.equal(app.entries.length, 0);
    assert.equal(app.notifications.at(-1).level, "warning");
    assert.equal(app.request(payload), undefined);
  }
});

test("fast and ultrafast are mutually exclusive, with idempotent on and shared off", async () => {
  const app = setup({ model: openai });
  await app.command();
  await app.command("on", "codex-ultrafast");
  await app.command("on", "codex-ultrafast");
  await app.command("status", "codex-ultrafast");
  assert.match(app.notifications.at(-1).message, /ultrafast \(active\)/);
  assert.equal(app.request(payload).service_tier, "ultrafast");
  await app.command();
  assert.equal(app.request(payload).service_tier, "priority");
  await app.command("off", "codex-ultrafast");
  assert.equal(app.request(payload), undefined);
  assert.deepEqual(app.entries.map((entry) => entry.data.mode), ["fast", "ultrafast", "fast", "off"]);
});

test("unsupported models, providers and APIs never enable or modify speed tiers", async () => {
  for (const model of [
    { ...openai, id: "gpt-4o" },
    { ...codex, id: "unknown-future-model" },
    { ...codex, provider: "other" },
    { ...codex, api: "openai-responses" },
    { ...openai, api: "openai-completions" },
    null,
  ]) {
    const app = setup({ model });
    await app.command();
    assert.equal(app.entries.length, 0);
    assert.equal(app.notifications.at(-1).level, "warning");
    app.entries.push(stateEntry("fast"));
    app.emit("session_start");
    assert.equal(app.request(payload), undefined);
    assert.equal(app.status(), "Codex fast: inactive");
  }
});

test("switching models updates active/inactive state without losing the selected mode", async () => {
  const app = setup({ model: openai });
  await app.command("on", "codex-ultrafast");
  app.select(codex);
  assert.equal(app.status(), "Codex ultrafast: inactive");
  assert.equal(app.request(payload), undefined);
  await app.command("status");
  assert.match(app.notifications.at(-1).message, /ultrafast \(inactive/);
  await app.command("on", "codex-ultrafast");
  assert.equal(app.entries.length, 1);
  app.select(openai);
  assert.equal(app.status(), "Codex ultrafast: active");
  assert.equal(app.request(payload).service_tier, "ultrafast");
  app.select(undefined);
  await app.command("", "codex-ultrafast");
  assert.equal(app.status(), undefined);
});

test("off stops overriding tiers supplied elsewhere", async () => {
  const app = setup();
  await app.command();
  assert.equal(app.request({ ...payload, service_tier: "auto" }).service_tier, "priority");
  await app.command("off");
  const upstream = { ...payload, service_tier: "flex" };
  assert.equal(app.request(upstream), undefined);
  assert.equal(upstream.service_tier, "flex");
});

test("reload/resume restores each mode from the active branch", async () => {
  for (const mode of ["fast", "ultrafast", "off"]) {
    const app = setup({ model: openai, entries: [stateEntry("fast"), stateEntry(mode)] });
    assert.equal(app.request(payload)?.service_tier,
      mode === "off" ? undefined : mode === "fast" ? "priority" : "ultrafast");
    assert.equal(app.status(), mode === "off" ? undefined : `Codex ${mode}: active`);
    app.entries.length = 0;
    app.emit("session_start");
    assert.equal(app.request(payload), undefined);
    assert.equal(app.status(), undefined);
  }
});

test("tree navigation restores branch state and ignores unrelated or malformed entries", async () => {
  const app = setup({ model: openai });
  await app.command("on", "codex-ultrafast");
  app.entries.push(
    { type: "custom", customType: "another-extension", data: { mode: "off" } },
    stateEntry("invalid"),
    { type: "custom", customType: "tau:codex-fast" },
    { type: "custom", customType: "tau:codex-fast", data: null },
    { type: "custom", customType: "tau:codex-fast", data: { enabled: "false" } },
  );
  app.emit("session_tree");
  assert.equal(app.request(payload).service_tier, "ultrafast");
  app.entries.splice(0, app.entries.length, stateEntry("fast"));
  app.emit("session_tree");
  assert.equal(app.request(payload).service_tier, "priority");
  assert.equal(app.status(), "Codex fast: active");
  app.entries.length = 0;
  app.emit("session_tree");
  assert.equal(app.request(payload), undefined);
  assert.equal(app.status(), undefined);
});

test("legacy boolean session state migrates without overriding newer mode entries", async () => {
  const entries = [{ type: "custom", customType: "tau:codex-fast", data: { enabled: true } }];
  const app = setup({ model: openai, entries });
  assert.equal(app.request(payload).service_tier, "priority");
  await app.command("on", "codex-ultrafast");
  assert.equal(setup({ model: openai, entries }).request(payload).service_tier, "ultrafast");
  entries.push({ type: "custom", customType: "tau:codex-fast", data: { enabled: false } });
  app.emit("session_tree");
  assert.equal(app.request(payload), undefined);
});

test("unexpected payloads are left unchanged", async () => {
  const app = setup();
  await app.command();
  for (const value of [null, undefined, [], "payload", 42]) {
    assert.equal(app.request(value), undefined);
  }
});

test("non-terminal modes keep request behavior independent of the footer", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const app = setup({ mode, model: openai });
    app.ctx.ui.setStatus = () => assert.fail("terminal status called outside TUI");
    if (!app.ctx.hasUI) app.ctx.ui.notify = () => assert.fail("notification called without UI");
    await app.command("on", "codex-ultrafast");
    assert.equal(app.request(payload).service_tier, "ultrafast");
    app.select({ ...openai, id: "gpt-4o" });
    app.emit("session_tree");
    await app.command("status");
    await app.command("banana");
    await app.command("off");
    assert.equal(app.statuses.size, 0);
  }
});
