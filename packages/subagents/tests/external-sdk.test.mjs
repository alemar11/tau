import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { writeNodeCommand } from "./support/node-command.ts";

const root = fs.mkdtempSync(path.join(tmpdir(), "tau-external-sdk-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.TAU_SUBAGENTS_TEMP_ROOT = path.join(root, "state");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(root, "git-config"); fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
const { DIRS } = await import("../extensions/subagents/src/shared/types.ts");
const queueWaiting = () => {
  const dir = path.join(process.env.TAU_SUBAGENTS_TEMP_ROOT, "writer-admission-v1");
  return fs.existsSync(dir) ? fs.readdirSync(dir).reduce((sum, name) => sum + json(path.join(dir, name, "queue.json")).waiting.length, 0) : 0;
};
const { disposeChildSessions } = await import("../extensions/subagents/src/runs/shared/child-session.ts");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
async function until(condition) {
  const deadline = Date.now() + 30_000;
  while (!condition() && Date.now() < deadline) await delay(20);
  assert.ok(condition(), "fixture barrier deadline exceeded");
}

test("real SDK dispatches only opted-in CLI adapters with writer admission, final receipts and retained worktrees", { timeout: 180_000, skip: process.platform === "win32" ? "POSIX process-group validation" : false }, async (t) => {
  const cwd = path.join(root, "repo"), bin = path.join(root, "bin");
  fs.mkdirSync(cwd); fs.mkdirSync(bin);
  git(cwd, "init", "-q"); git(cwd, "config", "user.name", "Fixture"); git(cwd, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(cwd, "file.txt"), "original"); git(cwd, "add", "."); git(cwd, "commit", "-qm", "Fixture");
  const agentDir = process.env.PI_CODING_AGENT_DIR, settingsDir = path.join(agentDir, "tau-subagents"), profiles = path.join(settingsDir, "agents");
  fs.mkdirSync(profiles, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, "config.json"), JSON.stringify({ worktreeBaseDir: path.join(root, "worktrees") }));
  const fixture = new URL("./support/external-cli-fixture.mjs", import.meta.url).href;
  for (const adapter of ["claude-code", "codex-exec", "cursor-agent"]) {
    const command = writeNodeCommand(bin, adapter, `import(${JSON.stringify(fixture)}).then(m => m.run(${JSON.stringify(adapter)})).catch(error => { console.error(error); process.exitCode = 1; });`);
    fs.writeFileSync(path.join(profiles, `${adapter}-fixture.md`), `---\nname: ${adapter}-fixture\ndescription: local CLI fixture\nrunner:\n  type: external-cli\n  adapter: ${adapter}-writer\n  command: ${JSON.stringify(command)}\n---\nDo exactly the task.\n`);
  }
  const provider = fileURLToPath(new URL("./support/provider.ts", import.meta.url));
  fs.writeFileSync(path.join(profiles, "native-fixture.md"), `---\nname: native-fixture\ndescription: native fixture\nmodel: tau-fixture/local\ntools: read,write\nextensions: ${provider}\n---\nDo exactly the task.\n`);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory({ packages: [fileURLToPath(new URL("../", import.meta.url))] }), noSkills: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: path.join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime, sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }) });
  await session.bindExtensions({ mode: "json" });
  const tool = session.agent.state.tools.find((entry) => entry.name === "subagent"); assert.ok(tool);
  const abort = new AbortController(), dispatches = [], gates = [];
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  t.after(async () => {
    for (const gate of gates) fs.writeFileSync(`${gate}.release`, "");
    abort.abort();
    for (const receipt of dispatches) {
      const statusPath = path.join(receipt.asyncDir, "status.json");
      if (fs.existsSync(statusPath) && ["running", "pending", "queued"].includes(json(statusPath).state)) {
        await tool.execute(`cleanup-${receipt.asyncId}`, { action: "stop", id: receipt.asyncId }, new AbortController().signal).catch(() => {});
      }
    }
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
    await disposeChildSessions();
    process.env.PATH = oldPath;
    // Preserve diagnostics rather than deleting directories under uncertain writers.
    if (dispatches.every(d => fs.existsSync(path.join(d.asyncDir, "status.json")) && json(path.join(d.asyncDir, "status.json")).processTerminal?.state === "observed")) fs.rmSync(root, { recursive: true, force: true });
  });
  let counter = 0;
  const execute = params => tool.execute(`external-${counter++}`, params, abort.signal);
  async function start(params) {
    const result = await execute(params);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(result.details.asyncId, JSON.stringify(result)); dispatches.push(result.details);
    return result.details;
  }
  async function publishedResult(receipt) {
    const resultPath = path.join(DIRS.results, `${receipt.asyncId}.json`);
    let result;
    await until(() => {
      if (!fs.existsSync(resultPath)) return false;
      result = json(resultPath);
      return true;
    });
    return result;
  }
  async function finish(receipt, success = true) {
    // Delivery may consume the publication while process settlement is pending.
    // Capture the actual result first; still require independent terminal proof.
    const result = await publishedResult(receipt), statusPath = path.join(receipt.asyncDir, "status.json");
    await until(() => json(statusPath).processTerminal?.state === "observed");
    const status = json(statusPath);
    assert.equal(result.success, success, JSON.stringify(result));
    if (status.steps.some(step => step.externalProcess?.pid)) {
      assert.ok(status.processTerminal.instances.some(instance => instance.kind === "external-writer" && instance.processTree.state === "observed"), JSON.stringify(status.processTerminal));
    }
    return { result, status };
  }
  const gate = name => { const p = path.join(root, name); gates.push(p); return p; };
  const task = (label, barrier) => `TAU_FIXTURE_WRITE:file.txt TAU_FIXTURE_CONTENT:${label}${barrier ? ` TAU_FIXTURE_GATE:${barrier}` : ""}`;
  const noGit = path.join(root, "git-called");
  const gitShim = writeNodeCommand(bin, "git", `require('fs').appendFileSync(${JSON.stringify(noGit)}, process.argv.join(' ')+'\\n'); process.exit(91);`);

  // A native foreground writer blocks a CLI before preflight/spawn; another
  // native writer then waits for the CLI, using the same root session and cwd.
  const nativeGate = gate("native"), externalGate = gate("external");
  let nativeError;
  const native = execute({ agent: "native-fixture", task: task("native", nativeGate), async: false });
  void native.catch(error => { nativeError = error; });
  await until(() => fs.existsSync(`${nativeGate}.entered`) || nativeError); if (nativeError) throw nativeError;
  const external = await start({ agent: "claude-code-fixture", task: task("cli", externalGate), model: "sonnet:high" });
  await until(() => queueWaiting() > 0);
  assert.equal(fs.existsSync(`${externalGate}.entered`), false);
  fs.writeFileSync(`${nativeGate}.release`, ""); assert.notEqual((await native).isError, true);
  await until(() => fs.existsSync(`${externalGate}.entered`));
  const entered = json(`${externalGate}.entered`);
  assert.ok(entered.args.includes("sonnet") && entered.args.includes("high"));
  const successor = execute({ agent: "native-fixture", task: task("successor"), async: false });
  void successor.catch(() => {});
  await until(() => queueWaiting() > 0);
  assert.equal(fs.readFileSync(path.join(cwd, "file.txt"), "utf8"), "native");
  fs.writeFileSync(`${externalGate}.release`, "");
  await finish(external); assert.notEqual((await successor).isError, true);
  assert.equal(fs.readFileSync(path.join(cwd, "file.txt"), "utf8"), "successor");
  assert.equal(fs.existsSync(noGit), false, fs.existsSync(noGit) ? fs.readFileSync(noGit, "utf8") : "");

  for (const adapter of ["codex-exec", "cursor-agent"]) {
    const { result } = await finish(await start({ agent: `${adapter}-fixture`, task: "Inspect" }));
    assert.match(result.results[0].output, new RegExp(`external fixture complete: ${adapter}`));
  }
  await assert.rejects(execute({ agent: "claude-code-fixture", task: "Never launch", async: false }), /background execution only/);
  const bad = await finish(await start({ agent: "claude-code-fixture", task: "TAU_FIXTURE_MALFORMED" }), false);
  assert.match(JSON.stringify(bad.result), /malformed JSONL/);
  await assert.rejects(execute({ action: "resume", id: external.asyncId, message: "Do not resume" }), /cannot resume|not support/);

  // Stop both a queued and a running CLI. Neither a stop receipt nor root exit
  // alone suffices for writer release; the next writer must actually launch.
  const stopGate = gate("stop");
  const holder = await start({ agent: "claude-code-fixture", task: `Wait TAU_FIXTURE_GATE:${stopGate}` });
  await until(() => fs.existsSync(`${stopGate}.entered`));
  const never = gate("never");
  const queued = await start({ agent: "claude-code-fixture", task: `Never launch TAU_FIXTURE_GATE:${never}` });
  await until(() => queueWaiting() > 0);
  await execute({ action: "stop", id: queued.asyncId }); await finish(queued, false);
  assert.equal(fs.existsSync(`${never}.entered`), false);
  await execute({ action: "stop", id: holder.asyncId }); await finish(holder, false);
  await finish(await start({ agent: "claude-code-fixture", task: "Launch after stopped writer" }));

  assert.equal(fs.existsSync(noGit), false);
  fs.rmSync(gitShim); git(cwd, "add", "."); git(cwd, "commit", "-qm", "Fixture writes");
  const isolated = await finish(await start({ agent: "codex-exec-fixture", task: task("isolated"), worktree: true }));
  const manifest = json(isolated.status.parallelHandoff.path), retained = manifest.groups[0].cleanup.tasks[0];
  assert.equal(retained.preserved, true); assert.equal(retained.worktreeRemoved, false);
  assert.equal(fs.readFileSync(path.join(retained.path, "file.txt"), "utf8"), "isolated");
  assert.equal(fs.readFileSync(path.join(cwd, "file.txt"), "utf8"), "successor");
  assert.deepEqual(isolated.result.results[0].effects.trackedMutations.changedFiles, ["file.txt"]);

  const script = path.join(root, "external-workflow.js");
  fs.writeFileSync(script, 'const child = await runs.run("cli",{agent:"cursor-agent-fixture",task:"Inspect"}); return {ok:child.ok,output:child.output,resumability:child.resumability,externalAdapter:child.externalAdapter};');
  const workflow = await execute({ workflow: script, async: false });
  assert.notEqual(workflow.isError, true, JSON.stringify(workflow));
  assert.match(JSON.stringify(workflow), /external fixture complete: cursor-agent/);
  assert.match(JSON.stringify(workflow), /not-resumable/);

  // Inject an unprovable census after a real probe exits. Neither runner exit
  // nor a later queued timeout may silently reclaim its writer ownership.
  const psShim = writeNodeCommand(bin, "ps", 'process.stderr.write("fixture census unavailable"); process.exit(1);');
  const uncertain = await start({ agent: "cursor-agent-fixture", task: "Never execute after unknown preflight" });
  const uncertainStatus = path.join(uncertain.asyncDir, "status.json");
  const uncertainResult = await publishedResult(uncertain);
  await until(() => json(uncertainStatus).processTerminal?.state === "unknown");
  assert.equal(uncertainResult.success, false);
  fs.rmSync(psShim);
  const blockedGate = gate("unknown-owner-blocked");
  await assert.rejects(execute({ agent: "native-fixture", task: `Do not launch TAU_FIXTURE_GATE:${blockedGate}`, async: false, timeoutMs: 500 }), /timed out|deadline|aborted/i);
  assert.equal(fs.existsSync(`${blockedGate}.entered`), false);
  assert.equal(queueWaiting(), 0);
  const writerDir = path.join(process.env.TAU_SUBAGENTS_TEMP_ROOT, "writer-admission-v1");
  assert.ok(fs.readdirSync(writerDir).some(name => json(path.join(writerDir, name, "queue.json")).owner?.runId === `${uncertain.asyncId}:0`));
  const privatePrompts = fs.readdirSync(uncertain.asyncDir).filter(name => name.includes("cursor") && fs.statSync(path.join(uncertain.asyncDir, name)).isDirectory());
  assert.ok(privatePrompts.length > 0, "unknown settlement retains private prompt directories");
});
