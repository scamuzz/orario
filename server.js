'use strict';

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const AdmZip = require('adm-zip');
const { transit_realtime } = require('gtfs-realtime-bindings');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Base URLs ───────────────────────────────────────────────────────────────
const VIAGGIATRENO = 'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno';
const LEFRECCE = 'https://www.lefrecce.it/Channels.Website.BFF.WEB/website';
const TRENORD_HAFAS = 'https://orari.trenord.it/hafas';

// ─── e015 / GTFS config (set via env vars after obtaining credentials) ────────
const GTFS_API_KEY = process.env.TRENORD_API_KEY || '';
const GTFS_STATIC_URL = process.env.TRENORD_GTFS_STATIC_URL || '';
const GTFS_RT_URL = process.env.TRENORD_GTFS_RT_URL || '';
const GTFS_REFRESH_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── In-memory GTFS static cache ─────────────────────────────────────────────

/**
 * gtfsCache holds parsed GTFS static data:
 *   stops:       Map<stop_id, { stop_id, stop_name, stop_lat, stop_lon }>
 *   trips:       Map<trip_id, { trip_id, route_id, service_id, trip_headsign, direction_id }>
 *   routes:      Map<route_id, { route_id, route_short_name, route_long_name }>
 *   stopTimes:   Map<stop_id, Array<{ trip_id, arrival_time, departure_time, stop_sequence }>>
 *   services:    Set<service_id>  (active today per calendar + calendar_dates)
 *   lastLoaded:  number (Date.now())
 */
let gtfsCache = null;
let gtfsLoading = false;
let gtfsLoadTimer = null;

/** Parse a GTFS CSV text into an array of objects keyed by header row. */
function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Simple CSV split (no quoted-field support – GTFS rarely uses embedded commas in fields)
    const parts = line.split(',');
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (parts[idx] || '').trim(); });
    rows.push(obj);
  }
  return rows;
}

/** Return today's date as "YYYYMMDD" string (local). */
function todayGtfs() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** Return the day-of-week field name for today ("monday"…"sunday"). */
function todayDow() {
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date().getDay()];
}

/** Compute the Set of active service_ids for today from calendar.txt + calendar_dates.txt. */
function computeActiveServices(calendarRows, calendarDatesRows) {
  const today = todayGtfs();
  const dow = todayDow();
  const active = new Set();

  for (const row of calendarRows) {
    if (row.start_date <= today && today <= row.end_date && row[dow] === '1') {
      active.add(row.service_id);
    }
  }

  for (const row of calendarDatesRows) {
    if (row.date === today) {
      if (row.exception_type === '1') active.add(row.service_id);
      if (row.exception_type === '2') active.delete(row.service_id);
    }
  }

  return active;
}

/** Convert GTFS time string "HH:MM:SS" (may be >24h) to minutes-since-midnight. */
function gtfsTimeToMinutes(t) {
  if (!t) return NaN;
  const parts = t.split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

/** Convert minutes-since-midnight to a JS Date object for today. */
function minutesToDate(minutes) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}

/**
 * Download and parse the GTFS static zip from e015.
 * Populates gtfsCache.
 */
