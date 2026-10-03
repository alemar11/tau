# Registry locale — protocollo interno v1

Il broker offre registrazione, discovery, lookup, presenza e mutazioni dei workgroup. Il client e l'[invio di messaggi](DELIVERY.md) usano questo registry; l'adapter Pi collega lifecycle e preferenze della sessione. I comandi interattivi sono un passo successivo. Gli helper sotto `src/registry/` non sono un export API pubblico del package.

Ogni richiesta mantiene l'envelope `type`, `protocol: "openspace"`, `version: 1`, `requestId` (1–256 byte UTF-8, senza controlli ASCII). Frame completo entro 1 MiB. Le risposte correlate conservano il requestId; gli eventi `presence` non ne hanno uno.

## Registrazione e fencing

1. Su una connessione nuova: `prepare` con `id` → `prepared` con `lease`.
2. Conservare la lease **prima di tentare register**, nel runtime, non in `process.env`.
3. `register` con `mode: "claim"`, la stessa `lease`, `session` e `workgroups` specifici → `registered` con `session` e `features`.

Esempio di corpo register, escluso l'envelope:

```json
{
  "mode": "claim",
  "lease": "<ticket ricevuto da prepare>",
  "session": { "id": "worker-a", "cwd": "/progetto", "model": "provider/model", "pid": 123 },
  "workgroups": ["progetto", "review"]
}
```

`session` richiede id, cwd, model e pid; accetta startedAt, name, status, contextUsage e tmuxPane. I campi generati dal broker non sono scrivibili dal peer. Un ID è unico **nell'intero broker**, anche fra gruppi disgiunti. Una nuova claim dello stesso ID sostituisce il runtime precedente.

- Il ticket è firmato dal broker, legato all'hash dell'ID e ammissibile per **5 minuti**. I ticket inutilizzati non occupano il ledger. La firma delimita la finestra di replay, non autentica l'identità dell'agente.
- Per riprendere una connessione usare `mode: "resume"` con **la stessa lease**, session e workgroups. Non chiedere un nuovo ticket dopo un rifiuto terminale per tentare di riprendersi l'ID.
- Un'acknowledgement persa non richiede una nuova claim: il ticket è già noto al chiamante. Resume, oppure ripetizione esatta di una claim ancora corrente, sono idempotenti rispetto all'ownership. Ogni nuova connessione ruota comunque endpointEpoch e chiude il socket precedente.
- Takeover da un'altra lease: `endpoint_replaced` al vecchio socket, best effort. Anche perdendo la notifica, il vecchio ticket è respinto. Il riuso di una lease corrente su un nuovo socket produce invece `connection_replaced`, non revoca della lease.
- `endpoint_revoked`, `lease_unknown`, `lease_expired` e `lease_invalid` sono terminali per quel ticket. Resume non diventa mai implicitamente claim. Un ticket mai registrato e ormai scaduto non può essere usato come prova di ownership. La gestione dei retry e dell'avviso in Pi appartiene al task client.
- `release` su una connessione registrata → `released`, poi chiusura: termina esplicitamente la lease e lascia tutti i gruppi. La semplice disconnessione non è release né uscita dai gruppi.

### Persistenza e limiti delle lease

`leases.json`, mode 0600 nella directory runtime 0700, conserva chiave di firma, ownership corrente e tombstone di revoca. Contiene hash, non metadati del roster; gli hash non sono anonimizzazione. Non è un archivio di conversazioni o workgroup.

L'ownership viene salvata **prima** di cambiare registry/rispondere: file temporaneo, fsync, rename atomico, fsync della directory ove supportato e checksum verificato al caricamento. Un errore di scrittura, anche con esito incerto dopo rename, ferma il broker: non continua a servire il vecchio stato. Uno store corrotto blocca lo startup; non si recupera da un backup che potrebbe precedere una revoca. Rimuovere lo store a broker fermo invalida le lease precedenti, non le trasforma in nuove claim.

Le ownership inattive scadono **24 ore dopo l'ultimo checkpoint**. Register/resume rinnovano la retention; un checkpoint orario rinnova i runtime connessi e raccoglie gli scaduti. Le tombstone restano almeno fino alla fine della finestra di ammissione del vecchio ticket: dopo la raccolta, claim scade e resume sconosciuto resta rifiutato. Un restart ordinario entro la retention conserva il resume del proprietario corrente e il fencing dei precedenti. La raccolta salva anche un high-water mark temporale: un arretramento dell'orologio, anche dopo restart, non riapre la finestra di un ticket revocato già raccolto. Le scadenze usano questo tempo non retrogrado, non promettono durata reale esatta sotto salti dell'orologio.

Limiti tecnici: **1024 ownership correnti**, **1024 tombstone**, file **512 KiB**. Esaurimento → `lease_capacity`, senza takeover parziale né eviction di un proprietario vivo. Release libera un'ownership, ma può richiedere una tombstone fino alla scadenza del ticket. Nessuna pulizia automatica può rendere nuovamente ammissibile una claim revocata.

## Record, presenza e revisioni

Un `SessionInfo` pubblicato contiene:

