import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details } from "../shared/types.ts";

export function bindingExists(file: string): boolean {
	try { fs.lstatSync(file); return true; } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export function readInspectorBinding(file: string): unknown {
	const directory = fs.lstatSync(path.dirname(file));
	const stat = fs.lstatSync(file);
	if (!directory.isDirectory() || directory.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
		throw new Error("Inspector binding must be a bounded regular file in a non-symlink directory.");
	}
	const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		if (!fs.fstatSync(descriptor).isFile()) throw new Error("Inspector binding is not a regular file.");
		const bytes = Buffer.alloc(64 * 1024 + 1);
		let length = 0;
		while (length < bytes.length) {
			const read = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
			if (!read) break;
			length += read;
		}
		if (length > 64 * 1024) throw new Error("Inspector binding exceeded its byte limit.");
		return JSON.parse(bytes.toString("utf8", 0, length));
	} finally { fs.closeSync(descriptor); }
}

/** Serialize mutations; a crashed operation remains blocked for manual reconciliation. */
export async function withInspectorBindingLock(file: string, operation: (assertCurrent: () => void) => Promise<AgentToolResult<Details>>): Promise<AgentToolResult<Details>> {
	const fail = (text: string): AgentToolResult<Details> => ({ content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } });
	const directory = path.dirname(file), root = path.dirname(directory), lock = `${file}.lock`;
	const owner = path.join(lock, "owner.json"), token = randomUUID();
	let rootStat: fs.Stats, directoryStat: fs.Stats, lockStat: fs.Stats;
	try {
		rootStat = fs.lstatSync(root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Inspector run directory is not a regular directory.");
		try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		directoryStat = fs.lstatSync(directory);
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Inspector binding directory is not a regular directory.");
		fs.mkdirSync(lock, { mode: 0o700 });
		fs.writeFileSync(owner, JSON.stringify({ token }), { mode: 0o600, flag: "wx" });
		lockStat = fs.lstatSync(lock);
	} catch (error) {
		return fail(`Inspector operation blocked: ${error instanceof Error ? error.message : String(error)}. Reconcile existing bindings and operations before retrying.`);
	}
	const assertCurrent = () => {
		const currentRoot = fs.lstatSync(root), currentDirectory = fs.lstatSync(directory), currentLock = fs.lstatSync(lock);
		if (currentRoot.isSymbolicLink() || currentDirectory.isSymbolicLink() || currentLock.isSymbolicLink()
			|| currentDirectory.dev !== directoryStat.dev || currentDirectory.ino !== directoryStat.ino
			|| currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino
			|| currentLock.dev !== lockStat.dev || currentLock.ino !== lockStat.ino
			|| (readInspectorBinding(owner) as { token?: string } | null)?.token !== token) throw new Error("Inspector operation ownership changed.");
	};
	let outcome: AgentToolResult<Details>;
	try { assertCurrent(); outcome = await operation(assertCurrent); } catch (error) {
		outcome = fail(`Inspector operation failed: ${error instanceof Error ? error.message : String(error)}. Any created terminal and binding are retained; reconcile before retrying.`);
	}
	try { assertCurrent(); fs.unlinkSync(owner); fs.rmdirSync(lock); } catch {
		return { ...outcome, isError: true, content: [...outcome.content, { type: "text", text: "Inspector operation ownership/release is uncertain. Retain evidence and reconcile manually; no foreign lock was removed." }] };
	}
	return outcome;
}
