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
const SCHEMA_VERSION = 3;

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
  return { version: SCHEMA_VERSION, days: {}, doses: {}, profile: {} };
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
  /* v2 had no dose log. Nothing to convert — the map simply did not exist —
     so the migration is to give it one and leave every meal alone. Done
     unconditionally rather than under the version check, because a v3 blob
     hand-edited or truncated somewhere else would otherwise reach addDose()
     with no map to push onto. */
  if (!db.doses || typeof db.doses !== 'object') db.doses = {};

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

/* ------------------------------------------------------------- the doses */

/* Insulin is day-keyed like meals, which is right for "how much did I take
   today" and wrong for everything the sliding window needs — a dose at 23:40
   is still working at 01:20 and lives under yesterday's key. So every window
   read goes through dosesBetween(), which walks the day keys the window
   actually touches instead of the one the clock happens to be in.

   `kind` is 'bolus' (counts toward active insulin), 'basal' (long-acting,
   deliberately excluded from IOB — see insulin.js) or 'reading' (a glucose
   value logged with no dose, which is a real thing to want to record). */
export const DOSE_KINDS = ['bolus', 'basal', 'reading'];

export function dosesOn(key) {
  return (db.doses[key] || []).slice().sort((a, b) => a.ts - b.ts);
}

export function addDose(key, dose) {
  const day = db.doses[key] || (db.doses[key] = []);
  const row = { id: newId(), ts: Date.now(), kind: 'bolus', ...dose };
  day.push(row);
  day.sort((a, b) => a.ts - b.ts);
  const ok = persist();
  return { dose: row, persisted: ok };
}

export function updateDose(key, id, patch) {
  const day = db.doses[key];
  if (!day) return null;
  const i = day.findIndex((d) => d.id === id);
  if (i === -1) return null;
  day[i] = { ...day[i], ...patch, edited: true };
  persist();
  return day[i];
}

export function removeDose(key, id) {
  const day = db.doses[key];
  if (!day) return false;
  const i = day.findIndex((d) => d.id === id);
  if (i === -1) return false;
  day.splice(i, 1);
  if (!day.length) delete db.doses[key];
  persist();
  return true;
}

export function findDose(key, id) {
  return (db.doses[key] || []).find((d) => d.id === id) || null;
}

/* The day keys a timestamp window touches, inclusive at both ends. Built by
   walking dates rather than by dividing milliseconds, so a DST change — where
   a local day is 23 or 25 hours long — cannot drop or duplicate a key. */
function keysBetween(fromTs, toTs) {
  const first = dateKey(new Date(fromTs));
  const last = dateKey(new Date(toTs));
  const keys = [];
  let k = first;
  /* A window is hours wide, so this loop is two or three passes. The bound is
     a guard against a caller handing in a reversed or absurd range. */
  for (let i = 0; i < 400 && k <= last; i++) {
    keys.push(k);
    k = shiftKey(k, 1);
  }
  return keys;
}

export function dosesBetween(fromTs, toTs = Date.now()) {
  const out = [];
  for (const k of keysBetween(fromTs, toTs)) {
    for (const d of db.doses[k] || []) {
      if (d.ts >= fromTs && d.ts <= toTs) out.push(d);
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export function mealsBetween(fromTs, toTs = Date.now()) {
  const out = [];
  for (const k of keysBetween(fromTs, toTs)) {
    for (const m of db.days[k] || []) {
      if (m.ts >= fromTs && m.ts <= toTs) out.push(m);
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/* Bolus and basal are added up apart because they answer different questions:
   the bolus figure is what the day's food and corrections cost, the basal
   figure is a background rate that would swamp it. */
export function insulinTotalsOn(key) {
  const t = { bolus: 0, basal: 0, count: 0, readings: 0 };
  for (const d of db.doses[key] || []) {
    const u = Number(d.units) || 0;
    if (d.kind === 'basal') t.basal += u;
    else if (u > 0) { t.bolus += u; t.count++; }
    /* A reading is counted wherever it was typed, beside a dose or alone —
       the question "how many times did I check today" does not care which. */
    if (Number.isFinite(Number(d.bg)) && Number(d.bg) > 0) t.readings++;
  }
  t.bolus = Math.round(t.bolus * 10) / 10;
  t.basal = Math.round(t.basal * 10) / 10;
  return t;
}

/* Every glucose value on record in the last `days` days, wherever it was
   typed — beside a dose, or on its own. This is what the account screen's
   time-in-range summary reads. */
export function readingsSince(days = 14) {
  const from = new Date();
  from.setDate(from.getDate() - days);
  return dosesBetween(from.getTime())
    .filter((d) => Number.isFinite(Number(d.bg)) && Number(d.bg) > 0)
    .map((d) => ({ ts: d.ts, bg: Number(d.bg), trend: d.trend || null }));
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