- id, endpointEpoch, revision e membershipRevision;
- workgroups effettivi, cwd canonico, model, pid, startedAt, lastActivity;
- name opzionale oppure runtimeFallbackAlias casuale;
- status, contextUsage e tmuxPane opzionali; trustedLocal prodotto dal trasporto.

`trustedLocal` non autentica PID, cwd, modello o dichiarazioni del peer. I nomi possono ripetersi. Gli alias senza nome sono effimeri, distinti dall'ID e non trasferibili come identità mailbox; un nuovo runtime o restart del broker può generarne uno nuovo. Il roster restituisce gli ID completi, senza prefissi troncati ambigui.

Status: `{state: "idle" | "thinking", note?}` oppure `{state: "tool", toolName, note?}`. ToolName massimo **256 byte UTF-8**, note massimo **1 KiB UTF-8**. ContextUsage: `{tokens: number | null, contextWindow: number, percent: number | null}`; contatori non negativi, percentuale finita non negativa (può superare 100). `contextUsage: null` nell'update rimuove il dato sconosciuto. Anche name, status e tmuxPane possono essere cancellati con null.

L'intero record generato, inclusi gruppi, revisioni e JSON escaping, è limitato a **6 KiB**. Nessuna soglia separata arbitraria su nome/modello/cwd. Un rifiuto `record_too_large` non modifica metadati, gruppi o ownership. **128 record**, incluso il richiedente, più envelope e correlazione massima entrano in un singolo frame da 1 MiB.

- `update {expectedRevision, patch}`: patch di name/model/status/contextUsage/tmuxPane.
- `set-workgroups {expectedRevision, workgroups}`: sostituzione atomica della lista specifica; `[]` → solo default, altrimenti solo i gruppi specifici. `default` esplicito è invalido.
- Risposta `session_updated {session, changed}`. CAS stale → `revision_conflict`. No-op → changed false, nessuna revisione o evento aggiuntivo. Ordine dei gruppi e duplicati non sono cambiamenti.
- Revision cresce per ogni modifica effettiva; membershipRevision soltanto per cambiamenti dei gruppi. Ping non genera presenza né aggiorna lastActivity.

Le transizioni interne distinguono join/resume/takeover/update/workgroups/disconnect/release e riportano gruppi lasciati/aggiunti. Gli stamp per singolo gruppo sopravvivono al disconnect/resume sullo stesso broker; leave/rejoin cambia epoch anche se torna la stessa etichetta. Takeover e restart invalidano gli stamp precedenti. I futuri consumer devono controllare anche socket/endpointEpoch prima degli effetti, non trattare una membership valida ma offline come una connessione attiva.

Sul medesimo broker, resume conserva i metadati e gruppi più recenti del registry, anche se l'ack di una mutazione è andata persa. Dopo restart i metadati RAM vengono ripubblicati dal chiamante; non si promette persistenza delle preferenze a livello broker. Le code, attese e channel ownership saranno collegate alle transizioni nei rispettivi task.

## Discovery, lookup ed eventi

- `list {workgroup?}` → `sessions {sessions}`. Include sé stessi e peer con almeno un gruppo comune, una riga per ID. I gruppi di ciascun peer sono proiettati sull'intersezione visibile, non rivelati integralmente.
- `list-cwd {cwd, workgroup?}` → roster filtrato.
- `resolve {to?, cwd?, workgroup?}` → `resolved {session, workgroup}`; serve almeno to oppure cwd. Precedenza: ID esatto, nome/alias esatto case-insensitive, prefisso ID univoco. Cwd vincola il risultato del livello selezionato: niente fallback a un altro peer dopo un mismatch. Solo cwd esclude sé stessi; un destinatario esplicito self è rifiutato.
- Nessun target visibile → `target_not_found`, anche se esiste in un gruppo estraneo. Più target → `target_ambiguous`. Zero gruppi comuni → nessuna risoluzione; più gruppi comuni richiedono un selettore esplicito (`workgroup_ambiguous`). Un filtro estraneo al richiedente → `workgroup_not_shared`.
- Cwd: normalizzazione lessicale e realpath dei percorsi esistenti; path non più esistenti restano lessicali. Cwd relativo in register è relativo alla directory runtime; nei filtri è relativo al cwd registrato del richiedente. I client dovrebbero pubblicare cwd assoluti. I selettori combinati hanno un budget JSON di 6 KiB e non vengono riflessi negli errori.
- `presence` con event joined/updated porta un record proiettato; left porta id ed endpointEpoch. Una mutazione aggiorna la visibilità di entrambi i lati senza duplicare peer multigruppo. L'ack al chiamante precede i suoi eventi. Gli eventi non sono durevoli: dopo reconnect leggere list.

Features di registry: `liveness-v1`, `session-registry-v1`, `lease-resume-v1`. Il broker annuncia anche `delivery-v1`, `exact-send-v1` e `ask-reply-v1`; il bus estensioni non è ancora disponibile. Tutto questo è coordinamento cooperativo fra processi dello stesso utente: un nuovo runtime locale può ancora preparare una nuova claim e sostituire un ID; non è un sistema di autenticazione o una sandbox.
