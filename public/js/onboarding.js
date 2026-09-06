/* ==========================================================================
   onboarding.js — the account section: the slides that produce a daily
   calorie target, and the slides that turn a plate of food into units.

   Owns the overlay in index.html and nothing else. All arithmetic lives in
   profile.js and insulin.js, all persistence in storage.js; this file is the
   screen between them. The option lists are rendered from those modules' own
   tables, so the activity multipliers and the insulin action curves exist in
   exactly one place each.

   Two entry points, one flow:
     · first run   — no profile yet. "Skip" is offered, because trapping
                     someone behind a form to reach a log they already have
                     meals in would be worse than shipping without a target.
     · edit        — opened from the topbar later. Prefilled, "Cancel" instead
                     of "Skip", and it lands on step 1 so a weight change is
                     four taps rather than a fresh interrogation.

   ------------------------------------------------------- the branch

   Three of the eight steps only exist for someone who takes insulin, and the
   flow skips them outright for everyone else rather than showing a screenful
   of disabled boxes. Every pane is built into the track regardless — what
   changes is which indices the Continue button walks through and how many
   ticks the progress bar draws — because rebuilding the track on a toggle
   would throw away whatever was half-typed on the steps behind it.
   ========================================================================== */

import * as P from './profile.js';
import * as D from './insulin.js';

const $ = (id) => document.getElementById(id);

const el = {
  root: $('onboard'), track: $('obTrack'), ticks: $('obTicks'),
  back: $('obBack'), quit: $('obQuit'), next: $('obNext'),
};

const STEPS = ['body', 'who', 'activity', 'goal', 'health', 'insulin', 'fine', 'summary'];

/* Shown only to someone who doses. `health` is not in here: the question of
   whether diabetes applies is asked of everybody, and it is the answer to it
   that opens the two below. */
const INSULIN_ONLY = new Set(['insulin', 'fine']);

const lastIndex = () => STEPS.length - 1;
const stepActive = (name) => !INSULIN_ONLY.has(name) || D.dosesInsulin(draft);
const activeSteps = () => STEPS.filter(stepActive);

/* The next index in `dir` that is actually part of this person's flow. Both
   ends of STEPS are always active, so the walk always terminates. */
