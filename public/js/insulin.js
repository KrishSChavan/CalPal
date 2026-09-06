/* ==========================================================================
   insulin.js — carbohydrate ratio, correction factor, and the sliding window
   of insulin that is still working.

   Pure functions only. No DOM, no storage, and no clock of its own: every
   function that needs "now" is handed a timestamp, which is what lets
   test/insulin.test.mjs check the decay curve at 0, 75 and 300 minutes
   without waiting five hours for the answer.

   ---------------------------------------------------------------- the sum

   A mealtime dose is three terms, and this file keeps them apart so the
   screen can print each one rather than a single number nobody can audit:

       carb dose        = carbohydrate grams ÷ carb ratio
       correction dose  = (glucose − target) ÷ correction factor
       minus            = insulin already active from earlier doses (IOB)

   ------------------------------------------------------- where IOB lands

   Active insulin is subtracted from the CORRECTION only, never from the carb
   dose. That is what the Tandem t:slim, Medtronic and Omnipod bolus
   calculators do, and the reason is that the carbohydrate in front of you
   still has to be covered no matter what is left over from an earlier
   correction. Loop and oref0 subtract it from the whole dose instead; that
   suggests less insulin, which is safer against a low but can leave a real
   meal genuinely under-covered.

   ------------------------------------------------------- the decay itself

   IOB is the exponential curve from oref0/Loop, parameterised by time to peak
   activity and duration of action, rather than the old straight line. A
   straight line is wrong in both directions at once: it says half the dose is
   gone at the peak, when almost none of it has acted, and it says the tail is
   still working hard at four hours, when it has largely finished.

   ---------------------------------------------------------------- glucose

   Everything is stored in mg/dL and converted for display only. That is the
   unit Dexcom's own API and its US display use, and the 500/1800 rules below
   are stated in it. The band cut-points are the 2019 International Consensus
   on Time in Range — the same ones Dexcom Clarity reports against, so a user
   comparing the two screens sees the same word for the same number.

   Trend-arrow adjustment is the Pettus–Edelman method: shift the glucose
   value by the amount the arrow predicts for the next half hour, then let the
   person's own correction factor turn that into units. It stays off unless
   switched on, because trend-informed dosing has no consensus behind it yet —
   several algorithms exist and no trial has shown one to be better.

   ---------------------------------------------------------- what it isn't

   Not a dosing authority. Every number here comes from settings a clinician
   set, and an arithmetic slip in a carb count moves the answer further than
   anything in this file does. The screens say so; this note is here so the
   next person editing the file knows that copy is load-bearing.
   ========================================================================== */

/* ------------------------------------------------------------------ units */

/* Glucose is a molar concentration outside the US. The factor is the molar
   mass of glucose, 180.156 g/mol, over ten — so 100 mg/dL is 5.55 mmol/L.
   Dexcom Clarity rounds it to 18; the extra digits cost nothing and stop a
   round-trip through the display drifting. */
export const MGDL_PER_MMOL = 18.0182;

export const mmolToMgdl = (mmol) => Number(mmol) * MGDL_PER_MMOL;
export const mgdlToMmol = (mgdl) => Number(mgdl) / MGDL_PER_MMOL;

export const GLUCOSE_UNITS = [
  { id: 'mgdl', label: 'mg/dL', detail: 'United States — what Dexcom shows by default', step: 1, decimals: 0 },
  { id: 'mmoll', label: 'mmol/L', detail: 'Most of the rest of the world', step: 0.1, decimals: 1 },
];

export const isMmol = (units) => units === 'mmoll';

/* The only two places allowed to produce the non-canonical unit, so the
   rounding rule lives in one spot rather than at every call site.

   Both guard the empty cases by hand, because Number() will not: Number(null)
   and Number('') are both 0, and 0 is a finite number. Left to the plain
   check, "no reading" would render as a confident 0 mg/dL and an emptied box
   would be read back as a glucose of zero. */
const blank = (v) => v == null || v === '' || (typeof v === 'string' && !v.trim());

