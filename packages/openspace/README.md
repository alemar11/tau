# Openspace

Package Pi autonomo per la futura comunicazione locale fra sessioni. Nome npm `openspace`, versione `0.1.0`, privato; solo **macOS e Linux**, Node.js **22.19+**, target Pi **0.99.1**.

## Stato effettivo

Implementati **package-foundation**, **local-broker** e **session-registry**: broker Unix, avvio coordinato, registry a ID unico, discovery, presenza delimitata, mutazioni dei gruppi e fencing persistente del takeover. Il broker è verificabile separatamente da Pi; non è ancora collegato all'estensione, che valida la configurazione a `session_start` senza aprire connessioni, processi, watcher o timer.

**Non è ancora uno strumento di messaggistica utilizzabile.** Client/reconnect, send/ask/reply, UI, comandi workgroup, persistenza delle preferenze nella sessione Pi, API estensioni e handover sono ancora da implementare. Le integrazioni esterne rimangono differite. Non sono esposti tool o comandi Pi fittizi, skill o export API verso file inesistenti.

Il bin riserva il nome `openspace`: `--help` e `--version` funzionano; altri argomenti terminano con codice **2**, errore su stderr e nessun invio. Nessun contratto JSON della CLI è ancora disponibile.

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

**Caricare l'estensione non avvia ancora il broker**: il controller arriverà nei task successivi. I campi di delivery non sono ancora operativi. I comandi configurati sono codice fidato dell'utente, mai testo ricevuto da un peer.

Campi opzionali:

- `stableId`: stringa non vuota, normalizzata con trim. Il routing ID è unico nell'intero broker: un valore globale può provocare takeover anche fra workgroup disgiunti. L'adapter Pi non pubblica ancora questo campo.
- `status`: nota personalizzata, massimo **1 KiB UTF-8**, conservata senza troncamento. Non sostituisce lo stato `idle/thinking/tool`, già validato dal registry ma non ancora prodotto dal lifecycle Pi. Il registry verifica il limite complessivo del record di presenza da 6 KiB.

Valori ammessi: `inboundTrigger` = `always | replies | never`; `busyDelivery` = `steer | human-first`; gli altri flag sono booleani, `brokerArgs` un array di stringhe. Command, argomenti e stable ID rifiutano NUL espliciti. Config assente → default; JSON/campi noti invalidi o errori di lettura → errore con path e campo ove applicabile, mai fallback silenzioso. Le chiavi sconosciute vengono ignorate, non abilitate come funzionalità. Non sono consumate opzioni Herdr/SSH.

`enabled: false` non carica le variabili proprie né avvia risorse. Config nuova a ogni `session_start`/reload, nessun watcher. Non si scrivono file di configurazione o variabili globali.

### Ambiente Openspace

| Variabile | Default / significato |
| --- | --- |
| `PI_OPENSPACE_STABLE_ID` | Override non vuoto normalizzato; il futuro adapter lo passerà al registry |
| `PI_OPENSPACE_WORKGROUPS` | Lista specifica separata da virgole; assente/vuota → fallback `default` |
| `PI_OPENSPACE_ASK_TIMEOUT_MS` | 600000 ms; sarà letto indipendentemente dai processi interessati |
| `PI_OPENSPACE_LIVENESS_INTERVAL_MS` | 30000 ms |
| `PI_OPENSPACE_LIVENESS_TIMEOUT_MS` | 5000 ms, limitato all'intervallo configurato |

Prefisso `PI_` convenzionale, non interpretazione automatica dell'host. Le variabili vuote/spazi usano il default; i timeout espliciti devono essere interi da 1 a **2147483647 ms** per evitare l'overflow dei timer Node. Valori malformati causano un errore esplicito. Sono lette soltanto le variabili proprie elencate sopra, senza pubblicare l'identità in `process.env`.

Esempio di seed, non ancora di sessioni collegate:

```sh
PI_OPENSPACE_WORKGROUPS=progetto,review pi -e ./packages/openspace
```

Il parser applica trim, deduplicazione e confronto esatto case-sensitive; rifiuta componenti vuoti interni, virgole nei singoli nomi e caratteri di controllo. Non tronca i nomi o applica un limite arbitrario per singolo gruppo; il registry applica il budget al record JSON completo. `default` è riservato e non configurabile, nemmeno insieme ad altri nomi: lista specifica vuota → solo `[default]`, altrimenti solo i gruppi specifici.

La configurazione iniziale **non implementa** ancora `/openspace-workgroups` o la persistenza: le future preferenze della singola sessione, inclusa `[]`, prevarranno sull'ambiente. I workgroup organizzeranno routing/discovery, non autenticheranno peer né isoleranno il contesto del modello.

## Broker locale: stato e limiti

Per una prova esplicita dal checkout, senza configurazione Pi personale:

