import * as DB from './db.js';
import {
  NUTRIENTS, uuid, todayStr, addDays, fmtDateHuman,
  scale, sumLoose, sumStrict, macroKcal,
  f0, f1, fg, escapeHtml as esc,
} from './models.js';
import { YIELD_CATS, guessYield } from './yields.js';
import { scanBarcode, codeCandidates } from './scanner.js';

// keep in sync with VERSION in sw.js
const APP_VERSION = 'v15';

// Raspberry Pi backup target — reachable only when the phone is on the tailnet
const PI_URL = 'https://fbasz.tail23902b.ts.net';

// ---------------------------------------------------------------- state

let foods = [];
let foodsById = new Map();
let currentDate = todayStr();
let settings = {
  targets: { kcal: 2400, protein: 180, carbs: 240, fat: 80 },
  usdaKey: '',
  nutritionix: { id: '', key: '' },
  groupsEnabled: true,
  piBackup: true,
};
const GROUPS = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
const MACRO_COLORS = { protein: 'var(--c-protein)', carbs: 'var(--c-carbs)', fat: 'var(--c-fat)' };

// recipe builder working copy
let draft = null;

// ---------------------------------------------------------------- boot

async function boot() {
  await DB.openDB();
  const saved = await DB.getSetting('settings');
  if (saved) settings = { ...settings, ...saved, targets: { ...settings.targets, ...(saved.targets || {}) } };
  await refreshFoods();

  document.querySelectorAll('#bottom-nav button').forEach(btn => {
    btn.onclick = () => navTo(btn.dataset.screen);
  });
  navTo('dashboard');

  // safety-net backup to the Pi shortly after every open (quiet if unreachable)
  setTimeout(() => piBackupNow(false), 5000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      // iOS PWAs are lazy about update checks — force one on open and on re-focus
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => { /* offline dev, fine */ });
    // when a new version takes over, refresh once so it shows immediately
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  }
}

async function refreshFoods() {
  foods = await DB.all('foods');
  foodsById = new Map(foods.map(f => [f.id, f]));
}

async function saveSettings() { await DB.setSetting('settings', settings); }

// ---------------------------------------------------------------- Pi backup

let piBackupTimer = null;

// called after anything that changes data; sends one backup a minute later
function schedulePiBackup() {
  if (settings.piBackup === false) return;
  clearTimeout(piBackupTimer);
  piBackupTimer = setTimeout(() => piBackupNow(false), 60000);
}

async function piBackupNow(manual) {
  if (!manual && settings.piBackup === false) return false;
  // dev preview on the laptop must never overwrite the phone's backups with test data
  if (!manual && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return false;
  try {
    const data = await DB.exportAll();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(PI_URL + '/api/calorie/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const r = await resp.json();
    if (!r.ok) throw new Error(r.error || 'backup rejected');
    await DB.setSetting('piBackupInfo', { ts: new Date().toISOString(), file: r.file });
    if (manual) toast('Backed up to the Pi ✓');
    return true;
  } catch (e) {
    // off the tailnet / Pi asleep — quiet for auto-backups, loud when asked directly
    if (manual) alert('Pi backup failed: ' + e.message + '\n\nIs Tailscale on?');
    return false;
  }
}

// ---------------------------------------------------------------- navigation

function navTo(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
  document.querySelectorAll('#bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.screen === name));
  if (name === 'dashboard') renderDashboard();
  if (name === 'foods') renderFoodsScreen();
  if (name === 'recipes') renderRecipesScreen();
  if (name === 'convert') renderConverter();
  if (name === 'settings') renderSettings();
}

// ---------------------------------------------------------------- tiny UI kit

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 1900);
}

// bottom sheet; returns {el, close}
function openSheet(html, { full = false } = {}) {
  const back = document.createElement('div');
  back.className = 'sheet-back';
  const el = document.createElement('div');
  el.className = 'sheet' + (full ? ' sheet-full' : '');
  el.innerHTML = html;
  back.appendChild(el);
  document.getElementById('modal-root').appendChild(back);
  const close = () => back.remove();
  back.addEventListener('click', e => { if (e.target === back) close(); });
  el.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  return { el, close };
}

function groupForNow() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h < 10.5) return 'Breakfast';
  if (h < 15) return 'Lunch';
  if (h < 20.5) return 'Dinner';
  return 'Snacks';
}

function servingDesc(food) {
  const s = (food.servings || []).find(x => x.name === food.defaultServing) || food.servings?.[0];
  if (!s) return '';
  const amt = food.defaultAmount || 1;
  return `${fg(amt)} ${s.name} (${fg(amt * s.grams)}g)`;
}

// ---------------------------------------------------------------- dashboard

async function renderDashboard() {
  const scr = document.getElementById('screen-dashboard');
  const entries = (await DB.byIndex('log', 'date', currentDate))
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  const totals = sumLoose(entries.map(e => {
    const f = foodsById.get(e.foodId);
    return f ? scale(f.perGram, e.grams) : Object.fromEntries(NUTRIENTS.map(k => [k, null]));
  }));
  const T = settings.targets;
  const kcal = totals.kcal ?? 0;
  const pct = T.kcal ? Math.round(kcal / T.kcal * 100) : 0;

  const macroRow = (key, label) => {
    const v = totals[key] ?? 0, target = T[key] || 0;
    const w = target ? Math.min(100, v / target * 100) : 0;
    return `
      <div class="macro-row">
        <div class="macro-head"><span class="macro-name" style="color:${MACRO_COLORS[key]}">${label}</span>
          <span class="macro-val">${fg(v)} / ${fg(target)} g</span></div>
        <div class="bar seg"><div class="bar-fill" style="width:${w}%;background:${MACRO_COLORS[key]}"></div></div>
      </div>`;
  };

  const entryRow = (e) => {
    const f = foodsById.get(e.foodId);
    const name = f ? f.name : '(deleted food)';
    const n = f ? scale(f.perGram, e.grams) : null;
    const desc = e.servingName ? `${fg(e.amount)} ${e.servingName} · ${fg(e.grams)}g` : `${fg(e.grams)}g`;
    return `
      <div class="entry-row" data-entry="${e.id}">
        <div class="entry-main"><div class="entry-name">${esc(name)}</div>
        <div class="entry-sub">${esc(desc)}</div></div>
        <div class="entry-kcal">${n ? f0(n.kcal) : '—'}<span class="unit"> kcal</span></div>
      </div>`;
  };

  let entriesHtml = '';
  if (settings.groupsEnabled) {
    const order = [...GROUPS, null];
    for (const g of order) {
      const rows = entries.filter(e => (e.group || null) === g);
      if (g === null && !rows.length) continue;
      const gk = sumLoose(rows.map(e => { const f = foodsById.get(e.foodId); return f ? scale(f.perGram, e.grams) : { kcal: null }; })).kcal;
      entriesHtml += `
        <div class="group-block">
          <div class="group-head">
            <span>${g || 'Other'}</span>
            <span class="group-kcal">${rows.length ? f0(gk) + ' kcal' : ''}</span>
            ${g ? `<button class="mini-add" data-group="${g}">＋</button>` : ''}
          </div>
          ${rows.map(entryRow).join('') || '<div class="empty-line">Nothing logged</div>'}
        </div>`;
    }
  } else {
    entriesHtml = `<div class="group-block">${entries.map(entryRow).join('') || '<div class="empty-line">Nothing logged yet</div>'}</div>
      <button class="btn wide" id="dash-add">＋ Add food</button>`;
  }

  scr.innerHTML = `
    <div class="date-nav">
      <button class="icon-btn" id="date-prev">‹</button>
      <button class="date-label" id="date-today">${fmtDateHuman(currentDate)}</button>
      <button class="icon-btn" id="date-next">›</button>
    </div>
    <div class="card energy-card">
      <div class="energy-head">
        <span class="energy-val">${f1(kcal)} <span class="dim">/ ${f1(T.kcal)} kcal</span></span>
        <span class="energy-pct">${pct}%</span>
      </div>
      <div class="bar"><div class="bar-fill energy-fill" style="width:${Math.min(100, pct)}%"></div></div>
      ${macroRow('protein', 'Protein')}${macroRow('carbs', 'Carbs')}${macroRow('fat', 'Fat')}
    </div>
    ${entriesHtml}
    <button class="fab" id="fab-scan" title="Scan barcode">📷</button>`;

  scr.querySelector('#date-prev').onclick = () => { currentDate = addDays(currentDate, -1); renderDashboard(); };
  scr.querySelector('#date-next').onclick = () => { currentDate = addDays(currentDate, 1); renderDashboard(); };
  scr.querySelector('#date-today').onclick = () => { currentDate = todayStr(); renderDashboard(); };
  scr.querySelectorAll('.mini-add').forEach(b => b.onclick = () =>
    pickFood(food => openFoodDetail(food, { date: currentDate, group: b.dataset.group })));
  const dashAdd = scr.querySelector('#dash-add');
  if (dashAdd) dashAdd.onclick = () => pickFood(food => openFoodDetail(food, { date: currentDate }));
  scr.querySelectorAll('.entry-row').forEach(r => r.onclick = async () => {
    const e = await DB.get('log', r.dataset.entry);
    if (!e) return;
    const f = foodsById.get(e.foodId);
    if (!f) {
      if (confirm('The food for this entry was deleted. Remove this log entry?')) {
        await DB.del('log', e.id); renderDashboard();
      }
      return;
    }
    openFoodDetail(f, { mode: 'edit-entry', entry: e, date: e.date });
  });
  scr.querySelector('#fab-scan').onclick = () => scanFlow();
}

// ---------------------------------------------------------------- foods screen

let foodsFilter = { q: '', tab: 'all' };

function foodRowHtml(f) {
  const perServ = (() => {
    const s = (f.servings || []).find(x => x.name === f.defaultServing) || f.servings?.[0];
    if (!s) return '';
    const n = scale(f.perGram, (f.defaultAmount || 1) * s.grams);
    return `${servingDesc(f)} · ${f0(n.kcal)} kcal`;
  })();
  return `
    <div class="food-row" data-id="${f.id}">
      <div class="food-main">
        <div class="food-name">${f.favorite ? '⭐ ' : ''}${f.source === 'recipe' ? '🍲 ' : ''}${esc(f.name)}</div>
        <div class="food-sub">${esc(perServ)}</div>
      </div>
      <button class="quick-add" data-quick="${f.id}" title="Log usual portion">＋</button>
    </div>`;
}

