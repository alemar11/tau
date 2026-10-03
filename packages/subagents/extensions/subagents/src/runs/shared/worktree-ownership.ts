import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface WorktreeOwnership {
	recordPath: string;
	token: string;
	device?: number;
	inode?: number;
}
interface OwnerRecord {
	version: 1;
	token: string;
	rootSessionId: string;
	runId: string;
	branch: string;
	worktreePath: string;
	createdAt: number;
	ownerRunId?: string;
	agentCwd?: string;
	writerStorageRoot?: string;
	device?: number;
	inode?: number;
}

function save(recordPath: string, record: OwnerRecord): void {
	const temporary = `${recordPath}.${randomUUID()}.tmp`;
	const fd = fs.openSync(temporary, "wx", 0o600);
	try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
	finally { fs.closeSync(fd); }
	fs.renameSync(temporary, recordPath);
}

/** Shared Git metadata coordinates even launchers with different temporary roots.
 * Incomplete reservations stay blocking: no age/PID reclamation or automatic replay. */
export function reserveWorktree(commonDir: string, input: Omit<OwnerRecord, "version" | "token" | "createdAt">): WorktreeOwnership {
	const root = path.join(fs.realpathSync(commonDir), "tau-subagents", "worktree-owners-v1");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const dir = path.join(root, createHash("sha256").update(input.branch).digest("hex"));
	try { fs.mkdirSync(dir, { mode: 0o700 }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Worktree branch already reserved; manual reconciliation required: ${input.branch} (${dir})`);
		throw error;
	}
	const ownership = { recordPath: path.join(dir, "owner.json"), token: randomUUID() };
	save(ownership.recordPath, { ...input, version: 1, token: ownership.token, createdAt: Date.now() });
	return ownership;
}

function read(ownership: WorktreeOwnership, worktreePath: string, branch: string): OwnerRecord {
	const stat = fs.lstatSync(ownership.recordPath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error(`Invalid worktree ownership record: ${ownership.recordPath}`);
	const record = JSON.parse(fs.readFileSync(ownership.recordPath, "utf8")) as OwnerRecord;
	if (!record || record.version !== 1 || record.token !== ownership.token || record.branch !== branch
		|| record.worktreePath !== worktreePath || typeof record.rootSessionId !== "string" || !record.rootSessionId || typeof record.runId !== "string" || !record.runId) {
		throw new Error(`Worktree ownership mismatch; retained for reconciliation: ${worktreePath}`);
	}
	return record;
}

export function finishWorktreeReservation(ownership: WorktreeOwnership, worktreePath: string, branch: string): WorktreeOwnership {
	const record = read(ownership, worktreePath, branch);
	const stat = fs.lstatSync(worktreePath);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid managed worktree directory: ${worktreePath}`);
	const identity = { device: stat.dev, inode: stat.ino };
	save(ownership.recordPath, { ...record, ...identity });
	return { ...ownership, ...identity };
}

export function assertWorktreeOwnership(ownership: WorktreeOwnership | undefined, worktreePath: string, branch: string): OwnerRecord {
	if (!ownership) throw new Error(`Missing managed worktree ownership: ${worktreePath}`);
	const record = read(ownership, worktreePath, branch);
	const stat = fs.lstatSync(worktreePath);
	if (!stat.isDirectory() || stat.isSymbolicLink() || record.device !== stat.dev || record.inode !== stat.ino
		|| ownership.device !== stat.dev || ownership.inode !== stat.ino) {
		throw new Error(`Managed worktree directory was replaced; refusing finalization: ${worktreePath}`);
	}
	return record;
}

/** Cleanup must use the creator's coordination namespace, never the caller's new session. */
export function worktreeWriterScope(ownership: WorktreeOwnership | undefined, worktreePath: string, branch: string) {
	const record = assertWorktreeOwnership(ownership, worktreePath, branch);
	if (!record.ownerRunId || !record.agentCwd || !path.isAbsolute(record.agentCwd) || !record.writerStorageRoot || !path.isAbsolute(record.writerStorageRoot)) {
		throw new Error(`Managed worktree has no durable writer scope; manual reconciliation required: ${worktreePath}`);
	}
	const relative = path.relative(fs.realpathSync(worktreePath), fs.realpathSync(record.agentCwd));
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Managed writer cwd escaped its worktree");
	return { rootSessionId: record.rootSessionId, ownerRunId: record.ownerRunId, cwd: record.agentCwd, storageRoot: record.writerStorageRoot };
}
