# CLI per automazioni

`openspace` espone **list, send e ask** fuori Pi. Riusa un broker locale già avviato: **non avvia broker o sessioni AI**, non carica estensioni, model registry, auth o UI. Supporta macOS/Linux e Node.js 22.19+; i peer Pi non devono essere installati per questi comandi.

```sh
openspace list --json
openspace send --to worker --text "Build fallita" --name build-hook --json
openspace ask --to planner --text "Quale API uso?" --timeout-ms 120000 --json
PI_OPENSPACE_WORKGROUPS=progetto,review openspace send \
  --to worker --workgroup review --text "Controlla i test" --json
```

Se il broker è assente, `broker_unavailable` suggerisce di aprire Pi con Openspace. Nessun download implicito, launcher configurato, shell profile o link globale viene eseguito/modificato.

## Argomenti

- `list`: `--workgroup`, `--name`, `--json` opzionali.
- `send` e `ask`: `--to PEER` e `--text TEXT` obbligatori; `--workgroup`, `--name`, `--json` opzionali.
- Solo `ask`: `--timeout-ms N`, intero decimale da 1 a 2147483647; default **120000 ms**.
- `--help`/`-h`, nessun argomento, oppure `<comando> --help`: guida senza accesso al broker/config. `--version`: versione del package. Entrambi accettano `--json`.
- Flag sconosciuti, ripetuti, mancanti o non validi per il comando sono errori. Nessun argomento posizionale dopo il comando. Le opzioni possono precedere il comando; per un valore che inizia con `-` usare `--text=--valore`.
- Nessun flag cwd, stable ID, attachments, cancel, relay o integrazione remota. Il testo resta invariato; ask richiede una domanda non composta soltanto da spazi. Valgono anche i limiti argv del sistema operativo.

## Identità, gruppi e configurazione

Ogni invocazione usa un **nuovo UUID**, cwd corrente, PID reale, modello descrittivo `openspace-cli`, senza status Pi inventato. Il nome predefinito `openspace-cli-<UUID>` evita recovery involontaria fra invocazioni; `--name` assegna un alias esplicito, non un'identità autenticata. La sessione temporanea compare nel roster degli altri peer finché connessa. `list` omette soltanto la propria riga temporanea.

`PI_CODING_AGENT_DIR` seleziona il runtime, altrimenti `~/.pi/agent/openspace`. Il file `openspace/config.json`, se presente, viene validato: JSON/campi noti invalidi producono un errore JSON applicativo. Le impostazioni dell'estensione (`enabled`, `confirmSend`, `stableId`, policy inbound e launcher) **non cambiano l'automazione esplicitamente richiesta**. Nessun consenso UI e nessuna lettura di credenziali o preferenze Pi.

La CLI legge `PI_OPENSPACE_WORKGROUPS` e gli intervalli heartbeat `PI_OPENSPACE_LIVENESS_INTERVAL_MS`/`PI_OPENSPACE_LIVENESS_TIMEOUT_MS`. Non usa `PI_OPENSPACE_STABLE_ID` né `PI_OPENSPACE_ASK_TIMEOUT_MS`: non deve impersonare il processo padre e il proprio waiter ha una deadline distinta.

Gruppi specifici vuoti → solo `default`; altrimenti solo i gruppi specifici. `--workgroup` filtra/seleziona **un gruppo già condiviso**, non aggiunge appartenenze. Zero comuni → errore, uno → automatico, più di uno → `workgroup_ambiguous`. Le preferenze cambiate con `/openspace-workgroups` nella sessione Pi padre non sono automaticamente l'ambiente della shell figlia.

## JSON ed exit code

Con `--json`, **un solo oggetto JSON e una newline su stdout**, anche per errori di parsing/config/connessione. Nessun banner, log di startup o stack. Errori di sistema/loader **prima dell'avvio del JavaScript applicativo** (Node/tsx mancanti, entry non caricabile, argv troppo grande), SIGKILL, pipe stdout chiusa o output bloccato durante/dopo un'interruzione non possono rispettare questo contratto. In quest'ultimo caso i client sono già chiusi; l'uscita può troncare l'oggetto in scrittura invece di attendere indefinitamente il lettore. Dopo un'interruzione dell'operazione, la scrittura finale ha al massimo un secondo di attesa; un segnale durante la scrittura termina subito il processo, anche se non è il primo.

| Exit | Significato |
| --- | --- |
| 0 | Successo al livello dichiarato: roster, trasporto send o reply correlata ask |
| 1 | Usage, config, connessione, routing, invio fallito/incerto, correlazione scaduta nel broker, interruzione SIGINT/SIGTERM |
| 2 | Timeout del waiter ask CLI; non cancellazione del lavoro |