function filteredFoods() {
  let list = [...foods];
  if (foodsFilter.tab === 'fav') list = list.filter(f => f.favorite);
  if (foodsFilter.tab === 'recent') {
    list = list.filter(f => f.lastUsed).sort((a, b) => (b.lastUsed || '').localeCompare(a.lastUsed || ''));
  } else {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  const q = foodsFilter.q.trim().toLowerCase();
  if (q) list = list.filter(f => f.name.toLowerCase().includes(q) || (f.barcode || '').includes(q));
  return list;
}

function renderFoodsScreen() {
  const scr = document.getElementById('screen-foods');
  scr.innerHTML = `
    <h2>Foods</h2>
    <div class="row gap">
      <button class="btn small" id="foods-scan">📷 Scan</button>
      <button class="btn small" id="foods-label">🏷 Label photo</button>
      <button class="btn small" id="foods-usda">🔎 Search</button>
      <button class="btn small" id="foods-new">✏️ New food</button>
    </div>
    <input class="input" id="foods-search" placeholder="Search saved foods…" value="${esc(foodsFilter.q)}">
    <div class="chips">
      <button class="chip ${foodsFilter.tab === 'all' ? 'on' : ''}" data-tab="all">All</button>
      <button class="chip ${foodsFilter.tab === 'fav' ? 'on' : ''}" data-tab="fav">⭐ Favorites</button>
      <button class="chip ${foodsFilter.tab === 'recent' ? 'on' : ''}" data-tab="recent">Recents</button>
    </div>
    <div class="list" id="foods-list"></div>`;

  const renderList = () => {
    const list = filteredFoods();
    const el = scr.querySelector('#foods-list');
    el.innerHTML = list.map(foodRowHtml).join('') ||
      '<div class="empty-line">No foods yet. Scan a barcode or add one manually.</div>';
    el.querySelectorAll('.food-row').forEach(r => r.onclick = (e) => {
      if (e.target.closest('.quick-add')) return;
      openFoodDetail(foodsById.get(r.dataset.id), { date: currentDate });
    });
    el.querySelectorAll('.quick-add').forEach(b => b.onclick = async () => {
      const f = foodsById.get(b.dataset.quick);
      const s = (f.servings || []).find(x => x.name === f.defaultServing) || f.servings?.[0];
      if (!s) return;
      const grams = (f.defaultAmount || 1) * s.grams;
      await addLogEntry(f, { grams, amount: f.defaultAmount || 1, servingName: s.name, date: currentDate, group: settings.groupsEnabled ? groupForNow() : null });
      toast(`Logged ${servingDesc(f)} — ${f.name}`);
    });
  };
  renderList();

  scr.querySelector('#foods-search').oninput = (e) => { foodsFilter.q = e.target.value; renderList(); };
  scr.querySelectorAll('.chip').forEach(c => c.onclick = () => { foodsFilter.tab = c.dataset.tab; renderFoodsScreen(); });
  scr.querySelector('#foods-scan').onclick = () => scanFlow();
  scr.querySelector('#foods-label').onclick = () => pickLabelPhoto();
  scr.querySelector('#foods-usda').onclick = () => usdaSearchSheet(food => openFoodDetail(food, { date: currentDate }));
  scr.querySelector('#foods-new').onclick = () => openFoodForm(null);
}

// food picker used by dashboard "+" and the recipe builder
function pickFood(onPick) {
  const { el, close } = openSheet(`
    <div class="sheet-head"><h3>Choose a food</h3><button class="icon-btn" data-close>✕</button></div>
    <div class="row gap">
      <button class="btn small" id="pf-scan">📷 Scan</button>
      <button class="btn small" id="pf-label">🏷 Label</button>
      <button class="btn small" id="pf-usda">🔎 Search</button>
      <button class="btn small" id="pf-new">✏️ New</button>
    </div>
    <input class="input" id="pf-search" placeholder="Search saved foods…">
    <div class="list" id="pf-list"></div>`, { full: true });

  const renderList = (q) => {
    let list = [...foods].sort((a, b) => (b.lastUsed || '').localeCompare(a.lastUsed || ''));
    if (q) list = list.filter(f => f.name.toLowerCase().includes(q.toLowerCase()));
    el.querySelector('#pf-list').innerHTML = list.slice(0, 100).map(f =>
      `<div class="food-row" data-id="${f.id}">
         <div class="food-main"><div class="food-name">${f.favorite ? '⭐ ' : ''}${f.source === 'recipe' ? '🍲 ' : ''}${esc(f.name)}</div>
         <div class="food-sub">${f0(f.perGram.kcal * 100)} kcal / 100g</div></div></div>`).join('') ||
      '<div class="empty-line">No saved foods match.</div>';
    el.querySelectorAll('.food-row').forEach(r => r.onclick = () => { close(); onPick(foodsById.get(r.dataset.id)); });
  };
  renderList('');
  el.querySelector('#pf-search').oninput = e => renderList(e.target.value);
  el.querySelector('#pf-scan').onclick = () => { close(); scanFlow(onPick); };
  el.querySelector('#pf-label').onclick = () => { close(); pickLabelPhoto(onPick); };
  el.querySelector('#pf-usda').onclick = () => { close(); usdaSearchSheet(onPick); };
  el.querySelector('#pf-new').onclick = () => { close(); openFoodForm(null, { onSaved: onPick }); };
}

// ---------------------------------------------------------------- food detail

function openFoodDetail(food, ctx = {}) {
  // ctx: {mode:'add'|'edit-entry', entry, date, group, onLogged}
  const mode = ctx.mode || 'add';
  const entry = ctx.entry || null;
  const overlayBack = document.createElement('div');
  overlayBack.className = 'overlay';
  document.getElementById('modal-root').appendChild(overlayBack);
  const close = () => overlayBack.remove();

  let amount = entry ? (entry.amount || entry.grams) : (food.defaultAmount || 1);
  let servingName = entry
    ? (entry.servingName && (food.servings || []).some(s => s.name === entry.servingName) ? entry.servingName : 'g')
    : (food.defaultServing && (food.servings || []).some(s => s.name === food.defaultServing) ? food.defaultServing : (food.servings?.[0]?.name || 'g'));
  if (entry && !entry.servingName) amount = entry.grams;
  let group = entry ? (entry.group || null) : (ctx.group || (settings.groupsEnabled ? groupForNow() : null));
  const ts = entry?.timestamp ? new Date(entry.timestamp) : new Date();
  let timeVal = String(ts.getHours()).padStart(2, '0') + ':' + String(ts.getMinutes()).padStart(2, '0');

  const render = () => {
    const serving = (food.servings || []).find(s => s.name === servingName) || { name: 'g', grams: 1 };
    const grams = (parseFloat(amount) || 0) * serving.grams;
    const n = scale(food.perGram, grams);
    const mk = macroKcal(n);
    const mkTotal = (mk.protein ?? 0) + (mk.carbs ?? 0) + (mk.fat ?? 0);
    const pctOf = v => (v != null && n.kcal) ? Math.round(v / n.kcal * 100) + '%' : '—';

    // donut segments
    const R = 52, C = 2 * Math.PI * R;
    let segs = '', off = 0;
    if (mkTotal > 0) {
      for (const [key, val] of [['protein', mk.protein], ['carbs', mk.carbs], ['fat', mk.fat]]) {
        const frac = (val ?? 0) / mkTotal;
        if (frac > 0) {
          segs += `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${MACRO_COLORS[key]}" stroke-width="10"
            stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off * C).toFixed(2)}"
            transform="rotate(-90 60 60)"/>`;
          off += frac;
        }
      }
    } else {
      segs = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--line)" stroke-width="10"/>`;
    }

    const microRow = (label, val, unit) => `
      <div class="micro-row"><span>${label}</span><span>${val == null ? '—' : fg(val) + ' ' + unit}</span></div>`;

    overlayBack.innerHTML = `
      <div class="overlay-card">
        <div class="sheet-head">
          <button class="icon-btn star ${food.favorite ? 'on' : ''}" id="fd-star">★</button>
          <h3 class="grow">${esc(food.name)}</h3>
          <button class="icon-btn" id="fd-close">✕</button>
        </div>
        <div class="fd-controls">
          <label>Amount<input class="input" id="fd-amount" type="number" inputmode="decimal" step="any" min="0" value="${amount}"></label>
          <label>Serving Size<select class="input" id="fd-serving">
            ${(food.servings || []).map(s => `<option value="${esc(s.name)}" ${s.name === servingName ? 'selected' : ''}>${esc(s.name)} (${fg(s.grams)}g)</option>`).join('')}
          </select></label>
        </div>
        <div class="fd-controls">
          ${settings.groupsEnabled ? `<label>Meal<select class="input" id="fd-group">
            ${GROUPS.map(g => `<option ${g === group ? 'selected' : ''}>${g}</option>`).join('')}
          </select></label>` : ''}
          <label>Time<input class="input" id="fd-time" type="time" value="${timeVal}"></label>
        </div>
        <div class="fd-info-line">Nutritional Information per ${fg(parseFloat(amount) || 0)} ${esc(serving.name)} — ${fg(grams)}g</div>
        <div class="energy-summary">
          <svg viewBox="0 0 120 120" class="donut">${segs}
            <text x="60" y="57" text-anchor="middle" class="donut-kcal">${f0(n.kcal)}</text>
            <text x="60" y="74" text-anchor="middle" class="donut-unit">kcal</text>
          </svg>
          <div class="macro-legend">
            <div><i style="background:var(--c-protein)"></i>Protein <b>${fg(n.protein)}g</b> <span class="dim">${pctOf(mk.protein)}</span></div>
            <div><i style="background:var(--c-carbs)"></i>Carbs <b>${fg(n.carbs)}g</b> <span class="dim">${pctOf(mk.carbs)}</span></div>
            <div><i style="background:var(--c-fat)"></i>Fat <b>${fg(n.fat)}g</b> <span class="dim">${pctOf(mk.fat)}</span></div>
          </div>
        </div>
        <div class="micro-block">
          ${microRow('Fiber', n.fiber, 'g')}${microRow('Sugar', n.sugar, 'g')}
          ${microRow('Sat. Fat', n.satFat, 'g')}${microRow('Sodium', n.sodium, 'mg')}
        </div>
        <div class="row gap">
          ${food._unsaved ? '' : `<button class="btn small" id="fd-edit">${food.source === 'recipe' ? 'Edit recipe' : 'Edit food'}</button>`}
          ${food.barcode && !food._unsaved ? '<button class="btn small" id="fd-refresh">↻ Refresh data</button>' : ''}
          ${food.source === 'recipe' ? '<button class="btn small" id="fd-label">Nutrition label</button>' : ''}
        </div>
        <button class="btn primary wide" id="fd-log">${mode === 'edit-entry' ? 'Update Entry' : 'Add to Diary'}</button>
        ${mode === 'edit-entry' ? '<button class="btn danger wide" id="fd-del">Delete Entry</button>' : ''}
      </div>`;

    overlayBack.querySelector('#fd-close').onclick = close;
    overlayBack.querySelector('#fd-amount').oninput = e => { amount = e.target.value; softUpdate(); };
    overlayBack.querySelector('#fd-serving').onchange = e => { servingName = e.target.value; render(); };
    const gsel = overlayBack.querySelector('#fd-group');
    if (gsel) gsel.onchange = e => { group = e.target.value; };
    overlayBack.querySelector('#fd-time').onchange = e => { timeVal = e.target.value; };
    overlayBack.querySelector('#fd-star').onclick = async () => {
      // starring means "keep this food" — persist immediately, even before it's logged
      food.favorite = !food.favorite;
      delete food._unsaved;
      if (!food.lastUsed) food.lastUsed = new Date().toISOString();
      await DB.put('foods', food);
      await refreshFoods();
      overlayBack.querySelector('#fd-star').classList.toggle('on', food.favorite);
    };
    const editBtn = overlayBack.querySelector('#fd-edit');
    if (editBtn) editBtn.onclick = () => {
      close();
      if (food.source === 'recipe') openRecipeBuilder(food);
      else openFoodForm(food);
    };
    const labelBtn = overlayBack.querySelector('#fd-label');
    if (labelBtn) labelBtn.onclick = () => openLabel(food);
    const refreshBtn = overlayBack.querySelector('#fd-refresh');
    if (refreshBtn) refreshBtn.onclick = async () => {
      toast('Refreshing product data…');
      const r = await refreshBarcodeFood(food);
      if (!r) { toast('No fresh data found for this barcode'); return; }
      food = r.food;
      render();
      toast(r.warn ? 'Refreshed — but this product’s database entry looks shaky, double-check the label' : 'Product data refreshed ✓');
    };
    overlayBack.querySelector('#fd-log').onclick = async () => {
      const g = (parseFloat(amount) || 0) * serving.grams;
      if (g <= 0) { toast('Enter an amount first'); return; }
      const date = ctx.date || currentDate;
      const [hh, mm] = timeVal.split(':').map(Number);
      const [y, mo, d] = date.split('-').map(Number);
      const timestamp = new Date(y, mo - 1, d, hh || 0, mm || 0).toISOString();
      if (mode === 'edit-entry') {
        await DB.put('log', { ...entry, grams: g, amount: parseFloat(amount) || g, servingName: serving.name, group: settings.groupsEnabled ? group : null, timestamp });
        schedulePiBackup();
      } else {
        await addLogEntry(food, { grams: g, amount: parseFloat(amount) || 1, servingName: serving.name, date, group: settings.groupsEnabled ? group : null, timestamp });
      }
      close();
      if (ctx.onLogged) ctx.onLogged();
      navTo('dashboard');
    };
    const delBtn = overlayBack.querySelector('#fd-del');
    if (delBtn) delBtn.onclick = async () => {
      if (!confirm('Delete this log entry?')) return;
      await DB.del('log', entry.id);
      schedulePiBackup();
      close(); navTo('dashboard');
    };
  };

  // update numbers without rebuilding (keeps keyboard focus on iOS)
  const softUpdate = () => {
    const serving = (food.servings || []).find(s => s.name === servingName) || { name: 'g', grams: 1 };
    const grams = (parseFloat(amount) || 0) * serving.grams;
    const focusEl = document.activeElement;
    const pos = focusEl && focusEl.id === 'fd-amount' ? focusEl.selectionStart : null;
    render();
    if (pos != null) {
      const a = overlayBack.querySelector('#fd-amount');
      a.focus();
    }
  };

  render();
}

