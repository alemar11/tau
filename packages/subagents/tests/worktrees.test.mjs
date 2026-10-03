import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(tmpdir(), "tau-worktrees-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.TAU_SUBAGENTS_TEMP_ROOT = path.join(root, "state");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(root, "empty-git-config");
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
const { createWorktrees, cleanupWorktrees, diffWorktrees, withWorktreeFinalization, withWorktreeTransaction, resolveExpectedWorktreeAgentCwd, resolveWorktreeProvider } = await import("../extensions/subagents/src/runs/shared/worktree.ts");
const { admitWriter } = await import("../extensions/subagents/src/runs/shared/writer-admission.ts");
const { phaseOneConfig } = await import("../extensions/subagents/src/shared/phase-one.ts");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repo() {
  const cwd = fs.mkdtempSync(path.join(root, "repo-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Fixture"); git(cwd, "config", "user.email", "fixture@example.invalid");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src", "file.txt"), "original\n");
  fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "Fixture");
  return cwd;
}
function options(runId, extra = {}) {
  return { writerIdentity: { rootSessionId: "root-session", runId, ancestors: [] }, baseDir: path.join(root, "trees"), ...extra };
}

function allocateProcess(cwd, runId, baseDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./support/worktree-child.mjs", import.meta.url)), JSON.stringify({ cwd, runId, options: options(runId, { baseDir }) })], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => { try { resolve({ code, ...JSON.parse(stdout) }); } catch { reject(new Error(`${stdout}\n${stderr}`)); } });
  });
}

