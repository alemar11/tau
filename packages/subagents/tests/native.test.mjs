import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Type } from "typebox";
import { setTimeout as delay } from "node:timers/promises";

const root = fs.mkdtempSync(path.join(tmpdir(), "tau-native-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.TAU_SUBAGENTS_TEMP_ROOT = path.join(root, "state");
const bin = path.join(root, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nprintf attempted > "${path.join(root, "git-attempted")}"\nexit 127\n`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
const { runSync } = await import("../extensions/subagents/src/runs/foreground/execution.ts");
const { executeAsyncSingle } = await import("../extensions/subagents/src/runs/background/async-execution.ts");
const { default: fixtureProvider } = await import("./support/provider.ts");
const { disposeChildSessions, createDefaultChildSessionFactory } = await import("../extensions/subagents/src/runs/shared/child-session.ts");
const { DIRS } = await import("../extensions/subagents/src/shared/types.ts");
const provider = fileURLToPath(new URL("./support/provider.ts", import.meta.url));
const agent = { name: "fixture", description: "Local fixture", source: "runtime", filePath: "", tools: ["read"], model: "tau-fixture/local", thinking: "off", inheritProjectContext: true, inheritGlobalContext: false, inheritSkills: false, systemPromptMode: "append", systemPrompt: "Return a short result.", extensions: [provider] };

test("native foreground and separate background runner use the real host SDK", { timeout: 60_000 }, async (t) => {
  t.after(async () => { await disposeChildSessions(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "FIXTURE_PROJECT_INSTRUCTION\n");
  const owner = randomUUID();
  const result = await runSync(root, [agent], "fixture", "Complete the fixture task", { runId: randomUUID(), parentSessionId: owner, cwd: root, context: "fresh", acceptance: false, timeoutMs: 20_000, sessionDir: path.join(root, "foreground"), projectTrusted: true });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.finalOutput, /fixture complete/);
  assert.match(result.finalOutput, /project context present/);
  const webAgent = { ...agent, name: "audit-fixture", tools: ["read", "web_search", "fetch_web_content", "get_cached_web_content"] };
  const webResult = await runSync(root, [webAgent], webAgent.name, "Inspect the available source tools", { runId: randomUUID(), parentSessionId: owner, context: "fresh", acceptance: false, timeoutMs: 20_000, projectTrusted: true });
  assert.equal(webResult.exitCode, 0, JSON.stringify(webResult));
  assert.ok(webResult.launchResolvedExtensions?.required?.includes("tau-web"), JSON.stringify(webResult.launchResolvedExtensions));
  assert.match(webResult.finalOutput, /web tools present/);
  const untrusted = await runSync(root, [agent], "fixture", "No trusted project context", { runId: randomUUID(), parentSessionId: owner, context: "fresh", acceptance: false, timeoutMs: 20_000, projectTrusted: false });
  assert.equal(untrusted.exitCode, 0, JSON.stringify(untrusted));
  assert.doesNotMatch(untrusted.finalOutput, /project context present/);
  const missing = { ...agent, name: "missing-resource", extensions: [provider, path.join(root, "missing-extension.ts")] };
  const missingResult = await runSync(root, [missing], missing.name, "Do not silently omit my extension", { runId: randomUUID(), parentSessionId: owner, context: "fresh", acceptance: false, timeoutMs: 20_000 });
  assert.equal(missingResult.exitCode, 1);
  assert.match(missingResult.error, /missing-extension/);
  const realFactory = createDefaultChildSessionFactory();
  const readerLoadout = [];
  const readerFactory = { dispose: () => realFactory.dispose(), create(launch) {
    assert.equal(launch.runtime.workspaceWriter, false);
    launch.hooks.push({ name: "local-test-provider", factory: fixtureProvider }, { name: "test-dynamic-tool", factory(api) {
      api.registerTool({ name: "write", label: "Fixture write", exposure: "direct", description: "Test a dynamic capability", parameters: Type.Object({ path: Type.String(), content: Type.String() }), async execute(_id, args) { fs.writeFileSync(args.path, args.content); return { content: [{ type: "text", text: "fixture write" }], details: {} }; } });
      api.on("before_agent_start", (event) => { api.setActiveTools(["read", "write"]); readerLoadout.push(api.getActiveTools()); event.systemPromptOptions.selectedTools = ["read", "write"]; });
    } });
    return realFactory.create(launch);
  } };
  const forbiddenPath = path.join(root, "forbidden-write.txt");
  try {
    const reader = await runSync(root, [{ ...agent, extensions: [] }], "fixture", `TAU_FIXTURE_WRITE:${forbiddenPath}`, { runId: randomUUID(), parentSessionId: owner, context: "fresh", acceptance: false, timeoutMs: 20_000, childSessionFactory: readerFactory });
    assert.equal(reader.exitCode, 0, JSON.stringify(reader));
    assert.equal(readerLoadout.length, 1, "fixture attempted a dynamic capability change");
    // Pi 0.99.1 can refuse the addition at its strict allowlist before Tau's
    // tool-call boundary; either boundary must prevent the actual write.
    assert.match(JSON.stringify(reader.messages), readerLoadout[0].includes("write") ? /admitted as a reader/ : /Tool write not found/);
    assert.equal(fs.existsSync(forbiddenPath), false);
  } finally { await realFactory.dispose(); }
  const waitFor = async (condition) => { const deadline = Date.now() + 20_000; while (!condition() && Date.now() < deadline) await delay(25); assert.ok(condition(), "fixture barrier deadline"); };
  const foregroundGate = path.join(root, "foreground-gate");
  const backgroundGate = path.join(root, "background-gate");
  const sharedOutput = path.join(root, "shared-output.txt");
  const foreground = runSync(root, [agent], "fixture", `TAU_FIXTURE_GATE:${foregroundGate}`, { runId: randomUUID(), parentSessionId: owner, cwd: root, context: "fresh", acceptance: false, timeoutMs: 20_000, outputPath: sharedOutput });
  await waitFor(() => fs.existsSync(`${foregroundGate}.entered`));
  const events = [];
  const dispatch = await executeAsyncSingle(randomUUID(), { agent: "fixture", task: `TAU_FIXTURE_GATE:${backgroundGate}`, output: sharedOutput, agentConfig: agent, ctx: { cwd: root, currentSessionId: owner, parentSessionId: owner, currentModel: { provider: "tau-fixture", id: "local" }, projectTrusted: true, pi: { events: { emit(name, value) { events.push({ name, value }); } }, sendMessage() {} } }, cwd: root, artifactConfig: { enabled: true }, artifactsDir: path.join(root, "artifacts"), sessionDir: path.join(root, "background"), shareEnabled: false, maxSubagentDepth: 2, context: "fresh", acceptance: false, timeoutMs: 20_000 });
  assert.notEqual(dispatch.isError, true, JSON.stringify(dispatch));
  assert.ok(dispatch.details.asyncId, JSON.stringify(dispatch));
  const eventsPath = path.join(dispatch.details.asyncDir, "events.jsonl");
  await waitFor(() => fs.existsSync(eventsPath) && fs.readFileSync(eventsPath, "utf8").includes("writer_queued"));
  assert.equal(fs.existsSync(`${backgroundGate}.entered`), false, "dispatch cannot release an active foreground writer");
  fs.writeFileSync(`${foregroundGate}.release`, "");
  const foregroundResult = await foreground;
  assert.equal(foregroundResult.exitCode, 0, JSON.stringify(foregroundResult));
  await waitFor(() => fs.existsSync(`${backgroundGate}.entered`));
  assert.match(fs.readFileSync(sharedOutput, "utf8"), /gate=foreground-gate/, "next writer enters only after output finalization");
  fs.writeFileSync(`${backgroundGate}.release`, "");
  const resultPath = path.join(DIRS.results, `${dispatch.details.asyncId}.json`);
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(resultPath) && Date.now() < deadline) await delay(100);
  assert.ok(fs.existsSync(resultPath), `Missing result: ${JSON.stringify(dispatch)}\n${fs.readdirSync(dispatch.details.asyncDir).map((f) => f.endsWith('.log') ? fs.readFileSync(path.join(dispatch.details.asyncDir, f), 'utf8') : f).join('\n')}`);
  const background = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(background.success, true, JSON.stringify(background));
  assert.equal(background.sessionId, owner);
  assert.match(JSON.stringify(background.results), /fixture complete/);
  assert.match(fs.readFileSync(sharedOutput, "utf8"), /gate=background-gate/, "queued writer must not claim its predecessor's output");
  const statusPath = path.join(dispatch.details.asyncDir, "status.json");
  while (Date.now() < deadline) {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    if (status.processTerminal?.state === "observed" || events.some((event) => event.name === "subagent:process-terminal")) break;
    await delay(100);
  }
  assert.equal(fs.existsSync(path.join(root, "git-attempted")), false, "native core must not probe Git");
});