async function loadGtfsStatic() {
  if (!GTFS_STATIC_URL) {
    console.warn('[GTFS] TRENORD_GTFS_STATIC_URL not set – GTFS static disabled.');
    return;
  }
  if (gtfsLoading) return;
  gtfsLoading = true;
  console.log('[GTFS] Downloading static feed from', GTFS_STATIC_URL);

  try {
    const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; OrarioTreni/1.0)' };
    if (GTFS_API_KEY) headers['X-API-Key'] = GTFS_API_KEY;

    const r = await fetch(GTFS_STATIC_URL, { headers, timeout: 60000 });
    if (!r.ok) throw new Error(`HTTP ${r.status} from GTFS static URL`);

    const buffer = await r.buffer();
    const zip = new AdmZip(buffer);

    const readEntry = (name) => {
      const entry = zip.getEntry(name);
      return entry ? zip.readAsText(entry) : '';
    };

    const stopsRows = parseCsv(readEntry('stops.txt'));
    const tripsRows = parseCsv(readEntry('trips.txt'));
    const routesRows = parseCsv(readEntry('routes.txt'));
    const stopTimesRows = parseCsv(readEntry('stop_times.txt'));
    const calendarRows = parseCsv(readEntry('calendar.txt'));
    const calendarDatesRows = parseCsv(readEntry('calendar_dates.txt'));

    // Build maps
    const stops = new Map();
    for (const s of stopsRows) stops.set(s.stop_id, s);

    const trips = new Map();
    for (const t of tripsRows) trips.set(t.trip_id, t);

    const routes = new Map();
    for (const r of routesRows) routes.set(r.route_id, r);

    // Index stop_times by stop_id for fast departure/arrival lookup
    const stopTimes = new Map();
    for (const st of stopTimesRows) {
      if (!stopTimes.has(st.stop_id)) stopTimes.set(st.stop_id, []);
      stopTimes.get(st.stop_id).push(st);
    }

    const services = computeActiveServices(calendarRows, calendarDatesRows);

    gtfsCache = { stops, trips, routes, stopTimes, services, lastLoaded: Date.now() };
    console.log(`[GTFS] Static feed loaded: ${stops.size} stops, ${trips.size} trips, ${routes.size} routes.`);
  } catch (err) {
    console.error('[GTFS] Failed to load static feed:', err.message);
  } finally {
    gtfsLoading = false;
  }
}

/** Start the 24-hour refresh cycle. */
function scheduleGtfsRefresh() {
  loadGtfsStatic().catch(() => {});
  gtfsLoadTimer = setInterval(() => {
    loadGtfsStatic().catch(() => {});
  }, GTFS_REFRESH_MS);
}

scheduleGtfsRefresh();

/**
 * Fetch and decode a GTFS-RT protobuf feed.
 * Returns a FeedMessage object (gtfs-realtime-bindings).
 */
async function fetchGtfsRt() {
  if (!GTFS_RT_URL) throw new Error('TRENORD_GTFS_RT_URL non configurato.');
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; OrarioTreni/1.0)', Accept: 'application/x-protobuf' };
  if (GTFS_API_KEY) headers['X-API-Key'] = GTFS_API_KEY;
  const r = await fetch(GTFS_RT_URL, { headers, timeout: 15000 });
  if (!r.ok) throw new Error(`HTTP ${r.status} from GTFS-RT URL`);
  const buf = await r.buffer();
  return transit_realtime.FeedMessage.decode(new Uint8Array(buf));
}

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
 * GET /api/trenord/stazioni?q=<nome>
 * Autocomplete stazioni via HAFAS Trenord (orari.trenord.it).
 * Restituisce array di { nome, id } dove id è il codice VT (S…) ottenuto
 * per cross-reference con ViaggiaTreno, oppure il codice HAFAS se il VT
 * non risponde.
 */
