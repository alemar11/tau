import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { runSetupCommand, type SetupCommandOptions, type SetupCommandResult } from "./worktree-setup-command.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAuthorityDecision, type AuthorityPolicyConfig } from "../../policy/authority.ts";
import { PROJECT_SUBAGENTS_RELATIVE_DIR } from "../../shared/artifacts.ts";
import { getAgentDir } from "../../shared/utils.ts";
import type { ManagedWorktreeProvider, WorktreeNaming, WorktreeProvider } from "../../shared/types.ts";
import { admitWriter, type WriterIdentity } from "./writer-admission.ts";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";
import { reserveWorktree, finishWorktreeReservation, assertWorktreeOwnership, worktreeWriterScope, type WorktreeOwnership } from "./worktree-ownership.ts";

export const DEFAULT_WORKTREE_PROVIDER: WorktreeProvider = "native";
export const DEFAULT_WORKTREE_BASE_REF = "HEAD";
export const DEFAULT_WORKTREE_BRANCH_PREFIX = "tau-subagents/";
/** Internal marker for binding managed-worktree instruction paths at launch. */
export const WORKTREE_AGENT_CWD_PLACEHOLDER = path.join(path.parse(process.cwd()).root, "__tau_subagents_worktree_cwd__");
const WORKTREE_NAMING_COMPONENT_MAX_BYTES = 96;
const WORKTREE_NAMING_LABEL_MAX_BYTES = 256;
const WORKTREE_NAMING_BRANCH_MAX_BYTES = 256;
export const MACHINE_DIFF_OPTIONS = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--line-prefix=", "--no-relative"] as const;
const MACHINE_PATCH_OPTIONS = [...MACHINE_DIFF_OPTIONS, "--binary"] as const;
const PATCH_VALIDATION_OPTIONS = ["apply", "--check", "--cached", "--reverse", "--binary", "--whitespace=nowarn"] as const;

export interface WorktreeNamingInput {
	runId: string;
	index: number;
	/** Explicit step index; otherwise a trailing `-sN` in runId is used. */
	stepIndex?: number;
	/** Explicit task index; defaults to index. */
	taskIndex?: number;
	/** Label precedence is lane/workflow key, output/stable key, then this label. */
	agent?: string;
	label?: string;
	laneKey?: string;
	workflowKey?: string;
	outputName?: string;
	taskKey?: string;
	task?: string;
	branchPrefix?: string;
}

export interface WorktreeSetup {
	writerIdentity?: WriterIdentity;
	deadlineAt?: number;
	cwd: string;
	worktrees: WorktreeInfo[];
	baseCommit: string;
	capturedDiffs?: WorktreeDiff[];
}

export interface WorktreeInfo {
	ownership?: WorktreeOwnership;
	path: string;
	agentCwd: string;
	branch: string;
	index: number;
	nodeModulesLinked: boolean;
	syntheticPaths: string[];
	provider?: ManagedWorktreeProvider;
	naming?: WorktreeNaming;
}

export interface WorktreeDiff {
	index: number;
	agent: string;
	branch: string;
	diffStat: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	patchPath: string;
	error?: string;
}

export interface WorktreeCleanupTask {
	ownership?: WorktreeOwnership;
	index: number;
	path: string;
	branch: string;
	provider?: ManagedWorktreeProvider;
	naming?: WorktreeNaming;
	worktreeRemoved: boolean;
	branchRemoved: boolean;
	preserved?: boolean;
	reason?: string;
	errors?: string[];
}

export type WorktreeCleanupIntent =
	| { kind: "preserve"; capturedDiffs?: WorktreeDiff[]; handoffManifestPath?: string; cleanupBlocker?: string }
	| {
		kind: "discard";
		authorization:
			| { kind: "policy"; policy?: AuthorityPolicyConfig }
			| { kind: "confirmed"; policy?: AuthorityPolicyConfig };
	}
	| { kind: "setup-rollback" };

export interface WorktreeCleanupReport {
	state: "complete" | "partial";
	tasks: WorktreeCleanupTask[];
	pruned: boolean;
	errors?: string[];
}

interface WorktreeTaskCwdConflict {
	index: number;
	agent: string;
	cwd: string;
}

interface WorktreeSetupHookConfig {
	hookPath: string;
	timeoutMs?: number;
}

export interface CreateWorktreesOptions {
	writerIdentity?: WriterIdentity;
	signal?: AbortSignal;
	/** Existing absolute run deadline only; setup does not start a child budget. */
	deadlineAt?: number;
	onProgress?: (snapshot: WorktreeSetupProgress) => void;
	agents?: string[];
	/** Optional stable labels used to make branch identity readable. */
	labels?: Array<string | undefined>;
	/** Original task text used for the agent-plus-slug naming fallback. */
	tasks?: Array<string | undefined>;
	/** Native Git only; external allocators are excluded. */
	provider?: WorktreeProvider;
	/** Git ref used as the worktree base; defaults to `HEAD`. */
	baseRef?: string;
	/** Branch namespace; defaults to `tau-subagents/`. */
	branchPrefix?: string;
	setupHook?: WorktreeSetupHookConfig;
	baseDir?: string;
}

interface ResolvedWorktreeSetupHook {
	hookPath: string;
	timeoutMs: number;
}

interface WorktreeSetupHookInput {
	version: 1;
	repoRoot: string;
	worktreePath: string;
	agentCwd: string;
	branch: string;
	index: number;
	runId: string;
	baseCommit: string;
	agent?: string;
}

interface WorktreeSetupHookOutput {
	syntheticPaths?: string[];
}

interface GitResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

interface RepoState {
	toplevel: string;
	cwdRelative: string;
	baseCommit: string;
}

const DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS = 30000;

/** In-memory evidence only. Callers project this into existing handoff diagnostics. */
export interface WorktreeSetupProgress {
	setup: WorktreeSetup;
	attempts: Array<{ index: number; branch: string; path?: string; validated: boolean; command?: WorktreeSetupProgress["command"]; hookCommand?: WorktreeSetupProgress["command"] }>;
	phase: string;
	command?: { command: string; args: string[]; pid?: number; processGroupId?: number; result?: Omit<SetupCommandResult, "stdout" | "stdoutBuffer" | "stderr"> };
	unknown?: string;
	cleanup?: WorktreeCleanupReport;
}

export class WorktreeSetupError extends Error {
	readonly snapshot: WorktreeSetupProgress;
	constructor(error: unknown, snapshot: WorktreeSetupProgress) {
		super(`${error instanceof Error ? error.message : String(error)}${snapshot.unknown ? `; setup settlement unknown: ${snapshot.unknown}; manual reconciliation required` : ""}`, { cause: error });
		this.name = "WorktreeSetupError";
		this.snapshot = snapshot;
	}
}

let worktreeTurn: Promise<void> = Promise.resolve();
let setupActive = false;
let setupPoison: string | undefined;

function assertWorktreeMutationAllowed(): void {
	if (setupPoison) throw new Error(`Worktree mutation blocked: ${setupPoison}`);
	if (setupActive) throw new Error("Worktree setup is active; finalization must await withWorktreeTransaction");
}

