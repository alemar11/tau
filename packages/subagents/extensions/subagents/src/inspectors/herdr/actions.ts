import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { Details } from "../../shared/types.ts";
import type { InspectorContext, InspectorLaunch, InspectorParams, InspectorTarget } from "../types.ts";
import { bindingExists, readInspectorBinding, withInspectorBindingLock } from "../binding-store.ts";
import { formatShellCommand } from "../shell-command.ts";
import { detectHerdr, type HerdrClient } from "./client.ts";

export interface HerdrInspectorBinding {
	schemaVersion: 2;
	kind: "herdr-inspector";
	runId: string;
	asyncDir: string;
	childIndex?: number;
	missionId?: string;
	missionPath?: string;
	state: "opening" | "started";
	route: string;
	token: string;
	paneId?: string;
	terminalId?: string;
	openedAt: string;
	lastFocusedAt?: string;
	herdrVersion?: string;
	command: string;
	executable: string;
	argv: string[];
}

export function bindingPath(asyncDir: string, index?: number): string {
	return path.join(asyncDir, "inspectors", `herdr${index === undefined ? "" : `-${index}`}.json`);
}

function parse(value: unknown): HerdrInspectorBinding | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const binding = value as Partial<HerdrInspectorBinding>;
	if (binding.schemaVersion !== 2 || binding.kind !== "herdr-inspector"
		|| (binding.childIndex !== undefined && (!Number.isInteger(binding.childIndex) || binding.childIndex < 0))
		|| typeof binding.runId !== "string" || typeof binding.asyncDir !== "string"
		|| typeof binding.token !== "string" || !/^[a-f0-9-]{36}$/.test(binding.token)
		|| typeof binding.route !== "string" || typeof binding.openedAt !== "string"
		|| typeof binding.command !== "string" || typeof binding.executable !== "string" || !binding.executable
		|| !Array.isArray(binding.argv) || !binding.argv.every((arg) => typeof arg === "string")
		|| !["opening", "started"].includes(binding.state ?? "")
		|| (binding.paneId !== undefined && !validId(binding.paneId))
		|| (binding.terminalId !== undefined && !validId(binding.terminalId))) return undefined;
	return binding as HerdrInspectorBinding;
}

export function readHerdrInspectorBinding(asyncDir: string, index?: number): HerdrInspectorBinding | undefined {
	try { return parse(readInspectorBinding(bindingPath(asyncDir, index))); } catch { return undefined; }
}

/** A legacy, malformed or foreign binding never confers authority. */
export function readHerdrInspectorBindingForTarget(target: InspectorTarget): HerdrInspectorBinding | undefined {
	const binding = readHerdrInspectorBinding(target.asyncDir, target.index);
	if (!binding || binding.runId !== target.runId || binding.childIndex !== target.index) return undefined;
	try {
		if (fs.realpathSync(binding.asyncDir) !== fs.realpathSync(target.asyncDir)) return undefined;
	} catch { return undefined; }
	return binding;
}

function result(text: string, isError = false): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}), details: { mode: "management", results: [] } };
}

function route(env: NodeJS.ProcessEnv): string {
	const entries = Object.entries(env).filter(([key]) => ["HOME", "XDG_CONFIG_HOME"].includes(key)
		|| (key.startsWith("HERDR_") && !["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"].includes(key)));
	return createHash("sha256").update(JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}
function validId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(value);
}
function paneRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	return record.pane && typeof record.pane === "object" ? record.pane as Record<string, unknown> : record;
}
function samePane(data: unknown, binding: HerdrInspectorBinding): boolean {
	const pane = paneRecord(data);
	return Boolean(binding.paneId && binding.terminalId && pane?.pane_id === binding.paneId && pane.terminal_id === binding.terminalId);
}
function absent(error: { code: string }): boolean { return error.code === "NOT_FOUND" || error.code === "PANE_GONE"; }

