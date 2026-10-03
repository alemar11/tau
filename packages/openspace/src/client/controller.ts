import { systemClock, type Clock } from "../clock.ts";
import { ClientError, OpenspaceClient } from "./client.ts";

export const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
export interface ControllerOptions {
  client: OpenspaceClient;
  /** Extension-only hook, usually ensureBroker. The core and CLI never spawn. */
  ensureBroker?: () => Promise<unknown>;
  clock?: Clock;
  onWarning?: (error: Error) => void;
}
function permanent(error: unknown): boolean {
  if (error instanceof ClientError) return !error.retryable;
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return ["EACCES", "EPERM", "ENOENT", "MODULE_NOT_FOUND"].includes(code ?? "")
    || /requires a Node\.js|inspect it manually|refusing to|Invalid Openspace|incompatible/i.test(error.message)
    || (error.cause !== undefined && permanent(error.cause));
}

/** One session lifetime. stop() is terminal; a replacement session gets its own controller/client. */
export class ConnectionController {
  readonly client: OpenspaceClient;
  private readonly options: ControllerOptions;
  private readonly clock: Clock;
  private alive = false;
  private stopped = false;
  private generation = 0;
  private flight?: Promise<OpenspaceClient>;
  private cancelRetry?: () => void;
  private failures = 0;
  private halted?: Error;
  private readonly unsubscribe: () => void;
  constructor(options: ControllerOptions) {
    this.options = options; this.client = options.client; this.clock = options.clock ?? systemClock;
    this.unsubscribe = this.client.subscribe((event) => {
      if (!this.alive || event.type !== "state") return;
      if (event.state === "revoked") this.halt(event.error ?? new ClientError("endpoint_revoked"));
      else if (event.state === "disconnected") {
        if (event.error && permanent(event.error)) this.halt(event.error);
        else if (!this.flight) this.schedule();
      }
    });
  }
  get isRunning(): boolean { return this.alive && !this.halted; }
  start(): void {
    if (this.stopped) throw new ClientError("session_ended");
    if (this.alive) return;
    this.alive = true;
    void this.ensureConnected().catch(() => {});
  }
  private halt(error: Error): void {
    if (this.halted) return;
    this.halted = error;
    this.cancelRetry?.(); this.cancelRetry = undefined;
    try { void Promise.resolve(this.options.onWarning?.(error)).catch(() => {}); } catch { /* Host diagnostics cannot revive a revoked runtime. */ }
  }
  private schedule(): void {
    if (!this.isRunning || this.flight || this.cancelRetry || this.client.isConnected) return;
    const generation = this.generation;
    const delay = RECONNECT_DELAYS[Math.min(this.failures++, RECONNECT_DELAYS.length - 1)];
    this.cancelRetry = this.clock.after(delay, () => {
      this.cancelRetry = undefined;
      if (generation === this.generation && this.isRunning) void this.ensureConnected().catch(() => {});
    }, true);
  }
  ensureConnected(): Promise<OpenspaceClient> {
    if (this.halted) return Promise.reject(this.halted);
    if (!this.alive || this.stopped) return Promise.reject(new ClientError("session_ended"));
    if (this.flight) return this.flight;
    if (this.client.isConnected) return Promise.resolve(this.client);
    this.cancelRetry?.(); this.cancelRetry = undefined;
    const generation = this.generation;
    const task = Promise.resolve().then(async () => {
      await this.options.ensureBroker?.();
      if (generation !== this.generation || !this.isRunning) throw new ClientError("session_ended");
      await this.client.connect();
      if (generation !== this.generation || !this.isRunning) throw new ClientError("session_ended");
      this.failures = 0;
      return this.client;
    });
    this.flight = task;
    const finish = (error?: unknown) => {
      if (this.flight !== task) return;
      // Clear before scheduling: retaining the in-flight promise suppresses all future retries.
      this.flight = undefined;
      if (generation !== this.generation || !this.isRunning) return;
      if (error && permanent(error)) this.halt(error instanceof Error ? error : new Error("Connection failed"));
      else if (!this.client.isConnected) this.schedule();
    };
    void task.then(() => finish(), (error) => finish(error));
    return task;
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; this.alive = false; this.generation++;
    this.cancelRetry?.(); this.cancelRetry = undefined;
    this.unsubscribe();
    await this.client.disconnect();
  }
}
