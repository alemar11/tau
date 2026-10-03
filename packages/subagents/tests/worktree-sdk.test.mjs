import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = fs.mkdtempSync(path.join(tmpdir(), "tau-worktree-sdk-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.TAU_SUBAGENTS_TEMP_ROOT = path.join(root, "state");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(root, "git-config"); fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
const { DIRS } = await import("../extensions/subagents/src/shared/types.ts");
const { disposeChildSessions } = await import("../extensions/subagents/src/runs/shared/child-session.ts");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
async function until(condition) {
  const deadline = Date.now() + 30_000;
  while (!condition() && Date.now() < deadline) await delay(25);
  assert.ok(condition(), "fixture barrier deadline exceeded");
}
function handoff(reference) {
  assert.ok(reference?.path, JSON.stringify(reference));
  const manifest = readJson(reference.path);
  return { manifest, tree: manifest.groups[0].cleanup.tasks[0], patch: manifest.groups[0].children[0]?.patch };
}

test("public native SDK tool isolates foreground, background and workflow writers", { timeout: 120_000 }, async (t) => {
  const cwd = path.join(root, "repo"); fs.mkdirSync(cwd);
  git(cwd, "init", "-q"); git(cwd, "config", "user.name", "Fixture"); git(cwd, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(cwd, "file.txt"), "original"); git(cwd, "add", "."); git(cwd, "commit", "-qm", "Fixture");
  const agentDir = process.env.PI_CODING_AGENT_DIR, settingsDir = path.join(agentDir, "tau-subagents");
  fs.mkdirSync(path.join(settingsDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(settingsDir, "config.json"), JSON.stringify({ worktreeBaseDir: path.join(root, "worktrees") }));
  const provider = fileURLToPath(new URL("./support/provider.ts", import.meta.url));
  fs.writeFileSync(path.join(settingsDir, "agents", "tree-fixture.md"), `---\nname: tree-fixture\ndescription: native worktree writer\nmodel: tau-fixture/local\ntools: read,write\nextensions: ${provider}\n---\nWrite the requested file, then report completion.\n`);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory({ packages: [fileURLToPath(new URL("../", import.meta.url))] }), noSkills: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: path.join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime, sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }) });
  const foregroundGate = path.join(root, "foreground"), backgroundGate = path.join(root, "background");
  const abort = new AbortController();
  t.after(async () => {
    for (const gate of [foregroundGate, backgroundGate]) fs.writeFileSync(`${gate}.release`, "");
    abort.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
    await disposeChildSessions();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: "json" });
  const tool = session.agent.state.tools.find((entry) => entry.name === "subagent"); assert.ok(tool);
  assert.ok(tool.parameters.properties.worktree); assert.ok(tool.parameters.properties.baseRef);
  const task = (label, gate) => `TAU_FIXTURE_WRITE:file.txt TAU_FIXTURE_CONTENT:${label}${gate ? ` TAU_FIXTURE_GATE:${gate}` : ""}`;
  const foreground = tool.execute("tree-foreground", { agent: "tree-fixture", task: task("foreground", foregroundGate), worktree: true, async: false }, abort.signal);
  // Attach an early rejection handler so a barrier failure is diagnostic, not unhandled.
  let foregroundFailure; void foreground.catch((error) => { foregroundFailure = error; });
  await until(() => fs.existsSync(`${foregroundGate}.entered`) || foregroundFailure);
  if (foregroundFailure) throw foregroundFailure;
  const dispatch = await tool.execute("tree-background", { agent: "tree-fixture", task: task("background", backgroundGate), isolation: "worktree", async: true }, abort.signal);
  assert.notEqual(dispatch.isError, true, JSON.stringify(dispatch));
  assert.ok(dispatch.details.asyncId, JSON.stringify(dispatch));
  await until(() => fs.existsSync(`${backgroundGate}.entered`));
  assert.equal(fs.existsSync(`${foregroundGate}.release`), false, "background enters while foreground is still active");
  fs.writeFileSync(`${foregroundGate}.release`, ""); fs.writeFileSync(`${backgroundGate}.release`, "");
  const foregroundResult = await foreground;
  assert.notEqual(foregroundResult.isError, true, JSON.stringify(foregroundResult));
  const fg = handoff(foregroundResult.details.parallelHandoff);
  const resultPath = path.join(DIRS.results, `${dispatch.details.asyncId}.json`);
  await until(() => fs.existsSync(resultPath));
  const backgroundResult = readJson(resultPath);
  assert.equal(backgroundResult.success, true, JSON.stringify(backgroundResult));
  for (const result of [foregroundResult.details.results[0], backgroundResult.results[0]]) {
    assert.deepEqual(result.effects?.trackedMutations?.changedFiles, ["file.txt"]);
    assert.equal(result.effects.trackedMutations.unavailable, undefined);
  }
  const statusPath = path.join(dispatch.details.asyncDir, "status.json");
  await until(() => readJson(statusPath).processTerminal?.state === "observed");
  const bg = handoff(readJson(statusPath).parallelHandoff);
  assert.notEqual(fg.tree.path, bg.tree.path); assert.notEqual(fg.tree.branch, bg.tree.branch);
  for (const [label, value] of [["foreground", fg], ["background", bg]]) {
    assert.equal(value.tree.preserved, true); assert.equal(value.tree.worktreeRemoved, false); assert.equal(value.tree.branchRemoved, false);
    assert.equal(git(value.tree.path, "branch", "--show-current"), value.tree.branch);
    assert.equal(fs.readFileSync(path.join(value.tree.path, "file.txt"), "utf8"), label);
    assert.equal(value.patch.error, undefined, JSON.stringify(value));
    assert.match(fs.readFileSync(value.patch.path, "utf8"), new RegExp(label));
  }
  assert.equal(fs.readFileSync(path.join(cwd, "file.txt"), "utf8"), "original");
  assert.equal(git(cwd, "status", "--porcelain"), "");

  const script = path.join(root, "workflow.js");
  fs.writeFileSync(script, `const children = await runs.all([{key:"left",agent:"tree-fixture",task:${JSON.stringify(task("left"))},async:false},{key:"right",agent:"tree-fixture",task:${JSON.stringify(task("right"))},async:false}]); return children.map(c => ({ok:c.ok,output:c.output}));`);
  const workflow = await tool.execute("tree-workflow", { workflow: script, worktree: true, async: false }, abort.signal);
  assert.notEqual(workflow.isError, true, JSON.stringify(workflow));
  assert.match(JSON.stringify(workflow), /fixture complete/);
  const trees = git(cwd, "worktree", "list", "--porcelain").split("\n\n").filter((entry) => entry.startsWith("worktree ")).map((entry) => entry.split("\n")[0].slice(9));
  const writes = trees.map((tree) => fs.readFileSync(path.join(tree, "file.txt"), "utf8"));
  assert.ok(writes.includes("left") && writes.includes("right"), JSON.stringify(writes));
  assert.equal(git(cwd, "status", "--porcelain"), "");

  const laneScript = path.join(root, "lanes.js");
  fs.writeFileSync(laneScript, `return await runs.lanes([{key:"retained",stages:[{key:"start",agent:"tree-fixture",task:"Inspect",async:false},{key:"follow",resume:"previous",task:"Continue inspection",async:false},{key:"last",resume:"previous",task:"Verify again",async:false}]}]);`);
  const beforeLanes = git(cwd, "worktree", "list", "--porcelain").split("worktree ").length;
  const lanes = await tool.execute("tree-lanes", { workflow: laneScript, worktree: true, async: false }, abort.signal);
  assert.notEqual(lanes.isError, true, JSON.stringify(lanes));
  assert.doesNotMatch(JSON.stringify(lanes.details.workflow?.value ?? lanes), /"state":"blocked"/);
  assert.equal(git(cwd, "worktree", "list", "--porcelain").split("worktree ").length, beforeLanes + 1, "lane resume reuses its foreground-managed tree");

  const managed = bg.manifest.runId;
  const head = git(cwd, "rev-parse", "HEAD");
  const recorded = await tool.execute("tree-evidence", { action: "lane.recordMerge", laneId: managed, handoffPath: readJson(statusPath).parallelHandoff.path, merge: { prNumber: 1, reviewedHead: head, mergeCommit: head, treeEquivalent: true, postMergeChecks: "recorded", attestedBy: "fixture", attestedAt: new Date().toISOString() } }, abort.signal);
  assert.match(JSON.stringify(recorded), /terminal-eligible/);
  const plan = await tool.execute("tree-plan", { action: "worktree.cleanup", mode: "plan", repo: cwd, handoffPath: readJson(statusPath).parallelHandoff.path }, abort.signal);
  assert.match(JSON.stringify(plan), /Plan-only mode/);
  assert.match(JSON.stringify(plan), /uncommitted or untracked changes/);
  await assert.rejects(tool.execute("tree-discard-headless", { action: "worktree.discard", handoffPath: readJson(statusPath).parallelHandoff.path }, abort.signal), /requires user confirmation/);
  assert.ok(fs.existsSync(bg.tree.path));
  await assert.rejects(tool.execute("tree-no-gist", { agent: "tree-fixture", task: "Do not upload", share: true }, abort.signal), /excluded session sharing/);

  const pauseGate = path.join(root, "pause");
  const pausedDispatch = await tool.execute("tree-pause", { agent: "tree-fixture", task: `Wait TAU_FIXTURE_GATE:${pauseGate}`, worktree: true, async: true }, abort.signal);
  await until(() => fs.existsSync(`${pauseGate}.entered`));
  await tool.execute("interrupt-tree", { action: "interrupt", id: pausedDispatch.details.asyncId }, abort.signal);
  const pausedStatusPath = path.join(pausedDispatch.details.asyncDir, "status.json");
  await until(() => readJson(pausedStatusPath).processTerminal?.state === "observed");
  assert.equal(readJson(pausedStatusPath).state, "paused");
  const retained = handoff(readJson(pausedStatusPath).parallelHandoff);
  const ownerPath = retained.tree.ownership.recordPath, originalOwner = fs.readFileSync(ownerPath, "utf8");
  fs.writeFileSync(ownerPath, JSON.stringify({ ...JSON.parse(originalOwner), token: "replaced-owner" }));
  await assert.rejects(tool.execute("stale-tree-resume", { action: "resume", id: pausedDispatch.details.asyncId, message: task("forbidden") }, abort.signal), /ownership mismatch/);
  assert.equal(fs.readFileSync(path.join(retained.tree.path, "file.txt"), "utf8"), "original");
  fs.writeFileSync(ownerPath, originalOwner);
  fs.writeFileSync(`${pauseGate}.release`, "");
  const treeCount = git(cwd, "worktree", "list", "--porcelain").split("worktree ").length;
  const resumed = await tool.execute("resume-tree", { action: "resume", id: pausedDispatch.details.asyncId, message: task("resumed") }, abort.signal);
  assert.ok(resumed.details.asyncId, JSON.stringify(resumed));
  const resumedResultPath = path.join(DIRS.results, `${resumed.details.asyncId}.json`);
  await until(() => fs.existsSync(resumedResultPath));
  assert.equal(readJson(resumedResultPath).success, true, JSON.stringify(readJson(resumedResultPath)));
  assert.deepEqual(readJson(resumedResultPath).results[0].effects?.trackedMutations?.changedFiles, ["file.txt"]);
  await until(() => readJson(path.join(resumed.details.asyncDir, "status.json")).processTerminal?.state === "observed");
  assert.equal(fs.readFileSync(path.join(retained.tree.path, "file.txt"), "utf8"), "resumed");
  assert.equal(git(cwd, "worktree", "list", "--porcelain").split("worktree ").length, treeCount, "resume must not allocate or replay the original worktree");

  fs.writeFileSync(ownerPath, JSON.stringify({ ...JSON.parse(originalOwner), token: "replaced-after-resume" }));
  await assert.rejects(tool.execute("stale-successor", { action: "resume", id: resumed.details.asyncId, message: "Do not launch" }, abort.signal), /ownership mismatch/);
  fs.writeFileSync(ownerPath, originalOwner);

  fs.writeFileSync(path.join(cwd, "uncommitted"), "preserve me");
  const before = git(cwd, "worktree", "list", "--porcelain");
  for (const async of [false, true]) {
    await assert.rejects(tool.execute(`dirty-${async}`, { agent: "tree-fixture", task: "Do not launch", worktree: true, async }, abort.signal), /clean git working tree/);
  }
  assert.equal(git(cwd, "worktree", "list", "--porcelain"), before);
  assert.equal(fs.readFileSync(path.join(cwd, "uncommitted"), "utf8"), "preserve me");
});