test("native managed worktrees retain ownership, files and branches", { timeout: 60_000 }, async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await t.test("allocation isolates two writers, preserves a subdirectory and captures without changing the index", async () => {
    const cwd = repo(), runId = randomUUID();
    fs.mkdirSync(path.join(cwd, "node_modules")); fs.writeFileSync(path.join(cwd, "node_modules", "shared"), "dependency");
    const hook = path.join(cwd, ".git", "hooks", "post-checkout");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${path.join(root, "hook-ran")}'\n`, { mode: 0o755 });
    const setup = await createWorktrees(path.join(cwd, "src"), runId, 2, options(runId));
    assert.equal(setup.worktrees.length, 2);
    assert.notEqual(setup.worktrees[0].branch, setup.worktrees[1].branch);
    assert.equal(fs.existsSync(path.join(root, "hook-ran")), false, "allocation must not run implicit Git hooks");
    for (const [i, tree] of setup.worktrees.entries()) {
      assert.equal(tree.agentCwd, path.join(tree.path, "src"));
      assert.equal(tree.agentCwd, resolveExpectedWorktreeAgentCwd(path.join(cwd, "src"), runId, i, options(runId).baseDir));
      assert.equal(git(tree.path, "rev-parse", "HEAD"), setup.baseCommit);
      assert.equal(JSON.parse(fs.readFileSync(tree.ownership.recordPath)).token, tree.ownership.token);
      fs.writeFileSync(path.join(tree.agentCwd, "file.txt"), `writer ${i}\n`);
    }
    const leases = await Promise.all(setup.worktrees.map((tree, i) => admitWriter({ ...setup.writerIdentity, runId: `writer-${i}`, cwd: tree.agentCwd, deadlineAt: Date.now() + 1000 })));
    assert.equal(leases.length, 2, "different trees admit concurrently");
    await Promise.all(leases.map((lease) => lease.release()));
    const indexes = setup.worktrees.map((tree) => fs.readFileSync(git(tree.path, "rev-parse", "--git-path", "index")));
    const diffs = await withWorktreeFinalization(setup, () => diffWorktrees(setup, ["one", "two"], path.join(root, "patches")));
    assert.equal(diffs.length, 2);
    for (const [i, diff] of diffs.entries()) {
      assert.equal(diff.error, undefined, JSON.stringify(diff));
      assert.match(fs.readFileSync(diff.patchPath, "utf8"), new RegExp(`writer ${i}`));
      const tree = setup.worktrees[i];
      assert.deepEqual(fs.readFileSync(git(tree.path, "rev-parse", "--git-path", "index")), indexes[i]);
      assert.equal(fs.lstatSync(path.join(tree.path, "node_modules")).isSymbolicLink(), true);
      assert.equal(git(tree.path, "diff", "--cached"), "", "snapshot does not stage child files");
    }
    const report = cleanupWorktrees(setup, { kind: "preserve", capturedDiffs: diffs });
    assert.equal(report.pruned, false);
    assert.ok(report.tasks.every((task) => task.preserved && !task.worktreeRemoved && !task.branchRemoved));
    for (const tree of setup.worktrees) { assert.ok(fs.existsSync(tree.path)); assert.equal(git(tree.path, "branch", "--show-current"), tree.branch); }
    assert.equal(fs.readFileSync(path.join(cwd, "src", "file.txt"), "utf8"), "original\n");
    assert.equal(git(cwd, "status", "--porcelain"), "");
  });
  await t.test("an active/uncertain writer blocks snapshots, while queued writers stay FIFO on the same realpath", async () => {
    const cwd = repo(), id = randomUUID(), setup = await createWorktrees(cwd, id, 1, options(id));
    const tree = setup.worktrees[0], alias = path.join(root, "alias"); fs.symlinkSync(tree.path, alias);
    const lease = await admitWriter({ ...setup.writerIdentity, runId: "active-child", cwd: tree.agentCwd });
    let touched = false;
    await assert.rejects(withWorktreeFinalization(setup, () => { touched = true; }, Date.now() + 100), /deadline/);
    assert.equal(touched, false);
    let signalQueued; const queued = new Promise((resolve) => { signalQueued = resolve; });
    const order = [];
    const next = admitWriter({ ...setup.writerIdentity, runId: "next", cwd: alias, onWait: signalQueued, deadlineAt: Date.now() + 3000 }).then(async (l) => { order.push("next"); await l.release(); });
    await queued;
    const last = admitWriter({ ...setup.writerIdentity, runId: "last", cwd: tree.path, deadlineAt: Date.now() + 3000 }).then(async (l) => { order.push("last"); await l.release(); });
    assert.deepEqual(order, []);
    await lease.release(); await Promise.all([next, last]); assert.deepEqual(order, ["next", "last"]);
    await withWorktreeFinalization(setup, () => { touched = true; }); assert.equal(touched, true);
  });
  await t.test("cancellation, dirty sources, bad refs and optional providers fail without launching or deleting", async () => {
    const cwd = repo(), id = randomUUID();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(createWorktrees(cwd, id, 1, options(id, { signal: controller.signal })), /aborted/);
    await assert.rejects(createWorktrees(cwd, id, 1, options(id, { deadlineAt: Date.now() - 1 })), /deadline/);
    fs.writeFileSync(path.join(cwd, "dirty"), "leave me");
    await assert.rejects(createWorktrees(cwd, id, 1, options(id)), /clean git working tree/);
    assert.equal(fs.readFileSync(path.join(cwd, "dirty"), "utf8"), "leave me"); fs.unlinkSync(path.join(cwd, "dirty"));
    await assert.rejects(createWorktrees(cwd, id, 1, options(id, { baseRef: "missing-ref" })), /could not be resolved/);
    await assert.rejects(createWorktrees(cwd, id, 1, options(id, { baseRef: "HEAD~1" })), /valid Git ref/);
    await assert.rejects(createWorktrees(cwd, id, 1, options(id, { provider: "worktrunk" })), /native Git/);
    await assert.rejects(createWorktrees(cwd, id, 1, options(id, { setupHook: { hookPath: "ignored" } })), /hooks remain deferred/);
    assert.equal(resolveWorktreeProvider(undefined), "native");
    assert.throws(() => resolveWorktreeProvider("auto"), /native Git/);
    assert.equal(phaseOneConfig({ worktree: true }).worktreeProvider, "native");
    assert.throws(() => phaseOneConfig({ worktreeProvider: "worktrunk" }), /native Git/);
    assert.equal(git(cwd, "worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
  });
  await t.test("a cancelled setup turn exits promptly without opening the active transaction to its successor", async () => {
    const cwd = repo(), id = randomUUID();
    let entered, release;
    const ready = new Promise((resolve) => { entered = resolve; });
    const barrier = new Promise((resolve) => { release = resolve; });
    const active = withWorktreeTransaction(async () => { entered(); await barrier; });
    await ready;
    try {
      await assert.rejects(createWorktrees(cwd, id, 1, options(id, { deadlineAt: Date.now() + 50 })), /deadline/);
      let enteredNext = false;
      const controller = new AbortController();
      const next = withWorktreeTransaction(() => { enteredNext = true; }, { signal: controller.signal });
      const rejection = assert.rejects(next, /aborted/);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(enteredNext, false);
      controller.abort(); await rejection;
      assert.equal(git(cwd, "worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
    } finally { release(); await active; }
    const setup = await createWorktrees(cwd, id, 1, options(id));
    assert.equal(setup.worktrees.length, 1);
  });
  await t.test("cancelled partial allocations and replaced ownership are retained", async () => {
    const cwd = repo(), id = randomUUID(), controller = new AbortController(); let tree;
    await assert.rejects(createWorktrees(cwd, id, 2, options(id, { signal: controller.signal, onProgress(progress) {
      if (progress.phase === "validated") { tree = progress.setup.worktrees[0]; controller.abort(); }
    } })), /aborted/);
    assert.ok(tree && fs.existsSync(tree.path)); assert.equal(git(tree.path, "branch", "--show-current"), tree.branch);
    const anotherId = randomUUID(), setup = await createWorktrees(cwd, anotherId, 1, options(anotherId));
    const owner = setup.worktrees[0].ownership;
    const record = JSON.parse(fs.readFileSync(owner.recordPath)); record.token = randomUUID(); fs.writeFileSync(owner.recordPath, JSON.stringify(record));
    await assert.rejects(withWorktreeFinalization(setup, () => assert.fail("stale owner captured a successor")), /ownership mismatch/);
    assert.ok(fs.existsSync(setup.worktrees[0].path));
  });
  await t.test("named base refs, unsafe roots, inherited Git paths and replaced directories cannot redirect ownership", async () => {
    const cwd = repo(), id = randomUUID();
    git(cwd, "branch", "selected-base");
    fs.writeFileSync(path.join(cwd, "src", "file.txt"), "new head"); git(cwd, "commit", "-qam", "New head");
    const previous = process.env.GIT_DIR; process.env.GIT_DIR = path.join(root, "not-the-repo");
    let setup;
    try { setup = await createWorktrees(cwd, id, 1, options(id, { baseRef: "refs/heads/selected-base" })); }
    finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
    assert.equal(fs.readFileSync(path.join(setup.worktrees[0].path, "src", "file.txt"), "utf8"), "original\n");
    assert.equal(fs.readFileSync(path.join(cwd, "src", "file.txt"), "utf8"), "new head");
    await assert.rejects(createWorktrees(cwd, randomUUID(), 1, options(id, { baseDir: path.join(cwd, "unsafe") })), /inside the repository/);
    assert.equal(fs.existsSync(path.join(cwd, "unsafe")), false);
    const unsafeLink = path.join(root, "unsafe-link"); fs.symlinkSync(cwd, unsafeLink);
    await assert.rejects(createWorktrees(cwd, randomUUID(), 1, options(id, { baseDir: unsafeLink })), /inside the repository/);
    const tree = setup.worktrees[0];
    fs.renameSync(tree.path, `${tree.path}-retained`); fs.mkdirSync(tree.path);
    await assert.rejects(withWorktreeFinalization(setup, () => assert.fail("replacement accepted")), /directory was replaced/);
    assert.ok(fs.existsSync(`${tree.path}-retained`));
  });
  await t.test("malformed reservations cannot be reclaimed after process exit", async () => {
    const cwd = repo(), id = randomUUID(), setup = await createWorktrees(cwd, id, 1, options(id));
    const tree = setup.worktrees[0];
    fs.writeFileSync(tree.ownership.recordPath, "{broken");
    await assert.rejects(withWorktreeFinalization(setup, () => assert.fail("malformed owner accepted")));
    git(cwd, "worktree", "remove", tree.path); git(cwd, "branch", "-D", tree.branch);
    await assert.rejects(createWorktrees(cwd, id, 1, options(id)), /already reserved/);
    assert.equal(fs.readFileSync(tree.ownership.recordPath, "utf8"), "{broken");
  });
  await t.test("separate processes cannot claim or remove the same branch, including after allocator exit", async () => {
    const cwd = repo(), id = randomUUID();
    const attempts = await Promise.all([allocateProcess(cwd, id, path.join(root, "process-a")), allocateProcess(cwd, id, path.join(root, "process-b"))]);
    const winner = attempts.find((a) => a.code === 0); assert.ok(winner, JSON.stringify(attempts));
    assert.equal(attempts.filter((a) => a.code === 0).length, 1, JSON.stringify(attempts));
    assert.ok(fs.existsSync(winner.setup.worktrees[0].path));
    const retry = await allocateProcess(cwd, id, path.join(root, "process-c")); assert.notEqual(retry.code, 0);
    assert.ok(fs.existsSync(winner.setup.worktrees[0].path));
    assert.equal(git(winner.setup.worktrees[0].path, "branch", "--show-current"), winner.setup.worktrees[0].branch);
  });
});