export async function openHerdrInspector(context: InspectorContext, launch: InspectorLaunch, params: InspectorParams, client: HerdrClient): Promise<AgentToolResult<Details>> {
	const file = bindingPath(context.target.asyncDir, context.target.index);
	return withInspectorBindingLock(file, async (assertCurrent) => {
		if (context.signal?.aborted) return result("Inspector opening aborted before launch.", true);
		if (bindingExists(file)) {
			const existing = readHerdrInspectorBindingForTarget(context.target);
			if (!existing || existing.route !== route(context.env) || existing.state !== "started") {
				return result(`Inspector binding is invalid, foreign or incomplete. Reconcile ${file} manually; no pane was created or closed.`, true);
			}
			return statusHerdrInspector(context, client);
		}
		const source = context.env.HERDR_PANE_ID;
		if (context.env.HERDR_ENV !== "1" || !validId(source)) return result("Herdr inspector requires an explicit inherited HERDR_PANE_ID inside Herdr.", true);
		const detected = await detectHerdr(client, context.signal);
		if (!detected.ok) return result(`Herdr inspector error (${detected.error.code}): ${detected.error.message}`, true);
		const sourcePane = await client.run(["pane", "get", source], { timeoutMs: 5_000, signal: context.signal });
		const sourceIdentity = sourcePane.ok ? paneRecord(sourcePane.data) : undefined;
		if (sourceIdentity?.pane_id !== source || !validId(sourceIdentity.terminal_id)) return result("Cannot verify the source Herdr pane; no split was requested.", true);
		assertCurrent();
		const token = randomUUID();
		const argv = [...launch.argv, "--inspector-token", token];
		const binding: HerdrInspectorBinding = {
			schemaVersion: 2, kind: "herdr-inspector", state: "opening", route: route(context.env), token,
			runId: context.target.runId, asyncDir: context.target.asyncDir,
			...(context.target.index === undefined ? {} : { childIndex: context.target.index }),
			...(launch.mission ? { missionId: launch.mission.id, missionPath: launch.mission.path } : {}),
			openedAt: (context.now?.() ?? new Date()).toISOString(), herdrVersion: detected.data.versionText,
			command: formatShellCommand(launch.executable, argv), executable: launch.executable, argv,
		};
		const persist = () => {
			try { writeAtomicJson(file, binding); } catch (cause) {
				throw new Error(`Could not persist Herdr inspector identity: pane=${binding.paneId ?? "unassigned"}, terminal=${binding.terminalId ?? "unassigned"}. ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
			}
		};
		// Persist intent before any mutation: a timeout may still have created a pane.
		persist();
		const split = await client.run(["pane", "split", "--pane", source, "--direction", "right", "--cwd", context.target.status.cwd ?? context.cwd, params.focus === true ? "--focus" : "--no-focus"], { timeoutMs: 15_000, signal: context.signal });
		if (!split.ok) return result(`Herdr split failed: ${split.error.message}. Binding retained; reconcile possible effects before retrying.`, true);
		assertCurrent();
		const pane = paneRecord(split.data);
		if (!validId(pane?.pane_id) || !validId(pane?.terminal_id) || pane.pane_id === source || pane.terminal_id === sourceIdentity.terminal_id) return result("Herdr split returned no distinct verified pane/terminal identity. Reconcile manually; the opening binding is retained.", true);
		binding.paneId = pane.pane_id;
		binding.terminalId = pane.terminal_id;
		persist();
		const started = await client.run(["pane", "run", binding.paneId, binding.command], { timeoutMs: 15_000, signal: context.signal });
		if (!started.ok) return result(`Herdr inspector launch is uncertain: ${started.error.message}. Pane ${binding.paneId} and binding retained; no close or retry was attempted.`, true);
		assertCurrent();
		binding.state = "started";
		if (params.focus === true) binding.lastFocusedAt = binding.openedAt;
		persist();
		return result(`Opened Herdr inspector pane ${binding.paneId} for async run ${context.target.runId}. Closing the inspector does not stop the run. Status is observational, not writer-settlement evidence.`);
	});
}

export async function statusHerdrInspector(context: InspectorContext, client: HerdrClient): Promise<AgentToolResult<Details>> {
	const binding = readHerdrInspectorBindingForTarget(context.target);
	if (!binding || binding.route !== route(context.env) || !binding.paneId) return result("Herdr inspector binding is missing, invalid, incomplete or belongs to another endpoint. Reconcile manually.", true);
	const live = await client.run(["pane", "get", binding.paneId], { timeoutMs: 5_000, signal: context.signal });
	if (!live.ok) return result(`Herdr inspector status unavailable (${live.error.code}): ${live.error.message}. Binding retained; run state remains ${context.target.status.state}.`, true);
	if (!samePane(live.data, binding)) return result("Herdr pane identity changed; no authority over the replacement pane is implied.", true);
	return result(`Herdr inspector ${binding.paneId} is open for async run ${context.target.runId}. Launch: ${binding.state}.\nRun state: ${context.target.status.state}\nBinding: ${bindingPath(context.target.asyncDir, context.target.index)}`);
}

export async function closeHerdrInspector(context: InspectorContext, client: HerdrClient): Promise<AgentToolResult<Details>> {
	const file = bindingPath(context.target.asyncDir, context.target.index);
	return withInspectorBindingLock(file, async (assertCurrent) => {
		if (!bindingExists(file)) return result(`No Herdr inspector binding exists for async run ${context.target.runId}.`);
		const binding = readHerdrInspectorBindingForTarget(context.target);
		if (!binding || binding.route !== route(context.env) || !binding.paneId) return result("Herdr inspector ownership is unverified; binding and pane retained.", true);
		const live = await client.run(["pane", "get", binding.paneId], { timeoutMs: 5_000, signal: context.signal });
		assertCurrent();
		if (!live.ok && absent(live.error)) {
			fs.unlinkSync(file);
			return result("Verified absent Herdr inspector; removed its stale binding. The subagent run was not stopped.");
		}
		if (!live.ok || !samePane(live.data, binding)) return result("Herdr pane identity is uncertain or changed; refusing to close it.", true);
		const info = await client.run<{ pane_id?: string; foreground_processes?: Array<{ pid?: number; argv?: unknown }> }>(["pane", "process-info", "--pane", binding.paneId], { timeoutMs: 5_000, signal: context.signal });
		assertCurrent();
		const processes = info.ok && info.data.pane_id === binding.paneId ? info.data.foreground_processes : undefined;
		const candidate = Array.isArray(processes) && processes.length === 1 ? processes[0] : undefined;
		const argv = candidate?.argv;
		// Require the exact executable/argv and unpredictable token, not a title or idle badge.
		const ownsProcess = typeof candidate?.pid === "number" && Number.isSafeInteger(candidate.pid) && candidate.pid > 0
			&& Array.isArray(argv) && argv.length === binding.argv.length + 1 && argv[0] === binding.executable
			&& binding.argv.every((arg, offset) => argv[offset + 1] === arg)
			&& binding.argv.at(-2) === "--inspector-token" && binding.argv.at(-1) === binding.token;
		if (!ownsProcess) return result("Herdr foreground process ownership is unverified; refusing to close the pane. Close it manually after inspection.", true);
		const closed = await client.run(["pane", "close", binding.paneId], { timeoutMs: 10_000, signal: context.signal });
		if (!closed.ok) return result(`Herdr close is uncertain: ${closed.error.message}. Binding retained for reconciliation.`, true);
		assertCurrent();
		const remaining = await client.run(["pane", "get", binding.paneId], { timeoutMs: 5_000, signal: context.signal });
		assertCurrent();
		if (remaining.ok || !absent(remaining.error)) return result("Herdr did not verify pane removal; binding retained. No automatic retry.", true);
		fs.unlinkSync(file);
		return result(`Closed Herdr inspector pane ${binding.paneId}. The subagent run was not stopped.`);
	});
}
