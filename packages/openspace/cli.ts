import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { setImmediate } from "node:timers/promises";
import { loadConfig, loadEnvironment } from "./src/config.ts";
import { resolvePaths } from "./src/paths.ts";
import { ClientError, OpenspaceClient, type ClientOptions } from "./src/client/client.ts";
import { Messenger } from "./src/client/messenger.ts";
import { Conversation, type AskResult } from "./src/client/conversation.ts";
import { channelGroup } from "./src/protocol/channels.ts";
import type { DeliveryResult } from "./src/protocol/delivery.ts";
import { text, type SessionInfo } from "./src/registry/session.ts";
import { shortId, singleLine, terminalSafe } from "./src/presentation.ts";

export const CLI_ASK_TIMEOUT_MS = 120_000;
const HELP = `Usage: openspace <list|send|ask> [options]

  list [--workgroup GROUP] [--name NAME] [--json]
  send --to PEER --text TEXT [--workgroup GROUP] [--name NAME] [--json]
  ask  --to PEER --text TEXT [--timeout-ms MS] [--workgroup GROUP] [--name NAME] [--json]
  --help, -h    Show this help
  --version    Show package version

Uses an existing local broker; never starts one. Open Pi with Openspace first.
Groups come from this process's PI_OPENSPACE_WORKGROUPS, not saved Pi preferences.
Ask defaults to 120000 ms. Timeout ends the wait, not the recipient's work.
Exit: 0 success at the reported level; 1 usage/config/connection/send failure; 2 ask timeout.
Send success may mean RAM mailbox queued, not task completion.
Use --text=--value for text beginning with a dash.`;
export interface CliArguments { command: "help" | "version" | "list" | "send" | "ask"; json: boolean; to?: string; text?: string; workgroup?: string; name?: string; timeoutMs: number }
class CliError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
const usage = (message: string): never => { throw new CliError("usage_error", message); };
export function parseCli(args: string[]): CliArguments {
  try {
    const parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
      help: { type: "boolean", short: "h" }, version: { type: "boolean" }, json: { type: "boolean" },
      to: { type: "string" }, text: { type: "string" }, workgroup: { type: "string" }, name: { type: "string" }, "timeout-ms": { type: "string" },
    } });
    const seen = new Set<string>();
    for (const token of parsed.tokens) if (token.kind === "option") { if (seen.has(token.name)) usage(`Duplicate option: --${token.name}`); seen.add(token.name); }
    if (parsed.positionals.length > 1) usage("Expected one command; unexpected positional argument.");
    const action = parsed.positionals[0], v = parsed.values;
    if (action !== undefined && !["list", "send", "ask"].includes(action)) usage(`Unknown command: ${action}`);
    if (v.help && v.version || v.version && action) usage("--version cannot be combined with a command or --help.");
    const command = v.version ? "version" : v.help || action === undefined ? "help" : action as "list" | "send" | "ask";
    const allowed = command === "help" || command === "version" ? ["json", "help", "version"]
      : ["json", "name", "workgroup", ...(command === "list" ? [] : ["to", "text"]), ...(command === "ask" ? ["timeout-ms"] : [])];
    for (const name of seen) if (!allowed.includes(name)) usage(`--${name} is not valid for ${command}.`);
    if ((command === "send" || command === "ask") && (!v.to?.trim() || !v.text || command === "ask" && !v.text.trim())) usage("send/ask require --to PEER and non-empty --text TEXT.");
    let timeoutMs = CLI_ASK_TIMEOUT_MS;
    if (v["timeout-ms"] !== undefined) {
      timeoutMs = Number(v["timeout-ms"]);
      if (!/^\d+$/.test(v["timeout-ms"]) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1) usage("--timeout-ms must be an integer from 1 to 2147483647.");
    }
    return { command, json: v.json ?? false, timeoutMs, ...(v.to === undefined ? {} : { to: text(v.to) }),
      ...(v.text === undefined ? {} : { text: v.text }), ...(v.name === undefined ? {} : { name: text(v.name) }),
      ...(v.workgroup === undefined ? {} : { workgroup: channelGroup(v.workgroup) }) };
  } catch (error) { if (error instanceof CliError) throw error; return usage(error instanceof Error ? error.message : "Invalid arguments."); }
}
interface Failure { code: string; message: string }
export type CliResult = { version: 1; ok: boolean; command: CliArguments["command"] | null; error?: Failure }
  & Partial<{ help: string; packageVersion: string; sessions: SessionInfo[]; messageId: string; workgroup: string; delivery: DeliveryResult["delivery"] | DeliveryResult;
    retryable: boolean; outcomeKnown: boolean; code: string; status: AskResult["status"]; response: AskResult["response"] }>;
