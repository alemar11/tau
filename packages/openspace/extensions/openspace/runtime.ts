import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OpenspaceClient, ClientError } from "../../src/client/client.ts";
import { ConnectionController } from "../../src/client/controller.ts";
import { Conversation } from "../../src/client/conversation.ts";
import { messageRef, refKey, type MessageRef } from "../../src/protocol/delivery.ts";
import { Messenger, type SendOptions } from "../../src/client/messenger.ts";
import { ensureBroker } from "../../src/broker/spawn.ts";
import type { OpenspaceConfig, OpenspaceEnvironment } from "../../src/config.ts";
import type { OpenspacePaths } from "../../src/paths.ts";
import type { SessionStatus } from "../../src/registry/session.ts";
import type { Message } from "../../src/protocol/delivery.ts";
import { Receiver, BUSY_NOTICE, messageContent } from "./receiver.ts";
import { restoredWorkgroups, WorkgroupPreferences } from "./preferences.ts";
import { singleLine } from "./ui/render.ts";

export class PiRuntime {
  readonly client: OpenspaceClient;
  readonly controller: ConnectionController;
  readonly messenger: Messenger;
  readonly conversation: Conversation;
  readonly receiver: Receiver;
  readonly preferences: WorkgroupPreferences;
  readonly config: OpenspaceConfig;
  readonly sessionId: string;
  private readonly pi: ExtensionAPI;
  private ctx: ExtensionContext;
  private alive = true;
  private running = false;
  private compacting = false;
  private readonly tools = new Map<string, string>();
  private note?: string;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeReceipts: () => void;
  private desired?: Record<string, unknown>;
  private publishing = false;
  private lastPresence?: string;
  private readonly lifetime = new AbortController();
  constructor(pi: ExtensionAPI, ctx: ExtensionContext, paths: OpenspacePaths, config: OpenspaceConfig, environment: OpenspaceEnvironment) {
    this.pi = pi; this.ctx = ctx; this.config = config; this.sessionId = ctx.sessionManager.getSessionId(); this.note = config.status;
    this.client = new OpenspaceClient({ socketPath: paths.socketPath, session: {
      id: environment.stableId ?? config.stableId ?? this.sessionId, cwd: ctx.cwd, pid: process.pid,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown", name: pi.getSessionName(), status: this.status() },
      workgroups: restoredWorkgroups(ctx, environment.workgroups), heartbeatMs: environment.livenessIntervalMs, heartbeatTimeoutMs: environment.livenessTimeoutMs });
    this.controller = new ConnectionController({ client: this.client, ensureBroker: () => ensureBroker(paths, config), onWarning: (error) => this.warn(error) });
    this.messenger = new Messenger(this.client);
    this.conversation = new Conversation(this.messenger, { timeoutMs: environment.askTimeoutMs, trackerTimeoutMs: environment.askTimeoutMs,
      onAnswered: (ref) => this.receiver.answered(ref) });
    this.receiver = new Receiver(this.messenger, {
      accept: (message) => this.conversation.accept(message),
      state: () => {
        // Some cancelled compactions have no completion notification. Pi's authoritative idle state closes that gap.
        if (this.ctx.isIdle()) this.compacting = false;
        return { alive: this.alive, idle: this.ctx.isIdle(), running: this.running, interactive: this.ctx.mode === "tui",
          compacting: this.compacting, pending: this.ctx.hasPendingMessages() };
      },
      inject: (message, triggerTurn, steer) => {
        this.assertCurrent();
        this.pi.sendMessage({ customType: "openspace_message", display: true, content: messageContent(message) + (message.expectsReply && this.config.replyHint && this.conversation.tracker.has(messageRef(message)) ? `\n\nUse openspace action reply with replyTo ${JSON.stringify(messageRef(message))} to answer this ask.` : ""),
          details: { direction: "received", message, injectedAt: Date.now() } }, { triggerTurn, ...(steer ? { deliverAs: "steer" } : {}) });
      },
      busy: (message) => this.busy(message),
    }, config);
    this.preferences = new WorkgroupPreferences(pi, this.client, () => this.ctx, () => this.assertCurrent(), async () => {
      while (true) {
        this.assertCurrent();
        if (this.ctx.isIdle()) this.compacting = false;
        if (!this.compacting && (this.running || this.ctx.isIdle())) return;
        await delay(250, undefined, { signal: this.signal, ref: false });
      }
    });
    const receipts = new Map<string, string>();
    this.unsubscribeReceipts = this.messenger.subscribe((event) => {
      if (!this.alive || !this.ctx.hasUI || event.type !== "receipt") return;
      const { receipt } = event;
      if (!["injected", "expired", "cancelled", "superseded", "cancellation_requested"].includes(receipt.status)) return;
      const key = refKey(receipt.ref);
      if (receipts.get(key) === receipt.status) return;
      receipts.delete(key); receipts.set(key, receipt.status);
      if (receipts.size > 256) receipts.delete(receipts.keys().next().value!);
      this.ctx.ui.notify(singleLine(`Openspace · ${receipt.ref.messageId} [${receipt.ref.workgroup}] · ${receipt.status}${receipt.code ? ` (${receipt.code})` : ""} · non prova completamento`), receipt.status === "injected" ? "info" : "warning");
    });
    this.unsubscribe = this.client.subscribe((event) => {
      if (!this.alive) return;
      if (event.type === "session") this.receiver.flush();
      if (event.type === "state" && event.state === "revoked") this.receiver.stop("endpoint_revoked");
      if (event.type === "state" && event.state === "registered") { this.lastPresence = undefined; this.publishPresence(); }
    });
  }
  start(): void { this.controller.start(); }
  get context(): ExtensionContext { return this.ctx; }
  get signal(): AbortSignal { return this.lifetime.signal; }
  assertCurrent(ctx = this.ctx): void {
    if (!this.alive || ctx.sessionManager.getSessionId() !== this.sessionId || this.ctx.sessionManager.getSessionId() !== this.sessionId) throw new ClientError("session_ended");
  }
  use(ctx: ExtensionContext): void { this.assertCurrent(ctx); this.ctx = ctx; }
  async ready(ctx = this.ctx): Promise<void> { this.use(ctx); await this.controller.ensureConnected(); this.assertCurrent(ctx); }
  private status(): SessionStatus {
    const toolName = [...this.tools.values()].at(-1);
    return { ...(toolName ? { state: "tool" as const, toolName } : { state: this.running ? "thinking" as const : "idle" as const }),
      ...(this.note === undefined ? {} : { note: this.note }) };
  }
  private patch(): Record<string, unknown> {
    const usage = this.ctx.getContextUsage();
    return { name: this.pi.getSessionName() ?? null, model: this.ctx.model ? `${this.ctx.model.provider}/${this.ctx.model.id}` : "unknown",
      status: this.status(), contextUsage: usage?.tokens === null || !usage ? null : usage };
  }
  publishPresence(): void {
    if (!this.alive) return;
    this.desired = this.patch();
    if (this.publishing || !this.client.isConnected) return;
    this.publishing = true;
    void (async () => {
      while (this.alive && this.client.isConnected && this.desired) {
        const patch = this.desired; this.desired = undefined;
        const serialized = JSON.stringify(patch);
        if (serialized === this.lastPresence) continue;
        try { await this.client.updatePresence(patch); if (this.alive) this.lastPresence = serialized; }
        catch (error) { this.warn(error); }
      }
    })().finally(() => { this.publishing = false; });
  }
  async setNote(note: string | null): Promise<void> {
    this.assertCurrent();
    const status = { ...this.status() }; delete status.note;
    if (note !== null) status.note = note;
    await this.client.updatePresence({ status }); this.assertCurrent();
    this.note = note ?? undefined; this.publishPresence();
  }
  event(type: string, ctx: ExtensionContext, data?: { toolCallId?: string; toolName?: string }): void {
    this.use(ctx);
    if (type === "agent_start") this.running = true;
    // agent_end is not settlement: prohibit idle injection until Pi reports an actually safe boundary.
    if (type === "agent_end" || type === "agent_settled") { this.running = false; this.tools.clear(); }
    if (type === "agent_settled") this.conversation.activate();
    if (type === "session_before_compact") this.compacting = true;
    if (type === "session_compact" || type === "session_compact_failed") this.compacting = false;
    if (type === "tool_execution_start" && data?.toolCallId && data.toolName) this.tools.set(data.toolCallId, data.toolName);
    if (type === "tool_execution_end" && data?.toolCallId) this.tools.delete(data.toolCallId);
    if (type === "input") this.receiver.humanInput();
    if (type === "turn_start") this.receiver.turnStarted();
    this.publishPresence();
    if (["turn_end", "agent_settled", "session_compact", "session_compact_failed"].includes(type)) this.receiver.flush(true);
  }
  private busy(message: Message): void {
    if (message.expectsReply) void this.conversation.reply({ replyTo: messageRef(message) }, { text: BUSY_NOTICE, signal: this.signal }).catch(() => {});
    else void this.messenger.send(message.sender.id, { text: BUSY_NOTICE, workgroup: message.workgroup, signal: this.signal });
  }
  async ask(to: string | undefined, options: SendOptions) {
    await this.ready(); this.assertCurrent();
    return this.conversation.ask(to, { ...options, signal: options.signal ? AbortSignal.any([options.signal, this.signal]) : this.signal });
  }
  async reply(selector: { replyTo?: MessageRef; to?: string; workgroup?: string }, options: SendOptions) {
    await this.ready(); this.assertCurrent();
    return this.conversation.reply(selector, { ...options, signal: options.signal ? AbortSignal.any([options.signal, this.signal]) : this.signal });
  }
  async send(to: string | undefined, options: SendOptions, confirm = this.config.confirmSend) {
    const { signal: callerSignal, ...payload } = options; options = { ...structuredClone(payload), signal: callerSignal };
    await this.ready(); this.assertCurrent();
    if (options.replyTo) return this.reply({ replyTo: options.replyTo, to, workgroup: options.workgroup }, options);
    const inferred = this.conversation.infer(to, options.workgroup);
    const selected = await this.messenger.resolve({ to, cwd: options.cwd, workgroup: options.workgroup ?? inferred?.workgroup }); this.assertCurrent();
    const original = inferred?.sender.id === selected.session.id ? inferred : this.conversation.infer(selected.session.id, selected.workgroup);
    if (!original) this.conversation.guardSend(selected.session.id);
    const signal = options.signal ? AbortSignal.any([options.signal, this.signal]) : this.signal;
    if (confirm) {
      if (!this.ctx.hasUI) throw new ClientError("confirmation_unavailable");
      const approved = await this.ctx.ui.confirm("Openspace: inviare?", `A ${selected.session.name ?? selected.session.id} · ${selected.workgroup}\n${options.text}`, { signal });
      this.assertCurrent();
      if (!approved) throw new ClientError("confirmation_cancelled");
    }
    if (signal.aborted) throw new ClientError("aborted");
    if (!this.client.hasMembership(selected.stamp)) throw new ClientError("workgroup_left");
    const result = original ? await this.conversation.reply({ replyTo: messageRef(original) }, { ...options, cwd: undefined, signal })
      : await this.messenger.sendResolved(selected, { ...options, signal }); this.assertCurrent();
    // Diagnostic history is not an extra context message and cannot turn a successful transport write into a failed send.
    if (!this.compacting) {
      try { this.pi.appendEntry("openspace_sent", { to: selected.session.id, result, text: options.text, attachments: options.attachments }); }
      catch (error) { this.warn(error); }
    }
    return result;
  }
  warn(error: unknown): void {
    if (!this.alive) return;
    const text = error instanceof Error ? error.message : "Openspace error";
    const warning = `Openspace: ${text}. Pi continua; un'identità revocata non verrà reclamata automaticamente.`;
    if (this.ctx.hasUI) this.ctx.ui.notify(warning, "warning");
    else console.error(warning); // Keep stdout clean for JSON/print hosts.
  }
  async stop(): Promise<void> {
    if (!this.alive) return;
    this.alive = false; this.conversation.dispose(); this.lifetime.abort(); this.unsubscribe(); this.unsubscribeReceipts(); this.receiver.stop(); this.messenger.dispose();
    await this.controller.stop();
  }
}