async function addLogEntry(food, { grams, amount, servingName, date, group, timestamp }) {
  if (food._unsaved) {
    delete food._unsaved;
    await DB.put('foods', food);
  }
  // favorites remember the usual portion
  food.lastUsed = new Date().toISOString();
  food.defaultServing = servingName;
  food.defaultAmount = amount;
  await DB.put('foods', food);
  await refreshFoods();
  await DB.put('log', {
    id: uuid(), date, foodId: food.id, grams,
    amount, servingName,
    timestamp: timestamp || new Date().toISOString(),
    group: group || null,
  });
  schedulePiBackup();
}

// ---------------------------------------------------------------- label photo → Claude vision

const LABEL_PROMPT = `Read the nutrition facts label in this photo. Reply with ONLY a JSON object, no other text, in exactly this shape:
{"name": "product name if visible, else null", "brand": "brand if visible, else null", "serving_name": "the household serving unit, e.g. bag / 2 tbsp / 1 cup / 28 chips", "serving_grams": 32, "per_serving": {"kcal": 140, "protein_g": 19, "carbs_g": 5, "fat_g": 5, "fiber_g": 1, "sugar_g": 1, "sat_fat_g": null, "sodium_mg": 290}}
Rules: every value must be per ONE serving exactly as printed on the label. serving_grams is the gram weight printed next to the serving size (e.g. 32 from "(32g)"); null if the label doesn't print one. Use null for any nutrient the label does not list — never guess, estimate, or compute a missing value. If the photo contains no readable nutrition facts label, reply {"error": "what you see instead"}.`;

function fileToJpegB64(file, maxSide = 1568) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * s);
        c.height = Math.round(img.naturalHeight * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        res(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
      } catch (e) { rej(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('could not open that photo')); };
    img.src = url;
  });
}

async function readLabelPhoto(file) {
  const b64 = await fileToJpegB64(file);
  const headers = {
    'content-type': 'application/json',
    'x-api-key': settings.anthropicKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'server-side-fallback-2026-07-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  // identity-linked API keys must say which workspace the request acts in
  if (settings.anthropicWorkspace) headers['anthropic-workspace-id'] = settings.anthropicWorkspace;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 2048,
      output_config: { effort: 'low' },
      fallbacks: 'default',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: LABEL_PROMPT },
        ],
      }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => null);
    const msg = err?.error?.message || ('HTTP ' + resp.status);
    if (/workspace-id/i.test(msg)) {
      throw new Error('your API key needs a Workspace ID. In Settings, fill the "Workspace ID" box: get it at console.anthropic.com → Settings → Workspaces → tap your workspace → copy the ID (starts with wrkspc_).');
    }
    throw new Error(msg);
  }
  const msg = await resp.json();
  if (msg.stop_reason === 'refusal') throw new Error('the model declined to read this image');
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no label data found in the reply');
  const data = JSON.parse(m[0]);
  if (data.error) throw new Error(data.error);
  return data;
}

// opens the iOS photo library / camera picker (native behavior of a file input)
function pickLabelPhoto(onPick = null) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = () => { if (inp.files && inp.files[0]) labelPhotoFlow(inp.files[0], onPick); };
  inp.click();
}

async function labelPhotoFlow(file, onPick = null) {
  if (!settings.anthropicKey) {
    alert('Label photo reading needs your Claude API key.\n\nGet one at console.anthropic.com → API Keys, then paste it in Settings. It stays on this phone.');
    navTo('settings');
    return;
  }
  toast('Reading label…');
  let data;
  try {
    data = await readLabelPhoto(file);
  } catch (e) {
    alert('Could not read the label: ' + e.message);
    return;
  }
  const sg = parseFloat(data.serving_grams) || 0;
  const basis = sg || 100;
  const ps = data.per_serving || {};
  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v / basis : null;
  const prefill = {
    id: uuid(),
    name: [data.name, data.brand && data.name && !String(data.name).toLowerCase().includes(String(data.brand).toLowerCase()) ? `(${data.brand})` : '']
      .filter(Boolean).join(' ').trim() || (data.brand || ''),
    barcode: null, source: 'manual',
    perGram: {
      kcal: num(ps.kcal), protein: num(ps.protein_g), carbs: num(ps.carbs_g), fat: num(ps.fat_g),
      fiber: num(ps.fiber_g), sugar: num(ps.sugar_g), sodium: num(ps.sodium_mg), satFat: num(ps.sat_fat_g),
    },
    servings: [{ name: (data.serving_name || 'serving').replace(/^1\s+(?!\/)/, ''), grams: basis }, { name: 'g', grams: 1 }],
    defaultServing: (data.serving_name || 'serving').replace(/^1\s+(?!\/)/, ''),
    defaultAmount: 1, favorite: false, lastUsed: null,
  };
  if (prefill.perGram.kcal == null) { alert('The label photo had no readable calories — try a straighter, closer shot.'); return; }
  if (!sg) toast('Label had no gram weight — double-check the serving grams field');
  openFoodForm(null, { prefill, onSaved: onPick || undefined });
}

// ---------------------------------------------------------------- manual food form

function openFoodForm(existing, { barcode = '', onSaved = null, prefill = null } = {}) {
  const isEdit = !!existing;
  const f = existing || prefill || {
    id: uuid(), name: '', barcode, source: 'manual',
    perGram: Object.fromEntries(NUTRIENTS.map(k => [k, null])),
    servings: [{ name: 'serving', grams: 100 }, { name: 'g', grams: 1 }],
    defaultServing: 'serving', defaultAmount: 1, favorite: false, lastUsed: null,
  };
  const filled = isEdit || !!prefill; // prefill = values read from a label photo, shown for review
  // basis serving for entering label values
  let basis = (f.servings || []).find(s => s.name !== 'g') || { name: 'g', grams: 100 };
  let basisGrams = basis.grams;

  const val = (k) => {
    if (!filled) return '';
    const v = f.perGram[k];
    if (v == null) return '';
    const x = v * basisGrams * (k === 'sodium' ? 1 : 1);
    return String(Math.round(x * 100) / 100);
  };

  const { el, close } = openSheet(`
    <div class="sheet-head"><h3>${isEdit ? 'Edit food' : 'New food'}</h3><button class="icon-btn" data-close>✕</button></div>
    <label>Name<input class="input" id="ff-name" value="${esc(f.name)}" placeholder="e.g. Quest Chips, Loaded Taco"></label>
    <label>Barcode (optional)<input class="input" id="ff-barcode" inputmode="numeric" value="${esc(f.barcode || '')}"></label>
    <div class="fd-controls">
      <label>Serving name<input class="input" id="ff-sname" value="${esc(basis.name)}"></label>
      <label>Serving grams<input class="input" id="ff-sgrams" type="number" inputmode="decimal" step="any" min="0" value="${basisGrams}"></label>
    </div>
    <p class="hint">Enter the nutrition label values <b>per 1 serving</b> above. Leave blank if the label doesn't list it (blank = unknown, shows as a dash — never 0).</p>
    <div class="grid2">
      <label>Calories (kcal)*<input class="input" id="ff-kcal" type="number" inputmode="decimal" step="any" value="${val('kcal')}"></label>
      <label>Protein (g)<input class="input" id="ff-protein" type="number" inputmode="decimal" step="any" value="${val('protein')}"></label>
      <label>Carbs (g)<input class="input" id="ff-carbs" type="number" inputmode="decimal" step="any" value="${val('carbs')}"></label>
      <label>Fat (g)<input class="input" id="ff-fat" type="number" inputmode="decimal" step="any" value="${val('fat')}"></label>
      <label>Fiber (g)<input class="input" id="ff-fiber" type="number" inputmode="decimal" step="any" value="${val('fiber')}"></label>
      <label>Sugar (g)<input class="input" id="ff-sugar" type="number" inputmode="decimal" step="any" value="${val('sugar')}"></label>
      <label>Sat. fat (g)<input class="input" id="ff-satFat" type="number" inputmode="decimal" step="any" value="${val('satFat')}"></label>
      <label>Sodium (mg)<input class="input" id="ff-sodium" type="number" inputmode="decimal" step="any" value="${val('sodium')}"></label>
    </div>
    <div id="ff-extra-servings"></div>
    <button class="btn small" id="ff-add-serving">＋ Add another serving option</button>
    <button class="btn primary wide" id="ff-save">${isEdit ? 'Save changes' : 'Save food'}</button>
    ${isEdit ? '<button class="btn danger wide" id="ff-delete">Delete food</button>' : ''}`, { full: true });

  // extra named servings beyond the basis + g
  let extraServings = (f.servings || []).filter(s => s.name !== 'g' && s.name !== basis.name);
  const renderExtras = () => {
    el.querySelector('#ff-extra-servings').innerHTML = extraServings.map((s, i) => `
      <div class="fd-controls extra-serving" data-i="${i}">
        <label>Serving name<input class="input es-name" value="${esc(s.name)}"></label>
        <label>Grams<input class="input es-grams" type="number" step="any" value="${s.grams}"></label>
        <button class="icon-btn es-del">✕</button>
      </div>`).join('');
    el.querySelectorAll('.extra-serving .es-del').forEach(b => b.onclick = () => {
      extraServings.splice(+b.closest('.extra-serving').dataset.i, 1); renderExtras();
    });
  };
  renderExtras();
  el.querySelector('#ff-add-serving').onclick = () => {
    // pull current typed values first so they aren't lost on re-render
    el.querySelectorAll('.extra-serving').forEach(row => {
      const i = +row.dataset.i;
      extraServings[i] = { name: row.querySelector('.es-name').value, grams: parseFloat(row.querySelector('.es-grams').value) || 0 };
    });
    extraServings.push({ name: '', grams: 0 });
    renderExtras();
  };

  el.querySelector('#ff-save').onclick = async () => {
    const name = el.querySelector('#ff-name').value.trim();
    const sName = el.querySelector('#ff-sname').value.trim() || 'serving';
    const sGrams = parseFloat(el.querySelector('#ff-sgrams').value);
    const kcal = el.querySelector('#ff-kcal').value.trim();
    if (!name) { toast('Give it a name'); return; }
    if (!sGrams || sGrams <= 0) { toast('Serving grams is required — nutrition is stored per gram'); return; }
    if (kcal === '') { toast('Calories are required'); return; }
    const num = id => {
      const raw = el.querySelector('#ff-' + id).value.trim();
      return raw === '' ? null : (parseFloat(raw) / sGrams);
    };
    f.name = name;
    f.barcode = el.querySelector('#ff-barcode').value.trim() || null;
    f.perGram = {
      kcal: num('kcal'), protein: num('protein'), carbs: num('carbs'), fat: num('fat'),
      fiber: num('fiber'), sugar: num('sugar'), sodium: num('sodium'), satFat: num('satFat'),
    };
    el.querySelectorAll('.extra-serving').forEach(row => {
      const i = +row.dataset.i;
      extraServings[i] = { name: row.querySelector('.es-name').value.trim(), grams: parseFloat(row.querySelector('.es-grams').value) || 0 };
    });
    const servings = [{ name: sName, grams: sGrams }];
    for (const s of extraServings) if (s.name && s.grams > 0 && s.name !== sName && s.name !== 'g') servings.push(s);
    if (!servings.some(s => s.name === 'oz')) servings.push({ name: 'oz', grams: 28.35 });
    servings.push({ name: 'g', grams: 1 });
    f.servings = servings;
    if (!f.servings.some(s => s.name === f.defaultServing)) { f.defaultServing = sName; f.defaultAmount = 1; }
    delete f._unsaved;
    await DB.put('foods', f);
    await refreshFoods();
    schedulePiBackup();
    close();
    toast(isEdit ? 'Food updated' : 'Food saved');
    if (onSaved) onSaved(foodsById.get(f.id));
    else if (document.getElementById('screen-foods').classList.contains('active')) renderFoodsScreen();
  };

  const delBtn = el.querySelector('#ff-delete');
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm(`Delete "${f.name}"? Past log entries keep their grams but lose the nutrition data.`)) return;
    await DB.del('foods', f.id);
    await refreshFoods();
    close();
    renderFoodsScreen();
  };
}

