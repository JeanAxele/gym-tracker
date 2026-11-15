# Allenamenti offline

La build di produzione include una PWA. Dopo il primo accesso online, lascia aperta l'app fino al termine del download iniziale del catalogo, dei template e dello storico. Dal Galaxy S21 apri l'origine HTTPS in Chrome, quindi usa **Installa app** o **Aggiungi a schermata Home**. Torna sempre alla stessa origine e usa lo stesso profilo di Chrome.

Puoi aprire lo storico, iniziare da zero o da un template già scaricato, aggiungere esercizi dal catalogo locale, registrare o modificare serie e chiudere la sessione. Le serie con valori validi vengono salvate durante la modifica. Per nome e data esci dal campo prima di chiudere l'app. Le modifiche restano sul dispositivo dopo la chiusura finché il profilo di Chrome mantiene i dati del sito. Il login iniziale, la modifica del catalogo o dei template e l'assistente vocale remoto richiedono il server. Se hai già scaricato un template puoi usarlo come base per una sessione offline.

Tornato online, apri l'app e tienila attiva durante la sincronizzazione. Se la sessione è scaduta, entra di nuovo con lo stesso account. La coda resta sul dispositivo e un altro account non può vederla né inviarla. Se la stessa sessione è cambiata sul server, puoi aprire la copia locale e sincronizzarla come allenamento separato, oppure confermare che vuoi tenere la versione del server. Un rifiuto di validazione conserva i dati locali e offre un nuovo tentativo dopo la correzione.

## Prova locale senza costi

1. Parti dal branch della PR. Con l'ambiente virtuale attivo, dalla cartella `backend`, applica `alembic upgrade head` al database configurato, quindi avvia `python -m uvicorn app.main:app --port 8000`. Per un database di prova vuoto, dopo la migrazione lancia `python -m scripts.seed_db`. La nuova migrazione aggiunge solo la tabella delle ricevute di sync. Per usare i dati reali, tieni una copia di sicurezza del database prima dell'aggiornamento.
2. In `frontend` esegui `npm ci`, `npm run build` e `npm run preview -- --host 127.0.0.1`. Sul PC apri `http://127.0.0.1:4173`. Con Android Platform Tools e debug USB, puoi collegare il Galaxy S21 al PC ed eseguire `adb reverse tcp:4173 tcp:4173`. Poi apri lo stesso URL in Chrome sul telefono. È un modo per provare l'origine locale senza acquistare hosting. Per l'uso su rete e fuori casa serve un'origine HTTPS stabile che serva la build, con `/api` inoltrato a FastAPI oppure con `VITE_API_BASE_URL` HTTPS impostata prima della build e CORS configurato sul backend.
3. Accedi online e apri una sessione. Disconnetti il telefono, attiva modalità aereo e riapri l'app. Crea un allenamento, aggiungi una serie, modificala, chiudi la sessione e chiudi completamente l'app. Riaprila e controlla lo storico e l'ultima modifica.
4. Ripristina la connessione allo stesso backend. Per la prova via USB, ricollega il telefono e ripeti `adb reverse` se necessario. Riapri l'app, attendi che non ci siano allenamenti in attesa di sync e verifica sul PC che l'allenamento e la serie risultino presenti una sola volta.

## Integrazione IndexedDB ↔ FastAPI

Avvia FastAPI con un database SQLite temporaneo migrato e popolato dal seeder, e un `JWT_SECRET` di test. Dalla cartella `frontend`, con Node 20+ e dipendenze installate, esegui con le variabili `GYM_SYNC_TEST_URL` (origine di FastAPI senza `/api`) e `GYM_SYNC_TEST_SECRET` (lo stesso segreto del server di test):

```sh
npm test -- --reporter=verbose workoutSync.integration
```

Il test usa il vero endpoint FastAPI e un'implementazione IndexedDB in memoria. Chiude e riapre le connessioni IndexedDB, interrompe la consegna della prima risposta dopo la scrittura server, poi verifica retry, accesso scaduto, cambio di account, assenza di duplicati e conflitto con una modifica remota.
