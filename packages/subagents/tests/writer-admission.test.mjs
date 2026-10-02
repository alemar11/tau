import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { admitWriter, isWriter, withWriterAdmission } from "../extensions/subagents/src/runs/shared/writer-admission.ts";

function scope(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "tau-writer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { cwd: dir, rootSessionId: "root", ancestors: [], storageRoot: path.join(dir, "leases") };
}
function barrier() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

test("FIFO survives cancellation and symlink aliases; old cleanup cannot release a successor", async (t) => {
  const base = scope(t);
  const alias = `${base.cwd}-alias`; fs.symlinkSync(base.cwd, alias, "dir"); t.after(() => fs.rmSync(alias));
  const first = await admitWriter({ ...base, runId: "first" });
  const queued2 = barrier(), queued3 = barrier(), queued4 = barrier();
  const stop = new AbortController(); const admitted = [];
  const second = admitWriter({ ...base, cwd: alias, runId: "second", signal: stop.signal, onWait: () => queued2.resolve() });
  const secondResult = assert.rejects(second, (error) => error.name === "AbortError" || error.message === "cancelled");
  await queued2.promise;
  const third = admitWriter({ ...base, runId: "third", onWait: () => queued3.resolve() }).then((lease) => { admitted.push("third"); return lease; });
  await queued3.promise;
  const fourth = admitWriter({ ...base, runId: "fourth", onWait: () => queued4.resolve() }).then((lease) => { admitted.push("fourth"); return lease; });
  await queued4.promise;
  stop.abort(new Error("cancelled")); await secondResult;
  await first.release(); const thirdLease = await third;
  assert.deepEqual(admitted, ["third"]);
  await first.release();
  assert.deepEqual(admitted, ["third"]);
  await thirdLease.release(); const fourthLease = await fourth;
  assert.deepEqual(admitted, ["third", "fourth"]); await fourthLease.release();
});

test("queue deadline and ancestor conflicts fail closed, unrelated roots remain independent", async (t) => {
  const base = scope(t); const lease = await admitWriter({ ...base, runId: "ancestor" });
  await assert.rejects(admitWriter({ ...base, runId: "child", ancestors: ["ancestor"] }), /deadlock/);
  await assert.rejects(admitWriter({ ...base, runId: "timeout", deadlineAt: Date.now() + 60 }), /deadline/);
  const other = await admitWriter({ ...base, rootSessionId: "other-root", runId: "other" });
  await other.release(); await lease.release();
  const survivor = await admitWriter({ ...base, runId: "survivor" }); await survivor.release();
});

test("classification is capability-based and uncertain prompts keep their writer ownership", async (t) => {
  for (const tools of [undefined, ["bash"], ["read", "unknown"], ["edit"], ["write"]]) assert.equal(isWriter(tools), true);
  assert.equal(isWriter(["read", "fetch_web_content", "subagent", "subagent_supervisor"]), false);
  assert.equal(isWriter(["read"], true), true);
  const base = scope(t); const end = barrier(); const entered = barrier(); let count = 0;
  const factory = withWriterAdmission({ dispose: async () => {}, create: async () => { count++; return { messages: [], subscribe: () => () => {}, prompt: async () => { entered.resolve(); await end.promise; }, abort: async () => {}, dispose: async () => {} }; } });
  // Production storage uses TEMP_ROOT; isolate using a unique root session identity.
  const launch = (runId) => ({ cwd: base.cwd, runtime: { workspaceWriter: true, writerIdentity: { rootSessionId: base.cwd, runId, ancestors: [] } } });
  const first = await factory.create(launch("first")); const running = first.prompt("work"); await entered.promise;
  await first.dispose();
  const wait = barrier(); const next = factory.create({ ...launch("next"), onWriterWait: () => wait.resolve() });
  await wait.promise; assert.equal(count, 1, "bounded dispose is not termination proof");
  end.resolve(); await running; const second = await next; assert.equal(count, 2); await second.dispose();
  const readers = await Promise.all([factory.create({ ...launch("read-1"), runtime: { ...launch("read-1").runtime, workspaceWriter: false } }), factory.create({ ...launch("read-2"), runtime: { ...launch("read-2").runtime, workspaceWriter: false } })]);
  await Promise.all(readers.map((reader) => reader.dispose()));
});

