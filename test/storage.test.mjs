/* Tests for public/js/storage.js — run with: npm run test:storage
   The module touches only localStorage and Date, so a small stub is enough to
   exercise it under Node. */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------- localStorage stub ---- */

class FakeStorage {
  constructor(limitBytes = Infinity) {
    this.map = new Map();
    this.limit = limitBytes;
  }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
  setItem(k, v) {
    const s = String(v);
    let total = s.length;
    for (const [key, val] of this.map) if (key !== k) total += val.length;
    if (total > this.limit) {
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(k, s);
  }
}

/* Object.keys(localStorage) is how the v1 migration enumerates old keys, so
   the stub has to be a real own-enumerable-property object, not just a Map. */
function install(limit) {
  const backing = new FakeStorage(limit);
  const proxy = new Proxy(backing, {
    ownKeys: (t) => [...t.map.keys()],
    getOwnPropertyDescriptor: (t, p) =>
      t.map.has(p) ? { value: t.map.get(p), enumerable: true, configurable: true } : undefined,
    get: (t, p) => (typeof t[p] === 'function' ? t[p].bind(t) : t.map.has(p) ? t.map.get(p) : t[p]),
  });
  globalThis.localStorage = proxy;
  return backing;
}

async function freshStore() {
  /* Cache-bust so each test gets module-level state of its own. */
  return import(`../public/js/storage.js?v=${Math.random()}`);
}

/* ------------------------------------------------------------- date keys */

test('dateKey uses local time, not UTC', async () => {
  install();
  const s = await freshStore();
  // 1 Jan 2026 00:30 local — a UTC-based key would roll this to 2025-12-31
  assert.equal(s.dateKey(new Date(2026, 0, 1, 0, 30)), '2026-01-01');
  assert.equal(s.dateKey(new Date(2026, 8, 2, 23, 59)), '2026-09-02');
});

test('shiftKey crosses month and year boundaries', async () => {
  install();
  const s = await freshStore();
  assert.equal(s.shiftKey('2026-03-01', -1), '2026-02-28');
  assert.equal(s.shiftKey('2026-01-01', -1), '2025-12-31');
  assert.equal(s.shiftKey('2024-02-28', 1), '2024-02-29'); // leap year
});

test('slotForTime covers the whole clock with no gaps', async () => {
  install();
  const s = await freshStore();
  const at = (h, m = 0) => s.slotForTime(new Date(2026, 0, 1, h, m));
  assert.equal(at(4), 'breakfast');
  assert.equal(at(10, 29), 'breakfast');
  assert.equal(at(10, 30), 'lunch');
  assert.equal(at(14, 59), 'lunch');
  assert.equal(at(15), 'dinner');
  assert.equal(at(20, 59), 'dinner');
  assert.equal(at(21), 'snack');
  assert.equal(at(2), 'snack');
  assert.equal(at(3, 59), 'snack');

  for (let h = 0; h < 24; h++) {
    assert.ok(s.SLOTS.includes(at(h)), `hour ${h} produced no valid slot`);
  }
});

/* ------------------------------------------------------------- migration */

test('imports v1 meals_YYYY-MM-DD keys and leaves the originals in place', async () => {
  const backing = install();
  backing.setItem('meals_2026-08-30', JSON.stringify([
    { id: '1756500000000', name: 'Toast', calories: 210, notes: 'butter' },
    { id: '1756520000000', name: 'Curry', calories: 640 },
  ]));
  backing.setItem('meals_2026-08-31', JSON.stringify([{ id: '1756600000000', name: 'Salad', calories: 300 }]));
  backing.setItem('unrelated', 'x');

  const s = await freshStore();
  s.init();

  assert.equal(s.mealsOn('2026-08-30').length, 2);
  assert.equal(s.totalsOn('2026-08-30').kcal, 850);
  assert.equal(s.mealsOn('2026-08-31')[0].name, 'Salad');
  assert.equal(s.mealsOn('2026-08-30')[0].source, 'manual');

  // originals preserved so a failed migration is re-runnable
  assert.ok(backing.getItem('meals_2026-08-30'));
  assert.ok(backing.getItem('unrelated'));
});

test('migration skips rows with unusable calories and malformed days', async () => {
  const backing = install();
  backing.setItem('meals_2026-08-30', JSON.stringify([
    { id: '1', name: 'Good', calories: 100 },
    { id: '2', name: 'NaN cal', calories: 'abc' },
    { id: '3', name: 'Missing cal' },
  ]));
  backing.setItem('meals_not-a-date', JSON.stringify([{ id: '4', name: 'X', calories: 50 }]));
  backing.setItem('meals_2026-08-29', '{ broken json');

  const s = await freshStore();
  s.init();
  assert.equal(s.mealsOn('2026-08-30').length, 1);
  assert.equal(s.mealsOn('not-a-date').length, 0);
  assert.equal(s.mealsOn('2026-08-29').length, 0);
});

test('history survives a reload instead of being deleted', async () => {
  const backing = install();
  const s1 = await freshStore();
  s1.init();
  s1.addMeal('2026-08-01', { name: 'Old meal', kcal: 500, slot: 'lunch' });
  s1.addMeal(s1.dateKey(), { name: 'Today meal', kcal: 300, slot: 'dinner' });

  // Same backing store, fresh module instance = a page reload.
  const s2 = await freshStore();
  s2.init();
  assert.equal(s2.mealsOn('2026-08-01').length, 1, 'v1 deleted prior days here; v2 must not');
  assert.equal(s2.totalsOn('2026-08-01').kcal, 500);
  assert.equal(s2.daysWithMeals().length, 2);
});

/* ------------------------------------------------------------------ CRUD */

test('add, update and remove a meal', async () => {
  install();
  const s = await freshStore();
  s.init();
  const key = '2026-09-02';

  const { meal } = s.addMeal(key, { name: 'Biryani', kcal: 620, slot: 'dinner', protein: 30, carb: 70, fat: 22 });
  assert.ok(meal.id);
  assert.equal(s.totalsOn(key).kcal, 620);
  assert.equal(s.totalsOn(key).protein, 30);

  s.updateMeal(key, meal.id, { kcal: 700 });
  assert.equal(s.totalsOn(key).kcal, 700);
  assert.equal(s.findMeal(key, meal.id).edited, true, 'a corrected meal must be marked edited');

  assert.equal(s.removeMeal(key, meal.id), true);
  assert.equal(s.totalsOn(key).kcal, 0);
  assert.equal(s.daysWithMeals().includes(key), false, 'an emptied day should not linger');
  assert.equal(s.removeMeal(key, 'nope'), false);
});

test('meals come back in chronological order', async () => {
  install();
  const s = await freshStore();
  s.init();
  const key = '2026-09-02';
  s.addMeal(key, { name: 'Late', kcal: 1, ts: 3000 });
  s.addMeal(key, { name: 'Early', kcal: 1, ts: 1000 });
  s.addMeal(key, { name: 'Mid', kcal: 1, ts: 2000 });
  assert.deepEqual(s.mealsOn(key).map((m) => m.name), ['Early', 'Mid', 'Late']);
});

test('totals ignore missing and non-numeric fields', async () => {
  install();
  const s = await freshStore();
  s.init();
  const key = '2026-09-02';
  s.addMeal(key, { name: 'A', kcal: 100 });
  s.addMeal(key, { name: 'B', kcal: '250' });
  s.addMeal(key, { name: 'C', kcal: undefined });
  s.addMeal(key, { name: 'D', kcal: NaN });
  assert.equal(s.totalsOn(key).kcal, 350);
  assert.equal(s.totalsOn(key).count, 4);
});

/* --------------------------------------------------------------- quota */

test('a full quota sheds old thumbnails instead of losing the meal', async () => {
  install(9000); // small enough that a couple of thumbnails overflow it
  const s = await freshStore();
  s.init();

  const bigThumb = 'data:image/jpeg;base64,' + 'A'.repeat(3000);
  s.addMeal('2026-08-01', { name: 'Oldest', kcal: 400, thumb: bigThumb });
  s.addMeal('2026-08-02', { name: 'Older', kcal: 400, thumb: bigThumb });
  const res = s.addMeal('2026-09-02', { name: 'Newest', kcal: 400, thumb: bigThumb });

  assert.equal(res.persisted, true, 'the meal must still be saved');
  assert.equal(s.totalsOn('2026-08-01').kcal, 400, 'no meal record may be lost');
  assert.equal(s.totalsOn('2026-09-02').kcal, 400);
  assert.equal(s.mealsOn('2026-08-01')[0].thumb, undefined, 'oldest thumbnail should be shed first');
  assert.equal(s.mealsOn('2026-08-01')[0].thumbEvicted, true);
});

test('a non-quota storage failure is not swallowed', async () => {
  const backing = install();
  const s = await freshStore();
  s.init();
  backing.setItem = () => { throw new TypeError('storage is broken'); };
  assert.throws(() => s.addMeal('2026-09-02', { name: 'X', kcal: 1 }), /storage is broken/);
});

/* -------------------------------------------------------------- profile */

test('profile persists and merges', async () => {
  install();
  const s1 = await freshStore();
  s1.init();
  s1.setProfile({ plateDiameterCm: 27 });
  s1.setProfile({ dailyGoal: 2100 });

  const s2 = await freshStore();
  s2.init();
  assert.deepEqual(s2.getProfile(), { plateDiameterCm: 27, dailyGoal: 2100 });
});

test('corrupt storage falls back to a blank db rather than throwing', async () => {
  const backing = install();
  backing.setItem('ca:v2', 'not json at all');
  const s = await freshStore();
  assert.doesNotThrow(() => s.init());
  assert.deepEqual(s.daysWithMeals(), []);
});

/* ----------------------------------------------------------- namespaces */

test('two identities keep separate logs on the same device', async () => {
  const backing = install();

  const a = await freshStore();
  a.init('google.111');
  a.addMeal('2026-09-02', { name: 'Ramen', kcal: 600 });

  const b = await freshStore();
  b.init('guest');
  assert.deepEqual(b.daysWithMeals(), [], 'guest must not see the account log');
  b.addMeal('2026-09-02', { name: 'Toast', kcal: 150 });

  const a2 = await freshStore();
  a2.init('google.111');
  assert.equal(a2.totalsOn('2026-09-02').kcal, 600, 'signing back in reopens the same log');

  assert.ok(backing.getItem('ca:v2:google.111'));
  assert.ok(backing.getItem('ca:v2:guest'));
});

test('the first identity to sign in adopts a pre-auth log; the second does not', async () => {
  const backing = install();

  /* A log kept before the sign-in gate existed. */
  const pre = await freshStore();
  pre.init();
  pre.addMeal('2026-09-02', { name: 'Curry', kcal: 720 });
  assert.ok(backing.getItem('ca:v2'));

  const first = await freshStore();
  first.init('apple.abc');
  assert.equal(first.totalsOn('2026-09-02').kcal, 720, 'history carries into the account');
  assert.equal(backing.getItem('ca:v2'), null, 'the bare key is cleared once claimed');

  const second = await freshStore();
  second.init('guest');
  assert.deepEqual(second.daysWithMeals(), [], 'a second identity cannot claim it again');
});

test('init with no namespace still uses the bare key', async () => {
  const backing = install();
  const s = await freshStore();
  s.init();
  s.addMeal('2026-09-02', { name: 'Eggs', kcal: 180 });
  assert.ok(backing.getItem('ca:v2'));
  assert.equal(backing.getItem('ca:v2:guest'), null);
});

/* ------------------------------------------------------------- the doses */

test('doses are day-keyed and totalled apart from basal', async () => {
  install();
  const s = await freshStore();
  s.init();

  s.addDose('2026-09-02', { units: 6, kind: 'bolus', ts: Date.parse('2026-09-02T08:00:00') });
  s.addDose('2026-09-02', { units: 24, kind: 'basal', ts: Date.parse('2026-09-02T22:00:00') });
  s.addDose('2026-09-02', { units: 0, kind: 'reading', bg: 142, ts: Date.parse('2026-09-02T12:00:00') });

  const t = s.insulinTotalsOn('2026-09-02');
  assert.equal(t.bolus, 6, 'long-acting must not inflate the day’s mealtime figure');
  assert.equal(t.basal, 24);
  assert.equal(t.count, 1);
  assert.equal(t.readings, 1);

  assert.equal(s.dosesOn('2026-09-02').length, 3);
  assert.deepEqual(s.dosesOn('2026-09-03'), []);
});

test('dosesOn returns the day in the order it happened', async () => {
  install();
  const s = await freshStore();
  s.init();
  s.addDose('2026-09-02', { units: 3, ts: Date.parse('2026-09-02T19:00:00') });
  s.addDose('2026-09-02', { units: 5, ts: Date.parse('2026-09-02T07:00:00') });
  assert.deepEqual(s.dosesOn('2026-09-02').map((d) => d.units), [5, 3]);
});

test('the window reads across midnight, not just the current day key', async () => {
  install();
  const s = await freshStore();
  s.init();

  /* The case the day-keyed layout gets wrong on its own: a dose at 23:40 is
     still working at 01:20 and lives under the previous day. */
  const late = Date.parse('2026-09-02T23:40:00');
  const now = Date.parse('2026-09-03T01:20:00');
  s.addDose('2026-09-02', { units: 6, ts: late });
  s.addDose('2026-09-03', { units: 2, ts: Date.parse('2026-09-03T01:00:00') });

  const window = s.dosesBetween(now - 5 * 3600 * 1000, now);
  assert.deepEqual(window.map((d) => d.units), [6, 2],
    'both doses are inside a five-hour window that crosses midnight');

  /* And a dose older than the window is left out of it. */
  s.addDose('2026-09-02', { units: 9, ts: Date.parse('2026-09-02T12:00:00') });
  assert.deepEqual(
    s.dosesBetween(now - 5 * 3600 * 1000, now).map((d) => d.units),
    [6, 2]
  );
});

test('mealsBetween spans the same way doses do', async () => {
  install();
  const s = await freshStore();
  s.init();
  s.addMeal('2026-09-02', { name: 'Late curry', kcal: 700, carb: 80, ts: Date.parse('2026-09-02T23:30:00') });
  s.addMeal('2026-09-03', { name: 'Toast', kcal: 200, carb: 30, ts: Date.parse('2026-09-03T08:00:00') });

  const now = Date.parse('2026-09-03T01:00:00');
  const window = s.mealsBetween(now - 3 * 3600 * 1000, now);
  assert.deepEqual(window.map((m) => m.carb), [80]);
});

test('a dose can be edited and deleted, and an emptied day drops its key', async () => {
  install();
  const s = await freshStore();
  s.init();
  const { dose } = s.addDose('2026-09-02', { units: 4 });

  s.updateDose('2026-09-02', dose.id, { units: 5.5 });
  assert.equal(s.findDose('2026-09-02', dose.id).units, 5.5);
  assert.equal(s.findDose('2026-09-02', dose.id).edited, true);

  assert.equal(s.removeDose('2026-09-02', dose.id), true);
  assert.equal(s.findDose('2026-09-02', dose.id), null);
  assert.equal(s.removeDose('2026-09-02', dose.id), false);
  assert.deepEqual(s.dosesOn('2026-09-02'), []);
});

test('readingsSince gathers glucose wherever it was typed', async () => {
  install();
  const s = await freshStore();
  s.init();
  const today = s.dateKey();
  const now = Date.now();

  s.addDose(today, { units: 6, bg: 180, ts: now - 3600000 });
  s.addDose(today, { units: 0, kind: 'reading', bg: 95, ts: now - 1800000 });
  s.addDose(today, { units: 3, ts: now - 900000 });          // no reading on it

  const readings = s.readingsSince(14);
  assert.deepEqual(readings.map((r) => r.bg), [180, 95]);
});

test('a v2 log gains a dose map without touching its meals', async () => {
  const backing = install();

  /* Exactly what v2 wrote: days and profile, no doses key at all. */
  backing.setItem('ca:v2', JSON.stringify({
    version: 2,
    days: { '2026-09-02': [{ id: 'm1', ts: 1, name: 'Eggs', kcal: 180, slot: 'breakfast' }] },
    profile: { goalKcal: 2000 },
  }));

  const s = await freshStore();
  s.init();
  assert.equal(s.totalsOn('2026-09-02').kcal, 180, 'the meals must survive the migration');
  assert.equal(s.getProfile().goalKcal, 2000);
  assert.deepEqual(s.dosesOn('2026-09-02'), []);

  /* And the new map is writable straight away, which is the whole point. */
  s.addDose('2026-09-02', { units: 4 });
  assert.equal(s.insulinTotalsOn('2026-09-02').bolus, 4);
  assert.equal(JSON.parse(backing.getItem('ca:v2')).version, 3);
});
