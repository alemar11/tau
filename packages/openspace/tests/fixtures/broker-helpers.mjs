import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolvePaths } from "../../src/paths.ts";
import { FrameDecoder, encodeFrame } from "../../src/protocol/framing.ts";
import { envelope } from "../../src/protocol/messages.ts";
import { processAlive } from "../../src/broker/runtime-files.ts";

export function fixture(t) {
  // Keep the Unix socket comfortably below macOS's byte limit, even with Unicode.
  const root = mkdtempSync("/tmp/openspace-");
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const paths = resolvePaths({ PI_CODING_AGENT_DIR: join(root, "caffè agent") });
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: paths.agentDir };
  return { root, paths, env, cleanup: (callback) => cleanups.push(callback) };
}

export async function until(condition, timeout = 3_000) {
  const deadline = performance.now() + timeout;
  while (!await condition()) {
    assert.ok(performance.now() < deadline, "condition did not become true before timeout");
    await delay(10);
  }
}

export async function raw(t, path) {
  const socket = createConnection(path);
  socket.on("error", () => {});
  const messages = [];
  const waiters = [];
  const decoder = new FrameDecoder();
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.on("data", (bytes) => decoder.push(bytes, (message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message); else messages.push(message);
  }));
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  function receive() {
    if (messages.length) return Promise.resolve(messages.shift());
    return new Promise((resolve, reject) => {
      const finish = (value) => { clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => { const at = waiters.indexOf(finish); if (at >= 0) waiters.splice(at, 1); reject(new Error("response timeout")); }, 2_000);
      waiters.push(finish);
    });
  }
  return { socket, closed, receive,
    send(type, id, fields = {}) { socket.write(encodeFrame({ ...envelope(type, id), ...fields })); },
    async request(type, id, fields = {}) { this.send(type, id, fields); return receive(); },
  };
}

export class FakeClock {
  time = 0;
  timers = new Set();
  now = () => this.time;
  after = (ms, callback) => {
    const timer = { at: this.time + ms, callback };
    this.timers.add(timer);
    return () => this.timers.delete(timer);
  };
  advance(ms) {
    const target = this.time + ms;
    while (true) {
      const next = [...this.timers].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.time = next.at; this.timers.delete(next); next.callback();
    }
    this.time = target;
  }
}

export async function terminate(pid) {
  assert.notEqual(pid, process.pid, "never terminate the test runner");
  if (!processAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  try { await until(() => !processAlive(pid)); }
  catch (error) { if (processAlive(pid)) process.kill(pid, "SIGKILL"); throw error; }
}
