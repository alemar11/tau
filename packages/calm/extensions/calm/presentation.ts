import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

type AssistantMessage = Parameters<AssistantMessageComponent["updateContent"]>[0];
type AssistantLayout = {
  lastMessage?: AssistantMessage;
  isStreaming: boolean;
  hideThinkingBlock: boolean;
  thinkingVisibilityOverrides: Map<number, boolean>;
};
type ToolLayout = {
  toolName: string;
  expanded: boolean;
  result?: { isError?: boolean; content: { type: string }[] };
};

const QUIET_TOOLS = new Set(["bash", "powershell", "read", "edit", "write", "grep", "find", "ls"]);
const PRESERVE_MIN_CHARS = 240;

function projectMessage(message: AssistantMessage, streaming: boolean, hideThinking: boolean): AssistantMessage {
  const workingNote = !streaming && (message.stopReason === "toolUse" || message.stopReason === "length") &&
    message.content.some((block) => block.type === "toolCall");
  const content = message.content.filter((block) => {
    if (hideThinking && block.type === "thinking") return false;
    if (!workingNote || block.type !== "text") return true;
    return /[\r\n]/.test(block.text) || block.text.trim().length >= PRESERVE_MIN_CHARS;
  });
  return content.length === message.content.length ? message : { ...message, content };
}

function assistantLayout(component: AssistantMessageComponent): AssistantLayout | undefined {
  const layout = component as unknown as AssistantLayout;
  return typeof layout.isStreaming === "boolean" && typeof layout.hideThinkingBlock === "boolean" &&
    layout.thinkingVisibilityOverrides instanceof Map ? layout : undefined;
}

function toolLayout(component: ToolExecutionComponent): ToolLayout | undefined {
  const layout = component as unknown as ToolLayout;
  if (typeof layout.toolName !== "string" || typeof layout.expanded !== "boolean") return;
  if (layout.result !== undefined && (!layout.result || !Array.isArray(layout.result.content))) return;
  return layout;
}

/**
 * Pi has no transcript-wide presentation filter. These adapters touch rendering only;
 * private layout fields are capability-checked and an unavailable adapter fails open.
 * No tool registrations, messages, model context, or serialized entries are changed.
 */
export function installPresentation(isEnabled: () => boolean, warn: (message: string) => void): () => void {
  const assistant = AssistantMessageComponent.prototype;
  const tool = ToolExecutionComponent.prototype;
  const originalUpdate = assistant.updateContent;
  const originalAssistantRender = assistant.render;
  const originalToolRender = tool.render;
  const rendered = new WeakMap<AssistantMessageComponent, {
    message: AssistantMessage; streaming?: boolean; enabled: boolean;
  }>();
  const seen = new Set<AssistantMessageComponent>();
  let disposed = false;
  let assistantAvailable = typeof originalUpdate === "function" && typeof originalAssistantRender === "function";
  let toolAvailable = typeof originalToolRender === "function";
  let assistantWarned = false;
  let toolWarned = false;
  const active = () => !disposed && isEnabled();

  function unavailable(kind: "assistant" | "tool") {
    if (kind === "assistant") {
      assistantAvailable = false;
      if (assistantWarned) return;
      assistantWarned = true;
    } else {
      toolAvailable = false;
      if (toolWarned) return;
      toolWarned = true;
    }
    warn(`Calm: ${kind} presentation is unavailable on this Pi version; those rows remain visible.`);
  }

  function update(this: AssistantMessageComponent, message: AssistantMessage, streaming?: boolean) {
    const layout = assistantLayout(this);
    if (!layout && active()) unavailable("assistant");
    const enabled = active() && assistantAvailable && layout !== undefined;
    const projected = enabled && layout ? projectMessage(message, streaming ?? layout.isStreaming,
      layout.hideThinkingBlock && layout.thinkingVisibilityOverrides.size === 0) : message;
    originalUpdate.call(this, projected, streaming);
    // Pi's component needs the original message when invalidated, expanded, or toggled off.
    if (layout) layout.lastMessage = message;
    rendered.set(this, { message, streaming: streaming ?? layout?.isStreaming, enabled });
    seen.add(this);
  }

  function renderAssistant(this: AssistantMessageComponent, width: number): string[] {
    const layout = assistantLayout(this);
    if (!layout && active()) unavailable("assistant");
    const previous = rendered.get(this);
    if (layout?.lastMessage && previous?.enabled !== (active() && assistantAvailable)) {
      update.call(this, layout.lastMessage, layout.isStreaming);
    } else if (!layout && previous?.enabled) {
      // A seam can disappear after a row was hidden; restore its captured source too.
      originalUpdate.call(this, previous.message, previous.streaming);
      previous.enabled = false;
    }
    return originalAssistantRender.call(this, width);
  }

  function renderTool(this: ToolExecutionComponent, width: number): string[] {
    if (active() && toolAvailable) {
      const layout = toolLayout(this);
      if (!layout) unavailable("tool");
      else if (QUIET_TOOLS.has(layout.toolName) && !layout.expanded && !layout.result?.isError &&
        !layout.result?.content.some((block) => block.type === "image")) return [];
    }
    return originalToolRender.call(this, width);
  }

  if (assistantAvailable) {
    assistant.updateContent = update;
    assistant.render = renderAssistant;
  } else if (active()) unavailable("assistant");
  if (toolAvailable) tool.render = renderTool;
  else if (active()) unavailable("tool");

  return () => {
    if (disposed) return;
    disposed = true;
    for (const component of seen) {
      const previous = rendered.get(component);
      if (previous) originalUpdate.call(component, previous.message, previous.streaming);
    }
    seen.clear();
    // Do not overwrite a later extension's adapter. Our retained wrappers are now inert.
    if (assistant.updateContent === update) assistant.updateContent = originalUpdate;
    if (assistant.render === renderAssistant) assistant.render = originalAssistantRender;
    if (tool.render === renderTool) tool.render = originalToolRender;
  };
}
