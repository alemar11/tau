import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  DefaultResourceLoader, FooterComponent, SettingsManager, initTheme,
} from "@earendil-works/pi-coding-agent";
import orange, { hideFooterCost } from "../extensions/orange.ts";

initTheme("dark");
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");

function footer({ subscription = false, cost = 0.123, provider = "test-provider" } = {}) {
  const usage = { input: 1200, output: 300, cacheRead: 800, cacheWrite: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
  const entries = [{ type: "message", message: { role: "assistant", usage } }];
  const model = { id: "test-model", provider, contextWindow: 200000, reasoning: true };
  const session = {
    sessionManager: {
      getEntries: () => entries, getEntryCount: () => entries.length,
      getSessionId: () => "test-session", getLeafId: () => "leaf",
      getCwd: () => "/tmp/project-$0.123", getSessionName: () => "Orange test",
    },
    state: { model, thinkingLevel: "high" },
    model, modelRuntime: { isUsingSubscription: () => subscription },
    getContextUsage: () => ({ contextWindow: 200000, percent: 75 }),
  };
  const statuses = new Map([["test", "Search budget $0.123"]]);
  const component = new FooterComponent(session, {
    getGitBranch: () => "main", getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => statuses,
  });
  return { component, entries, usage };
}

test("stock footer hides only cost, preserving styles, alignment, and usage data", (t) => {
  const { component, entries, usage } = footer({ subscription: true });
  const before = structuredClone(entries);
  const stock = component.render(160);
  t.after(hideFooterCost());
  const rendered = component.render(160);
  assert.equal(rendered[0], stock[0]);
  assert.equal(rendered[2], stock[2]);
  assert.equal(rendered[1], stock[1].replace("$0.123 (sub)", " ".repeat(12)));
  assert.match(plain(rendered[1]), /↑1.2k ↓300 R800 W100 CH38.1%/);
  assert.match(plain(rendered[1]), /75.0%\/200k \(auto\)/);
  assert.match(plain(rendered[1]), /\(test-provider\) test-model • high$/);
  assert.deepEqual(entries, before);
  assert.equal(usage.cost.total, 0.123);
});

test("Codex provider label hides without changing the model, thinking level, or other rows", () => {
  const { component } = footer({ cost: 0, provider: "openai-codex" });
  const stock = component.render(160);
  assert.match(plain(stock[1]), /\(openai-codex\) test-model • high$/);
  const remove = hideFooterCost();
  try {
    const rendered = component.render(160);
    assert.equal(rendered[1], stock[1].replace("(openai-codex) ", " ".repeat(15)));
    assert.equal(rendered[0], stock[0]);
    assert.equal(rendered[2], stock[2]);
    assert.match(plain(rendered[1]), /test-model • high$/);
    for (let width = 1; width <= 180; width++) {
      assert.doesNotMatch(plain(component.render(width)[1]), /openai-codex/);
    }
  } finally { remove(); }
  assert.deepEqual(component.render(160), stock);
});

test("cost and partial subscription labels stay hidden at narrow widths", (t) => {
  for (const subscription of [false, true]) {
    const { component } = footer({ subscription });
    const remove = hideFooterCost();
    try {
      for (let width = 1; width <= 180; width++) {
        const stats = plain(component.render(width)[1]);
        assert.doesNotMatch(stats, /\$|\(s(?:u(?:b)?)?/, `width ${width}`);
        assert.ok(stats.length <= width);
      }
    } finally { remove(); }
  }
});

test("zero-cost API sessions keep stock output and cleanup restores the renderer", () => {
  const { component } = footer({ cost: 0 });
  const original = FooterComponent.prototype.render;
  const stock = component.render(100);
  const remove = hideFooterCost();
  assert.deepEqual(component.render(100), stock);
  remove();
  remove();
  assert.equal(FooterComponent.prototype.render, original);
});

test("cleanup leaves later adapters installed and makes retained wrappers inert", () => {
  const { component } = footer();
  const original = FooterComponent.prototype.render;
  const remove = hideFooterCost();
  const adapted = FooterComponent.prototype.render;
  const later = function (width) { return adapted.call(this, width); };
  FooterComponent.prototype.render = later;
  try {
    remove();
    assert.equal(FooterComponent.prototype.render, later);
    assert.deepEqual(component.render(100), original.call(component, 100));
  } finally { FooterComponent.prototype.render = original; }
});

test("lifecycle installs in TUI only and restores on shutdown", () => {
  const original = FooterComponent.prototype.render;
  const events = new Map();
  orange({ on: (event, handler) => events.set(event, handler) });
  const emit = (event, mode) => events.get(event)({}, { mode });
  try {
    for (const mode of ["rpc", "json", "print"]) {
      emit("session_start", mode);
      assert.equal(FooterComponent.prototype.render, original);
    }
    emit("session_start", "tui");
    assert.notEqual(FooterComponent.prototype.render, original);
    emit("session_start", "tui");
    emit("session_shutdown", "tui");
    assert.equal(FooterComponent.prototype.render, original);
  } finally { emit("session_shutdown", "tui"); }
});

test("Pi discovers and validates the package theme with an orange accent", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tau-orange-theme-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packagePath = fileURLToPath(new URL("../", import.meta.url));
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory,
    settingsManager: SettingsManager.inMemory({ packages: [packagePath] }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
  });
  await loader.reload();
  const { themes, diagnostics } = loader.getThemes();
  assert.deepEqual(diagnostics, []);
  const theme = themes.find((theme) => theme.name === "tau-orange");
  assert.ok(theme, "manifest theme is loaded");
  assert.equal(theme.appearance, "dark");
  assert.match(theme.fg("accent", "Orange"), /Orange/);
  const json = JSON.parse(readFileSync(join(packagePath, "themes/tau-orange.json"), "utf8"));
  assert.equal(json.colors.accent, "orange");
  assert.equal(json.vars.orange, "#ff9a3c");
});
