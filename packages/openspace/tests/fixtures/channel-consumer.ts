import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPENSPACE_EXTENSION_REGISTER_EVENT, OPENSPACE_EXTENSION_REGISTRY_READY_EVENT, type ChannelEvent, type ExtensionChannel } from "openspace/extension-api";

/** A separately loaded consumer: only the installed public API and this session's Pi bus. */
export default function consumer(pi: ExtensionAPI): void {
  const channels: ExtensionChannel[] = [], events: ChannelEvent[] = [], published: unknown[] = [], errors: unknown[] = [];
  const register = () => pi.events.emit(OPENSPACE_EXTENSION_REGISTER_EVENT, {
    namespace: "fixture", ownerEligible: true,
    onReady(channel: ExtensionChannel) {
      channels.push(channel);
      void channel.publish({ hello: "世界" }, { audience: "capable" }).then((result) => published.push(result), (error) => errors.push(error));
    },
    onEvent(event: ChannelEvent) { events.push(event); },
  });
  const removeReady = pi.events.on(OPENSPACE_EXTENSION_REGISTRY_READY_EVENT, register);
  const removeInspect = pi.events.on("fixture:inspect-channel", (value) => {
    (value as { inspect(data: unknown): void }).inspect({ channels, events, published, errors });
  });
  register();
  pi.on("session_shutdown", (event) => { if (event.reason === "quit" || event.reason === "reload") { removeReady(); removeInspect(); } });
}
