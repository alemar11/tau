import { randomUUID } from "node:crypto";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, SelectList, truncateToWidth, type Component, type Focusable, type KeybindingsManager, type SelectItem, type SelectListTheme, type TUI } from "@earendil-works/pi-tui";
import type { DeliveryResult } from "../../../src/protocol/delivery.ts";
import { deliveryLabel, singleLine } from "./render.ts";

function listTheme(theme: Theme): SelectListTheme {
  return { selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("warning", text) };
}
interface Shared { tui: TUI; theme: Theme; keys: KeybindingsManager; signal: AbortSignal }
export class Picker implements Component {
  private readonly options: Shared & { title: string; subtitle?: string; items: SelectItem[]; done(value: string | undefined): void };
  private list?: SelectList;
  private rows = 0;
  private index = 0;
  private disposed = false;
  private readonly abort = () => this.finish();
  constructor(options: Shared & { title: string; subtitle?: string; items: SelectItem[]; done(value: string | undefined): void }) {
    this.options = options; options.signal.addEventListener("abort", this.abort, { once: true });
    if (options.signal.aborted) queueMicrotask(this.abort);
  }
  private finish(value?: string): void { if (!this.disposed) { this.dispose(); this.options.done(value); } }
  dispose(): void { this.disposed = true; this.options.signal.removeEventListener("abort", this.abort); }
  invalidate(): void { this.list?.invalidate(); }
  render(width: number): string[] {
    width = Math.max(1, width);
    const { tui, theme, items } = this.options;
    const rows = Math.max(1, Math.min(12, Math.floor(tui.terminal.rows * 0.8) - 5));
    if (!this.list || rows !== this.rows) { this.rows = rows; this.list = new SelectList(items, rows, listTheme(theme)); this.list.setSelectedIndex(this.index); }
    const header = [theme.fg("accent", singleLine(this.options.title)), ...(this.options.subtitle ? [theme.fg("muted", singleLine(this.options.subtitle))] : [])];
    return [...header, ...this.list.render(width), theme.fg("dim", "↑↓/PgUp/PgDn · invio seleziona · esc chiude")].map((line) => truncateToWidth(line, width));
  }
  handleInput(data: string): void {
    if (this.disposed) return;
    const { keys, items } = this.options;
    if (keys.matches(data, "tui.select.cancel")) return this.finish();
    if (keys.matches(data, "tui.select.confirm")) return this.finish(items[this.index]?.value);
    if (keys.matches(data, "tui.select.up")) this.index--;
    else if (keys.matches(data, "tui.select.down")) this.index++;
    else if (keys.matches(data, "tui.select.pageUp")) this.index -= this.rows || 1;
    else if (keys.matches(data, "tui.select.pageDown")) this.index += this.rows || 1;
    else return;
    this.index = Math.max(0, Math.min(items.length - 1, this.index)); this.list?.setSelectedIndex(this.index); this.options.tui.requestRender();
  }
}
export interface ComposeResult { result?: DeliveryResult; pending?: boolean }
export class Compose implements Component, Focusable {
  readonly editor: Editor;
  private readonly options: Shared & { title: string; send(text: string, messageId: string, signal: AbortSignal): Promise<DeliveryResult>; done(result: ComposeResult): void };
  private readonly controller = new AbortController();
  private disposed = false;
  private sending = false;
  private lastText?: string;
  private messageId?: string;
  private result?: DeliveryResult;
  private readonly abort = () => this.finish();
  constructor(options: Shared & { title: string; send(text: string, messageId: string, signal: AbortSignal): Promise<DeliveryResult>; done(result: ComposeResult): void }) {
    this.options = options;
    this.editor = new Editor(options.tui, { borderColor: (text) => options.theme.fg("border", text), selectList: listTheme(options.theme) }, { paddingX: 0 });
    this.editor.onSubmit = (text) => { void this.submit(text); };
    options.signal.addEventListener("abort", this.abort, { once: true });
    if (options.signal.aborted) queueMicrotask(this.abort);
  }
  get focused(): boolean { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }
  private finish(): void { if (!this.disposed) { const outcome = { result: this.result, pending: this.sending }; this.dispose(); this.options.done(outcome); } }
  dispose(): void { this.disposed = true; this.controller.abort(); this.options.signal.removeEventListener("abort", this.abort); }
  invalidate(): void { this.editor.invalidate(); }
  render(width: number): string[] {
    width = Math.max(1, width);
    const { theme } = this.options;
    const status = this.sending ? "Invio…" : this.result ? deliveryLabel(this.result) : "Invio esplicito · nessuna conferma aggiuntiva";
    // Pi 0.99.1 Editor recurses on a wide grapheme in a one-column layout. Render a safe minimum, then clip only the view.
    return [theme.fg("accent", singleLine(this.options.title)), ...this.editor.render(Math.max(3, width)), theme.fg(this.result ? "warning" : "muted", singleLine(status)),
      theme.fg("dim", "Invio invia/riprova · Shift+Invio nuova riga · Esc chiude (non annulla il lavoro)")].map((line) => truncateToWidth(line, width));
  }
  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.options.keys.matches(data, "tui.select.cancel")) return this.finish();
    if (!this.sending) { this.editor.handleInput(data); this.options.tui.requestRender(); }
  }
  private async submit(text: string): Promise<void> {
    if (this.disposed || this.sending || !text.trim()) return;
    if (text !== this.lastText || this.result?.delivery === "failed" && this.result.outcomeKnown) { this.lastText = text; this.messageId = randomUUID(); }
    // Stock Editor clears on submit; keep the draft visible and available for an explicit retry.
    this.editor.setText(text); this.sending = true; this.options.tui.requestRender();
    try { this.result = await this.options.send(text, this.messageId!, this.controller.signal); }
    catch (error) { this.result = { messageId: this.messageId!, delivery: "unknown", outcomeKnown: false, retryable: false,
      code: error instanceof Error ? error.message : "send_failed" }; }
    if (this.disposed) return;
    this.sending = false; this.editor.setText(text);
    if (this.result.delivery === "socket_delivered" || this.result.delivery === "queued") this.finish();
    else this.options.tui.requestRender();
  }
}
