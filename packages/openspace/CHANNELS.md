# Canali per estensioni

`openspace/extension-api` esporta costanti JavaScript e tipi autonomi: importarlo non carica Pi, socket o loader TypeScript. Il bus `pi.events` è locale alla sessione; Openspace collega i consumer di sessioni diverse tramite il broker. I dati di questo percorso **non diventano messaggi conversazionali, entry Pi o turni modello**.

## Registrazione e handshake

Il consumer ascolta `openspace:extension-registry-ready` **e** invia una registrazione iniziale. Il primo percorso copre il caricamento prima di Openspace, il secondo quello dopo. L'evento ready indica che il listener locale è installato, non che il broker sia già connesso. Pi non fa replay degli eventi e non attende i listener asincroni.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  OPENSPACE_EXTENSION_REGISTER_EVENT,
  OPENSPACE_EXTENSION_REGISTRY_READY_EVENT,
  type ExtensionChannel,
  type ExtensionRegistration,
} from "openspace/extension-api";

export default function example(pi: ExtensionAPI) {
  let channel: ExtensionChannel | undefined;
  const registration: ExtensionRegistration = {
    namespace: "example.cache",
    // workgroup: "review", // obbligatorio se i gruppi effettivi sono più di uno
    ownerEligible: true,
    onReady(value) {
      channel = value;
      if (!value.snapshot().supported) return;
      void value.publish({ kind: "hello" }, { audience: "capable" }).catch(() => {
        // Gestire l'errore: non ripubblicare automaticamente un esito incerto.
      });
    },
    onEvent(event) {
      if (event.type === "state_result") {
        // Associare event.requestId all'ID restituito da commitState().
        // committed, rejected e unknown sono esiti distinti.
      }
      // Non rispedire automaticamente ogni message: capable include il mittente.
    },
  };
  const register = () => pi.events.emit(OPENSPACE_EXTENSION_REGISTER_EVENT, registration);
  const unsubscribe = pi.events.on(OPENSPACE_EXTENSION_REGISTRY_READY_EVENT, register);
  register();
  pi.on("session_shutdown", (event) => {
    channel = undefined;
    if (event.reason === "quit" || event.reason === "reload") unsubscribe();
  });
}
```

Namespace case-sensitive: 1–64 caratteri, alfabeto `[a-zA-Z0-9._-]`, primo carattere alfanumerico. Il workgroup esplicito deve essere effettivo nella sessione; con un solo gruppo è selezionato automaticamente. Non si aggiungono appartenenze mediante registrazione.

Una coppia gruppo/namespace può essere registrata una sola volta per runtime locale; i duplicati producono `error/duplicate_channel`. Sono ammessi **32 binding complessivi**, non 32 per gruppo. Le definizioni restano riservate per la vita del runtime, anche mentre il gruppo è assente. Config disabilitata produce `openspace_disabled`, senza avviare risorse.

Su broker compatibile, `onReady` avviene **dopo l'ack della capability**: pubblicare subito è valido. È chiamato una volta per handle; reconnect e rientro nel gruppo aggiornano lo stesso handle tramite eventi. Una nuova sessione/runtime riceve nuovi handle e quelli vecchi restano inutilizzabili. I consumer devono ripulire i propri listener al quit/reload e proteggere le proprie continuazioni asincrone dal cambio di sessione.

## Operazioni ed eventi

- `snapshot()`: copia indipendente di `connected`, `supported`, owner e stato opzionali. Mutarla non modifica le cache interne.
- `publish(payload, { audience: "owner" | "capable", ownerOnly? })`: invio JSON non durevole. `capable` include tutti i binding della coppia, **anche il mittente**; `owner` seleziona il proprietario corrente. `ownerOnly: true` limita chi può pubblicare, non sostituisce la scelta dell'audience.
- Risultato publish: conteggi `written`, `failed`, `unknown`. `written` indica accettazione della write sul socket, non elaborazione dal consumer. Un ack già accettato non viene annullato da una successiva uscita dal gruppo. Una write senza risposta può avere esito incerto: nessun retry automatico o mailbox.
- `commitState(payload, expectedRevision?)`: restituisce un **requestId**, non una conferma di persistenza. `expectedRevision: 0` richiede stato assente; omissione significa nessun CAS. Il broker ammette soltanto il proprietario corrente.
- `state_result`: stesso requestId, `committed` con stato, `rejected` con errore noto oppure `unknown` quando manca un esito affidabile. Due commit concorrenti con la stessa revisione restano distinguibili; conflitto → `revision_conflict`. Vedere uno state broadcast non autorizza a inventare l'ack di un commit scaduto.
- `listSessions()`: roster completo visibile nel solo gruppo del binding, inclusi peer senza capability per quel namespace. Le altre appartenenze non sono esposte.
- `connection`, `owner`, `state`, `message`, `peer`: aggiornamenti del canale. `peer` descrive joined/updated/left del roster del gruppo, non soltanto i consumer del namespace. `message` include il mittente ricavato dal broker; il payload non può cambiarne l'identità.
- `error`: fallimento di registrazione/negoziazione. Gli errori delle callback consumer, anche asincrone, sono isolati dagli altri canali e dal trasporto.

Le verifiche locali possono rifiutare payload o handle non validi prima di restituire un ID. Gli errori successivi sono correlati. Deadline richieste **5 s**; massimo **128 publish/commit pendenti** aggregati, dentro il limite core di 256 richieste. I commit usano il budget core di **65.536 ID espliciti per runtime**; oltre il budget ricevono `request_capacity`. Nessuna coda illimitata o promessa di riuso degli ID.

## Ownership e lifecycle

Il broker elegge il binding eleggibile più antico secondo un proprio contatore, non `startedAt`. Owner contiene routing ID, endpoint epoch e owner epoch. Commit e publish owner-only verificano tutti i riferimenti del binding: un vecchio proprietario non può scrivere dopo replacement, takeover o riacquisizione.

Il gruppo risolto non cambia. Uscire revoca disponibilità e ownership, termina le operazioni ancora pendenti con `workgroup_left` e conserva lo stato su disco. Rientrare richiede nuova registrazione, nuovi epoch e snapshot; non riproduce publish né operazioni terminate. Un disconnect ordinario mantiene la membership del registry, ma le capability del socket devono essere ristabilite. Il nuovo ordine di registrazione può eleggere un altro proprietario.

Reconnect non riusa snapshot/owner di una vecchia connessione. Le registrazioni dall'esito incerto possono essere ritentate in modo idempotente con backoff; **publish e commit non vengono ritentati**. La revoca terminale del runtime impedisce il reclaim automatico. Shutdown rimuove listener/timer e invalida gli handle.

Feature richiesta: `extension-bus-v1`. Con broker privo della feature il consumer riceve un handle `supported: false`; nessuna richiesta channel sconosciuta viene inviata. `connected` può essere true perché il client è connesso, ma le operazioni del canale sono rifiutate. Durante disconnect, `supported` può ancora riflettere l'ultima negoziazione: non basta a dichiarare il canale disponibile.

## Stato persistente e limiti

| Limite | Valore |
| --- | --- |
| Publish JSON serializzato UTF-8 | 16 KiB |
| Payload di stato JSON serializzato UTF-8 | 64 KiB |
| Profondità JSON / nodi visitati | 64 / 65.536 |
| Record persistenti nel broker | 1.024 coppie gruppo/namespace |
| Primarie + backup complessivi | 32 MiB |
| Singolo file | 72 KiB, envelope incluso |

Solo JSON stretto, con record plain/prototipo nullo e array: no funzioni, undefined, numeri non finiti, bigint, cicli, proxy, oggetti con prototipi personalizzati, getter o proprietà nascoste/extra che verrebbero scartate. Il payload viene catturato prima degli await; modificare l'oggetto originale non cambia l'operazione.

Directory `<runtime>/state/` privata 0700, file 0600. I nomi sono SHA-256 della coppia codificata senza ambiguità; il contenuto conserva workgroup e namespace in chiaro. Envelope versionato, revisione, timestamp e checksum. Il backup esiste dalla seconda commit. Una commit scrive la precedente primaria verificata in `.bak`, poi la nuova primaria `.json`: temporanea esclusiva, fsync, rename e fsync directory dove supportato. Anche il layout intermedio durevole deve rispettare la quota; raggiungerla può impedire un aggiornamento che richiede spazio per il backup. Le temporanee aggiungono spazio transitorio limitato, non una coda durevole.

Primaria mancante/corrotta con backup valido → recupero della precedente revisione, **possibile perdita dell'ultima revisione** e `recovered: true`, conservato anche al restart fino a una nuova commit. Primaria valida e backup corrotto non fanno perdere la primaria; il prossimo commit riscrive il backup dalla copia verificata in memoria. Nessuna coppia valida → startup rifiutato, senza cancellare stato. File estranei, non sicuri o oltre limite bloccano l'avvio; vengono rimosse solo temporanee riconoscibili, private e limitate.

Errore durante write, anche dopo rename → storage inutilizzabile fino al restart e stop del broker; il client non riceve un falso `committed`. Lo stato viene ricaricato al restart, **non** gli owner. Quota piena o corruzione richiedono manutenzione esplicita a broker fermo, senza rimozione automatica di revisioni riconosciute. I checksum rilevano corruzione, non autenticano un utente che può riscrivere i file. Questa recovery con backup non si applica alle lease di ownership.

Capacità e workgroup sono cooperativi, non permessi crittografici. Il bus è locale, piccolo e senza replica: non è un database distribuito né un servizio di esecuzione durevole.
