import { Worker } from "node:worker_threads";
import type { Config } from "./config.ts";
import { canonicalUrl, check, concurrent, diagnostic, stopError, WebError, type Diagnostic } from "./core.ts";
import { requireSuccess, type Transport } from "./network.ts";
import { document, type Document } from "./cache.ts";

export interface Extracted { text: string; title?: string; format: "text" | "markdown"; sourceType: "html" | "text" | "pdf"; pages?: { pageNumber: number; start: number; end: number }[]; pageCount?: number }
export interface Fetched { requestedUrl: string; finalUrl?: string; mime?: string; fetchedAt?: string; bytes?: number; extracted?: Extracted; error?: Diagnostic; inputIndices: number[] }
export function extract(body: Uint8Array, mime: string, url: string, maxChars: number, signal: AbortSignal): Promise<Extracted> {
  check(signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./extract-worker.mjs", import.meta.url), {
      workerData: { body, mime, url, maxChars }, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
      // Do not inherit an embedding application's loaders or executable eval flags.
      execArgv: [], stdout: true, stderr: true,
    });
    worker.stdout?.resume(); worker.stderr?.resume();
    let settled = false;
    const finish = (error?: unknown, result?: Extracted) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      void worker.terminate().then(
        () => error ? reject(error) : resolve(result!),
        () => reject(error ?? new WebError("EXTRACTION_FAILED", "Could not stop document worker.")),
      );
    };
    const abort = () => { try { check(signal); } catch (e) { finish(e); } };
    const timer = setTimeout(() => finish(new WebError("EXTRACTION_FAILED", "Document extraction timed out.")), 30000);
    timer.unref(); signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (message) => finish(message.error ? new WebError(message.error.code, message.error.message) : undefined, message.result));
    worker.once("error", () => finish(new WebError("EXTRACTION_FAILED", "Document worker failed or exceeded its memory limit.")));
    worker.once("exit", () => { if (!settled) finish(new WebError("EXTRACTION_FAILED", "Document worker exited without text.")); });
    if (signal.aborted) abort();
  });
}
export async function fetchContents(urls: string[], config: Config, transport: Transport, signal: AbortSignal): Promise<Fetched[]> {
  const normalized = urls.map(canonicalUrl), unique = [...new Set(normalized)];
  return concurrent(unique, config.limits.concurrency, signal, async (url) => {
    const item: Fetched = { requestedUrl: url, inputIndices: normalized.flatMap((v, i) => v === url ? [i] : []) };
    try {
      const response = await transport(url, { signal, timeoutMs: config.limits.requestTimeoutMs, maxBytes: config.limits.maxDownloadBytes, headers: { accept: "text/html,application/pdf,text/plain,application/json;q=0.8,*/*;q=0.1" } });
      requireSuccess(response); check(signal);
      item.finalUrl = response.url; item.mime = response.headers["content-type"] ?? ""; item.bytes = response.body.byteLength;
      item.extracted = await extract(response.body, item.mime, response.url, config.limits.maxExtractedChars, signal);
      item.fetchedAt = new Date().toISOString();
      return item;
    } catch (error) {
      check(signal);
      if (stopError(error)) throw error;
      return { ...item, error: diagnostic(error) };
    }
  });
}
export function contentDocuments(items: Fetched[]): Document[] {
  return items.map(({ extracted, ...metadata }, index) => document(index, extracted?.text ?? "", { ...metadata, ...(extracted ? { ...extracted, text: undefined } : {}) }, metadata.error));
}
