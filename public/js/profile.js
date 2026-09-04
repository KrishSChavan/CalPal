/* ==========================================================================
   profile.js — height, weight, and the arithmetic that turns them into a
   daily calorie target.

   No DOM and no storage in this file. Everything here is a pure function of
   its arguments, which is what lets test/profile.test.mjs check the numbers
   against the published formulas instead of against a screenshot.

   BMI is displayed because it was asked for, but it is NOT what sets the
   target and it cannot be: BMI is kg/m², a ratio with no energy term in it.
   The target comes from Mifflin-St Jeor (1990), the equation the Academy of
   Nutrition and Dietetics recommends for resting energy in non-obese and
   obese adults alike, multiplied by an activity factor.

   The honest limits, stated here so the screens can repeat them:
     · Mifflin-St Jeor lands within 10% of measured RMR for roughly 80% of
       people. The other 20% are off by more than that, in both directions.
     · The activity multipliers are coarse bands, not measurements. They are
       the single largest source of error in the final number.
     · "1 lb a week from a 500 kcal deficit" is the Wishnofsky rule. It holds
       early and then overstates loss, because resting burn falls as mass
       does — so the copy says "to start with" rather than promising a rate.
   ========================================================================== */

/* ----------------------------------------------------------------- units */

export const LB_PER_KG = 2.2046226218;
export const CM_PER_IN = 2.54;

export const lbToKg = (lb) => lb / LB_PER_KG;
export const kgToLb = (kg) => kg * LB_PER_KG;
export const inToCm = (inches) => inches * CM_PER_IN;
export const cmToIn = (cm) => cm / CM_PER_IN;

/* Feet and inches are one measurement wearing two boxes, so they convert as a
   pair. Inches alone is legal input (0 ft, 68 in) and must not be rejected. */
export const ftInToCm = (ft, inches) => inToCm(Number(ft || 0) * 12 + Number(inches || 0));

export function cmToFtIn(cm) {
  const total = Math.round(cmToIn(cm));
  return { ft: Math.floor(total / 12), in: total % 12 };
}

/* --------------------------------------------------------------- ranges */

/* Wide enough to admit every real person, tight enough to catch a decimal
   point typed in the wrong place — which is the actual failure mode here,
   since a 1750 cm height would otherwise yield a cheerful 12,000 kcal goal. */
export const LIMITS = {
  heightCm: { min: 90, max: 250 },
  weightKg: { min: 25, max: 350 },
  age: { min: 13, max: 100 },
};

/* Mifflin-St Jeor was derived and validated on adults. Below 18 it is being
   used outside the population it was fitted to, so the summary says so rather
   than pretending the number carries the same weight. */
export const ADULT_AGE = 18;

/* ------------------------------------------------------------- constants */

/* The sex term is a single additive constant in Mifflin-St Jeor, and the
   equation offers exactly two. "Prefer not to say" takes the midpoint of the
   two — not a third measured value, just the least-wrong number available
   when the input is withheld, and the summary labels it as an approximation. */
export const SEXES = [
  { id: 'female', label: 'Female', constant: -161, floor: 1200 },
  { id: 'male', label: 'Male', constant: 5, floor: 1500 },
  { id: 'unspecified', label: 'Prefer not to say', constant: -78, floor: 1200 },
];

export const ACTIVITY = [
  { id: 'sedentary', factor: 1.2, label: 'Sedentary', detail: 'Desk job, little or no exercise' },
  { id: 'light', factor: 1.375, label: 'Lightly active', detail: 'Light exercise 1–3 days a week' },
  { id: 'moderate', factor: 1.55, label: 'Moderately active', detail: 'Moderate exercise 3–5 days a week' },
  { id: 'active', factor: 1.725, label: 'Very active', detail: 'Hard exercise 6–7 days a week' },
  { id: 'athlete', factor: 1.9, label: 'Extremely active', detail: 'Physical job, or training twice a day' },
];

export const GOALS = [
  { id: 'lose', delta: -500, label: 'Lose weight', detail: 'About 1 lb a week to start with' },
  { id: 'maintain', delta: 0, label: 'Stay where I am', detail: 'Eat roughly what you burn' },
  { id: 'gain', delta: 300, label: 'Gain weight', detail: 'Around half a pound a week, gained slowly' },
];

export const sexById = (id) => SEXES.find((s) => s.id === id) || null;
export const activityById = (id) => ACTIVITY.find((a) => a.id === id) || null;
export const goalById = (id) => GOALS.find((g) => g.id === id) || null;

/* ------------------------------------------------------------------ BMI */

export function bmi(weightKg, heightCm) {
  const kg = Number(weightKg);
  const cm = Number(heightCm);
  if (!Number.isFinite(kg) || !Number.isFinite(cm) || kg <= 0 || cm <= 0) return null;
  const m = cm / 100;
  return kg / (m * m);
}

/* WHO/CDC adult cut-points. They are population screening bands and say
   nothing about one body's composition — a lifter and a sedentary person of
   the same mass land in the same band — so BMI_CAVEAT travels with the label
   rather than being left for the reader to remember. */
