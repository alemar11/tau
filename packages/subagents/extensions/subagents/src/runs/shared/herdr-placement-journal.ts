import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { HerdrMachineReference } from "../../shared/types.ts";
import { getAgentDir } from "../../shared/utils.ts";
import { validateHerdrPiRunId } from "./herdr-pi-protocol.ts";

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_RECORDS = 128;

export function assertHerdrPrivateDirectory(directory: string): fs.Stats {
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
		|| (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
		throw new Error("Herdr state path is not a mode-0700 agent-private owned directory.");
	}
	return stat;
}

/** No age/PID reclamation: these directories can refer to still-running remote effects. */
export function herdrPrivateDirectory(name: "herdr-allocation-locks" | "herdr-run-journal", agentDir = getAgentDir()): string {
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	assertHerdrPrivateDirectory(agentDir);
	let directory = agentDir;
	for (const component of ["tau-subagents", name]) {
		directory = path.join(directory, component);
		try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		assertHerdrPrivateDirectory(directory);
	}
	return directory;
}

export function syncHerdrDirectory(directory: string): void {
	const fd = fs.openSync(directory, fs.constants.O_RDONLY);
	try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Append-only intent/receipt evidence. A partial record or existing run blocks reuse. */
export class HerdrPlacementJournal {
	readonly directory: string;
	readonly storageRoot: string;
	readonly #runId: string;
	readonly #machine: HerdrMachineReference;
	readonly #token = randomUUID();
	readonly #generations: Array<{ directory: string; dev: number; ino: number }>;
	#next = 0;
	#failed = false;

	constructor(machine: HerdrMachineReference, runId: string) {
		this.#runId = validateHerdrPiRunId(runId);
		this.#machine = { ...machine };
		this.storageRoot = path.resolve(getAgentDir());
		const root = herdrPrivateDirectory("herdr-run-journal", this.storageRoot);
		try {
			fs.lstatSync(path.join(root, `${runId}.json`));
			throw new Error("Existing Herdr placement journal requires manual reconciliation.");
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		this.directory = path.join(root, runId);
		fs.mkdirSync(this.directory, { mode: 0o700 });
		this.#generations = [this.storageRoot, path.dirname(root), root, this.directory].map((directory) => {
			const { dev, ino } = assertHerdrPrivateDirectory(directory);
			return { directory, dev, ino };
		});
		syncHerdrDirectory(root);
		this.append("runtime-intent");
	}

	assertCurrent(): void {
		if (this.#failed) throw new Error(`Herdr placement journal is uncertain: ${this.directory}`);
		for (const expected of this.#generations) {
			const current = assertHerdrPrivateDirectory(expected.directory);
			if (current.dev !== expected.dev || current.ino !== expected.ino) {
				throw new Error(`Herdr placement journal ownership changed: ${this.directory}`);
			}
		}
	}

	append(phase: string, details: Record<string, unknown> = {}): void {
		try {
			this.assertCurrent();
			if (this.#next >= MAX_RECORDS) throw new Error("Herdr placement journal record limit exceeded.");
			const content = JSON.stringify({ version: 2, runId: this.#runId, machine: this.#machine,
				token: this.#token, sequence: this.#next, at: new Date().toISOString(), phase, details });
			if (Buffer.byteLength(content) > MAX_RECORD_BYTES) throw new Error("Herdr placement journal byte limit exceeded.");
			const file = path.join(this.directory, `${String(this.#next).padStart(3, "0")}.json`);
			const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
			try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			syncHerdrDirectory(this.directory);
			this.#next++;
		} catch (error) {
			this.#failed = true;
			throw new Error(`Could not persist Herdr placement ${phase}; retain evidence at ${this.directory}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}
}
