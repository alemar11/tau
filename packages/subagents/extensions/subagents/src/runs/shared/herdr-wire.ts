/** Bounded newline-delimited JSON shared by Herdr RPC and the private Pi bridge. */
export function decodeHerdrJsonLine(line: Buffer): unknown {
	try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as unknown; }
	catch { throw new Error("Herdr emitted malformed JSON or UTF-8."); }
}

export class HerdrJsonLineDecoder {
	readonly #maxBytes: number;
	#buffer = Buffer.alloc(0);
	#length = 0;
	#failure?: Error;
	constructor(maxBytes: number) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid Herdr frame byte bound.");
		this.#maxBytes = maxBytes;
	}
	#append(part: Buffer): Buffer {
		const length = this.#length + part.length;
		if (this.#buffer.length < length) {
			const next = Buffer.alloc(Math.min(this.#maxBytes, Math.max(length, this.#buffer.length * 2, 1024)));
			this.#buffer.copy(next, 0, 0, this.#length);
			this.#buffer = next;
		}
		part.copy(this.#buffer, this.#length);
		this.#length = length;
		return this.#buffer.subarray(0, length);
	}
	push(chunk: Buffer): Record<string, unknown>[] {
		if (this.#failure) throw this.#failure;
		try {
			const frames: Record<string, unknown>[] = [];
			let offset = 0;
			while (offset < chunk.length) {
				const newline = chunk.indexOf(10, offset);
				const end = newline < 0 ? chunk.length : newline;
				const length = this.#length + end - offset;
				// The bound includes the newline, even when it has not arrived yet.
				if (length + 1 > this.#maxBytes) throw new Error(`Herdr frame exceeds ${this.#maxBytes} bytes.`);
				const part = chunk.subarray(offset, end);
				if (newline < 0) { this.#append(part); break; }
				const line = this.#length ? this.#append(part) : part;
				this.#length = 0;
				const value = decodeHerdrJsonLine(line);
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Herdr frame must be an object.");
				frames.push(value as Record<string, unknown>);
				offset = newline + 1;
			}
			return frames;
		} catch (error) {
			this.#buffer = Buffer.alloc(0);
			this.#length = 0;
			this.#failure = error instanceof Error ? error : new Error(String(error));
			throw this.#failure;
		}
	}
	end(): void {
		if (this.#failure) throw this.#failure;
		if (this.#length) {
			this.#buffer = Buffer.alloc(0);
			this.#length = 0;
			throw this.#failure = new Error("Herdr connection ended with a partial frame.");
		}
	}
}
