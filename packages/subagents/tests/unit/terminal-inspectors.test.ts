import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it, type TestContext } from "node:test";
import { handleInspectorAction } from "../../extensions/subagents/src/inspectors/actions.ts";
import { bindingPath, closeHerdrInspector, openHerdrInspector, readHerdrInspectorBinding, statusHerdrInspector } from "../../extensions/subagents/src/inspectors/herdr/actions.ts";
import { createHerdrClient, type HerdrClient } from "../../extensions/subagents/src/inspectors/herdr/client.ts";
import { createGhosttyInspectorPlugin } from "../../extensions/subagents/src/inspectors/ghostty/plugin.ts";
import { ghosttyBindingPath, GHOSTTY_APPLESCRIPT, openGhosttyInspector, statusGhosttyInspector, type GhosttyRunner } from "../../extensions/subagents/src/inspectors/ghostty/actions.ts";
import { formatInspectorDashboard, submitInspectorControl } from "../../extensions/subagents/src/inspectors/inspector-runner.ts";
import { cleanupAsyncRetention } from "../../extensions/subagents/src/runs/background/async-retention.ts";
import { controlInboxDir } from "../../extensions/subagents/src/runs/background/control-channel.ts";
import type { InspectorContext, InspectorLaunch } from "../../extensions/subagents/src/inspectors/types.ts";
import type { AsyncStatus, SubagentState } from "../../extensions/subagents/src/shared/types.ts";

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tau-terminal-inspectors-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const dir = path.join(root, "run-1"); fs.mkdirSync(dir);
	const status: AsyncStatus = { runId: "run-1", sessionId: "owner", state: "running", mode: "single", startedAt: Date.now(), cwd: root, steps: [{ agent: "worker", status: "running", recentOutput: ["hello"] }] };
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
	const context: InspectorContext = { cwd: root, env: { HERDR_ENV: "1", HERDR_PANE_ID: "source" }, target: { runId: "run-1", asyncDir: dir, status } };
	const launch: InspectorLaunch = { executable: process.execPath, argv: ["/fixture/inspector-runner.mjs", "--async-dir", dir, "--run-id", "run-1"], displayCommand: "fixture command", allowSteer: false, allowStop: false, sessionRoots: [] };
	const calls: string[][] = [];
	let present = false;
	const faults = { split: false, run: false, get: false, close: false, replacement: false, foreignProcess: false, extraProcess: false, lookalikeProcess: false, beforeSplit: undefined as (() => Promise<void>) | undefined };
	const client: HerdrClient = { run: async <T>(args: string[]) => {
		calls.push(args);
		const ok = (data: unknown) => ({ ok: true as const, data: data as T });
		const uncertain = () => ({ ok: false as const, error: { code: "TIMEOUT" as const, message: "lost acknowledgement" } });
		if (args[0] === "--version") return ok("herdr 0.7.5");
		if (args[1] === "get" && args[2] === "source") return ok({ pane_id: "source", terminal_id: "source-terminal" });
		if (args[1] === "split") {
			assert.equal(readHerdrInspectorBinding(dir)?.state, "opening", "intent must precede remote effects");
			await faults.beforeSplit?.();
			present = true;
			return faults.split ? uncertain() : ok({ pane: { pane_id: "viewer", terminal_id: "viewer-terminal" } });
		}
		if (args[1] === "run") return faults.run ? uncertain() : ok({});
		if (args[1] === "get") {
			if (faults.get) return uncertain();
			return present ? ok({ pane_id: "viewer", terminal_id: faults.replacement ? "replacement" : "viewer-terminal" }) : { ok: false, error: { code: "NOT_FOUND", message: "gone" } };
		}
		if (args[1] === "process-info") {
			const argv = faults.foreignProcess ? ["node", "unrelated-job"] : [faults.lookalikeProcess ? "echo" : process.execPath, ...readHerdrInspectorBinding(dir)!.argv];
			return ok({ pane_id: "viewer", foreground_processes: [{ pid: 123, argv }, ...(faults.extraProcess ? [{ pid: 456, argv: ["unrelated"] }] : [])] });
		}
		if (args[1] === "close") { if (faults.close) return uncertain(); present = false; return ok({}); }
		assert.fail(`Unexpected Herdr command: ${args.join(" ")}`);
	} };
	return { root, dir, status, context, launch, calls, client, faults, file: bindingPath(dir) };
}
const text = (result: { content: unknown[] }) => JSON.stringify(result.content);

