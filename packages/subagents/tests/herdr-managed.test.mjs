import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { writeNodeCommand } from "./support/node-command.ts";

const root = fs.mkdtempSync(path.join(tmpdir(), "tau-managed-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.TAU_SUBAGENTS_TEMP_ROOT = path.join(root, "state");
const { HerdrManagedExecution } = await import("../extensions/subagents/src/runs/shared/herdr-managed-execution.ts");
const { DIRS, HERDR_MANAGED_REFERENCE } = await import("../extensions/subagents/src/shared/types.ts");
const { inspectWriterScope } = await import("../extensions/subagents/src/runs/shared/writer-admission.ts");
const { cleanupAsyncRetention } = await import("../extensions/subagents/src/runs/background/async-retention.ts");
const { readProcessTerminal } = await import("../extensions/subagents/src/runs/background/process-terminal.ts");
const cwd = path.join(root, "workspace"), bin = path.join(root, "bin"), profiles = path.join(process.env.PI_CODING_AGENT_DIR, "tau-subagents", "agents");
fs.mkdirSync(cwd); fs.mkdirSync(bin); fs.mkdirSync(profiles, { recursive: true });
const provider = fileURLToPath(new URL("./support/provider.ts", import.meta.url));
fs.writeFileSync(path.join(profiles, "managed-native.md"), `---\nname: managed-native\ndescription: managed SDK fixture\nmodel: tau-fixture/local\ntools: read,write\nextensions: ${provider}\ninheritProjectContext: true\n---\nDo exactly the task.\n`);
fs.writeFileSync(path.join(profiles, "managed-missing.md"), `---\nname: managed-missing\ndescription: missing explicit resource\nmodel: tau-fixture/local\ntools: read\nextensions: ${path.join(root, "missing.ts")}\n---\nNever prompt without the extension.\n`);
fs.writeFileSync(path.join(profiles, "managed-no-model.md"), "---\nname: managed-no-model\ndescription: no model selected\ntools: read\n---\nNo fallback.\n");
const cliFixture = new URL("./support/external-cli-fixture.mjs", import.meta.url).href;
for (const adapter of ["claude-code", "claude-code-writer", "codex-exec", "codex-exec-writer", "cursor-agent", "cursor-agent-writer"]) {
  const kind = adapter.replace(/-writer$/, "");
  const command = writeNodeCommand(bin, adapter, `import(${JSON.stringify(cliFixture)}).then(m => m.run(${JSON.stringify(kind)})).catch(error => { console.error(error); process.exitCode = 1; });`);
  fs.writeFileSync(path.join(profiles, `managed-${adapter}.md`), `---\nname: managed-${adapter}\ndescription: managed local CLI fixture\nrunner:\n  type: external-cli\n  adapter: ${adapter}\n  command: ${JSON.stringify(command)}\n---\nDo exactly the task.\n`);
}
const gitCalled = path.join(root, "git-called");
writeNodeCommand(bin, "git", `require('fs').writeFileSync(${JSON.stringify(gitCalled)}, 'unexpected git'); process.exit(91);`);
const previousPath = process.env.PATH;
process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
const executions = [], gates = [];
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
async function until(condition, label = "fixture barrier", budget = 30_000) {
  const deadline = Date.now() + budget;
  while (!condition() && Date.now() < deadline) await delay(20);
  assert.ok(condition(), label);
}
function request(overrides = {}) {
  return { version: 1, runId: `managed_${randomUUID()}`, rootSessionId: randomUUID(), cwd, agent: "managed-native", task: "Complete", projectTrusted: true, deadlineAt: Date.now() + 30_000, ...overrides };
}
function runtime() { return fs.mkdtempSync(path.join(root, "runtime-")); }
function create(overrides = {}) {
  const execution = new HerdrManagedExecution(runtime(), request(overrides));
  executions.push(execution); return execution;
}
function gate(name) { const value = path.join(root, name); gates.push(value); return value; }
function queued(id) {
  const directory = path.join(root, "state", "writer-admission-v1");
  return fs.existsSync(directory) && fs.readdirSync(directory).some((name) => {
    const file = path.join(directory, name, "queue.json");
    return fs.existsSync(file) && json(file).waiting.some((ticket) => ticket.runId === `${id}:0`);
  });
}
after(async () => {
  for (const barrier of gates) fs.writeFileSync(`${barrier}.release`, "");
  for (const execution of executions) {
    if (fs.existsSync(path.join(execution.directory, "runner.json")) && !["observed", "unknown"].includes(readProcessTerminal(execution.asyncDir)?.state)) {
      try { execution.stop(); } catch {}
    }
  }
  process.env.PATH = previousPath;
  // Fault-injected/uncertain executions retain their original namespace and evidence.
  if (executions.every((execution) => ["observed", "not-started"].includes(fs.existsSync(path.join(execution.directory, "outcome.json")) ? json(path.join(execution.directory, "outcome.json")).settlement : "unknown"))) fs.rmSync(root, { recursive: true, force: true });
});
const options = { skip: process.platform === "win32" ? "POSIX private state and process-tree validation" : false, timeout: 180_000 };

test("managed execution reuses real SDK sessions, explicit resources and independent process settlement", options, async () => {
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "FIXTURE_PROJECT_INSTRUCTION\n");
  const execution = create(), first = execution.run();
  assert.equal(execution.run(), first, "a second observation is not a second dispatch");
  const result = await first;
  assert.equal(result.settlement, "observed", JSON.stringify(result));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.match(JSON.stringify(result.result.results), /fixture complete.*project context present/s);
  assert.equal(result.result.completionOwnerId, json(path.join(execution.directory, "request.json")).token);
  assert.equal(result.runnerProcessInstanceId, json(path.join(execution.directory, "runner.json")).runnerProcessInstanceId);
  assert.equal(result.processTerminal.state, "observed");
  assert.ok(result.processTerminal.instances.some((instance) => instance.kind === "runner"));
  assert.equal(fs.existsSync(path.join(DIRS.results, `${execution.request.runId}.json`)), false, "the coordinator cannot consume the managed host's private result");
  assert.equal(fs.existsSync(path.join(execution.asyncDir, HERDR_MANAGED_REFERENCE)), true);
  assert.equal(fs.statSync(path.join(execution.directory, "outcome.json")).mode & 0o777, 0o600);
  assert.throws(() => new HerdrManagedExecution(path.dirname(execution.directory), execution.request), /EEXIST/);
  assert.equal(execution.run(), first);
  const untrusted = await create({ projectTrusted: false }).run();
  assert.equal(untrusted.success, true, JSON.stringify(untrusted));
  assert.doesNotMatch(JSON.stringify(untrusted.result.results), /project context present/);
  const missing = await create({ agent: "managed-missing" }).run();
  assert.equal(missing.success, false);
  assert.match(JSON.stringify(missing), /missing\.ts|Required child extension/);
  assert.equal(fs.existsSync(gitCalled), false, "ordinary managed execution remains Git-free");
});

test("managed CLI profiles use the existing one-shot adapters, preflight and per-process proof", options, async () => {
  for (const adapter of ["claude-code", "claude-code-writer", "codex-exec", "codex-exec-writer", "cursor-agent", "cursor-agent-writer"]) {
    const execution = create({ agent: `managed-${adapter}`, ...(adapter.startsWith("claude") ? { model: "sonnet:high" } : {}) });
    const result = await execution.run();
    assert.equal(result.settlement, "observed", JSON.stringify(result));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.match(result.result.results[0].output, /external fixture complete/);
    const writers = result.processTerminal.instances.filter((instance) => instance.kind === "external-writer");
    assert.ok(writers.length >= 3, "preflight processes and execution must be observed");
    assert.ok(writers.every((instance) => instance.processTree.state === "observed"));
    assert.equal(new Set(writers.map((instance) => instance.processInstanceId)).size, writers.length);
  }
  const malformed = await create({ agent: "managed-claude-code", task: "TAU_FIXTURE_MALFORMED" }).run();
  assert.equal(malformed.settlement, "observed"); assert.equal(malformed.success, false);
  assert.match(JSON.stringify(malformed), /malformed JSONL/);
  assert.equal(fs.existsSync(gitCalled), false);
});

test("managed native and CLI writers share FIFO; publication and stop requests cannot release ownership", options, async () => {
  const owner = randomUUID(), nativeGate = gate("native-held"), never = gate("queued-never"), externalGate = gate("external-held");
  const holder = create({ rootSessionId: owner, task: `TAU_FIXTURE_GATE:${nativeGate}` }), holding = holder.run();
  await until(() => fs.existsSync(`${nativeGate}.entered`));
  let completed = false; void holding.then(() => { completed = true; });
  const token = json(path.join(holder.directory, "request.json")).token;
  fs.writeFileSync(holder.resultPath, JSON.stringify({ id: holder.request.runId, sessionId: owner, completionOwnerId: token, asyncDir: holder.asyncDir, results: [], state: "complete", success: true, marker: "publication is not cessation" }));
  await delay(100); assert.equal(completed, false);
  const proofFile = path.join(holder.asyncDir, "process-terminal.json"), pending = json(proofFile);
  fs.writeFileSync(proofFile, JSON.stringify({ ...pending, state: "observed", observedAt: Date.now(), instances: [{ kind: "runner", processInstanceId: pending.runnerProcessInstanceId, closeObservedAt: Date.now(), exitCode: 0, signal: null }] }));
  assert.equal(readProcessTerminal(holder.asyncDir).state, "observed", "syntactically valid sidecar is not a live close observation");
  await delay(100); assert.equal(completed, false, "the launcher must actually observe closure independently of files");
  fs.writeFileSync(proofFile, JSON.stringify(pending));
  assert.equal(inspectWriterScope({ cwd, rootSessionId: owner }), "active");
  const waiting = create({ agent: "managed-codex-exec-writer", rootSessionId: owner, task: `TAU_FIXTURE_GATE:${never}` }), queuedResult = waiting.run();
  await until(() => queued(waiting.request.runId)); waiting.stop(); waiting.stop();
  const stopped = await queuedResult;
  assert.equal(stopped.success, false); assert.equal(stopped.settlement, "observed");
  assert.equal(fs.existsSync(`${never}.entered`), false);
  assert.equal(completed, false);
  const external = create({ agent: "managed-claude-code-writer", rootSessionId: owner, task: `TAU_FIXTURE_GATE:${externalGate}` }), externalResult = external.run();
  await until(() => queued(external.request.runId));
  fs.writeFileSync(`${nativeGate}.release`, "");
  const first = await holding; assert.equal(first.success, true); assert.equal(first.result.marker, undefined);
  await until(() => fs.existsSync(`${externalGate}.entered`));
  external.stop();
  const terminal = await externalResult; assert.equal(terminal.settlement, "observed"); assert.equal(terminal.success, false);
  const next = await create({ rootSessionId: owner, task: "Launch only after stopped CLI processes settle" }).run();
  assert.equal(next.success, true, JSON.stringify(next));
});

test("managed requests are immutable, single-use and retain the original writer namespace", options, async () => {
  const original = request(), selectedRuntime = runtime(), execution = new HerdrManagedExecution(selectedRuntime, original);
  executions.push(execution); original.task = "TAU_FIXTURE_WRITE:should-not-exist";
  assert.equal(execution.request.task, "Complete");
  const previous = process.env.TAU_SUBAGENTS_TEMP_ROOT;
  process.env.TAU_SUBAGENTS_TEMP_ROOT = path.join(root, "wrong-namespace");
  try {
    const result = await execution.run(); assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(inspectWriterScope({ cwd, rootSessionId: execution.request.rootSessionId }), "idle");
    assert.equal(fs.existsSync(path.join(root, "wrong-namespace", "writer-admission-v1")), false);
  } finally { process.env.TAU_SUBAGENTS_TEMP_ROOT = previous; }
  assert.equal(fs.existsSync(path.join(cwd, "should-not-exist")), false);
  for (const overrides of [{ deadlineAt: Date.now() - 1 }, { deadlineAt: Date.now() + 3_000_000_000 }, { agent: "missing-profile" }, { agent: "managed-no-model" }, { env: { PATH: "/untrusted" } }, { version: 2 }, { projectTrusted: undefined }, { cwd: "." }, { skills: ["/caller/path"] }, { task: "\u0001".repeat(256 * 1024) }]) {
    const target = runtime();
    assert.throws(() => new HerdrManagedExecution(target, request(overrides)));
    assert.equal(fs.existsSync(path.join(target, "managed-execution")), false);
  }
  const inside = fs.mkdtempSync(path.join(cwd, "unsafe-runtime-"));
  assert.throws(() => new HerdrManagedExecution(inside, request()), /outside the execution workspace/);
  assert.equal(fs.existsSync(path.join(inside, "managed-execution")), false);
  const cancelled = create(); cancelled.stop();
  assert.equal((await cancelled.run()).settlement, "not-started");
  assert.equal(fs.existsSync(path.join(cancelled.directory, "runner.json")), false);
  const expired = create({ deadlineAt: Date.now() + 100 }); await delay(120);
  assert.equal((await expired.run()).settlement, "not-started");
  assert.equal(fs.existsSync(path.join(expired.directory, "runner.json")), false);
});

test("managed state blocks retention and rejects replaced generations or missing ownership", options, async () => {
  const completed = create(); assert.equal((await completed.run()).success, true);
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  const statusPath = path.join(completed.asyncDir, "status.json"), status = json(statusPath);
  status.lastUpdate = old; status.startedAt = old; status.endedAt = old;
  fs.writeFileSync(statusPath, JSON.stringify(status));
  const retention = await cleanupAsyncRetention({ asyncDirRoot: DIRS.async, resultsDir: DIRS.results, now: () => Date.now() + 60 * 24 * 60 * 60 * 1000, processStartIdentity: "fixture" });
  assert.ok((retention.skipped["managed-placement-reference"] ?? 0) >= 1, JSON.stringify(retention));
  assert.equal(fs.existsSync(completed.asyncDir), true);
  for (const evidence of ["malformed", "symlink"]) {
    const marker = path.join(completed.asyncDir, HERDR_MANAGED_REFERENCE); fs.rmSync(marker);
    if (evidence === "malformed") fs.writeFileSync(marker, "incomplete"); else fs.symlinkSync(path.join(root, "missing-marker"), marker);
    const outcome = await cleanupAsyncRetention({ asyncDirRoot: DIRS.async, resultsDir: DIRS.results, now: () => Date.now() + 60 * 24 * 60 * 60 * 1000, processStartIdentity: "fixture" });
    assert.ok((outcome.skipped["managed-placement-reference"] ?? 0) >= 1, JSON.stringify(outcome));
  }
  const replaced = create(), owned = `${replaced.directory}-retained`;
  fs.renameSync(replaced.directory, owned); fs.mkdirSync(replaced.directory, { mode: 0o700 });
  fs.writeFileSync(path.join(replaced.directory, "foreign"), "keep");
  await assert.rejects(replaced.run(), /ownership.*uncertain|ownership changed/);
  assert.equal(fs.readFileSync(path.join(replaced.directory, "foreign"), "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(owned, "request.json")), true);
  assert.equal(fs.existsSync(path.join(replaced.asyncDir, "status.json")), false);
});

test("managed startup receipts and failed stop intents cannot be bypassed or silently retried", options, async () => {
  const never = gate("blocked-startup"), refused = create({ task: `TAU_FIXTURE_GATE:${never}` });
  fs.writeFileSync(path.join(refused.directory, "runner.json"), "retained receipt");
  const result = await refused.run(); assert.equal(result.success, false); assert.equal(result.settlement, "unknown");
  await until(() => ["observed", "unknown"].includes(readProcessTerminal(refused.asyncDir)?.state), "startup process closure");
  assert.equal(fs.existsSync(`${never}.entered`), false, "receipt persistence precedes child admission/prompting");
  assert.equal(fs.readFileSync(path.join(refused.directory, "runner.json"), "utf8"), "retained receipt");
  const barrier = gate("failed-stop-intent"), holder = create({ task: `TAU_FIXTURE_GATE:${barrier}` }), running = holder.run();
  await until(() => fs.existsSync(`${barrier}.entered`));
  const intent = path.join(holder.directory, "stop-intent.json"); fs.writeFileSync(intent, "retained intent");
  let originalError; try { holder.stop(); } catch (error) { originalError = error; }
  assert.match(originalError.message, /EEXIST/);
  fs.renameSync(intent, `${intent}.retained`);
  assert.throws(() => holder.stop(), (error) => error === originalError, "failed stop remains latched even if its path becomes free");
  assert.equal(fs.existsSync(intent), false);
  assert.equal(inspectWriterScope({ cwd, rootSessionId: holder.request.rootSessionId }), "active");
  fs.writeFileSync(`${barrier}.release`, ""); assert.equal((await running).success, true, "failed intent never delivered a stop");
});

test("foreign or oversized process proof cannot settle a managed writer", options, async () => {
  for (const kind of ["identity", "oversized"]) {
    const barrier = gate(`invalid-proof-${kind}`), holder = create({ task: `TAU_FIXTURE_GATE:${barrier}` }), running = holder.run();
    await until(() => fs.existsSync(`${barrier}.entered`));
    const file = path.join(holder.asyncDir, "process-terminal.json");
    fs.writeFileSync(file, kind === "identity" ? JSON.stringify({ ...json(file), runId: "foreign_run" }) : " ".repeat(1024 * 1024 + 1));
    const result = await running; assert.equal(result.settlement, "unknown"); assert.equal(result.success, false);
    assert.equal(inspectWriterScope({ cwd, rootSessionId: holder.request.rootSessionId }), "active");
    fs.writeFileSync(`${barrier}.release`, "");
    await until(() => ["complete", "failed"].includes(json(path.join(holder.asyncDir, "status.json")).state), "native final result after explicit release");
    assert.equal(fs.existsSync(path.join(holder.directory, "outcome.json")), true);
  }
});

test("unknown CLI census is retained and does not admit a successor writer", options, async () => {
  const ps = writeNodeCommand(bin, "ps", 'process.stderr.write("fixture census unavailable"); process.exit(1);');
  const owner = randomUUID(), uncertain = create({ agent: "managed-cursor-agent", rootSessionId: owner });
  let outcome;
  try { outcome = await uncertain.run(); } finally { fs.rmSync(ps); }
  assert.equal(outcome.settlement, "unknown", JSON.stringify(outcome));
  assert.equal(outcome.success, false);
  assert.equal(inspectWriterScope({ cwd, rootSessionId: owner }), "active");
  const never = gate("unknown-successor"), successor = create({ rootSessionId: owner, deadlineAt: Date.now() + 2_000, task: `TAU_FIXTURE_GATE:${never}` });
  const refused = await successor.run(); assert.equal(refused.success, false);
  assert.equal(refused.settlement, "observed", JSON.stringify(refused));
  assert.match(JSON.stringify(refused.result), /deadline|timed out/i);
  assert.equal(fs.existsSync(`${never}.entered`), false);
  assert.equal(inspectWriterScope({ cwd, rootSessionId: owner }), "active");
  assert.equal(fs.existsSync(path.join(uncertain.directory, "outcome.json")), true);
  assert.equal(fs.existsSync(gitCalled), false);
});
