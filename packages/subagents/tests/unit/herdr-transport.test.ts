import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { BridgeChannel } from "../../extensions/subagents/src/runs/shared/herdr-pi-channel.ts";
import { HerdrRpcError, SocketRpcClient } from "../../extensions/subagents/src/runs/shared/herdr-connection.ts";
import { HerdrJsonLineDecoder } from "../../extensions/subagents/src/runs/shared/herdr-wire.ts";
import registerHerdrPiBridge from "../../extensions/subagents/src/extension/herdr-pi-bridge.ts";
import { encodeHerdrPiFrame, HERDR_PI_MAX_FRAME_BYTES, HERDR_PI_PROTOCOL, HERDR_PI_RUN_ENV, HERDR_PI_RUNTIME_DIR_ENV, HerdrPiFrameDecoder, type HerdrPiFrame } from "../../extensions/subagents/src/runs/shared/herdr-pi-protocol.ts";
import { reconcileHerdrReconnect, type HerdrReconnectCandidate, type HerdrRunIdentity } from "../../extensions/subagents/src/runs/shared/herdr-placed-run.ts";
import packageJson from "../../package.json" with { type: "json" };

const runId = "run_wire_fixture";
const line = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const frame = (type: string, fields: Record<string, unknown> = {}): HerdrPiFrame => ({ protocol: HERDR_PI_PROTOCOL, runId, type, ...fields });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function withWire<T>(handler: (socket: net.Socket) => void, action: (socketPath: string) => Promise<T>): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tau-wire-"));
  const socketPath = path.join(directory, "s.sock"), sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {}); // Expected when the client rejects fixture bytes.
    socket.on("close", () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  try { return await action(socketPath); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
function onRequest(socket: net.Socket, handler: (request: Record<string, unknown>) => void): void {
  const decoder = new HerdrJsonLineDecoder(4 * 1024 * 1024);
  socket.on("data", (chunk: Buffer) => { for (const request of decoder.push(chunk)) handler(request); });
}

// No SSH, real Herdr/Ghostty, model calls or remote process placement.
describe("Herdr bounded wire decoding", () => {
  it("round-trips every split of a UTF-8 frame, including inside a multibyte character", () => {
    const value = frame("event", { text: "à漢字🙂", requestId: "request_1" }), bytes = encodeHerdrPiFrame(value);
    for (let i = 0; i <= bytes.length; i++) {
      const decoder = new HerdrPiFrameDecoder();
      assert.deepEqual([...decoder.push(bytes.subarray(0, i)), ...decoder.push(bytes.subarray(i))], [value]);
      decoder.end();
    }
  });
  it("accepts byte-at-a-time fragmentation without corrupting a following frame", () => {
    const value = frame("event", { text: "x".repeat(64 * 1024) }), bytes = encodeHerdrPiFrame(value);
    const decoder = new HerdrPiFrameDecoder();
    const frames: HerdrPiFrame[] = [];
    for (let i = 0; i < bytes.length; i++) frames.push(...decoder.push(bytes.subarray(i, i + 1)));
    frames.push(...decoder.push(encodeHerdrPiFrame(frame("ready"))));
    assert.deepEqual(frames, [value, frame("ready")]); decoder.end();
  });
  it("bounds individual frames rather than a coalesced socket chunk", () => {
    const value = frame("event", { text: "x".repeat(700_000) }), bytes = encodeHerdrPiFrame(value);
    assert.deepEqual(new HerdrPiFrameDecoder().push(Buffer.concat([bytes, bytes, bytes])), [value, value, value]);
  });
  it("uses the same exact byte limit for encoder, complete frames and partial frames", () => {
    const base = frame("event", { text: "" }), overhead = encodeHerdrPiFrame(base).length;
    const exact = encodeHerdrPiFrame({ ...base, text: "x".repeat(HERDR_PI_MAX_FRAME_BYTES - overhead) });
    assert.equal(exact.length, HERDR_PI_MAX_FRAME_BYTES);
    assert.equal(new HerdrPiFrameDecoder().push(exact).length, 1);
    assert.throws(() => encodeHerdrPiFrame({ ...base, text: "x".repeat(HERDR_PI_MAX_FRAME_BYTES - overhead + 1) }), /exceeds/);
    assert.throws(() => new HerdrPiFrameDecoder().push(Buffer.alloc(HERDR_PI_MAX_FRAME_BYTES, 120)), /exceeds/);
    const decoder = new HerdrPiFrameDecoder();
    decoder.push(exact.subarray(0, -1));
    assert.throws(() => decoder.push(Buffer.from("x\n")), /exceeds/);
  });
  for (const [name, value] of Object.entries({ null: null, array: [], scalar: 1, protocol: frame("event", { protocol: 99 }), run: frame("event", { runId: "bad" }), type: frame(""), request: frame("prepared", { requestId: {} }) })) {
    it(`rejects ${name} envelopes and latches the failure`, () => {
      const decoder = new HerdrPiFrameDecoder();
      assert.throws(() => decoder.push(line(value)));
      assert.throws(() => decoder.push(encodeHerdrPiFrame(frame("ready"))));
      assert.throws(() => decoder.end());
    });
  }
  it("rejects malformed UTF-8 and partial EOF without accepting later bytes", () => {
    assert.throws(() => new HerdrPiFrameDecoder().push(Buffer.from([0xc0, 0xaf, 0x0a])), /UTF-8/);
    const decoder = new HerdrPiFrameDecoder();
    decoder.push(Buffer.from('{"protocol":'));
    assert.throws(() => decoder.end(), /partial frame/);
    assert.throws(() => decoder.push(encodeHerdrPiFrame(frame("ready"))), /partial frame/);
  });
});

describe("Herdr RPC over local sockets", { skip: process.platform === "win32", timeout: 15_000 }, () => {
  it("accepts a fragmented matching response and retains structured errors", async () => {
    await withWire((socket) => onRequest(socket, (request) => {
      const bytes = line({ id: request.id, result: { text: "à🙂" } });
      socket.write(bytes.subarray(0, 9)); setImmediate(() => socket.end(bytes.subarray(9)));
    }), async (socket) => assert.deepEqual(await new SocketRpcClient(socket).call("pane.get"), { text: "à🙂" }));
    for (const id of ["1", ""]) await withWire((socket) => onRequest(socket, () => socket.end(line({ id, error: { code: "invalid_request", message: "refused" } }))), async (socket) => {
      await assert.rejects(new SocketRpcClient(socket).call("pane.get"), (error) => error instanceof HerdrRpcError && error.code === "invalid_request" && error.requestId === id);
    });
  });
  for (const [name, value] of Object.entries({ null: null, array: [], scalar: true, missing: { id: "1" }, wrongId: { id: "other", result: {} }, error: { id: "1", error: "bad" }, both: { id: "1", result: {}, error: { code: "x", message: "x" } } })) {
    it(`rejects ${name} responses without an uncaught event-handler exception`, async () => {
      await withWire((socket) => onRequest(socket, () => socket.end(line(value))), async (socket) => assert.rejects(new SocketRpcClient(socket).call("pane.get")));
    });
  }
  it("rejects truncated EOF, malformed bytes, missing acknowledgement and oversized responses", async () => {
    for (const bytes of [Buffer.from('{"id":'), Buffer.from([0xff, 0x0a]), Buffer.alloc(4 * 1024 * 1024 + 1, 120)]) {
      await withWire((socket) => onRequest(socket, () => socket.end(bytes)), async (socket) => assert.rejects(new SocketRpcClient(socket).call("pane.get", {}, 1_000), /partial|UTF-8|bound|exceeds/));
    }
    await withWire((socket) => onRequest(socket, () => socket.end()), async (socket) => assert.rejects(new SocketRpcClient(socket).call("pane.get"), /ended before a response/));
    await withWire(() => {}, async (socket) => assert.rejects(new SocketRpcClient(socket).call("pane.get", {}, 10), /timed out.*unknown/));
  });
  it("refuses invalid or oversized outbound requests before opening a connection", async () => {
    let connections = 0;
    await withWire(() => { connections++; }, async (socket) => {
      const client = new SocketRpcClient(socket);
      await assert.rejects(client.call("pane.get", {}, Infinity), /timeout/);
      await assert.rejects(client.call("pane.get", { text: "x".repeat(4 * 1024 * 1024) }), /request exceeded/);
      await assert.rejects(client.subscribe(["x".repeat(4 * 1024 * 1024)], () => {}), /request exceeded/);
      await tick(); assert.equal(connections, 0);
    });
  });
  it("waits for acknowledgement, emits schema-shaped events, and unsubscribes silently", async () => {
    const event = { event: "pane.agent_status_changed", data: { pane_id: "p", terminal_id: "t", agent_status: "working" } };
    const received = Promise.withResolvers<unknown>();
    await withWire((socket) => onRequest(socket, (request) => {
      const ack = line({ id: request.id, result: { type: "subscription_started" } });
      socket.write(ack.subarray(0, 7)); setImmediate(() => socket.write(Buffer.concat([ack.subarray(7), line(event)])));
    }), async (socket) => {
      const disconnects: Error[] = [];
      const stop = await new SocketRpcClient(socket).subscribe([], received.resolve, (error) => disconnects.push(error));
      assert.deepEqual(await received.promise, event);
      stop(); stop(); await tick(); assert.deepEqual(disconnects, []);
    });
  });
  it("rejects malformed, foreign and premature subscription acknowledgements", async () => {
    for (const value of [null, [], { id: "other", result: { type: "subscription_started" } }, { id: "1", result: {} }, { event: "pane.closed", data: {} }]) {
      await withWire((socket) => onRequest(socket, () => socket.end(line(value))), async (socket) => assert.rejects(new SocketRpcClient(socket).subscribe([], () => assert.fail("not acknowledged"))));
    }
    await withWire(() => {}, async (socket) => assert.rejects(new SocketRpcClient(socket, 10).subscribe([], () => {}), /acknowledgement timed out/));
  });
  it("reports post-ack errors once, including same-chunk failure before subscribe returns", async () => {
    await withWire((socket) => onRequest(socket, (request) => socket.write(Buffer.concat([
      line({ id: request.id, result: { type: "subscription_started" } }),
      line({ id: "event-error", error: { code: "stream_failed", message: "lost after ack" } }),
    ]))), async (socket) => {
      const errors: Error[] = [];
      const stop = await new SocketRpcClient(socket).subscribe([], () => assert.fail("not an event"), (error) => errors.push(error));
      assert.equal(errors.length, 1); assert.match(errors[0]!.message, /lost after ack/);
      stop(); await tick(); assert.equal(errors.length, 1);
    });
  });
  it("bounds a partial subscription frame and stops buffered delivery after unsubscribe", async () => {
    const send = Promise.withResolvers<void>(), lost = Promise.withResolvers<Error>();
    await withWire((socket) => onRequest(socket, (request) => {
      socket.write(line({ id: request.id, result: { type: "subscription_started" } }));
      void send.promise.then(() => socket.write(Buffer.alloc(4 * 1024 * 1024, 120)));
    }), async (socket) => {
      const stop = await new SocketRpcClient(socket).subscribe([], () => assert.fail("partial frame"), lost.resolve);
      send.resolve(); assert.match((await lost.promise).message, /frame exceeds/); stop();
    });
    const events = Promise.withResolvers<void>(), received = Promise.withResolvers<void>();
    let count = 0;
    await withWire((socket) => onRequest(socket, (request) => {
      socket.write(line({ id: request.id, result: { type: "subscription_started" } }));
      void events.promise.then(() => socket.write(Buffer.concat([line({ event: "pane.closed", data: {} }), line({ event: "pane.closed", data: {} })])));
    }), async (socket) => {
      const stop = await new SocketRpcClient(socket).subscribe([], () => { count++; stop(); received.resolve(); });
      events.resolve(); await received.promise; await tick(); assert.equal(count, 1);
    });
  });
  it("fails closed on malformed events and listener errors after acknowledgement", async () => {
    for (const bad of [null, { event: "pane.closed", data: [] }, { event: "pane.closed", data: {} }]) {
      const send = Promise.withResolvers<void>(), lost = Promise.withResolvers<Error>();
      await withWire((socket) => onRequest(socket, (request) => {
        socket.write(line({ id: request.id, result: { type: "subscription_started" } }));
        void send.promise.then(() => socket.write(line(bad)));
      }), async (socket) => {
        const stop = await new SocketRpcClient(socket).subscribe([], () => { throw new Error("observer failed"); }, lost.resolve);
        send.resolve(); assert.match((await lost.promise).message, /object|envelope|observer failed/); stop();
      });
    }
  });
});

describe("Private Pi bridge channel over local sockets (placement stays gated)", { skip: process.platform === "win32", timeout: 15_000 }, () => {
  it("isolates malformed peers in the retained bridge server without crashing Pi or removing evidence", async () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "tau-bridge-"));
    const previous = [process.env[HERDR_PI_RUN_ENV], process.env[HERDR_PI_RUNTIME_DIR_ENV]];
    process.env[HERDR_PI_RUN_ENV] = runId; process.env[HERDR_PI_RUNTIME_DIR_ENV] = runtime;
    const handlers = new Map<string, Function>();
    try {
      registerHerdrPiBridge({ registerTool() {}, registerCommand() {}, on(name: string, handler: Function) { handlers.set(name, handler); } } as never);
      fs.writeFileSync(path.join(runtime, "manifest.json"), "retained");
      await tick();
      for (const bytes of [line(null), Buffer.from('{"protocol":'), encodeHerdrPiFrame(frame("prepare", { requestId: "unconfigured", operation: "prompt" }))]) {
        await new Promise<void>((resolve, reject) => {
          let connected = false;
          const client = net.createConnection(path.join(runtime, "bridge.sock"));
          client.on("connect", () => { connected = true; client.end(bytes); });
          client.on("error", (error) => { if (!connected) reject(error); });
          client.on("close", () => { assert.equal(connected, true); resolve(); });
        });
        assert.equal(fs.readFileSync(path.join(runtime, "manifest.json"), "utf8"), "retained");
      }
    } finally {
      handlers.get("session_shutdown")?.();
      for (const [i, key] of [HERDR_PI_RUN_ENV, HERDR_PI_RUNTIME_DIR_ENV].entries()) previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i];
      await tick(); fs.rmSync(runtime, { recursive: true, force: true });
    }
  });
  it("correlates configured/prepared responses and does not confuse readiness with them", async () => {
    const seen: string[] = [];
    await withWire((socket) => onRequest(socket, (request) => {
      seen.push(String(request.type));
      socket.write(encodeHerdrPiFrame(frame("ready")));
      socket.write(encodeHerdrPiFrame(frame(request.type === "configure" ? "configured" : "prepared", { requestId: request.requestId })));
    }), async (socket) => {
      const bridge = new BridgeChannel(socket, runId);
      assert.equal((await bridge.configure({ agent: "worker" })).type, "configured");
      assert.equal((await bridge.prepare("prompt_1", "prompt", "task")).requestId, "prompt_1");
      bridge.close(); assert.deepEqual(seen, ["configure", "prepare"]);
    });
  });
  it("returns already received readiness and removes pending readiness observers on loss", async () => {
    const delivered = Promise.withResolvers<void>();
    await withWire((socket) => { socket.write(encodeHerdrPiFrame(frame("ready", { configured: true }))); }, async (socket) => {
      const bridge = new BridgeChannel(socket, runId);
      bridge.listeners.add(() => delivered.resolve());
      await delivered.promise;
      assert.equal((await bridge.ready(100, "timeout", true)).configured, true);
      bridge.close();
      await assert.rejects(bridge.ready(10_000, "timeout"), /released.*unknown/);
    });
    await withWire((socket) => socket.end(), async (socket) => {
      const bridge = new BridgeChannel(socket, runId);
      await assert.rejects(bridge.ready(10_000, "timeout"), /connection was lost/);
      assert.equal(bridge.listeners.size, 0);
    });
  });
  it("rejects pending and future waits on explicit release, without writing a retry", async () => {
    let requests = 0;
    await withWire((socket) => onRequest(socket, () => { requests++; }), async (socket) => {
      const bridge = new BridgeChannel(socket, runId);
      const waiting = bridge.prepare("request_1", "prompt", "task");
      bridge.close();
      await assert.rejects(waiting, /released.*unknown/);
      await assert.rejects(bridge.prepare("request_2", "prompt", "retry"), /released.*unknown/);
      await assert.rejects(bridge.wait("prepared", "request_3"), /released.*unknown/);
      assert.throws(() => bridge.supervisorDelivered("reply_1"), /released/);
      assert.equal(bridge.waiters.size, 0); assert.ok(requests <= 1);
    });
  });
  it("does not overwrite a duplicate waiter or send a second request", async () => {
    const arrived = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>();
    let requests = 0;
    await withWire((socket) => onRequest(socket, (request) => {
      requests++; arrived.resolve();
      void reply.promise.then(() => socket.write(encodeHerdrPiFrame(frame("prepared", { requestId: request.requestId }))));
    }), async (socket) => {
      const bridge = new BridgeChannel(socket, runId);
      const first = bridge.prepare("same_id", "prompt");
      await arrived.promise;
      await assert.rejects(bridge.prepare("same_id", "prompt"), /Duplicate/);
      reply.resolve(); await first; assert.equal(requests, 1); bridge.close();
    });
  });
  it("rejects oversized requests before reserving a waiter or sending bytes", async () => {
    let requests = 0;
    await withWire((socket) => onRequest(socket, () => { requests++; }), async (socket) => {
      const bridge = new BridgeChannel(socket, runId);
      await assert.rejects(bridge.prepare("big", "prompt", "x".repeat(HERDR_PI_MAX_FRAME_BYTES)), /exceeds/);
      assert.equal(bridge.waiters.size, 0); await tick(); assert.equal(requests, 0); bridge.close();
    });
  });
  it("times out unknown acknowledgements and handshake, cancelling their waiters", async () => {
    await withWire(() => {}, async (socket) => {
      const bridge = new BridgeChannel(socket, runId, { requestTimeoutMs: 10 });
      await assert.rejects(bridge.prepare("silent", "prompt"), /acknowledgement timed out.*unknown/);
      assert.equal(bridge.waiters.size, 0); assert.equal(bridge.socket.destroyed, true);
    });
    await withWire(() => {}, async (socket) => {
      const bridge = new BridgeChannel(socket, runId);
      await assert.rejects(bridge.ready(10, "ready timeout"), /ready timeout.*unknown/);
      assert.equal(bridge.listeners.size, 0); assert.equal(bridge.failed, true);
    });
  });
  it("applies cancellation and the original deadline, including pre-connection rejection", async () => {
    let connections = 0;
    await withWire(() => { connections++; }, async (socket) => {
      const controller = new AbortController(); controller.abort();
      assert.throws(() => new BridgeChannel(socket, runId, { signal: controller.signal }), /before connection/);
      assert.throws(() => new BridgeChannel(socket, runId, { deadlineAt: Date.now() - 1 }), /deadline/);
      await tick(); assert.equal(connections, 0);
      const active = new AbortController(), bridge = new BridgeChannel(socket, runId, { signal: active.signal });
      const pending = bridge.prepare("active", "prompt"); active.abort();
      await assert.rejects(pending, /aborted.*unknown/);
      const deadline = new BridgeChannel(socket, runId, { deadlineAt: Date.now() + 25 });
      await assert.rejects(deadline.prepare("deadline", "prompt"), /deadline expired.*unknown/);
    });
  });
  it("closes on foreign identity, malformed frames, partial EOF and observer exceptions", async () => {
    for (const bytes of [encodeHerdrPiFrame(frame("ready", { runId: "foreign_run" })), line(null), Buffer.from('{"protocol":')]) {
      await withWire((socket) => socket.end(bytes), async (socket) => {
        const bridge = new BridgeChannel(socket, runId);
        await assert.rejects(bridge.ready(1_000, "timeout"), /identity|object|partial/);
        assert.equal(bridge.socket.destroyed, true);
      });
    }
    await withWire((socket) => socket.write(encodeHerdrPiFrame(frame("event"))), async (socket) => {
      const bridge = new BridgeChannel(socket, runId);
      bridge.listeners.add(() => { throw new Error("observer failed"); });
      await assert.rejects(bridge.failure, /observer failed/);
    });
  });
  it("bounds pending acknowledgements without evicting their existing ownership", async () => {
    await withWire(() => {}, async (socket) => {
      const bridge = new BridgeChannel(socket, runId);
      const pending = Array.from({ length: 64 }, (_, i) => assert.rejects(bridge.wait("prepared", String(i)), /released/));
      await assert.rejects(bridge.wait("prepared", "overflow"), /bound/);
      bridge.close(); await Promise.all(pending);
    });
  });
  it("bounds replay by aggregate bytes as well as frame count", async () => {
    for (const values of [Array.from({ length: 1025 }, () => frame("event")), Array.from({ length: 18 }, () => frame("event", { text: "x".repeat(512 * 1024) }))]) {
      await withWire((socket) => socket.write(Buffer.concat(values.map(encodeHerdrPiFrame))), async (socket) => {
        const bridge = new BridgeChannel(socket, runId);
        await assert.rejects(bridge.failure, /replay queue exceeded/);
        assert.ok(bridge.frames.length <= 1024);
        assert.ok(bridge.frames.reduce((total, value) => total + encodeHerdrPiFrame(value).length, 0) <= 8 * 1024 * 1024);
      });
    }
  });
});

