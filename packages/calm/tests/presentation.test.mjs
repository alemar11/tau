import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AssistantMessageComponent, ToolExecutionComponent, createReadToolDefinition, initTheme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installPresentation } from "../extensions/calm/presentation.ts";

initTheme();
const plain = (lines) => lines.join("\n").replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;]*m/g, "");
const toolCall = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "example.txt" } };
const text = (value) => ({ type: "text", text: value });
const thinking = (value) => ({ type: "thinking", thinking: value });
const message = (content, stopReason = "stop", extra = {}) => ({
  role: "assistant", content, stopReason, ...extra,
});

function setup(t) {
  let enabled = true;
  const warnings = [];
  let color = "\x1b[31m";
  const remove = installPresentation(() => enabled, (warning) => warnings.push(warning), () => ({
    fg: (token, value) => {
      assert.equal(token, "error");
      return `${color}${value}\x1b[39m`;
    },
  }));
  t.after(remove);
  return { warnings, remove, toggle: (next) => { enabled = next; }, color: (next) => { color = next; } };
}

function row(name = "read", definition = name === "read" ? createReadToolDefinition(process.cwd()) : undefined) {
  return new ToolExecutionComponent(name, "call-1", { path: "example.txt" }, { showImages: false },
    definition, { requestRender() {} }, process.cwd());
}

test("routine built-in tool rows hide, errors remain visible, and expanded rows reveal native output", (t) => {
  const app = setup(t);
  for (const name of ["bash", "powershell", "read", "edit", "write", "grep", "find", "ls"]) {
    const component = row(name);
    assert.deepEqual(component.render(60), [], name);
    component.updateResult({ content: [text("result")], isError: false });
    assert.deepEqual(component.render(60), [], name);
    component.setExpanded(true);
    assert.match(plain(component.render(60)), /result/);
    component.setExpanded(false);
    component.updateResult({ content: [text("permission denied")], isError: true });
    const lines = component.render(60);
    assert.equal(lines.length, 1);
    assert.equal(plain(lines), `✗ ${name} — permission denied`);
    assert.equal(lines[0], `\x1b[31m✗ ${name} — permission denied\x1b[39m`);
  }
  assert.deepEqual(app.warnings, []);
});

test("shell failures summarize exit status or timeout instead of log output", (t) => {
  setup(t);
  for (const name of ["bash", "powershell"]) {
    const component = row(name);
    component.updateResult({
      content: [text("Lots of output\nassertion details\nCommand exited with code 1")],
      structuredContent: { exit_code: 2 }, isError: true,
    });
    assert.equal(plain(component.render(80)), `✗ ${name} — exited with code 2`);
    component.updateResult({
      content: [text("Earlier logs\nCommand exited with code 1")], isError: true,
    });
    assert.equal(plain(component.render(80)), `✗ ${name} — exited with code 1`);
    for (const status of ["timed out after 30 seconds", "aborted", "terminated without an exit code"]) {
      component.updateResult({ content: [text(`Earlier logs\nCommand ${status}`)], isError: true });
      assert.equal(plain(component.render(80)), `✗ ${name} — ${status}`);
    }
  }
});

test("expanded errors, Calm off, and cleanup restore full native output without mutating results", (t) => {
  const component = row("bash");
  const result = Object.freeze({
    content: Object.freeze([Object.freeze(text("First error\nFull diagnostic details\nCommand exited with code 1"))]),
    isError: true,
  });
  component.updateResult(result);
  const stock = component.render(80);
  component.setExpanded(true);
  const expanded = component.render(80);
  component.setExpanded(false);
  const app = setup(t);
  assert.equal(plain(component.render(80)), "✗ bash — exited with code 1");
  component.setExpanded(true);
  assert.deepEqual(component.render(80), expanded);
  assert.match(plain(component.render(80)), /Full diagnostic details/);
  component.setExpanded(false);
  assert.equal(component.render(80).length, 1);
  app.toggle(false);
  assert.deepEqual(component.render(80), stock);
  app.toggle(true);
  app.remove();
  assert.deepEqual(component.render(80), stock);
  assert.equal(result.content[0].text, "First error\nFull diagnostic details\nCommand exited with code 1");
});

