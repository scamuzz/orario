/* ============================================================
   Orario Treni – app.js
   ============================================================ */

'use strict';

// ─── Utilities ──────────────────────────────────────────────────────────────

function fmt(iso) {
  if (!iso) return '–';
  const d = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short' });
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function delayBadge(min) {
  if (min == null) return '<span class="badge badge-gray">–</span>';
  if (min === 0) return '<span class="badge badge-green">In orario</span>';
  if (min > 0) return `<span class="badge badge-red">+${min} min</span>`;
  return `<span class="badge badge-green">${min} min</span>`;
}

function delayClass(min) {
  if (!min) return 'delay-zero';
  return min > 0 ? 'delay-pos' : 'delay-neg';
}

function loading(msg = 'Caricamento...') {
  return `<div class="spinner">${msg}</div>`;
}

function errHtml(msg) {
  return `<div class="error-msg">⚠️ ${msg}</div>`;
}

async function api(path, opts = {}) {
  const base = (typeof window !== 'undefined' && window.API_BASE) ? window.API_BASE : '';
  const res = await fetch(base + path, opts);
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `Errore HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Autocomplete ─────────────────────────────────────────────────────────

function setupAutocomplete({ inputEl, listEl, hiddenEl, onSelect }) {
  let timer = null;
  let active = -1;
  let items = [];

  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    const q = inputEl.value.trim();
    if (q.length < 2) { hide(); return; }
    timer = setTimeout(() => fetchSuggestions(q), 280);
    active = -1;
  });

  inputEl.addEventListener('keydown', (e) => {
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) selectItem(items[active]);
    } else if (e.key === 'Escape') hide();
  });

  document.addEventListener('click', (e) => {
    if (!inputEl.contains(e.target) && !listEl.contains(e.target)) hide();
  });

  function setActive(idx) {
    const lis = listEl.querySelectorAll('li');
    if (!lis.length) return;
    active = (idx + lis.length) % lis.length;
    lis.forEach((li, i) => li.classList.toggle('active', i === active));
    lis[active].scrollIntoView({ block: 'nearest' });
  }

  async function fetchSuggestions(q) {
    try {
      let data = await api(`/api/trenord/stazioni?q=${encodeURIComponent(q)}`);
      if (!data.length) {
        data = await api(`/api/stazioni?q=${encodeURIComponent(q)}`);
      }
      items = data.slice(0, 8);
      render();
    } catch (_) { hide(); }
  }

  function render() {
    if (!items.length) { hide(); return; }
    listEl.innerHTML = items
      .map((s, i) => `<li data-idx="${i}">${s.nome}</li>`)
      .join('');
    listEl.querySelectorAll('li').forEach((li) => {
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectItem(items[+li.dataset.idx]);
      });
    });
    listEl.classList.remove('hidden');
  }

  function selectItem(s) {
    inputEl.value = s.nome;
    if (hiddenEl) hiddenEl.value = s.id;
    hide();
    if (onSelect) onSelect(s);
  }

  function hide() {
    listEl.classList.add('hidden');
    listEl.innerHTML = '';
    items = [];
    active = -1;
  }
}

// ─── Tab navigation ──────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

// ─── Set default date/time ────────────────────────────────────────────────────

(function setDefaults() {
  const now = new Date();
  const dateEl = document.getElementById('data-input');
  const timeEl = document.getElementById('ora-input');
  dateEl.value = now.toISOString().slice(0, 10);
  timeEl.value = now.toTimeString().slice(0, 5);
})();

// ─── Cerca Soluzioni ──────────────────────────────────────────────────────────

setupAutocomplete({
  inputEl: document.getElementById('orig-input'),
  listEl: document.getElementById('orig-list'),
  hiddenEl: document.getElementById('orig-id'),
});
setupAutocomplete({
  inputEl: document.getElementById('dest-input'),
  listEl: document.getElementById('dest-list'),
  hiddenEl: document.getElementById('dest-id'),
});

document.getElementById('form-soluzioni').addEventListener('submit', async (e) => {
  e.preventDefault();
  const origInput = document.getElementById('orig-input').value.trim();
  const destInput = document.getElementById('dest-input').value.trim();
  const origId = document.getElementById('orig-id').value;
  const destId = document.getElementById('dest-id').value;
  const date = document.getElementById('data-input').value;
  const time = document.getElementById('ora-input').value;
  const out = document.getElementById('sol-results');

  if (!origInput || !destInput || !date) {
    out.innerHTML = errHtml('Compila tutti i campi richiesti.');
    return;
  }
  if (!origId || !destId) {
    out.innerHTML = errHtml('Seleziona le stazioni dall\'elenco suggerito.');
    return;
  }

  out.innerHTML = loading('Ricerca soluzioni...');

  try {
    await searchSoluzioni({ origId, origInput, destId, destInput, date, time, out });
  } catch (err) {
    out.innerHTML = errHtml(err.message);
  }
});

async function searchSoluzioni({ origId, origInput, destId, destInput, date, time, out }) {
  // ── Strategy 1: ViaggiaTreno soluzioniViaggioNew (uses VT station IDs already known) ──
  if (origId && destId) {
    try {
      const data = await api(
        `/api/soluzioni-vt?orig=${encodeURIComponent(origId)}&dest=${encodeURIComponent(destId)}&date=${encodeURIComponent(date)}&time=${encodeURIComponent(time || '00:00')}`
      );
      renderSoluzioniVT(data, out, origId, destId);
      return;
    } catch (_) {
      // fall through to leFrecce
    }
  }

  // ── Strategy 2: leFrecce (resolve numeric IDs first) ──
  const [origResults, destResults] = await Promise.all([
    api(`/api/stazioni/lefrecce?q=${encodeURIComponent(origInput)}&limit=3`).catch(() => []),
    api(`/api/stazioni/lefrecce?q=${encodeURIComponent(destInput)}&limit=3`).catch(() => []),
  ]);

  const orig = origResults[0];
  const dest = destResults[0];

  if (!orig || !dest) {
    out.innerHTML = errHtml('Nessuna soluzione trovata. Assicurati di selezionare le stazioni dall\'elenco suggerito.');
    return;
  }

  const payload = {
    originId: orig.id,
    originName: orig.name || origInput,
    destId: dest.id,
    destName: dest.name || destInput,
    date,
    time,
  };

  const data = await api('/api/soluzioni', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  renderSoluzioni(data, out, origId || '', destId || '');
}

function renderSoluzioniVT(data, out, origVtId, destVtId) {
  // ViaggiaTreno returns { soluzioni: [...] } or an array directly
  const raw = Array.isArray(data) ? data : (data.soluzioni || []);

  if (!raw.length) {
    out.innerHTML = errHtml('Nessuna soluzione trovata per i parametri inseriti.');
    return;
  }

  const cards = raw.map((sol) => {
    const dep = sol.orarioPartenza;
    const arr = sol.orarioArrivo;
    const dur = sol.durata || '';
    const vehicles = sol.vehicles || [];
    const changes = vehicles.length > 1 ? vehicles.length - 1 : 0;

    const trainLabel = vehicles
      .map((v) => [v.categoriaDescrizione, v.numeroTreno].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(' + ') || 'Treno';

    const depFmt = fmt(dep);
    const arrFmt = fmt(arr);
    const durFmt = durLabel(dur);

    const legs = vehicles.map((v) => ({
      trainidentifier: v.numeroTreno || '',
      trainId: v.numeroTreno || '',
      codOrigine: origVtId,
    }));

    return `
      <div class="sol-card" data-sol='${esc(JSON.stringify({ legs, dep, arr, origVtId, destVtId }))}'>
        <div class="sol-times">
          <span class="sol-dep">${esc(depFmt)}</span>
          <span style="color:var(--border)">↓</span>
          <span class="sol-arr">${esc(arrFmt)}</span>
        </div>
        <span class="sol-arrow">→</span>
        <div class="sol-info">
          <div class="sol-train">${esc(trainLabel)}</div>
          <div class="sol-changes">
            ${esc(durFmt)}${changes > 0 ? ` · ${changes} cambio/i` : ' · Diretto'}
          </div>
        </div>
        <div class="sol-status">
          <span class="badge badge-gray">Cerca stato</span>
        </div>
      </div>`;
  });

  out.innerHTML = `<div class="sol-grid">${cards.join('')}</div>`;

  out.querySelectorAll('.sol-card').forEach((card) => {
    card.addEventListener('click', () => {
      const info = JSON.parse(card.dataset.sol);
      openSolDetailModal(info);
    });
  });
}

function renderSoluzioni(data, out, origVtId, destVtId) {
  // leFrecce returns an array of solution objects directly or { solutions: [] }
  const solutions = Array.isArray(data) ? data : (data.solutions || data.itineraries || []);

  if (!solutions.length) {
    out.innerHTML = errHtml('Nessuna soluzione trovata per i parametri inseriti.');
    return;
  }

  const cards = solutions.map((sol) => {
    const dep = sol.departureTime || sol.departuredatetime || sol.departure;
    const arr = sol.arrivalTime || sol.arrivaldatetime || sol.arrival;
    const dur = sol.duration || sol.travelTime || '';
    const changes = sol.changesNumber != null ? sol.changesNumber : (sol.transfers != null ? sol.transfers : '–');
    const price = sol.minPrice != null ? `<br><small>Da € ${sol.minPrice}</small>` : '';

    // Compose train labels
    let trainLabel = '';
    const legs = sol.legs || sol.trainlist || [];
    if (legs.length) {
      trainLabel = legs.map((l) => l.trainidentifier || l.trainId || l.code || '').filter(Boolean).join(' + ');
    } else {
      trainLabel = sol.trainidentifier || sol.trainId || '';
    }

    const depFmt = fmt(dep);
    const arrFmt = fmt(arr);
    const durFmt = durLabel(dur);

    return `
      <div class="sol-card" data-sol='${esc(JSON.stringify({ legs, dep, arr, origVtId, destVtId }))}'>
        <div class="sol-times">
          <span class="sol-dep">${esc(depFmt)}</span>
          <span style="color:var(--border)">↓</span>
          <span class="sol-arr">${esc(arrFmt)}</span>
        </div>
        <span class="sol-arrow">→</span>
        <div class="sol-info">
          <div class="sol-train">${esc(trainLabel) || 'Treno'}</div>
          <div class="sol-changes">
            ${esc(durFmt)}${changes !== '–' ? ` · ${changes === 0 ? 'Diretto' : esc(String(changes)) + ' cambio/i'}` : ''}
            ${price}
          </div>
        </div>
        <div class="sol-status">
          <span class="badge badge-gray">Cerca stato</span>
        </div>
      </div>`;
  });

  out.innerHTML = `<div class="sol-grid">${cards.join('')}</div>`;

  // Attach click handlers to load real-time status
  out.querySelectorAll('.sol-card').forEach((card) => {
    card.addEventListener('click', () => {
      const info = JSON.parse(card.dataset.sol);
      openSolDetailModal(info);
    });
  });
}

function durLabel(dur) {
  if (!dur) return '';
  if (typeof dur === 'number') {
    const h = Math.floor(dur / 60);
    const m = dur % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }
  return dur;
}

// ─── Partenze ─────────────────────────────────────────────────────────────────

setupAutocomplete({
  inputEl: document.getElementById('part-input'),
  listEl: document.getElementById('part-list'),
  hiddenEl: document.getElementById('part-id'),
});

document.getElementById('form-partenze').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('part-id').value;
  const nome = document.getElementById('part-input').value.trim();
  const out = document.getElementById('part-results');
  if (!id) { out.innerHTML = errHtml('Seleziona una stazione dall\'elenco.'); return; }
  out.innerHTML = loading('Caricamento partenze...');
  try {
    const data = await api(`/api/partenze/${encodeURIComponent(id)}`);
    renderTrainTable(data, out, 'partenze', nome);
  } catch (err) {
    out.innerHTML = errHtml(err.message);
  }
});

// ─── Arrivi ──────────────────────────────────────────────────────────────────

setupAutocomplete({
  inputEl: document.getElementById('arr-input'),
  listEl: document.getElementById('arr-list'),
  hiddenEl: document.getElementById('arr-id'),
});

document.getElementById('form-arrivi').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('arr-id').value;
  const nome = document.getElementById('arr-input').value.trim();
  const out = document.getElementById('arr-results');
  if (!id) { out.innerHTML = errHtml('Seleziona una stazione dall\'elenco.'); return; }
  out.innerHTML = loading('Caricamento arrivi...');
  try {
    const data = await api(`/api/arrivi/${encodeURIComponent(id)}`);
    renderTrainTable(data, out, 'arrivi', nome);
  } catch (err) {
    out.innerHTML = errHtml(err.message);
  }
});

function renderTrainTable(trains, out, type, stationName) {
  if (!trains || !trains.length) {
    out.innerHTML = errHtml('Nessun treno trovato.');
    return;
  }

  const isPartenze = type === 'partenze';
  const colLabel = isPartenze ? 'Destinazione' : 'Provenienza';
  const timeLabel = isPartenze ? 'Partenza' : 'Arrivo';

  const rows = trains.map((t) => {
    const num = t.numeroTreno || t.numero || '–';
    const dest = isPartenze ? (t.destinazione || '–') : (t.origine || '–');
    const timeScheduled = fmt(t.orarioPartenza || t.orarioArrivo || t.compOrarioArrivo || t.compOrarioPartenza);
    const delay = t.ritardo != null ? t.ritardo : null;
    const platform = t.binarioProgrammatoPartenzaDescrizione || t.binarioProgrammatoArrivoDescrizione || '–';
    const platformReal = t.binarioEffettivoPartenzaDescrizione || t.binarioEffettivoArrivoDescrizione || null;
    const cancelled = t.provvedimento === 1;
    const codOrigine = t.codOrigine || t.idOrigine || '';

    const delayCell = cancelled
      ? '<span class="badge badge-red">Cancellato</span>'
      : `<span class="${delayClass(delay)}">${delay != null ? (delay === 0 ? 'In orario' : (delay > 0 ? `+${delay} min` : `${delay} min`)) : '–'}</span>`;

    const platformCell = platformReal && platformReal !== platform
      ? `${esc(platform)} → <strong>${esc(platformReal)}</strong>`
      : esc(platform);

    return `<tr>
      <td class="clickable" data-num="${esc(num)}" data-orig="${esc(codOrigine)}">${esc(num)}</td>
      <td>${esc(dest)}</td>
      <td>${esc(timeScheduled)}</td>
      <td>${delayCell}</td>
      <td>${platformCell}</td>
    </tr>`;
  });

  out.innerHTML = `
    <p style="font-size:.85rem;color:var(--text-muted);margin-bottom:8px">
      ${type === 'partenze' ? 'Partenze da' : 'Arrivi a'} <strong>${esc(stationName)}</strong> – ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
      &nbsp;<button class="btn-secondary" id="refresh-btn">↻ Aggiorna</button>
    </p>
    <div style="overflow-x:auto">
    <table class="train-table">
      <thead><tr>
        <th>Treno</th><th>${colLabel}</th><th>${timeLabel}</th><th>Ritardo</th><th>Binario</th>
      </tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    </div>`;

  // Click on train number → open detail modal
  out.querySelectorAll('.clickable').forEach((td) => {
    td.addEventListener('click', () => openTrainDetailModal(td.dataset.orig, td.dataset.num));
  });

  // Refresh button
  out.querySelector('#refresh-btn').addEventListener('click', () => {
    const id = document.getElementById(`${type === 'partenze' ? 'part' : 'arr'}-id`).value;
    const nome2 = document.getElementById(`${type === 'partenze' ? 'part' : 'arr'}-input`).value.trim();
    out.innerHTML = loading('Aggiornamento...');
    api(`/api/${type}/${encodeURIComponent(id)}`)
      .then((d) => renderTrainTable(d, out, type, nome2))
      .catch((err) => { out.innerHTML = errHtml(err.message); });
  });
}

// ─── Stato treno per numero ───────────────────────────────────────────────────

document.getElementById('form-numero').addEventListener('submit', async (e) => {
  e.preventDefault();
  const num = document.getElementById('num-input').value.trim();
  const out = document.getElementById('num-results');
  if (!num) return;
  out.innerHTML = loading('Ricerca treno...');
  try {
    const candidates = await api(`/api/treno/info/${encodeURIComponent(num)}`);
    if (!candidates.length) { out.innerHTML = errHtml('Treno non trovato.'); return; }
    // Auto-load first result
    const first = candidates[0];
    out.innerHTML = loading('Caricamento andamento...');
    openTrainDetailModal(first.codOrigine, num, out);
  } catch (err) {
    out.innerHTML = errHtml(err.message);
  }
});

// ─── Modal helpers ────────────────────────────────────────────────────────────

const overlay = document.getElementById('modal-overlay');
const modalBody = document.getElementById('modal-body');
const modalTitle = document.getElementById('modal-title');

document.getElementById('modal-close').addEventListener('click', closeModal);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function openModal() { overlay.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
function closeModal() { overlay.classList.add('hidden'); document.body.style.overflow = ''; }

async function openTrainDetailModal(codOrigine, numero, inlineOut) {
  if (!inlineOut) {
    modalTitle.textContent = `Treno ${numero}`;
    modalBody.innerHTML = loading('Caricamento andamento...');
    openModal();
  }

  try {
    const data = await api(`/api/treno/${encodeURIComponent(codOrigine)}/${encodeURIComponent(numero)}`);
    const html = renderTrainDetail(data);
    if (inlineOut) {
      inlineOut.innerHTML = html;
    } else {
      modalTitle.textContent = `Treno ${data.numeroTreno || numero} – ${data.destinazione || ''}`;
      modalBody.innerHTML = html;
    }
  } catch (err) {
    const errContent = errHtml(err.message);
    if (inlineOut) { inlineOut.innerHTML = errContent; }
    else { modalBody.innerHTML = errContent; }
  }
}

async function openSolDetailModal(info) {
  const { legs, origVtId } = info;
  // Try the first leg
  const leg = legs[0];
  if (!leg) { return; }
  const num = leg.trainidentifier || leg.trainId || leg.code || '';
  if (!num) return;
  openTrainDetailModal(origVtId || '', num);
}

function renderTrainDetail(t) {
  if (!t || !t.fermate) return errHtml('Dati non disponibili.');

  const delay = t.ritardo != null ? t.ritardo : null;
  const delayHtml = delay != null
    ? `<span class="${delayClass(delay)}" style="font-weight:700">${delay === 0 ? 'In orario' : (delay > 0 ? `+${delay} min` : `${delay} min`)}</span>`
    : '<span style="color:var(--text-muted)">–</span>';

  const lastUpdate = t.oraUltimoRilevamento
    ? `<span style="font-size:.82rem;color:var(--text-muted)">Ultimo rilevamento: <strong>${esc(t.stazioneUltimoRilevamento || '')}</strong> ore ${esc(fmt(t.oraUltimoRilevamento))}</span>`
    : '';

  const header = `
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin-bottom:16px;padding-bottom:14px;border-bottom:1.5px solid var(--border)">
      <div>
        <span style="font-size:.82rem;color:var(--text-muted)">Categoria</span><br>
        <strong>${esc(t.categoriaDescrizione || t.categoria || '–')}</strong>
      </div>
      <div>
        <span style="font-size:.82rem;color:var(--text-muted)">Da</span><br>
        <strong>${esc(t.origine || '–')}</strong>
      </div>
      <div>
        <span style="font-size:.82rem;color:var(--text-muted)">A</span><br>
        <strong>${esc(t.destinazione || '–')}</strong>
      </div>
      <div style="margin-left:auto">
        <span style="font-size:.82rem;color:var(--text-muted)">Ritardo</span><br>
        ${delayHtml}
      </div>
    </div>
    ${lastUpdate ? `<div style="margin-bottom:12px">${lastUpdate}</div>` : ''}`;

  const stops = t.fermate.map((f, i) => {
    const passed = f.effettivo || f.partenzaReale || f.arrivoReale;
    const isCurrent = t.stazioneUltimoRilevamento === f.stazione;
    const dotClass = isCurrent ? 'current' : (passed ? 'passed' : '');
    const sched = esc(fmt(f.partenza || f.arrivo));
    const actual = esc(fmt(f.partenzaReale || f.arrivoReale));
    const binario = f.binarioProgrammatoPartenzaDescrizione || f.binarioProgrammatoArrivoDescrizione || '';
    const binarioReal = f.binarioEffettivoPartenzaDescrizione || f.binarioEffettivoArrivoDescrizione || '';

    return `<li class="stop-item">
      <div class="stop-dot ${dotClass}"></div>
      <div style="flex:1">
        <div class="stop-name">${esc(f.stazione || '–')}</div>
        <div class="stop-times">
          <span>Prev: ${sched}</span>
          ${actual && actual !== sched ? `<span style="color:var(--accent)">Eff: ${actual}</span>` : ''}
        </div>
        ${binario ? `<span class="stop-platform">Bin. ${binarioReal && binarioReal !== binario ? `${esc(binario)}→<strong>${esc(binarioReal)}</strong>` : esc(binario)}</span>` : ''}
      </div>
    </li>`;
  });

  return `${header}<ul class="stop-list">${stops.join('')}</ul>`;
}
