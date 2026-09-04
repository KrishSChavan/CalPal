/* ==========================================================================
   onboarding.js — the five slides that produce a daily calorie target.

   Owns the overlay in index.html and nothing else. All arithmetic lives in
   profile.js, all persistence in storage.js; this file is the screen between
   them. The option lists are rendered from profile.js's own tables, so the
   activity multipliers exist in exactly one place.

   Two entry points, one flow:
     · first run   — no profile yet. "Skip" is offered, because trapping
                     someone behind a form to reach a log they already have
                     meals in would be worse than shipping without a target.
     · edit        — opened from the topbar later. Prefilled, "Cancel" instead
                     of "Skip", and it lands on step 1 so a weight change is
                     four taps rather than a fresh interrogation.
   ========================================================================== */

import * as P from './profile.js';

const $ = (id) => document.getElementById(id);

const el = {
  root: $('onboard'), track: $('obTrack'), ticks: $('obTicks'),
  back: $('obBack'), quit: $('obQuit'), next: $('obNext'),
};

const STEPS = ['body', 'who', 'activity', 'goal', 'summary'];
const LAST = STEPS.length - 1;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/* ------------------------------------------------------------------ state */

let draft = {};          // the profile being built; heightCm/weightKg are canonical
let units = 'imperial';  // display only — never what gets stored
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
  `;
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

const CHOICES = [['obSex', 'sex'], ['obActivity', 'activity'], ['obGoal', 'goal']];

function paintChoices() {
  for (const [id, key] of CHOICES) {
    const cards = [...$(id).children];
    const chosen = cards.findIndex((c) => c.dataset.value === draft[key]);
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

function paintChrome() {
  el.ticks.innerHTML = STEPS.map((_, i) =>
    `<span class="onboard__tick${i <= step ? ' is-done' : ''}"></span>`).join('');
  el.back.hidden = step === 0;
  el.next.textContent = step === LAST ? (editing ? 'Save' : 'Start tracking') : 'Continue';
  el.quit.textContent = editing ? 'Cancel' : 'Skip';
}

/* --------------------------------------------------------------- movement */

function goTo(next, { focus = true } = {}) {
  step = Math.max(0, Math.min(LAST, next));
  if (step === LAST) renderSummary();

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

  for (const [id, key] of CHOICES) {
    const group = $(id);
    const pick = (card) => {
      draft[key] = card.dataset.value;
      paintChoices();
      showError(`${id}Err`, '');
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
  if (step < LAST) return goTo(step + 1);

  /* Last gate before anything is written. */
  const errors = P.validate(draft);
  const missing = Object.keys(errors);
  if (missing.length) {
    const first = STEPS.findIndex((name) =>
      (name === 'body' && (errors.heightCm || errors.weightKg))
      || (name === 'who' && (errors.age || errors.sex))
      || (name === 'activity' && errors.activity)
      || (name === 'goal' && errors.goal));
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
  }));
}

/* --------------------------------------------------------------- open/close */

function close(after) {
  open = false;
  el.root.classList.remove('is-open');
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onKey);
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
  };
  units = profile.units === 'metric' ? 'metric' : 'imperial';

  el.track.innerHTML = bodyStep() + whoStep() + activityStep() + goalStep() + summaryStep();
  wire();
  paintMeasures();
  paintChoices();

  /* No transition on the jump to step 0: the layer is still off-screen, and a
     track that animates while sliding up reads as two competing motions. */
  el.track.style.transition = 'none';
  goTo(0, { focus: false });
  el.root.hidden = false;

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
el.back.onclick = () => goTo(step - 1);
el.quit.onclick = quit;
