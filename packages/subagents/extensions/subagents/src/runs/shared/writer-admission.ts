import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";
import type { ChildSession, ChildSessionFactory, ChildSessionLaunch } from "./child-session.ts";

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "web_search", "fetch_web_content", "get_cached_web_content", "contact_supervisor", "structured_output", "subagent", "subagent_supervisor", "bg_wait", "wait"]);
export const MAX_QUEUED_WRITERS = 64;
export function isWriter(tools: readonly string[] | undefined, unknownExtensions = false): boolean {
	return unknownExtensions || tools === undefined || tools.some((tool) => !READ_TOOLS.has(tool));
}
export interface WriterIdentity {
	rootSessionId: string;
	runId: string;
	ancestors: string[];
}
interface Ticket { token: string; runId: string; pid: number; enqueuedAt: number }
interface Queue { version: 1; cwd: string; rootSessionId: string; owner?: Ticket; waiting: Ticket[] }
function validTicket(value: unknown): value is Ticket {
	if (!value || typeof value !== "object") return false;
	const ticket = value as Ticket;
	return typeof ticket.token === "string" && ticket.token.length > 0 && typeof ticket.runId === "string" && ticket.runId.length > 0
		&& Number.isSafeInteger(ticket.pid) && ticket.pid > 0 && Number.isFinite(ticket.enqueuedAt) && ticket.enqueuedAt > 0;
}
export interface AdmissionOptions extends WriterIdentity {
	cwd: string;
	signal?: AbortSignal;
	deadlineAt?: number;
	storageRoot?: string;
	onWait?: (owner: string | undefined, position: number) => void;
}
function check(options: AdmissionOptions): void {
	options.signal?.throwIfAborted();
	if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) throw new Error("Writer admission deadline expired; no child was launched.");
}

/** Atomic transactions have no age/PID reclamation. A crashed transaction or writer blocks,
 * rather than allowing another process to guess that the workspace is safe. */
export async function admitWriter(options: AdmissionOptions): Promise<{ release(): Promise<void>; token: string }> {
	check(options);
	if (!options.rootSessionId || !options.runId) throw new Error("Writer admission requires a root session and run identity.");
	const cwd = fs.realpathSync(options.cwd);
	const key = createHash("sha256").update(JSON.stringify([options.rootSessionId, cwd])).digest("hex");
	const dir = path.join(options.storageRoot ?? path.join(TEMP_ROOT_DIR, "writer-admission-v1"), key);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const statePath = path.join(dir, "queue.json");
	const lock = path.join(dir, "transaction");
	const ticket: Ticket = { token: randomUUID(), runId: options.runId, pid: process.pid, enqueuedAt: Date.now() };
	async function transaction<T>(update: (queue: Queue) => T, cleanup = false): Promise<T> {
		const cleanupDeadline = Date.now() + 2000;
		for (;;) {
			if (!cleanup) check(options);
			try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (cleanup && Date.now() > cleanupDeadline) throw new Error(`Writer transaction is uncertain: ${lock}`);
				await delay(25);
			}
		}
		try {
			const queue: Queue = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { version: 1, cwd, rootSessionId: options.rootSessionId, waiting: [] };
			if (!queue || queue.version !== 1 || queue.cwd !== cwd || queue.rootSessionId !== options.rootSessionId || !Array.isArray(queue.waiting)
				|| queue.waiting.length > MAX_QUEUED_WRITERS || queue.waiting.some((item) => !validTicket(item))
				|| (queue.owner !== undefined && !validTicket(queue.owner))) {
				throw new Error(`Writer admission state is invalid; refusing to reclaim: ${statePath}`);
			}
			const before = JSON.stringify(queue);
			const result = update(queue);
			const after = JSON.stringify(queue);
			// Polling and stale cleanup need a consistent read, not an fsync per waiter.
			if (after === before) return result;
			const temp = path.join(dir, `${randomUUID()}.tmp`);
			const fd = fs.openSync(temp, "wx", 0o600);
			try { fs.writeFileSync(fd, after); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			fs.renameSync(temp, statePath);
			return result;
		} finally { fs.rmdirSync(lock); }
	}
	await transaction((queue) => {
		if (queue.owner && options.ancestors.includes(queue.owner.runId)) throw new Error(`Descendant writer conflicts with ancestor ${queue.owner.runId} in ${cwd}; delegation would deadlock.`);
		if (queue.waiting.length >= MAX_QUEUED_WRITERS) throw new Error(`Writer queue limit (${MAX_QUEUED_WRITERS}) reached.`);
		queue.waiting.push(ticket);
	});
	let admitted = false;
	try {
		while (!admitted) {
			check(options);
			let waiting: { owner?: string; position: number } | undefined;
			admitted = await transaction((queue) => {
				if (queue.owner && options.ancestors.includes(queue.owner.runId)) throw new Error(`Descendant writer conflicts with ancestor ${queue.owner.runId}; delegation would deadlock.`);
				const index = queue.waiting.findIndex((item) => item.token === ticket.token);
				if (index < 0) throw new Error("Writer ticket disappeared; refusing launch.");
				if (!queue.owner && index === 0) { queue.owner = queue.waiting.shift(); return true; }
				waiting = { owner: queue.owner?.runId, position: index + 1 };
				return false;
			});
			if (waiting) options.onWait?.(waiting.owner, waiting.position);
			if (!admitted) await delay(50, undefined, { signal: options.signal });
		}
		check(options);
	} catch (error) {
		await transaction((queue) => {
			queue.waiting = queue.waiting.filter((item) => item.token !== ticket.token);
			if (queue.owner?.token === ticket.token) delete queue.owner;
		}, true).catch(() => { /* Keep uncertain ownership; never reclaim optimistically. */ });
		throw error;
	}
	return {
		token: ticket.token,
		async release() {
			await transaction((queue) => { if (queue.owner?.token === ticket.token) delete queue.owner; }, true);
		},
	};
}

