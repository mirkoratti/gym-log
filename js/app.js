import { h, uid, parseNum, fmtW, fmtSet, fmtDate, fmtDateLong, relDays, daysSince, downloadBlob, stamp } from './util.js';
import * as D from './db.js';
import { lineChart } from './chart.js';

const { S } = D;
export const APP_VERSION = '1.5.1';
const app = document.getElementById('app');
const BACKUP_WARN_DAYS = 7;
const DEFAULT_EX = { repMin: 6, repMax: 8, increment: 2.5 };

let persisted = null;      // result of navigator.storage.persist()
let draft = null;          // values in the set editor of the session screen
let historyTab = 'sessioni';
let chartMetric = 'e1rm';
let chartRange = 'all';
let progOpen = false;      // progression hint expanded in the session screen
try { progOpen = localStorage.getItem('gymlog.progOpen') === '1'; } catch { /* storage unavailable */ }

// Inline SVG icons (stroke = currentColor)
const ICONS = {
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
  timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 2M9.5 2.5h5"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  total: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12h4"/>',
};
function icon(name, size = 22) {
  const t = document.createElement('template');
  t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return t.content.firstChild;
}

// ============================================================ UI helpers

let toastTimer;
function toast(msg, action, ms = 2600) {
  const el = document.getElementById('toast');
  el.replaceChildren(msg);
  if (action) {
    el.append(h('button', { onclick: () => { el.hidden = true; action.fn(); } }, action.label));
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function sheet(build) {
  const backdrop = h('div', { class: 'backdrop' });
  const box = h('div', { class: 'sheet', role: 'dialog' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  box.append(...[build(close)].flat(Infinity).filter((x) => x != null && x !== false));
  backdrop.append(box);
  document.body.append(backdrop);
  return close;
}

function seg(options, value, onChange, cls = '') {
  return h('div', { class: `seg ${cls}` }, options.map((o) =>
    h('button', { class: `${o.value === value ? 'on' : ''} ${o.cls || ''}`, onclick: () => onChange(o.value) }, o.label)));
}

function currentGymId() {
  const id = S.meta.currentGymId;
  if (id && S.gyms.has(id)) return id;
  return D.gyms()[0]?.id ?? null;
}

function gymSeg() {
  const list = D.gyms();
  if (list.length < 2) return null;
  return h('div', { style: 'margin-bottom:14px' }, seg(
    list.map((g) => ({ value: g.id, label: g.name })), currentGymId(),
    async (id) => { await D.setMeta('currentGymId', id); render(); },
  ));
}

const activeSession = () => S.sessions.get(S.meta.activeSessionId) || null;
const exName = (id) => S.exercises.get(id)?.name ?? 'Esercizio eliminato';
const workSets = (sets) => sets.filter((s) => s.kind !== 'warmup');
const volume = (sets) => workSets(sets).reduce((acc, s) => acc + (s.weight || 0) * s.reps, 0);

// s may be null for a planned set that has no counterpart last time ("nuova").
function setRow(s, i, { target = false, onTap = null, sugg = null, role = null, extra = false } = {}) {
  const kind = s?.kind ?? sugg?.kind;
  const showSugg = sugg && sugg.kind === 'work' && sugg.action !== 'same';
  const pill = kind === 'warmup' ? h('span', { class: 'pill warm' }, 'Avv')
    : role === 'top' ? h('span', { class: 'pill role-top' }, 'Top')
    : role === 'backoff' ? h('span', { class: 'pill role-bo' }, 'B-off') : null;
  return h('li', { class: `${kind === 'warmup' ? 'warm' : ''} ${target ? 'target' : ''} ${onTap ? 'tap' : ''} ${extra ? 'extra' : ''}`, onclick: onTap },
    h('span', { class: 'n' }, i + 1),
    pill,
    s ? h('span', { class: 'v' }, fmtSet(s)) : h('span', { class: 'v new' }, 'nuova'),
    s?.note || showSugg || extra ? h('span', { class: 'right' },
      showSugg ? h('span', { class: `sugg ${sugg.action}` }, `→ ${fmtSet(sugg)}`) : null,
      extra ? h('span', { class: 'note muted' }, 'extra') : null,
      s?.note ? h('span', { class: 'note' }, s.note) : null) : null);
}

// Role of each set: null (warm-up or straight sets), 'top' or 'backoff'.
// Derived from position: the first working set is the top set, the following ones are back-offs.
function rolesOf(ex, sets) {
  if (!isTB(ex)) return sets.map(() => null);
  let seenTop = false;
  return sets.map((s) => {
    if (s.kind === 'warmup') return null;
    if (!seenTop) { seenTop = true; return 'top'; }
    return 'backoff';
  });
}

// Rows of the "last time" list, laid out along the plan for today.
function planRows(ex, sugg, lastSets, target = -1) {
  if (!sugg) {
    const roles = rolesOf(ex, lastSets);
    return lastSets.map((s, i) => setRow(s, i, { target: i === target, role: roles[i] }));
  }
  const rows = sugg.map((p, i) => setRow(p.from, i, { target: i === target, sugg: p, role: p.role }));
  const used = new Set(sugg.map((p) => p.from).filter(Boolean));
  const roles = rolesOf(ex, lastSets);
  lastSets.forEach((s, k) => {
    if (!used.has(s)) rows.push(setRow(s, rows.length, { role: roles[k], extra: true }));
  });
  return rows;
}

// ============================================================ Progression (double progression)
// For each working set, compared with the set in the same position last time:
//   reps >= max of range  -> +increment kg, back to min reps
//   reps <  min of range  -> same weight, aim for min reps
//   otherwise             -> same weight, +1 rep
// Warm-up sets are repeated as they were.

// Top set + back-off ("topBackoff"): the first working set follows the rule above on the
// exercise range; back-offs take the weight of TODAY's top set (or the suggested one) minus
// backoff.pct %, rounded to the increment, with their own rep range.

const BACKOFF_DEFAULT = { pct: 10, sets: 2, repMin: 8, repMax: 10 };
const isTB = (ex) => ex?.scheme === 'topBackoff';
const backoffOf = (ex) => ({ ...BACKOFF_DEFAULT, ...(ex.backoff || {}) });
const r2 = (w) => Math.round(w * 100) / 100;
// Nearest multiple of step, halves rounded up.
const roundTo = (w, step) => (step > 0 ? r2(Math.floor(w / step + 0.5 + 1e-9) * step) : r2(w));
const sameW = (a, b) => Math.abs(a - b) < 1e-6;

function straightStep(s, min, max, inc) {
  if (s.reps >= max) return { kind: 'work', weight: r2(s.weight + inc), reps: min, action: 'up' };
  if (s.reps < min) return { kind: 'work', weight: s.weight, reps: min, action: 'hold' };
  return { kind: 'work', weight: s.weight, reps: s.reps + 1, action: 'rep' };
}

// Returns the plan for today: [{ kind, weight, reps, action, role, from }] where `from` is the
// set of last time it derives from (null for a new back-off). todaySets only matter for topBackoff.
function suggestFor(ex, lastSets, todaySets = []) {
  if (!lastSets?.length || ex.repMax == null) return null;
  const max = ex.repMax;
  const min = ex.repMin ?? max;
  const inc = ex.increment || DEFAULT_EX.increment;
  const warm = (s) => ({ kind: 'warmup', weight: s.weight, reps: s.reps, action: 'same', role: null, from: s });

  if (!isTB(ex)) {
    return lastSets.map((s) => (s.kind === 'warmup' ? warm(s) : { ...straightStep(s, min, max, inc), role: null, from: s }));
  }

  const lastWork = lastSets.filter((s) => s.kind !== 'warmup');
  if (!lastWork.length) return null;
  const bo = backoffOf(ex);
  const plan = lastSets.filter((s) => s.kind === 'warmup').map(warm);
  const top = { ...straightStep(lastWork[0], min, max, inc), role: 'top', from: lastWork[0] };
  plan.push(top);

  const todayTop = todaySets.find((s) => s.kind !== 'warmup');
  const topW = todayTop ? todayTop.weight : top.weight;
  const boW = roundTo(topW * (1 - bo.pct / 100), inc);
  const lastBo = lastWork.slice(1);
  for (let k = 0; k < bo.sets; k++) {
    const prev = lastBo[k] || null;
    let reps, action;
    if (prev && sameW(prev.weight, boW)) {
      reps = Math.min(prev.reps + 1, bo.repMax);
      action = reps > prev.reps ? 'rep' : 'hold';
    } else {
      reps = bo.repMin;
      action = !prev ? 'new' : boW > prev.weight ? 'up' : 'hold';
    }
    plan.push({ kind: 'work', weight: boW, reps, action, role: 'backoff', from: prev, base: topW, fromToday: !!todayTop });
  }
  return plan;
}

// Index in the plan of the set to do next.
function nextIndex(ex, sugg, today) {
  if (!sugg || !isTB(ex)) return today.length;
  const planned = sugg.filter((p) => p.kind === 'warmup').length;
  const work = today.filter((s) => s.kind !== 'warmup').length;
  return work === 0 ? Math.min(today.length, planned) : planned + work;
}

function isDone(ex, sugg, today, lastSets) {
  if (sugg && isTB(ex)) return today.filter((s) => s.kind !== 'warmup').length >= 1 + backoffOf(ex).sets;
  const planned = sugg ? sugg.length : lastSets.length;
  return planned > 0 && today.length >= planned;
}

function suggestionSummaryTB(ex, sugg) {
  const top = sugg.find((p) => p.role === 'top');
  const bos = sugg.filter((p) => p.role === 'backoff');
  if (!top) return null;
  const bo = backoffOf(ex);
  const max = ex.repMax, min = ex.repMin ?? ex.repMax, inc = fmtW(ex.increment || DEFAULT_EX.increment);
  const ic = { up: '↑', rep: '+1', hold: '=' }[top.action];
  const topTitle = top.action === 'up' ? `Top +${inc} kg → ${fmtW(top.weight)} × ${top.reps}` : `Top ${fmtW(top.weight)} × ${top.reps}`;
  const boTitle = bos.length ? ` · B-off ${fmtW(bos[0].weight)} × ${bos.map((b) => b.reps).join('/')}` : '';
  const topText = top.action === 'up'
    ? `Top: arrivata a ${max} ripetizioni (range ${min}–${max}), +${inc} kg e riparti da ${min}.`
    : top.action === 'rep'
      ? `Top: stesso peso, +1 ripetizione. A ${max} ripetizioni sali di ${inc} kg.`
      : `Top: sotto le ${min} ripetizioni, stesso peso con obiettivo ${min}.`;
  let boText = '';
  if (bos.length) {
    const b = bos[0];
    const changed = bos.some((x) => x.action === 'up' || x.action === 'new' || (x.from && !sameW(x.from.weight, x.weight)));
    boText = ` Back-off: −${fmtW(bo.pct)}% della top ${b.fromToday ? 'di oggi' : 'suggerita'} (${fmtW(b.base)} kg → ${fmtW(b.weight)} kg, arrotondato a ${inc} kg)`
      + (changed ? `, peso cambiato: riparti da ${bo.repMin} ripetizioni.` : `, stesso peso dell'ultima volta: +1 ripetizione (max ${bo.repMax}).`);
  }
  return { icon: ic, title: topTitle + boTitle, text: topText + boText };
}

function suggestionSummary(ex, sugg) {
  if (sugg && isTB(ex)) return suggestionSummaryTB(ex, sugg);
  const work = (sugg || []).filter((x) => x.kind === 'work');
  if (!work.length) return null;
  const n = (a) => work.filter((x) => x.action === a).length;
  const max = ex.repMax, min = ex.repMin ?? ex.repMax, inc = fmtW(ex.increment || DEFAULT_EX.increment);
  const range = `range ${min}–${max} rip`;
  if (n('up')) {
    const rest = n('rep') ? ' Nelle altre serie: stesso peso, +1 ripetizione.' : '';
    return { icon: '↑', title: `Aumenta il peso: +${inc} kg`, text: `${n('up')} ${n('up') === 1 ? 'serie è arrivata' : 'serie sono arrivate'} a ${max} ripetizioni (${range}): sali di ${inc} kg e riparti da ${min}.${rest}` };
  }
  if (n('rep')) {
    return { icon: '+1', title: 'Una ripetizione in più', text: `Nessuna serie ha raggiunto ${max} ripetizioni (${range}): stesso peso, +1 ripetizione per serie. Quando arrivi a ${max} sali di ${inc} kg.` };
  }
  return { icon: '=', title: 'Mantieni il peso', text: `Le serie erano sotto le ${min} ripetizioni (${range}): stesso peso, obiettivo ${min} ripetizioni.` };
}

function progressCard(ex, sugg, { collapsible = false } = {}) {
  const sum = suggestionSummary(ex, sugg);
  if (!sum) return null;
  if (!collapsible) {
    return h('div', { class: 'prog-card' },
      h('span', { class: 'prog-icon' }, sum.icon),
      h('div', { class: 'grow' }, h('b', null, sum.title), h('div', { class: 'small muted' }, sum.text)));
  }
  const card = h('button', {
    class: `prog-card collapsible ${progOpen ? 'open' : ''}`, 'aria-expanded': progOpen ? 'true' : 'false',
    onclick: () => {
      progOpen = !progOpen;
      try { localStorage.setItem('gymlog.progOpen', progOpen ? '1' : '0'); } catch { /* ignore */ }
      card.classList.toggle('open', progOpen);
      card.setAttribute('aria-expanded', progOpen ? 'true' : 'false');
      fitPanelPadding();
    },
  },
  h('span', { class: 'prog-icon' }, sum.icon),
  h('div', { class: 'grow' }, h('b', null, sum.title), h('div', { class: 'small muted prog-text' }, sum.text)),
  h('span', { class: 'prog-chev' }, icon('chevron', 20)));
  return card;
}

// ============================================================ Rest timer
// Counts up from the last set logged in the active session: logging a set resets it,
// undoing a set brings back the previous time. Derived from timestamps, so it survives
// app restarts and the phone being locked.

const REST_HIDE_AFTER = 30 * 60 * 1000;

function restStart(sess) {
  let last = 0;
  for (const s of S.sets.values()) if (s.sessionId === sess.id && s.ts > last) last = s.ts;
  return last;
}

function fmtClock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

// Tap toggles between rest time and total workout time; logging a set switches back to rest.
let timerMode = 'rest';

function fmtLong(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const hrs = Math.floor(t / 3600);
  return hrs ? `${hrs}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` : fmtClock(ms);
}

function restTimer(sess) {
  const el = h('button', {
    class: 'rest-timer', id: 'rest-timer', type: 'button',
    'data-rest': restStart(sess) || '', 'data-total': sess.startedAt,
    onclick: () => { timerMode = timerMode === 'rest' ? 'total' : 'rest'; updateRestTimer(el); },
  },
  h('span', { class: 'ico ico-rest' }, icon('timer', 18)),
  h('span', { class: 'ico ico-total' }, icon('total', 18)),
  h('span', { class: 'rest-lbl' }, ''),
  h('span', { class: 'rest-val' }, ''));
  updateRestTimer(el);
  return el;
}

function updateRestTimer(el = document.getElementById('rest-timer')) {
  if (!el) return;
  const now = Date.now();
  const rest = Number(el.dataset.rest);
  const restOk = rest > 0 && now - rest < REST_HIDE_AFTER;
  const mode = timerMode === 'total' || !restOk ? 'total' : 'rest';
  el.dataset.mode = mode;
  el.querySelector('.rest-lbl').textContent = mode === 'rest' ? 'rec' : 'tot';
  el.querySelector('.rest-val').textContent = mode === 'rest' ? fmtClock(now - rest) : fmtLong(now - Number(el.dataset.total));
  el.setAttribute('aria-label', mode === 'rest'
    ? 'Recupero dall\'ultima serie. Tocca per il tempo totale'
    : 'Tempo totale dell\'allenamento. Tocca per il recupero');
}

setInterval(() => updateRestTimer(), 500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateRestTimer(); });

// ============================================================ Screen wake lock
// Keeps the screen on while a workout is open (Safari 16.4+, Home Screen apps from iOS 18.4).
// The browser drops the lock when the app is hidden, so it is re-requested on return
// and on the next tap if a request was refused.

let wakeLock = null;
let wantWake = false;

async function requestWake() {
  if (!wantWake || wakeLock || document.hidden || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    if (!wantWake) { wakeLock.release().catch(() => {}); }
  } catch { wakeLock = null; }
}

function syncWakeLock(on) {
  wantWake = on;
  if (on) requestWake();
  else if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) requestWake(); });
document.addEventListener('pointerdown', () => { if (wantWake && !wakeLock) requestWake(); }, { passive: true });

function fitPanelPadding() {
  // Kept for callers; the session layout no longer needs extra padding under a fixed panel.
  app.style.paddingBottom = '';
}

// ============================================================ Router

const routes = [
  [/^#\/?$/, viewHome, 'home'],
  [/^#\/sessione$/, viewSession, 'session'],
  [/^#\/riepilogo\/(.+)$/, viewSummary, 'home'],
  [/^#\/storico$/, viewHistory, 'storico'],
  [/^#\/storico\/sessione\/(.+)$/, viewSessionDetail, 'storico'],
  [/^#\/storico\/esercizio\/(.+)$/, viewExercise, 'storico'],
  [/^#\/impostazioni$/, viewSettings, 'impostazioni'],
  [/^#\/impostazioni\/scheda\/(.+)$/, viewTemplateEdit, 'impostazioni'],
];

function render({ keepScroll = false } = {}) {
  const prevScroller = app.querySelector('.sess-scroll');
  const y = prevScroller ? prevScroller.scrollTop : window.scrollY;
  const atBottom = prevScroller && prevScroller.scrollTop >= prevScroller.scrollHeight - prevScroller.clientHeight - 4;
  const hash = location.hash || '#/';
  let view = viewHome, tab = 'home', args = [];
  for (const [re, fn, t] of routes) {
    const m = hash.match(re);
    if (m) { view = fn; tab = t; args = m.slice(1).map(decodeURIComponent); break; }
  }
  document.body.classList.toggle('in-session', tab === 'session');
  syncWakeLock(tab === 'session');
  for (const a of document.querySelectorAll('#tabbar a')) a.classList.toggle('active', a.dataset.tab === tab);
  const nodes = [view(...args)].flat(Infinity).filter(Boolean);
  if (tab === 'session') {
    // The session screen never scrolls the page: only the list area scrolls and the input
    // panel is a normal block at the bottom. Fixed elements in iOS Home Screen apps drift
    // when the page itself scrolls or bounces.
    const panel = nodes.find((n) => n.classList?.contains('panel'));
    const scroller = h('div', { class: 'sess-scroll' }, nodes.filter((n) => n !== panel));
    app.replaceChildren(scroller, ...(panel ? [panel] : []));
    // Stay pinned to the bottom if the list was scrolled all the way down (new sets appear there).
    scroller.scrollTop = !keepScroll ? 0 : atBottom ? scroller.scrollHeight : y;
  } else {
    app.replaceChildren(...nodes);
    window.scrollTo(0, keepScroll ? y : 0);
  }
  fitPanelPadding();
}

const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };

// ============================================================ Home

function viewHome() {
  if (D.isEmpty()) return viewWelcome();
  const gymId = currentGymId();
  const active = activeSession();
  const out = [h('h1', null, 'Allena'), gymSeg()];

  if (active) {
    out.push(h('div', { class: 'banner go' },
      h('div', { class: 'grow' }, h('b', null, 'Sessione in corso'), h('div', { class: 'small muted' },
        `${active.templateName} · iniziata alle ${new Date(active.startedAt).toLocaleTimeString('it-CH', { hour: '2-digit', minute: '2-digit' })}`)),
      h('button', { class: 'btn primary', onclick: () => go('#/sessione') }, 'Riprendi')));
  }

  const last = S.meta.lastBackupAt;
  if (S.sessions.size && daysSince(last) >= BACKUP_WARN_DAYS) {
    out.push(h('div', { class: 'banner warn' },
      h('div', { class: 'grow small' }, h('b', null, 'Backup: '), last ? `ultimo ${relDays(last)}` : 'non hai ancora fatto un backup'),
      h('button', { class: 'btn small', onclick: doBackup }, 'Backup ora')));
  }

  const tpls = D.templatesOf(gymId);
  if (!tpls.length) out.push(h('div', { class: 'empty-state' }, 'Nessuna scheda per questa palestra. Creane una in Impostazioni.'));
  for (const t of tpls) {
    const lastSess = D.sessionsSorted().find((s) => s.templateId === t.id && s.finishedAt);
    out.push(h('button', { class: 'template-btn', onclick: () => startSession(t) },
      h('span', null, t.name, h('small', null,
        `${t.items.length} esercizi · ${lastSess ? 'ultima ' + fmtDate(lastSess.startedAt) : 'mai fatta'}`)),
      h('span', { class: 'chev' })));
  }
  out.push(h('button', { class: 'btn ghost block', onclick: () => startSession(null) }, '+ Sessione libera'));
  return out;
}

function viewWelcome() {
  return [
    h('h1', null, 'Gym Log'),
    h('p', { class: 'muted' }, 'Registra peso e ripetizioni di ogni serie, vedi cosa hai fatto l\'ultima volta e tieni lo storico completo. I dati restano su questo telefono: fai un backup ogni tanto.'),
    h('div', { class: 'stack' },
      h('button', { class: 'btn primary big block', onclick: pickImportFile }, 'Importa un backup (.json)'),
      h('button', { class: 'btn big block', onclick: startFromScratch }, 'Inizia da zero')),
  ];
}

async function startFromScratch() {
  const gym = { id: uid(), name: 'Palestra', order: 0 };
  const ops = [{ store: 'gyms', put: gym }];
  ['Push', 'Pull', 'Legs'].forEach((name, i) => ops.push({ store: 'templates', put: { id: uid(), gymId: gym.id, name, order: i, items: [] } }));
  ops.push({ store: 'meta', put: { key: 'currentGymId', value: gym.id } });
  await D.write(ops);
  toast('Fatto. Aggiungi gli esercizi alle schede in Impostazioni.');
  render();
}

async function startSession(template) {
  const active = activeSession();
  if (active) {
    if (template && active.templateId === template.id) return go('#/sessione');
    if (!confirm(`Hai una sessione in corso (${active.templateName}). Terminarla e iniziarne una nuova?`)) return;
    await closeSession(active);
  }
  const sess = {
    id: uid(), gymId: currentGymId(), templateId: template?.id ?? null,
    templateName: template?.name ?? 'Sessione libera', startedAt: Date.now(), finishedAt: null,
    items: (template?.items ?? []).map((i) => ({ ...i })), cur: 0, note: '',
  };
  await D.write([{ store: 'sessions', put: sess }, { store: 'meta', put: { key: 'activeSessionId', value: sess.id } }]);
  draft = null;
  go('#/sessione');
}

// Finishes a session; deletes it if no sets were logged. Returns true if it was kept.
async function closeSession(sess, { saveToTemplate = false } = {}) {
  const sets = D.setsOf(sess.id);
  const ops = [{ store: 'meta', del: 'activeSessionId' }];
  if (!sets.length) {
    ops.push({ store: 'sessions', del: sess.id });
  } else {
    ops.push({ store: 'sessions', put: { ...sess, finishedAt: Date.now() } });
    const tpl = S.templates.get(sess.templateId);
    if (saveToTemplate && tpl) ops.push({ store: 'templates', put: { ...tpl, items: sess.items.map((i) => ({ ...i })) } });
  }
  await D.write(ops);
  return sets.length > 0;
}

// ============================================================ Session

function prefill(sess, ex, today, last, sugg) {
  const n = today.length;
  const ni = nextIndex(ex, sugg, today);
  if (sugg && sugg[ni]) {
    const s = sugg[ni];
    return { kind: s.kind, weight: s.weight, reps: s.reps };
  }
  if (!isTB(ex) && last && last.sets[n]) {
    const s = last.sets[n];
    return { kind: s.kind, weight: s.weight, reps: s.reps };
  }
  if (n) {
    const s = today[n - 1];
    return { kind: 'work', weight: s.weight, reps: s.reps };
  }
  return { kind: 'work', weight: null, reps: ex.repMax ?? DEFAULT_EX.repMax };
}

function viewSession() {
  const sess = activeSession();
  if (!sess) { setTimeout(() => go('#/'), 0); return h('div'); }

  const head = h('div', { class: 'sess-head' },
    h('span', { class: 'title grow' }, sess.templateName),
    restTimer(sess),
    h('button', { class: 'icon-btn', 'aria-label': 'Elenco esercizi', title: 'Elenco esercizi', onclick: () => openSessionList(sess) }, icon('list')),
    h('button', { class: 'btn small danger', onclick: () => openFinish(sess) }, 'Termina'));

  if (!sess.items.length) {
    return [head, h('div', { class: 'empty-state' },
      h('p', null, 'Nessun esercizio in questa sessione.'),
      h('button', { class: 'btn primary', onclick: () => addExerciseToSession(sess) }, '+ Aggiungi esercizio'))];
  }

  const idx = Math.min(Math.max(sess.cur || 0, 0), sess.items.length - 1);
  const item = sess.items[idx];
  const ex = S.exercises.get(item.exerciseId);
  if (!ex) return [head, h('div', { class: 'empty-state' }, 'Esercizio non trovato. Rimuovilo dall\'elenco.')];

  const today = D.setsOf(sess.id, ex.id);
  const last = D.lastTime(ex.id, sess.id);
  const sugg = suggestFor(ex, last?.sets, today);
  const key = `${sess.id}|${ex.id}|${today.length}`;
  if (!draft || draft.key !== key) draft = { key, ...prefill(sess, ex, today, last, sugg) };

  const lastSets = last?.sets ?? [];
  const done = isDone(ex, sugg, today, lastSets);
  const target = done ? -1 : nextIndex(ex, sugg, today);
  const todayRoles = rolesOf(ex, today);

  const content = [
    head,
    item.optional ? h('span', { class: 'opt-badge' }, 'Facoltativo') : null,
    h('button', { class: 'ex-name ex-name-btn', 'aria-label': `${ex.name}: opzioni esercizio`, onclick: () => openExerciseMenu(sess, idx) },
      h('span', null, ex.name), h('span', { class: 'ex-chev' }, icon('chevron', 22))),
    ex.setupNote ? h('button', { class: 'note-chip setup', onclick: () => editExercise(ex) }, '⚙︎ ', ex.setupNote) : null,
    ex.nextNote ? h('button', { class: 'note-chip next', onclick: () => editExercise(ex) }, '→ ', ex.nextNote) : null,
    !done ? progressCard(ex, sugg, { collapsible: true }) : null,
    h('h3', null, last ? `Ultima volta · ${fmtDate(last.session.startedAt)}` : 'Ultima volta'),
    lastSets.length
      ? h('ul', { class: 'sets' }, planRows(ex, sugg, lastSets, target))
      : h('div', { class: 'sets' }, h('div', { class: 'empty' }, 'Nessuno storico per questo esercizio.')),
    h('h3', null, 'Oggi'),
    today.length
      ? h('ul', { class: 'sets' }, today.map((s, i) => setRow(s, i, { onTap: () => editSet(s), role: todayRoles[i] })))
      : h('div', { class: 'sets' }, h('div', { class: 'empty' }, 'Nessuna serie ancora.')),
  ];

  return [...content, sessionPanel(sess, idx, ex, today, done)];
}

function sessionPanel(sess, idx, ex, today, done) {
  const inc = ex.increment || DEFAULT_EX.increment;
  const wInput = h('input', {
    type: 'text', inputmode: 'decimal', value: draft.weight == null ? '' : fmtW(draft.weight), placeholder: '0',
    'aria-label': 'Peso in kg', oninput: (e) => { draft.weight = parseNum(e.target.value); },
  });
  const rInput = h('input', {
    type: 'text', inputmode: 'numeric', value: draft.reps ?? '', placeholder: '0',
    'aria-label': 'Ripetizioni', oninput: (e) => { draft.reps = parseNum(e.target.value); },
  });
  const step = (field, delta, input) => {
    const cur = draft[field] ?? 0;
    const next = Math.max(0, Math.round((cur + delta) * 100) / 100);
    draft[field] = next;
    input.value = fmtW(next);
  };
  const isLast = idx >= sess.items.length - 1;
  const move = async (d) => {
    const n = idx + d;
    if (n < 0 || n >= sess.items.length) return;
    await D.put('sessions', { ...sess, cur: n });
    render();
  };

  return h('div', { class: 'panel' }, h('div', { class: 'panel-inner' },
    h('div', { class: 'nav' },
      h('button', { class: 'btn', disabled: idx === 0, 'aria-label': 'Esercizio precedente', onclick: () => move(-1) }, '‹'),
      seg([{ value: 'warmup', label: 'Avv.', cls: 'warm' }, { value: 'work', label: 'Lavoro', cls: 'work' }],
        draft.kind, (v) => { draft.kind = v; render({ keepScroll: true }); }, 'kind'),
      h('button', { class: 'btn', disabled: isLast, 'aria-label': 'Esercizio successivo', onclick: () => move(1) }, '›')),
    h('div', { class: 'stepper' },
      h('button', { onclick: () => step('weight', -inc, wInput), 'aria-label': `meno ${inc} kg` }, '−'),
      h('div', { class: 'field' }, wInput, h('span', { class: 'unit' }, 'kg')),
      h('button', { onclick: () => step('weight', inc, wInput), 'aria-label': `più ${inc} kg` }, '+')),
    h('div', { class: 'stepper' },
      h('button', { onclick: () => step('reps', -1, rInput), 'aria-label': 'meno una ripetizione' }, '−'),
      h('div', { class: 'field' }, rInput, h('span', { class: 'unit' }, 'rip')),
      h('button', { onclick: () => step('reps', 1, rInput), 'aria-label': 'più una ripetizione' }, '+')),
    done ? [
      h('button', { class: 'log-btn secondary', onclick: () => logSet(sess, ex) }, `+ Serie extra (${today.length + 1})`),
      isLast
        ? h('button', { class: 'log-btn', onclick: () => openFinish(sess) }, 'Termina allenamento ✓')
        : h('button', { class: 'log-btn next', onclick: () => move(1) },
          h('span', { class: 'next-label' }, sess.items[idx + 1].optional ? 'Prossimo · facoltativo' : 'Prossimo esercizio'), h('span', { class: 'next-name' }, exName(sess.items[idx + 1].exerciseId), ' ›')),
    ] : h('button', { class: 'log-btn', onclick: () => logSet(sess, ex) }, `✓ Registra serie ${today.length + 1}`),
  ));
}

async function logSet(sess, ex) {
  const reps = Math.round(draft.reps ?? 0);
  if (!(reps > 0)) return toast('Inserisci le ripetizioni');
  const set = {
    id: uid(), sessionId: sess.id, exerciseId: ex.id, kind: draft.kind,
    weight: draft.weight ?? 0, reps, note: '', ts: Date.now(),
  };
  await D.put('sets', set);
  draft = null;
  timerMode = 'rest';
  render({ keepScroll: true });
  toast(`Registrata: ${fmtSet(set)}`, { label: 'Annulla', fn: async () => { await D.del('sets', set.id); draft = null; render({ keepScroll: true }); } }, 4000);
}

function editSet(set) {
  let kind = set.kind;
  sheet((close) => {
    const w = h('input', { class: 'input', type: 'text', inputmode: 'decimal', value: fmtW(set.weight) });
    const r = h('input', { class: 'input', type: 'text', inputmode: 'numeric', value: set.reps });
    const n = h('input', { class: 'input', type: 'text', value: set.note || '', placeholder: 'es. dropset, cedimento, +1' });
    const kindBox = h('div');
    const drawKind = () => kindBox.replaceChildren(seg(
      [{ value: 'warmup', label: 'Avvicinamento', cls: 'warm' }, { value: 'work', label: 'Lavoro', cls: 'work' }],
      kind, (v) => { kind = v; drawKind(); }, 'kind'));
    drawKind();
    return [
      h('h2', null, `Modifica serie · ${exName(set.exerciseId)}`),
      kindBox,
      h('div', { class: 'grid2' },
        h('label', null, h('span', { class: 'field-label' }, 'Peso (kg)'), w),
        h('label', null, h('span', { class: 'field-label' }, 'Ripetizioni'), r)),
      h('label', null, h('span', { class: 'field-label' }, 'Nota'), n),
      h('div', { class: 'actions' },
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Eliminare questa serie?')) return;
          await D.del('sets', set.id); close(); draft = null; render({ keepScroll: true });
        } }, 'Elimina'),
        h('button', { class: 'btn primary', onclick: async () => {
          const reps = Math.round(parseNum(r.value) ?? 0);
          if (!(reps > 0)) return toast('Ripetizioni non valide');
          await D.put('sets', { ...set, kind, weight: parseNum(w.value) ?? 0, reps, note: n.value.trim() });
          close(); draft = null; render({ keepScroll: true });
        } }, 'Salva')),
    ];
  });
}

function openExerciseMenu(sess, idx) {
  const item = sess.items[idx];
  const ex = S.exercises.get(item.exerciseId);
  sheet((close) => [
    h('h2', null, ex.name),
    h('div', { class: 'stack' },
      h('button', { class: 'btn block', onclick: () => { close(); editExercise(ex); } }, 'Note, range e incremento'),
      h('button', { class: 'btn block', onclick: () => { close(); go(`#/storico/esercizio/${ex.id}`); } }, 'Storico completo'),
      h('button', { class: 'btn block', onclick: () => {
        close();
        pickExercise(sess.gymId, { exclude: sess.items.map((i) => i.exerciseId), title: `Sostituisci ${ex.name}` }, async (newId) => {
          const items = sess.items.map((it, i) => (i === idx ? { ...it, exerciseId: newId } : it));
          await D.put('sessions', { ...sess, items });
          draft = null; render();
        });
      } }, 'Sostituisci con un altro esercizio'),
      h('button', { class: 'btn danger block', onclick: () => { close(); removeFromSession(sess, idx); } }, 'Rimuovi da questa sessione')),
  ]);
}

async function removeFromSession(sess, idx) {
  const exId = sess.items[idx].exerciseId;
  const n = D.setsOf(sess.id, exId).length;
  const msg = n
    ? `${exName(exId)} ha ${n} serie registrate oggi. Rimuoverlo dall'elenco? Le serie restano nello storico.`
    : `Rimuovere ${exName(exId)} da questa sessione?`;
  if (!confirm(msg)) return;
  const items = sess.items.filter((_, i) => i !== idx);
  await D.put('sessions', { ...sess, items, cur: Math.min(sess.cur, Math.max(items.length - 1, 0)) });
  draft = null;
  render();
}

function addExerciseToSession(sess, after = null) {
  pickExercise(sess.gymId, { exclude: sess.items.map((i) => i.exerciseId), title: 'Aggiungi esercizio' }, async (exId) => {
    const fresh = S.sessions.get(sess.id);
    const items = [...fresh.items];
    const pos = after == null ? items.length : after + 1;
    items.splice(pos, 0, { exerciseId: exId, optional: false });
    await D.put('sessions', { ...fresh, items, cur: pos });
    draft = null;
    render();
  });
}

function openSessionList(sess0) {
  sheet((close) => {
    const box = h('div');
    const draw = () => {
      const sess = S.sessions.get(sess0.id);
      const moveItem = async (i, d) => {
        const items = [...sess.items];
        const j = i + d;
        if (j < 0 || j >= items.length) return;
        [items[i], items[j]] = [items[j], items[i]];
        let cur = sess.cur;
        if (cur === i) cur = j; else if (cur === j) cur = i;
        await D.put('sessions', { ...sess, items, cur });
        draw();
      };
      box.replaceChildren(
        h('h2', null, 'Esercizi della sessione'),
        h('p', { class: 'small muted' }, 'Tocca un esercizio per andarci. Usa le frecce per cambiare l\'ordine.'),
        h('ul', { class: 'list' }, sess.items.map((it, i) => {
          const n = D.setsOf(sess.id, it.exerciseId).length;
          return h('li', null,
            h('div', { class: 'grow', style: 'cursor:pointer', onclick: async () => {
              await D.put('sessions', { ...sess, cur: i }); close(); draft = null; render();
            } },
            h('div', { style: i === sess.cur ? 'font-weight:800;color:var(--accent)' : 'font-weight:600' }, exName(it.exerciseId)),
            h('div', { class: 'small muted' }, it.optional ? h('span', { class: 'pill opt', style: 'margin-right:6px' }, 'facoltativo') : null, n ? `${n} serie fatte` : 'da fare')),
            h('button', { class: 'icon-btn', disabled: i === 0, 'aria-label': 'Su', onclick: () => moveItem(i, -1) }, '↑'),
            h('button', { class: 'icon-btn', disabled: i === sess.items.length - 1, 'aria-label': 'Giù', onclick: () => moveItem(i, 1) }, '↓'));
        })),
        h('div', { class: 'stack', style: 'margin-top:14px' },
          h('button', { class: 'btn block', onclick: () => { close(); addExerciseToSession(sess, sess.cur); } }, '+ Aggiungi esercizio'),
          h('button', { class: 'btn danger block', onclick: async () => {
            const n = D.setsOf(sess.id).length;
            if (!confirm(n ? `Eliminare la sessione e le sue ${n} serie? Non si può annullare.` : 'Annullare questa sessione?')) return;
            const ops = D.setsOf(sess.id).map((s) => ({ store: 'sets', del: s.id }));
            ops.push({ store: 'sessions', del: sess.id }, { store: 'meta', del: 'activeSessionId' });
            await D.write(ops);
            close(); go('#/');
          } }, 'Elimina sessione')));
    };
    draw();
    return box;
  });
  // re-render the screen underneath when the sheet closes (order may have changed)
  const obs = new MutationObserver(() => {
    if (!document.querySelector('.backdrop')) { obs.disconnect(); draft = null; render({ keepScroll: true }); }
  });
  obs.observe(document.body, { childList: true });
}

function openFinish(sess) {
  const sets = D.setsOf(sess.id);
  const tpl = S.templates.get(sess.templateId);
  const orderChanged = tpl && JSON.stringify(tpl.items.map((i) => i.exerciseId)) !== JSON.stringify(sess.items.map((i) => i.exerciseId));
  let saveToTemplate = false;
  sheet((close) => [
    h('h2', null, 'Terminare la sessione?'),
    sets.length
      ? h('p', { class: 'muted' }, `${new Set(sets.map((s) => s.exerciseId)).size} esercizi · ${workSets(sets).length} serie di lavoro · ${Math.round(volume(sets))} kg di volume`)
      : h('p', { class: 'muted' }, 'Non hai registrato nessuna serie: la sessione verrà eliminata.'),
    orderChanged && sets.length ? h('label', { class: 'check' },
      h('input', { type: 'checkbox', onchange: (e) => { saveToTemplate = e.target.checked; } }),
      h('span', null, `Salva questo elenco e ordine nella scheda «${tpl.name}»`)) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: close }, 'Continua'),
      h('button', { class: 'btn primary', onclick: async () => {
        close();
        const kept = await closeSession(sess, { saveToTemplate });
        draft = null;
        go(kept ? `#/riepilogo/${sess.id}` : '#/');
      } }, 'Termina')),
  ]);
}

function viewSummary(id) {
  const sess = S.sessions.get(id);
  if (!sess) return viewHome();
  const sets = D.setsOf(id);
  const last = S.meta.lastBackupAt;
  return [
    h('h1', null, 'Sessione salvata'),
    h('p', { class: 'muted' }, `${sess.templateName} · ${fmtDateLong(sess.startedAt)}`),
    h('div', { class: 'stats' },
      h('div', { class: 'card' }, h('b', null, new Set(sets.map((s) => s.exerciseId)).size), h('span', null, 'esercizi')),
      h('div', { class: 'card' }, h('b', null, workSets(sets).length), h('span', null, 'serie di lavoro')),
      h('div', { class: 'card' }, h('b', null, Math.round(volume(sets))), h('span', null, 'kg di volume'))),
    h('div', { class: 'card stack' },
      h('div', null, h('b', null, 'Backup'), h('div', { class: 'small muted' }, `Ultimo backup: ${relDays(last)}. Salva il file in File › iCloud Drive.`)),
      h('button', { class: 'btn primary big block', onclick: doBackup }, 'Backup ora')),
    h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn block', onclick: () => go('#/') }, 'Torna alla Home')),
  ];
}

// ============================================================ Exercises

function pickExercise(gymId, { exclude = [], title }, onPick) {
  sheet((close) => {
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Cerca o scrivi un nome nuovo…' });
    const list = h('ul', { class: 'list', style: 'margin-top:10px' });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const items = D.exercisesOf(gymId).filter((e) => !exclude.includes(e.id) && (!q || e.name.toLowerCase().includes(q)));
      const rows = items.map((e) => h('li', { class: 'tap', onclick: () => { close(); onPick(e.id); } }, h('span', { class: 'grow' }, e.name)));
      if (q && !D.exercisesOf(gymId).some((e) => e.name.toLowerCase() === q)) {
        rows.unshift(h('li', { class: 'tap', onclick: async () => {
          const ex = { id: uid(), gymId, name: search.value.trim(), ...DEFAULT_EX, setupNote: '', nextNote: '', archived: false, createdAt: Date.now() };
          await D.put('exercises', ex);
          close(); onPick(ex.id);
        } }, h('b', { style: 'color:var(--accent)' }, `+ Nuovo esercizio: «${search.value.trim()}»`)));
      }
      if (!rows.length) rows.push(h('li', { class: 'muted' }, 'Scrivi il nome per creare un esercizio.'));
      list.replaceChildren(...rows);
    };
    search.addEventListener('input', draw);
    draw();
    return [h('h2', null, title), search, list];
  });
}

function editExercise(ex, { showArchive = false } = {}) {
  sheet((close) => {
    const name = h('input', { class: 'input', value: ex.name });
    const rmin = h('input', { class: 'input', inputmode: 'numeric', value: ex.repMin ?? '' });
    const rmax = h('input', { class: 'input', inputmode: 'numeric', value: ex.repMax ?? '' });
    const inc = h('input', { class: 'input', inputmode: 'decimal', value: fmtW(ex.increment ?? DEFAULT_EX.increment) });
    const setup = h('textarea', { class: 'input', placeholder: 'es. schienale 6, sedile basso' }, ex.setupNote || '');
    const next = h('textarea', { class: 'input', placeholder: 'es. provare 17,5 kg' }, ex.nextNote || '');
    let archived = !!ex.archived;
    let scheme = isTB(ex) ? 'topBackoff' : 'straight';
    const bo0 = backoffOf(ex);
    const boPct = h('input', { class: 'input', inputmode: 'decimal', value: fmtW(bo0.pct) });
    const boSets = h('input', { class: 'input', inputmode: 'numeric', value: bo0.sets });
    const boMin = h('input', { class: 'input', inputmode: 'numeric', value: bo0.repMin });
    const boMax = h('input', { class: 'input', inputmode: 'numeric', value: bo0.repMax });
    const lblMin = h('span', { class: 'field-label' });
    const lblMax = h('span', { class: 'field-label' });
    const boBox = h('div', { class: 'bo-box' },
      h('div', { class: 'grid2' },
        h('label', null, h('span', { class: 'field-label' }, '% scarico back-off'), boPct),
        h('label', null, h('span', { class: 'field-label' }, 'N. back-off'), boSets)),
      h('div', { class: 'grid2' },
        h('label', null, h('span', { class: 'field-label' }, 'Rip. min back-off'), boMin),
        h('label', null, h('span', { class: 'field-label' }, 'Rip. max back-off'), boMax)),
      h('p', { class: 'small muted', style: 'margin:8px 0 0' }, 'La prima serie di lavoro è la top; le back-off usano il peso della top di oggi meno la percentuale, arrotondato all\'incremento.'));
    const schemeBox = h('div');
    const drawScheme = () => {
      const tb = scheme === 'topBackoff';
      lblMin.textContent = tb ? 'Top: rip. min' : 'Rip. min';
      lblMax.textContent = tb ? 'Top: rip. max' : 'Rip. max';
      boBox.hidden = !tb;
      schemeBox.replaceChildren(seg([{ value: 'straight', label: 'Serie dritte' }, { value: 'topBackoff', label: 'Top + back-off' }],
        scheme, (v) => { scheme = v; drawScheme(); }));
    };
    drawScheme();
    return [
      h('h2', null, 'Esercizio'),
      h('label', null, h('span', { class: 'field-label' }, 'Nome'), name),
      h('span', { class: 'field-label' }, 'Schema'),
      schemeBox,
      h('div', { class: 'grid3' },
        h('label', null, lblMin, rmin),
        h('label', null, lblMax, rmax),
        h('label', null, h('span', { class: 'field-label' }, 'Incremento kg'), inc)),
      boBox,
      h('label', null, h('span', { class: 'field-label' }, 'Regolazioni e note fisse'), setup),
      h('label', null, h('span', { class: 'field-label' }, 'Nota per la prossima volta'), next),
      showArchive ? h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: archived, onchange: (e) => { archived = e.target.checked; } }),
        h('span', null, 'Archiviato (nascosto dagli elenchi, lo storico resta)')) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: close }, 'Annulla'),
        h('button', { class: 'btn primary', onclick: async () => {
          const n = name.value.trim();
          if (!n) return toast('Il nome non può essere vuoto');
          const min = parseNum(rmin.value), max = parseNum(rmax.value);
          if (min != null && max != null && min > max) return toast('Il minimo supera il massimo');
          const patch = { scheme };
          if (scheme === 'topBackoff') {
            const b = { pct: parseNum(boPct.value), sets: Math.round(parseNum(boSets.value) ?? 0), repMin: Math.round(parseNum(boMin.value) ?? 0), repMax: Math.round(parseNum(boMax.value) ?? 0) };
            if (!(b.pct > 0 && b.pct < 100)) return toast('% scarico tra 1 e 99');
            if (!(b.sets >= 1 && b.sets <= 6)) return toast('Back-off: da 1 a 6 serie');
            if (!(b.repMin > 0 && b.repMax >= b.repMin)) return toast('Range back-off non valido');
            if (max == null) return toast('Imposta il range della top');
            patch.backoff = b;
          }
          await D.put('exercises', {
            ...ex, ...patch, name: n, repMin: min, repMax: max, increment: parseNum(inc.value) || DEFAULT_EX.increment,
            setupNote: setup.value.trim(), nextNote: next.value.trim(), archived,
          });
          close(); render({ keepScroll: true });
        } }, 'Salva')),
    ];
  });
}

