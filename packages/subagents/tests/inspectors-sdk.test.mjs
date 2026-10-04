import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerInspector } from "../extensions/subagents/src/api/inspectors.ts";

async function until(condition) {
  const end = Date.now() + 30_000;
  while (!condition() && Date.now() < end) await delay(20);
  assert.ok(condition(), "fixture deadline exceeded");
}
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));

test("real SDK inspector actions do not settle or stop a live native writer", { timeout: 60_000 }, async t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "tau-inspectors-sdk-"));
  const env = Object.fromEntries(["PI_CODING_AGENT_DIR", "TAU_SUBAGENTS_TEMP_ROOT", "HERDR_ENV", "__CFBundleIdentifier"].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.TAU_SUBAGENTS_TEMP_ROOT = path.join(root, "state");
  process.env.HERDR_ENV = "0"; delete process.env.__CFBundleIdentifier;
  const { inspectWriterScope } = await import("../extensions/subagents/src/runs/shared/writer-admission.ts");
  const { disposeChildSessions } = await import("../extensions/subagents/src/runs/shared/child-session.ts");
  const agentDir = process.env.PI_CODING_AGENT_DIR, configDir = path.join(agentDir, "tau-subagents");
  fs.mkdirSync(path.join(configDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ authorityPolicy: { steerRun: "forbid", stopRun: "forbid" } }));
  const provider = fileURLToPath(new URL("./support/provider.ts", import.meta.url));
  fs.writeFileSync(path.join(configDir, "agents", "fixture.md"), `---\nname: fixture\ndescription: local fixture\nmodel: tau-fixture/local\ntools: read,write\nextensions: ${provider}\n---\nDo the task.\n`);
  const eventBus = createEventBus();
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, eventBus, settingsManager: SettingsManager.inMemory({ packages: [fileURLToPath(new URL("../", import.meta.url))] }), noSkills: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: path.join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const manager = SessionManager.inMemory(root);
  const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, modelRuntime, sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }) });
  await session.bindExtensions({ mode: "json" });
  const tool = session.agent.state.tools.find(tool => tool.name === "subagent"); assert.ok(tool);
  const gate = path.join(root, "gate");
  let statusFile;
  t.after(async () => {
    fs.writeFileSync(`${gate}.release`, "");
    if (statusFile) await until(() => json(statusFile).processTerminal?.state === "observed").catch(() => {});
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
    await disposeChildSessions();
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (!statusFile || json(statusFile).processTerminal?.state === "observed") fs.rmSync(root, { recursive: true, force: true });
  });
  let owned = false;
  const calls = [];
  const reply = text => ({ content: [{ type: "text", text }], details: { mode: "management", results: [] } });
  const registration = registerInspector({ events: eventBus }, {
    name: "fixture", available: () => true, owns: () => owned,
    async open(context, launch) {
      calls.push("open"); owned = true;
      assert.equal(context.target.status.sessionId, manager.getSessionId());
      assert.equal(launch.allowStop, false); assert.equal(launch.allowSteer, false);
      return reply("fixture inspector open");
    },
    async status() { calls.push("status"); return reply("fixture inspector present"); },
    async close() { calls.push("close"); owned = false; return reply("fixture inspector closed"); },
  });
  const execute = params => tool.execute(`inspector-${calls.length}`, params, new AbortController().signal);
  const run = await execute({ agent: "fixture", task: `TAU_FIXTURE_GATE:${gate}`, async: true });
  const id = run.details.asyncId, dir = run.details.asyncDir;
  assert.ok(id && dir, JSON.stringify(run)); statusFile = path.join(dir, "status.json");
  await until(() => fs.existsSync(`${gate}.entered`));
  const scope = { cwd: root, rootSessionId: manager.getSessionId() };
  assert.equal(inspectWriterScope(scope), "active");
  const before = json(statusFile).processTerminal;
  const command = await execute({ action: "inspector.command", id });
  assert.match(JSON.stringify(command), /inspector-runner\.mjs/);
  assert.deepEqual(calls, []);
  for (const action of ["inspector.open", "inspector.status", "inspector.close"]) {
    const result = await execute({ action, id }); assert.notEqual(result.isError, true);
  }
  assert.deepEqual(calls, ["open", "status", "close"]);
  assert.equal(inspectWriterScope(scope), "active");
  assert.deepEqual(json(statusFile).processTerminal, before);
  const control = path.join(dir, "control");
  for (const name of fs.existsSync(control) ? fs.readdirSync(control, { recursive: true }) : []) {
    if (name.endsWith(".json")) assert.ok(!["stop", "steer", "interrupt"].includes(json(path.join(control, name)).type), name);
  }
  await assert.rejects(execute({ action: "project.open", cwd: root }), /disabled/);
  await assert.rejects(execute({ action: "inspector.command", dir: root }), /outside trusted/);
  registration.dispose();
  fs.writeFileSync(`${gate}.release`, "");
  await until(() => json(statusFile).processTerminal?.state === "observed");
  assert.equal(inspectWriterScope(scope), "idle");
});
