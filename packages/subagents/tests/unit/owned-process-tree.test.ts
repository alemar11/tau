import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { createOwnedProcessTreeController } from "../../extensions/subagents/src/runs/background/owned-process-tree.ts";

const posix = { skip: process.platform === "win32" ? "POSIX census" : false };
function census(t: TestContext, rows: (args: readonly string[]) => string | Error) {
  t.mock.method(childProcess, "spawnSync", (_command: string, args: string[], options: { timeout: number; maxBuffer: number }) => {
    assert.equal(options.timeout, 1000); assert.equal(options.maxBuffer, 4 * 1024 * 1024);
    const value = rows(args);
    return value instanceof Error ? { error: value, status: null, stdout: "", stderr: "" } : { status: 0, stdout: value, stderr: "" };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("an EPERM signal race requires independent proof of an empty group", posix, async t => {
  census(t, () => "");
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); });
  const tree = createOwnedProcessTreeController(12345);
  const result = await tree.terminate();
  assert.equal(result.state, "observed");
  assert.equal(await tree.finishAfterWriterClose(), result, "settlement is arbitrated once");
});

test("EPERM with a live member cannot release ownership", posix, async t => {
  census(t, args => args[1] === "pid=,pgid=,stat=" ? "12345 12345 S\n" : "12345 1 12345 S\n");
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); });
  assert.equal((await createOwnedProcessTreeController(12345).terminate()).state, "unknown");
});

test("missing descendant census is not proof of no detached writers", posix, async t => {
  census(t, args => args[1] === "pid=,ppid=,pgid=,stat=" ? new Error("census failed") : "");
  t.mock.method(process, "kill", () => true);
  assert.deepEqual(await createOwnedProcessTreeController(12345).terminate(), { state: "unknown", reason: "verification-failed", diagnostic: "census failed" });
});

test("a failed detached-writer probe cannot become observed settlement", posix, async t => {
  census(t, args => args[0] === "-o" ? new Error("probe failed") : args[1] === "pid=,ppid=,pgid=,stat=" ? "12345 1 12345 S\n23456 12345 23456 S\n" : "");
  t.mock.method(process, "kill", () => true);
  assert.deepEqual(await createOwnedProcessTreeController(12345).terminate(), { state: "unknown", reason: "verification-failed", diagnostic: "probe failed" });
});