/** Holds admission beyond dispatch, abort requests and bounded SDK dispose. Only a
 * settled prompt plus observed tool completion may release a live writer. */
export function withWriterAdmission(factory: ChildSessionFactory): ChildSessionFactory {
	return {
		dispose: () => factory.dispose(),
		async create(launch: ChildSessionLaunch): Promise<ChildSession> {
			const identity = launch.runtime.writerIdentity;
			if (!identity) throw new Error("Missing Tau coordination identity.");
			const lease = launch.runtime.workspaceWriter !== false ? await admitWriter({ ...identity, cwd: launch.cwd, signal: launch.admissionSignal, deadlineAt: launch.deadlineAt, onWait: launch.onWriterWait }) : undefined;
			let child: ChildSession;
			try {
				launch.admissionSignal?.throwIfAborted();
				if (launch.deadlineAt !== undefined && Date.now() >= launch.deadlineAt) throw new Error("Child launch deadline expired.");
				launch.onAdmitted?.();
				child = await factory.create(launch);
			} catch (error) { await lease?.release(); throw error; }
			if (!lease) {
				const prompt = child.prompt.bind(child);
				child.prompt = async (text) => {
					launch.admissionSignal?.throwIfAborted();
					if (launch.deadlineAt !== undefined && Date.now() >= launch.deadlineAt) throw new Error("Child deadline expired before prompt.");
					await prompt(text);
				};
				return child;
			}
			let active = 0;
			let disposed = false;
			let released = false;
			let finalized = !launch.onWriterFinalizer;
			const tools = new Set<string>();
			const release = async () => {
				if (!disposed || !finalized || active > 0 || tools.size > 0 || released) return;
				await lease?.release();
				released = true;
				unsubscribe();
			};
			const unsubscribe = child.subscribe((event) => {
				if (event.type === "tool_execution_start") tools.add(String(event.toolCallId));
				if (event.type === "tool_execution_end") { tools.delete(String(event.toolCallId)); void release().catch(() => {}); }
			});
			launch.onWriterFinalizer?.(async () => { finalized = true; await release(); });
			const prompt = child.prompt.bind(child);
			const dispose = child.dispose.bind(child);
			child.prompt = async (text) => {
				if (disposed) throw new Error("Child already disposed.");
				launch.admissionSignal?.throwIfAborted();
				if (launch.deadlineAt !== undefined && Date.now() >= launch.deadlineAt) throw new Error("Child deadline expired before prompt.");
				active++;
				try { await prompt(text); } finally { active--; await release(); }
			};
			child.dispose = async () => { await dispose(); disposed = true; await release(); };
			return child;
		},
	};
}