export interface CliDependencies {
  env?: Readonly<NodeJS.ProcessEnv>; cwd?: string; signal?: AbortSignal;
  stdout?: (text: string) => void | Promise<void>; stderr?: (text: string) => void | Promise<void>;
  createClient?: (options: ClientOptions) => OpenspaceClient;
}
function failure(error: unknown): Failure {
  if (error instanceof ClientError && error.code === "connect_failed" && ["ENOENT", "ECONNREFUSED"].includes((error.cause as NodeJS.ErrnoException | undefined)?.code ?? "")) {
    return { code: "broker_unavailable", message: "Broker Openspace assente: apri Pi con Openspace. La CLI non avvia il broker." };
  }
  return { code: error instanceof ClientError || error instanceof CliError ? error.code : "cli_error", message: error instanceof Error ? error.message : "Openspace CLI failed." };
}
async function output(result: CliResult, json: boolean, stdout: NonNullable<CliDependencies["stdout"]>, stderr: NonNullable<CliDependencies["stderr"]>): Promise<void> {
  if (json) { await stdout(`${JSON.stringify(result)}\n`); return; }
  if (result.help) { await stdout(`${result.help}\n`); return; }
  if (result.packageVersion) { await stdout(`openspace ${result.packageVersion}\n`); return; }
  if (result.error) { await stderr(`Openspace: ${singleLine(result.error.code)}: ${singleLine(result.error.message)}\n`); return; }
  if (result.sessions) {
    const rows = result.sessions.map((peer) => [shortId(peer.id, result.sessions!), peer.name ?? peer.runtimeFallbackAlias ?? "", peer.workgroups.join(","), peer.cwd].map(singleLine).join("\t"));
    await stdout(`ID\tNAME\tWORKGROUPS\tCWD\n${rows.length ? `${rows.join("\n")}\n` : ""}`); return;
  }
  if (result.response) { await stdout(`${terminalSafe(result.response.text)}\n`); await stderr(`Openspace: risposta da ${singleLine(result.response.sender.id)} [${singleLine(result.workgroup!)}].\n`); return; }
  await stderr(`Openspace: ${result.delivery} · ${singleLine(result.messageId!)} [${singleLine(result.workgroup!)}]; trasporto, non completamento.\n`);
}
const write = (stream: NodeJS.WriteStream, value: string): Promise<void> => new Promise((resolve, reject) => { stream.write(value, (error) => error ? reject(error) : resolve()); });

