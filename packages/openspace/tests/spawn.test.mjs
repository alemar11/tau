import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { ensureBroker, launchCommand } from "../src/broker/spawn.ts";
import { startBroker } from "../src/broker/server.ts";
import { acquireClaim, prepareRuntime, privateSocket, processAlive } from "../src/broker/runtime-files.ts";
import { probeBroker } from "../src/broker/probe.ts";
import { resolvePaths } from "../src/paths.ts";
import { fixture, raw, terminate, until } from "./fixtures/broker-helpers.mjs";

const exec = promisify(execFile);
const defaults = { brokerArgs: [] };
const worker = fileURLToPath(new URL("./fixtures/broker-worker.mjs", import.meta.url));

async function concurrent(paths, env, log) {
  const results = await Promise.all(Array.from({ length: 6 }, async () => {
    const { stdout } = await exec(process.execPath, [worker, log], { env, timeout: 12_000, maxBuffer: 4096 });
    return JSON.parse(stdout);
  }));
  assert.equal(new Set(results.map((health) => health.instanceId)).size, 1);
  assert.equal(new Set(results.map((health) => health.pid)).size, 1);
  assert.equal((await probeBroker(paths.socketPath)).health.pid, results[0].pid);
  return results[0];
}

test("concurrent independent launchers start one detached broker and recover dead lock/PID/socket", { timeout: 20_000 }, async (t) => {
  const { root, paths, env, cleanup } = fixture(t);
  const log = join(root, "launches.jsonl");
  const first = await concurrent(paths, env, log);
  cleanup(() => terminate(first.pid));
  let launches = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].cwd, paths.runtimeDir);
  assert.notEqual(launches[0].command, "npx");
  assert.ok(launches[0].args.includes("--import"));
  const oldOwner = JSON.parse(readFileSync(join(paths.runtimeDir, "broker.pid"), "utf8"));
  process.kill(first.pid, "SIGKILL");
  await until(() => !processAlive(first.pid));
  writeFileSync(join(paths.runtimeDir, "spawn.lock"), JSON.stringify(oldOwner), { mode: 0o600 });
  writeFileSync(join(paths.runtimeDir, `.reap-${oldOwner.token}`), JSON.stringify({ ...oldOwner, token: "f".repeat(32) }), { mode: 0o600 });
  const second = await concurrent(paths, env, log);
  cleanup(() => terminate(second.pid));
  assert.notEqual(second.instanceId, first.instanceId);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
  assert.equal(existsSync(privateSocket(paths.runtimeDir, oldOwner)), false);
  assert.equal(existsSync(join(paths.runtimeDir, "spawn.lock")), false);
  const peer = await raw(t, paths.socketPath);
  assert.equal((await peer.register("r")).type, "registered");
  await terminate(second.pid);
  await peer.closed;
  assert.deepEqual(readdirSync(paths.runtimeDir), ["leases.json", "state"]);
});

test("real process exits after five idle seconds even if health probes keep arriving", { timeout: 12_000 }, async (t) => {
  const { paths, env, cleanup } = fixture(t);
  const health = await ensureBroker(paths, defaults, { env });
  cleanup(() => terminate(health.pid));
  const start = performance.now();
  await until(async () => {
    const result = await probeBroker(paths.socketPath);
    return result.status === "absent" && !processAlive(health.pid);
  }, 8_000);
  assert.ok(performance.now() - start >= 4_000);
  assert.deepEqual(readdirSync(paths.runtimeDir), ["leases.json", "state"]);
});

test("live/reused owner PID, corrupt lock and unrelated socket are never evicted", async (t) => {
  const { root, paths, env } = fixture(t);
  prepareRuntime(paths);
  const lock = join(paths.runtimeDir, "spawn.lock");
  const claim = acquireClaim(lock);
  assert.ok(claim);
  assert.equal(lstatSync(lock).mode & 0o777, 0o600);
  const before = readFileSync(lock, "utf8");
  let launches = 0;
  await assert.rejects(ensureBroker(paths, defaults, { env, timeoutMs: 80, launch() { launches++; throw new Error("unexpected spawn"); } }), /live owner/);
  assert.equal(launches, 0);
  assert.equal(readFileSync(lock, "utf8"), before);
  claim.release();
  writeFileSync(lock, "corrupt", { mode: 0o600 });
  await assert.rejects(ensureBroker(paths, defaults, { env }), /inspect it manually/);
  assert.equal(readFileSync(lock, "utf8"), "corrupt");
  // A stale-looking timestamp is not permission to delete a currently live PID.
  writeFileSync(join(paths.runtimeDir, "broker.pid"), JSON.stringify({ ...JSON.parse(before), createdAt: 1 }));
  await assert.rejects(startBroker(paths), /still alive/);
  assert.equal(JSON.parse(readFileSync(join(paths.runtimeDir, "broker.pid"), "utf8")).pid, process.pid);
  const other = resolvePaths({ PI_CODING_AGENT_DIR: join(root, "other") });
  prepareRuntime(other);
  writeFileSync(other.socketPath, "not an owned socket");
  await assert.rejects(startBroker(other), /unknown ownership/);
  assert.equal(readFileSync(other.socketPath, "utf8"), "not an owned socket");
});