test("error summaries sanitize controls, fit narrow Unicode widths, and use the current theme", (t) => {
  const app = setup(t);
  const component = row();
  component.updateResult({ content: [text("\n\x1b[41m病🙂é\tpermission denied\x1b[0m\x07\nFull details")], isError: true });
  assert.equal(plain(component.render(80)), "✗ read — 病🙂é permission denied");
  assert.doesNotMatch(component.render(80)[0], /\x1b\[41m|\x07/);
  for (const width of [1, 2, 5, 10, 15, 30, 80]) {
    const lines = component.render(width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= width);
    assert.doesNotMatch(lines[0], /[\n\r\t]/);
  }
  assert.deepEqual(component.render(0), []);
  app.color("\x1b[91m");
  assert.ok(component.render(80)[0].startsWith("\x1b[91m"));
  component.updateResult({ content: [], isError: true });
  assert.equal(plain(component.render(80)), "✗ read — failed");
});

test("custom tools and image-bearing results keep their normal rows", (t) => {
  setup(t);
  const custom = row("custom-tool");
  custom.updateResult({ content: [text("custom result")] });
  assert.match(plain(custom.render(60)), /custom result/);
  custom.updateResult({ content: [text("custom error\ncustom details")], isError: true });
  assert.match(plain(custom.render(60)), /custom details/);
  assert.ok(custom.render(60).length > 1);
  const image = row();
  image.updateResult({ content: [text("Read image file"), { type: "image", data: "", mimeType: "image/png" }] });
  assert.ok(image.render(60).length > 0);
  image.updateResult({ content: [text("image error"), { type: "image", data: "", mimeType: "image/png" }], isError: true });
  assert.match(plain(image.render(60)), /image error/);
  assert.ok(image.render(60).length > 1);
});

test("toggling off restores existing tool rows byte-for-byte without new registrations", (t) => {
  const component = row();
  component.updateResult({ content: [text("result")] });
  const stock = component.render(60);
  const app = setup(t);
  assert.deepEqual(component.render(60), []);
  app.toggle(false);
  assert.deepEqual(component.render(60), stock);
  app.toggle(true);
  assert.deepEqual(component.render(60), []);
});

test("settled short working notes hide; streaming, multiline, and long blocks stay visible", (t) => {
  setup(t);
  const short = message([text("Checking the file."), toolCall], "toolUse");
  const component = new AssistantMessageComponent();
  component.updateContent(short, true);
  assert.match(plain(component.render(60)), /Checking the file/);
  component.updateContent(short, false);
  assert.deepEqual(component.render(60), []);
  const mixed = message([text("Checking."), text("Important\nexplanation."), text("x".repeat(240)), toolCall], "toolUse");
  component.updateContent(mixed, false);
  const visible = plain(component.render(60));
  assert.doesNotMatch(visible, /Checking/);
  assert.match(visible, /Important/);
  assert.match(visible, /explanation/);
  assert.match(visible, /x{20}/);
  component.updateContent(message([text("x".repeat(239)), toolCall], "toolUse"), false);
  assert.deepEqual(component.render(60), []);
});

test("final answers, failure messages, and truncation notices never hide", (t) => {
  setup(t);
  for (const stopReason of ["stop", "error", "aborted", "length"]) {
    const component = new AssistantMessageComponent(message([text("Visible reply.")], stopReason, { errorMessage: "Failure detail" }));
    assert.match(plain(component.render(60)), /Visible reply/);
    if (stopReason === "error" || stopReason === "aborted") {
      assert.match(plain(component.render(60)), /Failure detail/);
    }
    if (stopReason === "length") assert.match(plain(component.render(60)), /truncated/);
  }
  const truncated = new AssistantMessageComponent(message([text("Checking."), toolCall], "length"));
  assert.doesNotMatch(plain(truncated.render(60)), /Checking/);
  assert.match(plain(truncated.render(60)), /truncated/);
});

test("collapsed thinking takes zero rows, expanded reasoning stays visible, and toggling restores notes", (t) => {
  const original = message([thinking("Reasoning text"), text("Checking."), toolCall], "toolUse");
  const stock = new AssistantMessageComponent(original, true).render(60);
  const app = setup(t);
  const component = new AssistantMessageComponent(original, true);
  assert.deepEqual(component.render(60), []);
  component.setHideThinkingBlock(false);
  assert.match(plain(component.render(60)), /Reasoning text/);
  component.setHideThinkingBlock(true);
  assert.deepEqual(component.render(60), []);
  app.toggle(false);
  assert.deepEqual(component.render(60), stock);
  app.toggle(true);
  assert.deepEqual(component.render(60), []);
});

test("presentation never mutates source messages and cleanup restores already-rendered components", (t) => {
  const original = message([Object.freeze(thinking("Reasoning")), Object.freeze(text("Checking.")), Object.freeze(toolCall)], "toolUse");
  Object.freeze(original.content);
  Object.freeze(original);
  const before = structuredClone(original);
  const nativeUpdate = AssistantMessageComponent.prototype.updateContent;
  const nativeAssistantRender = AssistantMessageComponent.prototype.render;
  const nativeToolRender = ToolExecutionComponent.prototype.render;
  const app = setup(t);
  const component = new AssistantMessageComponent(original, true);
  assert.deepEqual(component.render(60), []);
  component.invalidate();
  assert.deepEqual(original, before);
  app.remove();
  assert.equal(AssistantMessageComponent.prototype.updateContent, nativeUpdate);
  assert.equal(AssistantMessageComponent.prototype.render, nativeAssistantRender);
  assert.equal(ToolExecutionComponent.prototype.render, nativeToolRender);
  assert.match(plain(component.render(60)), /Thinking/);
  assert.match(plain(component.render(60)), /Checking/);
  assert.deepEqual(original, before);
});

test("missing layout seams fail open independently with one warning", (t) => {
  const component = row();
  delete component.expanded;
  const stock = component.render(60);
  const app = setup(t);
  assert.deepEqual(component.render(60), stock);
  assert.deepEqual(component.render(60), stock);
  assert.equal(app.warnings.length, 1);
  assert.match(app.warnings[0], /tool presentation is unavailable/);
  const assistant = new AssistantMessageComponent(message([text("Checking."), toolCall], "toolUse"));
  assert.deepEqual(assistant.render(60), []);
  delete assistant.isStreaming;
  assistant.render(60);
  assert.equal(app.warnings.length, 2);
  assert.match(app.warnings[1], /assistant presentation is unavailable/);
  assert.match(plain(assistant.render(60)), /Checking/);
});

test("cleanup does not overwrite a later extension's renderer", (t) => {
  const native = ToolExecutionComponent.prototype.render;
  const app = setup(t);
  const calmRender = ToolExecutionComponent.prototype.render;
  const later = function (width) { return calmRender.call(this, width); };
  ToolExecutionComponent.prototype.render = later;
  try {
    app.remove();
    assert.equal(ToolExecutionComponent.prototype.render, later);
    assert.deepEqual(row().render(60), native.call(row(), 60));
  } finally {
    ToolExecutionComponent.prototype.render = native;
  }
});

test("native execution, errors, and cancellation remain unchanged", async (t) => {
  setup(t);
  const directory = mkdtempSync(join(tmpdir(), "tau-calm-read-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "example.txt"), "original content\n");
  const definition = createReadToolDefinition(directory);
  const result = await definition.execute("test", { path: "example.txt" });
  assert.equal(result.content[0].text, "original content\n");
  await assert.rejects(definition.execute("test", { path: "missing.txt" }), /ENOENT/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(definition.execute("test", { path: "example.txt" }, controller.signal), /aborted/);
});
