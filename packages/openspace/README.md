# Openspace

Package Pi autonomo per la comunicazione locale fra sessioni. Nome npm `openspace`, versione `0.1.0`, privato; solo **macOS e Linux**, Node.js **22.19+**, target Pi **0.99.1**.

## Stato effettivo

Implementati i passi **01–11**: broker Unix, registry, recovery, delivery, adapter Pi, ask/reply, UI, canali, outbox, identity claim e CLI per automazioni. Il tool `openspace` permette list/list-cwd/status/send/cancel/ask/reply/pending e i messaggi ricevuti entrano nella conversazione rispettando lifecycle e policy.

Roster/compose e comandi alias/ID/workgroup sono disponibili: vedere [Comandi e UI](UI.md). Le API pubbliche per [canali e stato revisionato](CHANNELS.md) e [outbox/identity claim](OUTBOX.md) sono disponibili. La [CLI list/send/ask](CLI.md) è operativa. **Handover non è ancora disponibile.** Le integrazioni esterne rimangono differite; nessuna capacità fittizia viene esposta.

Il bin `openspace` usa un broker già esistente, senza auto-spawn o import del runtime Pi. Con `--json` restituisce un solo oggetto anche sugli errori applicativi: exit **0** successo al livello dichiarato, **1** errore/interruzione, **2** timeout del waiter ask. `queued` non è consegna al socket né completamento.

## Preparare e caricare il package

Dal checkout Tau, usare `mise install` e la shell mise (oppure anteporre `mise exec --` ai comandi) per Node 22.19.0. Installare le dipendenze del singolo workspace:

```sh
npm install --ignore-scripts --workspace openspace
npm run check --workspace openspace
npm test --workspace openspace
pi -e ./packages/openspace
```

`pi -e` carica per una sola invocazione senza modificare le impostazioni personali. Per un'installazione personale esplicita, quando desiderata:

```sh
pi install /percorso/tau/packages/openspace
```

Poi `/reload` o riavvio Pi. Caricare un package locale **non installa dipendenze e non crea bin link**: preparare prima il checkout. npm crea il link in `node_modules/.bin`, ma Pi non aggiunge automaticamente questa directory al PATH. Per verificare il launcher dal checkout:

```sh
./node_modules/.bin/openspace --help
```

Nessuna pubblicazione npm o disponibilità del nome pubblico è verificata. Il package è autonomo e non richiede build o checkout esterni. Questa fase non aggiunge il package al manifest del bundle root; l'integrazione delle risorse è prevista con la validazione finale.

## Configurazione

File opzionale: `$PI_CODING_AGENT_DIR/openspace/config.json`, altrimenti `~/.pi/agent/openspace/config.json`. Un agent dir relativo è risolto rispetto al cwd del processo al momento dell'avvio del runtime; normalizzazione lessicale una sola volta, senza creare directory o utilizzare i percorsi di altre estensioni. `~`, `~/…` e URL `file://` locali vengono risolti come in Pi 0.99.1, senza importare il runtime Pi nel core.

```json
{
  "enabled": true,
  "brokerArgs": [],
  "replyHint": true,
  "confirmSend": false,
  "inboundTrigger": "always",
  "busyDelivery": "steer"
}
```

Questi sono i default della configurazione. Senza `brokerCommand`, il launcher interno verifica Node.js 22.19+ e risolve `tsx/esm` dal package: niente `npx` o loader cercato nel cwd runtime, né riuso di un eseguibile host standalone come Node. `brokerCommand` opzionale sostituisce l'eseguibile; `brokerArgs` è il suo prefisso di argomenti, seguito dall'entry del broker e da `--runtime-dir <directory>`. Un prefisso non vuoto richiede un comando esplicito. Percorsi con spazi/Unicode vengono passati come argomenti, senza shell.

Il factory registra soltanto tool, comandi, renderer, handler e handshake del bus locale. **A `session_start` l'estensione abilitata avvia o riusa il broker e si registra**; shutdown/reload/sostituzione chiudono le risorse del vecchio runtime. I comandi configurati sono codice fidato dell'utente, mai testo ricevuto da un peer.

Campi opzionali:

