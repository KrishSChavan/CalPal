/* Tests for public/js/profile.js — run with: npm run test:profile
   Pure arithmetic, no DOM and no localStorage, so no stubs are needed. The
   expected values are worked by hand from the published equations rather than
   copied from a run of the code, which is the only way this catches a sign
   flip or a transposed constant. */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../public/js/profile.js';

const near = (actual, expected, tol = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tol,
    `expected ${expected} +/- ${tol}, got ${actual}`);

/* ------------------------------------------------------------------ units */

test('pounds and kilograms round-trip', () => {
  near(P.lbToKg(220.462), 100, 0.001);
  near(P.kgToLb(100), 220.462, 0.001);
  near(P.kgToLb(P.lbToKg(165)), 165, 1e-9);
});

test('feet and inches convert as one measurement', () => {
  near(P.ftInToCm(5, 10), 177.8);
  /* Inches alone is legal input and must not be rejected as a missing feet. */
  near(P.ftInToCm(0, 70), 177.8);
  near(P.ftInToCm(6, 0), 182.88);
});

test('cmToFtIn carries 12 inches into a foot', () => {
  assert.deepEqual(P.cmToFtIn(177.8), { ft: 5, in: 10 });
  assert.deepEqual(P.cmToFtIn(182.88), { ft: 6, in: 0 });
  /* 71.6 in rounds to 72, which is 6'0" and not 5'12". */
  assert.deepEqual(P.cmToFtIn(181.9), { ft: 6, in: 0 });
});

/* -------------------------------------------------------------------- BMI */

test('BMI is kg over metres squared', () => {
  near(P.bmi(80, 180), 24.691, 0.001);
  near(P.bmi(100, 200), 25, 0.001);
});

test('BMI rejects nonsense rather than returning a number', () => {
  assert.equal(P.bmi(0, 180), null);
  assert.equal(P.bmi(80, 0), null);
  assert.equal(P.bmi(NaN, 180), null);
  assert.equal(P.bmi(undefined, undefined), null);
});

test('BMI bands sit on the WHO cut-points', () => {
  assert.equal(P.bmiBand(18.49).id, 'under');
  assert.equal(P.bmiBand(18.5).id, 'healthy');
  assert.equal(P.bmiBand(24.99).id, 'healthy');
  assert.equal(P.bmiBand(25).id, 'over');
  assert.equal(P.bmiBand(29.99).id, 'over');
  assert.equal(P.bmiBand(30).id, 'obese');
  assert.equal(P.bmiBand(NaN), null);
});

/* -------------------------------------------------------------------- BMR */

test('Mifflin-St Jeor, worked by hand', () => {
  /* male, 80 kg, 180 cm, 30 y: 800 + 1125 - 150 + 5 */
  assert.equal(P.bmr({ weightKg: 80, heightCm: 180, age: 30, sex: 'male' }), 1780);
  /* female, 60 kg, 165 cm, 30 y: 600 + 1031.25 - 150 - 161 */
  assert.equal(P.bmr({ weightKg: 60, heightCm: 165, age: 30, sex: 'female' }), 1320.25);
});

test('the sex constant is the only thing that differs between sexes', () => {
  const body = { weightKg: 70, heightCm: 170, age: 40 };
  const male = P.bmr({ ...body, sex: 'male' });
  const female = P.bmr({ ...body, sex: 'female' });
  assert.equal(male - female, 166);
  /* Withheld takes the midpoint, so it sits exactly between the two. */
  assert.equal(P.bmr({ ...body, sex: 'unspecified' }), (male + female) / 2);
});

test('BMR refuses incomplete or impossible input', () => {
  assert.equal(P.bmr({ weightKg: 80, heightCm: 180, age: 30, sex: 'other' }), null);
  assert.equal(P.bmr({ weightKg: 80, heightCm: 180, sex: 'male' }), null);
  assert.equal(P.bmr({ weightKg: -80, heightCm: 180, age: 30, sex: 'male' }), null);
  assert.equal(P.bmr(), null);
});

/* ------------------------------------------------------------- the target */

test('target is BMR x activity, plus the goal delta', () => {
  const out = P.dailyTarget({
    weightKg: 80, heightCm: 180, age: 30, sex: 'male',
    activity: 'moderate', goal: 'lose',
  });
  assert.equal(out.bmr, 1780);
  assert.equal(out.maintenance, Math.round(1780 * 1.55)); // 2759
  assert.equal(out.goalDelta, -500);
  assert.equal(out.target, 2259);
  assert.equal(out.floored, false);
});

test('maintain leaves the target at maintenance', () => {
  const out = P.dailyTarget({
    weightKg: 80, heightCm: 180, age: 30, sex: 'male',
    activity: 'sedentary', goal: 'maintain',
  });
  assert.equal(out.target, out.maintenance);
  assert.equal(out.goalDelta, 0);
});

