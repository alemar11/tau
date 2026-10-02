import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflowScript, validateWorkflowScript, WorkflowScriptError } from "../extensions/subagents/src/workflows/scripted-workflow.ts";
import { assertNativeAgent, assertNativeExecution } from "../extensions/subagents/src/shared/phase-one.ts";
import { resolveDisabledFeatureSurface, disabledFeatureUseError } from "../extensions/subagents/src/shared/disabled-features.ts";

const result = (key, output = key) => ({ key, runId: key, ok: true, output, artifactPaths: [] });
const options = (script, launch) => ({ script, timeoutMs: 2000, launch, status: async (key) => result(key) });

test("script engine waits for dependencies and keeps ordered parallel results", async () => {
  const calls = [];
  const workflow = await runWorkflowScript(options(`const first = await runs.run("first", {agent:"scout",task:"scan"}); const results = await runs.all([{key:"a",agent:"reviewer",task:first.output},{key:"b",agent:"reviewer",task:first.output}]); emit(results.map(r=>r.key)); return results.map(r=>r.output);`, async (key, params) => {
    calls.push({ key, task: params.task }); return result(key, key === "first" ? "complete scan" : params.task);
  }));
  assert.deepEqual(workflow.value, ["complete scan", "complete scan"]);
  assert.deepEqual(calls.map((call) => call.key), ["first", "a", "b"]);
  assert.deepEqual(workflow.emits, [["a", "b"]]);
});

test("static rejection launches nothing and dynamic host/state calls cannot bypass phase gates", async () => {
  let launches = 0;
  assert.equal(validateWorkflowScript(`await runs.host("ci", {kind:"command",command:"echo unsafe",timeoutMs:1000});`).ok, false);
  await assert.rejects(runWorkflowScript(options(`await runs.run("a", {agent:"worker",task:"write"}); await runs.host("ci", {kind:"command",command:"echo unsafe",timeoutMs:1000});`, async (key) => { launches++; return result(key); })), /deferred/);
  assert.equal(launches, 0);
  await assert.rejects(runWorkflowScript({ ...options(`return state["set"]("x", 1);`, async (key) => result(key)), state: { set() { throw new Error("must not reach host"); }, get() {} } }), /deferred/);
  await assert.rejects(runWorkflowScript(options(`return typeof process === "undefined" ? require("node:fs") : process.cwd();`, async (key) => result(key))), /require is not defined/);
});

test("unobserved promises and incompatible duplicate keys fail with partial child evidence", async () => {
  await assert.rejects(runWorkflowScript(options(`runs.run("forgotten", {agent:"worker",task:"write"}); return 1;`, async (key) => result(key))), (error) => error instanceof WorkflowScriptError && /unawaited/.test(error.message));
  await assert.rejects(runWorkflowScript(options(`await runs.run("same", {agent:"reviewer",task:"one"}); return runs.run("same", {agent:"reviewer",task:"different"});`, async (key) => result(key))), /same|duplicate|params/);
});

test("status, steering, refs, console and immutable args retain native contracts", async () => {
  const calls = [];
  const workflow = await runWorkflowScript({
    ...options(`const dispatched = await runs.run("active", {agent:"scout",task:args.task,async:true}); const status = await runs.status("active"); const receipt = await runs.steer("active", "Follow up", {mode:"follow_up"}); console.info(args.task); emit(runs.refs([dispatched,status])); return {dispatched, receipt, frozen:Object.isFrozen(args.nested), ref:runs.ref(status)};`, async (key) => ({ ...result(key, ""), ok: false, state: "running" })),
    args: { task: "inspect", nested: { safe: true } },
    steer: async (key, message, options) => { calls.push({ key, message, options }); return { key, status: "queued", queued: true }; },
  });
  assert.equal(workflow.value.dispatched.ok, false);
  assert.equal(workflow.value.dispatched.state, "running");
  assert.equal(workflow.value.frozen, true);
  assert.match(workflow.value.ref, /active/);
  assert.equal(workflow.value.receipt.status, "queued");
  assert.deepEqual(calls, [{ key: "active", message: "Follow up", options: { mode: "follow_up" } }]);
  assert.deepEqual(workflow.console, [{ level: "info", text: "inspect" }]);
  assert.match(workflow.emits[0], /active/);
});

