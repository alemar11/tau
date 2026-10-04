import * as path from "node:path";
import { HerdrJsonLineDecoder } from "./herdr-wire.ts";

export const HERDR_PI_PROTOCOL = 1;
export const HERDR_PI_MAX_FRAME_BYTES = 1024 * 1024;
export const HERDR_PI_MODE_ENV = "TAU_SUBAGENTS_HERDR_BRIDGE";
export const HERDR_PI_RUN_ENV = "TAU_SUBAGENTS_HERDR_RUN_ID";
export const HERDR_PI_RUNTIME_DIR_ENV = "TAU_SUBAGENTS_HERDR_RUNTIME_DIR";
const SAFE_ID = /^[A-Za-z0-9_-]{8,96}$/u;

export function validateHerdrPiRunId(value: unknown): string {
	if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error("Herdr Pi bridge run identity is invalid.");
	return value;
}

export function herdrPiRuntimeRoot(agentDir: string): string {
	return path.join(agentDir, "tau-subagents", "herdr-runs");
}

export function herdrPiRunDir(agentDir: string, runId: string): string {
	return path.join(herdrPiRuntimeRoot(agentDir), validateHerdrPiRunId(runId));
}

export interface HerdrPiFrame {
	protocol: number;
	runId: string;
	type: string;
	requestId?: string;
	[key: string]: unknown;
}

function validateFrame(frame: Record<string, unknown>): HerdrPiFrame {
	if (frame.protocol !== HERDR_PI_PROTOCOL || typeof frame.type !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(frame.type)) throw new Error("Herdr Pi bridge protocol mismatch.");
	validateHerdrPiRunId(frame.runId);
	if (frame.requestId !== undefined && (typeof frame.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(frame.requestId))) throw new Error("Herdr Pi bridge request identity is invalid.");
	return frame as HerdrPiFrame;
}

export function encodeHerdrPiFrame(frame: HerdrPiFrame): Buffer {
	validateFrame(frame);
	const data = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
	if (data.byteLength > HERDR_PI_MAX_FRAME_BYTES) throw new Error(`Herdr Pi frame exceeds ${HERDR_PI_MAX_FRAME_BYTES} bytes.`);
	return data;
}

export class HerdrPiFrameDecoder {
	readonly #decoder = new HerdrJsonLineDecoder(HERDR_PI_MAX_FRAME_BYTES);
	#failure?: Error;
	push(chunk: Buffer): HerdrPiFrame[] {
		if (this.#failure) throw this.#failure;
		try { return this.#decoder.push(chunk).map(validateFrame); }
		catch (error) { throw this.#failure = error instanceof Error ? error : new Error(String(error)); }
	}
	end(): void {
		if (this.#failure) throw this.#failure;
		this.#decoder.end();
	}
}
