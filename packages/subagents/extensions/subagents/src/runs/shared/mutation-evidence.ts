import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as os from "node:os";
import { gitEnvironment } from "./worktree.ts";
import type { ArtifactPaths, TimeoutRecoveryProjection, TimeoutRecoverySummary, TrackedMutationEvidence, TrackedMutationFingerprint, TrackedMutationSnapshot } from "../../shared/types.ts";

const MAX_TRACKED_PATHS = 500;
const MAX_HASH_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const EVIDENCE_BUDGET_MS = 5000;
const MAX_TIMEOUT_FILES = 20;

function gitArguments(args: string[]): string[] {
	// Mutation evidence must not block child startup on a stale fsmonitor daemon.
	return ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`, ...args];
}

function gitOutput(cwd: string, args: string[], maxBuffer: number, deadlineAt: number): string {
	const timeout = deadlineAt - Date.now();
	if (timeout <= 0) throw new Error("Git mutation evidence exceeded its time budget");
	return execFileSync("git", gitArguments(args), { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer, windowsHide: true, timeout, killSignal: "SIGKILL", env: gitEnvironment() });
}

function splitNul(output: string): string[] {
	return output.split("\0").filter((part) => part.length > 0);
}

function listChangedTrackedFiles(cwd: string, baseCommit: string, deadlineAt: number): { paths: string[]; truncated: boolean } {
	const paths = splitNul(gitOutput(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", baseCommit, "--"], MAX_HASH_BYTES, deadlineAt));
	return { paths: paths.slice(0, MAX_TRACKED_PATHS), truncated: paths.length > MAX_TRACKED_PATHS };
}

function fingerprintPath(cwd: string, relativePath: string, baseCommit: string, deadlineAt: number): TrackedMutationFingerprint {
	const diff = gitOutput(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--binary", baseCommit, "--", relativePath], MAX_DIFF_BYTES, deadlineAt);
	return { kind: "diff", digest: createHash("sha256").update(diff).digest("hex") };
}

function sameFingerprint(left: TrackedMutationFingerprint | undefined, right: TrackedMutationFingerprint): boolean {
	if (!left || left.kind !== "diff" || right.kind !== "diff") return false;
	return left.digest === right.digest;
}

export function snapshotTrackedMutations(cwd: string): TrackedMutationSnapshot {
	try {
		const deadlineAt = Date.now() + EVIDENCE_BUDGET_MS;
		const gitRoot = gitOutput(cwd, ["rev-parse", "--show-toplevel"], MAX_HASH_BYTES, deadlineAt).trim();
		const baseCommit = gitOutput(gitRoot, ["rev-parse", "HEAD"], MAX_HASH_BYTES, deadlineAt).trim();
		const changed = listChangedTrackedFiles(gitRoot, baseCommit, deadlineAt);
		const fingerprints: Record<string, TrackedMutationFingerprint> = {};
		for (const file of changed.paths) fingerprints[file] = fingerprintPath(gitRoot, file, baseCommit, deadlineAt);
		return { source: "tracked-files", trackedOnly: true, cwd, gitRoot, baseCommit, dirtyFiles: changed.paths, fingerprints, truncated: changed.truncated };
	} catch (error) {
		return { source: "tracked-files", trackedOnly: true, cwd, dirtyFiles: [], fingerprints: {}, unavailable: error instanceof Error ? error.message : String(error) };
	}
}

export function collectTrackedMutationEvidence(snapshot: TrackedMutationSnapshot, cwd = snapshot.cwd): TrackedMutationEvidence {
	if (snapshot.unavailable) {
		return { source: "tracked-files", trackedOnly: true, changedFiles: [], attemptedMutation: false, unavailable: snapshot.unavailable };
	}
	try {
		const deadlineAt = Date.now() + EVIDENCE_BUDGET_MS;
		const gitRoot = gitOutput(cwd, ["rev-parse", "--show-toplevel"], MAX_HASH_BYTES, deadlineAt).trim();
		if (snapshot.gitRoot && snapshot.gitRoot !== gitRoot) throw new Error("Git repository changed since admission");
		const baseCommit = snapshot.baseCommit ?? "HEAD";
		const current = listChangedTrackedFiles(gitRoot, baseCommit, deadlineAt);
		const startDirty = new Set(snapshot.dirtyFiles);
		const candidates = new Set([...snapshot.dirtyFiles, ...current.paths]);
		const changedFiles: string[] = [];
		for (const file of candidates) {
			if (!startDirty.has(file)) {
				if (!snapshot.truncated) changedFiles.push(file);
				continue;
			}
			if (!sameFingerprint(snapshot.fingerprints[file], fingerprintPath(gitRoot, file, baseCommit, deadlineAt))) changedFiles.push(file);
		}
		changedFiles.sort();
		return {
			source: "tracked-files",
			trackedOnly: true,
			changedFiles,
			attemptedMutation: changedFiles.length > 0,
			truncated: snapshot.truncated || current.truncated || undefined,
		};
	} catch (error) {
		return { source: "tracked-files", trackedOnly: true, changedFiles: [], attemptedMutation: false, unavailable: error instanceof Error ? error.message : String(error) };
	}
}

function formatPathList(paths: string[]): string {
	if (paths.length === 0) return "none";
	const shown = paths.slice(0, MAX_TIMEOUT_FILES).join(", ");
	return paths.length > MAX_TIMEOUT_FILES ? `${shown}, ... (${paths.length - MAX_TIMEOUT_FILES} more)` : shown;
}

/** Keep status and completion details to bounded routing evidence, not raw output or effects. */
export function projectTimeoutRecovery(value: unknown): TimeoutRecoveryProjection | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const termination = source.termination === "timed-out" || source.termination === "stopped" ? source.termination : undefined;
	if (!termination || !Array.isArray(source.changedFiles)) return undefined;
	const allChangedFiles = source.changedFiles.filter((file): file is string => typeof file === "string");
	const changedFiles = allChangedFiles.slice(0, MAX_TIMEOUT_FILES);
	const reportStatus = source.reportStatus === "missing"
		|| source.reportStatus === "written"
		|| source.reportStatus === "not-requested"
		|| source.reportStatus === "unknown"
		? source.reportStatus
		: undefined;
	return {
		termination,
		changedFiles,
		...(source.truncated === true || allChangedFiles.length > changedFiles.length ? { truncated: true } : {}),
		...(source.recoveryNeeded === true ? { recoveryNeeded: true } : {}),
		...(source.reason === "timed-out-with-dirty-worktree" ? { reason: source.reason } : {}),
		...(reportStatus ? { reportStatus } : {}),
	};
}

/** Render only the bounded recovery route needed by a parent/operator. */
export function formatTimeoutRecoveryLines(value: unknown, indent = ""): string[] {
	const recovery = projectTimeoutRecovery(value);
	if (!recovery?.recoveryNeeded) return [];
	const changedFiles = recovery.changedFiles.length > 0
		? `${recovery.changedFiles.join(", ")}${recovery.truncated ? ", …" : ""}`
		: "none";
	const changedFileCount = recovery.changedFiles.length > 0 ? `${recovery.changedFiles.length}${recovery.truncated ? "+" : ""}` : "0";
	return [
		`${indent}Recovery needed: review the diff and artifacts before resuming or launching dependent stages.`,
		`${indent}Recovery evidence: requested report: ${recovery.reportStatus ?? "unknown"}; changed tracked files: ${changedFiles} (${changedFileCount}); classification: ${recovery.reason ?? recovery.termination}`,
	];
}

export function buildTimeoutRecoverySummary(input: {
	termination: "timed-out" | "stopped";
	evidence: TrackedMutationEvidence;
	requiredOutputMissing?: boolean;
	currentTool?: string;
	currentToolArgs?: string;
	currentPath?: string;
	sessionFile?: string;
	transcriptPath?: string;
	artifactPaths?: ArtifactPaths;
}): TimeoutRecoverySummary {
	const warning = "Inspect partial changes before retrying or resuming the child.";
	const changedFiles = input.evidence.changedFiles.slice(0, MAX_TIMEOUT_FILES);
	let reportStatus: "missing" | "written" | "not-requested" = "not-requested";
	if (input.requiredOutputMissing === true) reportStatus = "missing";
	else if (input.requiredOutputMissing === false) reportStatus = "written";
	const recoveryNeeded = input.termination === "timed-out"
		&& reportStatus === "missing"
		&& input.evidence.changedFiles.length > 0;
	const lines = [
		"Recovery summary:",
		`- termination: ${input.termination}`,
		`- changed tracked files: ${input.evidence.unavailable ? `unavailable (${input.evidence.unavailable})` : formatPathList(input.evidence.changedFiles)}`,
	];
	if (input.requiredOutputMissing !== undefined) lines.push(`- requested report: ${reportStatus}`);
	if (recoveryNeeded) lines.push("- Recovery needed: review the diff and artifacts before resuming or launching dependent stages.");
	if (input.currentTool) lines.push(`- active tool: ${input.currentTool}${input.currentToolArgs ? ` — ${input.currentToolArgs}` : ""}`);
	if (input.currentPath) lines.push(`- active path: ${input.currentPath}`);
	if (input.sessionFile) lines.push(`- session file: ${input.sessionFile}`);
	if (input.transcriptPath) lines.push(`- transcript: ${input.transcriptPath}`);
	if (input.artifactPaths?.outputPath) lines.push(`- output artifact: ${input.artifactPaths.outputPath}`);
	if (input.artifactPaths?.metadataPath) lines.push(`- metadata artifact: ${input.artifactPaths.metadataPath}`);
	lines.push(`Warning: ${warning}`);
	return {
		termination: input.termination,
		changedFiles,
		truncated: input.evidence.changedFiles.length > changedFiles.length || input.evidence.truncated || undefined,
		...(recoveryNeeded ? { recoveryNeeded: true, reason: "timed-out-with-dirty-worktree" as const } : {}),
		reportStatus,
		currentTool: input.currentTool,
		currentToolArgs: input.currentToolArgs,
		currentPath: input.currentPath,
		sessionFile: input.sessionFile,
		transcriptPath: input.transcriptPath,
		artifactPaths: input.artifactPaths,
		warning,
		message: lines.join("\n"),
	};
}