describe("Herdr reconnect cursor evidence", () => {
  const identity = { runId, nativeSessionId: "native", terminalId: "terminal", session: null } as HerdrRunIdentity;
  const candidate: HerdrReconnectCandidate = {
    endpoint: { session: null, protocol: 22, version: "fixture" },
    agents: [{ terminal_id: "terminal", pane_id: "pane", agent_status: "done" }],
    bridge: { runId, nativeSessionId: "native", packageVersion: packageJson.version, protocol: HERDR_PI_PROTOCOL, evidenceCursor: 7, evidenceFloor: 5 },
  };
  it("keeps readiness distinct from settlement with contiguous evidence", () => {
    assert.deepEqual(reconcileHerdrReconnect(identity, candidate, 4), { ok: true, state: "ready", paneId: "pane", cursor: 7 });
  });
  it("rejects non-integer, negative, non-finite and discontinuous evidence", () => {
    for (const field of ["evidenceCursor", "evidenceFloor"] as const) for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(reconcileHerdrReconnect(identity, { ...candidate, bridge: { ...candidate.bridge, [field]: value } }, 4).ok, false);
    }
    for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(reconcileHerdrReconnect(identity, candidate, value).ok, false);
    assert.equal(reconcileHerdrReconnect(identity, { ...candidate, bridge: { ...candidate.bridge, evidenceFloor: 0 } }, 4).ok, false);
    assert.equal(reconcileHerdrReconnect(identity, { ...candidate, bridge: { ...candidate.bridge, evidenceFloor: 6 } }, 4).ok, false);
    assert.equal(reconcileHerdrReconnect(identity, { ...candidate, bridge: { ...candidate.bridge, evidenceCursor: 3 } }, 4).ok, false);
  });
});
