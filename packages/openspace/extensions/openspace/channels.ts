import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPENSPACE_EXTENSION_REGISTER_EVENT, OPENSPACE_EXTENSION_REGISTRY_READY_EVENT, type ExtensionRegistration } from "../../extension-api.mjs";
import { ChannelManager, channelCallback } from "../../src/client/channels.ts";
import { CHANNEL_LIMITS, channelGroup, namespace } from "../../src/protocol/channels.ts";
import { object } from "../../src/registry/session.ts";
import { ClientError } from "../../src/client/client.ts";

/** Factory-time, session-local handshake. Each runtime gets new channel objects; consumers retain no authority through old handles. */
export class ChannelRegistry {
  private readonly definitions = new Map<string, ExtensionRegistration>();
  private readonly unsubscribe: () => void;
  private manager?: ChannelManager;
  private unavailable?: string;
  private disposed = false;
  constructor(events: ExtensionAPI["events"]) {
    this.unsubscribe = events.on(OPENSPACE_EXTENSION_REGISTER_EVENT, (input) => this.register(input));
    // Consumers loaded earlier retry on this event; consumers loaded later also emit their registration once directly.
    events.emit(OPENSPACE_EXTENSION_REGISTRY_READY_EVENT, { version: 1 });
  }
  private report(input: unknown, code: string): void {
    if (object(input) && typeof input.onEvent === "function") channelCallback(input.onEvent as ExtensionRegistration["onEvent"], { type: "error", code });
    else console.error(`Openspace extension registration: ${code}`);
  }
  private register(input: unknown): void {
    try {
      if (this.disposed || this.unavailable) throw new ClientError(this.unavailable ?? "session_ended");
      if (!object(input) || typeof input.ownerEligible !== "boolean" || typeof input.onReady !== "function" || typeof input.onEvent !== "function") throw new ClientError("invalid_registration");
      const ns = namespace(input.namespace), group = input.workgroup === undefined ? undefined : channelGroup(input.workgroup);
      const key = JSON.stringify([group ?? null, ns]);
      if (this.definitions.has(key)) throw new ClientError("duplicate_channel");
      if (this.definitions.size >= CHANNEL_LIMITS.capabilities) throw new ClientError("capability_capacity");
      const registration: ExtensionRegistration = { namespace: ns, workgroup: group, ownerEligible: input.ownerEligible,
        onReady: input.onReady as ExtensionRegistration["onReady"], onEvent: input.onEvent as ExtensionRegistration["onEvent"] };
      this.manager?.register(registration); this.definitions.set(key, registration);
    } catch (error) { this.report(input, error instanceof Error ? error.message : "invalid_registration"); }
  }
  start(manager: ChannelManager): void {
    this.manager = manager; this.unavailable = undefined;
    for (const registration of this.definitions.values()) {
      try { manager.register(registration); }
      catch (error) { this.report(registration, error instanceof Error ? error.message : "invalid_registration"); }
    }
  }
  pause(): void { this.manager = undefined; this.unavailable = undefined; }
  disable(code = "openspace_disabled"): void { this.manager = undefined; this.unavailable = code; for (const registration of this.definitions.values()) this.report(registration, code); }
  dispose(): void { this.disposed = true; this.manager = undefined; this.unsubscribe(); this.definitions.clear(); }
}
