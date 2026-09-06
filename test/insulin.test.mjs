/* Tests for public/js/insulin.js — run with: npm run test:insulin

   Pure arithmetic, no DOM and no localStorage, so no stubs are needed.

   The expected values are worked by hand from the published sources rather
   than captured from a run of the code, because a snapshot of the current
   output cannot tell a correct constant from a transposed one. Where a figure
   comes from a paper it is named in the test, so that a future change to a
   constant has to argue with the citation rather than just with the number.

   Sources used below:
     · exponential IOB curve — oref0/Loop, tau/S closed form
     · trend arrows — Dexcom G6/G7 rate definitions; Pettus & Edelman
       adjustment; cross-checked against the Aleppo/Laffel per-ISF table
     · glucose bands and CGM metrics — 2019 International Consensus on Time
       in Range (Battelino et al., Diabetes Care 42:1593)
     · GMI — Bergenstal et al., Diabetes Care 41:2275
     · 500 / 1800 rules, and 450 / 1500 for regular human insulin
*/

import test from 'node:test';
import assert from 'node:assert/strict';

import * as I from '../public/js/insulin.js';

const near = (actual, expected, tol = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tol,
    `expected ${expected} +/- ${tol}, got ${actual}`);

/* A complete, ordinary set of settings: 1 unit per 10 g, 1 unit drops
   50 mg/dL, aiming at 100, rapid-acting insulin over five hours. */
const P = {
  diabetesType: 'type1',
  insulinUse: 'ratio',
  insulinType: 'rapid',
  carbRatio: 10,
  correctionFactor: 50,
  targetBg: 100,
  diaHours: 5,
  doseIncrement: 0.5,
  maxBolus: 15,
  useTrendArrows: false,
  slotRatios: {},
};

/* ------------------------------------------------------------------ units */

test('mg/dL and mmol/L round-trip through the molar mass of glucose', () => {
  /* 100 mg/dL is the textbook 5.55 mmol/L. */
  near(I.mgdlToMmol(100), 5.55, 0.005);
  near(I.mmolToMgdl(5.5), 99.1, 0.05);
  near(I.mmolToMgdl(I.mgdlToMmol(180)), 180, 1e-9);
});

test('display conversion rounds per unit, not per call site', () => {
  assert.equal(I.glucoseOut(180, 'mgdl'), 180);
  assert.equal(I.glucoseOut(180, 'mmoll'), 10);
  /* A whole mg/dL is meaningless precision; a tenth of a mmol/L is not. */
  assert.equal(I.glucoseOut(183, 'mgdl'), 183);
  assert.equal(I.glucoseOut(183, 'mmoll'), 10.2);
  assert.equal(I.glucoseOut(null, 'mgdl'), null);
});

test('glucoseIn is the inverse of the box the user typed into', () => {
  near(I.glucoseIn('180', 'mgdl'), 180);
  near(I.glucoseIn('10', 'mmoll'), 180.18, 0.01);
  assert.ok(Number.isNaN(I.glucoseIn('', 'mgdl')));
});

/* ------------------------------------------------------------------ bands */

test('glucose bands sit on the 2019 consensus cut-points', () => {
  assert.equal(I.glucoseBand(53.9).id, 'urgentLow');
  assert.equal(I.glucoseBand(54).id, 'low');
  assert.equal(I.glucoseBand(69.9).id, 'low');
  assert.equal(I.glucoseBand(70).id, 'inRange');
  assert.equal(I.glucoseBand(180).id, 'inRange');
  assert.equal(I.glucoseBand(180.1).id, 'high');
  assert.equal(I.glucoseBand(250).id, 'high');
  assert.equal(I.glucoseBand(250.1).id, 'veryHigh');
  assert.equal(I.glucoseBand(NaN), null);
});

/* ------------------------------------------------------------- the curve */

test('the IOB curve starts whole, ends at nothing, and never rises', () => {
  const a = I.actionProfile(P);
  assert.equal(a.diaMin, 300);
  assert.equal(a.peakMin, 75);

  assert.equal(I.iobFraction(0, a), 1);
  assert.equal(I.iobFraction(-5, a), 1, 'a dose in the future is entirely unacted');
  assert.equal(I.iobFraction(300, a), 0);
  assert.equal(I.iobFraction(600, a), 0);

  let prev = 1;
  for (let t = 0; t <= 300; t += 5) {
    const v = I.iobFraction(t, a);
    assert.ok(v <= prev + 1e-12, `curve rose between ${t - 5} and ${t} min`);
    assert.ok(v >= 0 && v <= 1, `fraction out of range at ${t} min`);
    prev = v;
  }
});

