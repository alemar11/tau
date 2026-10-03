# Invio locale — protocollo interno

`Messenger` (`src/client/messenger.ts`) aggiunge invio, ricevute e controlli al client core. Non importa Pi, non legge file allegati e non avvia processi. L'adapter Pi e [ask/reply](ASKS.md) usano questo trasporto; la CLI è il passo successivo dedicato.

## Destinazione e invio

`resolve({to?, cwd?, workgroup?})` sceglie una destinazione esatta, anche recentemente disconnessa, un solo gruppo e gli epoch di membership del mittente/destinatario. Restano le regole del registry: zero gruppi comuni → errore, più gruppi → scelta esplicita, niente fallback al primo peer o a un altro gruppo. L'ID esatto resta prioritario; nomi omonimi live/offline rimangono ambigui, salvo un filtro cwd che li distingua. Gli alias runtime non sono identità trasferibili.

`send(to, {text, messageId?, workgroup?, cwd?, attachments?, supersedes?, retryOf?, provenance?, signal?})` restituisce un `DeliveryResult`. `sendResolved` mantiene una selezione già fatta, utile per conferma/compose. Il messageId esplicito è conservato; altrimenti viene generato un UUID. Le mutazioni del payload del caller durante lookup non cambiano il testo inviato.

Il broker ottiene il mittente dalla connessione posseduta. Il wire contiene destinatario ID + endpointEpoch, workgroup, epoch di entrambe le membership e il corpo. La riadesione a un gruppo non rende valide lookup precedenti. Solo `endpoint_rebound`, che garantisce **nessuna consegna**, permette un unico nuovo lookup e retry, verso lo stesso ID e gruppo. Nessun retry automatico dopo timeout, abort o perdita di un acknowledgement.

Risultato:

- `socket_delivered`: scritto/accodato sul socket, non prova di ricezione, injection o completamento del lavoro;
- `queued`: conservato nella mailbox RAM;
- `failed`: rifiuto noto prima della consegna, oppure coda annullata/scaduta;
- `unknown`: una write può essere avvenuta ma manca un esito affidabile; outcomeKnown false.

MessageId, gruppo risolto, code, retryable e outcomeKnown restano separati. Un retry esplicito identico consulta l'esito conservato, non reinietta. Un codice terminale può accompagnare una precedente socket_delivered: cancellazione e risultato originale del trasporto non vengono confusi.

Gli allegati sono `{type: file | snippet | context, name, text, language?}`: solo contenuto testuale, massimo tecnico 32 allegati. Nessuna lettura implicita di path ricevuti. Il limite di 1 MiB riguarda sia l'intera richiesta sia l'intero evento consegnato, inclusi sender, recipient, gruppo, timestamp ed escaping JSON. Ogni runtime mantiene una sequenza crescente; niente ordine globale fra mittenti o attraverso reconnect.

## Replay e mailbox

Replay indicizzato da **workgroup + sender ID + messageId**, con fingerprint di contenuto, target originale, allegati, correlazione, provenance e link. Timestamp, sequenza di trasporto ed epoch del socket non cambiano il fingerprint. Contenuto o target diversi sotto lo stesso riferimento → `E_MESSAGE_ID_REUSE`.

Limiti:

| Risorsa | Count | Budget JSON | Retention massima |
| --- | --- | --- | --- |
| Replay | 4096 | 16 MiB di metadata con margine per aggiornamenti | 1 ora, salvo pressione di capacità |
| Mailbox | 256 | 16 MiB aggregati dei messaggi | 24 ore |

Le copie complete dei messaggi vengono trattenute solo mentre queued; dopo forwarding restano fingerprint e metadata. I queued mantengono la protezione replay finché restano nella mailbox. Pressione mailbox espelle il queued più vecchio con `expired/mailbox_overflow`; un singolo messaggio oltre budget viene rifiutato senza svuotare la coda. Replay espelle solo record non queued (`replay_evicted`), o rifiuta l'ammissione se non può liberare spazio. Non si promette exactly-once dopo scadenza, eviction o restart.

La recovery ammette ID esatto, oppure nome esplicito + cwd canonico + workgroup con un solo candidato, mai il mittente stesso. I record offline omonimi concorrenti impediscono un trasferimento ambiguo; un alias runtime non concede recovery per nome. Il destinatario effettivo diventa il proprietario delle ricevute del messaggio recuperato. I gruppi sono rivalidati: un nuovo ID/epoch non autorizza un nuovo gruppo.

Disconnect normale non è uscita. Uscita esplicita, revoca/cambio di ownership pertinente o perdita della validità delle membership invalidano le code interessate. Il risultato terminale rimane nel replay: rejoin non lo riapre. Una nuova claim dello stesso ID può recuperare dati queued nel gruppo ancora condiviso. La retention mailbox è un limite massimo, non una garanzia indipendente dalla validità dell'ownership. Il broker riavviato non ricostruisce nulla di questo stato RAM.

## Ricevute e controlli

`subscribe` espone message, receipt, control e ask_closed. `receipt(ref, status, code?)` è ammessa solo per il destinatario effettivo e la sua membership corrente. Ref = `{workgroup, senderId, messageId}`; nessun indice globale per il solo messageId.

Status: receiver_received, acknowledged, queued, injected, expired, cancelled, superseded, cancellation_requested. Sono diagnostici, non una progressione monotona: acknowledged può precedere queued. Una injection già osservata non viene trasformata in "lavoro cancellato": successive ricevute cancelled/superseded/expired diventano cancellation_requested.

`cancel(ref)` è riservato al mittente originario corrente. In mailbox rimuove davvero la consegna; dopo write invia un controllo al receiver e risponde cancellation_requested. Il receiver Pi distingue held da già injected. Controlli pendenti vengono riproposti al receiver sul resume entro la retention, senza replay del messaggio. Supersedes richiede stesso mittente, gruppo e destinatario effettivo; retryOf è soltanto un collegamento a un nuovo tentativo esplicito.

ReplyTo ed expectsReply sono validati dal servizio ask del broker: destinatario live per le nuove domande, relazione originaria e membership valide per le risposte. Nessuna reply arbitraria o deadline negoziata; vedere [ASKS](ASKS.md).

Features broker: `delivery-v1`, `exact-send-v1` e `ask-reply-v1`, oltre a liveness/registry/lease-resume. Le notifiche e i controlli non avviano modelli: questa responsabilità appartiene all'adapter Pi.
