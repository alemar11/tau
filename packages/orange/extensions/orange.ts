import { FooterComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi has no switch for hiding footer cost or its Codex provider label. Adapt the stock stats line,
 * reserving its columns so model alignment, ANSI styles, and narrow widths stay intact.
 * Other footers and extension status lines are not changed.
 */
export function hideFooterCost(): () => void {
  const prototype = FooterComponent.prototype;
  const original = prototype.render;
  let disposed = false;

  function render(this: FooterComponent, width: number): string[] {
    const lines = original.call(this, width);
    if (disposed || lines.length < 2) return lines;
    // Includes partial amounts/subscription labels when Pi truncates a narrow stats line.
    const stats = lines[1]
      .replace(/\$[\d.]*(?: \([sub.]*\)?)?/g, (cost) => " ".repeat(cost.length))
      .replace(/\(openai-codex\) /g, (provider) => " ".repeat(provider.length));
    return [lines[0], stats, ...lines.slice(2)];
  }

  prototype.render = render;
  return () => {
    disposed = true;
    if (prototype.render === render) prototype.render = original;
  };
}

export default function orange(pi: ExtensionAPI) {
  let restore: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    restore?.();
    restore = ctx.mode === "tui" ? hideFooterCost() : undefined;
  });
  pi.on("session_shutdown", () => {
    restore?.();
    restore = undefined;
  });
}