app.get('/api/trenord/stazioni', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const hafasUrl = `${TRENORD_HAFAS}/query.exe/dny?getstop.y=1&S=${encodeURIComponent(q)}&js=true&tpl=suggest2json&look_maxno=15&performLocating=2&noSession=yes`;
  const vtUrl = `${VIAGGIATRENO}/autocompletaStazione/${encodeURIComponent(q.toUpperCase())}`;

  const [hafasResult, vtResult] = await Promise.allSettled([
    fetch(hafasUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OrarioTreni/1.0)', Accept: '*/*' },
      timeout: 8000,
    }).then((r) => r.text()),
    fetch(vtUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/plain, */*' },
      timeout: 8000,
    }).then((r) => r.text()),
  ]);

  // Parse ViaggiaTreno autocomplete → Map<UPPERCASE_NAME, vtId>
  const vtMap = new Map();
  if (vtResult.status === 'fulfilled') {
    vtResult.value
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((line) => {
        const [nome, id] = line.split('|');
        if (nome && id) vtMap.set(nome.trim().toUpperCase(), id.trim());
      });
  }

  // Parse HAFAS JSONP → TSLs.map({...})
  if (hafasResult.status === 'fulfilled') {
    const m = hafasResult.value.match(/TSLs\.map\s*\(([\s\S]*)\)/);
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        const stations = (data.suggestions || [])
          .filter((s) => s.extId || s.id)
          .map((s) => {
            const nome = s.value || s.name || '';
            const vtId = vtMap.get(nome.toUpperCase());
            return { nome, id: vtId || s.extId || s.id };
          })
          .filter((s) => s.id);
        if (stations.length) return res.json(stations);
      } catch (_) { /* fall through */ }
    }
  }

  // Fallback: return ViaggiaTreno results directly
  const vtStations = [];
  for (const [nome, id] of vtMap) {
    vtStations.push({ nome, id });
  }
  return res.json(vtStations.slice(0, 8));
});

/**
 * GET /api/partenze/:idStazione?orario=<HH:MM>
 * Partenze da una stazione (ViaggiaTreno).
 */
app.get('/api/partenze/:id', async (req, res) => {
  const id = req.params.id;
  const now = new Date();
  const ts = now.getTime();
  const url = `${VIAGGIATRENO}/partenze/${encodeURIComponent(id)}/${ts}`;
  return proxyGet(url, res);
});

/**
 * GET /api/arrivi/:idStazione
 * Arrivi in una stazione (ViaggiaTreno).
 */
