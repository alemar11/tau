import { randomBytes } from "node:crypto";
import * as net from "node:net";
import { encodeHerdrPiFrame, HERDR_PI_PROTOCOL, HerdrPiFrameDecoder, validateHerdrPiRunId, type HerdrPiFrame } from "./herdr-pi-protocol.ts";

const MAX_REPLAY_BYTES = 8 * 1024 * 1024;
const MAX_REPLAY_FRAMES = 1024;
const MAX_WAITERS = 64;

export interface BridgeChannelOptions {
	deadlineAt?: number;
	signal?: AbortSignal;
	requestTimeoutMs?: number;
}

/** Transport acknowledgements do not attest remote prompt, tool or process settlement. */
export class BridgeChannel {
	readonly socket: net.Socket;
	readonly decoder = new HerdrPiFrameDecoder();
	readonly listeners = new Set<(frame: HerdrPiFrame) => void>();
	readonly waiters = new Map<string, { resolve(frame: HerdrPiFrame): void; reject(error: Error): void }>();
	readonly runId: string;
	readonly frames: HerdrPiFrame[] = [];
	readonly failure: Promise<never>;
	readonly #requestTimeoutMs: number;
	readonly #signal?: AbortSignal;
	#rejectFailure!: (error: Error) => void;
	#failure?: Error;
	#replayBytes = 0;
	#deadlineTimer?: NodeJS.Timeout;
	readonly #abort = () => this.fail(new Error("Remote Pi bridge aborted; task state is unknown."));

	constructor(socketPath: string, runId: string, options: BridgeChannelOptions = {}) {
		this.runId = validateHerdrPiRunId(runId);
		this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
		if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1 || this.#requestTimeoutMs > 2_147_483_647) throw new Error("Invalid bridge request timeout.");
		if (options.deadlineAt !== undefined && (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt <= Date.now())) throw new Error("Remote Pi bridge launch deadline expired or invalid.");
		if (options.signal?.aborted) throw new Error("Remote Pi bridge aborted before connection.");
		this.failure = new Promise<never>((_resolve, reject) => { this.#rejectFailure = reject; });
		void this.failure.catch(() => {});
		this.socket = net.createConnection(socketPath);
		this.#signal = options.signal;
		this.#signal?.addEventListener("abort", this.#abort, { once: true });
		if (options.deadlineAt !== undefined) this.#deadlineTimer = setTimeout(() => this.fail(new Error("Remote Pi bridge launch deadline expired; task state is unknown.")), Math.min(2_147_483_647, Math.max(1, options.deadlineAt - Date.now())));
		this.socket.on("data", (chunk: Buffer) => {
			if (this.#failure) return;
			try {
				for (const frame of this.decoder.push(chunk)) {
					if (this.#failure) break;
					if (frame.runId !== runId) throw new Error("Bridge run identity mismatch.");
					const bytes = encodeHerdrPiFrame(frame).length;
					if (this.frames.length >= MAX_REPLAY_FRAMES || this.#replayBytes + bytes > MAX_REPLAY_BYTES) throw new Error("Bridge replay queue exceeded its bound.");
					this.frames.push(frame); this.#replayBytes += bytes;
					const key = frame.requestId ? `${frame.type}:${frame.requestId}` : "";
					this.waiters.get(key)?.resolve(frame);
					for (const listener of this.listeners) {
						if (this.#failure) break;
						listener(frame);
					}
				}
			} catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
		});
		this.socket.on("end", () => { try { this.decoder.end(); } catch (error) { this.fail(error as Error); } });
		this.socket.on("error", (error) => this.fail(error));
		this.socket.on("close", () => this.fail(new Error("Remote Pi bridge connection was lost; task state is unknown.")));
	}

	fail(error: Error): void {
		if (this.#failure) return;
		this.#failure = error;
		if (this.#deadlineTimer) clearTimeout(this.#deadlineTimer);
		this.#signal?.removeEventListener("abort", this.#abort);
		this.socket.destroy();
		this.#rejectFailure(error);
		for (const waiter of this.waiters.values()) waiter.reject(error);
		this.waiters.clear();
		this.listeners.clear();
	}
	get failed(): boolean { return this.#failure !== undefined; }
	#assertWaitable(type: string, requestId: string): void {
		if (this.#failure) throw this.#failure;
		if (this.waiters.has(`${type}:${requestId}`)) throw new Error("Duplicate bridge acknowledgement waiter; no retry was sent.");
		if (this.waiters.size >= MAX_WAITERS) throw new Error("Bridge pending acknowledgement bound exceeded.");
	}
	wait(type: string, requestId: string): Promise<HerdrPiFrame> {
		return new Promise((resolve, reject) => {
			this.#assertWaitable(type, requestId);
			const key = `${type}:${requestId}`;
			const timer = setTimeout(() => this.fail(new Error(`Bridge ${type} acknowledgement timed out; remote effects are unknown.`)), this.#requestTimeoutMs);
			this.waiters.set(key, {
				resolve: (frame) => { clearTimeout(timer); this.waiters.delete(key); resolve(frame); },
				reject: (error) => { clearTimeout(timer); this.waiters.delete(key); reject(error); },
			});
		});
	}
	async #request(frame: HerdrPiFrame, responseType: string): Promise<HerdrPiFrame> {
		// Validate and serialize before reserving a waiter or writing any bytes.
		const bytes = encodeHerdrPiFrame(frame);
		this.#assertWaitable(responseType, frame.requestId!);
		const waiting = this.wait(responseType, frame.requestId!);
		try { this.socket.write(bytes); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
		return waiting;
	}
	configure(resources: { agent: string; skills?: string[]; toolCeiling?: string[]; reads?: string[] | false }): Promise<HerdrPiFrame> {
		return this.#request({ protocol: HERDR_PI_PROTOCOL, runId: this.runId, type: "configure", requestId: `cfg_${randomBytes(6).toString("hex")}`, resources }, "configured");
	}
	supervisorDelivered(requestId: string): void {
		if (this.#failure) throw this.#failure;
		this.socket.write(encodeHerdrPiFrame({ protocol: HERDR_PI_PROTOCOL, runId: this.runId, type: "supervisor-delivered", requestId }));
	}
	prepare(requestId: string, operation: string, text?: string, supervisorId?: string): Promise<HerdrPiFrame> {
		return this.#request({ protocol: HERDR_PI_PROTOCOL, runId: this.runId, type: "prepare", requestId, operation, ...(text !== undefined ? { text } : {}), ...(supervisorId ? { supervisorId } : {}) }, "prepared");
	}
	async ready(timeoutMs: number, timeoutMessage: string, configured = false): Promise<HerdrPiFrame> {
		if (this.#failure) throw this.#failure;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("Invalid bridge ready timeout.");
		const matches = (frame: HerdrPiFrame) => frame.type === "ready" && (!configured || frame.configured === true);
		const received = this.frames.findLast(matches);
		if (received) return received;
		let listener!: (frame: HerdrPiFrame) => void;
		const waiting = new Promise<HerdrPiFrame>((resolve) => {
			listener = (frame) => { if (matches(frame)) resolve(frame); };
			this.listeners.add(listener);
		});
		const timer = setTimeout(() => this.fail(new Error(`${timeoutMessage} Remote state is unknown.`)), timeoutMs);
		try { return await Promise.race([waiting, this.failure]); }
		finally { clearTimeout(timer); this.listeners.delete(listener); }
	}
	close(): void { this.fail(new Error("Remote Pi bridge transport released; task state is unknown.")); }
}