it("Herdr uses an explicit source, retains identities and only closes its verified viewer", async (t) => {
	const f = fixture(t);
	assert.notEqual((await openHerdrInspector(f.context, f.launch, {}, f.client)).isError, true);
	assert.deepEqual(f.calls.find((args) => args[1] === "split"), ["pane", "split", "--pane", "source", "--direction", "right", "--cwd", f.root, "--no-focus"]);
	const binding = readHerdrInspectorBinding(f.dir)!;
	assert.equal(binding.paneId, "viewer"); assert.equal(binding.terminalId, "viewer-terminal");
	assert.ok(binding.command.includes(binding.token));
	assert.notEqual((await openHerdrInspector(f.context, f.launch, {}, f.client)).isError, true);
	assert.equal(f.calls.filter((args) => args[1] === "split").length, 1);
	assert.notEqual((await closeHerdrInspector(f.context, f.client)).isError, true);
	assert.equal(fs.existsSync(f.file), false);
	assert.equal(fs.existsSync(controlInboxDir(f.dir)), false, "viewer closure must not stop or steer the run");
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, "status.json"), "utf8")), f.status);
});

for (const stage of ["split", "run"] as const) it(`Herdr retains uncertain ${stage} effects and never retries or rolls back`, async (t) => {
	const f = fixture(t); f.faults[stage] = true;
	assert.equal((await openHerdrInspector(f.context, f.launch, {}, f.client)).isError, true);
	assert.equal(readHerdrInspectorBinding(f.dir)?.state, "opening");
	const count = f.calls.length;
	assert.equal((await openHerdrInspector(f.context, f.launch, {}, f.client)).isError, true);
	assert.equal(f.calls.length, count);
	assert.equal(f.calls.some((args) => args[1] === "close"), false);
});

for (const fault of ["get", "replacement", "foreignProcess", "extraProcess", "lookalikeProcess"] as const) it(`Herdr refuses close with ${fault}`, async (t) => {
	const f = fixture(t);
	await openHerdrInspector(f.context, f.launch, {}, f.client);
	f.faults[fault] = true;
	assert.equal((await closeHerdrInspector(f.context, f.client)).isError, true);
	assert.ok(fs.existsSync(f.file));
	assert.equal(f.calls.some((args) => args[1] === "close"), false);
});

for (const duplicate of ["pane_id", "terminal_id"] as const) it(`Herdr never runs a viewer in its caller when split reuses ${duplicate}`, async (t) => {
	const f = fixture(t);
	const client: HerdrClient = { run: async <T>(args: string[], options?: Parameters<HerdrClient["run"]>[1]) => {
		if (args[1] === "split") return { ok: true, data: { pane: { pane_id: duplicate === "pane_id" ? "source" : "viewer", terminal_id: duplicate === "terminal_id" ? "source-terminal" : "viewer-terminal" } } as T };
		return f.client.run<T>(args, options);
	} };
	assert.equal((await openHerdrInspector(f.context, f.launch, {}, client)).isError, true);
	assert.equal(f.calls.some((args) => args[1] === "run"), false);
	assert.equal(readHerdrInspectorBinding(f.dir)?.state, "opening");
});

it("Herdr retains a lost close acknowledgement, but a later explicit close reconciles it", async (t) => {
	const f = fixture(t); await openHerdrInspector(f.context, f.launch, {}, f.client);
	f.faults.close = true;
	assert.equal((await closeHerdrInspector(f.context, f.client)).isError, true);
	assert.ok(fs.existsSync(f.file));
	f.faults.close = false;
	assert.notEqual((await closeHerdrInspector(f.context, f.client)).isError, true);
});

