# Outbox e identità locale

API disponibile tramite `openspace/extension-api`, senza import runtime di Pi, socket o loader TypeScript. Il bus `pi.events` è locale alla sessione e non riproduce eventi precedenti. Queste API servono estensioni cooperative: non autenticano né isolano codice già autorizzato nel processo.

## Invio attribuito

Ascoltare `OPENSPACE_OUTBOX_RESULT_EVENT` **prima** di emettere `OPENSPACE_OUTBOX_REQUEST_EVENT`:

```ts
import { randomUUID } from "node:crypto";
import {
  OPENSPACE_OUTBOX_REQUEST_EVENT, OPENSPACE_OUTBOX_RESULT_EVENT,
  type OutboxRequest, type OutboxResult,
} from "openspace/extension-api";

const id = randomUUID(); // Nuovo in tutto il runtime, non soltanto per questa estensione.
const unsubscribe = pi.events.on(OPENSPACE_OUTBOX_RESULT_EVENT, (value) => {
  const result = value as OutboxResult;
  if (result?.version === 1 && result.requestId === id) {
    unsubscribe();
    // Osservare status/code/delivery/outcomeKnown; non dedurre completamento del lavoro.
  }
});
const request: OutboxRequest = {
  version: 1, requestId: id,
  extensionId: "build-hook", extensionName: "Build hook",
  to: "worker", workgroup: "review", message: "Build fallita",
};
pi.events.emit(OPENSPACE_OUTBOX_REQUEST_EVENT, request);
// Rimuovere anche il listener a session_shutdown e delimitare l'attesa se Openspace non è caricato.
```

[`examples/outbox.ts`](examples/outbox.ts) mostra prenotazione prima di emit, cleanup su timeout/shutdown e guard contro contesti Pi scaduti. Caricarlo esplicitamente insieme al package:

```sh
pi -e ./packages/openspace -e ./packages/openspace/examples/outbox.ts
# /openspace-example-send <ID-completo> <testo>
```

L'esempio non viene caricato dal manifest Pi. Il suo timeout locale non annulla l'outbox e non autorizza un retry automatico.

### Routing, consenso e risultato

- Solo testo: niente attachments, ask/reply impliciti, cwd, pane, override del sender o nuove appartenenze. Campi extra vengono rifiutati.
- Ricerca tra peer **live**: ID esatto, nome/alias esatto case-insensitive, prefisso ID univoco. Assenza, ambiguità e self sono errori. La successiva risoluzione del ticket usa soltanto ID e gruppo già scelti.
- Zero gruppi comuni: errore; uno: automatico; più di uno: `workgroup_ambiguous`. `workgroup` seleziona un gruppo già comune, non modifica le appartenenze.
- Destinatario e gruppo restano fissati anche durante consenso, mutazioni dei nomi o reconnect. Uscita/rientro invalida la vecchia richiesta; nessun trasferimento a `default` o a una nuova sessione. Il normale retry di trasporto dopo rebound noto mantiene le membership originali.
- `confirmSend` mostra estensione, ID completo del peer, gruppo e testo. UI assente/non funzionante: `blocked/confirmation_unavailable`; rifiuto: `rejected/confirmation_cancelled`. Anche RPC può fornire il dialogo; nessun overlay è necessario.
- Ogni richiesta valida ammessa con ID univoco riceve un risultato terminale. `sent` significa `socket_delivered` o `queued`, non esecuzione/completamento. Un peer live al lookup può disconnettersi prima dell'invio: la mailbox mantiene il normale contratto RAM.
- Errori di routing/trasporto: `failed` con codice esplicito. Shutdown: `failed/session_ended`. Durante un invio già iniziato, fine sessione/disconnect possono produrre `delivery: "unknown", outcomeKnown: false`: non significano mancata consegna. Nessun reinvio dopo esito incerto.
- Senza runtime attivo, ma con Openspace caricato: `failed/openspace_unavailable`. Un ID di correlazione valido in una richiesta malformata riceve `rejected/invalid_outbox_request`; senza ID utilizzabile viene scritta soltanto una diagnostica stderr. Un processo o listener già terminato non può ricevere eventi.

