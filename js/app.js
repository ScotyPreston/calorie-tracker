import * as DB from './db.js';
import {
  NUTRIENTS, uuid, todayStr, addDays, fmtDateHuman,
  scale, sumLoose, sumStrict, macroKcal,
  f0, f1, fg, escapeHtml as esc,
} from './models.js';
import { YIELD_CATS } from './yields.js';
import { scanBarcode, stopScan } from './scanner.js';

// ---------------------------------------------------------------- state

let foods = [];
let foodsById = new Map();
let currentDate = todayStr();
let settings = {
  targets: { kcal: 2400, protein: 180, carbs: 240, fat: 80 },
  usdaKey: '',
  groupsEnabled: true,
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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline dev, fine */ });
  }
}

async function refreshFoods() {
  foods = await DB.all('foods');
  foodsById = new Map(foods.map(f => [f.id, f]));
}

async function saveSettings() { await DB.setSetting('settings', settings); }

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
      <button class="btn small" id="foods-usda">🔎 USDA</button>
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
  scr.querySelector('#foods-usda').onclick = () => usdaSearchSheet(food => openFoodDetail(food, { date: currentDate }));
  scr.querySelector('#foods-new').onclick = () => openFoodForm(null);
}

// food picker used by dashboard "+" and the recipe builder
function pickFood(onPick) {
  const { el, close } = openSheet(`
    <div class="sheet-head"><h3>Choose a food</h3><button class="icon-btn" data-close>✕</button></div>
    <div class="row gap">
      <button class="btn small" id="pf-scan">📷 Scan</button>
      <button class="btn small" id="pf-usda">🔎 USDA</button>
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
      food.favorite = !food.favorite;
      if (!food._unsaved) { await DB.put('foods', food); await refreshFoods(); }
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
    overlayBack.querySelector('#fd-log').onclick = async () => {
      const g = (parseFloat(amount) || 0) * serving.grams;
      if (g <= 0) { toast('Enter an amount first'); return; }
      const date = ctx.date || currentDate;
      const [hh, mm] = timeVal.split(':').map(Number);
      const [y, mo, d] = date.split('-').map(Number);
      const timestamp = new Date(y, mo - 1, d, hh || 0, mm || 0).toISOString();
      if (mode === 'edit-entry') {
        await DB.put('log', { ...entry, grams: g, amount: parseFloat(amount) || g, servingName: serving.name, group: settings.groupsEnabled ? group : null, timestamp });
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
}

// ---------------------------------------------------------------- manual food form

function openFoodForm(existing, { barcode = '', onSaved = null } = {}) {
  const isEdit = !!existing;
  const f = existing || {
    id: uuid(), name: '', barcode, source: 'manual',
    perGram: Object.fromEntries(NUTRIENTS.map(k => [k, null])),
    servings: [{ name: 'serving', grams: 100 }, { name: 'g', grams: 1 }],
    defaultServing: 'serving', defaultAmount: 1, favorite: false, lastUsed: null,
  };
  // basis serving for entering label values
  let basis = (f.servings || []).find(s => s.name !== 'g') || { name: 'g', grams: 100 };
  let basisGrams = isEdit ? basis.grams : basis.grams;

  const val = (k) => {
    if (!isEdit) return '';
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
  let code;
  try {
    code = await scanBarcode();
  } catch (err) {
    alert(err.message + '\n\nOn iPhone: Settings → Safari → Camera must be allowed, and the site must be HTTPS.');
    return;
  }
  if (!code) return;
  const food = await lookupBarcode(code);
  if (food) {
    if (onPick) onPick(food);
    else openFoodDetail(food, { date: currentDate });
  } else {
    if (confirm(`Barcode ${code} not found in Open Food Facts.\n\nEnter it manually from the nutrition label?`)) {
      openFoodForm(null, { barcode: code, onSaved: onPick || undefined });
    }
  }
}

// local database first (instant + offline), then cache, then Open Food Facts
async function lookupBarcode(code) {
  const local = await DB.byIndex('foods', 'barcode', code);
  if (local.length) return local[0];

  const cached = await DB.get('scanCache', code);
  if (cached) return { ...cached.food, id: uuid(), _unsaved: true };

  let data;
  try {
    const resp = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`);
    if (!resp.ok) return null;
    data = await resp.json();
  } catch (e) {
    toast('No connection — Open Food Facts lookup failed');
    return null;
  }
  if (!data || data.status !== 1 || !data.product) return null;
  const food = offToFood(data.product, code);
  if (!food) return null;
  await DB.put('scanCache', { barcode: code, food: { ...food, id: undefined }, cachedAt: new Date().toISOString() });
  return { ...food, _unsaved: true };
}

