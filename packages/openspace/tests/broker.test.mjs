import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { encodeFrame, MAX_FRAME_BYTES } from "../src/protocol/framing.ts";
import { envelope } from "../src/protocol/messages.ts";
import { startBroker } from "../src/broker/server.ts";
import { probeBroker } from "../src/broker/probe.ts";
import { fixture, raw, FakeClock, until } from "./fixtures/broker-helpers.mjs";

async function brokerFixture(t, options) {
  const setup = fixture(t);
  const broker = await startBroker(setup.paths, options);
  setup.cleanup(() => broker.stop());
  return { ...setup, broker };
}

test("Unix health, restrictive permissions and ordered transport handshake without application features", async (t) => {
  const { paths, broker } = await brokerFixture(t);
  assert.equal(lstatSync(paths.runtimeDir).mode & 0o777, 0o700);
  assert.equal(lstatSync(paths.socketPath).mode & 0o777, 0o600);
  const pid = join(paths.runtimeDir, "broker.pid");
  assert.equal(lstatSync(pid).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(pid, "utf8")).token, broker.instanceId);
  const health = await probeBroker(paths.socketPath);
  assert.equal(health.status, "ready");
  assert.equal(health.health.instanceId, broker.instanceId);
  assert.equal(health.health.pid, process.pid);
  assert.deepEqual(health.health.features, ["liveness-v1"]);
  assert.deepEqual(Object.keys(health.health).sort(), ["features", "instanceId", "pid", "protocol", "requestId", "type", "version"]);
  const peer = await raw(t, paths.socketPath);
  peer.socket.write(Buffer.concat([
    encodeFrame({ ...envelope("register", "r"), workgroups: ["a", "b", "a"] }),
    encodeFrame(envelope("ping", "p")), encodeFrame(envelope("list", "l")),
  ]));
  const ack = await peer.receive();
  assert.equal(ack.type, "registered");
  assert.deepEqual(ack.workgroups, ["a", "b"]);
  assert.equal(ack.requestId, "r");
  assert.equal((await peer.receive()).type, "pong");
  assert.equal((await peer.receive()).code, "unsupported_operation");
  assert.equal((await peer.request("register", "again", { workgroups: [] })).code, "already_registered");
  await peer.closed;
  await broker.stop(); await broker.stop();
  assert.deepEqual(readdirSync(paths.runtimeDir), []);
});

test("malformed or incompatible peers are isolated while an established peer keeps responding", async (t) => {
  const { paths } = await brokerFixture(t);
  const good = await raw(t, paths.socketPath);
  await good.request("register", "r", { workgroups: [] });
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(MAX_FRAME_BYTES + 1);
  const invalidJson = Buffer.from([0, 0, 0, 1, 0x7b]);
  const invalidUtf8 = Buffer.from([0, 0, 0, 4, 0x22, 0xc3, 0x28, 0x22]);
  for (const data of [Buffer.alloc(4), oversized, invalidJson, invalidUtf8, encodeFrame(null)]) {
    const bad = await raw(t, paths.socketPath);
    bad.socket.write(data);
    await bad.closed;
    assert.equal((await good.request("ping", "still-alive")).type, "pong");
  }
  for (const fields of [{ version: 2 }, { protocol: "other" }]) {
    const bad = await raw(t, paths.socketPath);
    assert.equal((await bad.request("health", "v", fields)).code, "incompatible_protocol");
    await bad.closed;
  }
  for (const type of ["list", "send", "ping"]) {
    const bad = await raw(t, paths.socketPath);
    assert.equal((await bad.request(type, "before-register")).code, "registration_required");
  }
  const large = await raw(t, paths.socketPath);
  assert.equal((await large.request("register", "large", { workgroups: ["x".repeat(6144)] })).code, "registration_too_large");
  assert.equal((await good.request("ping", "after-large")).type, "pong");
});

