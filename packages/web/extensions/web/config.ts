import { readFileSync } from "node:fs";
import { join } from "node:path";
import { choice, integer, keys, object, WebError } from "./core.ts";

export const PROVIDERS = ["auto", "openai", "exa", "duckduckgo"] as const;
export type Provider = typeof PROVIDERS[number];
export interface Config {
  version: 1;
  search: { provider: Provider; fallbackToExa: boolean };
  openai: { auth: "pi-oauth" | "api-key"; model: string; apiKeyEnv: string };
  exa: { transport: "mcp" | "api"; apiKeyEnv: string };
  limits: { requestTimeoutMs: number; toolTimeoutMs: number; concurrency: number; maxDownloadBytes: number; maxExtractedChars: number; maxOutputChars: number };
}
export function parseConfig(raw: unknown = {}): Config {
  try {
    const config = object(raw);
    keys(config, ["version", "search", "openai", "exa", "limits"]);
    if (config.version !== undefined && config.version !== 1) throw Error();
    const search = object(config.search ?? {}), openai = object(config.openai ?? {}), exa = object(config.exa ?? {}), limits = object(config.limits ?? {});
    keys(search, ["provider", "fallbackToExa"]); keys(openai, ["auth", "model", "apiKeyEnv"]); keys(exa, ["transport", "apiKeyEnv"]);
    keys(limits, ["requestTimeoutMs", "toolTimeoutMs", "concurrency", "maxDownloadBytes", "maxExtractedChars", "maxOutputChars"]);
    if (search.fallbackToExa !== undefined && typeof search.fallbackToExa !== "boolean") throw Error();
    const env = (v: unknown, fallback: string) => {
      if (v === undefined) return fallback;
      if (typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) || v.length > 128) throw Error();
      return v;
    };
    const model = openai.model ?? "gpt-5.6-terra";
    if (typeof model !== "string" || !/^gpt-[a-z0-9.-]{1,100}$/.test(model)) throw Error();
    const result: Config = {
      version: 1,
      search: { provider: choice(search.provider, PROVIDERS, "auto"), fallbackToExa: search.fallbackToExa as boolean ?? true },
      openai: { auth: choice(openai.auth, ["pi-oauth", "api-key"], "pi-oauth"), model, apiKeyEnv: env(openai.apiKeyEnv, "OPENAI_API_KEY") },
      exa: { transport: choice(exa.transport, ["mcp", "api"], "mcp"), apiKeyEnv: env(exa.apiKeyEnv, "EXA_API_KEY") },
      limits: {
        requestTimeoutMs: integer(limits.requestTimeoutMs, 30000, 1000, 120000),
        toolTimeoutMs: integer(limits.toolTimeoutMs, 120000, 1000, 600000),
        concurrency: integer(limits.concurrency, 3, 1, 4),
        maxDownloadBytes: integer(limits.maxDownloadBytes, 20 * 1024 ** 2, 1024 ** 2, 64 * 1024 ** 2),
        maxExtractedChars: integer(limits.maxExtractedChars, 2000000, 1000000, 4000000),
        maxOutputChars: integer(limits.maxOutputChars, 30000, 1000, 30000),
      },
    };
    if (result.limits.toolTimeoutMs < result.limits.requestTimeoutMs) throw Error();
    return result;
  } catch { throw new WebError("CONFIG_INVALID", "Invalid web/config.json. Check its version, fields and ranges; then reload Pi."); }
}
export function loadConfig(agentDir: string): Config {
  try {
    const data = readFileSync(join(agentDir, "web", "config.json"));
    if (data.length > 16384) throw Error();
    return parseConfig(JSON.parse(data.toString("utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig();
    throw new WebError("CONFIG_INVALID", "Cannot read valid web/config.json; correct it and reload Pi.");
  }
}