function offToFood(p, barcode) {
  const nu = p.nutriments || {};
  const g100 = (key) => {
    const v = nu[key];
    return (typeof v === 'number' && isFinite(v)) ? v / 100 : null;
  };
  let kcal = g100('energy-kcal_100g');
  if (kcal == null && typeof nu.energy_100g === 'number') kcal = (nu.energy_100g / 4.184) / 100; // kJ fallback
  const perGram = {
    kcal,
    protein: g100('proteins_100g'),
    carbs: g100('carbohydrates_100g'),
    fat: g100('fat_100g'),
    fiber: g100('fiber_100g'),
    sugar: g100('sugars_100g'),
    sodium: g100('sodium_100g') == null ? null : g100('sodium_100g') * 1000, // g→mg per gram
    satFat: g100('saturated-fat_100g'),
  };
  if (perGram.kcal == null) {
    // compute from macros if we can; otherwise this record is unusable
    if (perGram.protein != null || perGram.carbs != null || perGram.fat != null) {
      perGram.kcal = (perGram.protein ?? 0) * 4 + (perGram.carbs ?? 0) * 4 + (perGram.fat ?? 0) * 9;
    } else return null;
  }
  const servings = [];
  const sq = parseFloat(p.serving_quantity);
  if (sq > 0) {
    const label = (p.serving_size || '').trim();
    servings.push({ name: label && !/^\d/.test(label) ? label : 'serving' + (label ? ` (${label})` : ''), grams: sq });
  }
  servings.push({ name: 'oz', grams: 28.35 });
  servings.push({ name: 'g', grams: 1 });
  const name = [p.product_name, p.brands ? `(${p.brands.split(',')[0].trim()})` : ''].filter(Boolean).join(' ').trim() || `Product ${barcode}`;
  return {
    id: uuid(), name, barcode, source: 'openfoodfacts', perGram, servings,
    defaultServing: servings[0].name, defaultAmount: sq > 0 ? 1 : 100,
    favorite: false, lastUsed: null,
  };
}

// ---------------------------------------------------------------- USDA search

