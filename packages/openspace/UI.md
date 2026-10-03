# Comandi e UI Pi

I quattro comandi sono registrati dal factory, senza cambiare tool/schema al primo uso. Nessuna shortcut globale è registrata: `/openspace` resta disponibile senza collisioni silenziose con scorciatoie di altre estensioni. Non ci sono azioni remote, pane, focus o handover.

| Comando | Effetto |
| --- | --- |
| `/openspace` | Roster e compose, soltanto in modalità TUI |
| `/openspace-alias <nome>` | Aggiorna presence e nome nativo della sessione Pi; senza argomento usa input TUI/RPC se disponibile |
| `/openspace-id` | Aggiunge nell'editor TUI un contatto con ID completo e gruppi; altrove lo mostra senza creare un turno |
| `/openspace-workgroups` | Mostra i gruppi effettivi |
| `/openspace-workgroups add <nome>` | Aggiunge un gruppo specifico e salva per la sessione Pi |
| `/openspace-workgroups remove <nome>` | Rimuove un gruppo specifico e salva per la sessione Pi |

`default` è riservato: primo gruppo specifico → uscita dal fallback; ultimo rimosso → ritorno al solo `default`. I comandi usano le preferenze versionate, non env/global config. Ack broker e accettazione del salvataggio Pi precedono l'indicazione di successo. Un errore di storage non annulla la membership live già cambiata. Uscire da un gruppo termina ask/held ancora posseduti, senza cancellare history o fermare lavoro già consegnato.

## Roster e compose

La sessione corrente è separata dai peer. Una riga per ID, nomi duplicati ammessi, ID breve disambiguato, gruppi condivisi, cwd/modello, stato e context usage. La larghezza disponibile limita la vista, non i dati del modello; il tool list restituisce il roster completo.

Selezione fissata all'ID e a un solo workgroup: con più gruppi comuni viene mostrata una scelta. Lookup e invio conservano le generazioni di membership; leave/rejoin o takeover non possono essere aggirati da un retry del socket. Disconnect ordinario può invece consegnare alla mailbox dello stesso ID.

Compose usa l'Editor Pi: paste, Unicode e protocolli tastiera sono quelli dell'host. Invio è un'azione umana esplicita, senza una seconda `confirmSend`; invia testo ordinario, non una reply inferita. Per rispondere a una domanda correlata usare il tool `reply`. Allegati UI non supportati in questa fase; quelli ricevuti sono leggibili espandendo il messaggio.

- Invio mostra lo stato sending e blocca ulteriori submit fino all'esito.
- Errori/esiti incerti conservano il draft; Invio riprova **solo su richiesta umana**.
- Un retry incerto con testo identico conserva il messageId. Una modifica del testo o un rifiuto noto produce un nuovo ID: l'eventuale vecchia consegna non viene annullata. Il replay rimane limitato e non durevole, non una garanzia exactly-once.
- Escape chiude l'overlay e l'eventuale attesa locale, **non cancella il messaggio o il lavoro remoto**. Un invio già avviato può avere esito incerto.
- Le azioni di selezione usano i keybinding TUI configurati; l'editor conserva quelli nativi. Nessuna modifica al footer, header o editor globale.

## Risultati e ricevute

Socket, mailbox RAM, rifiuto ed esito incerto hanno etichette distinte. Nessuna spunta di completamento: neppure `injected` prova che il modello abbia eseguito o concluso il lavoro. Le ricevute injected/expired/cancelled/superseded/cancellation_requested producono notifiche TUI/RPC best effort, deduplicate con una cache limitata a 256 riferimenti; non sono un registro durevole.

Messaggi: mittente/ID e gruppo, preview collassata limitata, allegati e richiesta di reply, dettaglio espandibile. Tool list/list-cwd: una riga collassata con conteggio; espansione mostra i dettagli completi. Solo il rendering neutralizza controlli terminale; contenuto/attachments destinati al modello restano invariati. Il layout conserva soltanto testo non colorato, così il tema corrente si applica anche a componenti già creati.

RPC può avere `hasUI` ma non apre overlay terminali. Print/JSON mostrano gli esiti dei comandi su stderr, mai stdout né turni artificiali; i tool restano operativi. La CLI separata rimane in sviluppo.

## Evidenza e limiti

Test con SDK Pi 0.99.1, broker reale e driver dei componenti: duplicati, scelta gruppo, disconnect/mailbox, leave/rejoin, retry, lifecycle, persistenza, modalità headless, paste/backspace per grapheme e Kitty. Viewport da 1 a 160 colonne, resize e tema mutabile. A 1–2 colonne viene applicato un minimo interno all'Editor prima del clipping, per evitare una ricorsione del suo wrapping sui caratteri larghi; nessuna patch all'host.

Calm e Orange vengono caricati insieme e verificati con rendering/tema, senza sostituirne la UI globale. Queste prove sono automatizzate: nessuna certificazione manuale IME o test visivo su ogni terminale.