test('the curve is the exponential model, not a straight line', () => {
  const a = I.actionProfile(P);
  /* The whole point of replacing the linear model. At the 75-minute peak a
     straight line over 300 minutes would say 75% remains; the exponential
     curve says about 67%. And at half the duration the line says 50% where
     the curve says roughly 27% — the tail is far lighter than it looks. */
  near(I.iobFraction(75, a), 0.673, 0.01);
  near(I.iobFraction(150, a), 0.268, 0.01);
  near(I.iobFraction(240, a), 0.033, 0.01);

  const linearAtPeak = 1 - 75 / 300;
  assert.ok(I.iobFraction(75, a) < linearAtPeak - 0.05,
    'at the peak the curve must sit well below the straight line');
});

test('activity peaks at the stated peak time', () => {
  const a = I.actionProfile(P);
  let best = 0;
  let bestT = 0;
  for (let t = 1; t < 300; t++) {
    const v = I.insulinActivity(t, a);
    if (v > best) { best = v; bestT = t; }
  }
  assert.ok(Math.abs(bestT - a.peakMin) <= 2,
    `activity peaked at ${bestT} min, expected near ${a.peakMin}`);
});

test('a peak past half the duration is clamped rather than dividing by zero', () => {
  /* Regular insulin peaks at 150 minutes. Asked for a 2-hour duration — which
     the form allows and which is shorter than the peak — the closed form
     would divide by (1 - 2·150/120), a negative, and hand back a curve that
     runs backwards. */
  const a = I.actionProfile({ insulinType: 'regular', diaHours: 2 });
  assert.ok(a.peakMin < a.diaMin / 2, 'peak must stay under half the duration');
  for (let t = 0; t <= 120; t += 5) {
    const v = I.iobFraction(t, a);
    assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `bad fraction ${v} at ${t} min`);
  }
});

test('each insulin class carries its published peak', () => {
  assert.equal(I.insulinById('ultraRapid').peakMin, 55);
  assert.equal(I.insulinById('rapid').peakMin, 75);
  assert.equal(I.insulinById('regular').peakMin, 150);
  /* Ultra-rapid is on and off faster, so at any point it must have less left
     to act than rapid-acting given the same duration. */
  const ur = I.actionProfile({ insulinType: 'ultraRapid', diaHours: 5 });
  const ra = I.actionProfile({ insulinType: 'rapid', diaHours: 5 });
  for (const t of [30, 60, 120, 180]) {
    assert.ok(I.iobFraction(t, ur) < I.iobFraction(t, ra), `no separation at ${t} min`);
  }
});

/* --------------------------------------------------------- the window */

test('insulin on board sums the live doses and ignores the finished ones', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0);
  const min = (n) => now - n * 60000;
  const doses = [
    { id: 'a', ts: min(60), units: 6 },
    { id: 'b', ts: min(400), units: 10 },   // past a five-hour duration
    { id: 'c', ts: min(30), units: 2, kind: 'basal' },  // long-acting
    { id: 'd', ts: min(10), units: 0 },     // a reading, no insulin
  ];
  const iob = I.insulinOnBoard(doses, now, P);

  const a = I.actionProfile(P);
  near(iob.units, 6 * I.iobFraction(60, a), 0.01);
  assert.deepEqual(iob.parts.map((p) => p.id), ['a']);
});

test('long-acting insulin is deliberately excluded from the window', () => {
  const now = Date.now();
  const withBasal = I.insulinOnBoard([{ id: 'b', ts: now - 3600000, units: 24, kind: 'basal' }], now, P);
  assert.equal(withBasal.units, 0,
    'counting basal here would suppress every meal dose of the day');
});

test('a dose in the future does not count against the present', () => {
  const now = Date.now();
  const iob = I.insulinOnBoard([{ id: 'x', ts: now + 600000, units: 5 }], now, P);
  assert.equal(iob.units, 0);
});

test('carbs on board decay linearly and expire', () => {
  const now = Date.now();
  const meals = [
    { ts: now - 90 * 60000, carb: 60 },    // halfway through three hours
    { ts: now - 240 * 60000, carb: 100 },  // finished
  ];
  assert.equal(I.carbsOnBoard(meals, now, P), 30);
  assert.equal(I.carbsOnBoard([], now, P), 0);
});

/* ------------------------------------------------------------ rounding */