it("Herdr rejects changed endpoints and legacy, foreign, symlink or oversized bindings", async (t) => {
	const f = fixture(t); await openHerdrInspector(f.context, f.launch, {}, f.client);
	const original = fs.readFileSync(f.file, "utf8");
	const calls = f.calls.length;
	assert.equal((await closeHerdrInspector({ ...f.context, env: { ...f.context.env, HERDR_SESSION: "other" } }, f.client)).isError, true);
	for (const value of [{ ...JSON.parse(original), schemaVersion: 1 }, { ...JSON.parse(original), runId: "other" }, "x".repeat(65 * 1024)]) {
		fs.writeFileSync(f.file, JSON.stringify(value));
		assert.equal((await openHerdrInspector(f.context, f.launch, {}, f.client)).isError, true);
		assert.equal((await closeHerdrInspector(f.context, f.client)).isError, true);
	}
	fs.unlinkSync(f.file); fs.writeFileSync(path.join(f.root, "outside"), original); fs.symlinkSync(path.join(f.root, "outside"), f.file);
	assert.equal((await closeHerdrInspector(f.context, f.client)).isError, true);
	assert.equal(f.calls.length, calls);
});

it("concurrent opens serialize without allocating a second pane", async (t) => {
	const f = fixture(t); let release!: () => void, entered!: () => void;
	const ready = new Promise<void>((r) => { entered = r; });
	const barrier = new Promise<void>((r) => { release = r; });
	f.faults.beforeSplit = async () => { entered(); await barrier; };
	const opening = openHerdrInspector(f.context, f.launch, {}, f.client);
	await ready;
	assert.equal((await openHerdrInspector(f.context, f.launch, {}, f.client)).isError, true);
	release(); assert.notEqual((await opening).isError, true);
	assert.equal(f.calls.filter((args) => args[1] === "split").length, 1);
});

it("a replaced operation lock is never released and prevents subsequent launch effects", async (t) => {
	const f = fixture(t);
	f.faults.beforeSplit = async () => {
		fs.renameSync(`${f.file}.lock`, `${f.file}.original-lock`);
		fs.mkdirSync(`${f.file}.lock`);
		fs.writeFileSync(path.join(`${f.file}.lock`, "owner.json"), JSON.stringify({ token: "foreign" }));
	};
	assert.equal((await openHerdrInspector(f.context, f.launch, {}, f.client)).isError, true);
	assert.equal(JSON.parse(fs.readFileSync(path.join(`${f.file}.lock`, "owner.json"), "utf8")).token, "foreign");
	assert.equal(f.calls.some((args) => args[1] === "run"), false);
	assert.equal(readHerdrInspectorBinding(f.dir)?.state, "opening");
});

for (const evidence of ["binding", "operation-lock", "symlink", "empty"] as const) it(`artifact retention respects inspector ${evidence}`, async (t) => {
	const f = fixture(t);
	const dir = path.join(f.dir, "inspectors");
	if (evidence === "symlink") fs.symlinkSync(f.root, dir, process.platform === "win32" ? "junction" : "dir");
	else {
		fs.mkdirSync(dir);
		if (evidence === "binding") fs.writeFileSync(path.join(dir, "ghostty.json"), "malformed evidence is still retained");
		if (evidence === "operation-lock") fs.mkdirSync(path.join(dir, "herdr.json.lock"));
	}
	fs.writeFileSync(path.join(f.dir, "status.json"), JSON.stringify({ ...f.status, state: "complete" }));
	const retention = await cleanupAsyncRetention({ asyncDirRoot: f.root, resultsDir: path.join(f.root, "results"), maintenanceRoot: path.join(f.root, "maintenance"), processStartIdentity: "fixture", now: () => Date.now() + 60 * 24 * 60 * 60 * 1000 });
	assert.equal(retention.workerFailed, false, JSON.stringify(retention));
	assert.deepEqual(retention.errors, []);
	assert.equal(fs.existsSync(f.dir), evidence !== "empty");
	if (evidence !== "empty") assert.equal(retention.skipped["inspector-reference"], 1);
});

it("aborted commands and missing caller identity cause no terminal operations", async (t) => {
	const f = fixture(t);
	f.context.signal = AbortSignal.abort();
	assert.equal((await openHerdrInspector(f.context, f.launch, {}, f.client)).isError, true);
	assert.deepEqual(f.calls, []);
	f.context.signal = undefined; f.context.env = {};
	assert.equal((await openHerdrInspector(f.context, f.launch, {}, f.client)).isError, true);
	assert.deepEqual(f.calls, []);
	assert.equal(fs.existsSync(f.file), false);
});