/** Later async finalization owners wrap their synchronous diff/cleanup as ONE turn. */
export async function withWorktreeTransaction<T>(action: () => T | Promise<T>, options: Pick<SetupCommandOptions, "signal" | "deadlineAt"> = {}): Promise<T> {
	if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)) throw new Error("Invalid worktree deadline");
	const previous = worktreeTurn;
	let release!: () => void;
	const completion = new Promise<void>((resolve) => { release = resolve; });
	// Cancelling a queued turn must not let its successor bypass the active turn.
	worktreeTurn = previous.then(() => completion);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			previous.then(resolve, reject);
			onAbort = () => reject(new Error("Worktree transaction aborted"));
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.signal?.aborted) onAbort();
			const arm = () => {
				if (options.deadlineAt === undefined) return;
				const remaining = options.deadlineAt - Date.now();
				if (remaining <= 0) reject(new Error("Worktree transaction deadline exceeded"));
				else timer = setTimeout(arm, Math.min(remaining, 2 ** 31 - 1));
			};
			arm();
		});
		if (setupPoison) throw new Error(`Worktree mutation blocked: ${setupPoison}`);
		return await action();
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) options.signal?.removeEventListener("abort", onAbort);
		release();
	}
}

const managedMutationLeases = new Set<string>();

export function assertManagedWorktree(worktree: Pick<WorktreeInfo, "ownership" | "path" | "branch">): void {
	assertWorktreeOwnership(worktree.ownership, worktree.path, worktree.branch);
	const commonDir = fs.realpathSync(path.resolve(worktree.path, runGitChecked(worktree.path, ["rev-parse", "--git-common-dir"]).trim()));
	const expectedRecord = path.join(commonDir, "tau-subagents", "worktree-owners-v1", createHash("sha256").update(worktree.branch).digest("hex"), "owner.json");
	if (worktree.ownership?.recordPath !== expectedRecord) throw new Error(`Managed worktree repository changed: ${worktree.path}`);
	if (runGitChecked(worktree.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim() !== worktree.branch) throw new Error(`Managed worktree branch changed: ${worktree.path}`);
}

/** Snapshot only after the SDK writer has released its real cwd. An uncertain
 * child or a competing writer leaves the tree intact, without an optimistic diff. */
export async function withWorktreeFinalization<T>(setup: WorktreeSetup, action: () => T | Promise<T>, deadlineAt = setup.deadlineAt): Promise<T> {
	if (!setup.writerIdentity) throw new Error("Missing worktree coordination identity");
	const identity = setup.writerIdentity;
	const deadline = Math.min(deadlineAt ?? Infinity, Date.now() + 2000);
	return withWorktreeTransaction(async () => {
		const leases: Array<Awaited<ReturnType<typeof admitWriter>>> = [];
		try {
			for (const worktree of [...setup.worktrees].sort((a, b) => a.path.localeCompare(b.path))) {
				const scope = worktreeWriterScope(worktree.ownership, worktree.path, worktree.branch);
				if (scope.rootSessionId !== identity.rootSessionId) throw new Error("Managed worktree root session mismatch");
				leases.push(await admitWriter({ ...identity, runId: `${identity.runId}:worktree-finalization:${worktree.index}`, cwd: scope.cwd, storageRoot: scope.storageRoot, deadlineAt: deadline }));
				assertManagedWorktree(worktree);
			}
			for (const worktree of setup.worktrees) managedMutationLeases.add(worktree.ownership!.token);
			return await action();
		} finally {
			for (const worktree of setup.worktrees) if (worktree.ownership) managedMutationLeases.delete(worktree.ownership.token);
			for (const lease of leases.reverse()) await lease.release();
		}
	}, { deadlineAt: deadline });
}

class SetupTransaction {
	readonly progress: WorktreeSetupProgress;
	readonly options: CreateWorktreesOptions;
	constructor(cwd: string, options: CreateWorktreesOptions) {
		this.options = options;
		this.progress = { setup: { cwd, baseCommit: "", worktrees: [], writerIdentity: options.writerIdentity, deadlineAt: options.deadlineAt }, attempts: [], phase: "preflight" };
	}
	snapshot(): WorktreeSetupProgress {
		return structuredClone(this.progress);
	}
	publish(): void { this.options.onProgress?.(this.snapshot()); }
	check(): void {
		if (setupPoison) throw new Error(setupPoison);
		if (this.options.signal?.aborted) throw new Error("Worktree setup aborted");
		if (this.options.deadlineAt !== undefined && Date.now() >= this.options.deadlineAt) throw new Error("Worktree setup deadline exceeded");
	}
	unknown(error: unknown): void {
		const reason = error instanceof Error ? error.message : String(error);
		this.progress.unknown ??= reason;
		setupPoison ??= reason;
	}
	async command(command: string, args: string[], options: SetupCommandOptions = {}): Promise<SetupCommandResult> {
		this.check();
		this.progress.command = { command, args };
		if (this.progress.phase === "allocation") this.progress.attempts.at(-1)!.command = this.progress.command;
		if (this.progress.phase === "hook") this.progress.attempts.find((attempt) => attempt.path === options.cwd)!.hookCommand = this.progress.command;
		const result = await runSetupCommand(command, args, {
			...options, signal: this.options.signal, deadlineAt: this.options.deadlineAt,
			onSpawn: (process) => { Object.assign(this.progress.command!, process); this.publish(); },
		});
		const { stdout: _stdout, stdoutBuffer: _stdoutBuffer, stderr: _stderr, ...metadata } = result;
		this.progress.command.result = metadata;
		if (result.processTree?.state === "unknown") this.unknown(result.error ?? "Command tree settlement unverified");
		this.publish();
		if (result.error) throw result.error;
		return result;
	}
	async git(cwd: string, args: string[], acceptedExitCodes?: readonly number[]): Promise<SetupCommandResult> {
		return this.command("git", ["-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], { acceptedExitCodes, env: gitEnvironment() });
	}
	async gitChecked(cwd: string, args: string[]): Promise<string> {
		const result = await this.git(cwd, args);
		return result.stdout;
	}
	attempt(index: number, branch: string, worktreePath?: string): void {
		this.check();
		this.progress.phase = "allocation";
		this.progress.command = undefined;
		this.progress.attempts.push({ index, branch, path: worktreePath, validated: false });
		this.publish();
	}
	validated(worktree: WorktreeInfo): void {
		this.progress.phase = "validated";
		Object.assign(this.progress.attempts.at(-1)!, { path: worktree.path, validated: true });
		this.progress.setup.worktrees.push(worktree);
		this.publish();
	}
}

export function gitEnvironment(): NodeJS.ProcessEnv {
	return { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_NAMESPACE: undefined, GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined };
}

function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): GitResult {
	const result = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], { encoding: "utf-8", windowsHide: true, shell: false, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, env: { ...gitEnvironment(), ...env } });
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr || result.error?.message || "",
		status: result.status,
	};
}

function runGitChecked(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (result.status !== 0) {
		const command = `git -C ${cwd} ${args.join(" ")}`;
		const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
		throw new Error(message);
	}
	return result.stdout;
}

/** Validate against a temporary snapshot index, leaving the real index and files intact. */
export function validateWorktreePatch(worktreePath: string, patchPath: string): string | undefined {
	try {
		return withSnapshotIndex(worktreePath, [], (env) => {
			const result = runGit(worktreePath, [...PATCH_VALIDATION_OPTIONS, patchPath], env);
			if (result.status === 0) return undefined;
			return result.stderr.trim() || result.stdout.trim() || `git -C ${worktreePath} apply --check failed`;
		});
	} catch (error) { return error instanceof Error ? error.message : String(error); }
}

