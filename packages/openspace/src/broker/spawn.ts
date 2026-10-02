import { spawn, execFile, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { basename, delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { OpenspaceConfig } from "../config.ts";
import type { OpenspacePaths } from "../paths.ts";
import type { Health } from "../protocol/messages.ts";
import { acquireClaim, prepareRuntime } from "./runtime-files.ts";
import { probeBroker } from "./probe.ts";

const require = createRequire(import.meta.url);
const brokerEntry = fileURLToPath(new URL("./main.ts", import.meta.url));
const STDERR_LIMIT = 16 * 1024;
const exec = promisify(execFile);
export type LauncherConfig = Pick<OpenspaceConfig, "brokerCommand" | "brokerArgs">;

/** Never treat a standalone Pi/Bun executable as a Node binary. No shell or npx. */
export async function launchCommand(config: LauncherConfig, env: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath, timeoutMs = 1_000): Promise<{ command: string; args: string[] }> {
  if (config.brokerCommand) return { command: config.brokerCommand, args: [...config.brokerArgs, brokerEntry] };
  if (config.brokerArgs.length) throw new Error("brokerArgs requires an explicit brokerCommand");
  const deadline = performance.now() + timeoutMs;
  const loader = pathToFileURL(require.resolve("tsx/esm")).href;
  const candidates = [
    ...(/^node(?:js)?$/.test(basename(execPath)) ? [execPath] : []),
    ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((path) => resolve(path, "node")),
  ];
  for (const command of new Set(candidates)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    try {
      accessSync(command, constants.X_OK);
      const { stdout } = await exec(command, ["-p", 'JSON.stringify({name:process.release.name,node:process.versions.node,bun:!!process.versions.bun})'], {
        env, timeout: Math.max(1, Math.floor(Math.min(1_000, remaining))), killSignal: "SIGKILL", maxBuffer: 4096, encoding: "utf8",
      });
      const result = JSON.parse(stdout);
      const [major, minor] = String(result.node).split(".").map(Number);
      if (result.name !== "node" || result.bun || !(major > 22 || major === 22 && minor >= 19)) continue;
      return { command, args: ["--import", loader, brokerEntry] };
    } catch { /* Try the next actual Node candidate, not the host executable. */ }
  }
  throw new Error("Openspace requires a Node.js 22.19+ executable (node on PATH), or an explicit brokerCommand/brokerArgs launcher");
}

export interface SpawnOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  launch?: typeof spawn;
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const kill = (signal: NodeJS.Signals) => {
    // Only the process group created by our detached spawn, never a PID from disk.
    try { process.kill(-pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout>;
  await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 500); })]);
  clearTimeout(timer!);
  if (child.exitCode === null && child.signalCode === null) { kill("SIGKILL"); await exited; }
}

/** Used by the future extension controller; the scripting CLI must not call this. */
export async function ensureBroker(paths: OpenspacePaths, config: LauncherConfig, options: SpawnOptions = {}): Promise<Health> {
  prepareRuntime(paths);
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1) throw new Error("Invalid broker startup timeout");
  const deadline = performance.now() + timeoutMs;
  const env = { ...(options.env ?? process.env) };
  const check = async () => {
    const result = await probeBroker(paths.socketPath, Math.max(1, Math.min(300, deadline - performance.now())));
    if (result.status === "occupied") throw new Error(`Cannot start Openspace: ${result.reason}; existing endpoint left untouched`);
    return result.status === "ready" ? result.health : undefined;
  };
  while (performance.now() < deadline) {
    const existing = await check();
    if (existing) return existing;
    const claim = acquireClaim(join(paths.runtimeDir, "spawn.lock"));
    if (!claim) { await delay(Math.min(50, Math.max(1, deadline - performance.now()))); continue; }
    let child: ChildProcess | undefined;
    let succeeded = false;
    let stderr = Buffer.alloc(0);
    let truncated = false;
    try {
      const second = await check();
      if (second) return second;
      const command = await launchCommand(config, env, process.execPath, Math.max(1, deadline - performance.now()));
      if (performance.now() >= deadline) throw new Error("Broker startup timeout while resolving Node");
      child = (options.launch ?? spawn)(command.command, [...command.args, "--runtime-dir", paths.runtimeDir], {
        cwd: paths.runtimeDir, env, detached: true, shell: false, stdio: ["ignore", "ignore", "pipe"],
      });
      let startupError: Error | undefined;
      child.on("error", (error) => { startupError = error; });
      child.stderr?.on("data", (chunk: Buffer) => {
        const available = STDERR_LIMIT - stderr.length;
        if (chunk.length > available) truncated = true;
        if (available > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, available)]);
      });
      while (performance.now() < deadline) {
        if (startupError) throw startupError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Broker exited during startup (${child.exitCode ?? child.signalCode})`);
        const ready = await check();
        if (ready) {
          succeeded = true;
          // Keep draining without retaining output; neither pipe nor child pins Pi.
          child.stderr?.removeAllListeners("data");
          child.stderr?.on("data", () => {});
          if (child.stderr instanceof Socket) child.stderr.unref();
          child.unref();
          return ready;
        }
        await delay(Math.min(50, Math.max(1, deadline - performance.now())));
      }
      throw new Error("Openspace broker startup timed out");
    } catch (error) {
      if (child) await terminateChild(child);
      const diagnostic = stderr.toString("utf8").trim();
      throw new Error(`${error instanceof Error ? error.message : "Broker startup failed"}${diagnostic ? `\nStartup stderr: ${diagnostic}${truncated ? "\n[truncated]" : ""}` : ""}`, { cause: error });
    } finally {
      if (!succeeded) child?.stderr?.destroy();
      claim.release();
    }
  }
  throw new Error("Openspace broker startup timed out waiting for the spawn lock; live owner left untouched");
}