- `stableId`: stringa non vuota, normalizzata con trim. Il routing ID è unico nell'intero broker: un valore globale può provocare takeover anche fra workgroup disgiunti. La precedenza è claim locale sincrona, ambiente, config, ID della sessione Pi; vedere [OUTBOX.md](OUTBOX.md).
- `status`: nota personalizzata, massimo **1 KiB UTF-8**, conservata senza troncamento. Non sostituisce lo stato `idle/thinking/tool`, prodotto dal lifecycle Pi con tool concorrenti tracciati per call ID. Il registry verifica il limite complessivo del record di presenza da 6 KiB.

Valori ammessi: `inboundTrigger` = `always | replies | never`; `busyDelivery` = `steer | human-first`; gli altri flag sono booleani, `brokerArgs` un array di stringhe. Command, argomenti e stable ID rifiutano NUL espliciti. Config assente → default; JSON/campi noti invalidi o errori di lettura → errore con path e campo ove applicabile, mai fallback silenzioso. Le chiavi sconosciute vengono ignorate, non abilitate come funzionalità. Non sono consumate opzioni Herdr/SSH.

Nell'estensione Pi, `enabled: false` non carica le variabili proprie né avvia risorse. Config nuova a ogni `session_start`/reload, nessun watcher. Non si scrivono file di configurazione o variabili globali.

### Ambiente Openspace

| Variabile | Default / significato |
| --- | --- |
| `PI_OPENSPACE_STABLE_ID` | Override non vuoto normalizzato dell'ID di routing |
| `PI_OPENSPACE_WORKGROUPS` | Lista specifica separata da virgole; assente/vuota → fallback `default` |
| `PI_OPENSPACE_ASK_TIMEOUT_MS` | 600000 ms; letto indipendentemente da waiter, receiver e processo broker |
| `PI_OPENSPACE_LIVENESS_INTERVAL_MS` | 30000 ms |
| `PI_OPENSPACE_LIVENESS_TIMEOUT_MS` | 5000 ms, limitato all'intervallo configurato |

Prefisso `PI_` convenzionale, non interpretazione automatica dell'host. Le variabili vuote/spazi usano il default; i timeout espliciti devono essere interi da 1 a **2147483647 ms** per evitare l'overflow dei timer Node. Valori malformati causano un errore esplicito. Sono lette soltanto le variabili proprie elencate sopra, senza pubblicare l'identità in `process.env`.

Esempio di seed per sessioni collegate allo stesso broker:

```sh
PI_OPENSPACE_WORKGROUPS=progetto,review pi -e ./packages/openspace
```

Il parser applica trim, deduplicazione e confronto esatto case-sensitive; rifiuta componenti vuoti interni, virgole nei singoli nomi e caratteri di controllo. Non tronca i nomi o applica un limite arbitrario per singolo gruppo; il registry applica il budget al record JSON completo. `default` è riservato e non configurabile, nemmeno insieme ad altri nomi: lista specifica vuota → solo `[default]`, altrimenti solo i gruppi specifici.

Il servizio interno salva preferenze versionate tramite entry Pi `openspace_workgroups`, legate all'ID Pi e non al routing ID o al ramo. La scelta salvata, inclusa `[]`, prevale sul seed. Reload/resume la ripristinano; fork/nuova sessione con ID diverso ignorano entry copiate. `/openspace-workgroups` permette list/add/remove e mostra le transizioni automatiche del fallback. Nessuna mutazione di env o config globali. Un errore di salvataggio è esplicito: i gruppi live già accettati restano autorevoli, senza rollback che riaprirebbe le operazioni annullate. `saved` indica accettazione dell'entry da Pi, non fsync; sessioni in-memory restano effimere. I workgroup organizzano routing/discovery, non autenticano peer né isolano il contesto del modello.

## CLI per script

```sh
./node_modules/.bin/openspace list --json
./node_modules/.bin/openspace send --to worker --text "Build fallita" --name build-hook --json
./node_modules/.bin/openspace ask --to planner --text "Quale API uso?" --timeout-ms 120000 --json
```