// ============================================================ History

function viewHistory() {
  const out = [h('h1', null, 'Storico'),
    h('div', { style: 'margin-bottom:14px' }, seg([{ value: 'sessioni', label: 'Sessioni' }, { value: 'esercizi', label: 'Esercizi' }],
      historyTab, (v) => { historyTab = v; render(); }))];

  if (historyTab === 'sessioni') {
    const list = D.sessionsSorted();
    if (!list.length) return [...out, h('div', { class: 'empty-state' }, 'Ancora nessuna sessione.')];
    out.push(h('ul', { class: 'list' }, list.map((s) => {
      const sets = D.setsOf(s.id);
      return h('li', { class: 'tap', onclick: () => go(`#/storico/sessione/${s.id}`) },
        h('div', { class: 'grow' },
          h('div', { style: 'font-weight:700' }, s.templateName, s.finishedAt ? '' : ' · in corso'),
          h('div', { class: 'small muted' }, `${fmtDate(s.startedAt)} · ${S.gyms.get(s.gymId)?.name ?? ''} · ${workSets(sets).length} serie`)),
        h('span', { class: 'chev' }));
    })));
    return out;
  }

  out.push(gymSeg());
  const gymId = currentGymId();
  const exs = D.exercisesOf(gymId);
  if (!exs.length) return [...out, h('div', { class: 'empty-state' }, 'Nessun esercizio in questa palestra.')];
  out.push(h('ul', { class: 'list' }, exs.map((e) => {
    const last = D.lastTime(e.id);
    const best = last ? workSets(last.sets).sort((a, b) => b.weight - a.weight || b.reps - a.reps)[0] : null;
    return h('li', { class: 'tap', onclick: () => go(`#/storico/esercizio/${e.id}`) },
      h('div', { class: 'grow' },
        h('div', { style: 'font-weight:700' }, e.name),
        h('div', { class: 'small muted' }, last ? `${fmtDate(last.session.startedAt)}${best ? ' · top ' + fmtSet(best) : ''}` : 'mai fatto')),
      h('span', { class: 'chev' }));
  })));
  const archived = D.exercisesOf(gymId, { archived: true });
  if (archived.length) {
    out.push(h('h3', null, 'Archiviati'), h('ul', { class: 'list' }, archived.map((e) =>
      h('li', { class: 'tap', onclick: () => go(`#/storico/esercizio/${e.id}`) }, h('span', { class: 'grow muted' }, e.name), h('span', { class: 'chev' })))));
  }
  return out;
}

