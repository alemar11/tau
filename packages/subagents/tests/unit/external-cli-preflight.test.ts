import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { runExternalCli } from "../../extensions/subagents/src/runs/shared/external-cli-runner.ts";
import type { ExternalProcessStatus } from "../../extensions/subagents/src/shared/types.ts";

const posix = { skip: process.platform === "win32" ? "POSIX process-group validation" : false };
function fixture(t: TestContext, source: string) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "tau-cli-probe-"));
  const script = path.join(dir, "fixture.cjs"); fs.writeFileSync(script, source);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, input: { command: process.execPath, args: [script], cwd: dir, asyncDir: dir, stepIndex: 0, prompt: "Inspect", preflight: { id: dir, versionArgs: [script, "--version"], helpArgs: [script, "--help"] } } };
}

test("aborted admission never executes preflight or the CLI", async t => {
  const { input } = fixture(t, 'throw new Error("must not launch")');
  const abort = new AbortController(); abort.abort();
  const processes: ExternalProcessStatus[] = [];
  const result = await runExternalCli({ ...input, signal: abort.signal, onProcess: process => processes.push(process) });
  assert.equal(result.exitCode, 1); assert.equal(result.stopped, true); assert.deepEqual(processes, []);
});

test("the launch deadline bounds preflight, not just the eventual CLI spawn", posix, async t => {
  const { input } = fixture(t, 'setInterval(() => {}, 1000)');
  const processes: ExternalProcessStatus[] = [], start = Date.now();
  const result = await runExternalCli({ ...input, deadlineAt: start + 100, onProcess: process => processes.push(process) });
  assert.equal(result.exitCode, 1); assert.equal(result.timedOut, true);
  assert.match(result.error ?? "", /preflight.*timed out|deadline expired/);
  assert.ok(Date.now() - start < 3000, "did not honor the launch deadline");
  assert.equal(processes.some(p => p.phase === "execution"), false);
  for (const p of processes.filter(p => p.endedAt)) assert.equal(p.processTree?.state, "observed");
});

test("cancellation during preflight settles its process before returning", posix, async t => {
  const { dir, input } = fixture(t, 'require("fs").writeFileSync("entered", ""); setInterval(() => {}, 1000)');
  const abort = new AbortController(), processes: ExternalProcessStatus[] = [];
  const pending = runExternalCli({ ...input, signal: abort.signal, onProcess: process => processes.push(process) });
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(path.join(dir, "entered")) && Date.now() < deadline) await delay(10);
  abort.abort();
  const result = await pending;
  assert.ok(fs.existsSync(path.join(dir, "entered")));
  assert.equal(result.exitCode, 1); assert.equal(result.stopped, true);
  assert.equal(processes.some(p => p.phase === "execution"), false);
  assert.equal(processes.at(-1)?.processTree?.state, "observed");
});

test("preflight descendants are settled and each probe has distinct process evidence", posix, async t => {
  const { dir, input } = fixture(t, `
const fs = require("fs");
if (process.argv[2] === "--version") {
  const child = require("child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  fs.writeFileSync("descendant", String(child.pid)); console.log("version 1"); process.exit(0);
}
console.log(process.argv[2] === "--help" ? "safe help" : "completed");
`);
  const processes: ExternalProcessStatus[] = [];
  const result = await runExternalCli({ ...input, onProcess: process => processes.push(process) });
  assert.equal(result.exitCode, 0, result.error);
  const ended = processes.filter(p => p.endedAt);
  assert.equal(ended.length, 3); assert.equal(new Set(ended.map(p => p.processInstanceId)).size, 3);
  assert.deepEqual(ended.map(p => p.phase), ["preflight", "preflight", "execution"]);
  for (const p of ended) assert.equal(p.processTree?.state, "observed");
  const pid = fs.readFileSync(path.join(dir, "descendant"), "utf8");
  const stat = spawnSync("ps", ["-p", pid, "-o", "stat="], { encoding: "utf8" }).stdout.trim();
  assert.ok(!stat || stat.startsWith("Z"), `preflight descendant remained active (${stat})`);
});
