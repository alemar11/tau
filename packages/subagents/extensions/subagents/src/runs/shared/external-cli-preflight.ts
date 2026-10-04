import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createOwnedProcessTreeController } from "../background/owned-process-tree.ts";
import type { ExternalProcessStatus } from "../../shared/types.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveNodeExecutable } from "../../shared/node-executable.ts";

const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;
const MAX_PROBE_TIMEOUT_MS = 5_000;
const MAX_REMOTE_PROBE_TIMEOUT_MS = 15_000;
const MAX_CACHE_ENTRIES = 64;
const MAX_AVAILABILITY_REASON_LENGTH = 256;

export type ExternalCliPreflightInvalidationReason = "launch" | "auth" | "parser" | "permission";

export interface ExternalCliPreflightSpec {
	id: string;
	versionArgs: readonly string[];
	helpArgs: readonly string[];
	evidenceArgs?: readonly string[];
	evidenceLabel?: string;
	probeTimeoutMs?: number;
	/** Remote probes include SSH handshakes; values may only narrow the code-owned remote ceiling. */
	remote?: boolean;
	validate?: (result: ExternalCliPreflightResult) => void;
}

export interface ExternalCliPreflightResult {
	binaryPath: string;
	binaryMtimeMs: number;
	version: string;
	help: string;
	evidence?: string;
	cacheHit: boolean;
}

type CachedPreflight = Omit<ExternalCliPreflightResult, "cacheHit">;

const cache = new Map<string, CachedPreflight>();
const lookup = new Map<string, string>();

export type ExternalCliBinaryAvailability =
	| { available: true }
	| { available: false; unavailableReason: string };

const BATCH_FILE = /\.(cmd|bat)$/i;

function resolveBinary(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
	const windows = platform === "win32";
	if (path.isAbsolute(command) || command.includes(path.sep) || (windows && command.includes("/"))) {
		const resolved = path.resolve(command);
		fs.accessSync(resolved, fs.constants.X_OK);
		return resolved;
	}
	// Windows environment names are case-insensitive, and a copied process.env keeps its spelling (often `Path`).
	const read = (name: string) => windows ? Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] : env[name];
	const pathExt = windows ? (read("PATHEXT") ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [];
	const named = pathExt.some((extension) => command.toLowerCase().endsWith(extension.toLowerCase()));
	const extensions = windows ? (named ? ["", ...pathExt] : pathExt) : [""];
	for (const directory of (read("PATH") ?? "").split(path.delimiter)) {
		if (!directory) continue;
		for (const extension of extensions) {
			const candidate = path.join(directory, `${command}${extension}`);
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				// A batch shim resolves its target from its own directory (%dp0%), so keep the path it was found at.
				return windows && BATCH_FILE.test(candidate) ? candidate : fs.realpathSync(candidate);
			} catch {}
		}
	}
	throw new Error(`External CLI binary '${command}' was not found on PATH.`);
}

/** Resolve only the configured command; unlike preflight, this never starts a child process. */
export function resolveExternalCliBinaryAvailability(command: string, env: NodeJS.ProcessEnv): ExternalCliBinaryAvailability {
	try {
		resolveBinary(command, env);
		return { available: true };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { available: false, unavailableReason: reason.slice(0, MAX_AVAILABILITY_REASON_LENGTH) };
	}
}

// npm's cmd-shim output for a `#!/usr/bin/env node` bin, with CRLF normalized; the target path sits between the two parts.
const NPM_NODE_SHIM_HEAD = '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\';
const NPM_NODE_SHIM_TAIL = '" %*\n';

export interface ExternalCliSpawn {
	command: string;
	args: readonly string[];
}

/**
 * Node refuses to spawn `.cmd`/`.bat` files without a shell (CVE-2024-27980), and a shell would expand
 * `%` and `!` inside operator- and project-controlled arguments. On Windows, an npm Node shim is launched
 * by running Node on its script directly; every other batch wrapper is rejected.
 */
