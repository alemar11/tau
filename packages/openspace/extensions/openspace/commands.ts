import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ClientError } from "../../src/client/client.ts";
import { normalizeSpecificWorkgroups } from "../../src/workgroups.ts";
import type { PiRuntime } from "./runtime.ts";
import { Compose, Picker } from "./ui/overlay.ts";
import { deliveryLabel, peerDetail, peerLabel, singleLine } from "./ui/render.ts";

const overlay = { overlay: true, overlayOptions: { width: "95%" as const, maxHeight: "85%" as const, anchor: "center" as const } };
function notice(ctx: ExtensionContext, text: string, kind: "info" | "error" | "warning" = "info"): void {
  const safe = singleLine(text);
  if (ctx.hasUI) ctx.ui.notify(safe, kind); else console.error(safe);
}
export function registerCommands(pi: ExtensionAPI, current: () => PiRuntime | undefined): void {
  const open = new WeakSet<PiRuntime>();
  const command = (name: string, description: string, run: (args: string, ctx: ExtensionContext, runtime: PiRuntime) => Promise<void>) => {
    pi.registerCommand(name, { description, handler: async (args, ctx) => {
      const runtime = current();
      if (!runtime) { notice(ctx, "Openspace non abilitato", "error"); return; }
      try { await runtime.ready(ctx); await run(args.trim(), ctx, runtime); }
      catch (error) {
        if (current() !== runtime || runtime.signal.aborted) return;
        runtime.assertCurrent(ctx);
        notice(ctx, `Openspace: ${error instanceof Error ? error.message : "command_failed"} · gruppi live ${JSON.stringify(runtime.client.info?.workgroups ?? [])}`, "error");
      }
    } });
  };
  command("openspace", "Scegli un peer locale e componi un messaggio", async (_args, ctx, runtime) => {
    if (ctx.mode !== "tui") { notice(ctx, "Il roster interattivo richiede TUI; usare il tool openspace (list/send/ask).", "warning"); return; }
    if (open.has(runtime)) throw new ClientError("ui_already_open");
    open.add(runtime);
    try {
      const sessions = await runtime.client.listSessions(); runtime.assertCurrent(ctx);
      const self = runtime.client.info!, peers = sessions.filter((session) => session.id !== self.id);
      const stamps = new Map(self.workgroups.map((group) => [group, runtime.client.membership(group)]));
      if (!peers.length) { notice(ctx, `Nessun peer visibile · gruppi ${JSON.stringify(self.workgroups)}`); return; }
      const id = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => new Picker({ tui, theme, keys, done, signal: runtime.signal,
        title: `Openspace · tu: ${peerLabel(self, sessions)}`, subtitle: peerDetail(self),
        items: peers.map((peer) => ({ value: peer.id, label: peerLabel(peer, sessions), description: peerDetail(peer) })) }), overlay);
      runtime.assertCurrent(ctx); if (!id) return;
      const peer = peers.find((session) => session.id === id)!;
      const groups = peer.workgroups.filter((group) => stamps.has(group));
      if (!groups.length) throw new ClientError("workgroup_not_shared");
      let workgroup: string | undefined = groups[0];
      if (groups.length > 1) workgroup = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => new Picker({ tui, theme, keys, done,
        signal: runtime.signal, title: `Workgroup per ${peerLabel(peer, sessions)}`, items: groups.map((group) => ({ value: group, label: singleLine(group) })) }), overlay);
      runtime.assertCurrent(ctx); if (!workgroup) return;
      if (!runtime.client.hasMembership(stamps.get(workgroup)!)) throw new ClientError("workgroup_left");
      const selected = await runtime.messenger.resolve({ to: id, workgroup }); runtime.assertCurrent(ctx);
      if (!runtime.client.hasMembership(stamps.get(workgroup)!)) throw new ClientError("workgroup_left");
      const outcome = await ctx.ui.custom<import("./ui/overlay.ts").ComposeResult>((tui, theme, keys, done) => new Compose({ tui, theme, keys, done,
        signal: runtime.signal, title: `A ${peerLabel(peer, sessions)} · gruppo ${workgroup}`,
        send: async (text, messageId, signal) => {
          runtime.assertCurrent(ctx);
          const result = await runtime.messenger.sendResolved(selected, { text, messageId, signal: AbortSignal.any([signal, runtime.signal]) });
          runtime.assertCurrent(ctx); return result;
        } }), overlay);
      runtime.assertCurrent(ctx);
      if (outcome.pending) notice(ctx, "Compose chiuso durante l'invio: la consegna può essere già avvenuta; il lavoro remoto non è annullato.", "warning");
      else if (outcome.result) notice(ctx, `${deliveryLabel(outcome.result)} · ID ${outcome.result.messageId}`, outcome.result.delivery === "socket_delivered" ? "info" : "warning");
    } finally { open.delete(runtime); }
  });
  command("openspace-alias", "Rinomina la sessione Pi e la presence Openspace", async (args, ctx, runtime) => {
    let name: string | undefined = args;
    if (!name) {
      if (!ctx.hasUI) { notice(ctx, "Uso: /openspace-alias <nome>", "warning"); return; }
      name = await ctx.ui.input("Nome sessione Openspace", pi.getSessionName(), { signal: runtime.signal });
      runtime.assertCurrent(ctx); if (name === undefined) return;
    }
    name = name.trim(); if (!name) throw new ClientError("invalid_metadata");
    await runtime.client.updatePresence({ name }); runtime.assertCurrent(ctx);
    pi.setSessionName(name); runtime.assertCurrent(ctx);
    notice(ctx, `Alias aggiornato: ${name}`);
  });
  command("openspace-id", "Inserisci il contatto con ID completo, senza avviare un turno", async (_args, ctx, runtime) => {
    const info = runtime.client.info!;
    const contact = `Openspace: ${JSON.stringify({ id: info.id, name: info.name ?? info.runtimeFallbackAlias, workgroups: info.workgroups })}`;
    if (ctx.mode === "tui") ctx.ui.pasteToEditor(contact); else notice(ctx, contact);
  });
  command("openspace-workgroups", "Elenca i gruppi; add/remove <nome> salva per questa sessione Pi", async (args, ctx, runtime) => {
    if (!args) { notice(ctx, `Workgroup effettivi: ${JSON.stringify(runtime.client.info!.workgroups)} · default è il fallback esclusivo`); return; }
    const match = /^(add|remove)\s+(.+)$/.exec(args);
    if (!match) throw new ClientError("usage: /openspace-workgroups [add|remove <nome>]");
    const group = normalizeSpecificWorkgroups([match[2]!])[0]!;
    let before: string[] = [];
    const result = await runtime.preferences.mutate((groups) => {
      before = groups.length ? groups : ["default"];
      return match[1] === "add" ? [...groups, group] : groups.filter((item) => item !== group);
    });
    runtime.assertCurrent(ctx);
    notice(ctx, `Workgroup salvati: ${JSON.stringify(before)} → ${JSON.stringify(result.effective)}${result.specific.length ? " · default escluso" : " · fallback default ripristinato"}`);
  });
}