test("socket fragmentation works across real writes and health alone does not extend idle", async (t) => {
  const clock = new FakeClock();
  const { paths, broker } = await brokerFixture(t, { clock });
  const peer = await raw(t, paths.socketPath);
  const frame = encodeFrame(envelope("health", "🙂"));
  for (const byte of frame) peer.socket.write(Buffer.from([byte]));
  assert.equal((await peer.receive()).requestId, "🙂");
  clock.advance(4_999);
  assert.equal((await probeBroker(paths.socketPath)).status, "ready");
  clock.advance(1);
  await broker.closed;
  assert.equal(existsSync(paths.socketPath), false);
  assert.equal(existsSync(join(paths.runtimeDir, "broker.pid")), false);
});

test("idle shutdown is cancelled by registration and restarts after the last disconnect", async (t) => {
  const clock = new FakeClock();
  const { paths, broker } = await brokerFixture(t, { clock });
  clock.advance(4_999);
  const first = await raw(t, paths.socketPath);
  await first.request("register", "r1", { workgroups: [] });
  clock.advance(50_000);
  assert.equal((await first.request("ping", "alive")).type, "pong");
  first.socket.destroy();
  await until(() => [...clock.timers].some((timer) => timer.at === clock.time + 5_000));
  clock.advance(4_999);
  const second = await raw(t, paths.socketPath);
  await second.request("register", "r2", { workgroups: [] });
  clock.advance(10_000);
  assert.equal((await second.request("ping", "alive-again")).type, "pong");
  second.socket.destroy();
  await until(() => [...clock.timers].some((timer) => timer.at === clock.time + 5_000));
  clock.advance(5_000);
  await broker.closed;
  assert.deepEqual(readdirSync(paths.runtimeDir), []);
});

test("unregistered cap, registration deadline, registered cap and rate refill are enforced", async (t) => {
  const clock = new FakeClock();
  const { paths } = await brokerFixture(t, { clock, limits: { unregistered: 1, registered: 1, rateCapacity: 3, ratePerSecond: 1 } });
  const first = await raw(t, paths.socketPath);
  await first.request("health", "h");
  const excess = await raw(t, paths.socketPath);
  await excess.closed;
  clock.advance(1_000);
  await first.closed;
  const active = await raw(t, paths.socketPath);
  await active.request("register", "r", { workgroups: [] });
  const extraSession = await raw(t, paths.socketPath);
  assert.equal((await extraSession.request("register", "full", { workgroups: [] })).code, "session_limit");
  await active.request("ping", "p1"); await active.request("ping", "p2");
  clock.advance(1_000);
  assert.equal((await active.request("ping", "refilled")).type, "pong");
  active.send("ping", "over-rate");
  await active.closed;
});

test("a non-reading peer hits a bounded output queue without stopping other peers", { timeout: 10_000 }, async (t) => {
  const { paths } = await brokerFixture(t, { limits: { outputBytes: 4096, rateCapacity: 10_000 } });
  const slow = await raw(t, paths.socketPath);
  await slow.request("register", "r", { workgroups: [] });
  slow.socket.pause();
  const health = encodeFrame(envelope("health", "x".repeat(256)));
  // One bounded input chunk can produce more output than the test queue budget.
  for (let i = 0; i < 8; i++) slow.socket.write(Buffer.concat(Array.from({ length: 200 }, () => health)));
  await until(async () => (await probeBroker(paths.socketPath)).status === "ready");
  slow.socket.resume();
  await slow.closed;
  assert.equal((await probeBroker(paths.socketPath)).status, "ready");
});

test("shutdown does not unlink replacement PID or public socket paths", async (t) => {
  const { paths, broker } = await brokerFixture(t);
  const pid = join(paths.runtimeDir, "broker.pid");
  renameSync(paths.socketPath, join(paths.runtimeDir, "old-socket"));
  renameSync(pid, join(paths.runtimeDir, "old-pid"));
  writeFileSync(paths.socketPath, "foreign socket-path file");
  writeFileSync(pid, "foreign pid-path file");
  await broker.stop();
  assert.equal(readFileSync(paths.socketPath, "utf8"), "foreign socket-path file");
  assert.equal(readFileSync(pid, "utf8"), "foreign pid-path file");
});
