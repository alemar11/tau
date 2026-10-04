import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { createSubagentExecutor } from "../../extensions/subagents/src/runs/foreground/subagent-executor.ts";
import type { AuthorityPolicyConfig, SubagentState } from "../../extensions/subagents/src/shared/types.ts";

function executor(policy?: AuthorityPolicyConfig, childSafe = false, jobs = new Map()) {
	const state: SubagentState = {
		baseCwd: os.tmpdir(), currentSessionId: "owner", asyncJobs: jobs, foregroundRuns: new Map(), foregroundControls: new Map(),
		lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(),
		watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
	return createSubagentExecutor({
		pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as any,
		state, config: { maxSubagentDepth: 2, control: {}, intercomBridge: {}, authorityPolicy: policy } as any,
		allowMutatingManagementActions: !childSafe, asyncByDefault: false, tempArtifactsDir: os.tmpdir(),
		getSubagentSessionRoot: () => os.tmpdir(), expandTilde: value => value, discoverAgents: () => ({ agents: [] }),
	});
}
const context = (confirm?: () => Promise<boolean>) => ({ cwd: os.tmpdir(), hasUI: Boolean(confirm), ui: { confirm }, sessionManager: { getSessionId: () => "owner", getSessionFile: () => null }, modelRegistry: { getAvailable: () => [] } }) as any;
const text = (result: { content: unknown[] }) => JSON.stringify(result.content);

it("inspector.open respects forbid, interactive confirmation and operator refusal", async () => {
	for (const [policy, confirm, expected] of [
		["forbid", undefined, /forbids action/],
		["confirm", undefined, /requires user confirmation/],
		["confirm", async () => false, /canceled; authority was not granted/],
		["auto", undefined, /require id or dir/],
	] as const) {
		const result = await executor({ inspectorOpen: policy }).execute("authority", { action: "inspector.open" }, AbortSignal.timeout(5000), undefined, context(confirm));
		assert.match(text(result), expected);
	}
});

it("child-safe mode cannot open a viewer even if interactive authority would be granted", async () => {
	let prompts = 0;
	const result = await executor({ inspectorOpen: "confirm" }, true).execute("child-open", { action: "inspector.open" }, AbortSignal.timeout(5000), undefined, context(async () => { prompts++; return true; }));
	assert.equal(result.isError, true); assert.match(text(result), /child-safe/); assert.equal(prompts, 0);
});

it("child-safe inspector.command cannot grant stop or steering through a standalone command", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tau-inspector-authority-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.writeFileSync(path.join(root, "status.json"), JSON.stringify({ runId: "run", sessionId: "owner", mode: "single", state: "running", steps: [{ agent: "worker", status: "running" }] }));
	const jobs = new Map([["run", { asyncId: "run", asyncDir: root, status: "running", mode: "single", agents: ["worker"] }]]);
	const result = await executor(undefined, true, jobs).execute("child-command", { action: "inspector.command", dir: root }, AbortSignal.timeout(5000), undefined, context());
	assert.notEqual(result.isError, true, text(result));
	assert.match(text(result), /--allow-steer.*false/); assert.match(text(result), /--allow-stop.*false/);
});
