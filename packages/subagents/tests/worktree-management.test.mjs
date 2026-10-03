import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir, devNull } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

const root = fs.mkdtempSync(path.join(tmpdir(), "tau-tree-management-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.TAU_SUBAGENTS_TEMP_ROOT = path.join(root, "state");
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const { createWorktrees, diffWorktrees, cleanupWorktrees, withWorktreeFinalization } = await import("../extensions/subagents/src/runs/shared/worktree.ts");
const { writeParallelHandoffGroup, discardPreservedWorktrees, readParallelHandoffManifest, recordParallelHandoffMerge, formatStoredParallelHandoffCleanup, resolveManagedWorktreeReference } = await import("../extensions/subagents/src/runs/shared/parallel-handoff.ts");
const { createWorktreeCleanupPlan } = await import("../extensions/subagents/src/runs/shared/worktree-cleanup-plan.ts");
const { admitWriter } = await import("../extensions/subagents/src/runs/shared/writer-admission.ts");
const { stableJsonDigest } = await import("../extensions/subagents/src/shared/launch-contract.ts");
const git = (cwd, ...args) => execFileSync("git", ["-c", `core.hooksPath=${devNull}`, "-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const settled = { foregroundRunOwnership: () => "terminal" };
const confirmed = { kind: "confirmed" };
async function fixture({ dirty = false, source = "foreground" } = {}) {
  const cwd = fs.mkdtempSync(path.join(root, "repo-")), id = randomUUID();
  git(cwd, "init", "-q"); git(cwd, "config", "user.name", "Fixture"); git(cwd, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(cwd, "file.txt"), "original");
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "Fixture");
  const baseDir = path.join(root, "trees");
  const setup = await createWorktrees(cwd, id, 1, { baseDir, writerIdentity: { rootSessionId: "root-session", runId: id, ancestors: [] } });
  const tree = setup.worktrees[0];
  if (dirty) fs.writeFileSync(path.join(tree.path, "file.txt"), "child work");
  const dir = path.join(root, "reports", id); fs.mkdirSync(dir, { recursive: true });
  const diffs = await withWorktreeFinalization(setup, () => diffWorktrees(setup, ["worker"], path.join(dir, "diffs")));
  assert.equal(diffs[0].error, undefined);
  const manifestPath = path.join(dir, "handoff.json");
  writeParallelHandoffGroup({ manifestPath, runId: id, mode: "single", source, cwd, stepIndex: 0, flatStartIndex: 0, setup, diffs, cleanup: cleanupWorktrees(setup), results: [{ agent: "worker", status: "completed", summary: "Done" }] });
  const plan = () => createWorktreeCleanupPlan({ repo: cwd, handoffPath: manifestPath, worktreeBaseDir: baseDir, ...settled });
  return { cwd, id, setup, tree, dir, manifestPath, plan };
}

test("Git cleanup plans and explicit discard preserve uncertain or unrelated work", { timeout: 60_000 }, async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await t.test("planning inspects native hashed roots but never removes a branch or worktree", async () => {
    const f = await fixture();
    const foreign = path.join(root, "foreign"); git(f.cwd, "worktree", "add", "-qb", "foreign", foreign);
    const before = git(f.cwd, "worktree", "list", "--porcelain");
    const { plan, planPath } = f.plan();
    assert.ok(fs.existsSync(planPath));
    assert.equal(plan.entries.find((e) => e.path === fs.realpathSync(f.tree.path)).state, "safe");
    assert.equal(plan.entries.find((e) => e.path === fs.realpathSync(foreign)).decision, "unknown");
    assert.equal(git(f.cwd, "worktree", "list", "--porcelain"), before);
    fs.writeFileSync(path.join(f.tree.path, "file.txt"), "unreviewed");
    assert.equal(f.plan().plan.entries.find((e) => e.path === fs.realpathSync(f.tree.path)).state, "dirty");
  });
  await t.test("planning compares a committed divergence to its retained patch without staging", async () => {
    const f = await fixture({ dirty: true });
    git(f.tree.path, "add", "."); git(f.tree.path, "commit", "-qm", "Child work");
    const index = path.resolve(f.tree.path, git(f.tree.path, "rev-parse", "--git-path", "index"));
    const before = fs.readFileSync(index);
    const entry = f.plan().plan.entries[0];
    assert.equal(entry.state, "safe");
    assert.equal(entry.willDeleteBranch, false);
    assert.deepEqual(fs.readFileSync(index), before);
    assert.ok(fs.existsSync(f.tree.path));
  });
  await t.test("active/unknown writers and missing terminal evidence block discard", async () => {
    const f = await fixture();
    const lease = await admitWriter({ ...f.setup.writerIdentity, runId: "still-writing", cwd: f.tree.agentCwd });
    try {
      assert.equal(f.plan().plan.entries[0].state, "active");
      await assert.rejects(discardPreservedWorktrees(f.manifestPath, confirmed, settled), /writer is active or unknown/);
    } finally { await lease.release(); }
    await assert.rejects(discardPreservedWorktrees(f.manifestPath, confirmed), /not provably terminal/);
    await assert.rejects(discardPreservedWorktrees(f.manifestPath, { kind: "policy" }, settled), /authorization/);
    assert.throws(() => cleanupWorktrees(f.setup, { kind: "discard", authorization: confirmed }), /writer lease/);
    assert.throws(() => cleanupWorktrees(f.setup, { kind: "setup-rollback" }), /Automatic/);
    const owner = JSON.parse(fs.readFileSync(f.tree.ownership.recordPath));
    owner.token = "replaced"; fs.writeFileSync(f.tree.ownership.recordPath, JSON.stringify(owner));
    await assert.rejects(discardPreservedWorktrees(f.manifestPath, confirmed, settled), /ownership mismatch/);
    assert.equal(f.plan().plan.entries[0].state, "unknown");
    assert.ok(fs.existsSync(f.tree.path));
  });
  await t.test("lost writer storage remains unknown and retained foreground history keeps ownership evidence", async () => {
    const f = await fixture();
    const { persistForegroundRunHistory, restoreForegroundRunHistory } = await import("../extensions/subagents/src/runs/foreground/foreground-history.ts");
    const state = { currentSessionId: "root-session", foregroundRuns: new Map([[f.id, { runId: f.id, mode: "single", cwd: f.tree.agentCwd, sessionId: "root-session", updatedAt: Date.now(), managedWorktreeHandoff: f.manifestPath, children: [{ agent: "worker", index: 0, status: "completed" }] }]]) };
    persistForegroundRunHistory(state, { resultsDir: f.dir });
    const restored = { currentSessionId: "root-session" };
    assert.equal(restoreForegroundRunHistory(restored, { resultsDir: f.dir }), 1);
    assert.equal(restored.foregroundRuns.get(f.id).managedWorktreeHandoff, f.manifestPath);
    const owner = JSON.parse(fs.readFileSync(f.tree.ownership.recordPath));
    assert.throws(() => resolveManagedWorktreeReference({ path: f.manifestPath, runId: f.id, index: 0 }, "different-root"), /root session mismatch/);
    owner.writerStorageRoot = path.join(root, "lost-state");
    fs.writeFileSync(f.tree.ownership.recordPath, JSON.stringify(owner));
    assert.equal(f.plan().plan.entries[0].state, "unknown");
    assert.throws(() => resolveManagedWorktreeReference({ path: f.manifestPath, runId: f.id, index: 0 }), /original writer storage/);
    await assert.rejects(discardPreservedWorktrees(f.manifestPath, confirmed, settled), /writer is active or unknown/);
    assert.ok(fs.existsSync(f.tree.path));
  });
  await t.test("confirmation binds the manifest and dirty discard never prunes foreign registrations", async () => {
    const f = await fixture({ dirty: true });
    const before = readParallelHandoffManifest(f.manifestPath), digest = stableJsonDigest(before);
    before.groups[0].children[0].summary = "changed after review";
    fs.writeFileSync(f.manifestPath, JSON.stringify(before));
    await assert.rejects(discardPreservedWorktrees(f.manifestPath, confirmed, { ...settled, expectedDigest: digest }), /changed since discard confirmation/);
    assert.ok(fs.existsSync(f.tree.path));
    const foreign = path.join(root, "missing-foreign"); git(f.cwd, "worktree", "add", "-qb", "missing-foreign", foreign);
    fs.rmSync(foreign, { recursive: true, force: true });
    const discarded = await discardPreservedWorktrees(f.manifestPath, confirmed, settled);
    assert.equal(discarded.manifest.groups[0].cleanup.state, "complete");
    assert.equal(discarded.manifest.groups[0].cleanup.pruned, false);
    assert.equal(fs.existsSync(f.tree.path), false);
    assert.throws(() => git(f.cwd, "show-ref", "--verify", `refs/heads/${f.tree.branch}`));
    assert.match(git(f.cwd, "worktree", "list", "--porcelain"), /missing-foreign/);
    assert.equal(fs.readFileSync(path.join(f.cwd, "file.txt"), "utf8"), "original");
    assert.ok(fs.existsSync(f.tree.ownership.recordPath), "creation reservation is not reclaimed");
  });
  await t.test("a branch checked out elsewhere survives partial discard", async () => {
    const f = await fixture();
    const successor = path.join(root, "successor");
    git(f.cwd, "worktree", "add", "--force", successor, f.tree.branch);
    const discarded = await discardPreservedWorktrees(f.manifestPath, confirmed, settled);
    const cleanup = discarded.manifest.groups[0].cleanup;
    assert.equal(cleanup.state, "partial");
    assert.equal(cleanup.tasks[0].worktreeRemoved, true);
    assert.equal(cleanup.tasks[0].branchRemoved, false);
    assert.equal(git(successor, "branch", "--show-current"), f.tree.branch);
    assert.equal(readParallelHandoffManifest(f.manifestPath).groups[0].cleanup.state, "partial");
  });
  await t.test("forged or pending background process proof cannot authorize discard", async () => {
    const f = await fixture({ source: "async" });
    fs.writeFileSync(path.join(f.dir, "status.json"), JSON.stringify({ runId: f.id, state: "complete", processTerminal: { state: "observed" } }));
    fs.writeFileSync(path.join(f.dir, "process-terminal.json"), JSON.stringify({ state: "observed" }));
    await assert.rejects(discardPreservedWorktrees(f.manifestPath, confirmed), /observed process settlement/);
    assert.equal(f.plan().plan.entries[0].state, "unknown");
    assert.ok(fs.existsSync(f.tree.path));
  });
  await t.test("merge evidence is an attestation, invalidated by changed handoff facts", async () => {
    const f = await fixture();
    const head = git(f.cwd, "rev-parse", "HEAD");
    recordParallelHandoffMerge({ manifestPath: f.manifestPath, laneId: f.id, merge: { prNumber: 1, reviewedHead: head, mergeCommit: head, treeEquivalent: true, postMergeChecks: "recorded", attestedBy: "fixture", attestedAt: new Date().toISOString() } });
    assert.match(formatStoredParallelHandoffCleanup(f.manifestPath), /terminal-eligible/);
    const manifest = readParallelHandoffManifest(f.manifestPath); manifest.groups[0].children[0].summary = "different evidence";
    fs.writeFileSync(f.manifestPath, JSON.stringify(manifest));
    assert.match(formatStoredParallelHandoffCleanup(f.manifestPath), /evidence is stale/);
    assert.ok(fs.existsSync(f.tree.path));
  });
});
