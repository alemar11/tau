import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import timers from "node:timers";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { isDeepStrictEqual } from "node:util";

const before = { ...process.env };
const blocked = (name) => () => { throw new Error(`Unexpected resource: ${name}`); };
for (const method of ["spawn", "spawnSync", "fork", "exec", "execSync", "execFile", "execFileSync"]) {
  mock.method(childProcess, method, blocked(method));
}
for (const method of ["connect", "createConnection", "createServer"]) mock.method(net, method, blocked(method));
mock.method(net.Socket.prototype, "connect", blocked("Socket.connect"));
mock.method(net.Server.prototype, "listen", blocked("Server.listen"));
for (const method of ["watch", "watchFile"]) mock.method(fs, method, blocked(method));
for (const method of ["setTimeout", "setInterval"]) {
  mock.method(timers, method, blocked(method));
  mock.method(globalThis, method, blocked(method));
}
syncBuiltinESMExports();

let result;
try {
  const { default: openspace } = await import("../../extensions/openspace/index.ts");
  const handlers = new Map();
  openspace({ registerTool: () => {}, registerMessageRenderer: () => {}, registerCommand: () => {}, on: (event, handler) => {
    const registered = handlers.get(event) ?? [];
    handlers.set(event, [...registered, handler]);
    return () => handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== handler));
  } });
  if (process.argv[2] === "start") {
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start" }, { hasUI: false, mode: "print" });
    }
  }
  assert.ok(isDeepStrictEqual({ ...process.env }, before), "extension must not mutate process.env");
  result = { ok: true };
} catch (error) {
  result = { ok: false, error: error.message };
  process.exitCode = 1;
} finally {
  mock.restoreAll();
  syncBuiltinESMExports();
}
console.log(JSON.stringify(result));