test('doses round to what the pen can dial', () => {
  assert.equal(I.roundDose(4.37, 0.5), 4.5);
  assert.equal(I.roundDose(4.2, 0.5), 4);
  assert.equal(I.roundDose(4.2, 1), 4);
  assert.equal(I.roundDose(4.6, 1), 5);
  /* Float noise must not reach a screen: 2.5000000000000004 is not a dose. */
  assert.equal(I.roundDose(2.4999999, 0.5), 2.5);
  assert.equal(I.roundDose(NaN, 0.5), null);
});

/* --------------------------------------------------------------- doses */

test('a plain meal dose is grams over the ratio', () => {
  const d = I.bolus({ carbGrams: 60, profile: P });
  assert.equal(d.usable, true);
  near(d.carbDose, 6);
  assert.equal(d.correctionRaw, 0, 'no reading means no correction either way');
  assert.equal(d.units, 6);
});

test('a correction is the distance from target over the sensitivity factor', () => {
  /* 250 is 150 above a target of 100; at 50 mg/dL a unit that is 3 units, on
     top of 6 for the food. */
  const d = I.bolus({ carbGrams: 60, bg: 250, profile: P });
  near(d.correctionRaw, 3);
  near(d.total, 9);
  assert.equal(d.units, 9);
});

test('below target the correction is negative and trims the meal dose', () => {
  /* 75 is 25 under target: half a unit comes off the six for the food. */
  const d = I.bolus({ carbGrams: 60, bg: 75, profile: P });
  near(d.correctionRaw, -0.5);
  near(d.total, 5.5);
  assert.equal(d.units, 5.5);
});

test('active insulin comes off the correction and never off the food', () => {
  /* This is the pump-standard behaviour — Tandem, Medtronic, Omnipod — and
     the reason for it is that the carbohydrate still has to be covered. */
  const withIob = I.bolus({ carbGrams: 60, bg: 250, iob: 2, profile: P });
  near(withIob.iobApplied, 2);
  near(withIob.correction, 1);
  near(withIob.total, 7, 0.001);

  /* More active insulin than the correction calls for zeroes the correction
     and stops there: the six units of food dose survive intact. */
  const swamped = I.bolus({ carbGrams: 60, bg: 250, iob: 9, profile: P });
  near(swamped.iobApplied, 3);
  near(swamped.correction, 0);
  near(swamped.total, 6);

  /* And with no correction to take it from, active insulin changes nothing. */
  const noCorrection = I.bolus({ carbGrams: 60, iob: 4, profile: P });
  assert.equal(noCorrection.iobApplied, 0);
  near(noCorrection.total, 6);
});

test('active insulin does not double-count against a below-target reading', () => {
  /* The negative correction already trims the dose. Subtracting IOB on top of
     it would count the same insulin twice and under-dose the meal. */
  const d = I.bolus({ carbGrams: 60, bg: 75, iob: 3, profile: P });
  assert.equal(d.iobApplied, 0);
  near(d.correction, -0.5);
  near(d.total, 5.5);
});

test('below range no dose is suggested at all', () => {
  const d = I.bolus({ carbGrams: 60, bg: 65, profile: P });
  assert.equal(d.holdForLow, true);
  assert.equal(d.usable, false);
  assert.equal(d.units, null, 'a number here invites somebody to take it');
  assert.equal(d.warnings[0].tone, 'risk');

  /* 70 is the bottom of the target range, so it is dosed, not held. */
  const atSeventy = I.bolus({ carbGrams: 60, bg: 70, profile: P });
  assert.equal(atSeventy.holdForLow, false);
  assert.equal(atSeventy.usable, true);
});

test('an urgent low is worded differently from a level 1 low', () => {
  const urgent = I.bolus({ carbGrams: 30, bg: 50, profile: P });
  const low = I.bolus({ carbGrams: 30, bg: 65, profile: P });
  assert.match(urgent.warnings[0].text, /urgent low/i);
  assert.doesNotMatch(low.warnings[0].text, /urgent/i);
  assert.match(low.warnings[0].text, /15 g/);
});

test('a very high reading raises the ketone warning', () => {
  const d = I.bolus({ carbGrams: 30, bg: 300, profile: P });
  assert.ok(d.warnings.some((w) => /ketones/i.test(w.text)));
  const fine = I.bolus({ carbGrams: 30, bg: 200, profile: P });
  assert.ok(!fine.warnings.some((w) => /ketones/i.test(w.text)));
});

