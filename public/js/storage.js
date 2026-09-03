/* ==========================================================================
   storage.js — day-keyed meal history in localStorage.

   Replaces the v1 scheme, which had two defects:
     1. clearOldData() deleted every prior day on load, so no history existed.
     2. saveMealsToStorage() read FileReader.result synchronously right after
        readAsDataURL(), which is always undefined — meal images never saved.

   Here images are downscaled to a small JPEG thumbnail *before* they reach
   storage (see camera.js), and every write is synchronous over already-encoded
   strings. localStorage is ~5MB, so thumbnails are budgeted and evicted
   oldest-first when the quota is hit rather than failing the save.
   ========================================================================== */

const BASE_KEY = 'ca:v2';
const SCHEMA_VERSION = 2;

/* Which log is open. init(namespace) points this at the signed-in identity's
   own key; with no namespace it stays on the bare key, which is both the
   pre-sign-in layout and what the storage tests exercise. */
let KEY = BASE_KEY;

/* -------------------------------------------------------------- date keys */

export function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function shiftKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return dateKey(dt);
}

export function labelForKey(key) {
  const today = dateKey();
  if (key === today) return 'Today';
  if (key === shiftKey(today, -1)) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const sameYear = y === new Date().getFullYear();
  return dt.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/* Meal slot from the *browser's* clock. NHANES is explicit that clock time
   has no implication as to meal type, so this is a pre-selection the user can
   override in one tap — never an assertion, and never inferred from the image. */
export function slotForTime(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= 4 && h < 10.5) return 'breakfast';
  if (h >= 10.5 && h < 15) return 'lunch';
  if (h >= 15 && h < 21) return 'dinner';
  return 'snack';
}

export const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];

/* ------------------------------------------------------------------ state */

let db = null;

function blank() {
  return { version: SCHEMA_VERSION, days: {}, profile: {} };
}

function read(key = KEY) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.days) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* One-time import of the v1 `meals_YYYY-MM-DD` keys. v1 stored `calories` and
   an `imageData`/`imageName` pair that in practice was always undefined, so
   only the text fields are recoverable. The old keys are left in place — this
   is someone's food log, and a failed migration should be re-runnable. */
function migrateV1(target) {
  let imported = 0;
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith('meals_')) continue;
    const dk = k.slice('meals_'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
    let rows;
    try {
      rows = JSON.parse(localStorage.getItem(k));
    } catch {
      continue;
    }
    if (!Array.isArray(rows) || !rows.length) continue;

    const day = target.days[dk] || (target.days[dk] = []);
    for (const r of rows) {
      const kcal = Number(r.calories ?? r.kcal);
      if (!Number.isFinite(kcal)) continue;
      const ts = Number(r.id) || Date.parse(`${dk}T12:00:00`);
      day.push({
        id: `v1-${r.id ?? imported}-${dk}`,
        ts,
        slot: slotForTime(new Date(ts)),
        name: String(r.name || 'Meal'),
        kcal: Math.round(kcal),
        source: 'manual',
        notes: r.notes ? String(r.notes) : '',
        migrated: true,
      });
      imported++;
    }
    day.sort((a, b) => a.ts - b.ts);
  }
  return imported;
}

/* A log kept before sign-in existed sits under the bare key. The first
   identity to open the app on this device claims it, so nobody's history
   disappears the day the gate ships. The original is renamed rather than
   deleted — it is a food diary, and a second identity must not claim it too. */
function adoptPreAuth() {
  const legacy = read(BASE_KEY);
  if (!legacy) return null;
  /* Moved, not copied: thumbnails make these blobs big enough that keeping a
     duplicate around is a real chance of blowing the 5MB quota. Clearing the
     old key is also what stops a second identity claiming the same log. */
  localStorage.setItem(KEY, JSON.stringify(legacy));
  localStorage.removeItem(BASE_KEY);
  return legacy;
}

/* `namespace` comes from the session — 'guest', 'google.<sub>', 'apple.<sub>'.
   Omit it and the bare key is used, which is what the tests do. */
export function init(namespace) {
  KEY = namespace ? `${BASE_KEY}:${namespace}` : BASE_KEY;
  db = read();
  if (!db && namespace) db = adoptPreAuth();
  if (!db) {
    db = blank();
    const n = migrateV1(db);
    if (n) persist();
  }
  if (db.version !== SCHEMA_VERSION) {
    db.version = SCHEMA_VERSION;
    persist();
  }
  return db;
}

/* Thumbnails are the only large field. When the quota blows, shed them from
   the oldest days first and retry, so a save never silently loses a meal. */
function persist() {
  const attempt = () => localStorage.setItem(KEY, JSON.stringify(db));
  try {
    attempt();
    return true;
  } catch (err) {
    const quota =
      err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);
    if (!quota) throw err;

    const days = Object.keys(db.days).sort();
    for (const dk of days) {
      let shed = false;
      for (const meal of db.days[dk]) {
        if (meal.thumb) {
          delete meal.thumb;
          meal.thumbEvicted = true;
          shed = true;
        }
      }
      if (!shed) continue;
      try {
        attempt();
        return true;
      } catch {
        /* keep shedding */
      }
    }
    try {
      attempt();
      return true;
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------------------- API */

export function mealsOn(key) {
  return (db.days[key] || []).slice().sort((a, b) => a.ts - b.ts);
}

export function daysWithMeals() {
  return Object.keys(db.days)
    .filter((k) => db.days[k].length)
    .sort();
}

export function totalsOn(key) {
  const meals = db.days[key] || [];
  const t = { kcal: 0, protein: 0, carb: 0, fat: 0, count: meals.length };
  for (const m of meals) {
    t.kcal += Number(m.kcal) || 0;
    t.protein += Number(m.protein) || 0;
    t.carb += Number(m.carb) || 0;
    t.fat += Number(m.fat) || 0;
  }
  t.kcal = Math.round(t.kcal);
  t.protein = Math.round(t.protein);
  t.carb = Math.round(t.carb);
  t.fat = Math.round(t.fat);
  return t;
}

export function addMeal(key, meal) {
  const day = db.days[key] || (db.days[key] = []);
  const row = { id: newId(), ts: Date.now(), ...meal };
  day.push(row);
  const ok = persist();
  return { meal: row, persisted: ok, thumbEvicted: !!row.thumbEvicted };
}

export function updateMeal(key, id, patch) {
  const day = db.days[key];
  if (!day) return null;
  const i = day.findIndex((m) => m.id === id);
  if (i === -1) return null;
  day[i] = { ...day[i], ...patch, edited: true };
  persist();
  return day[i];
}

export function removeMeal(key, id) {
  const day = db.days[key];
  if (!day) return false;
  const i = day.findIndex((m) => m.id === id);
  if (i === -1) return false;
  day.splice(i, 1);
  if (!day.length) delete db.days[key];
  persist();
  return true;
}

export function findMeal(key, id) {
  return (db.days[key] || []).find((m) => m.id === id) || null;
}

/* Profile is written now and read later: height/weight/goal and the Google or
   Apple identity arrive in a later phase, and the plate diameter feeds portion
   estimation today. Keyed storage stays a single blob so a signed-in account
   can adopt it wholesale. */
export function getProfile() {
  return { ...db.profile };
}

export function setProfile(patch) {
  db.profile = { ...db.profile, ...patch };
  persist();
  return db.profile;
}

export function exportAll() {
  return JSON.parse(JSON.stringify(db));
}

function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