function currentWorktreePatch(worktreePath: string, baseCommit: string): { patch: string } | { error: string } {
	assertWorktreeMutationAllowed();
	try {
		return withSnapshotIndex(worktreePath, [], (env) => {
			const diff = runGit(worktreePath, ["diff", "--cached", ...MACHINE_PATCH_OPTIONS, baseCommit], env);
			if (diff.status !== 0) return { error: diff.stderr.trim() || diff.stdout.trim() || "git diff failed" };
			return { patch: diff.stdout };
		});
	} catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

export function validateWorktreePatchRepresentsCurrentWorktree(worktreePath: string, baseCommit: string, patchPath: string): string | undefined {
	const validationError = validateWorktreePatch(worktreePath, patchPath);
	if (validationError) return validationError;
	let capturedPatch: string;
	try {
		capturedPatch = fs.readFileSync(patchPath, "utf-8");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	const current = currentWorktreePatch(worktreePath, baseCommit);
	if ("error" in current) return current.error || "failed to capture current worktree patch";
	if (capturedPatch !== current.patch) return "captured handoff patch does not match current worktree changes";
	return undefined;
}

async function probeWorktreeSource(tx: Pick<SetupTransaction, "git" | "gitChecked">, cwd: string): Promise<string> {
	const repoCheck = await tx.git(cwd, ["rev-parse", "--is-inside-work-tree"], [0, 128]);
	if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") throw new Error("worktree isolation requires a git repository");
	const toplevel = (await tx.gitChecked(cwd, ["rev-parse", "--show-toplevel"])).trim();

	// tau-subagents writes durable runtime state under .pi/subagents/ by default;
	// that state must not make managed isolation unusable for later runs.
	const status = await tx.gitChecked(toplevel, ["status", "--porcelain", "--", `:!${PROJECT_SUBAGENTS_RELATIVE_DIR}`]);
	if (status.trim().length > 0) {
		throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
	}
	return toplevel;
}

/** Read-only admission check; allocation repeats it because source state can change. */
export async function preflightWorktreeSource(cwd: string, options: Pick<SetupCommandOptions, "signal" | "deadlineAt"> = {}): Promise<void> {
	const git = async (cwd: string, args: string[], acceptedExitCodes: readonly number[] = [0]): Promise<SetupCommandResult> => {
		const result = await runSetupCommand("git", ["-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], { ...options, acceptedExitCodes, env: gitEnvironment() });
		if (result.error) throw result.error;
		if (result.outputIncomplete || result.status === null || !acceptedExitCodes.includes(result.status)) {
			throw new Error(result.stderr.trim().slice(0, 2000) || "Worktree source probe failed");
		}
		return result;
	};
	await probeWorktreeSource({ git, gitChecked: async (cwd, args) => (await git(cwd, args)).stdout }, cwd);
}

async function resolveRepoState(tx: SetupTransaction, cwd: string, requestedBaseRef: string | undefined): Promise<RepoState> {
	const toplevel = await probeWorktreeSource(tx, cwd);
	const rawPrefix = (await tx.gitChecked(cwd, ["rev-parse", "--show-prefix"])).trim();
	const cwdRelative = rawPrefix ? path.normalize(rawPrefix.replace(/[\\/]+$/, "")) : "";

	const baseRef = normalizeWorktreeBaseRef(requestedBaseRef) ?? DEFAULT_WORKTREE_BASE_REF;
	let baseCommit: string;
	try {
		const base = await tx.git(toplevel, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], [0, 128]);
		if (base.status !== 0) throw new Error(base.stderr.trim() || "ref not found");
		baseCommit = base.stdout.trim();
	} catch (error) {
		throw new Error(`baseRef '${baseRef}' could not be resolved to a commit: ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
	}
	if (!baseCommit) throw new Error(`baseRef '${baseRef}' could not be resolved to a commit`);
	return { toplevel, cwdRelative, baseCommit };
}

function normalizeComparableCwd(cwd: string): string {
	const resolved = path.resolve(cwd);
	let existing = resolved;
	const missingSegments: string[] = [];
	while (true) {
		try {
			let realpath: string;
			try {
				realpath = fs.realpathSync.native(existing);
			} catch {
				realpath = fs.realpathSync(existing);
			}
			return path.join(realpath, ...missingSegments.reverse());
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) return resolved;
			missingSegments.push(path.basename(existing));
			existing = parent;
		}
	}
}

export function findWorktreeTaskCwdConflict(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): WorktreeTaskCwdConflict | undefined {
	const normalizedSharedCwd = normalizeComparableCwd(sharedCwd);
	for (let index = 0; index < tasks.length; index++) {
		const task = tasks[index]!;
		if (!task.cwd) continue;
		const taskCwd = path.isAbsolute(task.cwd) ? task.cwd : path.resolve(sharedCwd, task.cwd);
		if (normalizeComparableCwd(taskCwd) === normalizedSharedCwd) continue;
		return { index, agent: task.agent, cwd: task.cwd };
	}
	return undefined;
}

export function formatWorktreeTaskCwdConflict(
	conflict: WorktreeTaskCwdConflict,
	sharedCwd: string,
): string {
	return `worktree isolation uses the shared cwd (${sharedCwd}); task ${conflict.index + 1} (${conflict.agent}) sets cwd to ${conflict.cwd}. Remove task-level cwd overrides or disable worktree.`;
}

function safePatchAgentName(agent: string): string {
	return agent.replace(/[^\w.-]/g, "_");
}

function shortWorktreeHash(value: string): string {
	return createHash("sha256").update(value, "utf-8").digest("hex").slice(0, 8);
}

function truncateUtf8(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf-8");
	if (bytes.length <= maxBytes) return value;
	// Back off to a code-point boundary before decoding: cutting mid-sequence
	// emits U+FFFD (3 bytes per dangling byte), which can push the re-encoded
	// result beyond maxBytes (e.g. a 256-byte cap yields a 258-byte string).
	let end = maxBytes;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end).toString("utf-8");
}

/** Convert an arbitrary label to a single safe filesystem/branch component. */
export function sanitizeWorktreePathComponent(value: string, maxBytes = WORKTREE_NAMING_COMPONENT_MAX_BYTES): string {
	const raw = value.trim();
	let normalized = raw
		.replace(/[\\/\s]+/g, "-")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[._-]+|[._-]+$/g, "");
	if (!normalized) return "task";
	const changed = normalized !== raw;
	if (changed || Buffer.byteLength(normalized, "utf-8") > maxBytes) {
		const suffix = `-${shortWorktreeHash(raw || "task")}`;
		const prefix = truncateUtf8(normalized, Math.max(1, maxBytes - Buffer.byteLength(suffix, "utf-8"))).replace(/[._-]+$/g, "");
		normalized = `${prefix || "task"}${suffix}`;
	}
	return truncateUtf8(normalized, maxBytes).replace(/^[._-]+|[._-]+$/g, "") || "task";
}

function validGitRef(ref: string): boolean {
	if (!ref || ref === "@" || Buffer.byteLength(ref, "utf-8") > 1024 || ref.startsWith("/") || ref.endsWith("/") || ref.includes("//") || ref.includes("..") || ref.includes("@{")) return false;
	if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(ref)) return false;
	if (/[[\]\\~^:?*\u0000-\u0020\u007f]/u.test(ref) || ref.endsWith(".") || ref.endsWith(".lock")) return false;
	return ref.split("/").every((component) => component.length > 0 && component !== "." && component !== ".." && !component.startsWith(".") && !component.endsWith(".") && !component.endsWith(".lock"));
}

/** Normalize and validate a configured worktree base ref without resolving it. */
export function normalizeWorktreeBaseRef(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !validGitRef(value)) throw new Error("baseRef must be a valid Git ref: use HEAD or a supported named ref (for example, refs/heads/main). Full 40/64-character commit IDs and revision expressions are unsupported.");
	return value;
}

/** Normalize and validate the configured Git branch namespace. */
export function normalizeWorktreeBranchPrefix(value: string | undefined): string {
	const raw = value === undefined ? DEFAULT_WORKTREE_BRANCH_PREFIX : value.trim();
	if (!raw) throw new Error("worktree branch prefix cannot be empty");
	if (raw.includes("\\") || /[\u0000-\u001f\u007f\s]/u.test(raw) || raw.startsWith("/") || raw.includes("//") || raw.includes("..") || raw.includes("@{")) {
		throw new Error("worktree branch prefix contains invalid Git ref characters");
	}
	const withoutTrailingSlash = raw.replace(/\/+$/u, "");
	if (!withoutTrailingSlash || withoutTrailingSlash.startsWith("-") || withoutTrailingSlash.split("/").some((component) => component === "." || component === ".." || component.startsWith("."))) {
		throw new Error("worktree branch prefix contains an invalid Git ref component");
	}
	const prefix = `${withoutTrailingSlash}/`;
	if (!validGitRef(`${prefix}task`)) throw new Error("worktree branch prefix is not a valid Git ref namespace");
	return prefix;
}

function runShortId(runId: string): string {
	const base = runId.replace(/-s\d+$/u, "");
	const normalized = sanitizeWorktreePathComponent(base || runId, 16);
	return normalized.length > 12 ? normalized.slice(0, 12) : normalized;
}

function nonNegativeNamingIndex(value: number | undefined, label: string, fallback: number): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 0) throw new Error(`${label} must be a non-negative integer`);
	return resolved;
}

/** Build the stable branch identity used by native allocation. */
export function buildWorktreeNaming(input: WorktreeNamingInput): WorktreeNaming {
	if (!input.runId.trim()) throw new Error("worktree run id cannot be empty");
	const index = nonNegativeNamingIndex(input.index, "worktree index", 0);
	const stepIndex = nonNegativeNamingIndex(input.stepIndex, "worktree step index", Number(input.runId.match(/-s(\d+)$/u)?.[1] ?? 0));
	const taskIndex = nonNegativeNamingIndex(input.taskIndex, "worktree task index", index);
	const label = input.laneKey?.trim()
		|| input.workflowKey?.trim()
		|| input.outputName?.trim()
		|| input.taskKey?.trim()
		|| input.label?.trim()
		|| (input.agent?.trim() && input.task?.trim() ? `${input.agent.trim()}-${input.task.trim()}` : undefined)
		|| input.agent?.trim()
		|| "task";
	const branchPrefix = normalizeWorktreeBranchPrefix(input.branchPrefix);
	const labelComponent = sanitizeWorktreePathComponent(label);
	const pathComponentBase = `${labelComponent}-${runShortId(input.runId)}-s${stepIndex}-t${taskIndex}`;
	const sanitizedPathComponent = validGitRef(`${branchPrefix}${pathComponentBase}`)
		? pathComponentBase
		: sanitizeWorktreePathComponent(pathComponentBase, WORKTREE_NAMING_COMPONENT_MAX_BYTES);
	let requestedBranch = `${branchPrefix}${sanitizedPathComponent}`;
	if (!validGitRef(requestedBranch) || Buffer.byteLength(requestedBranch, "utf-8") > WORKTREE_NAMING_BRANCH_MAX_BYTES) {
		const suffix = `-${shortWorktreeHash(pathComponentBase)}`;
		const available = Math.max(1, WORKTREE_NAMING_BRANCH_MAX_BYTES - Buffer.byteLength(branchPrefix, "utf-8") - Buffer.byteLength(suffix, "utf-8"));
		requestedBranch = `${branchPrefix}${truncateUtf8(pathComponentBase, available).replace(/[._-]+$/g, "")}${suffix}`;
	}
	if (!validGitRef(requestedBranch) || Buffer.byteLength(requestedBranch, "utf-8") > WORKTREE_NAMING_BRANCH_MAX_BYTES) throw new Error(`generated worktree branch is not a valid Git ref: ${requestedBranch}`);
	const metadataLabel = truncateUtf8(label.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim() || "task", WORKTREE_NAMING_LABEL_MAX_BYTES);
	return {
		requestedBranch,
		branchPrefix,
		label: metadataLabel,
		sanitizedPathComponent: requestedBranch.slice(branchPrefix.length),
	};
}

function isInsidePiExtensionsDirectory(targetPath: string): boolean {
	const extensionsDir = normalizeComparableCwd(path.join(getAgentDir(), "extensions"));
	return isPathInside(extensionsDir, normalizeComparableCwd(targetPath));
}

function assertNativeWorktreeProvider(provider: WorktreeProvider | undefined): void {
	if (provider !== undefined && provider !== "native") throw new Error("Only the native Git worktree provider is supported; other allocators are excluded.");
}

export function resolveWorktreeProvider(requested: WorktreeProvider | undefined, _baseDir?: string): ManagedWorktreeProvider {
	assertNativeWorktreeProvider(requested);
	return "native";
}

/**
 * Resolves the dedicated worktree root: the configured base directory or
 * TAU_SUBAGENTS_WORKTREE_DIR when set, otherwise a `worktrees` folder sibling
 * to the repository. Managed leaves always nest one level deeper under the
 * project folder (repository basename plus a canonical-path hash).
 */
function resolveWorktreeDedicatedRoot(configuredBaseDir: string | undefined, repoRoot: string, relocateExtensionRepo = true): string {
	const rawBaseDir = configuredBaseDir ?? process.env.TAU_SUBAGENTS_WORKTREE_DIR;
	let expanded: string;
	if (rawBaseDir === undefined || (configuredBaseDir === undefined && !rawBaseDir.trim())) {
		expanded = relocateExtensionRepo && isInsidePiExtensionsDirectory(repoRoot)
			? path.join(getAgentDir(), "worktrees")
			: path.join(path.dirname(repoRoot), "worktrees");
	} else {
		const trimmed = rawBaseDir.trim();
		if (!trimmed) throw new Error("worktree base directory cannot be empty");

		const candidate = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
		expanded = path.isAbsolute(candidate) ? candidate : path.resolve(repoRoot, candidate);
	}
	const extensionsDir = normalizeComparableCwd(path.join(getAgentDir(), "extensions"));
	if (isPathInside(extensionsDir, normalizeComparableCwd(expanded))) {
		throw new Error(`worktree base directory cannot be inside Pi extensions directory: ${extensionsDir}. Choose a directory outside it.`);
	}
	return expanded;
}

export function resolveWorktreeProjectDirectory(repoRoot: string, baseDir?: string): string {
	return buildNativeProjectPath(resolveWorktreeDedicatedRoot(baseDir, repoRoot), repoRoot);
}

function buildNativeProjectPath(dedicatedRoot: string, repoRoot: string): string {
	return path.join(dedicatedRoot, `${path.basename(repoRoot)}-${shortWorktreeHash(normalizeComparableCwd(repoRoot))}`);
}

/**
 * Creates the project folder (parents included) so `git worktree add` can create
 * the leaf inside it. Must only run after `assertSafeWorktreeLocation` accepted
 * the planned leaf — an unsafe base must never be materialized on disk.
 */
function ensureProjectWorktreeDir(dedicatedRoot: string, repoRoot: string): void {
	try {
		fs.mkdirSync(buildNativeProjectPath(dedicatedRoot, repoRoot), { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to create worktree base directory ${dedicatedRoot}: ${message}`);
	}
}

function buildNativeWorktreePath(dedicatedRoot: string, repoRoot: string, runId: string, index: number): string {
	return path.join(buildNativeProjectPath(dedicatedRoot, repoRoot), `pi-worktree-${sanitizeWorktreePathComponent(runId, 120)}-${index}`);
}

function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	if (!relative || relative === ".") return true;
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isStrictChildPath(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return Boolean(relative) && relative !== "." && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Fail closed before `git worktree add`: reject unsafe planned/realpath locations. */
function assertSafeWorktreeLocation(worktreePath: string, repoRoot: string, dedicatedRoot: string): void {
	const resolvedLeaf = normalizeComparableCwd(worktreePath);
	const resolvedRepoRoot = normalizeComparableCwd(repoRoot);
	const projectDir = normalizeComparableCwd(buildNativeProjectPath(dedicatedRoot, repoRoot));
	const repoParent = normalizeComparableCwd(path.dirname(resolvedRepoRoot));
	const leafParent = normalizeComparableCwd(path.dirname(resolvedLeaf));
	const extensionsDir = normalizeComparableCwd(path.join(getAgentDir(), "extensions"));

	if (isPathInside(extensionsDir, projectDir) || isPathInside(extensionsDir, resolvedLeaf)) {
		throw new Error(`worktree path cannot be inside Pi extensions directory: ${extensionsDir}. Choose a directory outside it.`);
	}
	if (isPathInside(resolvedRepoRoot, resolvedLeaf)) {
		throw new Error(`worktree path would land inside the repository checkout: ${resolvedLeaf}`);
	}
	if (leafParent === repoParent) {
		throw new Error(`worktree path would be a direct child of the repository parent: ${resolvedLeaf}`);
	}
	if (!isStrictChildPath(projectDir, resolvedLeaf)) {
		throw new Error(`worktree path must be a strict child of the project worktree directory ${projectDir}: ${resolvedLeaf}`);
	}
}

function resolveRepoCwdRelative(cwd: string): string {
	const repoCheck = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
		throw new Error("worktree isolation requires a git repository");
	}
	const rawPrefix = runGitChecked(cwd, ["rev-parse", "--show-prefix"]).trim();
	const normalizedPrefix = rawPrefix
		? path.normalize(rawPrefix.replace(/[\\/]+$/, ""))
		: "";
	return normalizedPrefix === "." ? "" : normalizedPrefix;
}

export function resolveExpectedWorktreeAgentCwd(cwd: string, runId: string, index: number, baseDir?: string): string {
	const cwdRelative = resolveRepoCwdRelative(cwd);
	const repoRoot = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();
	const dedicatedRoot = resolveWorktreeDedicatedRoot(baseDir, repoRoot);
	const worktreePath = buildNativeWorktreePath(dedicatedRoot, repoRoot, runId, index);
	assertSafeWorktreeLocation(worktreePath, repoRoot, dedicatedRoot);
	return cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
}

function linkNodeModulesIfPresent(toplevel: string, worktreePath: string): boolean {
	const nodeModulesPath = path.join(toplevel, "node_modules");
	const nodeModulesLinkPath = path.join(worktreePath, "node_modules");
	const hasDirectoryEntry = (candidate: string): boolean => {
		try { fs.lstatSync(candidate); return true; }
		catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
			throw error;
		}
	};
	try {
		if (hasDirectoryEntry(nodeModulesLinkPath)) return false;
		let sourceRealPath: string;
		try {
			if (!fs.statSync(nodeModulesPath).isDirectory()) throw new Error("source node_modules is not a directory");
			sourceRealPath = fs.realpathSync.native(nodeModulesPath);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
			throw error;
		}
		fs.symlinkSync(nodeModulesPath, nodeModulesLinkPath, process.platform === "win32" ? "junction" : "dir");
		if (!fs.lstatSync(nodeModulesLinkPath).isSymbolicLink()
			|| fs.realpathSync.native(nodeModulesLinkPath) !== sourceRealPath) {
			throw new Error("created link does not resolve to the source node_modules");
		}
		return true;
	} catch (error) {
		const code = error instanceof Error && "code" in error && typeof error.code === "string" ? `${error.code}: ` : "";
		throw new Error(
			`failed to link node_modules from ${nodeModulesPath} to ${nodeModulesLinkPath}: ${code}${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

function parseHookTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("worktree setup hook timeout must be an integer greater than 0");
	}
	return timeoutMs;
}

function resolveWorktreeSetupHook(
	repoRoot: string,
	config: WorktreeSetupHookConfig | undefined,
): ResolvedWorktreeSetupHook | undefined {
	if (!config) return undefined;
	const hookPath = config.hookPath.trim();
	if (!hookPath) {
		throw new Error("worktree setup hook path cannot be empty");
	}

	const expandedHookPath = hookPath.startsWith("~/") ? path.join(os.homedir(), hookPath.slice(2)) : hookPath;
	let resolvedPath: string;
	if (path.isAbsolute(expandedHookPath)) {
		resolvedPath = expandedHookPath;
	} else if (expandedHookPath.includes("/") || expandedHookPath.includes("\\")) {
		resolvedPath = path.resolve(repoRoot, expandedHookPath);
	} else {
		throw new Error("worktree setup hook must be an absolute path or a repo-relative path");
	}

	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`worktree setup hook not found: ${resolvedPath}`);
	}
	if (fs.statSync(resolvedPath).isDirectory()) {
		throw new Error(`worktree setup hook must be a file, got directory: ${resolvedPath}`);
	}

	return {
		hookPath: resolvedPath,
		timeoutMs: parseHookTimeout(config.timeoutMs),
	};
}

function normalizeSyntheticPath(worktreePath: string, rawPath: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) throw new Error("synthetic path cannot be empty");
	if (path.isAbsolute(trimmed)) throw new Error(`synthetic path must be relative: ${rawPath}`);

	const resolved = path.resolve(worktreePath, trimmed);
	const relative = path.relative(worktreePath, resolved);
	if (!relative || relative === ".") {
		throw new Error(`synthetic path cannot target the worktree root: ${rawPath}`);
	}
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`synthetic path escapes the worktree root: ${rawPath}`);
	}
	return path.normalize(relative);
}

function parseWorktreeSetupHookOutput(rawStdout: string): WorktreeSetupHookOutput {
	const trimmed = rawStdout.trim();
	if (!trimmed) {
		throw new Error("worktree setup hook returned empty stdout; expected JSON object");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`worktree setup hook returned invalid JSON: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("worktree setup hook stdout must be a JSON object");
	}
	return parsed as WorktreeSetupHookOutput;
}

async function runWorktreeSetupHook(
	tx: SetupTransaction,
	hook: ResolvedWorktreeSetupHook,
	input: WorktreeSetupHookInput,
): Promise<string[]> {
	tx.progress.phase = "hook";
	let result: SetupCommandResult;
	try {
		result = await tx.command(hook.hookPath, [], {
			cwd: input.worktreePath,
			input: JSON.stringify(input),
			hookTimeoutMs: hook.timeoutMs,
		});
	} catch (error) {
		throw new Error(`worktree setup hook failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	tx.progress.phase = "hook-validation";

	try {
		const output = parseWorktreeSetupHookOutput(result.stdout);
		if (output.syntheticPaths === undefined) return [];
		if (!Array.isArray(output.syntheticPaths)) {
			throw new Error("worktree setup hook output field 'syntheticPaths' must be an array of relative paths");
		}
		const uniquePaths = new Set<string>();
		for (const candidate of output.syntheticPaths) {
			if (typeof candidate !== "string") throw new Error("worktree setup hook output field 'syntheticPaths' must contain only strings");
			const normalizedPath = normalizeSyntheticPath(input.worktreePath, candidate);
			if ((await tx.gitChecked(input.worktreePath, ["ls-files", "--", normalizedPath])).trim()) {
				throw new Error(`worktree setup hook cannot mark tracked paths as synthetic: ${normalizedPath}`);
			}
			uniquePaths.add(normalizedPath);
		}
		return [...uniquePaths];
	} catch (error) {
		// Semantic rejection occurs after exit: retain uncertainty, never signal an old PID.
		tx.unknown(error);
		throw error;
	}
}

async function finalizeCreatedWorktree(
	tx: SetupTransaction,
	toplevel: string,
	cwdRelative: string,
	runId: string,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
	worktree: WorktreeInfo,
): Promise<WorktreeInfo> {
	const agentCwd = cwdRelative ? path.join(worktree.path, cwdRelative) : worktree.path;
	tx.check();
	if (!fs.existsSync(agentCwd) || !fs.statSync(agentCwd).isDirectory()) throw new Error(`Selected worktree base does not contain the requested directory: ${cwdRelative}`);
	const nodeModulesLinked = linkNodeModulesIfPresent(toplevel, worktree.path);
	const syntheticPaths = nodeModulesLinked ? ["node_modules"] : [];
	if (setupHook) {
		const hookSyntheticPaths = await runWorktreeSetupHook(tx, setupHook, {
			version: 1, repoRoot: toplevel, worktreePath: worktree.path, agentCwd,
			branch: worktree.branch, index: worktree.index, runId, baseCommit, agent,
		});
		syntheticPaths.push(...hookSyntheticPaths);
	}
	return { ...worktree, agentCwd, nodeModulesLinked, syntheticPaths };
}

async function createNativeWorktree(
	tx: SetupTransaction,
	toplevel: string,
	cwdRelative: string,
	runId: string,
	index: number,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
	dedicatedRoot: string,
	labels: Array<string | undefined> | undefined,
	tasks: Array<string | undefined> | undefined,
	branchPrefix: string | undefined,
): Promise<WorktreeInfo> {
	const naming = buildWorktreeNaming({ runId, index, agent, label: labels?.[index], task: tasks?.[index], branchPrefix });
	const worktreePath = buildNativeWorktreePath(dedicatedRoot, toplevel, runId, index);
	assertSafeWorktreeLocation(worktreePath, toplevel, dedicatedRoot);
	// Absence is required before claiming any partial artifacts from this attempt.
	const branch = await tx.git(toplevel, ["show-ref", "--verify", "--quiet", `refs/heads/${naming.requestedBranch}`], [0, 1]);
	let pathExists = false;
	try { fs.lstatSync(worktreePath); pathExists = true; }
	catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
	if (branch.status !== 1 || pathExists) throw new Error(`worktree path or branch already exists: ${worktreePath}, ${naming.requestedBranch}`);
	const commonDir = path.resolve(toplevel, (await tx.gitChecked(toplevel, ["rev-parse", "--git-common-dir"])).trim());
	const reservation = reserveWorktree(commonDir, { rootSessionId: tx.options.writerIdentity!.rootSessionId, runId, ownerRunId: tx.options.writerIdentity!.runId, agentCwd: cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath, writerStorageRoot: path.join(TEMP_ROOT_DIR, "writer-admission-v1"), branch: naming.requestedBranch, worktreePath });
	tx.attempt(index, naming.requestedBranch, worktreePath);
	ensureProjectWorktreeDir(dedicatedRoot, toplevel);
	await tx.git(toplevel, ["worktree", "add", worktreePath, "-b", naming.requestedBranch, baseCommit]);
	const worktree: WorktreeInfo = {
		ownership: finishWorktreeReservation(reservation, worktreePath, naming.requestedBranch),
		path: worktreePath,
		agentCwd: worktreePath,
		branch: naming.requestedBranch,
		index,
		nodeModulesLinked: false,
		syntheticPaths: [],
		provider: "native",
		naming,
	};
	tx.validated(worktree);
	return finalizeCreatedWorktree(tx, toplevel, cwdRelative, runId, baseCommit, setupHook, agent, worktree);
}

function removeSyntheticPath(worktree: WorktreeInfo, syntheticPath: string): void {
	assertWorktreeMutationAllowed();
	const resolved = path.resolve(worktree.path, syntheticPath);
	const relative = path.relative(worktree.path, resolved);
	if (!relative || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return;
	}

	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(resolved);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return;
		throw error;
	}

	if (stat.isSymbolicLink()) {
		fs.unlinkSync(resolved);
		return;
	}
	if (stat.isDirectory()) {
		fs.rmSync(resolved, { recursive: true, force: true });
		return;
	}
	fs.rmSync(resolved, { force: true });
}

function removeSyntheticPathsBeforeDiff(worktree: WorktreeInfo): void {
	if (worktree.syntheticPaths.length === 0) return;
	const seen = new Set<string>();
	for (const syntheticPath of worktree.syntheticPaths) {
		if (seen.has(syntheticPath)) continue;
		seen.add(syntheticPath);
		removeSyntheticPath(worktree, syntheticPath);
	}
}

function emptyDiff(index: number, agent: string, branch: string, patchPath: string, error?: string): WorktreeDiff {
	return {
		index,
		agent,
		branch,
		diffStat: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		patchPath,
		...(error ? { error } : {}),
	};
}

function parseNumstat(numstat: string): { filesChanged: number; insertions: number; deletions: number } {
	const lines = numstat
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;

	for (const line of lines) {
		const [rawInsertions, rawDeletions] = line.split("\t");
		if (rawInsertions === undefined || rawDeletions === undefined) continue;
		filesChanged++;
		if (/^\d+$/.test(rawInsertions)) insertions += parseInt(rawInsertions, 10);
		if (/^\d+$/.test(rawDeletions)) deletions += parseInt(rawDeletions, 10);
	}

	return { filesChanged, insertions, deletions };
}

function withSnapshotIndex<T>(cwd: string, syntheticPaths: string[], action: (env: NodeJS.ProcessEnv) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tau-worktree-snapshot-"));
	const env = { GIT_INDEX_FILE: path.join(dir, "index") };
	try {
		for (const args of [["read-tree", "HEAD"], ["add", "-A", "--", ".", ...syntheticPaths.map((entry) => `:(exclude,literal)${entry}`)]]) {
			const result = runGit(cwd, args, env);
			if (result.status !== 0) throw new Error(result.stderr.trim() || "Worktree snapshot failed");
		}
		return action(env);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function captureWorktreeDiff(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	agent: string,
	patchPath: string,
): WorktreeDiff {
	assertWorktreeOwnership(worktree.ownership, worktree.path, worktree.branch);
	// Preserve the real index and dependency links, including for interrupted/resumable children.
	return withSnapshotIndex(worktree.path, worktree.syntheticPaths, (env) => {
		const checked = (args: string[]): string => {
			const result = runGit(worktree.path, args, env);
			if (result.status !== 0) throw new Error(result.stderr.trim() || "Worktree diff failed");
			return result.stdout;
		};
		const diffStat = checked(["diff", "--cached", ...MACHINE_DIFF_OPTIONS, "--stat", setup.baseCommit]).trim();
		const patch = checked(["diff", "--cached", ...MACHINE_PATCH_OPTIONS, setup.baseCommit]);
		const numstat = checked(["diff", "--cached", ...MACHINE_DIFF_OPTIONS, "--numstat", setup.baseCommit]);
		fs.writeFileSync(patchPath, patch, "utf-8");
		if (!patch.trim()) return emptyDiff(worktree.index, agent, worktree.branch, patchPath);
		checked([...PATCH_VALIDATION_OPTIONS, patchPath]);
		return { index: worktree.index, agent, branch: worktree.branch, diffStat, ...parseNumstat(numstat), patchPath };
	});
}

function writeEmptyPatch(patchPath: string): void {
	try {
		fs.writeFileSync(patchPath, "", "utf-8");
	} catch {
		// Diff artifact writing is best-effort in error paths.
	}
}

function handoffRecordsPatch(manifestPath: string | undefined, patchPath: string): boolean {
	if (!manifestPath || !fs.existsSync(manifestPath)) return false;
	try {
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
			version?: unknown;
			groups?: Array<{ children?: Array<{ patch?: { path?: unknown; error?: unknown } }> }>;
		};
		if (manifest.version !== 1 || !Array.isArray(manifest.groups)) return false;
		const resolvedPatchPath = path.resolve(patchPath);
		return manifest.groups.some((group) => Array.isArray(group.children) && group.children.some((child) =>
			child.patch?.error === undefined
			&& typeof child.patch?.path === "string"
			&& path.resolve(child.patch.path) === resolvedPatchPath,
		));
	} catch {
		return false;
	}
}

function cleanupSingleWorktree(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	intent: WorktreeCleanupIntent,
): WorktreeCleanupTask {
	const errors: string[] = [];
	let worktreeRemoved = false;
	let branchRemoved = false;
	if (intent.kind === "preserve" && intent.cleanupBlocker) {
		return {
			index: worktree.index,
			path: worktree.path,
			branch: worktree.branch,
			...(worktree.provider ? { provider: worktree.provider } : {}),
			...(worktree.naming ? { naming: worktree.naming } : {}),
			worktreeRemoved: false,
			branchRemoved: false,
			preserved: true,
			reason: intent.cleanupBlocker,
		};
	}
	if (intent.kind !== "setup-rollback") {
		try {
			if (intent.kind !== "discard") removeSyntheticPathsBeforeDiff(worktree);
		} catch (error) {
			errors.push(`synthetic path cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const status = runGit(worktree.path, ["status", "--porcelain"]);
		const baseDiff = runGit(worktree.path, ["diff", "--quiet", ...MACHINE_DIFF_OPTIONS, setup.baseCommit, "--"]);
		if (status.status !== 0 || (baseDiff.status !== 0 && baseDiff.status !== 1)) {
			const reason = status.status !== 0
				? status.stderr.trim() || status.stdout.trim() || "git status failed"
				: baseDiff.stderr.trim() || baseDiff.stdout.trim() || "git diff check failed";
			return {
				index: worktree.index,
				path: worktree.path,
				branch: worktree.branch,
				...(worktree.provider ? { provider: worktree.provider } : {}),
				...(worktree.naming ? { naming: worktree.naming } : {}),
				worktreeRemoved: false,
				branchRemoved: false,
				preserved: true,
				reason: "cleanup safety check failed",
				errors: [...errors, `cleanup refused: ${reason}`],
			};
		}
		const hasWork = status.stdout.trim().length > 0 || baseDiff.status === 1;
		if (hasWork && intent.kind === "preserve") {
			const captured = (intent.capturedDiffs ?? setup.capturedDiffs)?.find((diff) => diff.index === worktree.index);
			let patchValidationError: string | undefined;
			let patchCaptured = false;
			if (captured !== undefined
				&& captured.error === undefined
				&& fs.existsSync(captured.patchPath)
				&& handoffRecordsPatch(intent.handoffManifestPath, captured.patchPath)) {
				try {
					if (fs.statSync(captured.patchPath).size > 0) {
						patchValidationError = validateWorktreePatchRepresentsCurrentWorktree(worktree.path, setup.baseCommit, captured.patchPath);
						patchCaptured = patchValidationError === undefined;
					}
				} catch (error) {
					patchValidationError = error instanceof Error ? error.message : String(error);
				}
			}
			if (!patchCaptured) {
				const reason = patchValidationError
					? `captured handoff patch failed validation: ${patchValidationError}`
					: "worktree contains changes that are not represented by a captured handoff patch";
				return {
					index: worktree.index,
					path: worktree.path,
					branch: worktree.branch,
					...(worktree.provider ? { provider: worktree.provider } : {}),
					...(worktree.naming ? { naming: worktree.naming } : {}),
					worktreeRemoved: false,
					branchRemoved: false,
					preserved: true,
					reason,
					errors: [...errors, `cleanup refused: ${reason}; preserved ${worktree.path}`],
				};
			}
		}
		if (hasWork && intent.kind === "discard") {
			const decision = resolveAuthorityDecision({ action: "discardWorktree", policy: intent.authorization.policy });
			const authorized = decision === "auto" || (decision === "confirm" && intent.authorization.kind === "confirmed");
			if (!authorized) {
				const reason = decision === "forbid"
					? "authority policy forbids worktree discard"
					: "worktree discard requires explicit user confirmation";
				return {
					index: worktree.index,
					path: worktree.path,
					branch: worktree.branch,
					...(worktree.provider ? { provider: worktree.provider } : {}),
					...(worktree.naming ? { naming: worktree.naming } : {}),
					worktreeRemoved: false,
					branchRemoved: false,
					preserved: true,
					reason,
					errors: [...errors, `cleanup refused: ${reason}; preserved ${worktree.path}`],
				};
			}
		}
	}
	let reviewedHead: string | undefined;
	try {
		assertManagedWorktree(worktree);
		reviewedHead = runGitChecked(worktree.path, ["rev-parse", "HEAD"]).trim();
		runGitChecked(setup.cwd, ["worktree", "remove", "--force", worktree.path]);
		worktreeRemoved = true;
	} catch (error) {
		errors.push(`worktree removal failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (worktreeRemoved) {
		try {
			const record = JSON.parse(fs.readFileSync(worktree.ownership!.recordPath, "utf8"));
			if (record.token !== worktree.ownership!.token) throw new Error("Worktree ownership changed during removal");
			const listed = runGitChecked(setup.cwd, ["worktree", "list", "--porcelain"]);
			if (listed.split("\n").includes(`branch refs/heads/${worktree.branch}`)) throw new Error("Branch is checked out in another worktree");
			runGitChecked(setup.cwd, ["update-ref", "-d", `refs/heads/${worktree.branch}`, reviewedHead!]);
			branchRemoved = true;
		} catch (error) {
			errors.push(`branch removal failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		index: worktree.index,
		path: worktree.path,
		branch: worktree.branch,
		...(worktree.provider ? { provider: worktree.provider } : {}),
		...(worktree.naming ? { naming: worktree.naming } : {}),
		worktreeRemoved,
		branchRemoved,
		...(errors.length ? { errors } : {}),
	};
}

function hasWorktreeChanges(diff: WorktreeDiff): boolean {
	return diff.filesChanged > 0 || diff.insertions > 0 || diff.deletions > 0 || diff.diffStat.trim().length > 0;
}

async function compensateSetup(tx: SetupTransaction): Promise<WorktreeCleanupReport> {
	// A failed/cancelled allocator never removes a path or branch: another process
	// may still be settling, and failed Git allocation can leave partial evidence.
	const report: WorktreeCleanupReport = {
		state: "partial", pruned: false,
		tasks: tx.progress.attempts.filter((attempt) => attempt.path !== undefined).map((attempt) => ({
			index: attempt.index, path: attempt.path!, branch: attempt.branch, provider: "native",
			worktreeRemoved: false, branchRemoved: false, preserved: true,
			reason: "Setup did not complete; inspect the reservation and Git registration before explicit cleanup.",
		})),
		...(tx.progress.unknown ? { errors: [tx.progress.unknown] } : {}),
	};
	tx.progress.cleanup = report;
	tx.progress.phase = "retained";
	return report;
}

async function allocateWorktrees(tx: SetupTransaction, cwd: string, runId: string, count: number): Promise<WorktreeSetup> {
	const options = tx.options;
	tx.check();
	assertNativeWorktreeProvider(options.provider);
	if (!options.writerIdentity?.rootSessionId || !options.writerIdentity.runId) throw new Error("Worktree allocation requires a root session and run identity.");
	if (options.setupHook !== undefined) throw new Error("Worktree setup hooks remain deferred.");
	if (!Number.isSafeInteger(count) || count < 0) throw new Error("worktree count must be a non-negative integer");
	const repo = await resolveRepoState(tx, cwd, options?.baseRef);
	tx.progress.setup.cwd = repo.toplevel;
	tx.progress.setup.baseCommit = repo.baseCommit;
	const setupHook = resolveWorktreeSetupHook(repo.toplevel, options?.setupHook);
	const branchPrefix = normalizeWorktreeBranchPrefix(options?.branchPrefix);
	const dedicatedRoot = resolveWorktreeDedicatedRoot(options?.baseDir, repo.toplevel);
	const worktrees = tx.progress.setup.worktrees;

	try {
		for (let index = 0; index < count; index++) {
			worktrees[index] = await createNativeWorktree(tx, repo.toplevel, repo.cwdRelative, runId, index, repo.baseCommit,
				setupHook, options?.agents?.[index], dedicatedRoot, options?.labels, options?.tasks, branchPrefix);
		}
		tx.check();
		tx.progress.phase = "ready";
		tx.publish();
		tx.check();
		return tx.progress.setup;
	} catch (error) {
		await compensateSetup(tx);
		throw error;
	}
}

export async function createWorktrees(cwd: string, runId: string, count: number, options: CreateWorktreesOptions = {}): Promise<WorktreeSetup> {
	const tx = new SetupTransaction(cwd, options);
	try {
		return await withWorktreeTransaction(async () => {
			setupActive = true;
			try { return await allocateWorktrees(tx, cwd, runId, count); }
			finally { setupActive = false; }
		}, options);
	} catch (error) {
		if (setupPoison) tx.progress.unknown ??= setupPoison;
		tx.progress.cleanup ??= { state: tx.progress.unknown ? "partial" : "complete", tasks: [], pruned: false, errors: tx.progress.unknown ? [tx.progress.unknown] : [] };
		try { tx.publish(); } catch (publicationError) {
			tx.progress.cleanup?.errors?.push(`Recovery publication failed: ${String(publicationError)}`);
		}
		throw new WorktreeSetupError(error, tx.snapshot());
	}
}

export function diffWorktrees(setup: WorktreeSetup, agents: string[], diffsDir: string): WorktreeDiff[] {
	assertWorktreeMutationAllowed();
	try {
		fs.mkdirSync(diffsDir, { recursive: true });
	} catch {
		// Returning no diffs is safer than failing the whole command on artifact-dir issues.
		return [];
	}

	const diffs: WorktreeDiff[] = [];
	for (let index = 0; index < setup.worktrees.length; index++) {
		const worktree = setup.worktrees[index]!;
		const agent = agents[index] ?? `task-${index + 1}`;
		const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
		try {
			diffs.push(captureWorktreeDiff(setup, worktree, agent, patchPath));
		} catch (error) {
			// Preserve execution flow while retaining the failed capture as handoff evidence.
			writeEmptyPatch(patchPath);
			diffs.push(emptyDiff(index, agent, worktree.branch, patchPath, error instanceof Error ? error.message : String(error)));
		}
	}

	setup.capturedDiffs = diffs;
	return diffs;
}

export function cleanupWorktrees(
	setup: WorktreeSetup,
	intent: WorktreeCleanupIntent = { kind: "preserve", ...(setup.capturedDiffs ? { capturedDiffs: setup.capturedDiffs } : {}) },
): WorktreeCleanupReport {
	assertWorktreeMutationAllowed();
	if (intent.kind === "preserve") return {
		state: "partial", pruned: false,
		tasks: setup.worktrees.map((worktree) => ({ ownership: worktree.ownership, index: worktree.index, path: worktree.path, branch: worktree.branch, provider: worktree.provider, naming: worktree.naming,
			worktreeRemoved: false, branchRemoved: false, preserved: true, reason: intent.cleanupBlocker ?? "Retained for review and integration; cleanup requires explicit operator action." })),
	};
	if (intent.kind !== "discard") throw new Error("Automatic worktree removal is excluded; use explicit discard.");
	const decision = resolveAuthorityDecision({ action: "discardWorktree", policy: intent.authorization.policy });
	if (decision === "forbid" || (decision === "confirm" && intent.authorization.kind !== "confirmed")) throw new Error("Worktree discard requires operator authorization");
	for (const worktree of setup.worktrees) {
		if (!worktree.ownership || !managedMutationLeases.has(worktree.ownership.token)) throw new Error("Worktree discard requires an owned writer lease");
		assertManagedWorktree(worktree);
		if (normalizeComparableCwd(worktree.path) === normalizeComparableCwd(setup.cwd)) throw new Error("Refusing source-checkout removal");
	}
	const tasks = [...setup.worktrees].reverse().map((worktree) => ({ ...cleanupSingleWorktree(setup, worktree, intent), ownership: worktree.ownership })).sort((a, b) => a.index - b.index);
	// Removing an exact registration never authorizes pruning unrelated worktrees.
	return { state: tasks.every((task) => task.worktreeRemoved && task.branchRemoved) ? "complete" : "partial", tasks, pruned: false };
}

export function formatWorktreeDiffSummary(diffs: WorktreeDiff[]): string {
	const changed = diffs.filter(hasWorktreeChanges);
	if (changed.length === 0) return "";

	const lines: string[] = ["=== Worktree Changes ===", ""];
	for (const diff of changed) {
		lines.push(
			`--- Task ${diff.index + 1} (${diff.agent}): ${diff.filesChanged} files changed, +${diff.insertions} -${diff.deletions} ---`,
		);
		if (diff.diffStat.trim().length > 0) {
			lines.push(diff.diffStat);
		}
		lines.push("");
	}

	const patchesDir = path.dirname(changed[0]!.patchPath);
	lines.push(`Full patches: ${patchesDir}`);
	return lines.join("\n").trimEnd();
}