it("Herdr client bounds output, propagates errors and does not spawn after abort", async () => {
	const client = createHerdrClient({ bin: process.execPath });
	assert.deepEqual(await client.run(["-e", 'console.log(JSON.stringify({result:{pane_id:"fixture"}}))']), { ok: true, data: { pane_id: "fixture" } });
	const overflow = await client.run(["-e", 'process.stdout.write("x".repeat(800000));setInterval(()=>{},1000)']);
	assert.equal(overflow.ok, false); if (!overflow.ok) assert.match(overflow.error.message, /512 KiB/);
	const notStarted = createHerdrClient({ spawn: () => { assert.fail("aborted process spawned"); } });
	assert.equal((await notStarted.run(["pane", "split"], { signal: AbortSignal.abort() })).ok, false);
	const failed = await client.run(["-e", 'console.error(JSON.stringify({error:{code:"not_found",message:"missing"}}));process.exit(1)']);
	assert.equal(failed.ok, false); if (!failed.ok) assert.equal(failed.error.code, "NOT_FOUND");
});

it("Ghostty host detection excludes embedded hosts and other platforms", () => {
	const context = { env: { TERM_PROGRAM: "ghostty", __CFBundleIdentifier: "com.mitchellh.ghostty" } } as InspectorContext;
	assert.equal(createGhosttyInspectorPlugin({ platform: "darwin" }).available(context), true);
	assert.equal(createGhosttyInspectorPlugin({ platform: "linux" }).available(context), false);
	assert.equal(createGhosttyInspectorPlugin({ platform: "darwin" }).available({ ...context, env: { ...context.env, __CFBundleIdentifier: "com.cmuxterm.app" } }), false);
});

it("Ghostty splits only a selected terminal with argv-safe values and retains the returned identity", async (t) => {
	const f = fixture(t);
	const captured: string[][] = [];
	const runner: GhosttyRunner = async (args) => { captured.push([...args]); return { stdout: args[1] === GHOSTTY_APPLESCRIPT ? "new-terminal\n" : "true\n", stderr: "" }; };
	assert.equal((await openGhosttyInspector(f.context, f.launch, {}, runner)).isError, true);
	assert.deepEqual(captured, []);
	f.context.env.TAU_SUBAGENTS_GHOSTTY_TERMINAL_ID = "selected-terminal";
	f.launch.displayCommand = `node '/has quotes' '$not-code'`;
	assert.notEqual((await openGhosttyInspector(f.context, f.launch, {}, runner)).isError, true);
	assert.equal(captured[0]?.at(-1), "selected-terminal");
	assert.equal(captured[0]?.[3], f.launch.displayCommand);
	assert.ok(!GHOSTTY_APPLESCRIPT.includes(f.launch.displayCommand));
	assert.match(GHOSTTY_APPLESCRIPT, /sourceTerminal to terminal id sourceId/);
	assert.match(text(await statusGhosttyInspector(f.context, runner)), /new-terminal: present/);
	assert.notEqual((await openGhosttyInspector(f.context, f.launch, {}, runner)).isError, true);
	assert.equal(captured.filter((args) => args[1] === GHOSTTY_APPLESCRIPT).length, 1);
	assert.ok(fs.existsSync(ghosttyBindingPath(f.context)));
});

it("Ghostty rejects a returned source terminal identity without claiming success", async (t) => {
	const f = fixture(t); f.context.env.TAU_SUBAGENTS_GHOSTTY_TERMINAL_ID = "source-terminal";
	const outcome = await openGhosttyInspector(f.context, f.launch, {}, async () => ({ stdout: "source-terminal", stderr: "" }));
	assert.equal(outcome.isError, true);
	assert.equal(JSON.parse(fs.readFileSync(ghosttyBindingPath(f.context), "utf8")).state, "opening");
});

it("Ghostty retains ambiguous effects without a second AppleScript invocation", async (t) => {
	const f = fixture(t); f.context.env.TAU_SUBAGENTS_GHOSTTY_TERMINAL_ID = "selected-terminal";
	let calls = 0;
	const runner: GhosttyRunner = async () => { calls++; throw new Error("timeout after split"); };
	assert.equal((await openGhosttyInspector(f.context, f.launch, {}, runner)).isError, true);
	assert.equal((await openGhosttyInspector(f.context, f.launch, {}, runner)).isError, true);
	assert.equal(calls, 1);
	assert.equal(JSON.parse(fs.readFileSync(ghosttyBindingPath(f.context), "utf8")).state, "opening");
});