function viewSessionDetail(id) {
  const sess = S.sessions.get(id);
  if (!sess) return h('div', { class: 'empty-state' }, 'Sessione non trovata.');
  const sets = D.setsOf(id);
  const order = [...new Set([...sess.items.map((i) => i.exerciseId), ...sets.map((s) => s.exerciseId)])]
    .filter((exId) => sets.some((s) => s.exerciseId === exId));
  return [
    h('button', { class: 'btn ghost small', onclick: () => history.back() }, '‹ Indietro'),
    h('h1', null, sess.templateName),
    h('p', { class: 'muted' }, `${fmtDateLong(sess.startedAt)} · ${S.gyms.get(sess.gymId)?.name ?? ''}`),
    !sess.finishedAt ? h('button', { class: 'btn primary block', onclick: () => go('#/sessione') }, 'Riprendi sessione') : null,
    h('div', { class: 'stats' },
      h('div', { class: 'card' }, h('b', null, order.length), h('span', null, 'esercizi')),
      h('div', { class: 'card' }, h('b', null, workSets(sets).length), h('span', null, 'serie di lavoro')),
      h('div', { class: 'card' }, h('b', null, Math.round(volume(sets))), h('span', null, 'kg di volume'))),
    sess.note ? h('p', { class: 'small muted' }, sess.note) : null,
    order.map((exId) => [
      h('h3', null, exName(exId)),
      h('div', { class: 'card', style: 'padding:6px 4px' }, h('ul', { class: 'sets' },
        ((list, roles) => list.map((s, i) => setRow(s, i, { onTap: () => editSet(s), role: roles[i] })))(
          sets.filter((s) => s.exerciseId === exId), rolesOf(S.exercises.get(exId), sets.filter((s) => s.exerciseId === exId))))),
    ]),
    h('div', { style: 'margin-top:24px' }, h('button', { class: 'btn danger block', onclick: async () => {
      if (!confirm(`Eliminare questa sessione e le sue ${sets.length} serie? Non si può annullare.`)) return;
      const ops = sets.map((s) => ({ store: 'sets', del: s.id }));
      ops.push({ store: 'sessions', del: id });
      if (S.meta.activeSessionId === id) ops.push({ store: 'meta', del: 'activeSessionId' });
      await D.write(ops);
      go('#/storico');
    } }, 'Elimina sessione')),
  ];
}

