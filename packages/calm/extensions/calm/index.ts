import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderMonster } from "./monster.ts";
import { installPresentation } from "./presentation.ts";

const STATE_ENTRY = "tau:calm";
const WIDGET_KEY = "tau:calm";
const INTERVAL_MS = 240;

export default function calm(pi: ExtensionAPI) {
  let enabled = false;
  let running = false;
  let uiApplied = false;
  let fadeAnimation: (() => void) | undefined;
  let removePresentation: (() => void) | undefined;

  function clearAnimation(ctx: ExtensionContext) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    fadeAnimation = undefined;
  }

  function startAnimation(ctx: ExtensionContext) {
    ctx.ui.setWidget(WIDGET_KEY, (tui) => {
      let tick = 0;
      let fade: "muted" | "dim" | undefined;
      let timer = setInterval(() => {
        tick++;
        tui.requestRender();
      }, INTERVAL_MS);
      timer.unref();
      fadeAnimation = () => {
        if (fade) return;
        // Freeze the pose, then dim it without blocking the settled event or input.
        clearInterval(timer);
        fade = "muted";
        tui.requestRender();
        timer = setInterval(() => {
          if (fade === "dim") {
            clearAnimation(ctx);
            return;
          }
          fade = "dim";
          tui.requestRender();
        }, INTERVAL_MS);
        timer.unref();
      };
      return {
        render: (width) => renderMonster(width, tick, ctx.ui.theme, fade),
        invalidate() {},
        dispose: () => {
          clearInterval(timer);
          fadeAnimation = undefined;
        },
      };
    });
  }

  function apply(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    if (enabled) {
      removePresentation ??= installPresentation(() => enabled, (message) => ctx.ui.notify(message, "warning"));
      ctx.ui.setHiddenThinkingLabel("");
      ctx.ui.setWorkingVisible(false);
      uiApplied = true;
      if (running) startAnimation(ctx);
      else clearAnimation(ctx);
    } else if (uiApplied) {
      clearAnimation(ctx);
      ctx.ui.setHiddenThinkingLabel();
      ctx.ui.setWorkingVisible(true);
      uiApplied = false;
      removePresentation?.();
      removePresentation = undefined;
    }
  }

  function restore(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    enabled = false;
    apply(ctx);
    running = !ctx.isIdle();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      const data = entry.data;
      if (typeof data === "object" && data !== null && "enabled" in data && typeof data.enabled === "boolean") {
        enabled = data.enabled;
      }
    }
    apply(ctx);
  }

  pi.registerCommand("calm", {
    description: "Toggle quiet transcript presentation (usage: /calm [toggle|on|off|status])",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Calm is available in the terminal UI only.", "info");
        return;
      }
      const action = args.trim().toLowerCase() || "toggle";
      if (!["toggle", "on", "off", "status"].includes(action)) {
        ctx.ui.notify("Usage: /calm [toggle|on|off|status]", "warning");
        return;
      }
      if (action !== "status") {
        const next = action === "toggle" ? !enabled : action === "on";
        if (next !== enabled) {
          try {
            pi.appendEntry(STATE_ENTRY, { enabled: next });
          } catch (error) {
            ctx.ui.notify(`Calm session state could not be saved: ${(error as Error).message}`, "error");
            return;
          }
          enabled = next;
          apply(ctx);
        }
      }
      ctx.ui.notify(`Calm: ${enabled ? "on" : "off"}.`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    running = true;
    if (enabled) startAnimation(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    running = false;
    if (enabled) fadeAnimation?.();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    running = false;
    enabled = false;
    apply(ctx);
    removePresentation?.();
    removePresentation = undefined;
  });
}
