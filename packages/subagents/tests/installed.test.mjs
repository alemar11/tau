import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// Copy the shipped resource layout under node_modules: native Node stripping
// refuses TS there, so this also exercises Pi/Jiti and the runner peer preload.
test("installed resource layout loads standalone and runs a native background child", { timeout: 45_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "tau-installed-"));
  const source = fileURLToPath(new URL("../", import.meta.url));
  const modules = path.join(dir, "node_modules");
  const installed = path.join(modules, "subagents");
  const savedEnv = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, TAU_SUBAGENTS_TEMP_ROOT: process.env.TAU_SUBAGENTS_TEMP_ROOT };
  process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
  process.env.TAU_SUBAGENTS_TEMP_ROOT = path.join(dir, "state");
  let session;
  t.after(async () => {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    for (const [key, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(modules, { recursive: true });
  const hostModules = path.resolve(source, "../../node_modules");
  for (const name of fs.readdirSync(hostModules)) if (!name.startsWith(".") && !["subagents", "web"].includes(name)) fs.symlinkSync(path.join(hostModules, name), path.join(modules, name));
  for (const [from, target] of [[source, installed], [path.resolve(source, "../web"), path.join(modules, "web")]]) {
    fs.mkdirSync(target, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8"));
    fs.copyFileSync(path.join(from, "package.json"), path.join(target, "package.json"));
    for (const name of manifest.files) if (fs.existsSync(path.join(from, name))) fs.cpSync(path.join(from, name), path.join(target, name), { recursive: true });
    if (fs.existsSync(path.join(from, "node_modules"))) fs.symlinkSync(path.join(from, "node_modules"), path.join(target, "node_modules"));
  }
  const profiles = path.join(process.env.PI_CODING_AGENT_DIR, "tau-subagents", "agents");
  fs.mkdirSync(profiles, { recursive: true });
  const provider = fileURLToPath(new URL("./support/provider.ts", import.meta.url));
  fs.writeFileSync(path.join(profiles, "installed-fixture.md"), `---\nname: installed-fixture\ndescription: installed resource fixture\nmodel: tau-fixture/local\ntools: read, web_search, fetch_web_content, get_cached_web_content\nextensions: ${provider}\n---\nReturn a short answer.\n`);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, noExtensions: true, additionalExtensionPaths: [path.join(installed, "extensions/subagents/index.ts")], noSkills: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null, modelsStorePath: path.join(dir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  ({ session } = await createAgentSession({ cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader, modelRuntime, sessionManager: SessionManager.inMemory(dir), settingsManager }));
  await session.bindExtensions({ mode: "json" });
  const tool = session.agent.state.tools.find((entry) => entry.name === "subagent");
  const dispatch = await tool.execute("installed-child", { agent: "installed-fixture", task: "Complete with installed resources" }, new AbortController().signal);
  assert.notEqual(dispatch.isError, true, JSON.stringify(dispatch));
  assert.ok(dispatch.details.asyncId, JSON.stringify(dispatch));
  const statusPath = path.join(dispatch.details.asyncDir, "status.json");
  let status;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(statusPath)) { status = JSON.parse(fs.readFileSync(statusPath, "utf8")); if (status.processTerminal?.state === "observed") break; }
    await delay(50);
  }
  assert.equal(status?.processTerminal?.state, "observed", JSON.stringify(status));
  const outcome = await tool.execute("installed-result", { action: "status", id: dispatch.details.asyncId, view: "transcript" }, new AbortController().signal);
  assert.match(JSON.stringify(outcome), /fixture complete/);
  assert.match(JSON.stringify(outcome), /web tools present/);
  assert.doesNotMatch(JSON.stringify(outcome), /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
});
