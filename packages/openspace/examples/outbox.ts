import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPENSPACE_OUTBOX_REQUEST_EVENT, OPENSPACE_OUTBOX_RESULT_EVENT, type OutboxRequest, type OutboxResult } from "openspace/extension-api";

/** Load explicitly alongside Openspace. This example is not a bundled Pi entry point. */
export default function example(pi: ExtensionAPI): void {
  let generation = 0;
  const pending = new Map<string, (result?: OutboxResult) => void>();
  const remove = pi.events.on(OPENSPACE_OUTBOX_RESULT_EVENT, (value) => {
    const result = value as OutboxResult;
    if (result?.version === 1) pending.get(result.requestId)?.(result);
  });
  pi.on("session_shutdown", (event) => {
    generation++;
    for (const finish of [...pending.values()]) finish();
    if (event.reason === "quit" || event.reason === "reload") remove();
  });
  pi.registerCommand("openspace-example-send", {
    description: "Esempio outbox: <ID-destinatario> <testo> (un solo gruppo condiviso)",
    async handler(args, ctx) {
      const match = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
      const notice = (text: string) => { if (ctx.hasUI) ctx.ui.notify(text, "info"); else console.error(text); };
      if (!match || pending.size >= 8) { notice("Uso: /openspace-example-send <ID> <testo>; massimo 8 richieste in attesa."); return; }
      const epoch = generation, requestId = randomUUID();
      // Subscribe/reserve BEFORE emit: local results may be synchronous. Never reuse this ID, including on timeout.
      const result = new Promise<OutboxResult | undefined>((resolve) => {
        const timer = setTimeout(() => finish(), 60_000); timer.unref();
        const finish = (value?: OutboxResult) => { clearTimeout(timer); pending.delete(requestId); resolve(value); };
        pending.set(requestId, finish);
      });
      const request: OutboxRequest = { version: 1, requestId, extensionId: "openspace-example", extensionName: "Outbox example", to: match[1], message: match[2] };
      pi.events.emit(OPENSPACE_OUTBOX_REQUEST_EVENT, request);
      const outcome = await result;
      if (epoch !== generation) return; // Never touch the old context after session replacement/reload.
      notice(outcome ? `Openspace: ${outcome.status}${outcome.code ? ` (${outcome.code})` : ""}; non prova completamento.`
        : "Nessun esito osservato: l'invio non è stato annullato. Non ritentare automaticamente.");
    },
  });
}