export function glucoseOut(mgdl, units) {
  if (blank(mgdl)) return null;
  const v = Number(mgdl);
  if (!Number.isFinite(v)) return null;
  return isMmol(units) ? Math.round(mgdlToMmol(v) * 10) / 10 : Math.round(v);
}

export function glucoseIn(shown, units) {
  if (blank(shown)) return NaN;
  const v = Number(shown);
  if (!Number.isFinite(v)) return NaN;
  return isMmol(units) ? mmolToMgdl(v) : v;
}

export function glucoseLabel(mgdl, units) {
  const v = glucoseOut(mgdl, units);
  return v == null ? '—' : `${v} ${isMmol(units) ? 'mmol/L' : 'mg/dL'}`;
}

/* ------------------------------------------------------------------ bands */

/* 2019 International Consensus on Time in Range (Battelino et al., Diabetes
   Care 42:1593): level 2 hypo below 54, level 1 from 54 to 69, target range
   70–180, level 1 hyper to 250, level 2 above it. */
export const RANGE = {
  urgentLow: 54,
  low: 70,
  targetLow: 70,
  targetHigh: 180,
  high: 250,
};

export function glucoseBand(mgdl) {
  const v = Number(mgdl);
  if (!Number.isFinite(v)) return null;
  if (v < RANGE.urgentLow) return { id: 'urgentLow', label: 'Urgent low', tone: 'risk' };
  if (v < RANGE.low) return { id: 'low', label: 'Low', tone: 'risk' };
  if (v <= RANGE.targetHigh) return { id: 'inRange', label: 'In range', tone: 'ok' };
  if (v <= RANGE.high) return { id: 'high', label: 'High', tone: 'warn' };
  return { id: 'veryHigh', label: 'Very high', tone: 'risk' };
}

/* ---------------------------------------------------------------- insulins */

/* peakMin is time to peak ACTION, not to peak blood level, and it is the
   number the decay curve is most sensitive to. diaHours is the class default;
   it stays editable because a person's own observed tail is the better figure
   when they have one. */
export const INSULINS = [
  { id: 'ultraRapid', label: 'Ultra-rapid', detail: 'Fiasp, Lyumjev', peakMin: 55, diaHours: 5, family: 'rapid' },
  { id: 'rapid', label: 'Rapid-acting', detail: 'Humalog, NovoLog, Apidra, Admelog', peakMin: 75, diaHours: 5, family: 'rapid' },
  { id: 'regular', label: 'Regular human', detail: 'Humulin R, Novolin R — slower on and slower off', peakMin: 150, diaHours: 8, family: 'regular' },
];

export const insulinById = (id) => INSULINS.find((i) => i.id === id) || null;

/* --------------------------------------------------------- trend arrows */

/* Dexcom's seven arrows in the manufacturer's own terms. The arrow is set
   from the rate of change over the previous 15 minutes and describes mg/dL
   per minute; per30 is the change that implies over the next half hour.

   `delta` is the Pettus–Edelman adjustment — the amount added to or taken off
   the reading before the correction is worked out. Dividing it by the
   person's own correction factor is what turns it into units, which is why
   this table needs no row per sensitivity: an ISF of 25 gives 100/25 = 4
   units for a double-up arrow and an ISF of 100 gives 1 unit. Checked column
   by column against the Aleppo/Laffel per-band table the Endocrine Society
   quotes, the two methods agree to within about a unit across the whole
   sensitivity range — test/insulin.test.mjs holds that comparison. */
export const TREND = [
  { id: 'doubleUp', glyph: '↑↑', label: 'Rising quickly', rate: 'more than 3 mg/dL a minute', per30: 90, delta: 100 },
  { id: 'up', glyph: '↑', label: 'Rising', rate: '2–3 mg/dL a minute', per30: 75, delta: 75 },
  { id: 'upSlow', glyph: '↗', label: 'Rising slowly', rate: '1–2 mg/dL a minute', per30: 45, delta: 50 },
  { id: 'flat', glyph: '→', label: 'Steady', rate: 'under 1 mg/dL a minute', per30: 0, delta: 0 },
  { id: 'downSlow', glyph: '↘', label: 'Falling slowly', rate: '1–2 mg/dL a minute', per30: -45, delta: -50 },
  { id: 'down', glyph: '↓', label: 'Falling', rate: '2–3 mg/dL a minute', per30: -75, delta: -75 },
  { id: 'doubleDown', glyph: '↓↓', label: 'Falling quickly', rate: 'more than 3 mg/dL a minute', per30: -90, delta: -100 },
];