function viewExercise(id) {
  const ex = S.exercises.get(id);
  if (!ex) return h('div', { class: 'empty-state' }, 'Esercizio non trovato.');
  const hist = D.historyOf(id);
  return [
    h('button', { class: 'btn ghost small', onclick: () => history.back() }, '‹ Indietro'),
    h('div', { class: 'row between' }, h('h1', { class: 'grow' }, ex.name),
      h('button', { class: 'btn small', onclick: () => editExercise(ex, { showArchive: true }) }, 'Modifica')),
    h('p', { class: 'muted small' },
      `${S.gyms.get(ex.gymId)?.name ?? ''} · ${schemeLabel(ex)}${ex.archived ? ' · archiviato' : ''}`),
    ex.setupNote ? h('div', { class: 'note-chip setup' }, '⚙︎ ', ex.setupNote) : null,
    ex.nextNote ? h('div', { class: 'note-chip next' }, '→ ', ex.nextNote) : null,
    hist.length ? nextTimeCard(ex, hist[0]) : null,
    hist.length ? exerciseProgress(hist, ex) : h('div', { class: 'empty-state' }, 'Ancora nessuna serie registrata.'),
    hist.length ? h('h2', null, 'Storico') : null,
    hist.map(({ session, sets }) => [
      h('h3', null, `${fmtDate(session.startedAt)} · ${session.templateName}`),
      h('div', { class: 'card', style: 'padding:6px 4px' }, h('ul', { class: 'sets' },
        ((roles) => sets.map((s, i) => setRow(s, i, { onTap: () => editSet(s), role: roles[i] })))(rolesOf(ex, sets)))),
    ]),
  ];
}

