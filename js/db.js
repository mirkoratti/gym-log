// Storage layer: IndexedDB on disk, a full copy in memory for fast queries.
// Every write goes to IndexedDB first; memory is updated only after the write succeeds.

const DB_NAME = 'gymlog';
const DB_VERSION = 1;
export const SCHEMA = 1;
export const STORES = ['gyms', 'exercises', 'templates', 'sessions', 'sets'];

let db = null;

export const S = {
  gyms: new Map(),
  exercises: new Map(),
  templates: new Map(),
  sessions: new Map(),
  sets: new Map(),
  meta: {},
};

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(stores, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    fn(t);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transazione annullata'));
  });
}

function getAll(store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function load() {
  if (!db) db = await openDb();
  for (const s of STORES) {
    S[s] = new Map((await getAll(s)).map((o) => [o.id, o]));
  }
  S.meta = {};
  for (const m of await getAll('meta')) S.meta[m.key] = m.value;
}

// ops: [{ store, put: obj } | { store, del: id }]
export async function write(ops) {
  const stores = [...new Set(ops.map((o) => o.store))];
  await run(stores, (t) => {
    for (const op of ops) {
      const os = t.objectStore(op.store);
      if (op.put) os.put(op.put);
      else os.delete(op.del);
    }
  });
  for (const op of ops) {
    if (op.store === 'meta') {
      if (op.put) S.meta[op.put.key] = op.put.value; else delete S.meta[op.del];
    } else if (op.put) S[op.store].set(op.put.id, op.put);
    else S[op.store].delete(op.del);
  }
}

export const put = (store, obj) => write([{ store, put: obj }]).then(() => obj);
export const del = (store, id) => write([{ store, del: id }]);
export const setMeta = (key, value) => write([{ store: 'meta', put: { key, value } }]);

// ---------- Queries ----------

export const gyms = () => [...S.gyms.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
export const templatesOf = (gymId) =>
  [...S.templates.values()].filter((t) => t.gymId === gymId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
export const exercisesOf = (gymId, { archived = false } = {}) =>
  [...S.exercises.values()].filter((e) => e.gymId === gymId && !!e.archived === archived)
    .sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));

export function setsOf(sessionId, exerciseId) {
  const out = [];
  for (const s of S.sets.values()) {
    if (s.sessionId === sessionId && (exerciseId == null || s.exerciseId === exerciseId)) out.push(s);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// All sessions containing the exercise, newest first: [{ session, sets }]
export function historyOf(exerciseId, excludeSessionId = null) {
  const bySession = new Map();
  for (const s of S.sets.values()) {
    if (s.exerciseId !== exerciseId || s.sessionId === excludeSessionId) continue;
    if (!bySession.has(s.sessionId)) bySession.set(s.sessionId, []);
    bySession.get(s.sessionId).push(s);
  }
  const out = [];
  for (const [sid, sets] of bySession) {
    const session = S.sessions.get(sid);
    if (!session) continue;
    out.push({ session, sets: sets.sort((a, b) => a.ts - b.ts) });
  }
  return out.sort((a, b) => b.session.startedAt - a.session.startedAt);
}

export const lastTime = (exerciseId, excludeSessionId) => historyOf(exerciseId, excludeSessionId)[0] || null;

export const sessionsSorted = () => [...S.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);

export const isEmpty = () => STORES.every((s) => S[s].size === 0);

// ---------- Backup ----------

export function exportObject() {
  const data = {};
  for (const s of STORES) data[s] = [...S[s].values()];
  return { app: 'gymlog', schema: SCHEMA, exportedAt: new Date().toISOString(), data };
}

export function validateBackup(obj) {
  if (!obj || obj.app !== 'gymlog' || typeof obj.data !== 'object') {
    throw new Error('Questo file non è un backup di Gym Log.');
  }
  if (obj.schema > SCHEMA) throw new Error('Backup creato da una versione più recente dell\'app. Aggiorna l\'app e riprova.');
  for (const s of STORES) {
    const arr = obj.data[s];
    if (!Array.isArray(arr)) throw new Error(`Backup incompleto: manca "${s}".`);
    for (const o of arr) if (!o || typeof o.id !== 'string') throw new Error(`Backup danneggiato in "${s}".`);
  }
  for (const set of obj.data.sets) {
    if (!Number.isFinite(set.reps) || !(Number.isFinite(set.weight) || set.weight === null)) {
      throw new Error('Backup danneggiato: serie con valori non validi.');
    }
  }
  return obj;
}

// mode: 'replace' clears everything first, 'merge' upserts by id (file wins).
export async function importBackup(obj, mode) {
  await run([...STORES], (t) => {
    for (const s of STORES) {
      const os = t.objectStore(s);
      if (mode === 'replace') os.clear();
      for (const o of obj.data[s]) os.put(o);
    }
  });
  if (mode === 'replace') {
    await run(['meta'], (t) => t.objectStore('meta').delete('activeSessionId'));
  }
  await load();
}

export function toCsv() {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['data', 'palestra', 'scheda', 'esercizio', 'serie', 'tipo', 'peso_kg', 'ripetizioni', 'nota']];
  for (const sess of [...S.sessions.values()].sort((a, b) => a.startedAt - b.startedAt)) {
    const gym = S.gyms.get(sess.gymId)?.name ?? '';
    const counters = {};
    for (const set of setsOf(sess.id)) {
      const ex = S.exercises.get(set.exerciseId)?.name ?? '?';
      counters[ex] = (counters[ex] || 0) + 1;
      rows.push([
        new Date(sess.startedAt).toISOString().slice(0, 10), gym, sess.templateName ?? '', ex,
        counters[ex], set.kind === 'warmup' ? 'avvicinamento' : 'lavoro', set.weight, set.reps, set.note ?? '',
      ]);
    }
  }
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}