/** Injectable application boundary. No Pi imports, model credentials, controller, spawn, or reconnect. */
export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? ((value) => write(process.stdout, value)), stderr = dependencies.stderr ?? ((value) => write(process.stderr, value));
  let json = args.some((arg) => arg === "--json" || arg.startsWith("--json=")), command: CliArguments["command"] | null = null;
  let client: OpenspaceClient | undefined, messenger: Messenger | undefined, conversation: Conversation | undefined, result: CliResult, exit = 1;
  const signal = dependencies.signal;
  const interrupted = () => { void client?.disconnect().catch(() => {}); };
  try {
    const parsed = parseCli(args); json = parsed.json; command = parsed.command;
    if (command === "help" || command === "version") {
      result = { version: 1, ok: true, command, ...(command === "help" ? { help: HELP } : { packageVersion: JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version as string }) }; exit = 0;
    } else {
      if (process.platform !== "darwin" && process.platform !== "linux") throw new CliError("unsupported_platform", "Openspace supports macOS and Linux only.");
      const env = dependencies.env ?? process.env, cwd = dependencies.cwd ?? process.cwd();
      let paths, environment;
      try {
        paths = resolvePaths(env, env.HOME || undefined, cwd);
        loadConfig(paths.configPath); // Validate shared config. Explicit CLI commands do not consume extension-only UI/spawn/identity settings.
        environment = loadEnvironment({ PI_OPENSPACE_WORKGROUPS: env.PI_OPENSPACE_WORKGROUPS,
          PI_OPENSPACE_LIVENESS_INTERVAL_MS: env.PI_OPENSPACE_LIVENESS_INTERVAL_MS, PI_OPENSPACE_LIVENESS_TIMEOUT_MS: env.PI_OPENSPACE_LIVENESS_TIMEOUT_MS });
      } catch (error) { throw new CliError("invalid_config", error instanceof Error ? error.message : "Invalid configuration."); }
      const id = randomUUID();
      client = (dependencies.createClient ?? ((options) => new OpenspaceClient(options)))({ socketPath: paths.socketPath,
        session: { id, name: parsed.name ?? `openspace-cli-${id}`, cwd, model: "openspace-cli", pid: process.pid }, workgroups: environment.workgroups,
        heartbeatMs: environment.livenessIntervalMs, heartbeatTimeoutMs: environment.livenessTimeoutMs });
      messenger = new Messenger(client);
      // Install the receiver before registration/send: an immediate reply must not be lost.
      if (command === "ask") conversation = new Conversation(messenger, { timeoutMs: parsed.timeoutMs });
      signal?.addEventListener("abort", interrupted, { once: true });
      if (signal?.aborted) throw new CliError("interrupted", "Operazione interrotta; il lavoro remoto non è stato cancellato.");
      await client.connect();
      if (signal?.aborted) throw new CliError("interrupted", "Operazione interrotta; il lavoro remoto non è stato cancellato.");
      if (command === "list") {
        const sessions = (await client.listSessions({ workgroup: parsed.workgroup })).filter((peer) => peer.id !== id);
        result = { version: 1, ok: true, command, sessions }; exit = 0;
      } else if (command === "send") {
        const delivery = await messenger.send(parsed.to, { text: parsed.text!, workgroup: parsed.workgroup, signal });
        const ok = ["socket_delivered", "queued"].includes(delivery.delivery);
        result = { version: 1, ok, command, ...delivery, ...(!ok ? { error: { code: delivery.code ?? "send_failed", message: delivery.outcomeKnown ? "Invio rifiutato." : "Esito incerto: il messaggio può essere stato consegnato; nessun retry automatico." } } : {}) }; exit = ok ? 0 : 1;
      } else {
        const answer = await conversation!.ask(parsed.to, { text: parsed.text!, workgroup: parsed.workgroup, signal, timeoutMs: parsed.timeoutMs });
        const ok = answer.status === "answered";
        result = { version: 1, ok, command, ...answer, ...(!ok ? { error: { code: answer.code ?? "ask_failed", message: answer.code === "ask_timeout" ? "Attesa scaduta; il lavoro remoto non è stato cancellato." : "Attesa terminata senza risposta correlata; il lavoro remoto non è stato cancellato." } } : {}) };
        exit = ok ? 0 : answer.code === "ask_timeout" ? 2 : 1;
      }
      if (signal?.aborted) { result = { ...result, ok: false, error: { code: "interrupted", message: "Operazione interrotta; il lavoro remoto non è stato cancellato." } }; exit = 1; }
    }
  } catch (error) {
    result = { version: 1, ok: false, command, error: signal?.aborted ? { code: "interrupted", message: "Operazione interrotta; il lavoro remoto non è stato cancellato." } : failure(error) };
  } finally {
    // Disconnect, not release: keep the bounded broker correlation/mailbox lifetime for late replies after timeout.
    conversation?.dispose(); messenger?.dispose();
    try { await client?.disconnect(); }
    finally { signal?.removeEventListener("abort", interrupted); }
  }
  await output(result, json, stdout, stderr); return exit;
}
export async function runMain(args: string[] = process.argv.slice(2)): Promise<number> {
  const controller = new AbortController(); let writing = false;
  // Output begins after client cleanup; also honor subsequent signals after abort() is already spent.
  const interrupt = () => { if (writing) process.exit(1); controller.abort(); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  process.stdout.on("error", interrupt); process.stderr.on("error", interrupt);
  const writer = (stream: NodeJS.WriteStream) => async (value: string) => {
    // Node protects stdio from destroy(). Give an already-interrupted operation a bounded
    // chance to emit its result, even when the inherited pipe was full before this write.
    const timer = controller.signal.aborted ? setTimeout(() => process.exit(1), 1000) : undefined;
    writing = true;
    try { await write(stream, value); }
    finally { writing = false; clearTimeout(timer); }
  };
  try { return await runCli(args, { signal: controller.signal, stdout: writer(process.stdout), stderr: writer(process.stderr) }); }
  catch { return 1; } // Broken output pipes cannot receive a replacement JSON object.
  finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    await setImmediate(); // Writable callbacks precede their error event; keep the handler until that event is consumed.
    process.stdout.off("error", interrupt); process.stderr.off("error", interrupt);
  }
}
