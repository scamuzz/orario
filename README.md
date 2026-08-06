# Orario Treni 🚆

Applicazione web per consultare orari e stato in tempo reale dei treni italiani,
integrando i servizi REST di **Trenitalia** (ViaggiaTreno) e **Trenord/leFrecce**.

## Funzionalità

| Tab | Descrizione |
|-----|-------------|
| **Cerca Treno** | Cerca soluzioni di viaggio tra due stazioni con data e orario (via leFrecce API) |
| **Partenze** | Tabella partenze in tempo reale da una stazione (ViaggiaTreno) |
| **Arrivi** | Tabella arrivi in tempo reale in una stazione (ViaggiaTreno) |
| **Stato Treno** | Andamento completo di un treno per numero: fermate, ritardi, binari |

## Architettura

```
Browser  ──→  Express server (Node.js, porta 3000)  ──→  ViaggiaTreno API
                                                    ──→  leFrecce API
```

Il backend funge da **proxy CORS**: il browser effettua tutte le chiamate al server
locale, che a sua volta interroga le API esterne. Questo evita i problemi di
Same-Origin Policy.

## API Routes (backend)

| Endpoint | Descrizione |
|----------|-------------|
| `GET /api/stazioni?q=<nome>` | Autocomplete stazioni ViaggiaTreno |
| `GET /api/stazioni/lefrecce?q=<nome>` | Autocomplete stazioni leFrecce |
| `GET /api/partenze/:idStazione` | Partenze da una stazione |
| `GET /api/arrivi/:idStazione` | Arrivi in una stazione |
| `GET /api/treno/:origine/:numero` | Andamento dettagliato di un treno |
| `GET /api/treno/info/:numero` | Ricerca treno per numero |
| `POST /api/soluzioni` | Ricerca soluzioni di viaggio (leFrecce) |

## Installazione e avvio

```bash
npm install
npm start
# → http://localhost:3000
```

Richiede Node.js ≥ 16.

## Deploy pubblico (GitHub Pages + Render)

Il frontend statico viene pubblicato su **GitHub Pages** e il backend Express su **Render** (piano gratuito).

### 1 – Backend su Render

1. Crea un account su [render.com](https://render.com) e collega il repository GitHub.
2. Render rileva `render.yaml` e crea automaticamente il servizio `orario-treni-api`.
3. Nota l'URL del servizio, ad esempio `https://orario-treni-api.onrender.com`.

### 2 – Imposta l'URL del backend nel frontend

Apri `public/config.js` e imposta `API_BASE` con l'URL del servizio Render:

```js
window.API_BASE = 'https://orario-treni-api.onrender.com';
```

Fai commit e push su `main`.

### 3 – Abilita GitHub Pages

1. Vai su **Settings → Pages** del repository.
2. In **Source** seleziona **GitHub Actions**.
3. Il workflow `.github/workflows/deploy.yml` pubblica automaticamente la cartella `public/` su ogni push a `main`.

Il sito sarà disponibile su `https://scamuzz.github.io/orario`.

---

## Fonti dati

- [ViaggiaTreno](http://www.viaggiatreno.it/) – API non ufficiale Trenitalia
- [leFrecce](https://www.lefrecce.it/) – API non ufficiale Trenitalia/Trenord

> ⚠️ Le API non sono documentate ufficialmente e possono cambiare senza preavviso.
> Utilizzare solo per uso personale o di test.