// ---------------------------------------------------------------- barcode flow

async function scanFlow(onPick = null) {
  let hit;
  try {
    hit = await scanBarcode();
  } catch (err) {
    alert(err.message);
    return;
  }
  if (!hit) return;
  // zxing-cpp reports UPC-A as EAN-13 "0"+UPC; try the normalized code AND the raw read
  const candidates = codeCandidates(hit.text, hit.format);
  const food = await lookupBarcode(candidates);
  if (food) {
    if (onPick) onPick(food);
    else openFoodDetail(food, { date: currentDate });
  } else {
    if (confirm(`Barcode ${candidates[0]} not found in Open Food Facts.\n\nEnter it manually from the nutrition label?`)) {
      openFoodForm(null, { barcode: candidates[0], onSaved: onPick || undefined });
    }
  }
}

// fetch + parse one barcode from Open Food Facts; returns an unsaved food or null
async function fetchOffByCode(code) {
  let data;
  try {
    const resp = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`);
    if (!resp.ok) return null;
    data = await resp.json();
  } catch (e) {
    return null;
  }
  if (!data || data.status !== 1 || !data.product) return null;
  const food = offToFood(data.product, code);
  if (!food) return null;
  await DB.put('scanCache', { barcode: code, food: { ...food, id: undefined, _checkLabel: undefined }, cachedAt: new Date().toISOString(), v: 2 });
  return food;
}

// Re-pull a saved barcode food's nutrition with the CURRENT parser, keeping its
// identity (id, star, name) so past diary entries recalculate automatically.
async function refreshBarcodeFood(food) {
  const codes = codeCandidates(food.barcode, '');
  let fresh = null;
  for (const c of codes) { fresh = await fetchOffByCode(c); if (fresh) break; }
  if (!fresh) {
    for (const c of codes) {
      const item = await nixItem('upc=' + encodeURIComponent(c));
      if (item) { fresh = nixToFood(item); break; }
    }
  }
  if (!fresh) return null;
  const warn = !!fresh._checkLabel;
  food.perGram = fresh.perGram;
  food.servings = fresh.servings;
  food.source = fresh.source;
  if (!food.servings.some(s => s.name === food.defaultServing)) {
    food.defaultServing = fresh.defaultServing;
    food.defaultAmount = fresh.defaultAmount;
  }
  await DB.put('foods', food);
  await refreshFoods();
  schedulePiBackup();
  return { food: foodsById.get(food.id), warn };
}

// Scanned foods are saved to the database IMMEDIATELY (not just on "Add to Diary"),
// so they show up in Recents and survive even if you only looked at them.
async function saveScannedFood(food) {
  delete food._unsaved;
  food.lastUsed = new Date().toISOString();
  await DB.put('foods', food);
  await refreshFoods();
  return foodsById.get(food.id);
}

// local database first (instant + offline), then the lookup cache, then Open Food Facts
async function lookupBarcode(candidates) {
  for (const code of candidates) {
    const local = await DB.byIndex('foods', 'barcode', code);
    if (local.length) {
      const f = local[0];
      f.lastUsed = new Date().toISOString(); // a scan counts as recent use
      await DB.put('foods', f);
      await refreshFoods();
      return foodsById.get(f.id);
    }
  }
  for (const code of candidates) {
    const cached = await DB.get('scanCache', code);
    // v2 = cached by the basis-checking parser; older cached lookups get refetched
    if (cached && cached.v === 2) return saveScannedFood({ ...cached.food, id: uuid(), barcode: code });
  }
  for (const code of candidates) {
    const food = await fetchOffByCode(code);
    if (!food) continue;
    if (food._checkLabel) {
      delete food._checkLabel;
      setTimeout(() => toast('⚠ This product’s database entry looked off — double-check the numbers against the label'), 600);
    }
    return saveScannedFood(food);
  }
  // last resort: Nutritionix UPC lookup (official brand data), when keys are set
  for (const code of candidates) {
    const item = await nixItem('upc=' + encodeURIComponent(code));
    if (item) {
      const food = nixToFood(item);
      if (food) {
        food.barcode = code;
        await DB.put('scanCache', { barcode: code, food: { ...food, id: undefined }, cachedAt: new Date().toISOString(), v: 2 });
        return saveScannedFood(food);
      }
    }
  }
  return null;
}

function offToFood(p, barcode) {
  const nu = p.nutriments || {};
  const qty = parseFloat(p.serving_quantity);
  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
  // per-gram candidates from BOTH bases OFF publishes
  const h = (key) => { const v = num(nu[key + '_100g']); return v == null ? null : v / 100; };
  const s = (key) => {
    if (!(qty > 0)) return null;
    const v = num(nu[key + '_serving']);
    return v == null ? null : v / qty;
  };

  // OFF crowd data sometimes lands the LABEL's per-serving numbers in the _100g
  // fields (Scot's 19-kcal Big Mac... err, Birthday Cake Bites bug, 9-01).
  // Detect: serving is far from 100g, yet _100g ≈ _serving for calories.
  const k100 = num(nu['energy-kcal_100g']), kServ = num(nu['energy-kcal_serving']);
  let poisoned = false;
  if (qty > 0 && Math.abs(qty - 100) > 15 && k100 != null && kServ != null && kServ > 0) {
    poisoned = Math.abs(k100 - kServ) / kServ < 0.15;
  }

  const pick = (key) => {
    const hv = h(key), sv = s(key);
    if (poisoned) {
      // _100g fields hold per-serving values: use per-serving, or reinterpret _100g as per-serving
      if (sv != null) return sv;
      return (hv != null && qty > 0) ? (hv * 100) / qty : hv;
    }
    if (hv == null) return sv;
    if (sv == null) return hv;
    // both present but badly disagreeing: trust per-serving — it's what got typed off the label
    return (Math.abs(hv - sv) / Math.max(hv, sv) > 0.25) ? sv : hv;
  };

  const perGram = {
    kcal: pick('energy-kcal'),
    protein: pick('proteins'),
    carbs: pick('carbohydrates'),
    fat: pick('fat'),
    fiber: pick('fiber'),
    sugar: pick('sugars'),
    sodium: (() => { const v = pick('sodium'); return v == null ? null : v * 1000; })(), // g→mg per gram
    satFat: pick('saturated-fat'),
  };
  if (perGram.kcal == null && typeof nu.energy_100g === 'number') perGram.kcal = (nu.energy_100g / 4.184) / 100; // kJ fallback
  if (perGram.kcal == null) {
    // compute from macros if we can; otherwise this record is unusable
    if (perGram.protein != null || perGram.carbs != null || perGram.fat != null) {
      perGram.kcal = (perGram.protein ?? 0) * 4 + (perGram.carbs ?? 0) * 4 + (perGram.fat ?? 0) * 9;
    } else return null;
  }

  // Constraint repairs. A subtler poisoning (Scot's Drizzilicious record): SOME
  // nutrients typed per-serving into the _100g fields while others are true
  // per-100g — internally consistent, so only physical impossibilities give it
  // away: sugar can't exceed total carbs, saturated fat can't exceed total fat.
  // The under-scaled side is off by exactly 100/serving-grams — rescale it.
  const scale = (qty > 0 && Math.abs(qty - 100) > 15) ? 100 / qty : null;
  const repaired = [];
  if (scale) {
    const pg = perGram;
    if (pg.satFat != null && pg.fat != null && pg.satFat > pg.fat * 1.02) {
      const f2 = pg.fat * scale;
      if (pg.satFat <= f2 * 1.02) { pg.fat = f2; repaired.push('fat'); }
    }
    if (pg.sugar != null && pg.carbs != null && pg.sugar > pg.carbs * 1.02) {
      const c2 = pg.carbs * scale;
      if (pg.sugar <= c2 * 1.02) { pg.carbs = c2; repaired.push('carbs'); }
    }
    const estNow = () => (pg.protein ?? 0) * 4 + (pg.carbs ?? 0) * 4 + (pg.fat ?? 0) * 9;
    if (pg.kcal != null) {
      const e = estNow();
      if (e > 0.5 && pg.kcal / e < 0.6 && (pg.kcal * scale) / e <= 1.6) { pg.kcal *= scale; repaired.push('kcal'); }
    }
    // several fields proven under-scaled -> the whole macro row was typed per-serving
    if (repaired.length >= 2 && pg.protein != null && !repaired.includes('protein')) {
      pg.protein *= scale;
      repaired.push('protein');
    }
    // sodium can't be constraint-checked, but OFF carries salt too (salt = sodium x 2.5);
    // when they contradict each other on a proven-poisoned record, honest null beats wrong
    if (repaired.length >= 2 && pg.sodium != null) {
      const saltG = num(nu.salt_100g);
      const sodiumFromSalt = saltG == null ? null : (saltG / 2.5) / 100 * 1000; // mg per gram
      if (sodiumFromSalt != null && Math.max(pg.sodium, sodiumFromSalt) > 0 &&
        Math.abs(pg.sodium - sodiumFromSalt) / Math.max(pg.sodium, sodiumFromSalt) > 0.5) {
        pg.sodium = null;
      }
    }
  }

  // Atwater sanity: stated calories should roughly match 4/4/9 from the macros
  const est = (perGram.protein ?? 0) * 4 + (perGram.carbs ?? 0) * 4 + (perGram.fat ?? 0) * 9;
  const suspicious = poisoned || repaired.length > 0 ||
    (est > 0.5 && perGram.kcal != null && (perGram.kcal / est > 1.5 || perGram.kcal / est < 0.6));
  const servings = [];
  if (qty > 0) {
    const label = (p.serving_size || '').trim();
    servings.push({ name: label && !/^\d/.test(label) ? label : 'serving' + (label ? ` (${label})` : ''), grams: qty });
  }
  servings.push({ name: 'oz', grams: 28.35 });
  servings.push({ name: 'g', grams: 1 });
  const name = [p.product_name, p.brands ? `(${p.brands.split(',')[0].trim()})` : ''].filter(Boolean).join(' ').trim() || `Product ${barcode}`;
  return {
    id: uuid(), name, barcode, source: 'openfoodfacts', perGram, servings,
    defaultServing: servings[0].name, defaultAmount: qty > 0 ? 1 : 100,
    favorite: false, lastUsed: null,
    _checkLabel: suspicious || undefined,
  };
}

// ---------------------------------------------------------------- USDA search

// ---- Nutritionix: official restaurant/brand menu numbers (needs free keys in Settings) ----

function nixCreds() {
  const n = settings.nutritionix || {};
  return (n.id && n.key) ? { 'x-app-id': n.id, 'x-app-key': n.key } : null;
}

async function nixInstant(q) {
  const h = nixCreds();
  if (!h) return [];
  try {
    const resp = await fetch(`https://trackapi.nutritionix.com/v2/search/instant?query=${encodeURIComponent(q)}&common=false&branded=true`, { headers: h });
    if (!resp.ok) return [];
    const d = await resp.json();
    return (d.branded || []).slice(0, 15);
  } catch (e) { return []; }
}