it("inspector controls need explicit permission and matching ownership at submission", async (t) => {
	const f = fixture(t);
	const options = { asyncDir: f.dir, runId: "run-1", refreshMs: 1500, sessionRoots: [], ownerSessionId: "owner" };
	assert.throws(() => submitInspectorControl(options, "stop"), /Authority policy/);
	assert.throws(() => submitInspectorControl({ ...options, allowSteer: true, ownerSessionId: "foreign" }, "steer act"), /ownership/);
	assert.equal(fs.existsSync(controlInboxDir(f.dir)), false);
	assert.match(submitInspectorControl({ ...options, allowSteer: true }, "steer consider this"), /queued/);
	assert.match(submitInspectorControl({ ...options, allowStop: true }, "stop"), /Stop requested/);
	fs.writeFileSync(path.join(f.dir, "status.json"), JSON.stringify({ ...f.status, sessionId: "changed" }));
	assert.throws(() => submitInspectorControl({ ...options, allowStop: true }, "stop"), /ownership/);
});

it("external runners cannot be steered through inspector controls and child stop keeps its target", (t) => {
	const f = fixture(t);
	fs.writeFileSync(path.join(f.dir, "status.json"), JSON.stringify({ ...f.status, steps: [{ ...f.status.steps![0], runner: { type: "external-cli" } }] }));
	const options = { asyncDir: f.dir, runId: "run-1", refreshMs: 1500, sessionRoots: [], ownerSessionId: "owner", index: 0, allowSteer: true, allowStop: true };
	assert.throws(() => submitInspectorControl(options, "steer act"), /do not support/);
	assert.equal(fs.existsSync(controlInboxDir(f.dir)), false);
	assert.match(submitInspectorControl(options, "stop"), /child 0/);
	const files = fs.readdirSync(controlInboxDir(f.dir), { recursive: true }).filter((file) => file.endsWith(".json"));
	assert.ok(files.some((file) => {
		const request = JSON.parse(fs.readFileSync(path.join(controlInboxDir(f.dir), file), "utf8"));
		return request.type === "stop" && request.targetIndex === 0;
	}));
});

it("command generation stays headless, validates targets and grants controls only for the current owner", async (t) => {
	const f = fixture(t);
	const state = { currentSessionId: "owner", asyncJobs: new Map() } as SubagentState;
	const deps = { cwd: f.root, asyncDirRoot: f.root, state, plugins: [] };
	let result = await handleInspectorAction("inspector.command", { dir: f.dir }, deps);
	assert.match(text(result), /--owner-session-id.*owner/);
	assert.match(text(result), /--allow-stop.*true/);
	state.currentSessionId = "foreign";
	result = await handleInspectorAction("inspector.command", { dir: f.dir }, deps);
	assert.doesNotMatch(text(result), /--owner-session-id/);
	assert.match(text(result), /--allow-stop.*false/);
	assert.equal((await handleInspectorAction("inspector.command", { dir: f.dir, index: NaN }, deps)).isError, true);
	assert.equal((await handleInspectorAction("inspector.command", { dir: f.root }, { ...deps, asyncDirRoot: f.dir })).isError, true);
});

it("dashboard strips terminal controls and the packaged standalone viewer defaults to observation", (t) => {
	const f = fixture(t);
	f.status.steps[0]!.recentOutput = ["hello\x1b]52;c;clipboard\x07\x1b[31mworld"];
	f.status.runId += "\x1b]52;c;clipboard\x07";
	const dashboard = formatInspectorDashboard({ status: f.status, asyncDir: f.dir });
	assert.match(dashboard, /^tau-subagents inspector for run-1\n/);
	assert.match(dashboard, /hello.*world/);
	assert.doesNotMatch(dashboard, /\x1b|\x07/);
	const runner = fileURLToPath(new URL("../../extensions/subagents/inspector-runner.mjs", import.meta.url));
	const output = execFileSync(process.execPath, [runner, "--async-dir", f.dir, "--run-id", "run-1"], { encoding: "utf8", input: "stop\n", timeout: 30_000, maxBuffer: 1024 * 1024 });
	assert.match(output, /matching parent session ownership/);
	assert.equal(fs.existsSync(controlInboxDir(f.dir)), false);
});
