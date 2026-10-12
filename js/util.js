// Small helpers: DOM building, ids, number and date formatting.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// Accepts "7,5" or "7.5"; returns null when empty/invalid.
export function parseNum(s) {
  if (s == null) return null;
  const v = parseFloat(String(s).trim().replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

export function fmtW(w) {
  if (w == null || !Number.isFinite(w)) return '–';
  return String(Math.round(w * 100) / 100);
}

export function fmtSet(s) {
  return `${s.reps} × ${fmtW(s.weight)} kg`;
}

const dfShort = new Intl.DateTimeFormat('it-CH', { weekday: 'short', day: 'numeric', month: 'short' });
const dfLong = new Intl.DateTimeFormat('it-CH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const fmtDate = (ts) => dfShort.format(new Date(ts));
export const fmtDateLong = (ts) => dfLong.format(new Date(ts));

export function daysSince(ts) {
  if (!ts) return Infinity;
  return Math.floor((Date.now() - ts) / 86400000);
}

export function relDays(ts) {
  const d = daysSince(ts);
  if (d === Infinity) return 'mai';
  if (d === 0) return 'oggi';
  if (d === 1) return 'ieri';
  return `${d} giorni fa`;
}

export function byName(a, b) {
  return a.name.localeCompare(b.name, 'it', { sensitivity: 'base' });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
