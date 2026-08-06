'use strict';

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Base URLs ───────────────────────────────────────────────────────────────
const VIAGGIATRENO = 'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno';
const LEFRECCE = 'https://www.lefrecce.it/Channels.Website.BFF.WEB/website';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Proxy a GET request to an external URL and return the parsed JSON (or text).
 */
async function proxyGet(url, res, { text = false } = {}) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OrarioTreni/1.0)',
        Accept: 'application/json, text/plain, */*',
      },
      timeout: 10000,
    });
    if (!r.ok) {
      return res.status(r.status).json({ error: `Upstream error: ${r.status}` });
    }
    const body = text ? await r.text() : await r.json();
    return res.json(body);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}

/**
 * Proxy a POST request to an external URL.
 */
async function proxyPost(url, payload, res) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OrarioTreni/1.0)',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      timeout: 10000,
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ error: `Upstream error: ${r.status}`, detail: txt });
    }
    const body = await r.json();
    return res.json(body);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── API Routes ───────────────────────────────────────────────────────────────

/**
 * GET /api/stazioni?q=<nome>
 * Autocomplete stazioni ViaggiaTreno (Trenitalia).
 * Restituisce array di { nome, id } (parsing del formato testo "NOME|ID").
 */
app.get('/api/stazioni', async (req, res) => {
  const q = (req.query.q || '').trim().toUpperCase();
  if (!q) return res.json([]);
  const url = `${VIAGGIATRENO}/autocompletaStazione/${encodeURIComponent(q)}`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/plain, */*' },
      timeout: 8000,
    });
    const text = await r.text();
    // Response is "Nome Stazione|SXXXXX\nNome Stazione2|SXXXXX\n..."
    const stations = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [nome, id] = line.split('|');
        return { nome: nome ? nome.trim() : line, id: id ? id.trim() : '' };
      })
      .filter((s) => s.id);
    return res.json(stations);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/stazioni/lefrecce?q=<nome>&limit=5
 * Autocomplete stazioni leFrecce (per ricerca soluzioni leFrecce).
 */
app.get('/api/stazioni/lefrecce', async (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = parseInt(req.query.limit, 10) || 5;
  if (!q) return res.json([]);
  const url = `${LEFRECCE}/locations/search?name=${encodeURIComponent(q)}&limit=${limit}`;
  return proxyGet(url, res);
});

/**
 * GET /api/partenze/:idStazione?orario=<HH:MM>
 * Partenze da una stazione (ViaggiaTreno).
 */
app.get('/api/partenze/:id', async (req, res) => {
  const id = req.params.id;
  // orario opzionale in formato ISO o timestamp; se non fornito usa "now"
  const now = new Date();
  const ts = now.toISOString().slice(0, 16).replace('T', ' ');
  const url = `${VIAGGIATRENO}/partenze/${encodeURIComponent(id)}/${encodeURIComponent(ts)}`;
  return proxyGet(url, res);
});

/**
 * GET /api/arrivi/:idStazione
 * Arrivi in una stazione (ViaggiaTreno).
 */
app.get('/api/arrivi/:id', async (req, res) => {
  const id = req.params.id;
  const now = new Date();
  const ts = now.toISOString().slice(0, 16).replace('T', ' ');
  const url = `${VIAGGIATRENO}/arrivi/${encodeURIComponent(id)}/${encodeURIComponent(ts)}`;
  return proxyGet(url, res);
});

/**
 * GET /api/treno/:idStazioneOrigine/:numeroTreno
 * Andamento dettagliato di un treno (fermate, ritardi, binari).
 * Il timestamp di mezzanotte è calcolato lato server per la data odierna.
 */
app.get('/api/treno/:origine/:numero', async (req, res) => {
  const { origine, numero } = req.params;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const ts = midnight.getTime();
  const url = `${VIAGGIATRENO}/andamentoTreno/${encodeURIComponent(origine)}/${encodeURIComponent(numero)}/${ts}`;
  return proxyGet(url, res);
});

/**
 * POST /api/soluzioni
 * Ricerca soluzioni di viaggio tramite leFrecce.
 * Body: { originId, originName, destId, destName, date, time }
 *   date: "YYYY-MM-DD", time: "HH:MM"
 */
app.post('/api/soluzioni', async (req, res) => {
  const { originId, originName, destId, destName, date, time } = req.body || {};
  if (!originId || !destId || !date) {
    return res.status(400).json({ error: 'Parametri mancanti: originId, destId, date richiesti.' });
  }
  const payload = {
    origin: { id: originId, name: originName || '' },
    destination: { id: destId, name: destName || '' },
    arflag: 'A',
    adate: date,
    atime: time || '00:00',
  };
  const url = `${LEFRECCE}/timetable/search`;
  return proxyPost(url, payload, res);
});

/**
 * GET /api/treno/info/:numeroTreno
 * Cerca informazioni base del treno per numero (ViaggiaTreno cerca stazione origine).
 */
app.get('/api/treno/info/:numero', async (req, res) => {
  const { numero } = req.params;
  const url = `${VIAGGIATRENO}/cercaNumeroTrenoTrenoAutocomplete/${encodeURIComponent(numero)}`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/plain, */*' },
      timeout: 8000,
    });
    const text = await r.text();
    // Format: "NUMERO - DESTINAZIONE|CODICE_PARTENZA-NUMERO\n..."
    const results = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [label, value] = line.split('|');
        if (!value) return null;
        const [codOrigine] = value.split('-');
        return { label: label.trim(), codOrigine: codOrigine.trim(), numero: numero };
      })
      .filter(Boolean);
    return res.json(results);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Orario Treni server running at http://localhost:${PORT}`);
});