function usdaSearchSheet(onPick) {
  const { el, close } = openSheet(`
    <div class="sheet-head"><h3>USDA search</h3><button class="icon-btn" data-close>✕</button></div>
    <p class="hint">Good for generic foods (chicken breast, rice) that aren't in Open Food Facts.${settings.usdaKey ? '' : ' Using the shared DEMO_KEY — add your own free key in Settings if you hit rate limits.'}</p>
    <div class="row gap">
      <input class="input grow" id="us-q" placeholder="e.g. chicken breast raw">
      <button class="btn" id="us-go">Search</button>
    </div>
    <div class="list" id="us-list"></div>`, { full: true });

  const run = async () => {
    const q = el.querySelector('#us-q').value.trim();
    if (!q) return;
    el.querySelector('#us-list').innerHTML = '<div class="empty-line">Searching…</div>';
    const key = settings.usdaKey || 'DEMO_KEY';
    let data;
    try {
      const resp = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(q)}&pageSize=25&dataType=Foundation,SR%20Legacy,Branded`);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      data = await resp.json();
    } catch (e) {
      el.querySelector('#us-list').innerHTML = `<div class="empty-line">Search failed (${esc(e.message)}). Check connection or API key in Settings.</div>`;
      return;
    }
    const results = (data.foods || []).filter(x => x.foodNutrients?.length);
    el.querySelector('#us-list').innerHTML = results.map((r, i) => `
      <div class="food-row" data-i="${i}">
        <div class="food-main"><div class="food-name">${esc(r.description)}</div>
        <div class="food-sub">${esc(r.dataType)}${r.brandOwner ? ' · ' + esc(r.brandOwner) : ''}</div></div>
      </div>`).join('') || '<div class="empty-line">No results.</div>';
    el.querySelectorAll('.food-row').forEach(row => row.onclick = () => {
      const food = usdaToFood(results[+row.dataset.i]);
      if (!food) { toast('That record has no usable nutrition data'); return; }
      close();
      onPick(food);
    });
  };
  el.querySelector('#us-go').onclick = run;
  el.querySelector('#us-q').onkeydown = e => { if (e.key === 'Enter') run(); };
  setTimeout(() => el.querySelector('#us-q').focus(), 50);
}

function usdaToFood(r) {
  // search results report nutrients per 100 g
  const byId = {};
  for (const n of r.foodNutrients || []) byId[n.nutrientId] = n.value;
  const per100 = (id) => (typeof byId[id] === 'number') ? byId[id] / 100 : null;
  const perGram = {
    kcal: per100(1008),
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
  const servings = [];
  if (r.servingSize > 0 && /^(g|grm|gram)/i.test(r.servingSizeUnit || '')) {
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

function computeRecipe(ingredients) {
  const names = ingredients.map(i => i.name);
  const rows = ingredients.map(i => {
    const f = foodsById.get(i.foodId);
    return f ? scale(f.perGram, +i.grams || 0) : Object.fromEntries(NUTRIENTS.map(k => [k, null]));
  });
  const { totals, missing } = sumStrict(rows, names);
  const rawTotal = ingredients.reduce((s, i) => s + (+i.grams || 0), 0);
  return { totals, missing, rawTotal, rows };
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
    cookedTotalGrams: existing.cookedTotalGrams,
    customServings: (existing.servings || []).filter(s => !/^(whole batch|1\/2 batch|1\/4 batch|g|oz)$/.test(s.name)).map(s => ({ ...s })),
    favorite: existing.favorite, lastUsed: existing.lastUsed,
    defaultServing: existing.defaultServing, defaultAmount: existing.defaultAmount,
  } : {
    id: uuid(), name: '', ingredients: [], cookedTotalGrams: null, customServings: [],
    favorite: false, lastUsed: null, defaultServing: null, defaultAmount: 1,
  };
  navTo('recipeEdit');
  renderRecipeBuilder();
}

function renderRecipeBuilder() {
  const scr = document.getElementById('screen-recipeEdit');
  const { totals, missing, rawTotal } = computeRecipe(draft.ingredients);
  const basis = draft.cookedTotalGrams || rawTotal; // cooked basis once known, raw until then
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
    <p class="hint">Weigh ingredients <b>raw</b> (g; for liquids use ml ≈ g). If you weighed one cooked, tap ⇄ to convert. Macros come from raw weights; portions come from the cooked batch weight at save time.</p>
    ${draft.cookedTotalGrams ? `<label>Cooked batch weight (g)<input class="input" id="rb-cooked" type="number" step="any" value="${draft.cookedTotalGrams}"></label>` : ''}
    <div class="recipe-footer card">
      <div class="rf-line big"><span>Total</span><span><b>${fg(rawTotal)} g</b> · <b>${f0(totals.kcal)}</b> kcal</span></div>
      <div class="rf-line"><span>Per 100g ${draft.cookedTotalGrams ? 'cooked' : '(raw — enter cooked weight at save)'}</span>
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
    row.querySelector('.ing-convert').onclick = () => converterModal(raw => {
      draft.ingredients[i].grams = Math.round(raw * 10) / 10;
      renderRecipeBuilder();
    });
  });

  const addIngredient = (food) => {
    if (!food) return;
    const finish = async (f) => {
      gramsPrompt(f, grams => {
        draft.ingredients.push({ foodId: f.id, name: f.name, grams });
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
  const { totals, missing, rawTotal } = computeRecipe(draft.ingredients);
  if (totals.kcal == null) { toast('An ingredient has no calorie data — fix it before saving'); return; }

  const { el, close } = openSheet(`
    <div class="sheet-head"><h3>Cooked batch weight</h3><button class="icon-btn" data-close>✕</button></div>
    <p class="hint">Weigh the finished batch and enter it here. Macros were computed from the <b>raw</b> ingredients (${fg(rawTotal)}g); portioning uses the <b>cooked</b> weight. This can't be skipped.</p>
    <label>Cooked weight (g)*<input class="input" id="sr-cooked" type="number" inputmode="decimal" step="any" min="1" value="${draft.cookedTotalGrams || ''}" placeholder="e.g. 1240"></label>
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
    const cookedG = parseFloat(el.querySelector('#sr-cooked').value);
    if (!cookedG || cookedG <= 0) { toast('Cooked weight is required'); return; }
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
      missingNutrients: missing,
    };
    await DB.put('foods', recipe);
    await refreshFoods();
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
    <button class="btn primary wide" id="st-save">Save settings</button>
    <div class="card">
      <h4>Backup</h4>
      <p class="hint">All data lives on this device only. iOS can evict site storage — export regularly.</p>
      <button class="btn wide" id="st-export">⬇ Export all data to JSON</button>
      <label class="btn wide file-btn">⬆ Import from JSON<input type="file" id="st-import" accept=".json,application/json" hidden></label>
      <label class="row-label"><input type="checkbox" id="st-replace"> Replace everything on import (unchecked = merge)</label>
      <div class="hint" id="st-stats"></div>
    </div>`;

  DB.all('log').then(log => {
    scr.querySelector('#st-stats').textContent =
      `${foods.length} foods (${foods.filter(f => f.source === 'recipe').length} recipes) · ${log.length} log entries`;
  });

  scr.querySelector('#st-save').onclick = async () => {
    settings.targets = {
      kcal: parseFloat(scr.querySelector('#st-kcal').value) || 0,
      protein: parseFloat(scr.querySelector('#st-protein').value) || 0,
      carbs: parseFloat(scr.querySelector('#st-carbs').value) || 0,
      fat: parseFloat(scr.querySelector('#st-fat').value) || 0,
    };
    settings.groupsEnabled = scr.querySelector('#st-groups').checked;
    settings.usdaKey = scr.querySelector('#st-usda').value.trim();
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

boot().catch(err => {
  document.body.insertAdjacentHTML('beforeend',
    `<div style="padding:16px;color:#f87171">App failed to start: ${esc(err.message)}</div>`);
  console.error(err);
});