Il risultato contiene `version`, `requestId`, `status` (`sent | rejected | blocked | failed`), eventuali `code`, `detail`, `extensionId`, `extensionName`, `messageId`, ID `to` e `workgroup` risolti, `delivery` e `outcomeKnown`. I risultati sono oggetti piatti congelati. `OPENSPACE_OUTBOX_CODES` esporta i codici propri dell'outbox; possono inoltre comparire i codici del client/routing descritti in [REGISTRY.md](REGISTRY.md) e [DELIVERY.md](DELIVERY.md).

### Unicità e limiti

`requestId` deve essere nuovo nell'intero runtime, **anche tra estensioni diverse**. Un duplicato riceve `rejected/duplicate_request` senza eliminare l'originale: durante un dialogo può quindi comparire prima `rejected`, poi l'originale `sent`, entrambi con lo stesso ID. Fuori dalla precondizione di unicità non esiste una distinzione affidabile tra tentativi. Nessuna coalescenza o `attemptId`; requestId non è il messageId del trasporto.

Limiti implementativi aggregati per runtime:

- 32 richieste pendenti e 8 MiB di richieste normalizzate; superamento: `blocked/outbox_pending_capacity`.
- 4.096 ID ammessi, inclusi quelli bloccati dalla capacità pending. Hash conservati fino a fine runtime, senza eviction; superamento: `blocked/outbox_id_capacity` fino al nuovo runtime.
- Richiesta completa: 1 MiB JSON UTF-8; il successivo envelope di trasporto deve comunque rientrare in 1 MiB.
- requestId: 1–256 byte UTF-8 senza controlli ASCII; extensionId/name non vuoti, trim, senza controlli, rispettivamente 128/256 byte UTF-8. Selettore `to` entro il limite del record da 6 KiB, workgroup canonico. Il testo non viene prefissato o normalizzato.

La provenienza strutturata `extension_outbox` e l'identità reale del sender compaiono nei details ricevuti e nella presentazione del messaggio. Il sender non attiva il proprio modello: registra una entry diagnostica `openspace_outbox_result` nella propria cronologia Pi. La trace è best effort, non una ricevuta durevole: viene omessa durante compattazione/fine sessione e un errore di salvataggio non cambia un esito di trasporto già noto. Le richieste rifiutate prima dell'ammissione non producono trace. Il receiver applica le normali politiche di [DELIVERY.md](DELIVERY.md).

## Claim dell'identità di routing

Installare il listener nel factory, non in un handler `session_start` che potrebbe essere eseguito dopo Openspace:

```ts
import { OPENSPACE_SESSION_IDENTITY_EVENT, type SessionIdentityRequest } from "openspace/extension-api";
const unsubscribe = pi.events.on(OPENSPACE_SESSION_IDENTITY_EVENT, (value) => {
  const request = value as SessionIdentityRequest;
  if (request?.version === 1) request.claim("my-session-owner-id"); // Soltanto se questa estensione possiede la sessione.
});
pi.on("session_shutdown", (event) => {
  if (event.reason === "quit" || event.reason === "reload") unsubscribe();
});
```

A ogni `session_start` abilitato, prima della registrazione, Openspace emette `{ version: 1, claim(id): boolean }`. Prima claim valida non vuota vince; successive, vuote/invalide o ritardate dopo il ritorno di emit restituiscono `false`. Un listener può essere async, ma deve chiamare `claim` **prima** del primo await. Il payload è congelato; chiamate ritardate non modificano il runtime.

Precedenza: **claim → `PI_OPENSPACE_STABLE_ID` → `stableId` config → ID nativo Pi**. Nessuna modifica al nome della sessione o a `process.env`. Le preferenze dei workgroup restano legate all'ID **nativo Pi**, non alla claim. Tutti i factory vengono caricati prima del lifecycle: il listener può essere caricato prima o dopo Openspace. Fra più claimant vince intenzionalmente la prima claim sincrona valida.

L'ID è globale nel broker: due sessioni che reclamano lo stesso ID possono provocare takeover anche in gruppi distinti. Usare un'identità deliberatamente posseduta, non una costante condivisa accidentalmente da tutti i processi. La claim non costituisce autenticazione e non implementa integrazioni Subagents/Herdr.
