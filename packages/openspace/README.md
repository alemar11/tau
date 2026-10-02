# Openspace

Package Pi autonomo per la futura comunicazione locale fra sessioni. Nome npm `tau-openspace`, versione `0.1.0`, privato; solo **macOS e Linux**, Node.js **22.19+**, target Pi **0.99.1**.

## Stato effettivo

Implementato il primo blocco, **package-foundation**: manifest, loader TypeScript, configurazione, path isolati, parsing iniziale dei workgroup e test. L'estensione valida la configurazione a `session_start`, non all'import, e non apre connessioni, processi, watcher o timer.

**Non è ancora uno strumento di messaggistica utilizzabile.** Broker, registrazione, send/ask/reply, UI, comandi workgroup, persistenza per sessione, API estensioni e handover sono ancora da implementare. Herdr, SSH e bridge subagenti rimangono differiti. Non sono esposti tool o comandi Pi fittizi, skill o export API verso file inesistenti.

Il bin riserva il nome `openspace`: `--help` e `--version` funzionano; altri argomenti terminano con codice **2**, errore su stderr e nessun invio. Nessun contratto JSON della CLI è ancora disponibile.

## Preparare e caricare il package

Dal checkout Tau, usare `mise install` e la shell mise (oppure anteporre `mise exec --` ai comandi) per Node 22.19.0. Installare le dipendenze del singolo workspace:

```sh
npm install --ignore-scripts --workspace tau-openspace
npm run check --workspace tau-openspace
npm test --workspace tau-openspace
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
  "brokerCommand": "npx",
  "brokerArgs": ["--no-install", "tsx"],
  "replyHint": true,
  "confirmSend": false,
  "inboundTrigger": "always",
  "busyDelivery": "steer"
}
```

Questi sono i default della configurazione. I campi di delivery e launcher sono per i componenti successivi: **non avviano un broker in questa versione**. I comandi configurati sono codice fidato dell'utente, mai testo ricevuto da un peer.

Campi opzionali:

- `stableId`: stringa non vuota, normalizzata con trim. Il futuro routing ID sarà unico nell'intero broker: un valore globale può provocare takeover anche fra workgroup disgiunti.
- `status`: nota personalizzata, massimo **1 KiB UTF-8**, conservata senza troncamento. Non sostituisce il futuro stato automatico `idle/thinking/tool`. Il limite complessivo del record di presenza da 6 KiB sarà verificato dal registry, non da questo parser isolato.

Valori ammessi: `inboundTrigger` = `always | replies | never`; `busyDelivery` = `steer | human-first`; gli altri flag sono booleani, `brokerArgs` un array di stringhe. Command, argomenti e stable ID rifiutano NUL espliciti. Config assente → default; JSON/campi noti invalidi o errori di lettura → errore con path e campo ove applicabile, mai fallback silenzioso. Le chiavi sconosciute vengono ignorate, non abilitate come funzionalità. Non sono consumate opzioni Herdr/SSH.

`enabled: false` non carica le variabili proprie né avvia risorse. Config nuova a ogni `session_start`/reload, nessun watcher. Non si scrivono file di configurazione o variabili globali.

### Ambiente Openspace

| Variabile | Default / significato |
| --- | --- |
| `PI_OPENSPACE_STABLE_ID` | Override non vuoto normalizzato; il routing effettivo arriverà col registry |
| `PI_OPENSPACE_WORKGROUPS` | Lista specifica separata da virgole; assente/vuota → fallback `default` |
| `PI_OPENSPACE_ASK_TIMEOUT_MS` | 600000 ms; sarà letto indipendentemente dai processi interessati |
| `PI_OPENSPACE_LIVENESS_INTERVAL_MS` | 30000 ms |
| `PI_OPENSPACE_LIVENESS_TIMEOUT_MS` | 5000 ms, limitato all'intervallo configurato |

Prefisso `PI_` convenzionale, non interpretazione automatica dell'host. Le variabili vuote/spazi usano il default; i timeout espliciti devono essere interi da 1 a **2147483647 ms** per evitare l'overflow dei timer Node. Valori malformati causano un errore esplicito. Sono lette soltanto le variabili proprie elencate sopra, senza pubblicare l'identità in `process.env`.

Esempio di seed, non ancora di sessioni collegate:

```sh
PI_OPENSPACE_WORKGROUPS=progetto,review pi -e ./packages/openspace
```

Il parser applica trim, deduplicazione e confronto esatto case-sensitive; rifiuta componenti vuoti interni, virgole nei singoli nomi e caratteri di controllo. Non tronca i nomi o applica un limite arbitrario per singolo gruppo; i budget del record saranno applicati dal registry. `default` è riservato e non configurabile, nemmeno insieme ad altri nomi: lista specifica vuota → solo `[default]`, altrimenti solo i gruppi specifici.

La configurazione iniziale **non implementa** ancora `/openspace-workgroups` o la persistenza: le future preferenze della singola sessione, inclusa `[]`, prevarranno sull'ambiente. I workgroup organizzeranno routing/discovery, non autenticheranno peer né isoleranno il contesto del modello.

## Verifiche

I test vivono in `tests/`, fuori dalla discovery Pi. Coprono parsing/config errori e boundary UTF-8, ambiente isolato, loader Pi, assenza di risorse durante import/avvio disabilitato e contenuto del tarball/launcher. Il manifest dichiara un solo entry point reale.

```sh
npm run check
npm test
npm pack --dry-run --json --workspace tau-openspace
```

Check e test root orchestrano i workspace. I test non dipendono dai file temporanei dello studio né scrivono nella configurazione personale. La validazione corrente non dimostra i percorsi di messaggistica o il funzionamento del futuro broker su entrambe le piattaforme.

Il package è distribuito con licenza MIT; gli avvisi applicabili sono conservati nei sorgenti.