export function resolveExternalCliSpawn(command: string, args: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): ExternalCliSpawn {
	const unchanged = { command, args };
	if (platform !== "win32") return unchanged;
	let resolved: string;
	try {
		resolved = resolveBinary(command, env, platform);
	} catch (error) {
		if (BATCH_FILE.test(command)) throw error;
		return unchanged;
	}
	if (!BATCH_FILE.test(resolved)) return unchanged;
	const shim = fs.readFileSync(resolved, "utf-8").replace(/\r\n/g, "\n");
	const target = /\.cmd$/i.test(resolved) && shim.startsWith(NPM_NODE_SHIM_HEAD) && shim.endsWith(NPM_NODE_SHIM_TAIL)
		? shim.slice(NPM_NODE_SHIM_HEAD.length, shim.length - NPM_NODE_SHIM_TAIL.length)
		: "";
	const directory = path.dirname(resolved);
	const script = path.resolve(directory, target.split("\\").join(path.sep));
	if (!target || /^\\|["%:/\n]/.test(target) || !fs.statSync(script, { throwIfNoEntry: false })?.isFile()) {
		throw new Error(`External CLI '${resolved}' is a batch wrapper that cannot run without a shell. On Windows, only npm-generated Node shims and .exe files can launch.`);
	}
	const bundledNode = path.join(directory, "node.exe");
	return { command: fs.existsSync(bundledNode) ? bundledNode : resolveNodeExecutable(), args: [script, ...args] };
}

export interface ExternalCliPreflightOptions {
	signal?: AbortSignal;
	deadlineAt?: number;
	onProcess?: (process: Omit<ExternalProcessStatus, "stdoutPath" | "stderrPath">) => void;
}

async function probeWithTimeout(binaryPath: string, args: readonly string[], env: NodeJS.ProcessEnv, label: string, timeoutMs: number, cwd: string | undefined, options: ExternalCliPreflightOptions): Promise<string> {
	options.signal?.throwIfAborted();
	const remaining = options.deadlineAt === undefined ? timeoutMs : Math.min(timeoutMs, options.deadlineAt - Date.now());
	if (remaining <= 0) throw new Error("External CLI launch deadline expired during preflight");
	const launch = resolveExternalCliSpawn(binaryPath, args, env);
	return new Promise((resolve, reject) => {
		const startedAt = Date.now(), processInstanceId = randomUUID();
		const child = spawn(launch.command, launch.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true, detached: process.platform !== "win32" });
		const tree = child.pid === undefined ? undefined : createOwnedProcessTreeController(child.pid, { termGraceMs: 100, killVerifyMs: 1000 });
		const initial = { pid: child.pid, processInstanceId, phase: "preflight" as const, startedAt };
		let failure: Error | undefined, termination: ReturnType<NonNullable<typeof tree>["terminate"]> | undefined;
		let bytes = 0;
		const stdout: Buffer[] = [], stderr: Buffer[] = [];
		const fail = (error: Error) => { failure ??= error; termination ??= tree?.terminate(); };
		const collect = (parts: Buffer[], chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_PROBE_OUTPUT_BYTES) fail(new Error("probe output exceeded its byte limit"));
			else parts.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		child.once("error", fail);
		const timer = setTimeout(() => fail(new Error("probe timed out")), remaining);
		const abort = () => fail(new Error("probe aborted"));
		options.signal?.addEventListener("abort", abort, { once: true });
		child.once("close", (exitCode, processSignal) => {
			clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
			void (async () => {
				const processTree = termination ? await termination : await tree?.finishAfterWriterClose();
				options.onProcess?.({ ...initial, endedAt: Date.now(), exitCode, processSignal, ...(processTree ? { processTree } : {}) });
				if (processTree?.state === "unknown") throw new Error(`External CLI ${label} preflight process-tree settlement is unknown: ${processTree.reason}`);
				if (failure) throw new Error(`External CLI ${label} preflight failed: ${failure.message}`, { cause: failure });
				if (exitCode !== 0) throw new Error(`External CLI ${label} preflight exited with code ${exitCode}: ${Buffer.concat(stderr.length ? stderr : stdout).toString("utf8").trim()}`);
				resolve(Buffer.concat(stdout).toString("utf8").trim());
			})().catch(reject);
		});
		try { options.onProcess?.(initial); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
		if (options.signal?.aborted) abort();
	});
}

function narrowPositiveInteger(value: number | undefined, ceiling: number, label: string): number {
	if (value === undefined) return ceiling;
	if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) throw new Error(`${label} may only narrow the code-owned ceiling of ${ceiling}.`);
	return value;
}

function specKey(spec: ExternalCliPreflightSpec): string {
	return JSON.stringify([spec.id, spec.versionArgs, spec.helpArgs, spec.evidenceArgs, spec.evidenceLabel, spec.probeTimeoutMs, spec.remote === true]);
}

export async function preflightExternalCli(command: string, spec: ExternalCliPreflightSpec, env: NodeJS.ProcessEnv, cwd?: string, options: ExternalCliPreflightOptions = {}): Promise<ExternalCliPreflightResult> {
	const binaryPath = resolveBinary(command, env);
	const binaryMtimeMs = fs.statSync(binaryPath).mtimeMs;
	const lookupKey = JSON.stringify([binaryPath, binaryMtimeMs, specKey(spec)]);
	const cachedKey = lookup.get(lookupKey);
	const cached = cachedKey ? cache.get(cachedKey) : undefined;
	const ceiling = spec.remote === true ? MAX_REMOTE_PROBE_TIMEOUT_MS : MAX_PROBE_TIMEOUT_MS;
	const probeTimeoutMs = narrowPositiveInteger(spec.probeTimeoutMs, ceiling, "probeTimeoutMs");
	const base = cached ?? {
		binaryPath,
		binaryMtimeMs,
		version: await probeWithTimeout(binaryPath, spec.versionArgs, env, "version", probeTimeoutMs, cwd, options),
		help: await probeWithTimeout(binaryPath, spec.helpArgs, env, "help", probeTimeoutMs, cwd, options),
	};
	const evidence = spec.evidenceArgs
		? await probeWithTimeout(binaryPath, spec.evidenceArgs, env, spec.evidenceLabel ?? "evidence", probeTimeoutMs, cwd, options)
		: undefined;
	const result = { ...base, ...(evidence !== undefined ? { evidence } : {}), cacheHit: Boolean(cached) };
	spec.validate?.(result);
	if (!cached) {
		const cacheKey = JSON.stringify([binaryPath, base.version, binaryMtimeMs, specKey(spec)]);
		cache.set(cacheKey, base);
		lookup.set(lookupKey, cacheKey);
		while (cache.size > MAX_CACHE_ENTRIES) {
			const oldest = cache.keys().next().value as string;
			cache.delete(oldest);
			for (const [candidateLookup, candidateCache] of lookup) if (candidateCache === oldest) lookup.delete(candidateLookup);
		}
	}
	return result;
}

export function invalidateExternalCliPreflight(command: string, spec: ExternalCliPreflightSpec, _reason: ExternalCliPreflightInvalidationReason): void {
	const key = specKey(spec);
	for (const [cacheKey, entry] of cache) {
		if (entry.binaryPath === command || entry.binaryPath.endsWith(`${path.sep}${command}`) || cacheKey.includes(key)) cache.delete(cacheKey);
	}
	for (const [lookupKey, cacheKey] of lookup) if (!cache.has(cacheKey)) lookup.delete(lookupKey);
}

export function clearExternalCliPreflightCacheForTests(): void {
	cache.clear();
	lookup.clear();
}
