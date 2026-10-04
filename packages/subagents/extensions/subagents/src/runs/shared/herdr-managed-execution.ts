import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentConfig } from "../../agents/agents.ts";
import { DEFAULT_ARTIFACT_CONFIG, DIRS, TEMP_ROOT_DIR, HERDR_MANAGED_REFERENCE, SUBAGENT_PROCESS_TERMINAL_EVENT, type ProcessTerminal } from "../../shared/types.ts";
import { getAgentDir } from "../../shared/utils.ts";
import { assertNativeAgent } from "../../shared/phase-one.ts";
import { executeAsyncSingle } from "../background/async-execution.ts";
import { deliverStopRequest } from "../background/control-channel.ts";
import { sanitizeProcessTerminal, processTerminalPath } from "../background/process-terminal.ts";
import { assertHerdrPrivateDirectory, syncHerdrDirectory } from "./herdr-placement-journal.ts";
import { validateHerdrPiRunId } from "./herdr-pi-protocol.ts";

const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const SETTLEMENT_GRACE_MS = 10_000;

/** Logical selections interpreted on the execution host, never caller-supplied argv or env. */
export interface HerdrManagedRequest {
	version: 1;
	runId: string;
	rootSessionId: string;
	cwd: string;
	agent: string;
	task: string;
	deadlineAt: number;
	projectTrusted: boolean;
	model?: string;
	skills?: readonly string[];
	reads?: readonly string[] | false;
	output?: string | false;
}
export interface HerdrManagedResult {
	version: 1;
	runId: string;
	rootSessionId: string;
	runnerProcessInstanceId?: string;
	settlement: "observed" | "unknown" | "not-started";
	success: boolean;
	asyncDir: string;
	resultPath: string;
	result?: Record<string, unknown>;
	processTerminal?: ProcessTerminal;
	error?: string;
}
interface DirectoryIdentity { directory: string; dev: number; ino: number; private: boolean }
function directoryIdentity(directory: string, privateDirectory = false): DirectoryIdentity {
	const stat = privateDirectory ? assertHerdrPrivateDirectory(directory) : fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Managed execution directory is unsafe: ${directory}`);
	return { directory, dev: stat.dev, ino: stat.ino, private: privateDirectory };
}
function assertDirectory(identity: DirectoryIdentity): void {
	const current = directoryIdentity(identity.directory, identity.private);
	if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error(`Managed execution directory ownership changed: ${identity.directory}`);
}
function persistExclusive(file: string, value: unknown): void {
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
	if (bytes.length > MAX_RESULT_BYTES) throw new Error("Managed execution record exceeded its byte bound.");
	const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
	try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	syncHerdrDirectory(path.dirname(file));
}
function readBoundedRecord(file: string, maximum = MAX_RESULT_BYTES): Record<string, unknown> | undefined {
	let fd: number;
	try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	try {
		const stat = fs.fstatSync(fd), named = fs.lstatSync(file);
		if (!stat.isFile() || named.isSymbolicLink() || stat.dev !== named.dev || stat.ino !== named.ino || stat.size > maximum) throw new Error(`Managed execution evidence is not a bounded regular file: ${file}`);
		const bytes = Buffer.alloc(Math.min(maximum + 1, stat.size + 1));
		let length = 0;
		while (length < bytes.length) { const read = fs.readSync(fd, bytes, length, bytes.length - length, null); if (!read) break; length += read; }
		if (length > maximum || length !== stat.size) throw new Error(`Managed execution evidence changed size or exceeded its byte bound: ${file}`);
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Managed execution evidence is malformed: ${file}`);
		return value as Record<string, unknown>;
	} finally { fs.closeSync(fd); }
}
function requestSnapshot(value: HerdrManagedRequest): Readonly<HerdrManagedRequest> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Managed execution request must be an object.");
	const keys = new Set(["version", "runId", "rootSessionId", "cwd", "agent", "task", "deadlineAt", "projectTrusted", "model", "skills", "reads", "output"]);
	if (Object.keys(value).some((key) => !keys.has(key)) || value.version !== 1) throw new Error("Unsupported managed execution request fields/version.");
	validateHerdrPiRunId(value.runId);
	if (typeof value.rootSessionId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value.rootSessionId)) throw new Error("Invalid managed root session identity.");
	if (typeof value.cwd !== "string" || !path.isAbsolute(value.cwd) || value.cwd.includes("\0")) throw new Error("Managed execution requires an absolute cwd.");
	if (typeof value.agent !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.agent)) throw new Error("Invalid managed agent selection.");
	if (typeof value.task !== "string" || !value.task.trim() || Buffer.byteLength(value.task) > 256 * 1024) throw new Error("Managed task is missing or oversized.");
	const now = Date.now();
	if (!Number.isSafeInteger(value.deadlineAt) || value.deadlineAt <= now || value.deadlineAt - now > 2_147_483_647) throw new Error("Managed execution deadline expired or invalid; no child was launched.");
	if (typeof value.projectTrusted !== "boolean") throw new Error("Managed execution requires an explicit project trust decision.");
	for (const [name, maximum] of [["model", 512], ["output", 4096]] as const) {
		const item = value[name];
		if (item !== undefined && !(name === "output" && item === false) && (typeof item !== "string" || !item.trim() || item.includes("\0") || Buffer.byteLength(item) > maximum)) throw new Error(`Invalid managed ${name}.`);
	}
	for (const name of ["skills", "reads"] as const) {
		const items = value[name];
		if (items === undefined || name === "reads" && items === false) continue;
		if (!Array.isArray(items) || items.length > 64 || items.some((item) => typeof item !== "string" || !item.trim() || item.includes("\0") || Buffer.byteLength(item) > 4096 || name === "skills" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(item))) throw new Error(`Invalid managed ${name}.`);
	}
	const snapshot = { ...value, ...(value.skills ? { skills: Object.freeze([...value.skills]) } : {}), ...(Array.isArray(value.reads) ? { reads: Object.freeze([...value.reads]) } : {}) };
	if (Buffer.byteLength(JSON.stringify(snapshot)) > 512 * 1024) throw new Error("Managed request exceeded its serialized byte bound.");
	return Object.freeze(snapshot);
}

