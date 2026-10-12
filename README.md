# Gym Log

Diario di allenamento personale: web app installabile su iPhone, funziona offline.
Nessun server e nessun account: i dati restano nel telefono (IndexedDB) e si salvano con un backup JSON.

## Pubblicazione su GitHub Pages

1. Crea un repository **pubblico** (es. `gym-log`) e carica tutti i file di questa cartella nella radice.
2. Repository › **Settings › Pages** › *Build and deployment*: **Deploy from a branch**, branch `main`, cartella `/ (root)` › **Save**.
3. Dopo 1–2 minuti l'app è su `https://<utente>.github.io/gym-log/`.

> Nel repository va **solo il codice**. Non caricare mai i file di backup (`gymlog-*.json`): il `.gitignore` li esclude.

## Installazione su iPhone

1. Apri l'indirizzo in **Safari** › Condividi › **Aggiungi alla schermata Home**.
2. Usa sempre l'icona sulla Home: i dati dell'app installata sono separati da quelli della scheda di Safari.
3. Eliminare l'icona elimina anche i dati: fai prima un backup.

## Aggiornare l'app

1. Carica i file modificati nel repository.
2. In `sw.js` aumenta `VERSION` (es. `gymlog-v1.0.1`), altrimenti il telefono continua a usare la versione in cache.
3. Alla successiva apertura l'app mostra «Nuova versione disponibile › Aggiorna». I dati non vengono toccati.

## Struttura

| File | Contenuto |
|---|---|
| `index.html` | pagina unica |
| `css/app.css` | stile (tema scuro, controlli grandi) |
| `js/app.js` | schermate e logica |
| `js/db.js` | IndexedDB, query, backup/import/CSV |
| `js/util.js` | funzioni di supporto |
| `sw.js` | service worker per l'uso offline |

## Formato del backup

```json
{ "app": "gymlog", "schema": 1, "exportedAt": "…",
  "data": { "gyms": [], "exercises": [], "templates": [], "sessions": [], "sets": [] } }
```

Ogni serie: `{ id, sessionId, exerciseId, kind: "warmup" | "work", weight, reps, note, ts }`.
Lo storico è legato all'esercizio, non alla scheda: rinominare esercizi o cambiare le schede non lo altera.