test('the ceiling holds and says the number it held', () => {
  const d = I.bolus({ carbGrams: 300, profile: P });
  assert.equal(d.capped, true);
  assert.equal(d.units, 15);
  assert.ok(d.warnings.some((w) => /30/.test(w.text)), 'the un-capped figure must be printed');
});

test('a total that comes out negative is floored at zero, not inverted', () => {
  /* 40 g of carbohydrate is 4 units; a reading of 100 below target takes off
     2 — but 20 g at 200 below target would otherwise ask for negative
     insulin, which is not a thing a pen can do. */
  const d = I.bolus({ carbGrams: 10, bg: 70, profile: { ...P, correctionFactor: 10 } });
  assert.equal(d.total, 0);
  assert.equal(d.units, 0);
});

test('a per-meal ratio overrides the everyday one, and says so', () => {
  const p = { ...P, slotRatios: { breakfast: 6 } };
  const breakfast = I.bolus({ carbGrams: 60, slot: 'breakfast', profile: p });
  const dinner = I.bolus({ carbGrams: 60, slot: 'dinner', profile: p });

  assert.equal(breakfast.ratio, 6);
  assert.equal(breakfast.slotRatioUsed, true);
  assert.equal(breakfast.units, 10);

  assert.equal(dinner.ratio, 10);
  assert.equal(dinner.slotRatioUsed, false);
  assert.equal(dinner.units, 6);
});

test('a corrections-only regimen doses the glucose and not the food', () => {
  const p = { ...P, insulinUse: 'correction', carbRatio: null };
  const d = I.bolus({ carbGrams: 90, bg: 250, profile: p });
  assert.equal(d.carbDose, 0, '90 g must not become 9 units for someone not counting carbs');
  near(d.total, 3);
});

test('someone who takes no mealtime insulin gets no suggestion', () => {
  const d = I.bolus({ carbGrams: 60, bg: 250, profile: { ...P, insulinUse: 'none' } });
  assert.equal(d.usable, false);
  assert.equal(d.units, null);
});

test('missing settings produce no dose rather than a wrong one', () => {
  assert.equal(I.bolus({ carbGrams: 60, profile: { ...P, carbRatio: null } }).usable, false);
  assert.equal(I.bolus({ carbGrams: 60, profile: { ...P, correctionFactor: 0 } }).usable, false);
  assert.equal(I.bolus({ carbGrams: 60, profile: { ...P, targetBg: null } }).usable, false);
});

/* -------------------------------------------------------- trend arrows */

test('trend arrows are ignored unless they are switched on', () => {
  const off = I.bolus({ carbGrams: 0, bg: 150, trend: 'doubleUp', profile: P });
  assert.equal(off.trendDelta, 0);
  near(off.correctionRaw, 1);

  const on = I.bolus({ carbGrams: 0, bg: 150, trend: 'doubleUp', profile: { ...P, useTrendArrows: true } });
  assert.equal(on.trendDelta, 100);
  assert.equal(on.adjustedBg, 250);
  near(on.correctionRaw, 3);
});

test('the arrow table carries the Pettus-Edelman adjustments', () => {
  const byId = Object.fromEntries(I.TREND.map((t) => [t.id, t.delta]));
  assert.deepEqual(byId, {
    doubleUp: 100, up: 75, upSlow: 50, flat: 0, downSlow: -50, down: -75, doubleDown: -100,
  });
  /* Symmetric by construction: the method adds and subtracts the same
     predicted movement. */
  assert.equal(byId.doubleUp, -byId.doubleDown);
  assert.equal(byId.up, -byId.down);
  assert.equal(byId.upSlow, -byId.downSlow);
});

test('the arrows carry the Dexcom rate definitions', () => {
  const rate = Object.fromEntries(I.TREND.map((t) => [t.id, t.rate]));
  assert.match(rate.doubleUp, /more than 3 mg\/dL/);
  assert.match(rate.up, /2–3 mg\/dL/);
  assert.match(rate.upSlow, /1–2 mg\/dL/);
  assert.match(rate.flat, /under 1 mg\/dL/);
  assert.match(rate.doubleDown, /more than 3 mg\/dL/);

  /* And the half-hour projections those rates imply. */
  const per30 = Object.fromEntries(I.TREND.map((t) => [t.id, t.per30]));
  assert.equal(per30.doubleUp, 90);
  assert.equal(per30.flat, 0);
  assert.equal(per30.doubleDown, -90);
});

