/**
 * db.js — Shared IndexedDB layer
 * DB: TrackerDB  v3
 * Stores:
 *   trackers      – tracker definitions (id, title, type, options, valueMap …)
 *   dailyEntries  – one record per (date × tracker)
 *                   { id, date, trackerId, type, rawValue, timestamp }
 *
 * All pages import this via <script src="db.js"></script>
 */

const DB_NAME    = 'TrackerDB';
const DB_VERSION = 3;          // bump from 2 → 3 to add dailyEntries store

// ── open / upgrade ──────────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      // existing trackers store (may already exist)
      if (!db.objectStoreNames.contains('trackers')) {
        const ts = db.createObjectStore('trackers', { keyPath: 'id', autoIncrement: true });
        ts.createIndex('title', 'title', { unique: false });
      }

      // new dailyEntries store
      if (!db.objectStoreNames.contains('dailyEntries')) {
        const es = db.createObjectStore('dailyEntries', { keyPath: 'id', autoIncrement: true });
        es.createIndex('date',         'date',                    { unique: false });
        es.createIndex('trackerId',    'trackerId',               { unique: false });
        es.createIndex('date_tracker', ['date', 'trackerId'],     { unique: true  });
      }
    };
  });
}

// ── trackers store helpers ──────────────────────────────────────────────────
async function getAllTrackers() {
  const db  = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('trackers', 'readonly')
                  .objectStore('trackers').getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error);  };
  });
}

async function getTrackerById(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('trackers', 'readonly')
                  .objectStore('trackers').get(id);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error);  };
  });
}

// ── dailyEntries helpers ────────────────────────────────────────────────────

/** Save (upsert) one tracker entry for a given date */
async function saveEntry(date, trackerId, type, rawValue) {
  const db  = await openDB();
  const tx  = db.transaction('dailyEntries', 'readwrite');
  const idx = tx.objectStore('dailyEntries').index('date_tracker');

  return new Promise((resolve, reject) => {
    // check if record already exists for this date+tracker pair
    const getReq = idx.getKey([date, trackerId]);

    getReq.onsuccess = () => {
      const existingKey = getReq.result;
      const store = tx.objectStore('dailyEntries');
      const record = { date, trackerId, type, rawValue, timestamp: new Date().toISOString() };

      let putReq;
      if (existingKey !== undefined) {
        record.id = existingKey;
        putReq = store.put(record);
      } else {
        putReq = store.add(record);
      }
      putReq.onsuccess = () => { db.close(); resolve(putReq.result); };
      putReq.onerror   = () => { db.close(); reject(putReq.error);   };
    };
    getReq.onerror = () => { db.close(); reject(getReq.error); };
  });
}

/** Delete one tracker entry for a given date (when user clears a value) */
async function deleteEntry(date, trackerId) {
  const db  = await openDB();
  const tx  = db.transaction('dailyEntries', 'readwrite');
  const idx = tx.objectStore('dailyEntries').index('date_tracker');

  return new Promise((resolve, reject) => {
    const getReq = idx.getKey([date, trackerId]);
    getReq.onsuccess = () => {
      const key = getReq.result;
      if (key === undefined) { db.close(); resolve(); return; }
      const delReq = tx.objectStore('dailyEntries').delete(key);
      delReq.onsuccess = () => { db.close(); resolve(); };
      delReq.onerror   = () => { db.close(); reject(delReq.error); };
    };
    getReq.onerror = () => { db.close(); reject(getReq.error); };
  });
}

/** Load all entries for one date → { [trackerId]: { rawValue, type } } */
async function loadEntriesForDate(date) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const idx = db.transaction('dailyEntries', 'readonly')
                  .objectStore('dailyEntries').index('date');
    const req = idx.getAll(date);
    req.onsuccess = () => {
      db.close();
      const map = {};
      req.result.forEach(r => { map[r.trackerId] = r; });
      resolve(map);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Load ALL entries for one tracker (all dates) → array of records */
async function loadEntriesForTracker(trackerId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const idx = db.transaction('dailyEntries', 'readonly')
                  .objectStore('dailyEntries').index('trackerId');
    const req = idx.getAll(trackerId);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror   = () => { db.close(); reject(req.error);   };
  });
}

// ── localStorage → IndexedDB migration (run once) ───────────────────────────
async function migrateFromLocalStorage() {
  const MIGRATION_KEY = 'idb_migration_v3_done';
  if (localStorage.getItem(MIGRATION_KEY)) return;

  const raw = localStorage.getItem('dailySelections');
  if (!raw) { localStorage.setItem(MIGRATION_KEY, '1'); return; }

  try {
    const dailySelections = JSON.parse(raw);
    const dates = Object.keys(dailySelections);

    for (const date of dates) {
      const entries = dailySelections[date];
      for (const trackerId of Object.keys(entries)) {
        const e = entries[trackerId];
        if (e.rawValue !== undefined || e.value !== undefined) {
          await saveEntry(
            date,
            parseInt(trackerId),
            e.type || 'dropdown',
            e.rawValue !== undefined ? e.rawValue : e.value
          );
        }
      }
    }

    localStorage.removeItem('dailySelections');
    localStorage.setItem(MIGRATION_KEY, '1');
    console.log('[DB] Migration complete: localStorage → IndexedDB');
  } catch (err) {
    console.error('[DB] Migration failed:', err);
  }
}

// ── score resolver (live, read-time only) ────────────────────────────────────
/**
 * resolveScore(rawValue, trackerDef) → number 0-100 | null
 *
 * Never stores a score. Always reads the LIVE tracker definition
 * so edits to option values automatically affect all past data.
 */
function resolveScore(rawValue, trackerDef) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;

  const type = trackerDef.type || 'dropdown';

  if (type === 'dropdown') {
    const idx = parseInt(rawValue);
    const opt = trackerDef.options?.[idx];
    if (!opt) return null;
    // value defined on option (from template) or fall back to positional %
    if (opt.value !== undefined) return opt.value;
    const total = trackerDef.options.length;
    return Math.round(((total - 1 - idx) / (total - 1)) * 100);
  }

  if (type === 'yesno') {
    const vm = trackerDef.valueMap;
    if (!vm) return rawValue === 'yes' ? 80 : 20;
    return vm[rawValue] ?? null;
  }

  if (type === 'numeric') {
    const num = parseFloat(rawValue);
    if (isNaN(num)) return null;
    const vm  = trackerDef.valueMap;
    if (!vm) return null;
    const min = vm.min ?? 0;
    const max = vm.max ?? 100;
    if (max === min) return 50;
    return Math.max(0, Math.min(100, ((num - min) / (max - min)) * 100));
  }

  return null; // text — not correlatable
}
