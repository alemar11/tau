import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseCli, runCli, CLI_ASK_TIMEOUT_MS } from "../cli.ts";
import { shortId, terminalSafe } from "../src/presentation.ts";
import { startBroker } from "../src/broker/server.ts";
import { OpenspaceClient } from "../src/client/client.ts";
import { Messenger } from "../src/client/messenger.ts";
import { Conversation } from "../src/client/conversation.ts";
import { messageRef } from "../src/protocol/delivery.ts";
import { fixture, until, FakeClock } from "./fixtures/broker-helpers.mjs";
import { piSession } from "./fixtures/pi-session.mjs";

const bin = fileURLToPath(new URL("../cli.mjs", import.meta.url));
async function setup(t, options = {}) { const f = fixture(t), broker = await startBroker(f.paths, options); f.cleanup(() => broker.stop()); return { ...f, broker }; }
async function actor(f, id = "peer", groups = [], name, conversationOptions = {}) {
  const client = new OpenspaceClient({ socketPath: f.paths.socketPath, session: { id, cwd: f.root, model: "fixture", pid: process.pid, ...(name ? { name } : {}) }, workgroups: groups });
  const messenger = new Messenger(client), conversation = new Conversation(messenger, conversationOptions), events = [];
  messenger.subscribe((event) => events.push(event)); f.cleanup(async () => { conversation.dispose(); messenger.dispose(); await client.disconnect(); });
  await client.connect(); return { client, messenger, conversation, events, messages: () => events.filter((event) => event.type === "message").map((event) => event.message) };
}
function launch(f, args, env = {}, stdoutFd) {
  const child = spawn(process.execPath, [bin, ...args], { cwd: f.root, env: { ...f.env, ...env }, stdio: ["ignore", stdoutFd ?? "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout?.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); }); });
  f.cleanup(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await done; });
  return { child, done };
}
function json(output, code = 0) {
  assert.equal(output.signal, null, output.stderr); assert.equal(output.code, code, output.stderr || output.stdout);
  assert.equal(output.stdout.trim().split("\n").length, 1); assert.equal(output.stderr, "");
  const value = JSON.parse(output.stdout); assert.equal(value.version, 1); return value;
}

test("strict CLI parsing accepts only documented combinations, exact text and bounded decimal timeouts", () => {
  assert.equal(parseCli(["ask", "--to", "peer", "--text", "question"]).timeoutMs, 120000); assert.equal(CLI_ASK_TIMEOUT_MS, 120000);
  assert.equal(parseCli(["send", "--text=--json", "--to", "peer"]).text, "--json");
  assert.equal(parseCli(["send", "--to", "peer", "--text", "  raw\n世界  "]).text, "  raw\n世界  ");
  assert.equal(parseCli(["--json", "list"]).json, true);
  for (const args of [["send"], ["ask", "--to", "peer"], ["list", "extra"], ["list", "--to", "peer"], ["list", "--text", "x"],
    ["send", "--to", "peer", "--text", "x", "--timeout-ms", "1"], ["list", "--unknown"], ["list", "--json", "--json"],
    ["list", "--json=false"], ["--version", "list"], ["--version", "--help"], ["--help", "--name", "x"], ["relay"], ["list", "--name", ""],
    ["list", "--workgroup", " x "], ["ask", "--to", "peer", "--text", "  "]]) assert.throws(() => parseCli(args), { code: "usage_error" }, args.join(" "));
  for (const value of ["0", "-1", "1e3", "NaN", "1.1", "2147483648", "", " 1 "]) assert.throws(() => parseCli(["ask", "--to", "peer", "--text", "q", `--timeout-ms=${value}`]), { code: "usage_error" });
});

test("human prefixes preserve whole Unicode codepoints and escape unpaired surrogates instead of displaying replacement identities", () => {
  assert.equal(shortId("1234567🙂peer", []), "1234567🙂");
  assert.equal(terminalSafe("🙂\ud800"), "🙂\\ud800");
});

test("real launcher emits one JSON object for parse/config errors and never starts an absent broker", async (t) => {
  const f = fixture(t);
  for (const args of [["send", "--json"], ["list", "--typo", "--json"], ["list", "--json=false"], ["relay", "--json"]]) {
    const result = json(await launch(f, args).done, 1); assert.equal(result.ok, false); assert.equal(result.error.code, "usage_error");
  }
  const absent = json(await launch(f, ["list", "--json"]).done, 1); assert.equal(absent.error.code, "broker_unavailable"); assert.match(absent.error.message, /Pi.*Openspace/);
  assert.equal(existsSync(f.paths.runtimeDir), false);
  mkdirSync(f.paths.runtimeDir, { recursive: true }); writeFileSync(f.paths.configPath, "broken-json");
  assert.equal(json(await launch(f, ["list", "--json"]).done, 1).error.code, "invalid_config");
  assert.equal(json(await launch(f, ["--help", "--json"]).done).command, "help");
  assert.equal(json(await launch(f, ["--version", "--json"]).done).packageVersion, "0.1.0");
  writeFileSync(f.paths.configPath, JSON.stringify({ brokerCommand: "must-not-execute", enabled: false, confirmSend: true }));
  assert.equal(json(await launch(f, ["list", "--json"]).done, 1).error.code, "broker_unavailable");
  assert.equal(existsSync(f.paths.socketPath), false); assert.equal(existsSync(join(f.paths.runtimeDir, "broker.pid")), false);
  assert.equal(json(await launch(f, ["list", "--json"], { PI_OPENSPACE_WORKGROUPS: "default" }).done, 1).error.code, "invalid_config");
  assert.equal(json(await launch(f, ["list", "--json"], { PI_OPENSPACE_LIVENESS_INTERVAL_MS: "invalid" }).done, 1).error.code, "invalid_config");
});

test("list gives complete IDs in JSON and collision-free human prefixes without its own temporary row", async (t) => {
  const f = await setup(t), a = await actor(f, "abcdefgh-one", ["x", "y"], "One"), b = await actor(f, "abcdefgh-two", ["x"], "Two"); await actor(f, "hidden", ["z"]);
  const listed = json(await launch(f, ["list", "--json"], { PI_OPENSPACE_WORKGROUPS: "x,y" }).done);
  assert.deepEqual(listed.sessions.map((peer) => peer.id).sort(), [a.client.info.id, b.client.info.id]); assert.deepEqual(listed.sessions[0].workgroups, ["x", "y"]);
  const human = await launch(f, ["list"], { PI_OPENSPACE_WORKGROUPS: "x" }).done;
  assert.equal(human.code, 0); assert.equal(human.stderr, ""); assert.match(human.stdout, /abcdefgh-o\tOne/); assert.match(human.stdout, /abcdefgh-t\tTwo/);
  assert.equal(json(await launch(f, ["list", "--workgroup", "z", "--json"], { PI_OPENSPACE_WORKGROUPS: "x" }).done, 1).error.code, "workgroup_not_shared");
  await until(async () => (await a.client.listSessions()).length === 2);
});

test("send preserves text, alias and delivery semantics; explicit automation ignores extension confirmation/identity", async (t) => {
  const f = await setup(t), peer = await actor(f), content = "  世界\ntext\u001b[31m  ";
  writeFileSync(f.paths.configPath, JSON.stringify({ confirmSend: true, stableId: "peer", enabled: false, brokerCommand: "must-not-execute" }));
  const result = json(await launch(f, ["send", "--to", "peer", "--text", content, "--name", "build-hook", "--json"], { PI_OPENSPACE_STABLE_ID: "peer" }).done);
  assert.equal(result.ok, true); assert.equal(result.delivery, "socket_delivered"); assert.equal(result.workgroup, "default"); assert.equal(result.outcomeKnown, true);
  await until(() => peer.messages().length === 1); const message = peer.messages()[0];
  assert.equal(message.text, content); assert.equal(message.id, result.messageId); assert.equal(message.sender.name, "build-hook"); assert.notEqual(message.sender.id, "peer");
  assert.deepEqual(message.provenance, { kind: "local" }); assert.equal(peer.client.isConnected, true);
  const failed = json(await launch(f, ["send", "--to", "missing", "--text", "no", "--json"]).done, 1);
  assert.equal(failed.delivery, "failed"); assert.equal(failed.error.code, "target_not_found"); assert.ok(failed.messageId);
  const oversized = json(await launch(f, ["send", "--to", "peer", "--text", "not sent", "--name", "x".repeat(7000), "--json"]).done, 1);
  assert.equal(oversized.error.code, "record_too_large"); assert.equal(peer.messages().length, 1);
});

test("send to a retained offline ID is queued, never reported as socket delivery or task completion", async (t) => {
  const f = await setup(t), peer = await actor(f), observer = await actor(f, "observer"); await peer.client.disconnect();
  await until(async () => !(await observer.client.listSessions()).some((row) => row.id === "peer"));
  const result = json(await launch(f, ["send", "--to", "peer", "--text", "mailbox", "--json"]).done);
  assert.equal(result.delivery, "queued"); assert.equal(result.ok, true); await peer.client.connect(); await until(() => peer.messages().length === 1);
  assert.equal(peer.messages()[0].id, result.messageId);
});

test("ask receives an immediate broker-validated reply, reports sender/text and registers a descriptive temporary session", async (t) => {
  const f = await setup(t), peer = await actor(f), child = launch(f, ["ask", "--to", "peer", "--text", "question", "--name", "question-hook", "--json"], { PI_OPENSPACE_ASK_TIMEOUT_MS: "1" });
  await until(() => peer.messages().length === 1); const ask = peer.messages()[0];
  const cli = (await peer.client.listSessions()).find((session) => session.id === ask.sender.id);
  assert.equal(cli.model, "openspace-cli"); assert.equal(cli.pid, child.child.pid); assert.equal(cli.cwd, realpathSync(f.root)); assert.equal(cli.status, undefined);
  await delay(30); await peer.conversation.reply({}, { text: "answer 世界", attachments: [{ type: "snippet", name: "snippet", text: "hello" }] });
  const result = json(await child.done); assert.equal(result.status, "answered"); assert.equal(result.response.sender.id, "peer"); assert.equal(result.response.text, "answer 世界");
  assert.equal(result.response.attachments[0].text, "hello"); assert.equal(result.messageId, ask.id); assert.equal(result.response.replyTo.senderId, ask.sender.id);
  await until(async () => (await peer.client.listSessions()).length === 1);
});

test("CLI early-reply correlation works before the send acknowledgement becomes observable", async (t) => {
  const f = await setup(t), peer = await actor(f); let release, sendAcknowledged = false, seenReply;
  const gate = new Promise((resolve) => { release = resolve; }); let stdout = "";
  peer.messenger.subscribe((event) => { if (event.type === "message" && event.message.expectsReply) void peer.conversation.reply({}, { text: "immediate" }); });
  const code = await runCli(["ask", "--to", "peer", "--text", "q", "--json"], { env: f.env, cwd: f.root, stdout(value) { stdout += value; }, stderr() { assert.fail("no diagnostics"); },
    createClient(options) {
      const client = new OpenspaceClient(options), request = client.request.bind(client);
      client.subscribe((event) => { if (event.type === "wire" && event.message.type === "message") seenReply = true; });
      client.request = async (type, ...args) => { const response = await request(type, ...args); if (type === "send") { await gate; sendAcknowledged = true; } return response; }; return client;
    } });
  assert.equal(code, 0); assert.equal(JSON.parse(stdout).response.text, "immediate"); assert.equal(seenReply, true); assert.equal(sendAcknowledged, false); release();
});

test("local ask timeout exits 2 without cancel or abandoning the broker edge; explicit alias allows bounded late mailbox recovery", async (t) => {
  const f = await setup(t), peer = await actor(f), child = launch(f, ["ask", "--to", "peer", "--text", "q", "--name", "hook", "--timeout-ms", "50", "--json"]);
  const result = json(await child.done, 2); assert.equal(result.error.code, "ask_timeout"); assert.match(result.error.message, /non.*cancellato/);
  assert.equal(peer.events.some((event) => event.type === "control"), false);
  assert.equal(JSON.parse(readFileSync(join(f.paths.runtimeDir, "pending-asks.json"), "utf8")).asks.length, 1);
  await until(async () => (await peer.client.listSessions()).length === 1);
  assert.equal((await peer.conversation.reply({}, { text: "late reply" })).delivery, "queued");
  const recovered = await actor(f, "new-id", [], "hook"); await until(() => recovered.messages().length === 1);
  assert.equal(recovered.messages()[0].text, "late reply"); assert.equal(recovered.messages()[0].replyTo.messageId, result.messageId);
});

test("a longer CLI timeout cannot extend the broker correlation lifetime", async (t) => {
  const clock = new FakeClock(), f = await setup(t, { clock, asks: { now: clock.now, timeoutMs: 100 } }), peer = await actor(f);
  const child = launch(f, ["ask", "--to", "peer", "--text", "q", "--timeout-ms", "10000", "--json"]);
  await until(() => peer.messages().length === 1); clock.advance(100);
  const late = await peer.messenger.send(peer.messages()[0].sender.id, { text: "too late", replyTo: messageRef(peer.messages()[0]) }); assert.equal(late.code, "ask_expired");
  const result = json(await child.done, 1); assert.equal(result.error.code, "ask_expired");
});

test("CLI timeout overrides do not keep an expired receiver tracker alive", async (t) => {
  const clock = new FakeClock(), f = await setup(t), peer = await actor(f, "peer", [], undefined, { clock, trackerTimeoutMs: 20 });
  const child = launch(f, ["ask", "--to", "peer", "--text", "q", "--timeout-ms", "10000", "--json"]);
  await until(() => peer.messages().length === 1); clock.advance(20);
  await assert.rejects(peer.conversation.reply({}, { text: "too late for receiver" }), { message: "reply_not_pending" });
  assert.equal(child.child.exitCode, null); child.child.kill("SIGTERM"); assert.equal(json(await child.done, 1).error.code, "interrupted");
});

test("disconnect during ask fails explicitly rather than hanging or claiming timeout", async (t) => {
  const f = await setup(t), peer = await actor(f), child = launch(f, ["ask", "--to", "peer", "--text", "q", "--json"]);
  await until(() => peer.messages().length === 1); await f.broker.stop(); const result = json(await child.done, 1);
  assert.equal(result.error.code, "disconnected");
});

test("SIGINT and SIGTERM settle one JSON result and remove the temporary CLI from the roster", async (t) => {
  const f = await setup(t), peer = await actor(f);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const count = peer.messages().length, child = launch(f, ["ask", "--to", "peer", "--text", "q", "--json"]);
    await until(() => peer.messages().length > count); child.child.kill(signal);
    assert.equal(json(await child.done, 1).error.code, "interrupted"); await until(async () => (await peer.client.listSessions()).length === 1);
  }
});

test("SIGTERM during backpressured output exits without leaving a client or waiting forever for the pipe", async (t) => {
  const f = await setup(t), peer = await actor(f), fifo = join(f.root, "output.fifo");
  // Node's default stdio socket can buffer an entire frame on macOS; a FIFO gives real backpressure on both platforms.
  execFileSync("mkfifo", [fifo]); const fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK); f.cleanup(() => closeSync(fd));
  const runner = launch(f, ["ask", "--to", "peer", "--text", "large reply", "--json"], {}, fd);
  await until(() => peer.messages().length === 1); await peer.conversation.reply({}, { text: "x".repeat(800000) });
  await until(() => { try { return readSync(fd, Buffer.alloc(1)) === 1; } catch (error) { if (error.code === "EAGAIN") return false; throw error; } });
  runner.child.kill("SIGTERM"); const result = await runner.done;
  assert.equal(result.signal, null); assert.equal(result.code, 1); await until(async () => (await peer.client.listSessions()).length === 1);
});