test('Pettus-Edelman agrees with the Aleppo per-ISF table to within a unit', () => {
  /* The Endocrine Society quotes Aleppo/Laffel as a table of unit adjustments
     banded by correction factor. This app uses Pettus-Edelman instead, which
     shifts the glucose value and lets the person's own factor do the
     division — so the two are independent methods and their agreement is a
     real check on the constants, not a tautology.

     Aleppo, adults, pre-meal, for the four ISF bands. */
  const aleppo = [
    { isf: 20, row: { doubleUp: 4.5, up: 3.5, upSlow: 2.5, flat: 0, downSlow: -2.5, down: -3.5, doubleDown: -4.5 } },
    { isf: 35, row: { doubleUp: 3.5, up: 2.5, upSlow: 1.5, flat: 0, downSlow: -1.5, down: -2.5, doubleDown: -3.5 } },
    { isf: 60, row: { doubleUp: 2.5, up: 1.5, upSlow: 1.0, flat: 0, downSlow: -1.0, down: -1.5, doubleDown: -2.5 } },
    { isf: 90, row: { doubleUp: 1.5, up: 1.0, upSlow: 0.5, flat: 0, downSlow: -0.5, down: -1.0, doubleDown: -1.0 } },
  ];

  for (const { isf, row } of aleppo) {
    for (const arrow of I.TREND) {
      const ours = arrow.delta / isf;
      const theirs = row[arrow.id];
      assert.ok(Math.abs(ours - theirs) <= 1.0,
        `${arrow.id} at ISF ${isf}: this app says ${ours.toFixed(2)} u, Aleppo says ${theirs} u`);
    }
  }
});

test('a falling arrow reduces the dose and can zero a correction', () => {
  const p = { ...P, useTrendArrows: true };
  /* 160 with a double-down arrow is treated as 60 — below target — so the
     correction goes negative and trims the food dose rather than adding. */
  const d = I.bolus({ carbGrams: 60, bg: 160, trend: 'doubleDown', profile: p });
  assert.equal(d.adjustedBg, 60);
  near(d.correctionRaw, -0.8);
  near(d.total, 5.2);
  /* The reading itself is still in range, so this is a dose and not a hold. */
  assert.equal(d.holdForLow, false);
});

/* ----------------------------------------------------- the sliding scale */

test('the sliding scale is the calculator, laid out flat', () => {
  const rows = I.correctionScale(P);
  const at = (mgdl) => rows.find((r) => r.mgdl === mgdl);

  assert.ok(at(100).isTarget, 'the target must be a row of its own');
  assert.equal(at(100).units, 0);
  assert.equal(at(180).units, 1.5);   // 80 over target ÷ 50
  assert.equal(at(250).units, 3);     // 150 over target ÷ 50
  assert.equal(at(400).units, 6);
  assert.equal(at(70).below, true, 'under target reads as a trim, not a dose');

  /* The consensus thresholds are always present, whatever the step lands on. */
  assert.ok(at(180) && at(250));

  /* And every row must match what bolus() would say for the same reading, or
     the table on the account screen is quietly lying about the app. */
  for (const r of rows) {
    if (r.below || r.mgdl < I.RANGE.low) continue;
    const d = I.bolus({ carbGrams: 0, bg: r.mgdl, profile: P });
    assert.equal(r.units, d.units, `scale and calculator disagree at ${r.mgdl} mg/dL`);
  }
});

test('the carb ladder matches the ratio it was built from', () => {
  const rows = I.carbScale(P, null);
  assert.equal(rows[0].grams, 15);
  assert.equal(rows[0].units, 1.5);
  assert.equal(rows.at(-1).grams, 120);
  assert.equal(rows.at(-1).units, 12);

  for (const r of rows) {
    assert.equal(r.units, I.bolus({ carbGrams: r.grams, profile: P }).units);
  }
});

test('the scale is empty rather than wrong when the settings are not set', () => {
  assert.deepEqual(I.correctionScale({}), []);
  assert.deepEqual(I.carbScale({}, null), []);
});

/* --------------------------------------------------------- rules of thumb */

test('the 500 and 1800 rules divide the total daily dose', () => {
  const r = I.ruleOfThumb(50, P);
  assert.equal(r.carbRatio, 10);          // 500 / 50
  assert.equal(r.correctionFactor, 36);   // 1800 / 50

  /* Regular human insulin does less per unit, so it takes the lower pair. */
  const reg = I.ruleOfThumb(50, { insulinType: 'regular' });
  assert.equal(reg.carbRatio, 9);         // 450 / 50
  assert.equal(reg.correctionFactor, 30); // 1500 / 50

  assert.equal(I.ruleOfThumb(0, P), null);
  assert.equal(I.ruleOfThumb(undefined, P), null);
});

