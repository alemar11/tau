import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY = "tau:codex-fast";
const STATUS_KEY = "tau:codex-fast";
type SpeedMode = "off" | "fast" | "ultrafast";

const FAST_MODELS = new Set([
  "gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol",
]);
const ULTRAFAST_MODELS = new Set([
  "openai/gpt-5.6-sol", "openai/gpt-6-astra", "openai-codex/gpt-6-astra",
]);

function supportsMode(ctx: ExtensionContext, mode: SpeedMode): boolean {
  const model = ctx.model;
  if (!model || mode === "off") return false;
  const supportedApi = (model.provider === "openai" && model.api === "openai-responses") ||
    (model.provider === "openai-codex" && model.api === "openai-codex-responses");
  if (!supportedApi) return false;
  return mode === "fast"
    ? FAST_MODELS.has(model.id)
    : ULTRAFAST_MODELS.has(`${model.provider}/${model.id}`);
}

export default function codexFast(pi: ExtensionAPI) {
  let mode: SpeedMode = "off";

  function updateStatus(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus(STATUS_KEY, mode === "off"
      ? undefined
      : `Codex ${mode}: ${supportsMode(ctx, mode) ? "active" : "inactive"}`);
  }

  function restore(ctx: ExtensionContext) {
    mode = "off";
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      const data = entry.data;
      if (typeof data !== "object" || data === null) continue;
      if ("mode" in data) {
        if (data.mode === "off" || data.mode === "fast" || data.mode === "ultrafast") {
          mode = data.mode;
        }
      } else if ("enabled" in data && typeof data.enabled === "boolean") {
        // Sessions created before ultrafast stored a boolean instead of a mode.
        mode = data.enabled ? "fast" : "off";
      }
    }
    updateStatus(ctx);
  }

  function notifyState(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (mode === "off") {
      ctx.ui.notify("Codex speed mode: off.", "info");
    } else if (supportsMode(ctx, mode)) {
      const tier = mode === "fast" ? "priority" : "ultrafast";
      ctx.ui.notify(`Codex speed mode: ${mode} (active). ${tier} requested; access and usage limits depend on your account/model.`, "info");
    } else {
      ctx.ui.notify(`Codex speed mode: ${mode} (inactive for the current model).`, "info");
    }
  }

  function registerCommand(name: string, target: Exclude<SpeedMode, "off">) {
    pi.registerCommand(name, {
      description: `Toggle Codex ${target} mode (usage: /${name} [toggle|on|off|status])`,
      handler: async (args, ctx) => {
        const action = args.trim().toLowerCase() || "toggle";
        if (!["toggle", "on", "off", "status"].includes(action)) {
          if (ctx.hasUI) ctx.ui.notify(`Usage: /${name} [toggle|on|off|status]`, "warning");
          return;
        }
        if (action !== "status") {
          const next = action === "off" || (action === "toggle" && mode === target) ? "off" : target;
          if (next !== "off" && !supportsMode(ctx, next)) {
            if (ctx.hasUI) ctx.ui.notify(`The current model does not support ${target} mode. Select a supported OpenAI model.`, "warning");
            return;
          }
          if (next !== mode) {
            pi.appendEntry(STATE_ENTRY, { mode: next });
            mode = next;
          }
        }
        updateStatus(ctx);
        notifyState(ctx);
      },
    });
  }

  registerCommand("codex-fast", "fast");
  registerCommand("codex-ultrafast", "ultrafast");
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));

  pi.on("before_provider_request", (event, ctx) => {
    if (!supportsMode(ctx, mode)) return;
    if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return;

    return { ...event.payload, service_tier: mode === "fast" ? "priority" : "ultrafast" };
  });
}