test("failed health on a live foreign endpoint is not absence and never triggers spawn or unlink", async (t) => {
  const { paths, env, cleanup } = fixture(t);
  prepareRuntime(paths);
  const sockets = new Set();
  const server = createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  cleanup(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  await new Promise((resolve) => server.listen(paths.socketPath, resolve));
  const inode = lstatSync(paths.socketPath).ino;
  assert.equal((await probeBroker(paths.socketPath, 30)).status, "occupied");
  await assert.rejects(ensureBroker(paths, defaults, { env, timeoutMs: 100, launch() { throw new Error("must not spawn"); } }), /health timeout/);
  assert.equal(lstatSync(paths.socketPath).ino, inode);
});

test("default launcher ignores a standalone host executable; custom paths/args preserve spaces and Unicode", async (t) => {
  const { root, paths, env, cleanup } = fixture(t);
  const fake = join(root, "pi-standalone");
  const marker = join(root, "wrong-executable");
  writeFileSync(fake, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  const resolved = await launchCommand(defaults, env, fake);
  assert.notEqual(resolved.command, fake);
  assert.equal(existsSync(marker), false);
  const custom = join(root, "node caffè 🙂");
  symlinkSync(process.execPath, custom);
  const config = { brokerCommand: custom, brokerArgs: resolved.args.slice(0, -1) };
  const health = await ensureBroker(paths, config, { env });
  cleanup(() => terminate(health.pid));
  assert.equal((await probeBroker(paths.socketPath)).status, "ready");
  process.kill(health.pid, "SIGINT");
  await until(() => !processAlive(health.pid));
  assert.deepEqual(readdirSync(paths.runtimeDir), ["leases.json", "state"]);
  await assert.rejects(launchCommand(defaults, { PATH: "" }, fake), /Node.js 22.19/);
});

test("startup stderr is bounded and failed/timed-out children and locks are cleaned up", { timeout: 10_000 }, async (t) => {
  const { root, paths, env } = fixture(t);
  const failing = join(root, "failure.mjs");
  writeFileSync(failing, 'process.stderr.write("START FAILURE " + "x".repeat(50000), () => { process.exitCode = 3; });');
  await assert.rejects(ensureBroker(paths, { brokerCommand: process.execPath, brokerArgs: [failing] }, { env }), (error) => {
    assert.match(error.message, /START FAILURE/);
    assert.match(error.message, /truncated/);
    assert.ok(Buffer.byteLength(error.message) < 17_000);
    return true;
  });
  assert.equal(existsSync(join(paths.runtimeDir, "spawn.lock")), false);
  await assert.rejects(ensureBroker(paths, { brokerCommand: join(root, "missing"), brokerArgs: [] }, { env }), /ENOENT/);
  const hanging = join(root, "hang.mjs");
  writeFileSync(hanging, 'setInterval(() => {}, 1000);');
  let child;
  await assert.rejects(ensureBroker(paths, { brokerCommand: process.execPath, brokerArgs: [hanging] }, {
    env, timeoutMs: 150, launch(...args) { child = spawn(...args); return child; },
  }), /timed out/);
  assert.ok(child?.pid);
  assert.equal(processAlive(child.pid), false);
  assert.deepEqual(readdirSync(paths.runtimeDir), []);
});

test("path byte limits and unsafe runtime directories fail before launch without a network fallback", async (t) => {
  const { root, env, cleanup } = fixture(t);
  const length = 103 - Buffer.byteLength(join(root, "openspace", "broker.sock")) - 1;
  const boundary = resolvePaths({ PI_CODING_AGENT_DIR: join(root, "x".repeat(length)) });
  assert.equal(Buffer.byteLength(boundary.socketPath), 103);
  const broker = await startBroker(boundary);
  cleanup(() => broker.stop());
  assert.equal((await probeBroker(boundary.socketPath)).status, "ready");
  const tooLong = resolvePaths({ PI_CODING_AGENT_DIR: join(root, "🙂".repeat(40)) });
  await assert.rejects(ensureBroker(tooLong, defaults, { env }), /103 UTF-8 bytes/);
  assert.equal(existsSync(tooLong.runtimeDir), false);
  const target = join(root, "target"); mkdirSync(target, { mode: 0o755 }); chmodSync(target, 0o755);
  const paths = resolvePaths({ PI_CODING_AGENT_DIR: root });
  symlinkSync(target, paths.runtimeDir);
  await assert.rejects(ensureBroker(paths, defaults, { env }), /not a symlink/);
  assert.equal(lstatSync(target).mode & 0o777, 0o755);
});