async function nixItem(params) {
  const h = nixCreds();
  if (!h) return null;
  try {
    const resp = await fetch(`https://trackapi.nutritionix.com/v2/search/item?${params}`, { headers: h });
    if (!resp.ok) return null;
    const d = await resp.json();
    return (d.foods && d.foods[0]) || null;
  } catch (e) { return null; }
}

function nixToFood(f) {
  const per = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
  const wg = parseFloat(f.serving_weight_grams);
  const qty = f.serving_qty || 1;
  const unit = String(f.serving_unit || 'serving').trim();
  const servingName = (qty === 1 ? unit : `${fg(qty)} ${unit}`).slice(0, 40);
  const vals = {
    kcal: per(f.nf_calories), protein: per(f.nf_protein), carbs: per(f.nf_total_carbohydrate),
    fat: per(f.nf_total_fat), fiber: per(f.nf_dietary_fiber), sugar: per(f.nf_sugars),
    sodium: per(f.nf_sodium), satFat: per(f.nf_saturated_fat),
  };
  if (vals.kcal == null) return null;
  let perGram, servings;
  if (wg > 0) {
    perGram = {};
    for (const k of NUTRIENTS) perGram[k] = vals[k] == null ? null : vals[k] / wg;
    servings = [{ name: servingName, grams: wg }, { name: 'oz', grams: 28.35 }, { name: 'g', grams: 1 }];
  } else {
    // no gram weight published — 1 "gram" stands for 1 serving; g/oz would lie, so they're omitted
    perGram = { ...vals };
    servings = [{ name: servingName, grams: 1 }];
  }
  const name = [f.food_name, f.brand_name ? `(${f.brand_name})` : ''].filter(Boolean).join(' ').trim();
  return {
    id: uuid(), name, barcode: f.upc || null, source: 'nutritionix',
    perGram, servings, defaultServing: servings[0].name, defaultAmount: 1,
    favorite: false, lastUsed: null, _unsaved: true,
  };
}

// ---- combined search sheet: Nutritionix (official menus) first, then USDA ----