function schemeLabel(ex) {
  const inc = fmtW(ex.increment ?? DEFAULT_EX.increment);
  if (isTB(ex)) {
    const bo = backoffOf(ex);
    return `Top ${ex.repMin ?? '?'}–${ex.repMax ?? '?'} · B-off ${bo.repMin}–${bo.repMax} −${fmtW(bo.pct)}% · +${inc} kg`;
  }
  return `${ex.repMin ?? '?'}–${ex.repMax ?? '?'} rip · +${inc} kg`;
}


function nextTimeCard(ex, last) {
  const sugg = suggestFor(ex, last.sets);
  const work = (sugg || []).filter((x) => x.kind === 'work');
  if (!work.length) return null;
  return [
    h('h2', null, 'Prossima volta'),
    progressCard(ex, sugg),
    h('div', { class: 'card', style: 'padding:6px 4px;margin-top:8px' }, h('ul', { class: 'sets' },
      planRows(ex, sugg, last.sets))),
    h('p', { class: 'small muted', style: 'margin:6px 2px 0' }, `Basato su ${fmtDate(last.session.startedAt)}. Range e incremento si cambiano con «Modifica».`),
  ];
}

// ============================================================ Progress charts

const e1rm = (set) => (set.weight || 0) * (1 + set.reps / 30);   // Epley
const heaviest = (sets) => [...sets].sort((a, b) => b.weight - a.weight || b.reps - a.reps)[0];

