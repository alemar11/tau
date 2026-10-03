import assert from "node:assert/strict";
import { test } from "node:test";
import { Receiver } from "../extensions/openspace/receiver.ts";
import { FakeClock } from "./fixtures/broker-helpers.mjs";

function fixture(options = {}) {
  const clock = new FakeClock(), listeners = new Set(), receipts = [], injected = [], busy = [];
  const memberships = new Map([["default", "d1"], ["g", "g1"]]);
  const state = { alive: true, idle: false, running: false, compacting: true, interactive: true, pending: false };
  const messenger = { subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async receipt(ref, status, code) { receipts.push({ ref, status, code }); },
    client: { membership(workgroup) { if (!memberships.has(workgroup)) throw new Error("left"); return { workgroup, epoch: memberships.get(workgroup) }; },
      hasMembership(stamp) { return memberships.get(stamp.workgroup) === stamp.epoch; } } };
  const receiver = new Receiver(messenger, { state: () => state, inject: (message, trigger, steer) => injected.push({ message, trigger, steer }),
    busy: (message) => busy.push(message) }, { inboundTrigger: "never", busyDelivery: "steer", ...options.policy }, { clock, limits: options.limits });
  const emit = (id, extra = {}) => { for (const fn of listeners) fn({ type: "message", message: { id, workgroup: "default", sender: { id: "sender" }, text: id, ...extra } }); };
  return { receiver, clock, state, receipts, injected, memberships, emit };
}

test("held count/bytes/TTL are bounded and observable, with no timer once empty or dead", () => {
  const f = fixture({ limits: { heldCount: 2, heldBytes: 1024, heldMs: 1000, pollMs: 100 } });
  f.emit("first"); f.emit("second"); f.emit("overflow");
  assert.equal(f.receiver.heldCount, 2); assert.ok(f.receipts.some((r) => r.ref.messageId === "overflow" && r.code === "held_overflow"));
  assert.equal(f.clock.timers.size, 1);
  f.clock.advance(1000); assert.equal(f.receiver.heldCount, 0); assert.equal(f.clock.timers.size, 0);
  assert.equal(f.receipts.filter((r) => r.code === "held_expired").length, 2);
  f.emit("huge", { text: "x".repeat(1024) }); assert.equal(f.receiver.heldCount, 0);
  f.emit("shutdown"); f.receiver.stop(); f.clock.advance(1000); assert.equal(f.clock.timers.size, 0); assert.equal(f.injected.length, 0);
  assert.ok(f.receipts.some((r) => r.ref.messageId === "shutdown" && r.code === "session_ended"));
});

test("receiver dedupe is group+sender+ID, bounded by count/TTL, and duplicates never reinject while retained", () => {
  const f = fixture({ limits: { dedupeCount: 3, dedupeMs: 1000 } }); Object.assign(f.state, { idle: true, compacting: false });
  f.emit("same"); f.emit("same"); f.emit("same", { workgroup: "g" }); f.emit("same", { sender: { id: "other" } });
  assert.equal(f.injected.length, 3); assert.ok(f.receipts.some((r) => r.code === "duplicate"));
  f.emit("evicts-oldest"); f.emit("same"); assert.equal(f.injected.length, 5);
  f.clock.advance(1000); f.emit("same"); assert.equal(f.injected.length, 6);
  f.receiver.stop();
});

test("timer flush handles busy-without-run and silent compaction completion, but never revives a departed membership", () => {
  const f = fixture(); f.emit("left"); f.emit("survivor", { workgroup: "g" });
  f.memberships.set("default", "d2"); // Same textual group after leave/rejoin, different epoch.
  Object.assign(f.state, { compacting: false }); f.clock.advance(250); assert.equal(f.injected.length, 0);
  f.state.idle = true; f.clock.advance(250);
  assert.deepEqual(f.injected.map((item) => item.message.id), ["survivor"]);
  assert.ok(f.receipts.some((r) => r.ref.messageId === "left" && r.code === "workgroup_left"));
  assert.equal(f.clock.timers.size, 0); f.receiver.stop();
});

test("human-first does not drain a queue when becoming idle and already injected cancellation stays a request", () => {
  const f = fixture({ policy: { busyDelivery: "human-first" } }); f.emit("one"); f.emit("two");
  Object.assign(f.state, { idle: true, compacting: false }); f.receiver.flush(true); f.clock.advance(1000);
  assert.equal(f.injected.length, 1); assert.equal(f.receiver.heldCount, 1);
  f.receiver.cancel({ senderId: "sender", workgroup: "default", messageId: "one" });
  assert.equal(f.receipts.at(-1).status, "cancellation_requested");
  f.receiver.turnStarted(); f.receiver.flush(true); assert.equal(f.injected.length, 2); f.receiver.stop();
});