La CLI usa un nuovo ID e i propri gruppi ambientali, non stable ID o preferenze Pi ereditate. `--workgroup` seleziona un gruppo già condiviso. Timeout CLI, receiver e broker sono indipendenti; timeout/disconnect non cancellano il lavoro. La [guida CLI](CLI.md) specifica parsing, campi JSON, errori di launcher, segnali, limiti e PATH senza installazioni globali.

## Broker locale: stato e limiti

Per una prova esplicita dal checkout, senza configurazione Pi personale:

```sh
node --import tsx/esm ./packages/openspace/src/broker/main.ts --runtime-dir /tmp/openspace-demo/openspace
```

Il processo termina dopo **5 secondi** senza connessioni registrate. Il solo health non prolunga il timer; una registrazione lo annulla e l'ultima disconnessione lo riavvia. SIGINT/SIGTERM chiudono le connessioni e ripuliscono socket/PID posseduti; `leases.json` resta per il fencing dopo restart e `state/` conserva lo stato dei canali. Non è ancora un sottocomando del bin `openspace`.

Il socket pubblico è `broker.sock` nella directory runtime. Limite portabile del path: **103 byte UTF-8**, senza fallback TCP; in caso di errore scegliere un agent dir più corto. Directory 0700, socket e record PID/lock 0600. Il socket pubblico è un hard link a un nome privato casuale della stessa istanza, non un secondo listener: la chiusura nativa non può cancellare il socket pubblico di una generazione successiva. Non rimuovere manualmente file mentre un broker è vivo.

`src/broker/spawn.ts` fornisce l'helper interno `ensureBroker`: health prima/dopo la lock esclusiva, spawn detached dal cwd runtime e diagnostica stderr limitata a **16 KiB**. Le lock contengono PID, timestamp e identificatore di generazione, pubblicati atomicamente; anche il recupero concorrente di una generazione morta è serializzato. PID vivi, inclusi PID riutilizzati, non vengono rimossi perché un probe fallisce. Record corrotti, proprietà del socket sconosciuta o stato incoerente dopo uno startup interrotto richiedono ispezione manuale: nessuna cancellazione forzata di endpoint sconosciuti. Solo i processi avviati dal tentativo corrente vengono terminati dopo un errore/timeout.

### Protocollo di trasporto iniziale (interno)

Frame: **4 byte uint32 big-endian + JSON UTF-8**, payload massimo **1 MiB**, header escluso. Reader incrementale e writer verificano il limite dell'intero envelope; UTF-8/JSON malformati chiudono soltanto il peer responsabile.

Ogni richiesta contiene `type`, `protocol: "openspace"`, `version: 1` e `requestId` non vuoto, massimo **256 byte UTF-8**, senza controlli ASCII. Operazioni implementate:

- `health` → `health_result`, stesso requestId, versione, PID, instanceId e features; nessun dato di sessione o credenziale.
- `prepare {id}` → ticket di lease; `register` con lease, mode claim/resume, session e gruppi specifici → `registered` con record completo (massimo **6 KiB**). La lease resta valida per resume soltanto mentre il broker conserva quella ownership.
- `list`, `list-cwd`, `resolve`, `update`, `set-workgroups`, `release`: registry e mutazioni correlate, con proiezione dei gruppi visibili e revisioni CAS.
- `ping` dopo register → `pong` correlato. Features: `liveness-v1`, `session-registry-v1`, `lease-resume-v1`, `delivery-v1`, `exact-send-v1`, `ask-reply-v1`, `extension-bus-v1`.
- `channel-register`, `channel-publish`, `channel-commit`: binding di capability, invio non conversazionale e commit correlato dello stato; dettagli in [CHANNELS.md](CHANNELS.md).

Il [contratto del registry](REGISTRY.md) descrive schema, retention delle lease, revoca, limiti, lookup ed eventi. La notifica di takeover è best effort, ma il rifiuto del ticket revocato sopravvive alla sua perdita e al restart. Il controller core ferma retry e reconnect impliciti dopo il rifiuto; l'adapter avvisa e lascia proseguire Pi, senza reclamare nuovamente l'ID.