test("parallel reader launches overlap and failure retains prior results", async () => {
  let release; const barrier = new Promise((resolve) => { release = resolve; }); let started = 0;
  const workflow = await runWorkflowScript(options(`return runs.all([{key:"a",agent:"reviewer",task:"one"},{key:"b",agent:"reviewer",task:"two"}]);`, async (key) => { if (++started === 2) release(); await barrier; return result(key); }));
  assert.deepEqual(workflow.value.map((item) => item.key), ["a", "b"]);
  await assert.rejects(runWorkflowScript(options(`await runs.run("good", {agent:"reviewer",task:"one"}); throw new Error("later failure");`, async (key) => result(key))), (error) => error instanceof WorkflowScriptError && error.partial.children.some((child) => child.key === "good" && child.ok));
  assert.equal(validateWorkflowScript(`await runs.all([{key:"a",agent:"reviewer",task:"one"},{key:"b",agent:"reviewer",task:"two"}]);`, { maxSubagentSpawnsPerRun: 1 }).ok, false);
});

test("workflow helpers, promises, errors and returned objects cannot expose a host Function", async () => {
  for (const script of [
    `return runs.ref.constructor("return process")();`,
    `return console.log.constructor("return process")();`,
    `return Promise.resolve.constructor("return process")();`,
    `try { runs.ref(null); } catch(error) { return error.constructor.constructor("return process")(); }`,
    `const child = await runs.run("safe", {agent:"reviewer",task:"read"}); return child.constructor.constructor("return process")();`,
  ]) await assert.rejects(runWorkflowScript(options(script, async (key) => result(key))), /Code generation from strings disallowed/);
  const inspection = await runWorkflowScript(options(`let called = false; const value = { [Symbol.for("nodejs.util.inspect.custom")](_depth, _opts, inspect) { called = inspect.constructor("return typeof process")(); } }; console.log(value); return called;`, async (key) => result(key)));
  assert.equal(inspection.value, false, "console must not pass the unrestricted Node inspect function to script callbacks");
});

test("workflow output budgets fail before flooding the host and keep partial evidence", async () => {
  for (const script of [`return "x".repeat(1024*1024);`, `for(let i=0;i<600;i++) console.log("line");`, `for(let i=0;i<600;i++) emit(i);`]) {
    await assert.rejects(runWorkflowScript(options(script, async (key) => result(key))), /output limit/);
  }
});

test("phase-one gates apply even without user config and keep neutral internal fields valid", () => {
  const surface = resolveDisabledFeatureSurface({});
  for (const request of [{ action: "mission.create" }, { action: "schedule.run" }, { action: "inspector.open" }, { worktree: true }, { isolation: "worktree" }, { acceptance: { verify: ["true"] } }, { machine: "remote" }]) assert.ok(disabledFeatureUseError(request, surface));
  assert.equal(disabledFeatureUseError({ agent: "worker", task: "work", mission: false, acceptance: false }, surface), undefined);
  for (const options of [{ worktree: true }, { share: true }, { shareEnabled: true }, { machine: "remote" }]) assert.throws(() => assertNativeExecution(options), /phase 1/);
  for (const agent of [{ runner: { type: "codex" } }, { permissions: {} }, { tools: ["mcp:server"] }]) assert.throws(() => assertNativeAgent({ name: "deferred", ...agent }), /phase 1/);
  assert.doesNotThrow(() => assertNativeExecution({ acceptance: false, shareEnabled: false }));
  assert.doesNotThrow(() => assertNativeAgent({ name: "native", defaultAcceptance: false }));
});