app.get('/api/arrivi/:id', async (req, res) => {
  const id = req.params.id;
  const now = new Date();
  const ts = now.getTime();
  const url = `${VIAGGIATRENO}/arrivi/${encodeURIComponent(id)}/${ts}`;
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
 * Payload inviato a leFrecce: { departureLocationId, arrivalLocationId, departureTime, ... }
 */
app.post('/api/soluzioni', async (req, res) => {
  const { originId, originName, destId, destName, date, time } = req.body || {};
  if (!originId || !destId || !date) {
    return res.status(400).json({ error: 'Parametri mancanti: originId, destId, date richiesti.' });
  }
  const departureTime = `${date}T${time || '00:00'}:00`;
  const payload = {
    origin: { id: Number(originId), name: originName || '' },
    destination: { id: Number(destId), name: destName || '' },
    arflag: 'A',
    adults: 1,
    children: 0,
    frecceOnly: false,
    date: departureTime,
    returnDate: null,
    solutions: 10,
  };
  const url = `${LEFRECCE}/solutions/search`;
  return proxyPost(url, payload, res);
});

/**
 * GET /api/soluzioni-vt?orig=<id>&dest=<id>&date=<YYYY-MM-DD>&time=<HH:MM>
 * Ricerca soluzioni di viaggio tramite ViaggiaTreno (soluzioniViaggioNew).
 */
app.get('/api/soluzioni-vt', async (req, res) => {
  const { orig, dest, date, time } = req.query;
  if (!orig || !dest || !date) {
    return res.status(400).json({ error: 'Parametri mancanti: orig, dest, date richiesti.' });
  }
  const dt = `${date}T${(time || '00:00')}:00`;
  const url = `${VIAGGIATRENO}/soluzioniViaggioNew/${encodeURIComponent(orig)}/${encodeURIComponent(dest)}/${dt}`;
  return proxyGet(url, res);
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

// ─── GTFS API Routes ──────────────────────────────────────────────────────────

/**
 * GET /api/gtfs/status
 * Returns GTFS cache status and configuration.
 */
app.get('/api/gtfs/status', (req, res) => {
  res.json({
    staticConfigured: !!GTFS_STATIC_URL,
    realtimeConfigured: !!GTFS_RT_URL,
    apiKeyConfigured: !!GTFS_API_KEY,
    cacheLoaded: !!gtfsCache,
    lastLoaded: gtfsCache ? new Date(gtfsCache.lastLoaded).toISOString() : null,
    stops: gtfsCache ? gtfsCache.stops.size : 0,
    trips: gtfsCache ? gtfsCache.trips.size : 0,
    activeServices: gtfsCache ? gtfsCache.services.size : 0,
  });
});

/**
 * GET /api/gtfs/stazioni?q=<nome>&limit=10
 * Autocomplete stazioni dal feed GTFS statico.
 * Restituisce array di { nome, id, lat, lon }.
 */
app.get('/api/gtfs/stazioni', (req, res) => {
  if (!gtfsCache) {
    return res.status(503).json({ error: 'Feed GTFS statico non ancora caricato.', retry: true });
  }
  const q = (req.query.q || '').trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  if (!q) return res.json([]);

  const results = [];
  for (const s of gtfsCache.stops.values()) {
    if ((s.stop_name || '').toLowerCase().includes(q)) {
      results.push({ nome: s.stop_name, id: s.stop_id, lat: s.stop_lat, lon: s.stop_lon });
      if (results.length >= limit) break;
    }
  }
  return res.json(results);
});

/**
 * GET /api/gtfs/partenze/:stopId?limit=30
 * Prossime partenze da una fermata (GTFS static + real-time).
 * stopId: GTFS stop_id
 */
app.get('/api/gtfs/partenze/:stopId', async (req, res) => {
  if (!gtfsCache) {
    return res.status(503).json({ error: 'Feed GTFS statico non ancora caricato.', retry: true });
  }
  const { stopId } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const windowMin = 120; // show next 2 hours

  const times = gtfsCache.stopTimes.get(stopId) || [];
  const departures = [];

  for (const st of times) {
    const trip = gtfsCache.trips.get(st.trip_id);
    if (!trip) continue;
    if (!gtfsCache.services.has(trip.service_id)) continue;

    const depMin = gtfsTimeToMinutes(st.departure_time);
    if (isNaN(depMin)) continue;
    if (depMin < nowMin || depMin > nowMin + windowMin) continue;

    const route = gtfsCache.routes.get(trip.route_id);
    departures.push({
      tripId: st.trip_id,
      routeShortName: route ? route.route_short_name : '',
      routeLongName: route ? route.route_long_name : '',
      headsign: trip.trip_headsign || '',
      departureTime: minutesToDate(depMin).toISOString(),
      scheduledDepartureMin: depMin,
      stopSequence: parseInt(st.stop_sequence, 10) || 0,
      // real-time fields filled in below
      delay: null,
      cancelled: false,
      realtimeDepartureTime: null,
    });
  }

  // Sort by scheduled departure
  departures.sort((a, b) => a.scheduledDepartureMin - b.scheduledDepartureMin);

  // Merge GTFS-RT updates if available
  if (GTFS_RT_URL) {
    try {
      const feed = await fetchGtfsRt();
      const rtMap = new Map(); // trip_id → TripUpdate entity
      for (const entity of (feed.entity || [])) {
        if (entity.tripUpdate && entity.tripUpdate.trip) {
          rtMap.set(entity.tripUpdate.trip.tripId, entity.tripUpdate);
        }
      }

      for (const dep of departures) {
        const tu = rtMap.get(dep.tripId);
        if (!tu) continue;
        if (tu.trip && tu.trip.scheduleRelationship === transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED) {
          dep.cancelled = true;
          continue;
        }
        const stu = (tu.stopTimeUpdate || []).find((u) => u.stopId === stopId || u.stopSequence === dep.stopSequence);
        if (stu && stu.departure) {
          const rtTime = stu.departure.time ? Number(stu.departure.time) * 1000 : null;
          if (rtTime) {
            dep.realtimeDepartureTime = new Date(rtTime).toISOString();
            dep.delay = Math.round((rtTime - new Date(dep.departureTime).getTime()) / 60000);
          }
        }
      }
    } catch (err) {
      // GTFS-RT is best-effort; don't fail the whole request
      console.warn('[GTFS-RT] Error fetching real-time data:', err.message);
    }
  }

  return res.json(departures.slice(0, limit));
});

/**
 * GET /api/gtfs/arrivi/:stopId?limit=30
 * Prossimi arrivi in una fermata (GTFS static + real-time).
 */
app.get('/api/gtfs/arrivi/:stopId', async (req, res) => {
  if (!gtfsCache) {
    return res.status(503).json({ error: 'Feed GTFS statico non ancora caricato.', retry: true });
  }
  const { stopId } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const windowMin = 120;

  const times = gtfsCache.stopTimes.get(stopId) || [];
  const arrivals = [];

  for (const st of times) {
    const trip = gtfsCache.trips.get(st.trip_id);
    if (!trip) continue;
    if (!gtfsCache.services.has(trip.service_id)) continue;

    const arrMin = gtfsTimeToMinutes(st.arrival_time);
    if (isNaN(arrMin)) continue;
    if (arrMin < nowMin || arrMin > nowMin + windowMin) continue;

    const route = gtfsCache.routes.get(trip.route_id);
    arrivals.push({
      tripId: st.trip_id,
      routeShortName: route ? route.route_short_name : '',
      routeLongName: route ? route.route_long_name : '',
      headsign: trip.trip_headsign || '',
      arrivalTime: minutesToDate(arrMin).toISOString(),
      scheduledArrivalMin: arrMin,
      stopSequence: parseInt(st.stop_sequence, 10) || 0,
      delay: null,
      cancelled: false,
      realtimeArrivalTime: null,
    });
  }

  arrivals.sort((a, b) => a.scheduledArrivalMin - b.scheduledArrivalMin);

  // Merge GTFS-RT updates
  if (GTFS_RT_URL) {
    try {
      const feed = await fetchGtfsRt();
      const rtMap = new Map();
      for (const entity of (feed.entity || [])) {
        if (entity.tripUpdate && entity.tripUpdate.trip) {
          rtMap.set(entity.tripUpdate.trip.tripId, entity.tripUpdate);
        }
      }

      for (const arr of arrivals) {
        const tu = rtMap.get(arr.tripId);
        if (!tu) continue;
        if (tu.trip && tu.trip.scheduleRelationship === transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED) {
          arr.cancelled = true;
          continue;
        }
        const stu = (tu.stopTimeUpdate || []).find((u) => u.stopId === stopId || u.stopSequence === arr.stopSequence);
        if (stu && stu.arrival) {
          const rtTime = stu.arrival.time ? Number(stu.arrival.time) * 1000 : null;
          if (rtTime) {
            arr.realtimeArrivalTime = new Date(rtTime).toISOString();
            arr.delay = Math.round((rtTime - new Date(arr.arrivalTime).getTime()) / 60000);
          }
        }
      }
    } catch (err) {
      console.warn('[GTFS-RT] Error fetching real-time data:', err.message);
    }
  }

  return res.json(arrivals.slice(0, limit));
});

/**
 * GET /api/gtfs/realtime
 * Restituisce il feed GTFS-RT decodificato come JSON (per debug/ispezione).
 */
app.get('/api/gtfs/realtime', async (req, res) => {
  try {
    const feed = await fetchGtfsRt();
    // Convert Long objects to plain numbers for JSON serialisation
    const plain = JSON.parse(JSON.stringify(feed, (_, v) => {
      if (v && typeof v === 'object' && typeof v.low === 'number' && typeof v.high === 'number') {
        return v.low + v.high * 2 ** 32;
      }
      return v;
    }));
    return res.json(plain);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Orario Treni server running at http://localhost:${PORT}`);
});