function usdaSearchSheet(onPick) {
  const hasNix = !!nixCreds();
  const { el, close } = openSheet(`
    <div class="sheet-head"><h3>Search foods</h3><button class="icon-btn" data-close>✕</button></div>
    <p class="hint">${hasNix
      ? 'Restaurant & brand results use official menu numbers; generic foods (chicken breast, rice) come from USDA.'
      : 'USDA search. For official restaurant menu numbers (a Big Mac = 580), add the free Nutritionix keys in Settings.'}</p>
    <div class="row gap">
      <input class="input grow" id="us-q" placeholder="e.g. big mac, chicken breast raw">
      <button class="btn" id="us-go">Search</button>
    </div>
    <div class="list" id="us-list"></div>`, { full: true });

  const run = async () => {
    const q = el.querySelector('#us-q').value.trim();
    if (!q) return;
    el.querySelector('#us-list').innerHTML = '<div class="empty-line">Searching…</div>';
    const key = settings.usdaKey || 'DEMO_KEY';

    const usdaP = (async () => {
      const resp = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(q)}&pageSize=30&dataType=Foundation,SR%20Legacy,Survey%20%28FNDDS%29,Branded`);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    })();
    const [nix, usdaRes] = await Promise.all([nixInstant(q), usdaP.then(d => ({ d }), e => ({ e }))]);

    let html = '';
    if (nix.length) {
      html += '<div class="group-head"><span>🍔 Restaurants & brands (official)</span></div>';
      html += nix.map((b, i) => `
        <div class="food-row" data-nix="${i}">
          <div class="food-main"><div class="food-name">${esc(b.food_name)}</div>
          <div class="food-sub">${esc(b.brand_name || '')} · ${Math.round(b.nf_calories)} kcal per ${esc(fg(b.serving_qty || 1))} ${esc(b.serving_unit || 'serving')}</div></div>
        </div>`).join('');
    }
    let usdaFoods = [];
    if (usdaRes.d) {
      usdaFoods = (usdaRes.d.foods || []).filter(x => x.foodNutrients?.length);
      const srcLabel = (r) => r.dataType === 'Branded' ? (r.brandOwner || 'Branded') : 'USDA';
      if (usdaFoods.length) {
        if (nix.length) html += '<div class="group-head" style="padding-top:12px"><span>🥦 USDA database</span></div>';
        html += usdaFoods.map((r, i) => {
          const k = usdaKcal100(r);
          return `
          <div class="food-row" data-usda="${i}">
            <div class="food-main"><div class="food-name">${esc(r.description)}</div>
            <div class="food-sub">${esc(srcLabel(r))}${k != null ? ` · ${Math.round(k * 100)} kcal/100g` : ''}</div></div>
          </div>`;
        }).join('');
      }
    } else {
      const throttled = /429|400/.test(usdaRes.e?.message || '') && !settings.usdaKey;
      html += `<div class="empty-line">${throttled
        ? 'USDA: the shared DEMO_KEY is rate-limited right now. Get a free key at fdc.nal.usda.gov/api-key-signup and paste it in Settings.'
        : `USDA search failed (${esc(usdaRes.e?.message || '?')}).`}</div>`;
    }
    if (!nix.length && !usdaFoods.length && usdaRes.d) html += '<div class="empty-line">No results.</div>';
    el.querySelector('#us-list').innerHTML = html;

    el.querySelectorAll('[data-nix]').forEach(row => row.onclick = async () => {
      const b = nix[+row.dataset.nix];
      row.querySelector('.food-sub').textContent = 'Loading nutrition…';
      row.style.pointerEvents = 'none';
      const item = await nixItem('nix_item_id=' + encodeURIComponent(b.nix_item_id));
      const food = item && nixToFood(item);
      if (!food) { toast('Could not load that item'); row.style.pointerEvents = ''; return; }
      close();
      onPick(food);
    });
    el.querySelectorAll('[data-usda]').forEach(row => row.onclick = async () => {
      const r = usdaFoods[+row.dataset.usda];
      row.querySelector('.food-sub').textContent = 'Loading serving sizes…';
      row.style.pointerEvents = 'none';
      const food = await usdaToFood(r, key);
      if (!food) { toast('That record has no usable nutrition data'); row.style.pointerEvents = ''; return; }
      close();
      onPick(food);
    });
  };
  el.querySelector('#us-go').onclick = run;
  el.querySelector('#us-q').onkeydown = e => { if (e.key === 'Enter') run(); };
  setTimeout(() => el.querySelector('#us-q').focus(), 50);
}

// kcal per gram from a search result (1008 = Energy kcal; 2047/2048 = Atwater energy)
function usdaKcal100(r) {
  const byId = {};
  for (const n of r.foodNutrients || []) byId[n.nutrientId] = n.value;
  const v = byId[1008] ?? byId[2047] ?? byId[2048];
  return (typeof v === 'number') ? v / 100 : null;
}

// The search response has nutrition per 100g but NO portion weights — without them
// a Big Mac opens as "1 oz = 73 kcal". The /food/{id} detail endpoint carries the
// real household portions ("1 McDonald's Big Mac — 205g"), so fetch and use them.
async function usdaFetchPortions(fdcId, key) {
  try {
    const resp = await fetch(`https://api.nal.usda.gov/fdc/v1/food/${fdcId}?api_key=${encodeURIComponent(key)}`);
    if (!resp.ok) return [];
    const d = await resp.json();
    const out = [];
    for (const p of d.foodPortions || []) {
      const g = parseFloat(p.gramWeight);
      if (!g || g <= 0) continue;
      let name = (p.portionDescription || '').trim();
      if (/quantity not specified/i.test(name)) continue;
      if (!name) {
        const amt = (p.amount && p.amount !== 1) ? fg(p.amount) + ' ' : '';
        const unit = (p.measureUnit?.name && p.measureUnit.name !== 'undetermined') ? p.measureUnit.name + ' ' : '';
        name = (amt + unit + (p.modifier || '')).trim();
      }
      if (!name || /^\d+$/.test(name)) continue; // FNDDS numeric portion codes are not names
      name = name.replace(/^1\s+(?!\/)/, ''); // "1 McDonald's Big Mac" + Amount field would read "1 1 …"
      if (out.length >= 6 || out.some(s => s.name.toLowerCase() === name.toLowerCase())) continue;
      out.push({ name: name.slice(0, 40), grams: g });
    }
    return out;
  } catch (e) {
    return [];
  }
}

async function usdaToFood(r, key) {
  // search results report nutrients per 100 g
  const byId = {};
  for (const n of r.foodNutrients || []) byId[n.nutrientId] = n.value;
  const per100 = (id) => (typeof byId[id] === 'number') ? byId[id] / 100 : null;
  const perGram = {
    kcal: usdaKcal100(r),
    protein: per100(1003),
    carbs: per100(1005),
    fat: per100(1004),
    fiber: per100(1079),
    sugar: per100(2000),
    sodium: per100(1093), // already mg per 100g → mg per gram
    satFat: per100(1258),
  };
  if (perGram.kcal == null) {
    if (perGram.protein != null || perGram.carbs != null || perGram.fat != null) {
      perGram.kcal = (perGram.protein ?? 0) * 4 + (perGram.carbs ?? 0) * 4 + (perGram.fat ?? 0) * 9;
    } else return null;
  }
  const servings = await usdaFetchPortions(r.fdcId, key || 'DEMO_KEY');
  if (!servings.length && r.servingSize > 0 && /^(g|grm|gram)/i.test(r.servingSizeUnit || '')) {
    servings.push({ name: (r.householdServingFullText || 'serving').trim(), grams: r.servingSize });
  }
  servings.push({ name: 'oz', grams: 28.35 });
  servings.push({ name: 'g', grams: 1 });
  return {
    id: uuid(), name: r.description, barcode: r.gtinUpc || null, source: 'usda',
    perGram, servings, defaultServing: servings[0].name,
    defaultAmount: servings[0].name === 'g' ? 100 : 1,
    favorite: false, lastUsed: null, _unsaved: true,
  };
}

// ---------------------------------------------------------------- recipes

function computeRecipe(ingredients, batchYield = null) {
  const names = ingredients.map(i => i.name);
  const rows = ingredients.map(i => {
    const f = foodsById.get(i.foodId);
    return f ? scale(f.perGram, +i.grams || 0) : Object.fromEntries(NUTRIENTS.map(k => [k, null]));
  });
  const { totals, missing } = sumStrict(rows, names);
  const rawTotal = ingredients.reduce((s, i) => s + (+i.grams || 0), 0);
  // estimated cooked batch weight. A whole-batch method (cheesecake, casserole —
  // the dish cooks as one thing) applies to the raw total and wins over the
  // per-ingredient path (each ingredient's raw grams × its USDA yield factor).
  const estCooked = batchYield
    ? rawTotal * batchYield.factor
    : ingredients.reduce((s, i) => s + (+i.grams || 0) * (i.yield ? i.yield.factor : 1), 0);
  const anyYield = !!batchYield || ingredients.some(i => i.yield);
  return { totals, missing, rawTotal, rows, estCooked, anyYield };
}

function cookPillText(ing) {
  if (!ing.yield) return '🥄 uncooked';
  const f = ing.yield.factor;
  const pct = f > 1 ? `+${Math.round((f - 1) * 100)}%` : `−${Math.round((1 - f) * 100)}%`;
  return `🔥 ${ing.yield.label} ${pct}`;
}

// pick how one ingredient is cooked (drives the estimated batch weight)
function openYieldPicker(ing, onDone, startCat = 0) {
  let cat = startCat;
  const { el, close } = openSheet('<div class="yp"></div>', { full: true });
  const render = () => {
    el.querySelector('.yp').innerHTML = `
      <div class="sheet-head"><h3 class="grow">How is “${esc(ing.name)}” cooked?</h3><button class="icon-btn" data-close>✕</button></div>
      <button class="btn wide" id="yp-raw">🥄 Not cooked / eaten as-is (×1)</button>
      <div class="chips-scroll">
        ${YIELD_CATS.map((c, i) => `<button class="chip ${cat === i ? 'on' : ''}" data-cat="${i}">${esc(c.name)}</button>`).join('')}
      </div>
      <div class="cv2-items">
        ${YIELD_CATS[cat].items.map((it, i) => `
          <div class="cv2-item" data-i="${i}">
            <span>${esc(it.name)}</span><span class="cv2-pct">${cvItemLabel(it)}</span>
          </div>`).join('')}
      </div>`;
    el.querySelector('[data-close]').onclick = close;
    el.querySelector('#yp-raw').onclick = () => { close(); onDone(null); };
    el.querySelectorAll('.chips-scroll .chip').forEach(b => b.onclick = () => { cat = +b.dataset.cat; render(); });
    el.querySelectorAll('.cv2-item').forEach(r => r.onclick = () => {
      const it = YIELD_CATS[cat].items[+r.dataset.i];
      close();
      onDone({ label: it.name, factor: it.y });
    });
  };
  render();
}

function renderRecipesScreen() {
  const scr = document.getElementById('screen-recipes');
  const recipes = foods.filter(f => f.source === 'recipe').sort((a, b) => a.name.localeCompare(b.name));
  scr.innerHTML = `
    <h2>Recipes</h2>
    <button class="btn primary" id="rc-new">＋ New recipe</button>
    <div class="list">
      ${recipes.map(r => `
        <div class="card recipe-card" data-id="${r.id}">
          <div class="food-name">🍲 ${esc(r.name)}</div>
          <div class="food-sub">${fg(r.cookedTotalGrams)}g cooked · ${f0((r.perGram.kcal ?? 0) * 100)} kcal / 100g · ${fg((r.perGram.protein ?? 0) * 100)}g protein / 100g</div>
          <div class="row gap">
            <button class="btn small" data-act="log">Log</button>
            <button class="btn small" data-act="label">Label</button>
            <button class="btn small" data-act="edit">Edit</button>
          </div>
        </div>`).join('') || '<div class="empty-line">No recipes yet. A recipe is just a food — build one and log it like anything else.</div>'}
    </div>`;
  scr.querySelector('#rc-new').onclick = () => openRecipeBuilder(null);
  scr.querySelectorAll('.recipe-card').forEach(card => {
    const r = foodsById.get(card.dataset.id);
    card.querySelector('[data-act="log"]').onclick = () => openFoodDetail(r, { date: currentDate });
    card.querySelector('[data-act="label"]').onclick = () => openLabel(r);
    card.querySelector('[data-act="edit"]').onclick = () => openRecipeBuilder(r);
  });
}

function openRecipeBuilder(existing) {
  draft = existing ? {
    id: existing.id, name: existing.name,
    ingredients: existing.ingredients.map(i => ({ ...i })),
    // only a WEIGHED cooked weight is carried into editing; estimates recompute live
    cookedTotalGrams: existing.cookedWeighed ? existing.cookedTotalGrams : null,
    batchYield: existing.batchYield ? { ...existing.batchYield } : null,
    customServings: (existing.servings || []).filter(s => !/^(whole batch|1\/2 batch|1\/4 batch|g|oz)$/.test(s.name)).map(s => ({ ...s })),
    favorite: existing.favorite, lastUsed: existing.lastUsed,
    defaultServing: existing.defaultServing, defaultAmount: existing.defaultAmount,
  } : {
    id: uuid(), name: '', ingredients: [], cookedTotalGrams: null, customServings: [],
    batchYield: null,
    favorite: false, lastUsed: null, defaultServing: null, defaultAmount: 1,
  };
  navTo('recipeEdit');
  renderRecipeBuilder();
}

function renderRecipeBuilder() {
  const scr = document.getElementById('screen-recipeEdit');
  const { totals, missing, rawTotal, estCooked, anyYield } = computeRecipe(draft.ingredients, draft.batchYield);
  // basis priority: weighed cooked > estimated-from-cook-methods > raw total
  const basis = draft.cookedTotalGrams || (anyYield ? estCooked : rawTotal);
  const basisLabel = draft.cookedTotalGrams && draft.cookedTotalGrams !== rawTotal ? 'cooked (weighed)'
    : (anyYield ? 'cooked (estimated)' : 'raw');
  const per100 = (k) => (totals[k] == null || !basis) ? null : totals[k] / basis * 100;
  const missingAny = Object.keys(missing).length > 0;

  scr.innerHTML = `
    <div class="sheet-head">
      <button class="icon-btn" id="rb-back">‹</button>
      <h3 class="grow">${draft.cookedTotalGrams ? 'Edit recipe' : 'Recipe builder'}</h3>
    </div>
    <label>Recipe name<input class="input" id="rb-name" value="${esc(draft.name)}" placeholder="e.g. Chicken burrito batch"></label>
    <div class="list" id="rb-ingredients">
      ${draft.ingredients.map((ing, i) => {
        const f = foodsById.get(ing.foodId);
        const n = f ? scale(f.perGram, +ing.grams || 0) : null;
        return `
        <div class="ing-row" data-i="${i}">
          <div class="ing-main">
            <div class="food-name">${esc(ing.name)}${f ? '' : ' <span class="warn">(deleted)</span>'}</div>
            <div class="food-sub">${n ? `${f0(n.kcal)} kcal · ${fg(n.protein)}g protein` : 'no data'}</div>
            <button class="cook-pill">${esc(cookPillText(ing))}</button>
          </div>
          <input class="input ing-grams" type="number" inputmode="decimal" step="any" min="0" value="${ing.grams}"> g
          <button class="icon-btn ing-convert" title="Convert cooked→raw">⇄</button>
          <button class="icon-btn ing-del">✕</button>
        </div>`;
      }).join('') || '<div class="empty-line">No ingredients yet.</div>'}
    </div>
    <div class="row gap">
      <button class="btn small" id="rb-add">＋ Add ingredient</button>
      <button class="btn small" id="rb-scan">📷 Scan</button>
    </div>
    <button class="cook-pill" id="rb-batch">${draft.batchYield
      ? `🍳 Whole batch: ${esc(draft.batchYield.label)} −${Math.round((1 - draft.batchYield.factor) * 100)}%`
      : '🍳 Whole-batch cooking (cheesecake, casserole…): none'}</button>
    <p class="hint">Weigh ingredients <b>raw</b> (g; for liquids use ml ≈ g). If you weighed one cooked, tap ⇄ to convert. A cooked batch weight at save time is optional — for dishes that lose or gain water in cooking.</p>
    ${draft.cookedTotalGrams ? `<label>Cooked batch weight (g)<input class="input" id="rb-cooked" type="number" step="any" value="${draft.cookedTotalGrams}"></label>` : ''}
    <div class="recipe-footer card">
      <div class="rf-line big"><span>Total raw</span><span><b>${fg(rawTotal)} g</b> · <b>${f0(totals.kcal)}</b> kcal</span></div>
      ${anyYield && !draft.cookedTotalGrams ? `<div class="rf-line"><span>Est. cooked weight</span><span><b>${fg(estCooked)} g</b> from cook methods</span></div>` : ''}
      <div class="rf-line"><span>Per 100g ${basisLabel}</span>
        <span>${f0(per100('kcal'))} kcal · ${fg(per100('protein'))}g protein</span></div>
      ${missingAny ? `<div class="rf-line warn">Some ingredients are missing data for: ${Object.keys(missing).join(', ')} — the label will show dashes there.</div>` : ''}
    </div>
    <button class="btn primary wide" id="rb-save" ${draft.ingredients.length ? '' : 'disabled'}>Save recipe</button>
    <button class="btn wide" id="rb-cancel">Cancel</button>`;

  scr.querySelector('#rb-name').oninput = e => { draft.name = e.target.value; };
  scr.querySelector('#rb-back').onclick = () => navTo('recipes');
  scr.querySelector('#rb-cancel').onclick = () => navTo('recipes');
  const cooked = scr.querySelector('#rb-cooked');
  if (cooked) cooked.oninput = e => { draft.cookedTotalGrams = parseFloat(e.target.value) || null; };

  scr.querySelectorAll('.ing-row').forEach(row => {
    const i = +row.dataset.i;
    row.querySelector('.ing-grams').onchange = e => { draft.ingredients[i].grams = parseFloat(e.target.value) || 0; renderRecipeBuilder(); };
    row.querySelector('.ing-del').onclick = () => { draft.ingredients.splice(i, 1); renderRecipeBuilder(); };
    row.querySelector('.cook-pill').onclick = () => openYieldPicker(draft.ingredients[i], y => {
      draft.ingredients[i].yield = y;
      renderRecipeBuilder();
    });
    row.querySelector('.ing-convert').onclick = () => converterModal(raw => {
      draft.ingredients[i].grams = Math.round(raw * 10) / 10;
      renderRecipeBuilder();
    });
  });

  const addIngredient = (food) => {
    if (!food) return;
    const finish = async (f) => {
      gramsPrompt(f, grams => {
        // auto-guess the cook method from the name; the 🔥/🥄 pill overrides it
        draft.ingredients.push({ foodId: f.id, name: f.name, grams, yield: guessYield(f.name) });
        renderRecipeBuilder();
      });
    };
    if (food._unsaved) {
      delete food._unsaved;
      DB.put('foods', food).then(refreshFoods).then(() => finish(food));
    } else finish(food);
  };
  scr.querySelector('#rb-add').onclick = () => pickFood(addIngredient);
  scr.querySelector('#rb-scan').onclick = () => scanFlow(addIngredient);
  scr.querySelector('#rb-batch').onclick = () => openYieldPicker({ name: draft.name || 'this whole batch' }, y => {
    draft.batchYield = y;
    renderRecipeBuilder();
  }, Math.max(0, YIELD_CATS.findIndex(c => c.name === 'Baked & whole dishes')));
  scr.querySelector('#rb-save').onclick = () => saveRecipeModal();
}

function gramsPrompt(food, cb) {
  const { el, close } = openSheet(`
    <div class="sheet-head"><h3>${esc(food.name)}</h3><button class="icon-btn" data-close>✕</button></div>
    <label>Weight (g — for liquids ml ≈ g)<input class="input" id="gp-grams" type="number" inputmode="decimal" step="any" min="0" placeholder="raw weight in grams"></label>
    <div class="row gap wrap">
      ${(food.servings || []).filter(s => s.name !== 'g').map(s => `<button class="chip" data-g="${s.grams}">1 ${esc(s.name)} (${fg(s.grams)}g)</button>`).join('')}
    </div>
    <button class="btn small" id="gp-convert">⇄ I weighed it cooked</button>
    <button class="btn primary wide" id="gp-ok">Add ingredient</button>`);
  const input = el.querySelector('#gp-grams');
  el.querySelectorAll('.chip').forEach(c => c.onclick = () => { input.value = c.dataset.g; });
  el.querySelector('#gp-convert').onclick = () => converterModal(raw => { input.value = Math.round(raw * 10) / 10; });
  el.querySelector('#gp-ok').onclick = () => {
    const g = parseFloat(input.value);
    if (!g || g <= 0) { toast('Enter the weight'); return; }
    close();
    cb(g);
  };
  setTimeout(() => input.focus(), 50);
}

function saveRecipeModal() {
  if (!draft.name.trim()) { toast('Give the recipe a name'); return; }
  const { totals, missing, rawTotal, estCooked, anyYield } = computeRecipe(draft.ingredients, draft.batchYield);
  if (totals.kcal == null) { toast('An ingredient has no calorie data — fix it before saving'); return; }
  const fallbackG = anyYield ? estCooked : rawTotal;

  const { el, close } = openSheet(`
    <div class="sheet-head"><h3>Batch weight</h3><button class="icon-btn" data-close>✕</button></div>
    <p class="hint">${anyYield
      ? `Leave blank and the batch weight is <b>estimated at ${fg(estCooked)}g</b> from each ingredient's cook method (raw total ${fg(rawTotal)}g). Weighing the finished batch and typing it here beats the estimate.`
      : `Everything weighed raw? Just hit save — portions use the raw total (${fg(rawTotal)}g). If you weighed the <b>finished</b> batch, enter it here for extra accuracy.`}</p>
    <label>Cooked batch weight (g) — optional<input class="input" id="sr-cooked" type="number" inputmode="decimal" step="any" min="1" value="${draft.cookedTotalGrams || ''}" placeholder="blank = ${fg(fallbackG)}g ${anyYield ? 'estimated' : 'raw total'}"></label>
    <h4>Custom servings (optional)</h4>
    <p class="hint">e.g. "1 burrito — 285g". Whole/half/quarter batch and g are added automatically.</p>
    <div id="sr-custom"></div>
    <button class="btn small" id="sr-add">＋ Add custom serving</button>
    <button class="btn primary wide" id="sr-save">Save recipe</button>`);

  let custom = draft.customServings.map(s => ({ ...s }));
  const renderCustom = () => {
    el.querySelector('#sr-custom').innerHTML = custom.map((s, i) => `
      <div class="fd-controls extra-serving" data-i="${i}">
        <label>Name<input class="input cs-name" value="${esc(s.name)}" placeholder="1 burrito"></label>
        <label>Grams<input class="input cs-grams" type="number" step="any" value="${s.grams || ''}"></label>
        <button class="icon-btn cs-del">✕</button>
      </div>`).join('');
    el.querySelectorAll('.cs-del').forEach(b => b.onclick = () => { pull(); custom.splice(+b.closest('.extra-serving').dataset.i, 1); renderCustom(); });
  };
  const pull = () => {
    el.querySelectorAll('#sr-custom .extra-serving').forEach(row => {
      const i = +row.dataset.i;
      custom[i] = { name: row.querySelector('.cs-name').value.trim(), grams: parseFloat(row.querySelector('.cs-grams').value) || 0 };
    });
  };
  renderCustom();
  el.querySelector('#sr-add').onclick = () => { pull(); custom.push({ name: '', grams: 0 }); renderCustom(); };

  el.querySelector('#sr-save').onclick = async () => {
    // blank cooked weight = the per-ingredient estimate (or raw total if nothing is cooked)
    const typed = parseFloat(el.querySelector('#sr-cooked').value);
    const cookedG = typed || fallbackG;
    if (!cookedG || cookedG <= 0) { toast('Add ingredient weights first'); return; }
    pull();
    custom = custom.filter(s => s.name && s.grams > 0);

    // per-gram nutrition = raw-ingredient totals ÷ cooked grams, nulls propagate
    const perGram = {};
    for (const k of NUTRIENTS) perGram[k] = totals[k] == null ? null : totals[k] / cookedG;

    const servings = [
      { name: 'whole batch', grams: cookedG },
      { name: '1/2 batch', grams: cookedG / 2 },
      { name: '1/4 batch', grams: cookedG / 4 },
      ...custom,
      { name: 'g', grams: 1 },
    ];
    const defaultServing = custom.length ? custom[0].name : '1/4 batch';

    const recipe = {
      id: draft.id, name: draft.name.trim(), barcode: null, source: 'recipe',
      perGram, servings,
      defaultServing: (draft.defaultServing && servings.some(s => s.name === draft.defaultServing)) ? draft.defaultServing : defaultServing,
      defaultAmount: draft.defaultAmount || 1,
      favorite: draft.favorite, lastUsed: draft.lastUsed,
      ingredients: draft.ingredients.map(i => ({ ...i })),
      rawTotalGrams: rawTotal,
      cookedTotalGrams: cookedG,
      cookedWeighed: !!typed, // false = estimated/raw fallback, keeps re-estimating on edit
      batchYield: draft.batchYield || null,
      missingNutrients: missing,
    };
    await DB.put('foods', recipe);
    await refreshFoods();
    schedulePiBackup();
    close();
    navTo('recipes');
    toast('Recipe saved');
  };
}

// ---------------------------------------------------------------- nutrition label

function openLabel(recipe) {
  const back = document.createElement('div');
  back.className = 'overlay';
  back.id = 'label-overlay';
  document.getElementById('modal-root').appendChild(back);
  const close = () => back.remove();

  let servingName = recipe.defaultServing || recipe.servings[0].name;

  const render = () => {
    const serving = recipe.servings.find(s => s.name === servingName) || recipe.servings[0];
    const n = scale(recipe.perGram, serving.grams);
    const perContainer = serving.grams > 0 ? Math.round((recipe.cookedTotalGrams / serving.grams) * 10) / 10 : null;
    const missing = recipe.missingNutrients || {};
    const incompleteIngredients = [...new Set(Object.values(missing).flat())];
    const dash = (v, unit, dp = 0) => v == null ? '—' : (dp ? (Math.round(v * 10) / 10).toFixed(dp) : Math.round(v)) + unit;

    back.innerHTML = `
      <div class="overlay-card label-wrap">
        <div class="sheet-head no-print">
          <h3 class="grow">${esc(recipe.name)}</h3>
          <button class="icon-btn" id="lb-close">✕</button>
        </div>
        <label class="no-print">Serving
          <select class="input" id="lb-serving">
            ${recipe.servings.map(s => `<option value="${esc(s.name)}" ${s.name === servingName ? 'selected' : ''}>${esc(s.name)} (${fg(s.grams)}g)</option>`).join('')}
          </select>
        </label>
        <div class="nf-label" id="nf-label">
          <div class="nf-title">Nutrition Facts</div>
          <div class="nf-row nf-thin">${perContainer != null ? perContainer + ' servings per container' : ''}</div>
          <div class="nf-row nf-serving"><b>Serving size</b><b>${esc(serving.name)} (${fg(serving.grams)}g)</b></div>
          <div class="nf-cal-head">Amount per serving</div>
          <div class="nf-row nf-cal"><b>Calories</b><b class="nf-cal-num">${f0(n.kcal)}</b></div>
          <div class="nf-row nf-bar"></div>
          <div class="nf-row"><span><b>Total Fat</b> ${dash(n.fat, 'g', 1)}</span></div>
          <div class="nf-row nf-indent"><span>Saturated Fat ${dash(n.satFat, 'g', 1)}</span></div>
          <div class="nf-row"><span><b>Sodium</b> ${dash(n.sodium, 'mg')}</span></div>
          <div class="nf-row"><span><b>Total Carbohydrate</b> ${dash(n.carbs, 'g', 1)}</span></div>
          <div class="nf-row nf-indent"><span>Dietary Fiber ${dash(n.fiber, 'g', 1)}</span></div>
          <div class="nf-row nf-indent"><span>Total Sugars ${dash(n.sugar, 'g', 1)}</span></div>
          <div class="nf-row nf-last"><span><b>Protein</b> ${dash(n.protein, 'g', 1)}</span></div>
          ${incompleteIngredients.length ? `<div class="nf-note">— means unknown: incomplete data for ${esc(incompleteIngredients.join(', '))}. Missing values are never counted as zero.</div>` : ''}
          <div class="nf-note">${esc(recipe.name)} · batch ${fg(recipe.cookedTotalGrams)}g cooked</div>
        </div>
        <div class="row gap no-print">
          <button class="btn" id="lb-print">🖨 Print</button>
          <button class="btn" id="lb-share">Share</button>
        </div>
      </div>`;

    back.querySelector('#lb-close').onclick = close;
    back.querySelector('#lb-serving').onchange = e => { servingName = e.target.value; render(); };
    back.querySelector('#lb-print').onclick = () => window.print();
    back.querySelector('#lb-share').onclick = async () => {
      const text = `${recipe.name} — per ${serving.name} (${fg(serving.grams)}g): ${f0(n.kcal)} kcal, ${dash(n.protein, 'g', 1)} protein, ${dash(n.carbs, 'g', 1)} carbs, ${dash(n.fat, 'g', 1)} fat`;
      if (navigator.share) { try { await navigator.share({ title: recipe.name, text }); } catch (e) { /* cancelled */ } }
      else { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
    };
  };
  render();
}

// ---------------------------------------------------------------- converter

// One direction, like the original tool: weigh it after cooking, log it as raw.
// State is shared between the tab and the recipe-builder modal so your last
// pick (unit, category, item) sticks.
let cvState = { unit: 'g', cat: 0, item: null, customLost: '30', weight: '' };

function cvSelectedFactor() {
  if (cvState.cat === 'custom') {
    const L = parseFloat(cvState.customLost);
    if (isNaN(L) || L >= 100 || L < 0) return null;
    return 1 - L / 100;
  }
  if (cvState.item == null) return null;
  const it = YIELD_CATS[cvState.cat]?.items[cvState.item];
  return it ? it.y : null;
}

function cvItemLabel(it) {
  const pct = it.y > 1
    ? `+${Math.round((it.y - 1) * 100)}% gained`
    : `${Math.round((1 - it.y) * 100)}% lost`;
  return (it.approx ? '≈ ' : '') + pct;
}

function buildConverter(root, { onRaw = null } = {}) {
  const compute = () => {
    const w = parseFloat(cvState.weight);
    const y = cvSelectedFactor();
    if (!w || w <= 0 || !y) return null;
    const cookedG = cvState.unit === 'oz' ? w * 28.35 : w;
    return cookedG / y;
  };

  const update = () => {
    const num = root.querySelector('#cv2-num'), sub = root.querySelector('#cv2-sub');
    const raw = compute();
    if (raw == null) {
      num.textContent = '—';
      sub.textContent = 'Enter a weight and pick what you cooked.';
      return;
    }
    const y = cvSelectedFactor();
    const w = parseFloat(cvState.weight);
    const cookedG = cvState.unit === 'oz' ? w * 28.35 : w;
    const it = cvState.cat === 'custom' ? null : YIELD_CATS[cvState.cat].items[cvState.item];
    const dry = it && it.y > 1 ? ' (dry)' : '';
    num.innerHTML = `${fg(raw)}<span class="cv2-g"> g raw${dry}</span>`;
    const what = it ? it.name : `custom, ${cvState.customLost}% lost`;
    const inTxt = cvState.unit === 'oz' ? `${fg(w)}oz (${fg(cookedG)}g)` : `${fg(cookedG)}g`;
    sub.textContent = `${inTxt} cooked ÷ ${y.toFixed(2)} = ${fg(raw)}g raw · ${what}`;
  };

  const render = () => {
    root.innerHTML = `
      <h2>Cooked to raw</h2>
      <p class="hint">Weigh it after cooking, log it as raw.</p>
      <div class="cv2-input">
        <div class="cv2-in-main">
          <label>Cooked weight</label>
          <input class="cv2-weight" id="cv2-weight" type="number" inputmode="decimal" step="any" min="0" placeholder="0">
        </div>
        <div class="cv2-units">
          <button data-u="g" class="${cvState.unit === 'g' ? 'on' : ''}">grams</button>
          <button data-u="oz" class="${cvState.unit === 'oz' ? 'on' : ''}">ounces</button>
        </div>
      </div>
      <div class="cv2-result">
        <label>Raw weight</label>
        <div class="cv2-num" id="cv2-num">—</div>
        <div class="cv2-sub" id="cv2-sub"></div>
      </div>
      ${onRaw ? '<button class="btn primary wide" id="cv2-use">Use raw grams</button>' : ''}
      <h3 class="cv2-q">What did you cook?</h3>
      <div class="chips-scroll">
        ${YIELD_CATS.map((c, i) => `<button class="chip ${cvState.cat === i ? 'on' : ''}" data-cat="${i}">${esc(c.name)}</button>`).join('')}
        <button class="chip ${cvState.cat === 'custom' ? 'on' : ''}" data-cat="custom">Custom</button>
      </div>
      ${cvState.cat === 'custom' ? `
        <div class="cv2-custom">
          <label>Weight lost in cooking (%)
            <input class="input" id="cv2-lost" type="number" inputmode="decimal" step="any" min="0" max="99" value="${esc(cvState.customLost)}">
          </label>
          <p class="hint">Weigh a batch raw and again cooked to find your number: lost % = (1 − cooked ÷ raw) × 100.</p>
        </div>` : `
        <div class="cv2-items">
          ${YIELD_CATS[cvState.cat].items.map((it, i) => `
            <div class="cv2-item ${cvState.item === i ? 'sel' : ''}" data-i="${i}">
              <span>${esc(it.name)}</span><span class="cv2-pct">${cvItemLabel(it)}</span>
            </div>`).join('')}
        </div>
        ${YIELD_CATS[cvState.cat].note ? `<p class="hint tiny">${esc(YIELD_CATS[cvState.cat].note)}</p>` : ''}`}
      <p class="hint tiny">Meat &amp; poultry factors are from the USDA Table of Cooking Yields. ≈ marks typical values where USDA has no measurement.</p>`;

    const weightEl = root.querySelector('#cv2-weight');
    weightEl.value = cvState.weight;
    weightEl.oninput = e => { cvState.weight = e.target.value; update(); };
    root.querySelectorAll('.cv2-units button').forEach(b => b.onclick = () => {
      cvState.unit = b.dataset.u; render();
    });
    root.querySelectorAll('.chips-scroll .chip').forEach(b => b.onclick = () => {
      const c = b.dataset.cat;
      const next = c === 'custom' ? 'custom' : +c;
      if (next !== cvState.cat) { cvState.cat = next; cvState.item = null; }
      render();
    });
    root.querySelectorAll('.cv2-item').forEach(r => r.onclick = () => {
      cvState.item = +r.dataset.i; render();
    });
    const lostEl = root.querySelector('#cv2-lost');
    if (lostEl) lostEl.oninput = e => { cvState.customLost = e.target.value; update(); };
    const useBtn = root.querySelector('#cv2-use');
    if (useBtn) useBtn.onclick = () => {
      const raw = compute();
      if (raw == null) { toast('Enter a weight and pick what you cooked'); return; }
      onRaw(raw);
    };
    update();
  };

  render();
}

function renderConverter() {
  buildConverter(document.getElementById('screen-convert'));
}

// modal version used from the recipe builder; cb receives the RAW grams
function converterModal(cb) {
  const { el, close } = openSheet('<div class="cv2-sheet"></div>', { full: true });
  buildConverter(el.querySelector('.cv2-sheet'), { onRaw: raw => { close(); cb(raw); } });
}

// ---------------------------------------------------------------- settings

function renderSettings() {
  const scr = document.getElementById('screen-settings');
  const T = settings.targets;
  scr.innerHTML = `
    <h2>Settings</h2>
    <div class="card">
      <h4>Daily targets</h4>
      <div class="grid2">
        <label>Calories (kcal)<input class="input" id="st-kcal" type="number" value="${T.kcal}"></label>
        <label>Protein (g)<input class="input" id="st-protein" type="number" value="${T.protein}"></label>
        <label>Carbs (g)<input class="input" id="st-carbs" type="number" value="${T.carbs}"></label>
        <label>Fat (g)<input class="input" id="st-fat" type="number" value="${T.fat}"></label>
      </div>
    </div>
    <div class="card">
      <h4>Meal groups</h4>
      <label class="row-label"><input type="checkbox" id="st-groups" ${settings.groupsEnabled ? 'checked' : ''}> Group the diary into Breakfast / Lunch / Dinner / Snacks</label>
    </div>
    <div class="card">
      <h4>USDA FoodData Central</h4>
      <p class="hint">Used for generic foods (chicken breast, rice). Free key at fdc.nal.usda.gov/api-key-signup — without one, the shared DEMO_KEY works but rate-limits.</p>
      <label>API key<input class="input" id="st-usda" value="${esc(settings.usdaKey)}" placeholder="DEMO_KEY (default)"></label>
    </div>
    <div class="card">
      <h4>Label photo reading (Claude)</h4>
      <p class="hint">The 🏷 Label photo button reads a nutrition facts label from your camera roll and fills the food in for you. Uses your own Claude API key (console.anthropic.com → API Keys, ~a cent per label, billed to your account). The key is stored only on this device.</p>
      <label>Claude API key<input class="input" id="st-claude" value="${esc(settings.anthropicKey || '')}" placeholder="sk-ant-…"></label>
      <label>Workspace ID (only if the app asks for it)<input class="input" id="st-claude-ws" value="${esc(settings.anthropicWorkspace || '')}" placeholder="wrkspc_…"></label>
    </div>
    <div class="card">
      <h4>Restaurant menus (Nutritionix)</h4>
      <p class="hint">Official menu numbers for 800+ chains — a Big Mac shows 580, straight from McDonald's published data. Sign up free at developer.nutritionix.com, then paste both values. Also used as a barcode-lookup backup.</p>
      <label>Application ID<input class="input" id="st-nix-id" value="${esc(settings.nutritionix?.id || '')}"></label>
      <label>Application Key<input class="input" id="st-nix-key" value="${esc(settings.nutritionix?.key || '')}"></label>
    </div>
    <button class="btn primary wide" id="st-save">Save settings</button>
    <div class="card">
      <h4>App version</h4>
      <p class="hint">App ${APP_VERSION} · <span id="st-sw">checking cache…</span></p>
      <button class="btn wide" id="st-update">↻ Check for updates</button>
    </div>
    <div class="card">
      <h4>Pi backup</h4>
      <p class="hint">Everything backs up to the Raspberry Pi automatically whenever the phone can reach it over Tailscale (a minute after any change, and on every app open). The Pi keeps the last 30 copies.</p>
      <label class="row-label"><input type="checkbox" id="st-pib" ${settings.piBackup !== false ? 'checked' : ''}> Auto-backup to the Pi</label>
      <p class="hint" id="st-pib-status">checking…</p>
      <div class="row gap">
        <button class="btn small" id="st-pib-now">⬆ Back up now</button>
        <button class="btn small" id="st-pib-restore">⬇ Restore from Pi</button>
      </div>
    </div>
    <div class="card">
      <h4>Backup file</h4>
      <p class="hint">Manual export/import as a file — works anywhere, no Tailscale needed.</p>
      <button class="btn wide" id="st-export">⬇ Export all data to JSON</button>
      <label class="btn wide file-btn">⬆ Import from JSON<input type="file" id="st-import" accept=".json,application/json" hidden></label>
      <label class="row-label"><input type="checkbox" id="st-replace"> Replace everything on import (unchecked = merge)</label>
      <div class="hint" id="st-stats"></div>
    </div>`;

  DB.all('log').then(log => {
    scr.querySelector('#st-stats').textContent =
      `${foods.length} foods (${foods.filter(f => f.source === 'recipe').length} recipes) · ${log.length} log entries`;
  });

  if ('caches' in window) {
    caches.keys().then(keys => {
      const v = keys.find(k => k.startsWith('ct-'));
      const el = scr.querySelector('#st-sw');
      if (el) el.textContent = v ? 'cached ' + v : 'not cached yet';
    }).catch(() => {});
  }
  DB.getSetting('piBackupInfo').then(info => {
    const el = scr.querySelector('#st-pib-status');
    if (el) el.textContent = info ? `Last backup: ${new Date(info.ts).toLocaleString()} (${info.file})` : 'No Pi backup yet';
  });
  scr.querySelector('#st-pib-now').onclick = () => piBackupNow(true).then(ok => { if (ok) renderSettings(); });
  scr.querySelector('#st-pib-restore').onclick = async () => {
    let r;
    try {
      const resp = await fetch(PI_URL + '/api/calorie/backup');
      r = await resp.json();
    } catch (e) {
      alert('Could not reach the Pi — is Tailscale on?');
      return;
    }
    if (!r.ok) { alert('Restore failed: ' + (r.error || '?')); return; }
    if (!r.backup) { alert('No backup on the Pi yet.'); return; }
    if (!confirm(`Replace EVERYTHING on this phone with the Pi backup (${r.file})? This cannot be undone.`)) return;
    await DB.importAll(r.backup, { replace: true });
    const saved = await DB.getSetting('settings');
    if (saved) settings = { ...settings, ...saved, targets: { ...settings.targets, ...(saved.targets || {}) } };
    await refreshFoods();
    toast('Restored from the Pi');
    renderSettings();
  };

  scr.querySelector('#st-update').onclick = async () => {
    toast('Checking for updates…');
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) { toast('Not installed as an app yet — just reload the page'); return; }
      await reg.update();
      if (reg.installing || reg.waiting) toast('Update found — installing. The app will refresh itself in a moment.');
      else toast('You are on the latest version');
    } catch (e) {
      toast('Update check failed — are you online?');
    }
  };

  scr.querySelector('#st-save').onclick = async () => {
    settings.targets = {
      kcal: parseFloat(scr.querySelector('#st-kcal').value) || 0,
      protein: parseFloat(scr.querySelector('#st-protein').value) || 0,
      carbs: parseFloat(scr.querySelector('#st-carbs').value) || 0,
      fat: parseFloat(scr.querySelector('#st-fat').value) || 0,
    };
    settings.groupsEnabled = scr.querySelector('#st-groups').checked;
    settings.piBackup = scr.querySelector('#st-pib').checked;
    settings.usdaKey = scr.querySelector('#st-usda').value.trim();
    settings.nutritionix = {
      id: scr.querySelector('#st-nix-id').value.trim(),
      key: scr.querySelector('#st-nix-key').value.trim(),
    };
    settings.anthropicKey = scr.querySelector('#st-claude').value.trim();
    settings.anthropicWorkspace = scr.querySelector('#st-claude-ws').value.trim();
    await saveSettings();
    toast('Settings saved');
  };

  scr.querySelector('#st-export').onclick = async () => {
    const data = await DB.exportAll();
    const json = JSON.stringify(data, null, 1);
    const fname = `calorie-tracker-backup-${todayStr()}.json`;
    const file = new File([json], fname, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: fname }); return; } catch (e) { /* fall through */ }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = fname;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  scr.querySelector('#st-import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const replace = scr.querySelector('#st-replace').checked;
    try {
      const data = JSON.parse(await file.text());
      if (replace && !confirm('Replace ALL current data with this backup? This cannot be undone.')) return;
      const count = await DB.importAll(data, { replace });
      const saved = await DB.getSetting('settings');
      if (saved) settings = { ...settings, ...saved, targets: { ...settings.targets, ...(saved.targets || {}) } };
      await refreshFoods();
      toast(`Imported ${count} records`);
      renderSettings();
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
    e.target.value = '';
  };
}

// ---------------------------------------------------------------- go

window.__offToFood = offToFood; // debugging handle for verifying parser fixes

boot().catch(err => {
  document.body.insertAdjacentHTML('beforeend',
    `<div style="padding:16px;color:#f87171">App failed to start: ${esc(err.message)}</div>`);
  console.error(err);
});