const METRICS = {
  top: {
    label: 'Serie top', unit: 'kg', decimals: 1,
    help: (ex) => (isTB(ex) ? 'Il peso della top set (prima serie di lavoro).' : 'Il peso più alto usato in una serie di lavoro.'),
    point: (work, ex) => { const b = isTB(ex) ? work[0] : heaviest(work); return { y: b.weight, detail: `${b.reps} × ${fmtW(b.weight)} kg` }; },
  },
  e1rm: {
    label: '1RM stimato', unit: 'kg', decimals: 1,
    help: (ex) => `1RM stimato con la formula di Epley: peso × (1 + ripetizioni / 30), sulla ${isTB(ex) ? 'top set' : 'serie migliore'}.`,
    point: (work, ex) => {
      const b = isTB(ex) ? work[0] : [...work].sort((a, c) => e1rm(c) - e1rm(a))[0];
      return { y: e1rm(b), detail: `dalla serie ${b.reps} × ${fmtW(b.weight)} kg` };
    },
  },
  volume: {
    label: 'Volume', unit: 'kg', decimals: 0,
    help: () => 'Somma di peso × ripetizioni delle serie di lavoro (avvicinamento escluso).',
    point: (work) => ({ y: volume(work), detail: `${work.length} serie di lavoro` }),
  },
};