export function bmiBand(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  if (v < 18.5) return { id: 'under', label: 'Underweight', tone: 'warn' };
  if (v < 25) return { id: 'healthy', label: 'Healthy weight', tone: 'ok' };
  if (v < 30) return { id: 'over', label: 'Overweight', tone: 'warn' };
  return { id: 'obese', label: 'Obese', tone: 'risk' };
}

export const BMI_CAVEAT =
  'BMI is a screening ratio, not a body-fat measurement — it counts muscle and fat the same.';

/* ------------------------------------------------------------------ BMR */

/* Mifflin-St Jeor: 10·kg + 6.25·cm − 5·age + the sex constant. */
export function bmr({ weightKg, heightCm, age, sex } = {}) {
  const kg = Number(weightKg);
  const cm = Number(heightCm);
  const yrs = Number(age);
  const s = sexById(sex);
  if (!s) return null;
  if (![kg, cm, yrs].every(Number.isFinite)) return null;
  if (kg <= 0 || cm <= 0 || yrs <= 0) return null;
  return 10 * kg + 6.25 * cm - 5 * yrs + s.constant;
}

/* ------------------------------------------------------------ the target */

/* Returns every intermediate value, not just the final figure, so the summary
   screen can show its working. A target the user cannot audit is a number
   they have no reason to trust — the same argument the confirm sheet already
   makes for showing the FNDDS row behind every component. */
export function dailyTarget(profile) {
  if (!profile) return null;
  const base = bmr(profile);
  const act = activityById(profile.activity);
  const goal = goalById(profile.goal);
  if (base == null || !act || !goal) return null;

  const maintenance = base * act.factor;
  const raw = maintenance + goal.delta;

  /* A deficit applied to a small person can land under the point where a diet
     stops being able to carry its own micronutrients. Clamp rather than emit
     it, and hand back `floored` so the screen can explain the clamp instead
     of silently showing a number that is not maintenance minus 500. */
  const { floor } = sexById(profile.sex);
  const floored = raw < floor;

  return {
    bmr: Math.round(base),
    activityFactor: act.factor,
    maintenance: Math.round(maintenance),
    goalDelta: goal.delta,
    target: Math.round(floored ? floor : raw),
    floor,
    floored,
  };
}

/* ------------------------------------------------------------ validation */

/* One validator for the whole profile, returning a field-keyed map of
   messages. The step screens ask it about the fields they own; the summary
   asks it about all of them before it will commit anything. */
export function validate(profile) {
  const errors = {};
  const p = profile || {};

  const cm = Number(p.heightCm);
  if (!Number.isFinite(cm) || cm <= 0) errors.heightCm = 'Enter your height.';
  else if (cm < LIMITS.heightCm.min || cm > LIMITS.heightCm.max) {
    errors.heightCm = `That height is outside ${LIMITS.heightCm.min}–${LIMITS.heightCm.max} cm. Check the units.`;
  }

  const kg = Number(p.weightKg);
  if (!Number.isFinite(kg) || kg <= 0) errors.weightKg = 'Enter your weight.';
  else if (kg < LIMITS.weightKg.min || kg > LIMITS.weightKg.max) {
    errors.weightKg = `That weight is outside ${LIMITS.weightKg.min}–${LIMITS.weightKg.max} kg. Check the units.`;
  }

  const age = Number(p.age);
  if (!Number.isFinite(age) || age <= 0) errors.age = 'Enter your age.';
  else if (!Number.isInteger(age) || age < LIMITS.age.min || age > LIMITS.age.max) {
    errors.age = `Enter a whole age between ${LIMITS.age.min} and ${LIMITS.age.max}.`;
  }

  if (!sexById(p.sex)) errors.sex = 'Pick one so the equation has its constant.';
  if (!activityById(p.activity)) errors.activity = 'Pick the closest week.';
  if (!goalById(p.goal)) errors.goal = 'Pick what you are aiming for.';

  return errors;
}

export const isComplete = (profile) => Object.keys(validate(profile)).length === 0;

/* -------------------------------------------------------------- progress */

/* What the bar under the day's total is drawing. `ratio` is uncapped so the
   caller can colour an overshoot; `fill` is the clamped 0–1 the bar width
   actually uses. With no goal set there is nothing to draw against, and that
   is a null, not a zero — a zero would render as an empty bar and imply the
   day had a target the user simply has not eaten into yet. */
export function consumption(kcal, target) {
  const eaten = Math.max(0, Number(kcal) || 0);
  const goal = Number(target);
  if (!Number.isFinite(goal) || goal <= 0) return null;

  const ratio = eaten / goal;
  return {
    eaten,
    target: goal,
    ratio,
    fill: Math.min(1, ratio),
    percent: Math.round(ratio * 100),
    remaining: Math.round(goal - eaten),
    over: eaten > goal,
    /* Bands the bar colours itself by. 'near' starts at 85% so the warning
       arrives while there is still a meal's worth of room to act on it. */
    band: ratio > 1 ? 'over' : ratio >= 0.85 ? 'near' : 'under',
  };
}
