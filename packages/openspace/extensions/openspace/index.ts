import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadConfig, loadEnvironment, type OpenspaceConfig } from "../../src/config.ts";
import { resolvePaths } from "../../src/paths.ts";
import { parseMessage } from "../../src/protocol/delivery.ts";
import { PiRuntime } from "./runtime.ts";
import { registerTools } from "./tools.ts";

/** Internal injection seam for isolated SDK fixtures; not the public extension bus API. */
export interface InstallOptions {
  env?: Readonly<NodeJS.ProcessEnv>;
  config?: OpenspaceConfig;
  onRuntime?: (runtime: PiRuntime) => void;
}
export function installOpenspace(pi: ExtensionAPI, options: InstallOptions = {}): void {
  let runtime: PiRuntime | undefined;
  let generation = 0;
  registerTools(pi, () => runtime);
  pi.registerMessageRenderer("openspace_message", (message, { expanded }, theme) => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const safe = content.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return new Text(theme.fg("accent", "Openspace\n") + (expanded ? safe : safe.split("\n").slice(0, 5).join("\n")), 0, 0);
  });
  pi.on("session_start", async (_event, ctx) => {
    const epoch = ++generation, previous = runtime; runtime = undefined;
    await previous?.stop();
    if (epoch !== generation) return;
    const env = { ...(options.env ?? process.env) }, paths = resolvePaths(env);
    const config = options.config ?? loadConfig(paths.configPath);
    if (!config.enabled) return;
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Openspace supports macOS and Linux only");
    runtime = new PiRuntime(pi, ctx, paths, config, loadEnvironment(env));
    options.onRuntime?.(runtime); runtime.start();
  });
  pi.on("session_shutdown", async () => { generation++; const previous = runtime; runtime = undefined; await previous?.stop(); });
  const observe = (event: { type: string }, ctx: ExtensionContext) => { runtime?.event(event.type, ctx); };
  pi.on("agent_start", observe);
  pi.on("agent_end", observe);
  pi.on("agent_settled", observe);
  pi.on("turn_start", observe);
  pi.on("turn_end", observe);
  pi.on("session_before_compact", observe);
  pi.on("session_compact", observe);
  pi.on("session_compact_failed", observe);
  pi.on("session_info_changed", observe);
  pi.on("model_select", observe);
  pi.on("message_end", observe);
  pi.on("session_tree", observe);
  pi.on("message_start", (event) => {
    if (!runtime) return;
    if (event.message.role === "custom" && event.message.customType === "openspace_message") {
      const details = event.message.details as { message?: unknown } | undefined;
      if (details?.message) runtime.conversation.activate(parseMessage(details.message));
    } else if (event.message.role === "user") runtime.conversation.activate();
  });
  pi.on("tool_execution_start", (event, ctx) => { runtime?.event(event.type, ctx, event); });
  pi.on("tool_execution_end", (event, ctx) => { runtime?.event(event.type, ctx, event); });
  pi.on("input", (event, ctx) => { if (event.source !== "extension") runtime?.event(event.type, ctx); });
}
export default function openspace(pi: ExtensionAPI): void { installOpenspace(pi); }