Prima di register, operazioni applicative falliscono con `registration_required`; una seconda register chiude il peer con `already_registered`. Operazioni non implementate dopo register restituiscono `unsupported_operation`, mai un falso successo. Nome/versione incompatibili producono `incompatible_protocol`.

Limiti per broker: **128** connessioni registrate, **32** non registrate, deadline di registrazione **1 s**; token bucket per connessione di **240** messaggi, refill **120/s**. Le write usano la coda nativa di Node, con un budget di **4 MiB per peer**, header inclusi: oltre il budget il peer lento viene disconnesso. Nessuna coda applicativa illimitata; i limiti sono di trasporto, non autorizzazione o isolamento da processi ostili dello stesso utente.

## Client e recovery

`src/client/client.ts` espone un client senza import Pi o auto-spawn: connect/resume, disconnect, roster/lookup, presence e mutazioni serializzate dei gruppi. La stessa istanza conserva la lease dopo un errore di rete; dopo un register dall'esito incerto usa soltanto resume, mai una nuova claim. Un rifiuto terminale non viene cancellato da disconnect/connect.

`ConnectionController` coordina startup, tool e background in un solo tentativo. L'hook opzionale `ensureBroker` è riservato all'estensione, non alla CLI. Backoff 1/2/5/10/30 secondi, poi 30; un errore permanente o una revoca lo fermano. Stop è terminale per quel controller e invalida callback tardive. Un nuovo runtime richiede un nuovo controller, non un reset implicito della revoca.

Heartbeat dedicato ping/pong: 30 secondi, timeout 5 secondi clamped all'intervallo. Una list lenta non interferisce. Correlazione con ID automatici mai riutilizzati, timeout e cleanup dei pending; massimo 256 richieste simultanee. Gli ID espliciti non sono riutilizzabili nel runtime (budget 65536), così una risposta tardiva non risolve una nuova richiesta. Listener consumer sincroni/asincroni falliti non interrompono il trasporto.

Le mutazioni usano revisioni CAS, coda seriale e riconciliazione dopo un esito incerto. `mutateWorkgroups` applica una trasformazione alla lista corrente, senza perdere aggiunte concorrenti. Gli stamp per gruppo sopravvivono al disconnect sullo stesso broker; leave/rejoin e restart li invalidano. Uno stamp valido non basta a dimostrare che il socket sia connesso. Reconnect non reinvia automaticamente contenuti.

## Messaggistica core

`Messenger` supporta invio esatto, allegati testuali, replay limitato, mailbox RAM, ricevute e controlli. Il [contratto di delivery](DELIVERY.md) descrive i limiti, il binding al gruppo, gli esiti incerti, la recovery per identità e la distinzione fra cancellare una coda e chiedere l'annullamento di qualcosa già passato al receiver. Nessuna consegna viene descritta come completamento del lavoro.

## Consegna in Pi

Il tool `openspace` ha schema stabile e risultati `content`/`details`; errori e risultati incerti sono marcati `isError`. `send` conserva `messageId`, `supersedes` e `retryOf`; gli allegati trasportano testo, non letture remote. `confirmSend` richiede conferma TUI/RPC; senza dialoghi disponibili l'invio è bloccato. Cancel richiede `messageId` e il `workgroup` originario.

- Idle: `always` avvia un turno; `never` appende senza avvio. `replies` avvia soltanto per una reply con correlazione validata dal broker, non già consumata dal waiter.
- Run TUI: `steer` usa la coda Pi, **anche con `inboundTrigger: never`**. Questa opzione non è un firewall.
- `human-first`: FIFO esterna, al massimo un peer per turno, soltanto senza input umano pendente; non scarica l'intera coda quando torna idle. Input continuo può ritardare i peer fino alla scadenza.
- Compattazione o busy senza run: hold fino a un confine sicuro; controllo ogni 250 ms soltanto mentre ci sono held, anche se manca una notifica finale.
- Run print/JSON/RPC: nessuna interruzione; il messaggio ordinario riceve best effort un nuovo avviso busy, senza `replyTo` inventato o dialoghi automatici. RPC non equivale a un terminale TUI.