test("malformed ownership is never interpreted as an empty scope", async (t) => {
  const base = scope(t); const owner = await admitWriter({ ...base, runId: "owner" });
  const queuePath = path.join(base.storageRoot, fs.readdirSync(base.storageRoot)[0], "queue.json");
  const state = JSON.parse(fs.readFileSync(queuePath, "utf8"));
  for (const malformed of [null, { ...state, owner: null }, { ...state, owner: false }, { ...state, owner: {} }, { ...state, waiting: [{ token: "broken" }] }]) {
    fs.writeFileSync(queuePath, JSON.stringify(malformed));
    await assert.rejects(admitWriter({ ...base, runId: "must-not-launch" }), /invalid/);
  }
  fs.writeFileSync(queuePath, JSON.stringify(state));
  await assert.rejects(admitWriter({ ...base, runId: "still-occupied", deadlineAt: Date.now() + 60 }), /deadline/);
  await owner.release();
});

test("tool termination and output finalization are separate release barriers", async (t) => {
  const base = scope(t); let events; let finalize; let creates = 0;
  const factory = withWriterAdmission({ dispose: async () => {}, create: async () => { creates++; return { messages: [], subscribe: (callback) => { events = callback; return () => {}; }, prompt: async () => {}, dispose: async () => {} }; } });
  const launch = (runId) => ({ cwd: base.cwd, runtime: { workspaceWriter: true, writerIdentity: { rootSessionId: base.cwd, runId, ancestors: [] } } });
  const first = await factory.create({ ...launch("tool-owner"), onWriterFinalizer: (callback) => { finalize = callback; } });
  events({ type: "tool_execution_start", toolCallId: "active" });
  const finishTool = events;
  await first.prompt("work"); await first.dispose(); await finalize();
  let finalizeSuccessor;
  const waiting = barrier(); const next = factory.create({ ...launch("successor"), onWriterWait: () => waiting.resolve(), onWriterFinalizer: (callback) => { finalizeSuccessor = callback; } });
  await waiting.promise;
  assert.equal(creates, 1);
  finishTool({ type: "tool_execution_end", toolCallId: "active" });
  const successor = await next; assert.equal(creates, 2); await successor.dispose();
  const outputWait = barrier(); const third = factory.create({ ...launch("after-output"), onWriterWait: () => outputWait.resolve() });
  await outputWait.promise; assert.equal(creates, 2, "SDK/tool settlement alone cannot skip output finalization");
  await finalizeSuccessor(); const last = await third; assert.equal(creates, 3); await last.dispose();
});

test("different processes serialize; killed owner is not reclaimed by a guessed PID", { timeout: 10_000 }, async (t) => {
  const base = scope(t);
  const spawn = (runId) => {
    const child = fork(fileURLToPath(new URL("./support/writer-child.mjs", import.meta.url)), [JSON.stringify({ ...base, runId })], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); }); return child;
  };
  const first = spawn("process-a"); assert.equal((await once(first, "message"))[0].state, "admitted");
  const second = spawn("process-b"); assert.equal((await once(second, "message"))[0].state, "queued");
  const admitted = new Promise((resolve) => { second.on("message", (message) => { if (message.state === "admitted") resolve(); }); });
  const firstExit = once(first, "exit"); first.send("release"); await admitted; await firstExit;
  const exited = once(second, "exit"); second.kill("SIGKILL"); await exited;
  await assert.rejects(admitWriter({ ...base, runId: "after-crash", deadlineAt: Date.now() + 100 }), /deadline/);
});