/* The clamp is the one piece of the arithmetic that can silently produce a
   number that is NOT maintenance plus the delta, so it has to announce it. */
test('a deficit is clamped at the floor and says so', () => {
  const small = {
    weightKg: 45, heightCm: 150, age: 60, sex: 'female',
    activity: 'sedentary', goal: 'lose',
  };
  const out = P.dailyTarget(small);
  /* 450 + 937.5 - 300 - 161 = 926.5 BMR; x1.2 = 1111.8; -500 = 611.8 */
  assert.ok(out.maintenance + out.goalDelta < out.floor);
  assert.equal(out.floored, true);
  assert.equal(out.target, 1200);
  assert.equal(out.floor, 1200);
});

test('the floor differs by sex and is never crossed', () => {
  for (const sex of ['male', 'female', 'unspecified']) {
    const out = P.dailyTarget({
      weightKg: 40, heightCm: 145, age: 70, sex,
      activity: 'sedentary', goal: 'lose',
    });
    assert.equal(out.target, out.floor);
    assert.ok(out.target >= (sex === 'male' ? 1500 : 1200));
  }
});

test('target refuses to compute from a half-filled profile', () => {
  assert.equal(P.dailyTarget(null), null);
  assert.equal(P.dailyTarget({ weightKg: 80, heightCm: 180, age: 30, sex: 'male' }), null);
  assert.equal(P.dailyTarget({
    weightKg: 80, heightCm: 180, age: 30, sex: 'male', activity: 'bogus', goal: 'lose',
  }), null);
});

test('every activity multiplier is monotonic in the target', () => {
  const base = { weightKg: 80, heightCm: 180, age: 30, sex: 'male', goal: 'maintain' };
  const targets = P.ACTIVITY.map((a) => P.dailyTarget({ ...base, activity: a.id }).target);
  for (let i = 1; i < targets.length; i++) {
    assert.ok(targets[i] > targets[i - 1], `${P.ACTIVITY[i].id} is not above ${P.ACTIVITY[i - 1].id}`);
  }
});

/* -------------------------------------------------------------- validation */

test('validate catches the decimal-point-in-the-wrong-place case', () => {
  const errors = P.validate({
    heightCm: 1750, weightKg: 80, age: 30, sex: 'male', activity: 'moderate', goal: 'lose',
  });
  assert.ok(errors.heightCm);
  assert.equal(Object.keys(errors).length, 1);
});

test('validate names every missing field on an empty profile', () => {
  const errors = P.validate({});
  assert.deepEqual(
    Object.keys(errors).sort(),
    ['activity', 'age', 'goal', 'heightCm', 'sex', 'weightKg']
  );
});

test('a complete profile validates clean', () => {
  const p = {
    heightCm: 180, weightKg: 80, age: 30, sex: 'male', activity: 'moderate', goal: 'lose',
  };
  assert.deepEqual(P.validate(p), {});
  assert.equal(P.isComplete(p), true);
  assert.equal(P.isComplete({ ...p, age: 30.5 }), false); // whole years only
  assert.equal(P.isComplete({ ...p, age: 12 }), false);
  assert.equal(P.isComplete({ ...p, age: 101 }), false);
});

/* --------------------------------------------------------------- progress */

test('consumption reports the ratio, the remainder and the band', () => {
  const c = P.consumption(1240, 2150);
  assert.equal(c.percent, 58);
  assert.equal(c.remaining, 910);
  assert.equal(c.over, false);
  assert.equal(c.band, 'under');
  near(c.fill, 0.5767, 0.0001);
});

test('past the goal the fill pins but the ratio does not', () => {
  const c = P.consumption(3000, 2000);
  assert.equal(c.fill, 1);          // the bar cannot draw past its own end
  assert.equal(c.ratio, 1.5);       // but the overshoot is still reportable
  assert.equal(c.remaining, -1000);
  assert.equal(c.over, true);
  assert.equal(c.band, 'over');
});

test('the near band opens at 85% and closes at the goal', () => {
  assert.equal(P.consumption(849, 1000).band, 'under');
  assert.equal(P.consumption(850, 1000).band, 'near');
  assert.equal(P.consumption(1000, 1000).band, 'near');
  assert.equal(P.consumption(1001, 1000).band, 'over');
});

/* No goal is not a goal of zero. Returning a zeroed object here would paint an
   empty bar and imply a target the day simply had not been eaten into. */
test('no target yields null, not an empty bar', () => {
  assert.equal(P.consumption(500, 0), null);
  assert.equal(P.consumption(500, null), null);
  assert.equal(P.consumption(500, undefined), null);
  assert.equal(P.consumption(500, NaN), null);
});

test('an empty day against a real target is a full remainder', () => {
  const c = P.consumption(0, 2000);
  assert.equal(c.fill, 0);
  assert.equal(c.percent, 0);
  assert.equal(c.remaining, 2000);
  assert.equal(c.band, 'under');
});
