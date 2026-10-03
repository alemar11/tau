import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ClientError, type OpenspaceClient } from "../../src/client/client.ts";
import { normalizeSpecificWorkgroups } from "../../src/workgroups.ts";
import { object } from "../../src/registry/session.ts";

export const WORKGROUP_ENTRY = "openspace_workgroups";
export function restoredWorkgroups(ctx: ExtensionContext, seed: string[]): string[] {
  // Membership is session-wide, not branch-sensitive. Copied fork entries belong to their original Pi ID.
  const id = ctx.sessionManager.getSessionId();
  for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
    if (entry.type !== "custom" || entry.customType !== WORKGROUP_ENTRY || !object(entry.data) || entry.data.sessionId !== id) continue;
    if (entry.data.version !== 1 || !Array.isArray(entry.data.specific)) throw new ClientError("invalid_workgroup_preference");
    return normalizeSpecificWorkgroups(entry.data.specific);
  }
  return normalizeSpecificWorkgroups(seed);
}
export class WorkgroupPreferences {
  private serial: Promise<unknown> = Promise.resolve();
  private readonly pi: ExtensionAPI;
  private readonly client: OpenspaceClient;
  private readonly sessionId: string;
  private readonly context: () => ExtensionContext;
  private readonly guard: () => void;
  private readonly writable: () => Promise<void>;
  constructor(pi: ExtensionAPI, client: OpenspaceClient, context: () => ExtensionContext, guard: () => void, writable = async () => {}) {
    this.pi = pi; this.client = client; this.context = context; this.guard = guard; this.writable = writable;
    this.sessionId = context().sessionManager.getSessionId();
  }
  mutate(change: (current: string[]) => string[]): Promise<{ specific: string[]; effective: string[]; saved: true }> {
    const task = this.serial.then(async () => {
      this.guard();
      const info = await this.client.mutateWorkgroups(change);
      this.guard();
      await this.writable(); this.guard();
      if (this.context().sessionManager.getSessionId() !== this.sessionId) throw new ClientError("session_ended");
      const specific = info.workgroups.filter((group) => group !== "default");
      try { this.pi.appendEntry(WORKGROUP_ENTRY, { version: 1, sessionId: this.sessionId, specific }); }
      catch (cause) { throw new ClientError("preference_save_failed", { cause }); }
      return { specific, effective: info.workgroups, saved: true as const };
    });
    this.serial = task.catch(() => {}); return task;
  }
}