export const trendById = (id) => TREND.find((t) => t.id === id) || null;

/* ------------------------------------------------------------ the profile */

export const DIABETES_TYPES = [
  { id: 'none', label: 'No', detail: 'Skips the rest of these questions' },
  { id: 'type1', label: 'Type 1', detail: '' },
  { id: 'type2', label: 'Type 2', detail: '' },
  { id: 'gestational', label: 'Gestational', detail: '' },
  { id: 'prediabetes', label: 'Prediabetes', detail: '' },
  { id: 'other', label: 'Other', detail: 'LADA, MODY, post-surgical' },
];

export const INSULIN_USE = [
  { id: 'ratio', label: 'Yes — I count carbs', detail: 'A dose worked out from grams of carbohydrate' },
  { id: 'correction', label: 'Yes — corrections only', detail: 'Long-acting insulin, plus a correction when glucose runs high' },
  { id: 'none', label: 'No mealtime insulin', detail: 'Tablets, diet, or long-acting only' },
];

export const DOSE_INCREMENTS = [
  { id: 0.5, label: 'Half units', detail: 'Most pumps, and half-unit pens' },
  { id: 1, label: 'Whole units', detail: 'A standard disposable pen' },
];

export const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];
export const SLOT_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };

export const LIMITS = {
  carbRatio: { min: 1, max: 150 },
  correctionFactor: { min: 5, max: 400 },
  targetBg: { min: 70, max: 180 },
  diaHours: { min: 2, max: 10 },
  maxBolus: { min: 1, max: 60 },
  tdd: { min: 5, max: 300 },
  bg: { min: 20, max: 600 },
  carbGrams: { min: 0, max: 400 },
  units: { min: 0, max: 100 },
};

export const dosesInsulin = (p) => p?.insulinUse === 'ratio' || p?.insulinUse === 'correction';
export const countsCarbs = (p) => p?.insulinUse === 'ratio';

/* One ratio per person is the common case; one per meal is the common
   refinement, because most people are more insulin-resistant at breakfast. An
   override only counts when it is a usable number, so a half-typed box falls
   back to the everyday ratio rather than to NaN. */
export function ratioFor(profile, slot) {
  const override = Number(profile?.slotRatios?.[slot]);
  if (Number.isFinite(override) && override > 0) return override;
  const base = Number(profile?.carbRatio);
  return Number.isFinite(base) && base > 0 ? base : null;
}

