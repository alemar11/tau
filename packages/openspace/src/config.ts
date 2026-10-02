/*
MIT License

Copyright (c) 2026 Nico Bailon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { readFileSync } from "node:fs";
import { OPENSPACE_ENV, STATUS_NOTE_MAX_BYTES } from "./constants.ts";
import { parseWorkgroups } from "./workgroups.ts";

export type InboundTriggerPolicy = "always" | "replies" | "never";
export type BusyDeliveryPolicy = "steer" | "human-first";

export interface OpenspaceConfig {
  brokerCommand: string;
  brokerArgs: string[];
  enabled: boolean;
  replyHint: boolean;
  confirmSend: boolean;
  inboundTrigger: InboundTriggerPolicy;
  busyDelivery: BusyDeliveryPolicy;
  stableId?: string;
  /** Custom note, not the automatic lifecycle state. */
  status?: string;
}

function defaultConfig(): OpenspaceConfig {
  return {
    brokerCommand: "npx",
    brokerArgs: ["--no-install", "tsx"],
    enabled: true,
    replyHint: true,
    confirmSend: false,
    inboundTrigger: "always",
    busyDelivery: "steer",
  };
}

function parseConfig(input: unknown): OpenspaceConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("config must be a JSON object");
  }
  const value = input as Record<string, unknown>;
  const config = defaultConfig();
  for (const key of ["enabled", "replyHint", "confirmSend"] as const) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== "boolean") throw new Error(`"${key}" must be a boolean`);
    config[key] = value[key];
  }
  for (const key of ["brokerCommand", "stableId"] as const) {
    if (!Object.hasOwn(value, key)) continue;
    const field = value[key];
    if (typeof field !== "string" || !field.trim() || field.includes("\0")) {
      throw new Error(`"${key}" must be a non-empty string without NUL`);
    }
    config[key] = field.trim();
  }
  if (Object.hasOwn(value, "brokerArgs")) {
    if (!Array.isArray(value.brokerArgs) || value.brokerArgs.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new Error('"brokerArgs" must be an array of strings without NUL');
    }
    config.brokerArgs = [...value.brokerArgs];
  }
  if (Object.hasOwn(value, "inboundTrigger")) {
    if (value.inboundTrigger !== "always" && value.inboundTrigger !== "replies" && value.inboundTrigger !== "never") {
      throw new Error('"inboundTrigger" must be "always", "replies", or "never"');
    }
    config.inboundTrigger = value.inboundTrigger;
  }
  if (Object.hasOwn(value, "busyDelivery")) {
    if (value.busyDelivery !== "steer" && value.busyDelivery !== "human-first") {
      throw new Error('"busyDelivery" must be "steer" or "human-first"');
    }
    config.busyDelivery = value.busyDelivery;
  }
  if (Object.hasOwn(value, "status")) {
    if (typeof value.status !== "string" || Buffer.byteLength(value.status, "utf8") > STATUS_NOTE_MAX_BYTES) {
      throw new Error(`"status" must be a string of at most ${STATUS_NOTE_MAX_BYTES} UTF-8 bytes`);
    }
    config.status = value.status;
  }
  return config;
}

/** Missing config uses defaults; malformed or unreadable config never does. */
export function loadConfig(configPath: string): OpenspaceConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw new Error(`Failed to read Openspace config at ${configPath}`, { cause: error });
  }
  try {
    return parseConfig(JSON.parse(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Openspace config at ${configPath}: ${message}`, { cause: error });
  }
}

export interface OpenspaceEnvironment {
  stableId?: string;
  /** Initial specific groups only; saved session preferences take precedence later. */
  workgroups: string[];
  askTimeoutMs: number;
  livenessIntervalMs: number;
  livenessTimeoutMs: number;
}

// Node timers overflow above this value, firing after 1 ms instead of waiting.
const MAX_TIMER_MS = 2 ** 31 - 1;
function timeout(env: Readonly<NodeJS.ProcessEnv>, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new Error(`${key} must be an integer between 1 and ${MAX_TIMER_MS} milliseconds`);
  }
  return value;
}

/** Snapshot the calling process; never mutate process.env or read legacy variables. */
export function loadEnvironment(env: Readonly<NodeJS.ProcessEnv> = process.env): OpenspaceEnvironment {
  let workgroups: string[];
  try {
    workgroups = parseWorkgroups(env[OPENSPACE_ENV.workgroups]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${OPENSPACE_ENV.workgroups}: ${message}`, { cause: error });
  }
  const stableId = env[OPENSPACE_ENV.stableId]?.trim() || undefined;
  if (stableId?.includes("\0")) throw new Error(`${OPENSPACE_ENV.stableId} must not contain NUL`);
  const livenessIntervalMs = timeout(env, OPENSPACE_ENV.livenessIntervalMs, 30_000);
  return {
    ...(stableId ? { stableId } : {}),
    workgroups,
    askTimeoutMs: timeout(env, OPENSPACE_ENV.askTimeoutMs, 10 * 60_000),
    livenessIntervalMs,
    livenessTimeoutMs: Math.min(timeout(env, OPENSPACE_ENV.livenessTimeoutMs, 5_000), livenessIntervalMs),
  };
}