test("an interrupted CLI cannot hang on an already-full output pipe, with or without a second signal", async (t) => {
  const f = await setup(t), peer = await actor(f), fifo = join(f.root, "full-output.fifo");
  execFileSync("mkfifo", [fifo]); const fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK); f.cleanup(() => closeSync(fd));
  // Fill all remaining capacity, including any space below PIPE_BUF. Nothing will read this pipe.
  for (const size of [4096, 1]) {
    const buffer = Buffer.alloc(size);
    try { while (true) writeSync(fd, buffer); } catch (error) { if (error.code !== "EAGAIN") throw error; }
  }
  for (const again of [false, true]) {
    const count = peer.messages().length, runner = launch(f, ["ask", "--to", "peer", "--text", "q", "--json"], {}, fd);
    await until(() => peer.messages().length > count); runner.child.kill("SIGINT");
    await until(async () => (await peer.client.listSessions()).length === 1);
    if (again) runner.child.kill("SIGTERM");
    const result = await runner.done; assert.equal(result.signal, null); assert.equal(result.code, 1);
  }
});

test("CLI workgroups use their own environment, not parent Pi preferences or inherited stable identity", async (t) => {
  const f = await setup(t), parent = await piSession(f, { env: { PI_OPENSPACE_WORKGROUPS: "seed" } }); await parent.runtime.preferences.mutate(() => ["saved"]);
  const peer = await actor(f, "peer", ["saved", "seed"]), ownEnv = { PI_OPENSPACE_WORKGROUPS: "seed", PI_OPENSPACE_STABLE_ID: parent.runtime.client.info.id };
  const result = json(await launch(f, ["send", "--to", "peer", "--text", "env scope", "--json"], ownEnv).done); assert.equal(result.workgroup, "seed");
  assert.equal(json(await launch(f, ["send", "--to", "peer", "--text", "wrong", "--workgroup", "saved", "--json"], ownEnv).done, 1).error.code, "workgroup_not_shared");
  const multi = { PI_OPENSPACE_WORKGROUPS: "seed,saved" };
  assert.equal(json(await launch(f, ["send", "--to", "peer", "--text", "ambiguous", "--json"], multi).done, 1).error.code, "workgroup_ambiguous");
  assert.equal(json(await launch(f, ["send", "--to", "peer", "--text", "chosen", "--workgroup", "saved", "--json"], multi).done).workgroup, "saved");
  assert.equal(json(await launch(f, ["send", "--to", "peer", "--text", "default", "--json"]).done, 1).error.code, "target_not_found");
  assert.deepEqual(parent.runtime.client.info.workgroups, ["saved"]); assert.equal(parent.runtime.client.isConnected, true); assert.equal(peer.messages().length, 2);
});

test("human output keeps response text on stdout, diagnostics on stderr and terminal controls escaped", async (t) => {
  const f = await setup(t), peer = await actor(f);
  peer.messenger.subscribe((event) => { if (event.type === "message" && event.message.expectsReply) void peer.conversation.reply({}, { text: "answer\u001b[31m\nnext" }); });
  const answered = await launch(f, ["ask", "--to", "peer", "--text", "q"]).done; assert.equal(answered.code, 0);
  assert.equal(answered.stdout, "answer\\u001b[31m\nnext\n"); assert.match(answered.stderr, /risposta da peer/);
  const sent = await launch(f, ["send", "--to", "peer", "--text", "notice"]).done; assert.equal(sent.code, 0); assert.equal(sent.stdout, ""); assert.match(sent.stderr, /socket_delivered.*non completamento/);
  const failure = await launch(f, ["send", "--to", "missing", "--text", "notice"]).done; assert.equal(failure.code, 1); assert.equal(failure.stdout, ""); assert.match(failure.stderr, /target_not_found/);
});