```sh
node --import tsx/esm ./packages/openspace/src/broker/main.ts --runtime-dir /tmp/openspace-demo/openspace
```

Il processo termina dopo **5 secondi** senza connessioni registrate. Il solo health non prolunga il timer; una registrazione lo annulla e l'ultima disconnessione lo riavvia. SIGINT/SIGTERM chiudono le connessioni e ripuliscono socket/PID posseduti; `leases.json` resta per il fencing dopo restart. Non è ancora un sottocomando del bin `openspace`.

Il socket pubblico è `broker.sock` nella directory runtime. Limite portabile del path: **103 byte UTF-8**, senza fallback TCP; in caso di errore scegliere un agent dir più corto. Directory 0700, socket e record PID/lock 0600. Il socket pubblico è un hard link a un nome privato casuale della stessa istanza, non un secondo listener: la chiusura nativa non può cancellare il socket pubblico di una generazione successiva. Non rimuovere manualmente file mentre un broker è vivo.

`src/broker/spawn.ts` fornisce l'helper interno `ensureBroker`: health prima/dopo la lock esclusiva, spawn detached dal cwd runtime e diagnostica stderr limitata a **16 KiB**. Le lock contengono PID, timestamp e identificatore di generazione, pubblicati atomicamente; anche il recupero concorrente di una generazione morta è serializzato. PID vivi, inclusi PID riutilizzati, non vengono rimossi perché un probe fallisce. Record corrotti, proprietà del socket sconosciuta o stato incoerente dopo uno startup interrotto richiedono ispezione manuale: nessuna cancellazione forzata di endpoint sconosciuti. Solo i processi avviati dal tentativo corrente vengono terminati dopo un errore/timeout.

### Protocollo di trasporto iniziale (interno)

Frame: **4 byte uint32 big-endian + JSON UTF-8**, payload massimo **1 MiB**, header escluso. Reader incrementale e writer verificano il limite dell'intero envelope; UTF-8/JSON malformati chiudono soltanto il peer responsabile.

Ogni richiesta contiene `type`, `protocol: "openspace"`, `version: 1` e `requestId` non vuoto, massimo **256 byte UTF-8**, senza controlli ASCII. Operazioni implementate:

- `health` → `health_result`, stesso requestId, versione, PID, instanceId e features; nessun dato di sessione o credenziale.
- `prepare {id}` → ticket di lease; `register` con lease, mode claim/resume, session e gruppi specifici → `registered` con record completo (massimo **6 KiB**). La lease resta valida per resume soltanto mentre il broker conserva quella ownership.
- `list`, `list-cwd`, `resolve`, `update`, `set-workgroups`, `release`: registry e mutazioni correlate, con proiezione dei gruppi visibili e revisioni CAS.
- `ping` dopo register → `pong` correlato. Features: `liveness-v1`, `session-registry-v1`, `lease-resume-v1`; send esatto e bus estensioni non vengono pubblicizzati.

Il [contratto del registry](REGISTRY.md) descrive schema, retention delle lease, revoca, limiti, lookup ed eventi. La notifica di takeover è best effort, ma il rifiuto del ticket revocato sopravvive alla sua perdita e al restart. Il comportamento del controller Pi dopo il rifiuto sarà implementato separatamente.

Prima di register, operazioni applicative falliscono con `registration_required`; una seconda register chiude il peer con `already_registered`. Operazioni non implementate dopo register restituiscono `unsupported_operation`, mai un falso successo. Nome/versione incompatibili producono `incompatible_protocol`.

Limiti per broker: **128** connessioni registrate, **32** non registrate, deadline di registrazione **1 s**; token bucket per connessione di **240** messaggi, refill **120/s**. Le write usano la coda nativa di Node, con un budget di **4 MiB per peer**, header inclusi: oltre il budget il peer lento viene disconnesso. Nessuna coda applicativa illimitata; i limiti sono di trasporto, non autorizzazione o isolamento da processi ostili dello stesso utente.

## Verifiche

I test vivono in `tests/`, fuori dalla discovery Pi. Coprono configurazione, framing segmentato e boundary UTF-8, handshake, quote/rate/output, clock controllato, processi reali concorrenti, recovery, segnali, timeout, takeover/restart, roster massimo, status, revisioni, visibilità e packaging. Il manifest dichiara un solo entry point Pi; il processo broker non viene scoperto come estensione.

```sh
npm run check
npm test
npm pack --dry-run --json --workspace openspace
```

Check e test root orchestrano i workspace. I test non dipendono dai file temporanei dello studio né scrivono nella configurazione personale. Queste prove non dimostrano ancora i percorsi di messaggistica, il reconnect automatico del client o l'integrazione del broker nel lifecycle Pi.

Il package è distribuito con licenza MIT; gli avvisi applicabili sono conservati nei sorgenti.