const RANGES = { '3m': 91, '6m': 182, '1a': 365, all: Infinity };

function exerciseProgress(hist, ex) {
  const box = h('div');
  const draw = () => {
    const m = METRICS[chartMetric];
    const all = hist.slice().reverse()
      .map(({ session, sets }) => ({ session, work: workSets(sets) }))
      .filter((r) => r.work.length);
    const cutoff = Date.now() - RANGES[chartRange] * 86400000;
    const points = all.filter((r) => r.session.startedAt >= cutoff)
      .map((r) => ({ x: r.session.startedAt, ...m.point(r.work, ex) }));

    let trend = null;
    if (points.length >= 2) {
      const a = points[0].y, b = points.at(-1).y;
      const diff = b - a;
      const pct = a ? Math.round((diff / a) * 100) : 0;
      const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
      trend = `${sign}${(Math.round(Math.abs(diff) * 10 ** m.decimals) / 10 ** m.decimals).toLocaleString('it-CH')} kg (${sign}${Math.abs(pct)}%) dal ${new Date(points[0].x).toLocaleDateString('it-CH', { day: 'numeric', month: 'short' })}`;
    }

    const allWork = all.flatMap((r) => r.work);
    const rmPool = isTB(ex) ? all.map((r) => r.work[0]) : allWork;
    const best1rm = rmPool.length ? [...rmPool].sort((a, b) => e1rm(b) - e1rm(a))[0] : null;
    const top = allWork.length ? heaviest(allWork) : null;

    box.replaceChildren(
      h('h2', null, 'Progressi'),
      seg(Object.entries(METRICS).map(([value, x]) => ({ value, label: x.label })), chartMetric, (v) => { chartMetric = v; draw(); }),
      h('div', { class: 'card chart-card' },
        h('div', { class: 'row', style: 'justify-content:flex-end;margin-bottom:6px' },
          seg([{ value: '3m', label: '3M' }, { value: '6m', label: '6M' }, { value: '1a', label: '1A' }, { value: 'all', label: 'Tutto' }],
            chartRange, (v) => { chartRange = v; draw(); }, 'mini')),
        lineChart(points, { unit: m.unit, decimals: m.decimals }),
        trend || points.length === 1
          ? h('p', { style: 'margin:8px 2px 0;font-weight:600' }, trend ?? 'Una sola sessione finora: la linea parte dalla prossima.') : null,
        h('p', { class: 'small muted', style: 'margin:6px 2px 0' }, m.help(ex))),
      allWork.length ? h('div', { class: 'stats' },
        h('div', { class: 'card' }, h('b', null, fmtW(Math.round(e1rm(best1rm) * 10) / 10)), h('span', null, '1RM stimato max')),
        h('div', { class: 'card' }, h('b', null, `${top.reps}×${fmtW(top.weight)}`), h('span', null, 'serie più pesante')),
        h('div', { class: 'card' }, h('b', null, all.length), h('span', null, 'sessioni'))) : null,
    );
  };
  draw();
  return box;
}

// ============================================================ Settings

function viewSettings() {
  const gymId = currentGymId();
  const last = S.meta.lastBackupAt;
  if (D.isEmpty()) return viewWelcome();
  return [
    h('h1', null, 'Impostazioni'),

    h('h3', null, 'Backup e dati'),
    h('div', { class: 'card stack' },
      h('div', { class: 'small muted' }, `Ultimo backup: ${last ? fmtDateLong(last) + ' (' + relDays(last) + ')' : 'mai'}`),
      h('button', { class: 'btn primary block', onclick: doBackup }, 'Backup ora (file JSON)'),
      h('button', { class: 'btn block', onclick: pickImportFile }, 'Importa / ripristina backup'),
      h('button', { class: 'btn block', onclick: exportCsv }, 'Esporta serie in CSV'),
      h('div', { class: 'small muted' }, `Memoria persistente: ${persisted === true ? 'attiva' : persisted === false ? 'non concessa dal browser' : 'non disponibile'}. ${S.sessions.size} sessioni, ${S.sets.size} serie.`)),

    h('h3', null, 'Palestre'),
    h('ul', { class: 'list' }, D.gyms().map((g) => h('li', { class: 'tap', onclick: async () => {
      const name = prompt('Nome della palestra', g.name);
      if (name && name.trim()) { await D.put('gyms', { ...g, name: name.trim() }); render({ keepScroll: true }); }
    } }, h('span', { class: 'grow' }, g.name, g.id === gymId ? h('span', { class: 'pill', style: 'margin-left:8px' }, 'attuale') : null), h('span', { class: 'small muted' }, 'rinomina')))),
    h('button', { class: 'btn ghost block', onclick: async () => {
      const name = prompt('Nome della nuova palestra');
      if (name && name.trim()) { await D.put('gyms', { id: uid(), name: name.trim(), order: D.gyms().length }); render({ keepScroll: true }); }
    } }, '+ Aggiungi palestra'),

    h('h3', null, `Schede · ${S.gyms.get(gymId)?.name ?? ''}`),
    gymSeg(),
    h('ul', { class: 'list' }, D.templatesOf(gymId).map((t) => h('li', { class: 'tap', onclick: () => go(`#/impostazioni/scheda/${t.id}`) },
      h('div', { class: 'grow' }, h('div', { style: 'font-weight:700' }, t.name), h('div', { class: 'small muted' }, `${t.items.length} esercizi`)), h('span', { class: 'chev' })))),
    h('button', { class: 'btn ghost block', onclick: async () => {
      const name = prompt('Nome della nuova scheda (es. Push A)');
      if (!name || !name.trim()) return;
      const t = { id: uid(), gymId, name: name.trim(), order: D.templatesOf(gymId).length, items: [] };
      await D.put('templates', t);
      go(`#/impostazioni/scheda/${t.id}`);
    } }, '+ Nuova scheda'),

    h('h3', null, `Esercizi · ${S.gyms.get(gymId)?.name ?? ''}`),
    h('ul', { class: 'list' }, D.exercisesOf(gymId).map((e) => h('li', { class: 'tap', onclick: () => editExercise(e, { showArchive: true }) },
      h('div', { class: 'grow' }, h('div', { style: 'font-weight:600' }, e.name),
        h('div', { class: 'small muted' }, schemeLabel(e))), h('span', { class: 'chev' })))),
    h('button', { class: 'btn ghost block', onclick: () => pickExercise(gymId, { title: 'Nuovo esercizio' }, (id) => editExercise(S.exercises.get(id), { showArchive: true })) }, '+ Nuovo esercizio'),
    D.exercisesOf(gymId, { archived: true }).length
      ? h('p', { class: 'small muted' }, `${D.exercisesOf(gymId, { archived: true }).length} esercizi archiviati: li trovi in Storico › Esercizi.`) : null,

    h('p', { class: 'small muted', style: 'margin-top:28px;text-align:center' }, `Gym Log ${APP_VERSION}`),
  ];
}

