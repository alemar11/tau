import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameDecoder, encodeFrame, MAX_FRAME_BYTES, MAX_OUTPUT_BYTES, writeFrame } from "../src/protocol/framing.ts";
import { envelope, parseRequest } from "../src/protocol/messages.ts";

function decode(chunks) {
  const decoder = new FrameDecoder();
  const messages = [];
  for (const chunk of chunks) decoder.push(chunk, (message) => { messages.push(message); });
  return messages;
}

const messages = [{ a: "🙂 caffè\n\0", nested: [1, true, null] }, { second: "日本語" }, {}];
const stream = Buffer.concat(messages.map(encodeFrame));

test("every split, one-byte chunks and deterministic random segmentation preserve Unicode frames", () => {
  for (let at = 0; at <= stream.length; at++) {
    assert.deepEqual(decode([stream.subarray(0, at), stream.subarray(at)]), messages);
  }
  assert.deepEqual(decode([...stream].map((byte) => Buffer.from([byte]))), messages);
  let seed = 42;
  for (let run = 0; run < 100; run++) {
    const chunks = [];
    for (let offset = 0; offset < stream.length;) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const length = 1 + seed % 31;
      chunks.push(stream.subarray(offset, offset + length));
      offset += length;
    }
    assert.deepEqual(decode(chunks), messages);
  }
});

test("frame boundary counts the complete UTF-8 JSON payload, including escaping, excluding the header", () => {
  for (const value of ["x".repeat(MAX_FRAME_BYTES - 2), "é".repeat((MAX_FRAME_BYTES - 2) / 2)]) {
    const frame = encodeFrame(value);
    assert.equal(frame.length, MAX_FRAME_BYTES + 4);
    assert.equal(frame.readUInt32BE(), MAX_FRAME_BYTES);
    assert.deepEqual(decode([frame]), [value]);
    assert.throws(() => encodeFrame(value + "x"), /limit/);
  }
  assert.throws(() => encodeFrame({ text: "x".repeat(MAX_FRAME_BYTES - 2) }), /limit/);
  assert.throws(() => encodeFrame("\0".repeat(Math.ceil(MAX_FRAME_BYTES / 6))), /limit/);
  assert.throws(() => encodeFrame(undefined), /serializable/);
  assert.throws(() => encodeFrame(1n));
  const circular = {}; circular.self = circular;
  assert.throws(() => encodeFrame(circular));
});

test("invalid length, invalid JSON and invalid UTF-8 poison only that decoder", () => {
  for (const size of [0, MAX_FRAME_BYTES + 1, 0xffffffff]) {
    const header = Buffer.alloc(4); header.writeUInt32BE(size);
    assert.throws(() => decode([header]), /length/);
  }
  for (const payload of [Buffer.from("{bad"), Buffer.from([0x22, 0xc3, 0x28, 0x22])]) {
    const header = Buffer.alloc(4); header.writeUInt32BE(payload.length);
    const decoder = new FrameDecoder();
    assert.throws(() => decoder.push(Buffer.concat([header, payload]), () => {}));
    assert.throws(() => decoder.push(encodeFrame({}), () => {}), /closed/);
  }
  assert.deepEqual(decode([encodeFrame({ ok: true })]), [{ ok: true }]);
});

test("receiver can stop a coalesced stream immediately", () => {
  const seen = [];
  new FrameDecoder().push(stream, (message) => { seen.push(message); return false; });
  assert.deepEqual(seen, [messages[0]]);
});

test("writer bounds the native queue before writing and propagates backpressure", () => {
  let writes = 0;
  const frame = encodeFrame({ ok: true });
  const sink = { destroyed: false, writableLength: MAX_OUTPUT_BYTES - frame.length,
    write(bytes) { writes++; this.writableLength += bytes.length; return false; } };
  assert.equal(writeFrame(sink, { ok: true }), false);
  assert.equal(sink.writableLength, MAX_OUTPUT_BYTES);
  assert.throws(() => writeFrame(sink, { ok: true }), /budget/);
  assert.equal(writes, 1);
  sink.writableLength = 0; sink.destroyed = true;
  assert.throws(() => writeFrame(sink, { ok: true }), /closed/);
});

test("protocol validates namespace/version, bounded correlation and specific workgroup arrays", () => {
  assert.deepEqual(parseRequest({ ...envelope("register", "r"), workgroups: [" a ", "b", "a"] }),
    { type: "register", requestId: "r", workgroups: ["a", "b"] });
  assert.deepEqual(parseRequest({ ...envelope("register", "r"), workgroups: [] }).workgroups, ["default"]);
  for (const value of [null, [], 1, { ...envelope("health", "r"), version: 2 },
    { ...envelope("health", "r"), protocol: "other" }, envelope("health", "é".repeat(129)),
    envelope("health", "bad\0id"), envelope("", "r"), envelope("bad\0type", "r"),
    { ...envelope("health", "r"), extra: true },
    { ...envelope("register", "r"), workgroups: ["default"] },
    { ...envelope("register", "r"), workgroups: [1] }, envelope("register", "r")]) {
    assert.throws(() => parseRequest(value));
  }
  assert.equal(parseRequest(envelope("health", "é".repeat(128))).requestId.length, 128);
});