Schema v1 comune: `version: 1`, `ok`, `command` (`list | send | ask | help | version`, oppure `null` se il parser non ha completato), e su errore `error: { code, message }`. Gli errori precoci possono contenere soltanto lo schema comune; i campi specifici seguenti sono presenti quando disponibili. In caso di interruzione, `error.code` è `interrupted`, conservando gli eventuali risultati di trasporto/risposta già noti.

- **List:** `sessions` contiene i record completi proiettati dal broker, inclusi ID interi e gruppi condivisi. Nessuna paginazione/troncamento.
- **Send:** aggiunge `messageId`, `workgroup` quando risolto, `delivery: socket_delivered | queued | failed | unknown`, `retryable`, `outcomeKnown`, eventuale `code`. `ok: true`/exit 0 ammettono **anche `queued`**; leggere `delivery` se serve distinguere il socket dalla mailbox RAM. Esito incerto non prova mancata consegna.
- **Ask:** aggiunge `messageId`, gruppo, `status: answered | failed`, eventuale `code`, `delivery` come risultato di trasporto strutturato e `response` come messaggio completo. `response.sender`, `response.text`, allegati e `replyTo` conservano la correlazione broker. Una reply può precedere l'ack send: `answered` può coesistere con una delivery ancora incerta.
- **Help/version:** `help` contiene la guida, `packageVersion` la versione.

Esempio send:

```json
{"version":1,"ok":true,"command":"send","messageId":"…","workgroup":"review","delivery":"queued","retryable":false,"outcomeKnown":true}
```

Non viene esposto il vecchio booleano semplificato `delivered` né un alias `id`: gli script devono leggere `messageId`/`delivery`. Questo è il contratto Openspace, non una promessa di compatibilità con altri bin.

Senza `--json`, list/help/version e testo della risposta ask sono dati su stdout; diagnostica, informazioni sul sender ed esito send sono su stderr. La lista umana estende i prefissi ID fino all'unicità fra le righe mostrate. Per automazioni usare sempre gli ID completi del JSON. I controlli terminale vengono escapati solo nella presentazione umana, non nel contenuto JSON.

## Timeout e cleanup

Il receiver viene installato prima dell'invio; reply precoci non vanno perse. Una disconnessione durante ask conclude l'attesa con errore, senza reconnect/reinvio automatico. La CLI chiude socket, heartbeat, waiter e listener in `finally`, anche su SIGINT/SIGTERM.

I **120 secondi CLI**, i timeout Pi/receiver e la retention broker sono indipendenti. `--timeout-ms` cambia soltanto il waiter CLI: non viene inviato al broker e non estende la validità delle reply. Un timeout CLI non invia cancel, non abbandona l'ask edge e non interrompe il lavoro remoto. Il cleanup disconnette, senza fare release dell'identità o simulare un'uscita dal workgroup. Le invocazioni consumano le normali quote di lease/record del broker: non esiste una riserva illimitata per script, e un broker saturo può restituire `lease_capacity` (vedere [REGISTRY.md](REGISTRY.md)).

Una reply successiva può essere accodata nel broker ancora vivo **solo finché la correlazione è valida**. Recovery per nome richiede un alias esplicito univoco, stesso cwd canonico e workgroup; il nome predefinito è deliberatamente unico per invocazione. Non viene aggiunto un inbox persistente e una nuova ask non interpreta una vecchia reply come risposta propria. TTL mailbox non prolunga una correlazione scaduta. Vedere [ASKS.md](ASKS.md) e [DELIVERY.md](DELIVERY.md).

## Installazione e PATH

Dal checkout preparato, senza installazione personale:

```sh
mise exec -- npm install --ignore-scripts --workspace openspace
mise exec -- node ./packages/openspace/cli.mjs list --json
# oppure, con Node corretto sul PATH:
./node_modules/.bin/openspace list --json
```

npm crea il link `.bin` durante installazione. Il mero caricamento `pi -e ./packages/openspace` **non installa dipendenze e non crea link bin**. Un package locale preparato può essere eseguito direttamente con `node /percorso/openspace/cli.mjs`.

Per installazioni npm gestite da Pi, la directory utente è `$PI_CODING_AGENT_DIR/npm/node_modules/.bin` (default `~/.pi/agent/npm/node_modules/.bin`); quella di progetto è `.pi/npm/node_modules/.bin`. Usare il percorso esplicito o un PATH impostato dall'utente: Pi non lo aggiunge automaticamente alla shell. Il package resta privato e non incluso nel bundle root; nessuna disponibilità npm o installazione globale è presupposta.

I test eseguono il launcher reale, segnali, broker/receiver controllati, timeout eterogenei, preferenze Pi differenti e il bin link di un tarball installato senza peer Pi.