Held: **256 messaggi / 8 MiB / 10 minuti**. Dedupe: **1000 record / 1 ora**, chiave workgroup+sender+ID. Overflow/scadenza producono ricevute diagnostiche. `injected` significa passato all'API Pi, non risposta o completamento del modello. Cancel/supersede/uscita da un gruppo rimuovono soltanto contenuti ancora posseduti da Openspace; history e code già consegnate a Pi non vengono modificate. Leave/rejoin non riabilita callback vecchie; disconnect ordinario non è leave. Shutdown scade gli held e invalida timer, conferme e callback.

Il custom message `openspace_message` conserva dettagli, gruppo, provenienza e allegati. Pi lo converte in contenuto user-role attribuito al peer, non in istruzioni di sistema o input umano. La history diagnostica degli invii è `openspace_sent`. Dedupe/held non vengono ricreati da history dopo reload. `replyHint` mostra il riferimento di una domanda ancora pendente.

## Ask e reply

Il [contratto ask/reply](ASKS.md) descrive waiter single-flight, selezione pending, inferenza send, validazione broker, timeout indipendenti e diagnostica non durevole. Ask richiede un peer live; la risposta con allegati ritorna nello stesso risultato tool. Timeout non cancella il lavoro, abort del waiter non equivale a cancel del messaggio e le reply non cambiano gruppo.

## Canali per estensioni

L'export autonomo `openspace/extension-api` fornisce handshake, canali vincolati a un workgroup, ownership per namespace e stato persistente CAS. Nessun dato di questo percorso attiva Pi o passa nella conversazione. Il [contratto dei canali](CHANNELS.md) descrive limiti, callback, esiti incerti e recupero con backup, distinto dal fencing delle lease.

## Outbox e identity claim

L'outbox locale è notify-only, con sender derivato dalla sessione, attribuzione strutturata, consenso e risultato terminale. Gli ID delle richieste sono univoci nell'intero runtime, non per producer. Una claim sincrona può assegnare l'ID di routing prima della registrazione, senza cambiare nome, identità Pi delle preferenze o ambiente globale. [OUTBOX.md](OUTBOX.md) documenta limiti, errori, lifecycle ed esempio consumer caricato esplicitamente.

## Verifiche

I test vivono in `tests/`, fuori dalla discovery Pi. Coprono configurazione, framing segmentato e boundary UTF-8, handshake, quote/rate/output, clock controllato, processi reali concorrenti, recovery, segnali, timeout, takeover/restart, roster massimo, status, revisioni, visibilità e packaging. Il manifest dichiara un solo entry point Pi; il processo broker non viene scoperto come estensione.

```sh
npm run check
npm test
npm pack --dry-run --json --workspace openspace
```

Check e test root orchestrano i workspace. I test non dipendono dai file temporanei dello studio né scrivono nella configurazione personale. Le fixture `AgentSession` reali usano un provider locale controllato: idle/steer, priorità umana, compattazione riuscita/fallita/annullata, headless, tool, fork/new/resume/reload e preferenze isolate. Ask/reply è verificato anche nel loop modello→tool→modello, con allegati Unicode, correlazione anticipata, timeout indipendenti e reply-before-injection. La UI è verificata con il broker reale, keybinding/paste/Unicode, viewport stretti, tema mutabile, lifecycle, headless e coesistenza con Calm/Orange; nessuno smoke manuale IME è dichiarato. Due consumer Pi reali verificano canali/stato e ordine inverso di caricamento senza sendMessage, entry o chiamate modello; i test coprono anche ack persi, quote, CAS, leave/rejoin, SIGKILL, corruzione/backup e import/tipi da tarball installato senza peer Pi. L'outbox è verificata tra sessioni Pi reali con attribution, dialoghi sospesi, duplicati fra producer, budget, routing live, leave/rejoin, reload/shutdown, invii incerti e identità per-sessione senza mutazioni globali. I test CLI eseguono il vero launcher, JSON anche su errori config/parse, early reply, timeout indipendenti, segnali, output bloccato, gruppi distinti dalle preferenze Pi e il bin link da tarball senza peer Pi.

Il package è distribuito con licenza MIT; gli avvisi applicabili sono conservati nei sorgenti.