/**
 * One-shot execution-host owner. Reuses the normal background SDK/CLI engines,
 * their FIFO and terminal proof; it neither launches persistent interactive CLIs
 * nor treats a result publication, transport loss or pane status as settlement.
 * The public machine/placement gates remain closed until transport wiring lands.
 */
export class HerdrManagedExecution {
	readonly request: Readonly<HerdrManagedRequest>;
	readonly directory: string;
	readonly asyncDir: string;
	readonly resultPath: string;
	readonly #agent: AgentConfig;
	readonly #agentDir: string;
	readonly #token = randomUUID();
	readonly #directories: DirectoryIdentity[];
	#runnerProcessInstanceId?: string;
	#execution?: Promise<HerdrManagedResult>;
	#stopRequested = false;
	#stopWritten = false;
	#stopFailure?: Error;
	#observed = false;
	#finishing = false;

	constructor(runtimeDir: string, input: HerdrManagedRequest) {
		this.request = requestSnapshot(input);
		if (!path.isAbsolute(runtimeDir)) throw new Error("Managed runtime directory must be absolute.");
		this.#agentDir = path.resolve(getAgentDir());
		const discovery = discoverAgents(input.cwd, input.projectTrusted ? "both" : "user", undefined, { globalNpmRoot: null });
		const matches = discovery.agents.filter((agent) => agent.name === input.agent || agent.aliases?.includes(input.agent));
		if (matches.length !== 1) throw new Error(`Managed agent '${input.agent}' was not resolved unambiguously on the execution host.`);
		this.#agent = structuredClone(matches[0]!);
		assertNativeAgent(this.#agent, true);
		if (!this.#agent.runner && !(input.model ?? this.#agent.model)) throw new Error("Managed native execution requires an explicit requested or profile model; no fallback is selected.");
		this.directory = path.join(runtimeDir, "managed-execution");
		this.asyncDir = path.join(DIRS.async, input.runId);
		this.resultPath = path.join(this.directory, "result.json");
		this.#directories = [directoryIdentity(runtimeDir, true), directoryIdentity(fs.realpathSync(input.cwd))];
		const relativeRuntime = path.relative(this.#directories[1]!.directory, fs.realpathSync(runtimeDir));
		if (!relativeRuntime || (!relativeRuntime.startsWith(`..${path.sep}`) && relativeRuntime !== ".." && !path.isAbsolute(relativeRuntime))) throw new Error("Managed runtime evidence must be outside the execution workspace.");
		// The exclusive directories reserve both the placement slot and engine run ID.
		// Partial creation is deliberately retained and cannot authorize a retry.
		fs.mkdirSync(this.directory, { mode: 0o700 });
		this.#directories.push(directoryIdentity(this.directory, true));
		syncHerdrDirectory(runtimeDir);
		fs.mkdirSync(DIRS.async, { recursive: true, mode: 0o700 });
		this.#directories.push(directoryIdentity(TEMP_ROOT_DIR), directoryIdentity(DIRS.async));
		fs.mkdirSync(this.asyncDir, { mode: 0o700 });
		this.#directories.push(directoryIdentity(this.asyncDir, true));
		syncHerdrDirectory(DIRS.async);
		const ownership = { version: 1, token: this.#token, request: this.request, runtimeDir, asyncDir: this.asyncDir, storageRoot: TEMP_ROOT_DIR, agentDir: this.#agentDir, canonicalCwd: fs.realpathSync(input.cwd) };
		persistExclusive(path.join(this.directory, "request.json"), ownership);
		persistExclusive(path.join(this.asyncDir, HERDR_MANAGED_REFERENCE), { version: 1, runId: input.runId, token: this.#token, directory: this.directory });
	}

	#assertCurrent(): void {
		for (const identity of this.#directories) assertDirectory(identity);
		if (path.resolve(getAgentDir()) !== this.#agentDir || fs.realpathSync(this.request.cwd) !== this.#directories[1]!.directory) throw new Error("Managed execution resource namespace or cwd changed.");
		const owner = readBoundedRecord(path.join(this.directory, "request.json"), 1024 * 1024);
		const reference = readBoundedRecord(path.join(this.asyncDir, HERDR_MANAGED_REFERENCE), 4096);
		if (owner?.token !== this.#token || reference?.token !== this.#token || reference.directory !== this.directory || reference.runId !== this.request.runId) throw new Error("Managed execution ownership evidence changed.");
	}
	/** Stop is only a request to the owned engine. It never releases admission. */
	stop(): void {
		this.#assertCurrent();
		if (this.#observed) return;
		if (this.#stopFailure) throw this.#stopFailure;
		if (this.#stopWritten) return;
		this.#stopRequested = true;
		if (!this.#runnerProcessInstanceId) return;
		// A failed/ambiguous write is retained, not retried as a new operation.
		this.#stopWritten = true;
		try {
			persistExclusive(path.join(this.directory, "stop-intent.json"), { version: 1, runId: this.request.runId, runnerProcessInstanceId: this.#runnerProcessInstanceId, at: Date.now() });
			deliverStopRequest({ asyncDir: this.asyncDir, source: "herdr-managed-owner" });
		} catch (error) {
			this.#stopFailure = error instanceof Error ? error : new Error(String(error));
			throw this.#stopFailure;
		}
	}
	/** Repeated calls observe one promise; they cannot dispatch a second execution. */
	run(): Promise<HerdrManagedResult> { return this.#execution ??= this.#run(); }
	async #run(): Promise<HerdrManagedResult> {
		const events = createEventBus();
		let closeObservation: ProcessTerminal | undefined;
		// This private bus is emitted by the launcher's actual process-close callback.
		// A plausible sidecar written before close is not an observation of cessation.
		const unsubscribe = events.on(SUBAGENT_PROCESS_TERMINAL_EVENT, (value) => {
			if (this.#runnerProcessInstanceId) closeObservation = sanitizeProcessTerminal(value, { runId: this.request.runId, runnerProcessInstanceId: this.#runnerProcessInstanceId }, this.asyncDir);
		});
		try {
			this.#assertCurrent();
			if (this.#stopRequested || Date.now() >= this.request.deadlineAt) return this.#finish("not-started", undefined, undefined, "Managed execution cancelled or expired before dispatch; no child was launched.");
			const request = this.request;
			const dispatched = await executeAsyncSingle(request.runId, {
				agent: this.#agent.name, agentConfig: this.#agent, task: request.task,
				ctx: { pi: { events }, cwd: request.cwd, currentSessionId: request.rootSessionId, parentSessionId: request.rootSessionId, completionOwnerId: this.#token, projectTrusted: request.projectTrusted },
				cwd: request.cwd, requestedCwd: request.cwd, context: "fresh", acceptance: false,
				modelOverride: request.model, skills: request.skills ? [...request.skills] : undefined,
				reads: request.reads === false ? false : request.reads ? [...request.reads] : undefined,
				// Cross-host nested lineage/supervision is not wired; do not create a fresh fanout budget.
				output: request.output, shareEnabled: false, maxSubagentDepth: 1,
				artifactConfig: { ...DEFAULT_ARTIFACT_CONFIG, enabled: true }, artifactsDir: path.join(this.directory, "artifacts"), sessionDir: path.join(this.directory, "sessions"),
				retainedResultPath: this.resultPath, absoluteDeadlineAt: request.deadlineAt,
				onRunnerStarted: (runnerProcessInstanceId) => {
					this.#assertCurrent();
					persistExclusive(path.join(this.directory, "runner.json"), { version: 1, runId: request.runId, runnerProcessInstanceId, at: Date.now() });
					this.#runnerProcessInstanceId = runnerProcessInstanceId;
					if (this.#stopRequested) this.stop();
				},
			});
			this.#assertCurrent();
			if (dispatched.isError || dispatched.details.asyncId !== request.runId || dispatched.details.asyncDir !== this.asyncDir || !this.#runnerProcessInstanceId) throw new Error(`Managed engine dispatch failed: ${dispatched.content.map((part) => part.text).join(" ")}`);
			for (;;) {
				this.#assertCurrent();
				// Use the same proof validator as the ordinary host, without a second file read.
				const raw = readBoundedRecord(processTerminalPath(this.asyncDir), 1024 * 1024);
				const proof = sanitizeProcessTerminal(raw, { runId: request.runId, runnerProcessInstanceId: this.#runnerProcessInstanceId }, this.asyncDir);
				if (proof?.state === "unknown" || closeObservation?.state === "unknown") return this.#finish("unknown", undefined, closeObservation ?? proof, "Managed writer settlement is unknown; all evidence and ownership remain retained.");
				if (proof?.state === "observed" && closeObservation?.state === "observed") {
					const result = readBoundedRecord(this.resultPath);
					if (!result || result.id !== request.runId || result.sessionId !== request.rootSessionId || result.completionOwnerId !== this.#token || result.asyncDir !== this.asyncDir || !Array.isArray(result.results) || !["complete", "failed", "stopped", "rejected"].includes(String(result.state)) || result.success !== (result.state === "complete")) throw new Error("Managed result is missing or has mismatched execution ownership.");
					this.#observed = true;
					return this.#finish("observed", result, closeObservation);
				}
				if (Date.now() >= request.deadlineAt + SETTLEMENT_GRACE_MS) return this.#finish("unknown", undefined, proof, "Managed settlement deadline expired; no process or writer cessation was inferred.");
				await delay(50);
			}
		} catch (error) {
			if (this.#finishing) throw error;
			return this.#finish("unknown", undefined, undefined, error instanceof Error ? error.message : String(error));
		} finally { unsubscribe(); }
	}
	#finish(settlement: HerdrManagedResult["settlement"], result?: Record<string, unknown>, processTerminal?: ProcessTerminal, error?: string): HerdrManagedResult {
		this.#finishing = true;
		const record: HerdrManagedResult = { version: 1, runId: this.request.runId, rootSessionId: this.request.rootSessionId,
			runnerProcessInstanceId: this.#runnerProcessInstanceId, settlement, success: settlement === "observed" && result?.success === true,
			asyncDir: this.asyncDir, resultPath: this.resultPath, ...(result ? { result } : {}), ...(processTerminal ? { processTerminal } : {}), ...(error ? { error: error.slice(0, 4096) } : {}) };
		try { this.#assertCurrent(); persistExclusive(path.join(this.directory, "outcome.json"), record); }
		catch (failure) { throw new Error(`Managed outcome persistence/ownership is uncertain; retain ${this.directory}: ${failure instanceof Error ? failure.message : String(failure)}`, { cause: failure }); }
		return record;
	}
}
