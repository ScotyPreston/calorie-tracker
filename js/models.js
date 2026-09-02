// Core data helpers. Every food stores nutrition PER 1 GRAM.
// Nutrients with no data are null, never 0 — null must display as a dash.

export const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium', 'satFat'];

export const NUTRIENT_LABELS = {
  kcal: 'Calories', protein: 'Protein', carbs: 'Carbs', fat: 'Fat',
  fiber: 'Fiber', sugar: 'Sugar', sodium: 'Sodium', satFat: 'Sat. Fat',
};

export function uuid() {
  return (crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---- Dates (always the user's local timezone, never UTC) ----

export function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function todayStr() { return localDateStr(new Date()); }

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDateStr(new Date(y, m - 1, d + n));
}

export function fmtDateHuman(dateStr) {
  const t = todayStr();
  if (dateStr === t) return 'Today';
  if (dateStr === addDays(t, -1)) return 'Yesterday';
  if (dateStr === addDays(t, 1)) return 'Tomorrow';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// ---- Nutrition math ----

// perGram * grams, nulls propagate
export function scale(perGram, grams) {
  const out = {};
  for (const k of NUTRIENTS) {
    const v = perGram ? perGram[k] : null;
    out[k] = (v == null) ? null : v * grams;
  }
  return out;
}

// Loose sum for the daily dashboard: nulls are skipped (unknown ≠ zero, but
// the day total still shows what we do know). All-null stays null.
export function sumLoose(list) {
  const out = {};
  for (const k of NUTRIENTS) {
    let s = null;
    for (const n of list) {
      if (n[k] != null) s = (s ?? 0) + n[k];
    }
    out[k] = s;
  }
  return out;
}

// Strict sum for recipes/labels: if ANY item is missing a nutrient, the total
// for that nutrient is null and we record which items were incomplete.
// Never sum around a missing value and present it as fact.
export function sumStrict(list, names) {
  const totals = {}, missing = {};
  for (const k of NUTRIENTS) {
    let s = 0;
    const miss = [];
    for (let i = 0; i < list.length; i++) {
      const v = list[i][k];
      if (v == null) miss.push(names[i]); else s += v;
    }
    if (miss.length) { totals[k] = null; missing[k] = miss; }
    else totals[k] = list.length ? s : null;
  }
  return { totals, missing };
}

// Calories are always CALCULATED from macros (4/4/9), never stored per-macro.
export function macroKcal(n) {
  return {
    protein: n.protein == null ? null : n.protein * 4,
    carbs: n.carbs == null ? null : n.carbs * 4,
    fat: n.fat == null ? null : n.fat * 9,
  };
}

// Label sanity: stated calories vs calories computed from the macros (4/4/9).
// A big disagreement almost always means per-SERVING numbers landed in the
// per-100g fields (the import poisoning that halved the eggs' protein).
// Only runs when all three macros are present — partial data isn't evidence.
export function labelLooksOff(perGram) {
  if (!perGram || perGram.kcal == null) return false;
  if (perGram.protein == null || perGram.carbs == null || perGram.fat == null) return false;
  const fromMacros = perGram.protein * 4 + perGram.carbs * 4 + perGram.fat * 9;
  if (perGram.kcal < 0.15 && fromMacros < 0.15) return false; // near-zero foods: rounding noise
  return Math.abs(perGram.kcal - fromMacros) / Math.max(perGram.kcal, fromMacros) > 0.35;
}

// ---- Formatting ----

export function f1(n) { return n == null ? '—' : (Math.round(n * 10) / 10).toFixed(1); }
export function f0(n) { return n == null ? '—' : String(Math.round(n)); }

// grams etc: up to 1 decimal, trailing .0 trimmed
export function fg(n) {
  if (n == null) return '—';
  const r = Math.round(n * 10) / 10;
  return (r % 1 === 0) ? String(r) : r.toFixed(1);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