export function isfFor(profile) {
  const v = Number(profile?.correctionFactor);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function targetFor(profile) {
  const v = Number(profile?.targetBg);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function incrementFor(profile) {
  const v = Number(profile?.doseIncrement);
  return v > 0 ? v : 0.5;
}

export function actionProfile(profile) {
  const type = insulinById(profile?.insulinType) || INSULINS[1];
  const dia = Number(profile?.diaHours);
  const diaMin = (Number.isFinite(dia) && dia > 0 ? dia : type.diaHours) * 60;
  /* The curve divides by (1 − 2·peak/duration), so a peak at or past the
     halfway mark is a division by zero or a sign flip. Nothing real gets near
     it — 75 minutes against a five-hour tail is 25% — but a hand-typed
     two-hour duration on regular insulin would, so it is clamped rather than
     allowed to produce a curve that runs backwards. */
  const peakMin = Math.min(type.peakMin, diaMin * 0.45);
  return { ...type, diaMin, peakMin };
}

/* ------------------------------------------------------- the decay curve */

/* The exponential insulin-activity model used by Loop and oref0. `t` is
   minutes since the dose; the return is the FRACTION of that dose still to
   act — 1 at the moment of injection, 0 at the end of the duration.

     tau = tp·(1 − tp/td) / (1 − 2·tp/td)
     a   = 2·tau/td
     S   = 1 / (1 − a + (1 + a)·e^(−td/tau))
     iob = 1 − S·(1 − a)·((t²/(tau·td·(1−a)) − t/tau − 1)·e^(−t/tau) + 1)

   At t = td the closed form leaves about two thousandths behind, which is
   float noise rather than insulin, so the tail is cut flat at the duration. */
export function iobFraction(minutesAgo, action) {
  const t = Number(minutesAgo);
  const td = action.diaMin;
  const tp = action.peakMin;
  if (!Number.isFinite(t) || t <= 0) return 1;
  if (t >= td) return 0;

  const tau = (tp * (1 - tp / td)) / (1 - (2 * tp) / td);
  const a = (2 * tau) / td;
  const S = 1 / (1 - a + (1 + a) * Math.exp(-td / tau));

  const frac =
    1 - S * (1 - a) * (((t * t) / (tau * td * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1);

  return Math.min(1, Math.max(0, frac));
}

/* Units per minute still being delivered at `t`. Not used for dosing — it is
   what the curve on the account screen draws, so the shape of the thing being
   subtracted is visible rather than asserted. */
export function insulinActivity(minutesAgo, action) {
  const t = Number(minutesAgo);
  const td = action.diaMin;
  const tp = action.peakMin;
  if (!Number.isFinite(t) || t <= 0 || t >= td) return 0;

  const tau = (tp * (1 - tp / td)) / (1 - (2 * tp) / td);
  const a = (2 * tau) / td;
  const S = 1 / (1 - a + (1 + a) * Math.exp(-td / tau));
  return (S / (tau * tau)) * t * (1 - t / td) * Math.exp(-t / tau);
}

/* ------------------------------------------------------------ the window */

/* Insulin on board: every bolus still inside its duration of action, decayed
   by the curve above and added up. Long-acting insulin is excluded — its job
   is the background rate, and subtracting it from a meal dose would suppress
   that dose to nothing every morning.

   The contributions come back as well as the sum, because "2.4 units active"
   is not something anyone should take on faith at the moment they are
   deciding how much to inject. */
export function insulinOnBoard(doses, at, profile) {
  const action = actionProfile(profile);
  const now = Number(at) || Date.now();
  const parts = [];
  let units = 0;

  for (const d of doses || []) {
    const u = Number(d.units);
    if (!Number.isFinite(u) || u <= 0) continue;
    if (d.kind === 'basal') continue;
    const minutesAgo = (now - Number(d.ts)) / 60000;
    if (!Number.isFinite(minutesAgo) || minutesAgo < 0 || minutesAgo >= action.diaMin) continue;
    const fraction = iobFraction(minutesAgo, action);
    const remaining = u * fraction;
    if (remaining <= 0) continue;
    parts.push({
      id: d.id,
      ts: d.ts,
      units: u,
      minutesAgo: Math.round(minutesAgo),
      fraction,
      remaining,
    });
    units += remaining;
  }

  parts.sort((x, y) => y.ts - x.ts);
  return { units: Math.round(units * 100) / 100, parts, action };
}

/* Carbs on board. Linear absorption over a fixed span, which is the crude
   floor model oref0 falls back to and is labelled as crude wherever it shows:
   real absorption has a lag at the front and a long tail behind fat and
   protein, and nothing here can see either. It answers "have I already eaten
   into this", and it deliberately does not feed a dose. */
export const CARB_ABSORPTION_HOURS = 3;

export function carbsOnBoard(meals, at, profile) {
  const hours = Number(profile?.carbAbsorptionHours) || CARB_ABSORPTION_HOURS;
  const span = hours * 60;
  const now = Number(at) || Date.now();
  let grams = 0;

  for (const m of meals || []) {
    const g = Number(m.carb);
    if (!Number.isFinite(g) || g <= 0) continue;
    const minutesAgo = (now - Number(m.ts)) / 60000;
    if (!Number.isFinite(minutesAgo) || minutesAgo < 0 || minutesAgo >= span) continue;
    grams += g * (1 - minutesAgo / span);
  }
  return Math.round(grams);
}

/* -------------------------------------------------------------- rounding */

/* Pens and pumps deliver in fixed steps, so 4.37 units is a number nobody can
   dial. Rounded to the nearest step rather than down: rounding down every
   dose all day is a systematic under-delivery, and the step is at most a
   unit. */
export function roundDose(units, increment = 0.5) {
  const inc = Number(increment) > 0 ? Number(increment) : 0.5;
  const u = Number(units);
  if (!Number.isFinite(u)) return null;
  const stepped = Math.round(u / inc) * inc;
  /* Float arithmetic would otherwise print 2.5000000000000004. */
  return Math.round(stepped * 1000) / 1000;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/* ----------------------------------------------------- settings sanity */

/* The 500 and 1800 rules. Both are back-of-envelope starting points fitted to
   total daily dose, not measurements, and they are used here only to catch a
   setting that is an order of magnitude off — a 1:1 carb ratio typed where
   1:10 was meant is a tenfold overdose, and that is exactly the sort of thing
   a form ought to notice. Regular human insulin uses 450 and 1500 instead,
   because it does less per unit over its longer, flatter action. */
export const RULES = {
  rapid: { carb: 500, correction: 1800 },
  regular: { carb: 450, correction: 1500 },
};

export function ruleOfThumb(tdd, profile) {
  const total = Number(tdd);
  if (!Number.isFinite(total) || total <= 0) return null;
  const family = (insulinById(profile?.insulinType) || INSULINS[1]).family;
  const r = RULES[family] || RULES.rapid;
  return {
    family,
    tdd: total,
    carbRatio: Math.round((r.carb / total) * 10) / 10,
    correctionFactor: Math.round(r.correction / total),
    carbConstant: r.carb,
    correctionConstant: r.correction,
  };
}

/* Divergence past this much from the rule of thumb earns a word. Wide on
   purpose: real settings sit well off the rule for plenty of people, and a
   warning that fires on everybody is a warning nobody reads. */
const RULE_TOLERANCE = 0.5;

export function settingsChecks(profile) {
  const out = [];
  const p = profile || {};
  const rule = ruleOfThumb(p.tdd, p);
  if (!rule) return out;

  const ratio = Number(p.carbRatio);
  if (countsCarbs(p) && Number.isFinite(ratio) && ratio > 0) {
    if (Math.abs(ratio - rule.carbRatio) / rule.carbRatio > RULE_TOLERANCE) {
      out.push({
        tone: 'warn',
        field: 'carbRatio',
        text: `Your carb ratio of 1 unit per ${ratio} g is a long way from the ${rule.carbConstant}-rule figure of roughly 1 per ${rule.carbRatio} g for a ${rule.tdd} unit day. That can be perfectly correct — plenty of people sit off the rule — but check the two numbers are the way round you meant.`,
      });
    }
  }

  const isf = isfFor(p);
  if (isf && Math.abs(isf - rule.correctionFactor) / rule.correctionFactor > RULE_TOLERANCE) {
    out.push({
      tone: 'warn',
      field: 'correctionFactor',
      text: `A correction factor of ${isf} mg/dL per unit is a long way from the ${rule.correctionConstant}-rule figure of about ${rule.correctionFactor} for a ${rule.tdd} unit day. Worth a second look before you dose off it.`,
    });
  }
  return out;
}

/* --------------------------------------------------------------- the dose */

/* Everything the screen needs to show its working, not only the answer.

   `holdForLow` is the one case where no number comes back at all. Below
   70 mg/dL the thing to do is treat the low — about 15 g of fast-acting
   carbohydrate, recheck in 15 minutes — and printing a bolus beside that
   advice invites somebody to take it. A suggestion withheld is recoverable;
   a meal dose stacked on top of a hypo is not. */
export function bolus({ carbGrams = 0, bg = null, trend = null, slot = null, iob = 0, profile = {} } = {}) {
  const p = profile;
  const ratio = ratioFor(p, slot);
  const isf = isfFor(p);
  const target = targetFor(p);
  const increment = incrementFor(p);
  const cap = Number(p.maxBolus) > 0 ? Number(p.maxBolus) : null;
  const warnings = [];

  const out = {
    usable: false,
    carbGrams: Math.max(0, Number(carbGrams) || 0),
    ratio,
    /* Whether a per-meal override supplied that ratio rather than the
       everyday one. The screen says so: a breakfast dose coming out higher
       than the same plate at dinner is correct and confusing at once. */
    slotRatioUsed: Number(p?.slotRatios?.[slot]) > 0,
    carbDose: 0,
    bg: null,
    band: null,
    trend: null,
    trendDelta: 0,
    adjustedBg: null,
    target,
    isf,
    correctionRaw: 0,
    iob: Math.max(0, Number(iob) || 0),
    iobApplied: 0,
    correction: 0,
    total: 0,
    units: null,
    increment,
    cap,
    capped: false,
    holdForLow: false,
    warnings,
  };

  if (!dosesInsulin(p)) return out;
  if (!isf || !target) return out;
  if (countsCarbs(p) && !ratio) return out;

  /* --- carbohydrate --------------------------------------------------- */

  if (countsCarbs(p) && ratio) {
    out.carbDose = out.carbGrams / ratio;
    if (out.carbGrams > 200) {
      warnings.push({
        tone: 'warn',
        text: `${Math.round(out.carbGrams)} g of carbohydrate in one sitting is a large count. Worth re-reading the component list before dosing off it.`,
      });
    }
  }

  /* --- glucose -------------------------------------------------------- */

  const reading = Number(bg);
  if (Number.isFinite(reading) && reading > 0) {
    out.bg = reading;
    out.band = glucoseBand(reading);

    if (reading < RANGE.low) {
      out.holdForLow = true;
      warnings.push({
        tone: 'risk',
        text:
          reading < RANGE.urgentLow
            ? 'That is an urgent low. Take fast-acting sugar now — around 15 g — and recheck in 15 minutes. No dose is suggested while you are below range.'
            : 'You are below range. Treat the low first — about 15 g of fast-acting carbohydrate, then recheck in 15 minutes — before working out a meal dose.',
      });
      return out;
    }

    const arrow = p.useTrendArrows ? trendById(trend) : null;
    if (arrow) {
      out.trend = arrow;
      out.trendDelta = arrow.delta;
    }
    out.adjustedBg = reading + out.trendDelta;
    out.correctionRaw = (out.adjustedBg - target) / isf;

    if (reading > RANGE.high) {
      warnings.push({
        tone: 'warn',
        text: 'Above 250 mg/dL, check for ketones before eating — particularly if this is not the first high reading, or if you feel unwell.',
      });
    }
  }

  /* --- active insulin -------------------------------------------------- */

  /* Subtracted from the correction only, and only while the correction is
     positive. A reading below target already produces a negative correction
     that trims the meal dose on its own; letting IOB push it further down
     would count the same insulin twice. */
  if (out.correctionRaw > 0) {
    out.iobApplied = Math.min(out.iob, out.correctionRaw);
    out.correction = out.correctionRaw - out.iobApplied;
    if (out.iobApplied > 0) {
      warnings.push({
        tone: 'info',
        text: `${round2(out.iobApplied)} units of the correction is already covered by insulin still working from an earlier dose.`,
      });
    }
  } else {
    out.correction = out.correctionRaw;
  }

  /* --- the total -------------------------------------------------------- */

  out.total = Math.max(0, out.carbDose + out.correction);
  let units = roundDose(out.total, increment);

  if (cap && units > cap) {
    out.capped = true;
    units = cap;
    warnings.push({
      tone: 'warn',
      text: `Held at your ${cap} unit ceiling. The arithmetic asked for ${round2(out.total)}, so either the carb count is wrong or this wants splitting — check before overriding.`,
    });
  }

  out.units = units;
  out.usable = true;
  return out;
}

/* -------------------------------------------------------- sliding scale */

/* The scale, built from the person's own numbers instead of a printed card.

   A traditional sliding scale is a fixed table — 150 to 200 take two units,
   200 to 250 take four — issued the same to everyone, blind to what is
   already on board and to where glucose is heading. This is the same shape of
   table, so it reads as easily, but every row is (glucose − target) ÷ THEIR
   correction factor and the carb ladder is grams ÷ THEIR ratio. It is the
   calculator's own arithmetic laid out flat, which is what stops it drifting
   from what the confirm sheet suggests. */
export function correctionScale(profile, { from = 70, to = 400, step = 30 } = {}) {
  const isf = isfFor(profile);
  const target = targetFor(profile);
  const increment = incrementFor(profile);
  if (!isf || !target) return [];

  const points = new Set();
  for (let v = from; v <= to; v += step) points.add(v);
  points.add(target);
  points.add(RANGE.targetHigh);
  points.add(RANGE.high);

  return [...points]
    .filter((v) => v >= from && v <= to)
    .sort((a, b) => a - b)
    .map((mgdl) => {
      const raw = (mgdl - target) / isf;
      return {
        mgdl,
        mmol: Math.round(mgdlToMmol(mgdl) * 10) / 10,
        raw,
        units: roundDose(Math.max(0, raw), increment),
        below: raw < 0,
        band: glucoseBand(mgdl),
        isTarget: mgdl === target,
      };
    });
}

export function carbScale(profile, slot, { from = 15, to = 120, step = 15 } = {}) {
  const ratio = ratioFor(profile, slot);
  const increment = incrementFor(profile);
  if (!ratio) return [];
  const rows = [];
  for (let g = from; g <= to; g += step) {
    rows.push({ grams: g, raw: g / ratio, units: roundDose(g / ratio, increment) });
  }
  return rows;
}

/* ---------------------------------------------------------- CGM summary */

/* The other window: what glucose has actually been doing lately, on the
   metrics the 2019 consensus settled on and Dexcom Clarity reports.

   GMI is Bergenstal's regression of laboratory A1c on mean CGM glucose
   (Diabetes Care 41:2275): 3.31 + 0.02392 × mean mg/dL. It is emphatically
   not an A1c — the two disagree by more than half a point in a third of
   people — and the label says so wherever it is printed.

   Readings typed in by hand are not a CGM trace, so `sparse` comes back true
   below the point where a percentage would be describing a handful of
   readings while looking like it describes a fortnight. */
export const CGM_TARGETS = {
  inRange: 70,   // % of readings 70–180, aim above
  below70: 4,    // % under 70, aim below
  below54: 1,    // % under 54, aim below
  above180: 25,  // % over 180, aim below
  above250: 5,   // % over 250, aim below
  cv: 36,        // coefficient of variation, aim at or below
};

export function glucoseStats(readings) {
  const values = (readings || [])
    .map((r) => Number(r?.bg ?? r))
    .filter((v) => Number.isFinite(v) && v > 0);
  const n = values.length;
  if (!n) return null;

  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const pct = (fn) => (values.filter(fn).length / n) * 100;

  return {
    count: n,
    sparse: n < 14,
    mean: Math.round(mean),
    sd: Math.round(sd),
    cv: Math.round((sd / mean) * 1000) / 10,
    gmi: Math.round((3.31 + 0.02392 * mean) * 10) / 10,
    inRange: Math.round(pct((v) => v >= RANGE.targetLow && v <= RANGE.targetHigh)),
    below70: Math.round(pct((v) => v < RANGE.low)),
    below54: Math.round(pct((v) => v < RANGE.urgentLow)),
    above180: Math.round(pct((v) => v > RANGE.targetHigh)),
    above250: Math.round(pct((v) => v > RANGE.high)),
  };
}

/* ------------------------------------------------------------ validation */

/* Field-keyed, exactly like profile.validate(), so each onboarding step can
   ask about the fields it owns and the summary can ask about all of them. */
export function validate(profile) {
  const errors = {};
  const p = profile || {};

  if (!DIABETES_TYPES.some((t) => t.id === p.diabetesType)) {
    errors.diabetesType = 'Pick one, or "No" to skip the rest.';
    return errors;
  }
  if (p.diabetesType === 'none') return errors;

  if (!INSULIN_USE.some((u) => u.id === p.insulinUse)) {
    errors.insulinUse = 'Say whether you take insulin at meals.';
    return errors;
  }
  if (!dosesInsulin(p)) return errors;

  if (countsCarbs(p)) {
    const ratio = Number(p.carbRatio);
    if (!Number.isFinite(ratio) || ratio <= 0) errors.carbRatio = 'Enter your carb ratio.';
    else if (ratio < LIMITS.carbRatio.min || ratio > LIMITS.carbRatio.max) {
      errors.carbRatio = `1 unit per ${LIMITS.carbRatio.min}–${LIMITS.carbRatio.max} g is the plausible range. Check which way round the numbers go.`;
    }
  }

  const isf = Number(p.correctionFactor);
  if (!Number.isFinite(isf) || isf <= 0) errors.correctionFactor = 'Enter your correction factor.';
  else if (isf < LIMITS.correctionFactor.min || isf > LIMITS.correctionFactor.max) {
    errors.correctionFactor = `That is outside ${LIMITS.correctionFactor.min}–${LIMITS.correctionFactor.max} mg/dL per unit.`;
  }

  const target = Number(p.targetBg);
  if (!Number.isFinite(target) || target <= 0) errors.targetBg = 'Enter your target glucose.';
  else if (target < LIMITS.targetBg.min || target > LIMITS.targetBg.max) {
    errors.targetBg = `Targets sit between ${LIMITS.targetBg.min} and ${LIMITS.targetBg.max} mg/dL.`;
  }

  if (!insulinById(p.insulinType)) errors.insulinType = 'Pick the insulin you take at meals.';

  const dia = Number(p.diaHours);
  if (Number.isFinite(dia) && dia > 0 && (dia < LIMITS.diaHours.min || dia > LIMITS.diaHours.max)) {
    errors.diaHours = `Between ${LIMITS.diaHours.min} and ${LIMITS.diaHours.max} hours.`;
  }

  const cap = Number(p.maxBolus);
  if (Number.isFinite(cap) && cap > 0 && (cap < LIMITS.maxBolus.min || cap > LIMITS.maxBolus.max)) {
    errors.maxBolus = `Between ${LIMITS.maxBolus.min} and ${LIMITS.maxBolus.max} units.`;
  }

  const tdd = Number(p.tdd);
  if (Number.isFinite(tdd) && tdd > 0 && (tdd < LIMITS.tdd.min || tdd > LIMITS.tdd.max)) {
    errors.tdd = `Between ${LIMITS.tdd.min} and ${LIMITS.tdd.max} units a day.`;
  }

  for (const slot of SLOTS) {
    const raw = p.slotRatios?.[slot];
    if (raw === '' || raw == null) continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < LIMITS.carbRatio.min || v > LIMITS.carbRatio.max) {
      errors[`slotRatio.${slot}`] = `1 unit per ${LIMITS.carbRatio.min}–${LIMITS.carbRatio.max} g, or leave it blank.`;
    }
  }

  return errors;
}

export const isComplete = (profile) => Object.keys(validate(profile)).length === 0;

/* The standing disclaimer, in one place so every screen says the same thing.
   Not boilerplate: these settings come from a clinician, the carb count above
   them is an estimate made from a photograph, and both of those facts change
   what the number underneath is worth. */
export const DISCLAIMER =
  'This is your own settings doing arithmetic — not medical advice. Your carb ratio, correction factor and target come from your care team, the carbohydrate count above them is an estimate, and the dose you actually take is your call with your meter or CGM in front of you.';
