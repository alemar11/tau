import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { object, type SessionInfo } from "../../../src/registry/session.ts";
import { parseMessage, type DeliveryResult } from "../../../src/protocol/delivery.ts";

import { terminalSafe, singleLine, shortId } from "../../../src/presentation.ts";
export { terminalSafe, singleLine, shortId } from "../../../src/presentation.ts";
export function peerLabel(peer: SessionInfo, peers: SessionInfo[]): string {
  return singleLine(`[${shortId(peer.id, peers)}] ${peer.name ?? peer.runtimeFallbackAlias ?? "sessione"} · ${peer.workgroups.join(", ")}`);
}
export function peerDetail(peer: SessionInfo): string {
  const status = peer.status?.state === "tool" ? `tool:${peer.status.toolName}` : peer.status?.state ?? "unknown";
  const usage = peer.contextUsage?.percent == null ? "" : ` · context ${peer.contextUsage.percent.toFixed(1)}%`;
  return singleLine(`${peer.cwd} · ${peer.model} · ${status}${peer.status?.note ? ` (${peer.status.note})` : ""}${usage}`);
}
export function deliveryLabel(result: DeliveryResult): string {
  const label = { socket_delivered: "Inviato al socket (non completamento)", queued: "In mailbox RAM (non ancora ricevuto)",
    failed: "Invio rifiutato", unknown: "Esito incerto: può essere stato consegnato" }[result.delivery];
  return `${label}${result.code ? ` · ${result.code}` : ""}`;
}

/** Cache only unstyled layout: a live theme change must affect existing components. */
export class RenderBlock implements Component {
  private width = -1;
  private lines: string[] = [];
  private readonly title: string;
  private readonly body: string;
  private readonly theme: Theme;
  private readonly color: "accent" | "warning" | "error";
  private readonly maxLines?: number;
  constructor(title: string, body: string, theme: Theme, color: "accent" | "warning" | "error" = "accent", maxLines?: number) {
    this.title = singleLine(title); this.body = terminalSafe(body); this.theme = theme; this.color = color; this.maxLines = maxLines;
  }
  invalidate(): void { this.width = -1; }
  render(width: number): string[] {
    width = Math.max(1, width);
    if (this.width !== width) {
      this.width = width;
      // A collapsed one-line payload may be 1 MiB: do not build its complete wrapped layout for a preview.
      const source = this.maxLines ? this.body.slice(0, Math.max(256, width * this.maxLines * 8)) : this.body;
      const lines = source ? wrapTextWithAnsi(source, width).flatMap((line) => line.split("\n")) : [];
      this.lines = this.maxLines ? lines.slice(0, this.maxLines) : lines;
      if (this.maxLines && (lines.length > this.maxLines || source.length < this.body.length) && this.lines.length) {
        this.lines[this.lines.length - 1] = truncateToWidth(this.lines.at(-1)!, Math.max(0, width - 1), "") + "…";
      }
    }
    return [this.theme.fg(this.color, truncateToWidth(this.title, width)), ...this.lines.map((line) => truncateToWidth(line, width))];
  }
}
export function renderMessage(content: string, details: unknown, expanded: boolean, theme: Theme): Component {
  try {
    const message = parseMessage(object(details) ? details.message : undefined);
    const attachments = message.attachments ?? [];
    const origin = message.provenance.kind === "extension_outbox" ? ` · estensione ${message.provenance.extensionName}` : "";
    const sender = message.sender.name ? `${message.sender.name} (${message.sender.id})` : message.sender.id;
    const title = `Openspace · ${sender} · [${message.workgroup}]${origin}${attachments.length ? ` · ${attachments.length} allegati` : ""}`;
    const preview = [message.text.split("\n").slice(0, 3).join("\n"), ...attachments.slice(0, 3).map((item) => `[${item.type}: ${item.name}]`),
      ...(message.expectsReply ? ["Risposta richiesta · espandi per riferimento e reply hint"] : [])].join("\n");
    return new RenderBlock(title, expanded ? content : preview, theme, "accent", expanded ? undefined : 6);
  } catch { return new RenderBlock("Openspace", content, theme, "accent", expanded ? undefined : 5); }
}
export function renderTool(details: unknown, expanded: boolean, theme: Theme, isError = false): Component {
  const data = object(details) ? details : {};
  let title = "Openspace", color: "accent" | "warning" | "error" = isError ? "error" : "accent";
  if (Array.isArray(data.sessions)) title += ` · ${data.sessions.length} sessioni`;
  else if (Array.isArray(data.pending)) title += ` · ${data.pending.length} domande pendenti`;
  else if (typeof data.error === "string") title += ` · ${data.error}`;
  else if (typeof data.delivery === "string" && ["socket_delivered", "queued", "failed", "unknown"].includes(data.delivery)) {
    title += ` · ${deliveryLabel(data as unknown as DeliveryResult)}`;
    if (data.delivery === "queued" || data.delivery === "unknown") color = "warning";
  } else if (data.status === "answered") title += " · Risposta ricevuta (non completamento)";
  else if (data.status === "failed") title += ` · ${data.code ?? "Attesa terminata"}`;
  const body = expanded ? JSON.stringify(details ?? {}, null, 2) : "";
  return new RenderBlock(title, body, theme, color);
}