function seek(from, dir) {
  let i = from + dir;
  while (i > 0 && i < lastIndex() && !stepActive(STEPS[i])) i += dir;
  return Math.max(0, Math.min(lastIndex(), i));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/* ------------------------------------------------------------------ state */

let draft = {};          // the profile being built; heightCm/weightKg are canonical
let units = 'imperial';  // display only — never what gets stored
let gUnits = 'mgdl';     // ditto for glucose: mg/dL is what is stored, always
let step = 0;
let editing = false;
let done = null;         // { onSave, onSkip }
let open = false;

/* ------------------------------------------------------------------ steps */

function bodyStep() {
  return `
    <section class="obstep" data-step="body"><div class="obstep__body">
      <h3 class="obstep__title">How tall are you, and what do you weigh?</h3>
      <p class="obstep__lede">These two set your calorie number. Like your food log, they stay on this device — the server is never told.</p>

      <div class="segmented segmented--mini" role="group" aria-label="Units">
        <button class="segmented__btn is-on" type="button" data-units="imperial">ft / lb</button>
        <button class="segmented__btn" type="button" data-units="metric">cm / kg</button>
      </div>

      <div class="field">
        <label class="field__label" for="obHeightFt">Height</label>
        <div class="measure" data-unit-group="imperial">
          <input class="input input--num" id="obHeightFt" type="number" inputmode="numeric" min="0" max="8" step="1" placeholder="5" aria-label="Height, feet">
          <span class="measure__unit">ft</span>
          <input class="input input--num" id="obHeightIn" type="number" inputmode="numeric" min="0" max="11" step="1" placeholder="10" aria-label="Height, inches">
          <span class="measure__unit">in</span>
        </div>
        <div class="measure" data-unit-group="metric" hidden>
          <input class="input input--num" id="obHeightCm" type="number" inputmode="decimal" min="90" max="250" step="0.5" placeholder="178" aria-label="Height in centimetres">
          <span class="measure__unit">cm</span>
        </div>
        <p class="field__err" id="obHeightErr" hidden></p>
      </div>

      <div class="field">
        <label class="field__label" for="obWeightLb">Weight</label>
        <div class="measure" data-unit-group="imperial">
          <input class="input input--num" id="obWeightLb" type="number" inputmode="decimal" min="50" max="800" step="0.5" placeholder="165" aria-label="Weight in pounds">
          <span class="measure__unit">lb</span>
        </div>
        <div class="measure" data-unit-group="metric" hidden>
          <input class="input input--num" id="obWeightKg" type="number" inputmode="decimal" min="25" max="350" step="0.5" placeholder="75" aria-label="Weight in kilograms">
          <span class="measure__unit">kg</span>
        </div>
        <p class="field__err" id="obWeightErr" hidden></p>
      </div>

      <div class="bmi" id="obBmi" hidden>
        <div class="bmi__row">
          <span class="eyebrow">Body mass index</span>
          <span class="bmi__value num" id="obBmiValue">—</span>
        </div>
        <div class="bmi__scale"><span class="bmi__marker" id="obBmiMarker"></span></div>
        <div class="bmi__band" id="obBmiBand"></div>
        <p class="bmi__caveat">${esc(P.BMI_CAVEAT)} It is shown because you asked for it, but it is not what sets your target — that comes from the next few questions.</p>
      </div>
    </div></section>`;
}

function whoStep() {
  return `
    <section class="obstep" data-step="who"><div class="obstep__body">
      <h3 class="obstep__title">Your age and sex</h3>
      <p class="obstep__lede">Resting burn falls with age, and the equation carries a different constant for each sex. Without both, the number would be a guess.</p>

      <div class="field">
        <label class="field__label" for="obAge">Age</label>
        <div class="measure">
          <input class="input input--num" id="obAge" type="number" inputmode="numeric" min="${P.LIMITS.age.min}" max="${P.LIMITS.age.max}" step="1" placeholder="30">
          <span class="measure__unit">yrs</span>
        </div>
        <p class="field__err" id="obAgeErr" hidden></p>
      </div>

      <div class="field">
        <span class="field__label">Sex</span>
        <div class="optlist" id="obSex" role="radiogroup" aria-label="Sex">
          ${P.SEXES.map((s) => optcard(s.id, s.label, s.id === 'unspecified'
            ? 'The equation is given the midpoint of the two constants'
            : '')).join('')}
        </div>
        <p class="field__err" id="obSexErr" hidden></p>
      </div>
    </div></section>`;
}

function activityStep() {
  return `
    <section class="obstep" data-step="activity"><div class="obstep__body">
      <h3 class="obstep__title">How much do you move in a normal week?</h3>
      <p class="obstep__lede">This multiplies your resting burn, and it is the largest source of error in the whole calculation. If you are between two, pick the lower one.</p>
      <div class="optlist" id="obActivity" role="radiogroup" aria-label="Activity level">
        ${P.ACTIVITY.map((a) => optcard(a.id, a.label, a.detail)).join('')}
      </div>
      <p class="field__err" id="obActivityErr" hidden></p>
    </div></section>`;
}

function goalStep() {
  return `
    <section class="obstep" data-step="goal"><div class="obstep__body">
      <h3 class="obstep__title">What are you aiming for?</h3>
      <p class="obstep__lede">This is the only step that moves your target away from what you actually burn.</p>
      <div class="optlist" id="obGoal" role="radiogroup" aria-label="Goal">
        ${P.GOALS.map((g) => optcard(g.id, g.label, g.detail)).join('')}
      </div>
      <p class="field__err" id="obGoalErr" hidden></p>
    </div></section>`;
}

/* ------------------------------------------------------------- diabetes */

/* The gate. Asked of everybody, in two parts, because "I have type 2" and "I
   take insulin at meals" are different facts and only the second one opens
   the calculator — a great many people with type 2 take no mealtime insulin
   at all, and dragging them through a carb-ratio form would be a form asking
   for a number they have never been given. */
function healthStep() {
  return `
    <section class="obstep" data-step="health"><div class="obstep__body">
      <h3 class="obstep__title">Do you manage diabetes?</h3>
      <p class="obstep__lede">Everything so far was about calories. This is the part that turns a plate of food into units of insulin — and if it does not apply to you, one tap gets you past it.</p>

      <div class="optlist" id="obDiabetes" role="radiogroup" aria-label="Diabetes">
        ${D.DIABETES_TYPES.map((t) => optcard(t.id, t.label, t.detail)).join('')}
      </div>
      <p class="field__err" id="obDiabetesErr" hidden></p>

      <div class="field" id="obUseField" hidden style="margin-top:1.75rem;">
        <span class="field__label">Do you take insulin at meals?</span>
        <div class="optlist" id="obInsulinUse" role="radiogroup" aria-label="Mealtime insulin">
          ${D.INSULIN_USE.map((u) => optcard(u.id, u.label, u.detail)).join('')}
        </div>
        <p class="field__err" id="obInsulinUseErr" hidden></p>
      </div>
    </div></section>`;
}

/* ------------------------------------------------------------- the ratios */

function insulinStep() {
  return `
    <section class="obstep" data-step="insulin"><div class="obstep__body">
      <h3 class="obstep__title">Your ratios</h3>
      <p class="obstep__lede">These come from your care team and nothing here guesses them. They are the whole calculation: everything else on this screen only decides how they get applied.</p>

      <div class="segmented segmented--mini" role="group" aria-label="Glucose units">
        <button class="segmented__btn is-on" type="button" data-gunits="mgdl">mg/dL</button>
        <button class="segmented__btn" type="button" data-gunits="mmoll">mmol/L</button>
      </div>

      <div class="field">
        <span class="field__label">Which insulin do you take at meals?</span>
        <div class="optlist" id="obInsulinType" role="radiogroup" aria-label="Mealtime insulin type">
          ${D.INSULINS.map((i) => optcard(i.id, i.label, i.detail)).join('')}
        </div>
        <p class="field__err" id="obInsulinTypeErr" hidden></p>
      </div>

      <div class="field" id="obRatioField">
        <label class="field__label" for="obCarbRatio">Carb ratio</label>
        <div class="measure">
          <span class="measure__lead">1 unit per</span>
          <input class="input input--num" id="obCarbRatio" type="number" inputmode="decimal" min="${D.LIMITS.carbRatio.min}" max="${D.LIMITS.carbRatio.max}" step="0.5" placeholder="10" aria-label="Grams of carbohydrate covered by one unit">
          <span class="measure__unit">g</span>
        </div>
        <p class="field__hint">Grams of carbohydrate one unit covers. A smaller number means more insulin for the same plate.</p>
        <p class="field__err" id="obCarbRatioErr" hidden></p>
      </div>

      <div class="field">
        <label class="field__label" for="obIsf">Correction factor</label>
        <div class="measure">
          <span class="measure__lead">1 unit drops</span>
          <input class="input input--num" id="obIsf" type="number" inputmode="decimal" step="1" placeholder="50" aria-label="Glucose drop from one unit">
          <span class="measure__unit measure__unit--wide" id="obIsfUnit">mg/dL</span>
        </div>
        <p class="field__hint">Your insulin sensitivity factor, if that is what your clinic called it.</p>
        <p class="field__err" id="obIsfErr" hidden></p>
      </div>

      <div class="field">
        <label class="field__label" for="obTarget">Target glucose</label>
        <div class="measure">
          <span class="measure__lead">aim for</span>
          <input class="input input--num" id="obTarget" type="number" inputmode="decimal" step="1" placeholder="110" aria-label="Target glucose">
          <span class="measure__unit measure__unit--wide" id="obTargetUnit">mg/dL</span>
        </div>
        <p class="field__hint">The single figure a correction aims at — not the 70–180 range you want the day to sit inside.</p>
        <p class="field__err" id="obTargetErr" hidden></p>
      </div>

      <div id="obRatioPreview"></div>
    </div></section>`;
}

/* ---------------------------------------------------- window and ceilings */

function fineStep() {
  return `
    <section class="obstep" data-step="fine"><div class="obstep__body">
      <h3 class="obstep__title">The window, and the guard rails</h3>
      <p class="obstep__lede">How long a dose keeps working is what decides how much of it still counts against the next one. The rest of this step is what stops a mistyped carb count turning into a large dose.</p>

      <div class="field">
        <label class="field__label" for="obDia">How long your insulin keeps working</label>
        <div class="measure">
          <input class="input input--num" id="obDia" type="number" inputmode="decimal" min="${D.LIMITS.diaHours.min}" max="${D.LIMITS.diaHours.max}" step="0.5" placeholder="5">
          <span class="measure__unit">hrs</span>
        </div>
        <p class="field__hint" id="obDiaHint"></p>
        <p class="field__err" id="obDiaErr" hidden></p>
      </div>

      <div class="field">
        <label class="field__label" for="obMaxBolus">Most this app will ever suggest</label>
        <div class="measure">
          <input class="input input--num" id="obMaxBolus" type="number" inputmode="decimal" min="${D.LIMITS.maxBolus.min}" max="${D.LIMITS.maxBolus.max}" step="0.5" placeholder="15">
          <span class="measure__unit">u</span>
        </div>
        <p class="field__hint">A ceiling, not a target. If the arithmetic ever asks for more than this you will be told the number and told it was held — which is the moment to check the carb count rather than the moment to override.</p>
        <p class="field__err" id="obMaxBolusErr" hidden></p>
      </div>

      <div class="field">
        <span class="field__label">What your pen or pump can actually dial</span>
        <div class="optlist" id="obIncrement" role="radiogroup" aria-label="Dose increment">
          ${D.DOSE_INCREMENTS.map((i) => optcard(String(i.id), i.label, i.detail)).join('')}
        </div>
      </div>

      <div class="field">
        <label class="field__label" for="obTdd">Total insulin on an average day <span class="field__opt">optional</span></label>
        <div class="measure">
          <input class="input input--num" id="obTdd" type="number" inputmode="decimal" min="${D.LIMITS.tdd.min}" max="${D.LIMITS.tdd.max}" step="1" placeholder="45">
          <span class="measure__unit">u</span>
        </div>
        <p class="field__hint">Long-acting and mealtime added together. Used for one thing only — checking your ratios against the 500 and 1800 rules, so a ratio typed the wrong way round gets caught before it doses anybody.</p>
        <p class="field__err" id="obTddErr" hidden></p>
      </div>

      <div class="field">
        <span class="field__label">Dexcom trend arrows</span>
        <div class="optlist" id="obTrendUse" role="radiogroup" aria-label="Trend arrow adjustment">
          ${optcard('off', 'Leave them out', 'Dose on the reading in front of you')}
          ${optcard('on', 'Let the arrow move the dose', 'Shifts the glucose figure by what the arrow predicts for the next half hour')}
        </div>
        <p class="field__hint">Off by default on purpose. Adjusting a dose for a trend arrow is well described in the literature but has no consensus behind it — several methods disagree with each other and none has been shown to come out ahead. Agree it with your care team before you switch it on.</p>
      </div>

      <details class="disclose">
        <summary class="disclose__head">A different carb ratio at different meals?</summary>
        <div class="disclose__body">
          <p class="field__hint" style="margin-top:0;">Most people need more insulin per gram at breakfast than at dinner. Fill in only the ones that differ — anything left blank uses the ratio from the last step.</p>
          <div class="slotratios" id="obSlotRatios">
            ${D.SLOTS.map((s) => `
              <div class="slotratio">
                <label class="slotratio__label" for="obRatio-${s}">${esc(D.SLOT_LABEL[s])}</label>
                <span class="slotratio__lead">1 u per</span>
                <input class="input input--num" id="obRatio-${s}" data-slotratio="${s}" type="number" inputmode="decimal" min="${D.LIMITS.carbRatio.min}" max="${D.LIMITS.carbRatio.max}" step="0.5" placeholder="—" aria-label="${esc(D.SLOT_LABEL[s])} carb ratio">
                <span class="slotratio__unit">g</span>
              </div>`).join('')}
          </div>
          <p class="field__err" id="obSlotRatiosErr" hidden></p>
        </div>
      </details>
    </div></section>`;
}

function summaryStep() {
  return `<section class="obstep" data-step="summary"><div class="obstep__body" id="obSummary"></div></section>`;
}

function optcard(value, label, detail) {
  return `
    <button class="optcard" type="button" role="radio" aria-checked="false" data-value="${esc(value)}">
      <span class="optcard__mark" aria-hidden="true"></span>
      <span class="optcard__text">
        <span class="optcard__label">${esc(label)}</span>
        ${detail ? `<span class="optcard__detail">${esc(detail)}</span>` : ''}
      </span>
    </button>`;
}

/* --------------------------------------------------------------- summary */

function renderSummary() {
  const host = $('obSummary');
  const calc = P.dailyTarget(draft);
  if (!calc) {
    host.innerHTML = `<h3 class="obstep__title">Something is still missing</h3>
      <p class="obstep__lede">Step back and fill in whatever was left blank.</p>`;
    return;
  }

  const act = P.activityById(draft.activity);
  const goal = P.goalById(draft.goal);
  const fromActivity = calc.maintenance - calc.bmr;
  const value = P.bmi(draft.weightKg, draft.heightCm);
  const band = P.bmiBand(value);

  const notes = [];
  if (calc.floored) {
    notes.push(`A ${Math.abs(calc.goalDelta)} kcal deficit would have put you under
      ${calc.floor} kcal a day, which is below what a day's food can reliably carry in
      vitamins and minerals. The target is held at ${calc.floor} instead, so it will
      lose weight more slowly than the goal implies.`);
  }
  if (Number(draft.age) < P.ADULT_AGE) {
    notes.push(`This equation was fitted on adults. Under ${P.ADULT_AGE} it is a rougher
      guide than it is for an adult, and it does not account for growth.`);
  }
  notes.push(`Mifflin-St Jeor lands within 10% of measured resting burn for about four
    people in five — the other one is out by more. Treat this as a starting point and
    move it based on what actually happens over a few weeks.`);

  host.innerHTML = `
    <h3 class="obstep__title">${editing ? 'Your updated target' : 'Your daily target'}</h3>
    <p class="obstep__lede">Here is where the number came from, so you can see what moves it.</p>

    <div class="target">
      <div class="target__kcal num">${calc.target.toLocaleString()}</div>
      <div class="target__unit">kcal a day</div>
    </div>

    <div class="working">
      <div class="working__row">
        <span class="working__label">Resting burn<small>Mifflin-St Jeor, from your height, weight, age and sex</small></span>
        <span class="working__value num">${calc.bmr.toLocaleString()}</span>
      </div>
      <div class="working__row">
        <span class="working__label">Movement<small>${esc(act.label)} — resting burn × ${act.factor}</small></span>
        <span class="working__value num">+${fromActivity.toLocaleString()}</span>
      </div>
      <div class="working__row">
        <span class="working__label">Goal<small>${esc(goal.label)}</small></span>
        <span class="working__value num">${calc.goalDelta === 0 ? '0' : (calc.goalDelta > 0 ? '+' : '−') + Math.abs(calc.goalDelta).toLocaleString()}</span>
      </div>
      ${calc.floored ? `
        <div class="working__row">
          <span class="working__label">Held at the floor<small>Never below ${calc.floor} kcal</small></span>
          <span class="working__value num">${calc.floor.toLocaleString()}</span>
        </div>` : ''}
      <div class="working__row working__row--total">
        <span class="working__label">Your target</span>
        <span class="working__value num">${calc.target.toLocaleString()} kcal</span>
      </div>
    </div>

    ${value && band ? `
      <p class="bmi__caveat" style="margin-top:1.25rem;">
        For reference, your BMI is <strong>${value.toFixed(1)}</strong> (${esc(band.label.toLowerCase())}).
        ${esc(P.BMI_CAVEAT)}
      </p>` : ''}

    ${notes.map((n) => `<p class="bmi__caveat">${n}</p>`).join('')}

    ${insulinSummary()}
  `;
}

/* ------------------------------------------------- the insulin summary */

/* Same argument as the calorie working above: a dose nobody can audit is a
   dose nobody has a reason to trust. So this prints the settings, then the
   scale those settings imply, then the curve the sliding window decays along
   — the three things that between them fully determine every number the app
   will ever suggest. */
function insulinSummary() {
  if (!D.dosesInsulin(draft)) return '';

  const action = D.actionProfile(draft);
  const isf = D.isfFor(draft);
  const target = D.targetFor(draft);
  const ratio = D.ratioFor(draft, null);
  const insulin = D.insulinById(draft.insulinType);
  const checks = D.settingsChecks(draft);
  const rule = D.ruleOfThumb(draft.tdd, draft);
  const overrides = D.SLOTS.filter((s) => Number(draft.slotRatios?.[s]) > 0);

  const g = (mgdl) => esc(D.glucoseLabel(mgdl, gUnits));

  return `
    <div class="section-head" style="padding-top:2rem;">
      <h3 class="eyebrow">Insulin</h3>
    </div>

    <div class="working">
      ${D.countsCarbs(draft) ? `
        <div class="working__row">
          <span class="working__label">Carb ratio<small>One unit covers this much carbohydrate</small></span>
          <span class="working__value num">1 u / ${ratio} g</span>
        </div>` : ''}
      <div class="working__row">
        <span class="working__label">Correction factor<small>What one unit takes off your glucose</small></span>
        <span class="working__value num">${g(isf)}</span>
      </div>
      <div class="working__row">
        <span class="working__label">Target<small>Where a correction aims</small></span>
        <span class="working__value num">${g(target)}</span>
      </div>
      <div class="working__row">
        <span class="working__label">Active insulin window<small>${esc(insulin?.label || 'Rapid-acting')} — peaks near ${Math.round(action.peakMin)} min</small></span>
        <span class="working__value num">${action.diaMin / 60} hrs</span>
      </div>
      ${Number(draft.maxBolus) > 0 ? `
        <div class="working__row">
          <span class="working__label">Ceiling<small>Nothing suggested above this</small></span>
          <span class="working__value num">${Number(draft.maxBolus)} u</span>
        </div>` : ''}
      <div class="working__row">
        <span class="working__label">Trend arrows<small>${draft.useTrendArrows ? 'The arrow shifts the glucose figure before the correction is worked out' : 'Not used — dosing on the reading as it stands'}</small></span>
        <span class="working__value num">${draft.useTrendArrows ? 'On' : 'Off'}</span>
      </div>
    </div>

    ${overrides.length ? `
      <p class="bmi__caveat">Different at ${overrides.map((s) => `${esc(D.SLOT_LABEL[s].toLowerCase())} (1 u per ${Number(draft.slotRatios[s])} g)`).join(', ')}. Those are used in place of the everyday ratio when you log a meal in that slot.</p>` : ''}

    <h4 class="obsub">Your sliding scale</h4>
    <p class="bmi__caveat" style="margin-top:0;">Not a printed card handed to everybody — every row below is <em>(glucose − ${g(target)}) ÷ ${g(isf)}</em>, your own two numbers. It is the same arithmetic the app runs when you log a meal, laid out flat so you can see the whole shape of it at once.</p>
    ${scaleTable()}

    ${D.countsCarbs(draft) ? `
      <h4 class="obsub">Carbohydrate to units</h4>
      <p class="bmi__caveat" style="margin-top:0;">Grams ÷ ${ratio}, before any correction or active insulin.</p>
      ${carbTable()}` : ''}

    <h4 class="obsub">How a dose fades</h4>
    <p class="bmi__caveat" style="margin-top:0;">One unit, from the moment it goes in. The app subtracts whatever is still left on this curve from the correction part of your next dose — never from the carb part, which is what a pump does and the reason a meal always gets covered.</p>
    ${iobCurve(action)}

    ${rule ? `
      <p class="bmi__caveat">Cross-checked against your ${rule.tdd} unit day: the ${rule.carbConstant} rule puts a carb ratio near 1 unit per ${rule.carbRatio} g, and the ${rule.correctionConstant} rule puts a correction factor near ${rule.correctionFactor} mg/dL per unit. Both are rules of thumb fitted to a population, not measurements of you — they are here to catch a number typed the wrong way round, not to argue with your clinic.</p>` : ''}

    ${checks.map((c) => `<div class="notice notice--warn">${esc(c.text)}</div>`).join('')}

    <div class="notice notice--risk" style="margin-top:1.25rem;">${esc(D.DISCLAIMER)}</div>
  `;
}

function scaleTable() {
  const rows = D.correctionScale(draft);
  if (!rows.length) return '';
  return `
    <div class="scale-wrap">
      <table class="scale">
        <thead>
          <tr>
            <th scope="col">Glucose</th>
            <th scope="col">Band</th>
            <th scope="col" class="scale__num">Correction</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr class="${r.isTarget ? 'is-target' : ''}">
              <th scope="row">${esc(D.glucoseLabel(r.mgdl, gUnits))}</th>
              <td><span class="scale__band" data-tone="${esc(r.band.tone)}">${esc(r.band.label)}</span></td>
              <td class="scale__num num">${r.below ? '—' : `${r.units} u`}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="bmi__caveat">Below your target the correction turns negative, which trims a meal dose rather than adding one — so the column reads as a dash instead of a number you could take on its own. Active insulin from an earlier dose comes off the top of every figure in it.</p>`;
}

function carbTable() {
  const rows = D.carbScale(draft, null);
  if (!rows.length) return '';
  return `
    <div class="scale-wrap">
      <table class="scale">
        <thead>
          <tr><th scope="col">Carbohydrate</th><th scope="col" class="scale__num">Dose</th></tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr><th scope="row">${r.grams} g</th><td class="scale__num num">${r.units} u</td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* The decay curve, drawn rather than asserted. viewBox units, no width or
   height attributes, so it scales with the column it sits in. */
function iobCurve(action) {
  const steps = 60;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * action.diaMin;
    const frac = D.iobFraction(t, action);
    pts.push(`${((i / steps) * 100).toFixed(2)},${((1 - frac) * 100).toFixed(2)}`);
  }
  const peakX = (action.peakMin / action.diaMin) * 100;
  const peakY = (1 - D.iobFraction(action.peakMin, action)) * 100;
  const hours = action.diaMin / 60;

  return `
    <figure class="iobfig">
      <svg class="iobfig__svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
           aria-label="One unit of insulin decaying to nothing over ${hours} hours, with peak action near ${Math.round(action.peakMin)} minutes">
        <polyline class="iobfig__line" points="${pts.join(' ')}" />
        <line class="iobfig__peak" x1="${peakX.toFixed(2)}" y1="${peakY.toFixed(2)}" x2="${peakX.toFixed(2)}" y2="100" />
      </svg>
      <figcaption class="iobfig__axis">
        <span>Injected</span><span>peak ${Math.round(action.peakMin)} min</span><span>${hours} hrs</span>
      </figcaption>
    </figure>`;
}

/* ------------------------------------------------------------------ paint */

/* Height and weight are stored in metric and shown in whichever unit is
   selected, so this repaints the boxes from the canonical value rather than
   letting the two representations drift. */
function paintMeasures() {
  const cm = Number(draft.heightCm);
  const kg = Number(draft.weightKg);

  for (const group of el.track.querySelectorAll('[data-unit-group]')) {
    group.hidden = group.dataset.unitGroup !== units;
  }
  for (const b of el.track.querySelectorAll('[data-units]')) {
    const on = b.dataset.units === units;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  }

  if (units === 'imperial') {
    if (Number.isFinite(cm) && cm > 0) {
      const { ft, in: inches } = P.cmToFtIn(cm);
      $('obHeightFt').value = ft;
      $('obHeightIn').value = inches;
    }
    if (Number.isFinite(kg) && kg > 0) $('obWeightLb').value = Math.round(P.kgToLb(kg) * 10) / 10;
  } else {
    if (Number.isFinite(cm) && cm > 0) $('obHeightCm').value = Math.round(cm * 10) / 10;
    if (Number.isFinite(kg) && kg > 0) $('obWeightKg').value = Math.round(kg * 10) / 10;
  }
  paintBmi();
}

function paintBmi() {
  const card = $('obBmi');
  const value = P.bmi(draft.weightKg, draft.heightCm);
  const band = P.bmiBand(value);

  /* Only once both numbers are inside the plausible range: a half-typed "1"
     in the weight box would otherwise flash a BMI of 0.3 and an "underweight"
     verdict at somebody, which is a nasty thing for a form to do. */
  const ok = value != null && band
    && draft.heightCm >= P.LIMITS.heightCm.min && draft.heightCm <= P.LIMITS.heightCm.max
    && draft.weightKg >= P.LIMITS.weightKg.min && draft.weightKg <= P.LIMITS.weightKg.max;

  card.hidden = !ok;
  if (!ok) return;

  $('obBmiValue').textContent = value.toFixed(1);
  $('obBmiBand').textContent = band.label;
  $('obBmiBand').dataset.tone = band.tone;
  /* The scale runs 15–40; anything outside pins to an end. */
  const pct = Math.max(0, Math.min(1, (value - 15) / 25)) * 100;
  $('obBmiMarker').style.left = `${pct}%`;
}

/* The plain numeric boxes — the ones that are the same number in every unit
   system, so they need filling but not converting.

   Age is in here too. It was never prefilled before: paintMeasures() only
   ever touched height and weight, so reopening the profile to change a weight
   presented an empty age box that then failed validation on the way past. */
function paintNumbers() {
  const set = (id, value) => {
    const node = $(id);
    if (!node) return;
    node.value = Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : '';
  };

  set('obAge', draft.age);
  set('obCarbRatio', draft.carbRatio);
  set('obDia', draft.diaHours);
  set('obMaxBolus', draft.maxBolus);
  set('obTdd', draft.tdd);
  for (const s of D.SLOTS) set(`obRatio-${s}`, draft.slotRatios?.[s]);
}

/* --------------------------------------------------- the glucose boxes */

/* mg/dL is what gets stored; mmol/L is a rendering of it. Same contract as
   the height and weight boxes above, and the same reason: two live
   representations of one number drift the moment somebody types in the one
   the code is not reading. Both the correction factor and the target are
   glucose concentrations, so both convert — a correction factor is "how far
   one unit moves your glucose", which is 50 mg/dL or 2.8 mmol/L for the same
   insulin, not 50 either way. */
function paintGlucose() {
  for (const b of el.track.querySelectorAll('[data-gunits]')) {
    const on = b.dataset.gunits === gUnits;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  }

  const label = D.isMmol(gUnits) ? 'mmol/L' : 'mg/dL';
  const step = D.isMmol(gUnits) ? '0.1' : '1';
  for (const [box, unit, value] of [
    ['obIsf', 'obIsfUnit', draft.correctionFactor],
    ['obTarget', 'obTargetUnit', draft.targetBg],
  ]) {
    const input = $(box);
    if (!input) continue;
    $(unit).textContent = label;
    input.step = step;
    const shown = D.glucoseOut(value, gUnits);
    input.value = shown == null ? '' : shown;
  }
  paintRatioPreview();
}

/* What the three ratios add up to, live, while they are still being typed.
   A worked example is the fastest way to catch a carb ratio entered upside
   down: "1 unit per 10 g" and "10 units per 1 g" both look plausible in a
   box, and only one of them says 6 units under a plate of pasta. */
function paintRatioPreview() {
  const host = $('obRatioPreview');
  if (!host) return;

  const errors = D.validate(draft);
  const ready = !errors.correctionFactor && !errors.targetBg
    && (!D.countsCarbs(draft) || !errors.carbRatio);
  if (!ready) { host.innerHTML = ''; return; }

  const example = { carbGrams: 60, bg: 180, slot: null, iob: 0, profile: draft };
  const dose = D.bolus(example);
  if (!dose.usable) { host.innerHTML = ''; return; }

  const g = (v) => esc(D.glucoseLabel(v, gUnits));
  host.innerHTML = `
    <div class="preview">
      <div class="preview__head">With those numbers</div>
      <div class="preview__line">
        <span>${D.countsCarbs(draft) ? '60 g of carbohydrate' : 'No carb dose'}, glucose at ${g(180)}, nothing active</span>
        <b class="num">${dose.units} u</b>
      </div>
      <div class="preview__split">
        ${D.countsCarbs(draft) ? `<span>food ${Math.round(dose.carbDose * 10) / 10} u</span>` : ''}
        <span>correction ${Math.round(dose.correction * 10) / 10} u</span>
      </div>
    </div>`;
}

/* The duration box explains what it is doing to the curve rather than just
   accepting a number, because "5 hours" and "3 hours" produce visibly
   different amounts of active insulin at the moment of the next meal. */
function paintFine() {
  const hint = $('obDiaHint');
  if (!hint) return;
  const type = D.insulinById(draft.insulinType) || D.INSULINS[1];
  const action = D.actionProfile(draft);
  const atTwoHours = Math.round(D.iobFraction(120, action) * 100);
  hint.textContent =
    `${type.label} insulin peaks about ${type.peakMin} minutes in. At the duration set here, `
    + `${atTwoHours}% of a dose is still to act two hours after you take it — that is the share `
    + `subtracted from the correction on your next one.`;

  const use = $('obUseField');
  if (use) use.hidden = !draft.diabetesType || draft.diabetesType === 'none';
}

/* Every radiogroup in the flow, and how its string card values map onto the
   draft. `coerce` runs on the way in and `show` on the way out, because two
   of these answers are not strings: the dose increment is a number the
   arithmetic divides by, and the trend-arrow switch is a boolean. Keeping the
   conversion here means the cards stay plain data attributes. */
const CHOICES = [
  { id: 'obSex', key: 'sex' },
  { id: 'obActivity', key: 'activity' },
  { id: 'obGoal', key: 'goal' },
  { id: 'obDiabetes', key: 'diabetesType' },
  { id: 'obInsulinUse', key: 'insulinUse' },
  { id: 'obInsulinType', key: 'insulinType' },
  { id: 'obIncrement', key: 'doseIncrement', coerce: Number },
  {
    id: 'obTrendUse',
    key: 'useTrendArrows',
    coerce: (v) => v === 'on',
    show: (v) => (v ? 'on' : 'off'),
  },
];

const showValue = (c, v) => (c.show ? c.show(v) : v == null ? '' : String(v));

function paintChoices() {
  for (const c of CHOICES) {
    const group = $(c.id);
    if (!group) continue;
    const want = showValue(c, draft[c.key]);
    const cards = [...group.children];
    const chosen = cards.findIndex((card) => card.dataset.value === want);
    cards.forEach((card, i) => {
      const on = i === chosen;
      card.classList.toggle('is-on', on);
      card.setAttribute('aria-checked', String(on));
      /* Roving tabindex. A radiogroup is one tab stop with the arrows moving
         inside it, not five separate stops — five would put the whole of the
         activity list between the heading and the Continue button. Before
         anything is chosen the first option is the way in. */
      card.tabIndex = (chosen === -1 ? i === 0 : on) ? 0 : -1;
    });
  }
}

/* The ticks count the steps this person will actually be walked through, not
   the eight panes sitting in the track — so answering "no" to the diabetes
   question shortens the bar rather than leaving two ticks that never fill. */
function paintChrome() {
  const list = activeSteps();
  const pos = list.indexOf(STEPS[step]);
  el.ticks.innerHTML = list.map((_, i) =>
    `<span class="onboard__tick${i <= pos ? ' is-done' : ''}"></span>`).join('');
  el.back.hidden = step === 0;
  el.next.textContent = step === lastIndex() ? (editing ? 'Save' : 'Start tracking') : 'Continue';
  el.quit.textContent = editing ? 'Cancel' : 'Skip';
}

/* --------------------------------------------------------------- movement */

function goTo(next, { focus = true } = {}) {
  step = Math.max(0, Math.min(lastIndex(), next));
  if (STEPS[step] === 'summary') renderSummary();

  el.track.style.setProperty('--i', String(step));

  const panes = [...el.track.children];
  panes.forEach((pane, i) => {
    const current = i === step;
    pane.classList.toggle('is-current', current);
    /* inert keeps tab order, the find-in-page cursor and screen readers out of
       the four steps parked off-screen — and it blurs anything focused inside
       the pane being parked, on its own. Deliberately NOT paired with an
       aria-hidden: setting that on an ancestor of the focused element is the
       one way to make a step genuinely unreachable, and inert already carries
       the meaning without the hazard. */
    if (current) pane.removeAttribute('inert');
    else pane.setAttribute('inert', '');
  });

  paintChrome();
  el.track.parentElement.scrollTop = 0;
  panes[step].scrollTop = 0;

  /* Focus after the slide, and only a text box — moving focus onto a choice
     list would announce the first option as though it were selected. The
     first input in the DOM is not necessarily the visible one, because the
     unit swap parks a whole measure row behind [hidden]. */
  if (!focus) return;
  const input = [...panes[step].querySelectorAll('input')].find((node) => {
    const group = node.closest('[data-unit-group]');
    return !group || !group.hidden;
  });
  if (input) setTimeout(() => input.focus({ preventScroll: true }), 440);
}

/* ------------------------------------------------------------ validation */

function showError(id, message) {
  const node = $(id);
  if (!node) return;
  node.textContent = message || '';
  node.hidden = !message;
}

/* Each step vets only what it collects. Anything still missing at the end is
   caught again by P.validate() before a single value is written. */
function stepIsValid() {
  const errors = P.validate(draft);
  const name = STEPS[step];

  if (name === 'body') {
    showError('obHeightErr', errors.heightCm);
    showError('obWeightErr', errors.weightKg);
    for (const box of ['obHeightFt', 'obHeightIn', 'obHeightCm']) {
      $(box).classList.toggle('is-bad', !!errors.heightCm);
    }
    for (const box of ['obWeightLb', 'obWeightKg']) {
      $(box).classList.toggle('is-bad', !!errors.weightKg);
    }
    return !errors.heightCm && !errors.weightKg;
  }
  if (name === 'who') {
    showError('obAgeErr', errors.age);
    $('obAge').classList.toggle('is-bad', !!errors.age);
    showError('obSexErr', errors.sex);
    return !errors.age && !errors.sex;
  }
  if (name === 'activity') {
    showError('obActivityErr', errors.activity);
    return !errors.activity;
  }
  if (name === 'goal') {
    showError('obGoalErr', errors.goal);
    return !errors.goal;
  }

  /* The insulin steps validate against insulin.js, not profile.js: the two
     validators own disjoint sets of fields and neither knows the other's
     limits. */
  const dErrors = D.validate(draft);

  if (name === 'health') {
    showError('obDiabetesErr', dErrors.diabetesType);
    showError('obInsulinUseErr', dErrors.insulinUse);
    return !dErrors.diabetesType && !dErrors.insulinUse;
  }
  if (name === 'insulin') {
    showError('obInsulinTypeErr', dErrors.insulinType);
    showError('obCarbRatioErr', dErrors.carbRatio);
    showError('obIsfErr', dErrors.correctionFactor);
    showError('obTargetErr', dErrors.targetBg);
    $('obCarbRatio').classList.toggle('is-bad', !!dErrors.carbRatio);
    $('obIsf').classList.toggle('is-bad', !!dErrors.correctionFactor);
    $('obTarget').classList.toggle('is-bad', !!dErrors.targetBg);
    return !dErrors.insulinType && !dErrors.carbRatio
      && !dErrors.correctionFactor && !dErrors.targetBg;
  }
  if (name === 'fine') {
    showError('obDiaErr', dErrors.diaHours);
    showError('obMaxBolusErr', dErrors.maxBolus);
    showError('obTddErr', dErrors.tdd);
    const slotBad = D.SLOTS.map((s) => dErrors[`slotRatio.${s}`]).find(Boolean);
    showError('obSlotRatiosErr', slotBad);
    for (const s of D.SLOTS) {
      $(`obRatio-${s}`).classList.toggle('is-bad', !!dErrors[`slotRatio.${s}`]);
    }
    return !dErrors.diaHours && !dErrors.maxBolus && !dErrors.tdd && !slotBad;
  }
  return true;
}

/* ------------------------------------------------------------------ wiring */

function wire() {
  /* Units. Read the boxes into canonical form first, so a half-entered height
     survives the swap instead of being wiped by the repaint. */
  for (const b of el.track.querySelectorAll('[data-units]')) {
    b.onclick = () => {
      units = b.dataset.units;
      paintMeasures();
    };
  }

  const readImperialHeight = () => {
    const ft = $('obHeightFt').value.trim();
    const inches = $('obHeightIn').value.trim();
    if (!ft && !inches) return NaN;
    return P.ftInToCm(Number(ft) || 0, Number(inches) || 0);
  };

  const onHeight = () => {
    draft.heightCm = units === 'imperial' ? readImperialHeight() : Number($('obHeightCm').value);
    paintBmi();
  };
  const onWeight = () => {
    const raw = units === 'imperial' ? Number($('obWeightLb').value) : Number($('obWeightKg').value);
    draft.weightKg = units === 'imperial' ? P.lbToKg(raw) : raw;
    paintBmi();
  };

  for (const id of ['obHeightFt', 'obHeightIn', 'obHeightCm']) $(id).oninput = onHeight;
  for (const id of ['obWeightLb', 'obWeightKg']) $(id).oninput = onWeight;

  $('obAge').oninput = () => { draft.age = Number($('obAge').value); };

  /* Glucose units. Same shape as the height/weight swap: the canonical mg/dL
     value in the draft is already current, so the toggle only repaints. */
  for (const b of el.track.querySelectorAll('[data-gunits]')) {
    b.onclick = () => {
      gUnits = b.dataset.gunits;
      paintGlucose();
    };
  }

  $('obCarbRatio').oninput = () => {
    draft.carbRatio = Number($('obCarbRatio').value);
    paintRatioPreview();
  };
  $('obIsf').oninput = () => {
    draft.correctionFactor = D.glucoseIn($('obIsf').value, gUnits);
    paintRatioPreview();
  };
  $('obTarget').oninput = () => {
    draft.targetBg = D.glucoseIn($('obTarget').value, gUnits);
    paintRatioPreview();
  };

  $('obDia').oninput = () => {
    draft.diaHours = Number($('obDia').value);
    paintFine();
  };
  $('obMaxBolus').oninput = () => { draft.maxBolus = Number($('obMaxBolus').value); };
  $('obTdd').oninput = () => { draft.tdd = Number($('obTdd').value); };

  /* A blank box means "use the everyday ratio", which is not the same as a
     zero — so an emptied field deletes the override rather than storing a
     falsy number the calculator would then have to second-guess. */
  for (const s of D.SLOTS) {
    const box = $(`obRatio-${s}`);
    box.oninput = () => {
      draft.slotRatios = { ...draft.slotRatios };
      const raw = box.value.trim();
      if (!raw) delete draft.slotRatios[s];
      else draft.slotRatios[s] = Number(raw);
    };
  }

  for (const choice of CHOICES) {
    const group = $(choice.id);
    const pick = (card) => {
      draft[choice.key] = choice.coerce ? choice.coerce(card.dataset.value) : card.dataset.value;
      paintChoices();
      showError(`${choice.id}Err`, '');
      /* Two of these answers change the flow itself rather than just a field:
         the diabetes type reveals the insulin question under it, and the
         answer to that adds or removes two whole steps. Both want the chrome
         repainted now, not on the next slide. */
      if (choice.key === 'diabetesType' || choice.key === 'insulinUse') {
        if (choice.key === 'diabetesType' && card.dataset.value === 'none') {
          draft.insulinUse = 'none';
          paintChoices();
        }
        paintFine();
        paintChrome();
      }
      if (choice.key === 'insulinType') {
        /* The class default only fills a box the user has not touched — an
           observed five-hour tail must survive switching pen brands. */
        if (!Number(draft.diaHours)) {
          draft.diaHours = D.insulinById(draft.insulinType)?.diaHours ?? 5;
          $('obDia').value = draft.diaHours;
        }
        paintFine();
        paintRatioPreview();
      }
    };
    for (const card of group.children) card.onclick = () => pick(card);

    /* role="radio" promises arrow keys, so it has to keep that promise. As in
       a native radiogroup, moving the selection is what the arrows do — the
       alternative leaves a state where an option is focused but unchosen,
       which is exactly the ambiguity the roving tabindex exists to avoid. */
    group.onkeydown = (e) => {
      const cards = [...group.children];
      const from = cards.indexOf(e.target.closest('.optcard'));
      if (from === -1) return;

      let to = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') to = (from + 1) % cards.length;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') to = (from - 1 + cards.length) % cards.length;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = cards.length - 1;
      if (to === null) return;

      e.preventDefault();
      pick(cards[to]);
      cards[to].focus();
    };
  }

  /* Enter should move the flow on, not submit nothing.

     Assigned, not addEventListener: wire() runs on every open, and el.track
     is a fixture of index.html that outlives the steps inside it — so a
     listener added here would stack, and after three visits to the profile
     one Enter would advance three steps. Assignment replaces. */
  el.track.onkeydown = (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    advance();
  };
}

function advance() {
  if (!stepIsValid()) return;
  if (step < lastIndex()) return goTo(seek(step, 1));

  /* Last gate before anything is written. Both validators run: a carb ratio
     left blank is as much a reason not to commit as a missing weight, and it
     is a far worse one to discover later. */
  const errors = P.validate(draft);
  const dErrors = D.validate(draft);
  if (Object.keys(errors).length || Object.keys(dErrors).length) {
    const first = STEPS.findIndex((name) =>
      (name === 'body' && (errors.heightCm || errors.weightKg))
      || (name === 'who' && (errors.age || errors.sex))
      || (name === 'activity' && errors.activity)
      || (name === 'goal' && errors.goal)
      || (name === 'health' && (dErrors.diabetesType || dErrors.insulinUse))
      || (name === 'insulin' && (dErrors.insulinType || dErrors.carbRatio
          || dErrors.correctionFactor || dErrors.targetBg))
      || (name === 'fine' && (dErrors.diaHours || dErrors.maxBolus || dErrors.tdd
          || D.SLOTS.some((s) => dErrors[`slotRatio.${s}`]))));
    return goTo(first === -1 ? 0 : first);
  }

  const calc = P.dailyTarget(draft);
  close(() => done?.onSave?.({
    /* Four decimals, not one. Metric is the stored form but imperial is what
       most people type, and 165 lb is 74.8427 kg — round that to 74.8 and it
       comes back as 164.9 lb the next time the form is opened, along with a
       target one kcal adrift. Four decimals is 0.0002 lb, comfortably finer
       than the tenth of a pound the boxes display. */
    heightCm: Math.round(draft.heightCm * 1e4) / 1e4,
    weightKg: Math.round(draft.weightKg * 1e4) / 1e4,
    age: draft.age,
    sex: draft.sex,
    activity: draft.activity,
    goal: draft.goal,
    units,
    goalKcal: calc.target,
    bmr: calc.bmr,
    maintenanceKcal: calc.maintenance,
    setupSkipped: false,
    updatedAt: Date.now(),
    ...insulinPayload(),
  }));
}

/* Written whether or not this person doses, because the fields have to be
   clearable: someone who turns the insulin steps off wants the strip and the
   dose card gone, and leaving a stale carb ratio behind would keep them. */
function insulinPayload() {
  const base = {
    diabetesType: draft.diabetesType || 'none',
    insulinUse: draft.insulinUse || 'none',
    glucoseUnits: gUnits,
  };
  if (!D.dosesInsulin(draft)) {
    return {
      ...base,
      carbRatio: null,
      correctionFactor: null,
      targetBg: null,
      slotRatios: {},
      useTrendArrows: false,
    };
  }

  /* Only the overrides that are real numbers survive the write. A box the
     user emptied is an override they removed, and it must not come back the
     next time the form is opened. */
  const slotRatios = {};
  for (const s of D.SLOTS) {
    const v = Number(draft.slotRatios?.[s]);
    if (Number.isFinite(v) && v > 0) slotRatios[s] = v;
  }

  const action = D.actionProfile(draft);
  return {
    ...base,
    insulinType: draft.insulinType || 'rapid',
    carbRatio: D.countsCarbs(draft) ? Number(draft.carbRatio) : null,
    /* Glucose is stored in mg/dL to four decimals for the same reason weight
       is stored to four: 5.5 mmol/L is 99.1 mg/dL, and a value rounded on the
       way in comes back a different number in the box it was typed into. */
    correctionFactor: Math.round(Number(draft.correctionFactor) * 1e4) / 1e4,
    targetBg: Math.round(Number(draft.targetBg) * 1e4) / 1e4,
    diaHours: action.diaMin / 60,
    maxBolus: Number(draft.maxBolus) > 0 ? Number(draft.maxBolus) : null,
    doseIncrement: Number(draft.doseIncrement) > 0 ? Number(draft.doseIncrement) : 0.5,
    tdd: Number(draft.tdd) > 0 ? Number(draft.tdd) : null,
    useTrendArrows: !!draft.useTrendArrows,
    slotRatios,
  };
}

/* ------------------------------------------------------- the iOS keyboard */

/* The panel deliberately does NOT lay itself out around the software
   keyboard. It stays the size of the screen and the foot stays at the bottom
   of it — behind the keyboard while the keyboard is up, the way a page does.

   An earlier version pinned the whole layer to visualViewport, which dragged
   Continue up onto the keyboard's top edge on every step that auto-focuses an
   input. That was never what fixed the foot's spacing either — the foot was
   stacking a design margin on top of env(safe-area-inset-bottom), and in a
   standalone PWA with the keyboard down the pin was writing the values the
   CSS already had. See .onboard__foot in onboard.css for the actual fix.

   What CSS genuinely cannot do is the one thing left here. `position: fixed`
   on iOS is laid out against the LAYOUT viewport, and iOS scrolls the
   DOCUMENT to reveal a focused field without reliably putting it back when
   the keyboard goes away — so the overlay ends up painting from a top edge
   that is no longer the top of the screen. Nothing is scrollable behind a
   full-screen overlay, so any non-zero scroll here is that artefact and only
   ever wants putting back to zero. */

function onFocusOut() {
  requestAnimationFrame(() => {
    if (open && globalThis.scrollY) globalThis.scrollTo(0, 0);
  });
}

function watchViewport(on) {
  if (on) document.addEventListener('focusout', onFocusOut);
  else document.removeEventListener('focusout', onFocusOut);
}

/* --------------------------------------------------------------- open/close */

function close(after) {
  open = false;
  el.root.classList.remove('is-open');
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onKey);
  watchViewport(false);
  setTimeout(() => {
    el.root.hidden = true;
    after?.();
  }, 460);
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); quit(); }
}

function quit() {
  close(() => done?.onSkip?.());
}

/* `profile` is whatever storage already holds — empty on first run, populated
   when reopened from the topbar. `mode: 'edit'` only changes the wording and
   the fact that leaving is a cancel rather than a skip. */
export function openOnboarding({ profile = {}, mode = 'setup', onSave, onSkip } = {}) {
  if (open) return;
  open = true;
  editing = mode === 'edit';
  done = { onSave, onSkip };
  step = 0;

  draft = {
    heightCm: Number(profile.heightCm) || NaN,
    weightKg: Number(profile.weightKg) || NaN,
    age: Number(profile.age) || NaN,
    sex: profile.sex || '',
    activity: profile.activity || '',
    goal: profile.goal || '',

    /* An account opened before these fields existed has none of them, and the
       defaults have to be the answers that change nothing: no diabetes, no
       insulin, no strip on the main screen. Only an explicit answer on the
       health step turns any of it on. */
    diabetesType: profile.diabetesType || '',
    insulinUse: profile.insulinUse || '',
    insulinType: profile.insulinType || 'rapid',
    carbRatio: Number(profile.carbRatio) || NaN,
    correctionFactor: Number(profile.correctionFactor) || NaN,
    targetBg: Number(profile.targetBg) || NaN,
    diaHours: Number(profile.diaHours) || NaN,
    maxBolus: Number(profile.maxBolus) || NaN,
    doseIncrement: Number(profile.doseIncrement) || 0.5,
    tdd: Number(profile.tdd) || NaN,
    useTrendArrows: !!profile.useTrendArrows,
    slotRatios: { ...(profile.slotRatios || {}) },
  };
  units = profile.units === 'metric' ? 'metric' : 'imperial';
  gUnits = profile.glucoseUnits === 'mmoll' ? 'mmoll' : 'mgdl';

  el.track.innerHTML = bodyStep() + whoStep() + activityStep() + goalStep()
    + healthStep() + insulinStep() + fineStep() + summaryStep();
  wire();
  paintMeasures();
  paintChoices();
  paintNumbers();
  paintGlucose();
  paintFine();

  /* No transition on the jump to step 0: the layer is still off-screen, and a
     track that animates while sliding up reads as two competing motions. */
  el.track.style.transition = 'none';
  goTo(0, { focus: false });
  el.root.hidden = false;

  /* Armed before the slide rather than after it: the first step can raise the
     keyboard on its own, and the scroll it leaves behind has to be caught
     whenever it happens. */
  watchViewport(true);

  /* One frame with the layer laid out but still translated off the bottom,
     so the browser has a start value to animate the slide from. */
  requestAnimationFrame(() => {
    el.track.style.transition = '';
    el.root.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  });

  document.addEventListener('keydown', onKey);
}

el.next.onclick = advance;
el.back.onclick = () => goTo(seek(step, -1));
el.quit.onclick = quit;