function viewTemplateEdit(id) {
  const t = S.templates.get(id);
  if (!t) return h('div', { class: 'empty-state' }, 'Scheda non trovata.');
  const save = async (patch) => { await D.put('templates', { ...S.templates.get(id), ...patch }); render({ keepScroll: true }); };
  const items = t.items;
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    save({ items: next });
  };
  return [
    h('button', { class: 'btn ghost small', onclick: () => go('#/impostazioni') }, '‹ Impostazioni'),
    h('div', { class: 'row between' }, h('h1', { class: 'grow' }, t.name),
      h('button', { class: 'btn small', onclick: () => {
        const name = prompt('Nome della scheda', t.name);
        if (name && name.trim()) save({ name: name.trim() });
      } }, 'Rinomina')),
    h('p', { class: 'small muted' }, `${S.gyms.get(t.gymId)?.name ?? ''} · tocca «facoltativo» per cambiarlo. Le modifiche non toccano lo storico.`),
    items.length ? h('ul', { class: 'list' }, items.map((it, i) => h('li', null,
      h('div', { class: 'grow' },
        h('div', { style: 'font-weight:600' }, exName(it.exerciseId)),
        h('button', { class: 'link-btn', onclick: () => {
          save({ items: items.map((x, k) => (k === i ? { ...x, optional: !x.optional } : x)) });
        } }, it.optional ? h('span', { class: 'pill opt' }, 'facoltativo') : 'obbligatorio')),
      h('button', { class: 'icon-btn', disabled: i === 0, 'aria-label': 'Su', onclick: () => move(i, -1) }, '↑'),
      h('button', { class: 'icon-btn', disabled: i === items.length - 1, 'aria-label': 'Giù', onclick: () => move(i, 1) }, '↓'),
      h('button', { class: 'icon-btn', 'aria-label': 'Togli dalla scheda', onclick: () => {
        if (confirm(`Togliere ${exName(it.exerciseId)} dalla scheda? Lo storico resta.`)) save({ items: items.filter((_, k) => k !== i) });
      } }, '✕'))))
      : h('div', { class: 'empty-state' }, 'Scheda vuota.'),
    h('button', { class: 'btn block', style: 'margin-top:12px', onclick: () => pickExercise(t.gymId, { exclude: items.map((i) => i.exerciseId), title: `Aggiungi a ${t.name}` },
      (exId) => save({ items: [...S.templates.get(id).items, { exerciseId: exId, optional: false }] })) }, '+ Aggiungi esercizio'),
    h('button', { class: 'btn danger block', style: 'margin-top:24px', onclick: async () => {
      if (!confirm(`Eliminare la scheda «${t.name}»? Sessioni ed esercizi restano nello storico.`)) return;
      await D.del('templates', id);
      go('#/impostazioni');
    } }, 'Elimina scheda'),
  ];
}

// ============================================================ Backup / import / export

// Builds the file synchronously so the share sheet keeps the user's tap gesture (needed on iOS).
function doBackup() {
  const json = JSON.stringify(D.exportObject());
  const name = `gymlog-backup-${stamp()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  const mark = async () => { await D.setMeta('lastBackupAt', Date.now()); toast('Backup completato'); render({ keepScroll: true }); };
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: 'Backup Gym Log' })
      .then(mark)
      .catch((e) => { if (e.name !== 'AbortError') { downloadBlob(file, name); mark(); } });
  } else {
    downloadBlob(file, name);
    mark();
  }
}

function exportCsv() {
  const name = `gymlog-serie-${stamp()}.csv`;
  const file = new File(['﻿' + D.toCsv()], name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: 'Serie Gym Log' }).catch(() => {});
  } else downloadBlob(file, name);
}

function pickImportFile() {
  const input = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    input.remove();
    if (!f) return;
    let obj;
    try { obj = D.validateBackup(JSON.parse(await f.text())); } catch (e) {
      return toast(e instanceof SyntaxError ? 'File non leggibile (JSON non valido).' : e.message, null, 5000);
    }
    confirmImport(obj);
  });
  document.body.append(input);
  input.click();
}

function confirmImport(obj) {
  const d = obj.data;
  const empty = D.isEmpty();
  const run = async (mode) => {
    await D.importBackup(obj, mode);
    if (!S.meta.currentGymId || !S.gyms.has(S.meta.currentGymId)) await D.setMeta('currentGymId', D.gyms()[0]?.id ?? null);
    toast('Dati importati');
    go('#/');
  };
  sheet((close) => [
    h('h2', null, 'Importa backup'),
    h('p', { class: 'muted' }, `Creato il ${obj.exportedAt ? fmtDateLong(Date.parse(obj.exportedAt)) : '?'}.`),
    h('ul', { class: 'list' },
      h('li', null, h('span', { class: 'grow' }, 'Palestre'), h('b', null, d.gyms.map((g) => g.name).join(', ') || '–')),
      h('li', null, h('span', { class: 'grow' }, 'Schede'), h('b', null, d.templates.length)),
      h('li', null, h('span', { class: 'grow' }, 'Esercizi'), h('b', null, d.exercises.length)),
      h('li', null, h('span', { class: 'grow' }, 'Sessioni'), h('b', null, d.sessions.length)),
      h('li', null, h('span', { class: 'grow' }, 'Serie'), h('b', null, d.sets.length))),
    empty ? h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: close }, 'Annulla'),
      h('button', { class: 'btn primary', onclick: () => { close(); run('replace'); } }, 'Importa'))
      : [
        h('p', { class: 'small muted' }, '«Unisci» aggiunge i dati del file a quelli attuali (a parità di elemento vince il file). «Sostituisci» cancella tutto e ripristina il file.'),
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary block', onclick: () => { close(); run('merge'); } }, 'Unisci con i dati attuali'),
          h('button', { class: 'btn danger block', onclick: () => {
            if (!confirm('Sostituire TUTTI i dati attuali con il contenuto del file? Fai prima un backup se non sei sicuro.')) return;
            close(); run('replace');
          } }, 'Sostituisci tutto'),
          h('button', { class: 'btn block', onclick: close }, 'Annulla')),
      ],
  ]);
}

// ============================================================ Start-up

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const watch = (w) => w && w.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) {
        toast('Nuova versione disponibile', { label: 'Aggiorna', fn: () => w.postMessage('skipWaiting') }, 0);
      }
    });
    if (reg.waiting && navigator.serviceWorker.controller) {
      toast('Nuova versione disponibile', { label: 'Aggiorna', fn: () => reg.waiting.postMessage('skipWaiting') }, 0);
    }
    reg.addEventListener('updatefound', () => watch(reg.installing));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
  // Reload only when an update replaces a previous worker: on the very first install the
  // worker takes control via clients.claim(), and reloading then would interrupt the user.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
}

async function init() {
  try {
    await D.load();
  } catch (e) {
    app.replaceChildren(h('div', { class: 'empty-state' }, 'Impossibile aprire il database: ', e.message));
    return;
  }
  try {
    if (navigator.storage?.persist) persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch { persisted = null; }
  window.addEventListener('hashchange', () => render());
  if (S.meta.activeSessionId && !S.sessions.has(S.meta.activeSessionId)) await D.write([{ store: 'meta', del: 'activeSessionId' }]);
  render();
  registerServiceWorker();
}

init();