test('a ratio entered upside down is caught by the cross-check', () => {
  /* 1 unit per 1 g, on a 50 unit day, is a tenfold overdose waiting to
     happen. The rule of thumb is not precise, but it is precise enough for
     this. */
  const checks = I.settingsChecks({ ...P, carbRatio: 1, tdd: 50 });
  assert.ok(checks.some((c) => c.field === 'carbRatio'));

  /* And a ratio near the rule raises nothing. */
  assert.deepEqual(I.settingsChecks({ ...P, carbRatio: 10, correctionFactor: 36, tdd: 50 }), []);

  /* No total daily dose means no cross-check, not a false alarm. */
  assert.deepEqual(I.settingsChecks({ ...P, carbRatio: 1 }), []);
});

/* --------------------------------------------------------- CGM metrics */

test('glucose statistics are the consensus metrics', () => {
  const readings = [
    { bg: 50 },   // level 2 low
    { bg: 65 },   // level 1 low
    { bg: 100 }, { bg: 120 }, { bg: 140 }, { bg: 160 },  // in range
    { bg: 200 },  // level 1 high
    { bg: 300 },  // level 2 high
  ];
  const s = I.glucoseStats(readings);

  assert.equal(s.count, 8);
  assert.equal(s.inRange, 50);     // 4 of 8
  assert.equal(s.below70, 25);     // 50 and 65
  assert.equal(s.below54, 13);     // 50 alone, rounded from 12.5
  assert.equal(s.above180, 25);    // 200 and 300
  assert.equal(s.above250, 13);    // 300 alone
  assert.equal(s.sparse, true, 'eight hand-typed readings are not a CGM trace');
});

test('GMI is the Bergenstal regression, not an A1c', () => {
  /* 3.31 + 0.02392 x mean. A mean of 154 mg/dL is the canonical 7.0%. */
  const s = I.glucoseStats([{ bg: 154 }]);
  near(s.gmi, 7, 0.05);
  const higher = I.glucoseStats([{ bg: 200 }]);
  near(higher.gmi, 8.1, 0.05);
});

test('coefficient of variation is the standard deviation over the mean', () => {
  const s = I.glucoseStats([{ bg: 100 }, { bg: 100 }, { bg: 100 }]);
  assert.equal(s.cv, 0);
  assert.equal(s.mean, 100);
  assert.equal(I.glucoseStats([]), null);
});

/* ------------------------------------------------------------ validation */

test('validation stops at the first gate that closes the rest', () => {
  assert.ok(I.validate({}).diabetesType);
  /* Answering "no" ends it — no carb ratio is demanded of someone without
     diabetes. */
  assert.deepEqual(I.validate({ diabetesType: 'none' }), {});
  /* And so does taking no mealtime insulin. */
  assert.deepEqual(I.validate({ diabetesType: 'type2', insulinUse: 'none' }), {});
});

test('the plausible ranges catch the dangerous typos', () => {
  const base = { diabetesType: 'type1', insulinUse: 'ratio', insulinType: 'rapid' };
  const e = I.validate({ ...base, carbRatio: 500, correctionFactor: 1000, targetBg: 40 });
  assert.ok(e.carbRatio);
  assert.ok(e.correctionFactor);
  assert.ok(e.targetBg);

  assert.deepEqual(
    I.validate({ ...base, carbRatio: 10, correctionFactor: 50, targetBg: 110 }),
    {}
  );
});

test('a corrections-only regimen is not asked for a carb ratio', () => {
  const e = I.validate({
    diabetesType: 'type2', insulinUse: 'correction', insulinType: 'rapid',
    correctionFactor: 50, targetBg: 110,
  });
  assert.deepEqual(e, {});
});

test('a blank per-meal ratio is allowed; a nonsense one is not', () => {
  const base = {
    diabetesType: 'type1', insulinUse: 'ratio', insulinType: 'rapid',
    carbRatio: 10, correctionFactor: 50, targetBg: 110,
  };
  assert.deepEqual(I.validate({ ...base, slotRatios: { breakfast: '', lunch: null } }), {});
  assert.ok(I.validate({ ...base, slotRatios: { breakfast: 0 } })['slotRatio.breakfast']);
  assert.ok(I.validate({ ...base, slotRatios: { dinner: 900 } })['slotRatio.dinner']);
});
