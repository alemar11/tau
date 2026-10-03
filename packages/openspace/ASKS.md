# Ask e reply locali

Il tool Pi espone `ask`, `reply` e `pending`, oltre alle azioni di invio. `Conversation` e `ReplyTracker` sotto `src/client/` sono helper interni senza dipendenze Pi, usati anche dal futuro client CLI.

## Ask

`ask(to, {text, cwd?, workgroup?, messageId?, attachments?, signal?, timeoutMs?})` richiede testo non vuoto e un destinatario live. Risolve un solo gruppo, installa il listener prima della write e riserva un unico waiter per runtime **dopo** il lookup. La seconda chiamata concorrente fallisce con `ask_in_progress`, anche fra gruppi diversi. Non crea una mailbox per una nuova domanda a un destinatario offline.

Il risultato contiene `messageId`, `workgroup`, `status: answered | failed`, `code?`, ultimo `delivery` osservato e, se arrivata, la `response` completa con testo, allegati e provenienza. Se arriva prima dell'ack, la risposta è raccolta ma l'ultimo esito di trasporto può ancora essere `unknown/awaiting_delivery_result`. `answered` prova soltanto una risposta correlata, non la correttezza o il completamento del lavoro. Nel tool Pi la risposta entra nel risultato tool, senza una seconda injection come messaggio custom.

Gli ID espliciti attraversano il percorso senza sostituzione. Un riferimento ask non può essere riutilizzato per un nuovo waiter dello stesso runtime: `ask_id_reuse`. Si conservano fino a 4096 digest dei riferimenti usati, poi `ask_runtime_capacity`; non si espellono ID permettendo a una risposta vecchia di risolvere un nuovo waiter. Questo è distinto dal retry esatto di trasporto.

## Reply e inferenza

`pending` mostra ref completo, mittente, gruppo, età e preview. `reply` seleziona nell'ordine:

1. `replyTo: {workgroup, senderId, messageId}` esplicito e valido;
2. `to` tra gli ask pendenti: ID esatto, nome esplicito case-insensitive, prefisso ID univoco;
3. ask associato al turno Pi corrente;
4. unico pending.

Più candidati → `reply_ambiguous_use_pending`; nessun pending valido → `reply_not_pending`. Cwd non è un selettore reply. Il gruppo e il target restano quelli della domanda. Il broker verifica entrambi i partecipanti e le loro membership, non soltanto nomi o messageId. Reply arbitrarie, dirette a un altro peer o su un altro gruppo sono rifiutate.

Un send al mittente di un unico pending può inferire la reply e il suo gruppo. La selezione è fissata prima della conferma; non si trasforma un send ordinario in una reply a una domanda arrivata durante il dialogo. L'inferenza **non** bypassa `confirmSend`; una reply esplicita sì. Nel turno attivato da un ask, un send non-reply verso un altro target è bloccato. Risposta accettata dal broker rimuove il pending e l'eventuale held, senza abortire lavoro già passato a Pi. Errori di invio non cancellano automaticamente il pending, salvo invalidazione autorevole della relazione.

Il tracker conserva fino a **256 domande / 8 MiB**, con dedupe per riferimento e senza rinnovare la scadenza dei duplicati. La saturazione è osservabile con una ricevuta `expired/reply_tracker_capacity`. Non viene ripristinato dalla history. `replyHint` aggiunge il riferimento da usare soltanto mentre il pending è valido.

## Timeout indipendenti

| Componente | Default | Configurazione |
| --- | --- | --- |
| Waiter Pi | 10 minuti | `PI_OPENSPACE_ASK_TIMEOUT_MS` del processo Pi |
| ReplyTracker | 10 minuti | ambiente del receiver Pi |
| Ask edge broker | 10 minuti | ambiente letto quando parte quel processo broker |
| CLI prevista | 120 secondi | default/override della futura CLI |

Nessuna deadline viene propagata nel messaggio. Aumentare il tempo del caller non estende gli altri componenti; cambiare env non riconfigura un broker già attivo. Il waiter scade con `ask_timeout`, il tracker non offre più il pending, il broker rifiuta con `ask_expired` finché conserva il tombstone (poi `ask_not_pending`). La mailbox da 24 ore non rende valida una reply non ancora inviata dopo la scadenza dell'edge.

Timeout non invia cancel. Disconnect termina il waiter locale ma non cancella l'edge: una reply ancora valida può entrare in mailbox e arrivare dopo reconnect, senza risolvere un waiter nuovo. In Pi `inboundTrigger: replies` può avviare il turno per queste reply validate dal broker; un run non interattivo resta protetto e trattiene una reply non consumata fino al confine sicuro.

Abort esplicito libera il waiter e tenta `abandon-ask`: chiude la correlazione, **non** invia `cancel_message` e non abortisce il peer. La notifica è best effort se la connessione si perde. `cancel`/`supersedes` sono operazioni separate e chiudono anche l'edge. Shutdown invalida waiter e callback. Leave/rejoin non riapre la correlazione; normale disconnect non è leave.

## Broker e diagnostica

Feature negoziata `ask-reply-v1`. Edge RAM: massimo **256 / 4 MiB** di domande e metadata; 512 digest terminali mantengono motivi di chiusura, poi vengono espulsi. Le relazioni sono workgroup+sender+messageId, con entrambi gli stamp di membership. A→B/B→A è rifiutato con `mutual_ask` anche su gruppi diversi; nessuna prevenzione generale di cicli con tre o più peer.

`pending-asks.json` è un snapshot diagnostico privato, scritto atomicamente: domanda, sender, target, gruppo, created/expires, PID broker e `durable: false`. Non è una coda o un input di recovery. Gli errori di scrittura diagnostica sono segnalati su stderr senza convertire un invio già avvenuto in un rifiuto. Il file viene rimosso allo stop quando ancora posseduto; startup sostituisce eventuali residui di crash con lo snapshot vuoto. Non recupera waiter, edge o esecuzioni.

Un receiver Pi busy print/JSON/RPC risponde all'ask con un avviso busy correlato e verificato, non con un risultato inventato del task; l'avviso non interrompe il suo run. Nessun overlay viene aperto.
