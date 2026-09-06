/* ==========================================================================
   app.js — screen logic.
   ========================================================================== */

import * as store from './storage.js';
import { takePhoto, choosePhoto, normalize, formatBytes } from './camera.js';
import { analyzeMeal, ApiError } from './api.js';
import { requireSession, namespaceFor, signOut, LANDING_URL } from './auth.js';
import { consumption } from './profile.js';
import * as D from './insulin.js';
import { openOnboarding } from './onboarding.js';

const $ = (id) => document.getElementById(id);

const el = {
  dateLabel: $('dateLabel'), prevDay: $('prevDay'), nextDay: $('nextDay'),
  dayKcal: $('dayKcal'), dayMeta: $('dayMeta'),
  dayGoal: $('dayGoal'), dayRule: $('dayRule'), dayFill: $('dayFill'), dayLeft: $('dayLeft'),
  dayProtein: $('dayProtein'), dayCarb: $('dayCarb'), dayFat: $('dayFat'),
  meals: $('meals'), mealCount: $('mealCount'),
  snapBtn: $('snapBtn'), manualBtn: $('manualBtn'),

  addScrim: $('addScrim'), tabPhoto: $('tabPhoto'), tabManual: $('tabManual'),
  panePhoto: $('panePhoto'), paneManual: $('paneManual'),
  capture: $('capture'), captureImg: $('captureImg'), captureSize: $('captureSize'),
  captureClear: $('captureClear'), takeBtn: $('takeBtn'), chooseBtn: $('chooseBtn'),
  photoSlot: $('photoSlot'), photoNotes: $('photoNotes'),
  manualName: $('manualName'), manualKcal: $('manualKcal'), manualSlot: $('manualSlot'),
  manualCarb: $('manualCarb'), manualCarbWhy: $('manualCarbWhy'),
  addSubmit: $('addSubmit'),

  insulinWindow: $('insulinWindow'), winTotal: $('winTotal'), winActive: $('winActive'),
  winCob: $('winCob'), winBg: $('winBg'), winDoses: $('winDoses'), doseBtn: $('doseBtn'),
  doseScrim: $('doseScrim'), doseBody: $('doseBody'), doseTitle: $('doseTitle'),
  doseSave: $('doseSave'), doseDelete: $('doseDelete'),

  confirmScrim: $('confirmScrim'), confirmBody: $('confirmBody'), confirmSave: $('confirmSave'),
  mealScrim: $('mealScrim'), mealBody: $('mealBody'), mealTitle: $('mealTitle'),
  mealDelete: $('mealDelete'), mealSave: $('mealSave'),

  signOut: $('signOutBtn'), profileBtn: $('profileBtn'),

  busy: $('busy'), busyLabel: $('busyLabel'), toast: $('toast'),
};

const SLOT_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };
const SLOT_GLYPH = { breakfast: '🍳', lunch: '🥗', dinner: '🍽️', snack: '🍎' };

let viewKey = store.dateKey();
let mode = 'photo';
let shot = null;      // normalized capture: {blob, dataUrl, thumb, bytes}
let draft = null;     // pending analysis being confirmed
let editing = null;   // meal id open in the meal sheet
let ins = null;       // the dose card's own state, alongside a draft meal
let doseEdit = null;  // { key, id } open in the dose sheet, or null for a new one

/* ------------------------------------------------------------------ utils */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

const round = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : 0);

function toast(msg, tone) {
  el.toast.textContent = msg;
  el.toast.className = `toast is-on${tone === 'risk' ? ' toast--risk' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.className = 'toast'; }, 4200);
}

function busy(on, label) {
  if (label) el.busyLabel.textContent = label;
  el.busy.classList.toggle('is-on', !!on);
}

function openSheet(scrim) {
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add('is-open'));
  document.body.style.overflow = 'hidden';
}

function closeSheet(scrim) {
  scrim.classList.remove('is-open');
  document.body.style.overflow = '';
  setTimeout(() => { scrim.hidden = true; }, 260);
}

function confidenceBand(c) {
  const n = Number(c);
  if (!Number.isFinite(n)) return { cls: 'med', text: 'Estimated' };
  if (n >= 0.7) return { cls: 'high', text: 'Confident' };
  if (n >= 0.45) return { cls: 'med', text: 'Rough estimate' };
  return { cls: 'low', text: 'Low confidence' };
}

/* ------------------------------------------------------------------ chips */

function buildSlotChips(container, selected, onPick) {
  container.innerHTML = '';
  for (const slot of store.SLOTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip${slot === selected ? ' is-on' : ''}`;
    b.dataset.slot = slot;
    b.textContent = SLOT_LABEL[slot];
    b.setAttribute('aria-pressed', String(slot === selected));
    b.onclick = () => {
      for (const c of container.children) {
        const on = c === b;
        c.classList.toggle('is-on', on);
        c.setAttribute('aria-pressed', String(on));
      }
      onPick?.(slot);
    };
    container.appendChild(b);
  }
}

const pickedSlot = (container) => container.querySelector('.chip.is-on')?.dataset.slot || store.slotForTime();

/* ------------------------------------------------------------ goal bar */

/* Fills the heavy rule under the day's total. With no target set there is
   nothing to fill against, so everything the goal added is put away and the
   rule goes back to being the plain Nutrition Facts bar it started as —
   an empty track would imply a target the day had not been eaten into.

   Note this reads the profile fresh on every render rather than caching it:
   the onboarding overlay can change the target while the app is mounted
   behind it, and a cached goal would leave a stale bar under a live number. */
function paintGoal(kcal) {
  const c = consumption(kcal, store.getProfile().goalKcal);

  if (!c) {
    el.dayGoal.hidden = true;
    el.dayLeft.hidden = true;
    el.dayFill.style.width = '0%';
    el.dayRule.className = 'readout__rule';
    for (const attr of ['role', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-label']) {
      el.dayRule.removeAttribute(attr);
    }
    return;
  }

  el.dayGoal.hidden = false;
  el.dayGoal.textContent = `of ${c.target.toLocaleString()}`;

  el.dayRule.className = `readout__rule has-goal readout__rule--${c.band}`;
  el.dayFill.style.width = `${c.fill * 100}%`;

  /* The bar is the only place the ratio is drawn, so it has to carry the
     number for anyone who cannot see it drawn. */
  el.dayRule.setAttribute('role', 'progressbar');
  el.dayRule.setAttribute('aria-valuemin', '0');
  el.dayRule.setAttribute('aria-valuemax', String(c.target));
  el.dayRule.setAttribute('aria-valuenow', String(Math.min(c.eaten, c.target)));
  el.dayRule.setAttribute('aria-label', `${c.percent}% of a ${c.target.toLocaleString()} kcal target`);

  el.dayLeft.hidden = false;
  el.dayLeft.classList.toggle('is-over', c.over);
  el.dayLeft.innerHTML = c.over
    ? `<b>${Math.abs(c.remaining).toLocaleString()} over</b><span>${c.percent}% of target</span>`
    : `<b>${c.remaining.toLocaleString()} left</b><span>${c.percent}% of target</span>`;
}

/* ------------------------------------------------------------ the window */

/* Read fresh on every call, never cached, for the same reason paintGoal()
   does it: the account overlay can change a carb ratio while the app is
   mounted behind it, and a cached profile would leave the strip and the dose
   card disagreeing with the settings that produced them. */
const profile = () => store.getProfile();
const dosing = () => D.dosesInsulin(profile());

const gLabel = (mgdl) => D.glucoseLabel(mgdl, profile().glucoseUnits);
const gUnitName = () => (D.isMmol(profile().glucoseUnits) ? 'mmol/L' : 'mg/dL');
const gStep = () => (D.isMmol(profile().glucoseUnits) ? '0.1' : '1');

/* Both halves of the sliding window at one instant. The lookback is the
   duration of action itself rather than "today", because a dose taken at
   23:40 is still working at 01:20 and lives under the previous day's key. */
function windowAt(at = Date.now()) {
  const p = profile();
  const action = D.actionProfile(p);
  const absorbMin = (Number(p.carbAbsorptionHours) || D.CARB_ABSORPTION_HOURS) * 60;
  return {
    action,
    iob: D.insulinOnBoard(store.dosesBetween(at - action.diaMin * 60000, at), at, p),
    cob: D.carbsOnBoard(store.mealsBetween(at - absorbMin * 60000, at), at, p),
  };
}

const DOSE_KIND_LABEL = { bolus: 'Bolus', basal: 'Long-acting', reading: 'Reading' };

function paintWindow() {
  if (!dosing()) {
    el.insulinWindow.hidden = true;
    return;
  }
  el.insulinWindow.hidden = false;

  const totals = store.insulinTotalsOn(viewKey);
  el.winTotal.innerHTML = `${totals.bolus}<span>u</span>`;

  /* Active insulin and absorbing carbohydrate are properties of *now*. On a
     day being reviewed rather than lived they are not zero, they are not a
     question that has an answer, so the tiles say so rather than printing a
     confident nothing. */
  const live = viewKey === store.dateKey();
  if (live) {
    const w = windowAt();
    /* One decimal on the tile. The calculator keeps the full figure and
       subtracts that, but 9.29 units printed on a strip is a precision the
       underlying curve does not have and nobody can act on. */
    el.winActive.innerHTML = `${r1(w.iob.units)}<span>u</span>`;
    el.winCob.innerHTML = `${w.cob}<span>g</span>`;
    el.winActive.title = w.iob.parts.length
      ? w.iob.parts.map((x) => `${Math.round(x.remaining * 10) / 10}u left of ${x.units}u, ${x.minutesAgo} min ago`).join('\n')
      : 'Nothing still working';
  } else {
    el.winActive.innerHTML = '—';
    el.winCob.innerHTML = '—';
    el.winActive.removeAttribute('title');
  }

  const doses = store.dosesOn(viewKey);
  const reading = [...doses].reverse().find((d) => Number(d.bg) > 0);
  if (reading) {
    const band = D.glucoseBand(reading.bg);
    el.winBg.innerHTML = `${D.glucoseOut(reading.bg, profile().glucoseUnits)}<span data-tone="${esc(band.tone)}">${esc(band.label.toLowerCase())}</span>`;
  } else {
    el.winBg.innerHTML = '—';
  }

  el.winDoses.innerHTML = doses.length
    ? doses.map((d) => {
        const time = new Date(d.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        const bits = [];
        if (Number(d.units) > 0) bits.push(`${Number(d.units)} u`);
        if (Number(d.bg) > 0) bits.push(gLabel(d.bg));
        if (d.mealName) bits.push(esc(d.mealName));
        return `
          <button class="wdose" data-dose="${esc(d.id)}">
            <span class="wdose__time">${esc(time)}</span>
            <span class="wdose__kind slot slot--${d.kind === 'basal' ? 'snack' : d.kind === 'reading' ? 'lunch' : 'dinner'}">${esc(DOSE_KIND_LABEL[d.kind] || d.kind)}</span>
            <span class="wdose__body">${bits.join(' · ')}</span>
          </button>`;
      }).join('')
    : '';

  for (const node of el.winDoses.querySelectorAll('[data-dose]')) {
    node.onclick = () => openDose(node.dataset.dose);
  }
}

/* Active insulin falls continuously, so a strip painted once at load is wrong
   within minutes. Cheap enough to redraw on a minute's tick — it reads four
   numbers out of localStorage — and it stops only while the tab is hidden,
   where nothing is being looked at anyway. */
let windowTimer = null;

function watchWindow() {
  clearInterval(windowTimer);
  if (!dosing()) return;
  windowTimer = setInterval(() => {
    if (document.visibilityState === 'visible') paintWindow();
  }, 60000);
}

/* -------------------------------------------------------- the arrow row */

function arrowPicker(id, selected) {
  const chosen = D.trendById(selected);
  return `
    <div class="arrows" id="${id}" role="radiogroup" aria-label="Glucose trend arrow">
      ${D.TREND.map((t) => `
        <button type="button" class="arrow${t.id === selected ? ' is-on' : ''}" role="radio"
                aria-checked="${t.id === selected}" data-trend="${esc(t.id)}"
                aria-label="${esc(t.label)}, ${esc(t.rate)}">${t.glyph}</button>`).join('')}
    </div>
    <p class="field__hint" id="${id}Hint">${arrowHint(chosen)}</p>`;
}

function arrowHint(t) {
  if (!t) return 'Optional — the arrow your CGM is showing right now.';
  const per30 = t.per30 > 0 ? `+${t.per30}` : String(t.per30);
  return `<strong>${esc(t.label)}</strong> — ${esc(t.rate)}, roughly ${per30} mg/dL over the next half hour.`;
}

/* One selection handler for both arrow rows. Assigned per render, so nothing
   stacks across reopenings of the sheet. */
function wireArrows(id, onPick) {
  const group = $(id);
  if (!group) return;
  for (const btn of group.querySelectorAll('[data-trend]')) {
    btn.onclick = () => {
      /* Tapping the chosen arrow again clears it: a trend is a thing you can
         stop asserting, and there is no "no arrow" button to reach for. */
      const next = btn.classList.contains('is-on') ? null : btn.dataset.trend;
      for (const b of group.querySelectorAll('[data-trend]')) {
        const on = b.dataset.trend === next;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', String(on));
      }
      const hint = $(`${id}Hint`);
      if (hint) hint.innerHTML = arrowHint(D.trendById(next));
      onPick(next);
    };
  }
}

/* ----------------------------------------------------------------- render */

function render() {
  const today = store.dateKey();
  el.dateLabel.textContent = store.labelForKey(viewKey);
  el.nextDay.disabled = viewKey >= today;

  const t = store.totalsOn(viewKey);
  el.dayKcal.textContent = t.kcal.toLocaleString();
  paintGoal(t.kcal);
  paintWindow();
  el.dayProtein.innerHTML = `${t.protein}<span>g</span>`;
  el.dayCarb.innerHTML = `${t.carb}<span>g</span>`;
  el.dayFat.innerHTML = `${t.fat}<span>g</span>`;

  const meals = store.mealsOn(viewKey);
  el.mealCount.textContent = meals.length ? `${meals.length}` : '';
  el.dayMeta.textContent = meals.length
    ? `${meals.length} meal${meals.length > 1 ? 's' : ''} logged`
    : viewKey === today ? 'No meals logged yet' : 'Nothing logged this day';

  if (!meals.length) {
    el.meals.innerHTML = `<div class="empty"><strong>Nothing here yet</strong>Snap a photo of your next meal.</div>`;
    return;
  }

  el.meals.innerHTML = meals.map((m) => {
    const time = new Date(m.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const thumb = m.thumb
      ? `<img class="meal__thumb" src="${esc(m.thumb)}" alt="">`
      : `<div class="meal__thumb meal__thumb--glyph">${SLOT_GLYPH[m.slot] || '🍽️'}</div>`;
    return `
      <button class="meal" data-id="${esc(m.id)}">
        ${thumb}
        <div class="meal__body">
          <div class="meal__name">${esc(m.name)}</div>
          <div class="meal__meta">
            <span class="slot slot--${esc(m.slot)}">${esc(SLOT_LABEL[m.slot] || m.slot)}</span>
            <span class="dot">·</span><span>${esc(time)}</span>
            ${m.edited ? '<span class="dot">·</span><span>edited</span>' : ''}
          </div>
        </div>
        <div class="meal__kcal num">${round(m.kcal).toLocaleString()}<span>kcal</span></div>
      </button>`;
  }).join('');

  for (const node of el.meals.querySelectorAll('.meal')) {
    node.onclick = () => openMeal(node.dataset.id);
  }
}

/* -------------------------------------------------------------- add sheet */

function resetAdd() {
  shot = null;
  el.capture.classList.remove('has-image');
  el.captureImg.removeAttribute('src');
  el.captureSize.textContent = '';
  el.photoNotes.value = '';
  el.manualName.value = '';
  el.manualKcal.value = '';
  el.manualCarb.value = '';
  /* Optional for everybody, and the thing the dose divides for anyone
     counting carbs — so the label stops calling it optional to them. */
  el.manualCarbWhy.textContent = D.countsCarbs(profile()) ? 'for your dose' : 'optional';
  const slot = store.slotForTime();
  buildSlotChips(el.photoSlot, slot);
  buildSlotChips(el.manualSlot, slot);
  setMode('photo');
}

function setMode(next) {
  mode = next;
  const photo = next === 'photo';
  el.tabPhoto.classList.toggle('is-on', photo);
  el.tabManual.classList.toggle('is-on', !photo);
  el.tabPhoto.setAttribute('aria-selected', String(photo));
  el.tabManual.setAttribute('aria-selected', String(!photo));
  el.panePhoto.hidden = !photo;
  el.paneManual.hidden = photo;
  el.addSubmit.textContent = photo ? 'Analyze' : 'Add meal';
}

async function receivePhoto(file) {
  try {
    busy(true, 'Preparing photo…');
    shot = await normalize(file);
    el.captureImg.src = shot.dataUrl;
    el.captureSize.textContent = formatBytes(shot.bytes);
    el.capture.classList.add('has-image');
  } catch (err) {
    toast(err.message, 'risk');
  } finally {
    busy(false);
  }
}

async function submitAdd() {
  if (mode === 'manual') {
    const name = el.manualName.value.trim();
    const kcal = parseInt(el.manualKcal.value, 10);
    if (!name) return toast('Give the meal a name.', 'risk');
    if (!Number.isFinite(kcal) || kcal <= 0) return toast('Enter the calories.', 'risk');

    const carb = Math.max(0, parseInt(el.manualCarb.value, 10) || 0);
    const slot = pickedSlot(el.manualSlot);
    const res = store.addMeal(viewKey, {
      name, kcal, carb, slot,
      source: 'manual',
      thumb: shot?.thumb,   // a photo is optional here, but kept if one was taken
    });
    if (!res.persisted) toast("Saved, but storage is full — clear some old days.", 'risk');
    closeSheet(el.addScrim);
    render();
    /* A hand-typed meal with carbohydrate on it is a dose waiting to be
       worked out, so the correction sheet opens onto it prefilled rather than
       making somebody re-type the number they just entered. */
    if (carb > 0 && D.countsCarbs(profile())) {
      openDose(null, { carbGrams: carb, slot, mealName: name, mealId: res.meal.id });
    }
    return;
  }

  if (!shot) return toast('Take or choose a photo first.', 'risk');

  const slot = pickedSlot(el.photoSlot);
  try {
    busy(true, 'Reading the plate…');
    const result = await analyzeMeal({
      blob: shot.blob,
      notes: el.photoNotes.value.trim(),
      slot,
      localTimeLabel: new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      plateDiameterCm: store.getProfile().plateDiameterCm,
    });
    draft = {
      ...result,
      slot: result.slot || slot,
      thumb: shot.thumb,
      notes: el.photoNotes.value.trim(),
    };
    closeSheet(el.addScrim);
    renderConfirm();
    openSheet(el.confirmScrim);
  } catch (err) {
    /* A token the server rejected is not something a retry fixes, and leaving
       a dead session in place would fail every later photo the same way. Clear
       it and send them back to the gate. A guest hitting no_session is NOT
       that case — there is nothing wrong with their session, photo analysis
       simply is not part of what a guest gets, so say so and stay put. */
    if (err instanceof ApiError && (err.code === 'session_expired' || err.code === 'bad_session')) {
      signOut();
      toast(err.message, 'risk');
      setTimeout(() => location.replace(LANDING_URL), 1200);
      return;
    }
    toast(err instanceof ApiError ? err.message : 'Analysis failed. Check your connection and try again.', 'risk');
  } finally {
    busy(false);
  }
}

/* ---------------------------------------------------------- confirm sheet */

function recomputeDraft() {
  let kcal = 0, protein = 0, carb = 0, fat = 0;
  for (const c of draft.components) {
    const g = Number(c.grams) || 0;
    if (Number.isFinite(c.kcal100)) {
      c.kcal = (c.kcal100 * g) / 100;
      c.protein = ((c.protein100 || 0) * g) / 100;
      c.carb = ((c.carb100 || 0) * g) / 100;
      c.fat = ((c.fat100 || 0) * g) / 100;
    }
    kcal += Number(c.kcal) || 0;
    protein += Number(c.protein) || 0;
    carb += Number(c.carb) || 0;
    fat += Number(c.fat) || 0;
  }
  draft.kcal = kcal;
  draft.protein = protein;
  draft.carb = carb;
  draft.fat = fat;
  /* Widen the model's own spread. Published 2D-VLM error runs 25-40% MAPE and
     skews low, and LLM-emitted intervals have no measured coverage, so a
     narrow range would be false precision. */
  draft.kcalLow = Math.round(kcal * 0.7);
  draft.kcalHigh = Math.round(kcal * 1.35);
}

/* Two different failures wear the same "no match" label, and they need
   different words. A component the model priced is an unsourced guess; one it
   didn't is simply missing from the total, and saying "estimated" there would
   be a lie. */
function unmatchedNote(components) {
  const unmatched = components.filter((c) => !c.matched);
  if (!unmatched.length) return '';
  const uncounted = unmatched.filter((c) => !(Number(c.kcal) > 0));
  const estimated = unmatched.filter((c) => Number(c.kcal) > 0);

  const lines = [];
  if (uncounted.length) {
    const names = uncounted.map((c) => c.name).join(', ');
    lines.push(
      `<strong>${esc(names)}</strong> ${uncounted.length > 1 ? 'were' : 'was'} not found in the database and ${uncounted.length > 1 ? 'are' : 'is'} counting as zero. Type the grams and calories in yourself, or remove ${uncounted.length > 1 ? 'them' : 'it'}.`
    );
  }
  if (estimated.length) {
    const names = estimated.map((c) => c.name).join(', ');
    lines.push(
      `<strong>${esc(names)}</strong> had no database match, so ${estimated.length > 1 ? 'those calories are' : 'that calorie figure is'} the model's guess rather than a looked-up value.`
    );
  }
  return `<div class="notice notice--risk">${lines.join('<br><br>')}</div>`;
}

function renderConfirm() {
  recomputeDraft();
  const band = confidenceBand(draft.confidence);

  el.confirmBody.innerHTML = `
    <div class="field" style="margin-top:0.5rem;">
      <label class="field__label" for="draftName">Meal name</label>
      <input class="input" id="draftName" type="text" value="${esc(draft.dishName || 'Meal')}">
    </div>

    <div class="field">
      <label class="field__label">Meal</label>
      <div class="chips" id="draftSlot"></div>
    </div>

    <div class="verdict" style="margin-top:1.25rem;">
      <div class="verdict__kcal num" id="draftTotal">0</div>
      <div class="verdict__unit">kcal</div>
      <div class="verdict__range">
        <span id="draftRange"></span><br>
        <span class="confidence confidence--${band.cls}">${esc(band.text)}</span>
      </div>
    </div>

    ${draft.cookingMethod ? `<p class="field__hint" style="margin-top:-0.25rem;">Read as <strong>${esc(draft.cookingMethod.replace(/_/g, ' '))}</strong>${draft.cuisine ? ` · ${esc(draft.cuisine)}` : ''}</p>` : ''}

    <div class="section-head" style="padding-top:1.25rem;">
      <h3 class="eyebrow">Cross-referenced against USDA FNDDS</h3>
    </div>
    <div class="components" id="draftComponents"></div>

    ${draft.clarifyingQuestion ? `
      <div class="ask">
        <div class="ask__q">${esc(draft.clarifyingQuestion)}</div>
        <input class="input" id="draftAnswer" type="text" placeholder="Your answer refines the estimate">
      </div>` : ''}

    ${draft.disagreement?.flagged ? `
      <div class="notice notice--warn">
        The database total (${round(draft.disagreement.dbKcal)} kcal) and the model's own estimate
        (${round(draft.disagreement.modelKcal)} kcal) disagree by more than a third. The component list
        below is probably where it went wrong — check the portions.
      </div>` : ''}

    ${unmatchedNote(draft.components)}

    <div id="draftInsulin"></div>
  `;

  buildSlotChips($('draftSlot'), draft.slot, (s) => {
    draft.slot = s;
    /* The slot is part of the dose: a breakfast ratio and a dinner ratio are
       different numbers for the same plate, so changing the chip has to move
       the suggestion under it. */
    if (ins) { ins.slot = s; paintDoseResult(); }
  });
  renderComponents();
  renderDoseCard();
}

/* -------------------------------------------------- the mealtime dose */

/* Lives inside the confirm sheet rather than in a sheet of its own, because a
   dose worked out from a plate belongs beside the plate — and because the
   carbohydrate figure it divides is the one thing on this screen most worth
   correcting before anybody acts on it. */
function renderDoseCard() {
  const host = $('draftInsulin');
  if (!host) return;
  const p = profile();
  if (!D.dosesInsulin(p)) { host.innerHTML = ''; ins = null; return; }

  ins = {
    carbGrams: Math.round(Number(draft.carb) || 0),
    bg: null,
    trend: null,
    slot: draft.slot,
    log: true,
    units: null,
  };

  host.innerHTML = `
    <div class="section-head" style="padding-top:1.5rem;">
      <h3 class="eyebrow">Your dose</h3>
    </div>

    <div class="dose">
      <div class="dose__inputs">
        ${D.countsCarbs(p) ? `
          <div class="field" style="margin-top:0;">
            <label class="field__label" for="doseCarb">Carbohydrate</label>
            <div class="measure">
              <input class="input input--num" id="doseCarb" type="number" inputmode="numeric" min="0" max="${D.LIMITS.carbGrams.max}" step="1" value="${ins.carbGrams}">
              <span class="measure__unit">g</span>
            </div>
            <p class="field__hint">Totalled from the components above. FNDDS reports carbohydrate by difference, which counts fibre in — so a very high-fibre plate reads a little high here, and this is the box to correct if you subtract it.</p>
          </div>` : ''}

        <div class="field">
          <label class="field__label" for="doseBg">Glucose now <span class="field__opt">optional</span></label>
          <div class="measure">
            <input class="input input--num" id="doseBg" type="number" inputmode="decimal" step="${gStep()}" placeholder="—">
            <span class="measure__unit measure__unit--wide">${esc(gUnitName())}</span>
          </div>
          <p class="field__hint">Leave it empty and you get the food dose alone, with no correction either way.</p>
        </div>

        ${p.useTrendArrows ? `
          <div class="field">
            <span class="field__label">Trend arrow</span>
            ${arrowPicker('doseArrows', null)}
          </div>` : ''}
      </div>

      <div id="doseResult"></div>
    </div>`;

  $('doseCarb') && ($('doseCarb').oninput = () => {
    ins.carbGrams = Math.max(0, Number($('doseCarb').value) || 0);
    paintDoseResult();
  });
  $('doseBg').oninput = () => {
    const raw = $('doseBg').value.trim();
    ins.bg = raw === '' ? null : D.glucoseIn(raw, p.glucoseUnits);
    paintDoseResult();
  };
  wireArrows('doseArrows', (t) => { ins.trend = t; paintDoseResult(); });

  paintDoseResult();
}

/* The suggestion and its working, repainted on its own so that typing in a
   box above it never costs the box its focus. */
function paintDoseResult() {
  const host = $('doseResult');
  if (!host || !ins) return;
  const p = profile();
  const w = windowAt();
  const dose = D.bolus({
    carbGrams: ins.carbGrams,
    bg: ins.bg,
    trend: ins.trend,
    slot: ins.slot,
    iob: w.iob.units,
    profile: p,
  });
  ins.units = dose.units;

  host.innerHTML = doseVerdict(dose, w) + `
    ${dose.usable && dose.units > 0 ? `
      <label class="dose__log">
        <input type="checkbox" id="doseLog" ${ins.log ? 'checked' : ''}>
        <span>Log this dose</span>
        <span class="dose__logunits">
          <input class="input input--num" id="doseUnits" type="number" inputmode="decimal" min="0" max="${D.LIMITS.units.max}" step="${p.doseIncrement || 0.5}" value="${dose.units}" aria-label="Units to log">
          <span class="measure__unit">u</span>
        </span>
      </label>
      <p class="field__hint">Recorded as what you took, not as what was suggested — edit it to whatever you actually dial. This is what the active-insulin window is built from, so a dose left unlogged is a dose the next suggestion will not know about.</p>` : ''}

    <div class="notice notice--risk dose__legal">${esc(D.DISCLAIMER)}</div>`;

  const log = $('doseLog');
  if (log) log.onchange = () => { ins.log = log.checked; };
  const units = $('doseUnits');
  if (units) units.oninput = () => { ins.units = Math.max(0, Number(units.value) || 0); };
}

/* The verdict block: the number, the split that produced it, and every
   warning the calculator raised. Shared by the confirm sheet and the
   correction sheet so the two can never word the same situation differently. */
function doseVerdict(dose, w) {
  const p = profile();
  const notes = dose.warnings.map((warn) =>
    `<div class="notice notice--${warn.tone === 'risk' ? 'risk' : warn.tone === 'warn' ? 'warn' : 'info'}">${esc(warn.text)}</div>`
  ).join('');

  if (!dose.usable) {
    return dose.holdForLow
      ? `<div class="dose__hold"><div class="dose__holdtitle">Treat the low first</div>${notes}</div>`
      : `${notes}<div class="notice notice--warn">Your ratios are not filled in yet, so there is nothing to work from. Open your details from the top of the screen to add them.</div>`;
  }

  const bits = [];
  if (D.countsCarbs(p)) bits.push(`food ${r1(dose.carbDose)} u`);
  if (dose.bg != null) bits.push(`correction ${r1(dose.correction)} u`);
  if (dose.iobApplied > 0) bits.push(`active −${r1(dose.iobApplied)} u`);

  return `
    <div class="dose__verdict">
      <div class="dose__units num">${dose.units}</div>
      <div class="dose__unitlabel">units</div>
      <div class="dose__split">${bits.join(' · ') || 'nothing to dose'}</div>
    </div>

    <div class="working dose__working">
      ${D.countsCarbs(p) ? `
        <div class="working__row">
          <span class="working__label">Food<small>${Math.round(dose.carbGrams)} g ÷ ${dose.ratio} g per unit${dose.slotRatioUsed ? ' (this meal’s own ratio)' : ''}</small></span>
          <span class="working__value num">${r2(dose.carbDose)}</span>
        </div>` : ''}
      ${dose.bg != null ? `
        <div class="working__row">
          <span class="working__label">Correction<small>${esc(gLabel(dose.bg))}${dose.trend ? ` ${dose.trend.glyph} → treated as ${esc(gLabel(dose.adjustedBg))}` : ''} − target ${esc(gLabel(dose.target))}, ÷ ${esc(gLabel(dose.isf))}</small></span>
          <span class="working__value num">${dose.correctionRaw >= 0 ? '+' : '−'}${r2(Math.abs(dose.correctionRaw))}</span>
        </div>` : `
        <div class="working__row">
          <span class="working__label">Correction<small>No glucose entered, so none applied</small></span>
          <span class="working__value num">0</span>
        </div>`}
      <div class="working__row">
        <span class="working__label">Active insulin<small>${w.iob.parts.length
          ? `${w.iob.parts.length} earlier dose${w.iob.parts.length > 1 ? 's' : ''} still working — taken off the correction only, never off the food`
          : 'Nothing still working from an earlier dose'}</small></span>
        <span class="working__value num">${dose.iobApplied > 0 ? `−${r2(dose.iobApplied)}` : '0'}</span>
      </div>
      <div class="working__row working__row--total">
        <span class="working__label">Suggested${dose.increment === 1 ? ', to the nearest unit' : ', to the nearest half unit'}</span>
        <span class="working__value num">${dose.units} u</span>
      </div>
    </div>

    ${notes}`;
}

const r1 = (n) => Math.round(Number(n) * 10) / 10;
const r2 = (n) => Math.round(Number(n) * 100) / 100;

function renderComponents() {
  const host = $('draftComponents');
  host.innerHTML = draft.components.map((c, i) => {
    const src = c.matched
      ? `<span class="tag">FDC ${esc(c.fdcId)}</span><span>${esc(c.fdcDescription)}</span>${
          c.portionHint ? `<span>· ${esc(c.portionHint)}</span>` : ''
        }<span>· ${round(c.kcal100)} kcal/100g</span>`
      : `<span class="tag tag--nomatch">no match</span><span>${
          Number(c.kcal) > 0 ? "the model's own guess, not a looked-up value" : 'not counted — enter the calories below'
        }</span>`;

    /* Grams alone are meaningless without a kcal/100g to multiply them by, so
       an unmatched component gets a calorie field the user can actually fill. */
    const kcalField = c.matched
      ? ''
      : `<input class="grams-input num" type="number" inputmode="numeric" min="0" step="1"
                value="${round(c.kcal)}" data-kcalin="${i}" aria-label="Calories in ${esc(c.name)}">
         <span class="grams-unit">kcal</span>`;

    return `
      <div class="component" data-i="${i}">
        <div class="component__name">${esc(c.name)}</div>
        <div class="component__kcal num" data-kcal="${i}">${round(c.kcal)}</div>
        <div class="component__source">${src}</div>
        <div class="component__grams">
          <input class="grams-input num" type="number" inputmode="numeric" min="0" step="1"
                 value="${round(c.grams)}" data-grams="${i}" aria-label="Grams of ${esc(c.name)}">
          <span class="grams-unit">g</span>
          ${kcalField}
          <button class="component__drop" data-drop="${i}" type="button">Remove</button>
        </div>
      </div>`;
  }).join('');

  for (const input of host.querySelectorAll('[data-grams]')) {
    input.oninput = () => {
      const i = Number(input.dataset.grams);
      draft.components[i].grams = Math.max(0, Number(input.value) || 0);
      recomputeDraft();
      host.querySelector(`[data-kcal="${i}"]`).textContent = round(draft.components[i].kcal);
      paintTotal();
    };
  }
  for (const input of host.querySelectorAll('[data-kcalin]')) {
    input.oninput = () => {
      const i = Number(input.dataset.kcalin);
      draft.components[i].kcal = Math.max(0, Number(input.value) || 0);
      recomputeDraft();
      host.querySelector(`[data-kcal="${i}"]`).textContent = round(draft.components[i].kcal);
      paintTotal();
    };
  }
  for (const btn of host.querySelectorAll('[data-drop]')) {
    btn.onclick = () => {
      draft.components.splice(Number(btn.dataset.drop), 1);
      recomputeDraft();
      renderComponents();
      paintTotal();
    };
  }
  paintTotal();
}

function paintTotal() {
  const total = $('draftTotal');
  if (!total) return;
  total.textContent = round(draft.kcal).toLocaleString();
  $('draftRange').textContent = `${draft.kcalLow.toLocaleString()}–${draft.kcalHigh.toLocaleString()}`;
}

function saveDraft() {
  if (!draft) return;
  if (!draft.components.length) return toast('Nothing left to save — add an item or discard.', 'risk');

  const name = $('draftName')?.value.trim() || draft.dishName || 'Meal';
  const res = store.addMeal(viewKey, {
    name,
    slot: draft.slot,
    kcal: round(draft.kcal),
    kcalLow: draft.kcalLow,
    kcalHigh: draft.kcalHigh,
    protein: round(draft.protein),
    carb: round(draft.carb),
    fat: round(draft.fat),
    components: draft.components.map((c) => ({
      name: c.name, grams: round(c.grams), kcal: round(c.kcal),
      fdcId: c.fdcId ?? null, fdcDescription: c.fdcDescription ?? null, matched: !!c.matched,
    })),
    cookingMethod: draft.cookingMethod || null,
    confidence: draft.confidence ?? null,
    notes: draft.notes || '',
    thumb: draft.thumb,
    source: 'ai',
  });

  logMealDose(name, res.meal.id);

  draft = null;
  ins = null;
  closeSheet(el.confirmScrim);
  render();
  if (!res.persisted) toast('Saved, but storage is full — older photos were dropped.', 'risk');
  else if (res.thumbEvicted) toast('Saved. Storage was tight so the photo was not kept.');
}

/* The dose that went with the meal, written as a separate row rather than a
   field on the meal. Two reasons: a correction taken an hour later is the
   same kind of thing and has no meal to hang off, and the sliding window
   reads doses on their own timeline — the meal it was aimed at is a label on
   the row, not the thing that owns it.

   A glucose reading is worth keeping even when no insulin was taken, so a
   reading typed with the dose box left at zero still lands. */
function logMealDose(mealName, mealId) {
  if (!ins) return;
  const units = Number(ins.units) || 0;
  const hasReading = Number(ins.bg) > 0;
  if ((!ins.log || units <= 0) && !hasReading) return;

  const took = ins.log && units > 0;
  store.addDose(viewKey, {
    kind: took ? 'bolus' : 'reading',
    units: took ? units : 0,
    bg: hasReading ? ins.bg : null,
    trend: ins.trend || null,
    carbGrams: ins.carbGrams || null,
    mealId,
    mealName,
  });
  if (took) toast(`${units} units logged. They count against your next dose for the next few hours.`);
}

/* ------------------------------------------------------------- meal sheet */

function openMeal(id) {
  const m = store.findMeal(viewKey, id);
  if (!m) return;
  editing = id;
  el.mealTitle.textContent = m.name;

  const comps = (m.components || []).filter((c) => c.matched || c.fdcDescription);
  el.mealBody.innerHTML = `
    ${m.thumb ? `<img src="${esc(m.thumb)}" alt="" style="width:100%;max-height:12rem;object-fit:cover;border-radius:var(--r-md);margin-top:0.5rem;">` : ''}
    <div class="field">
      <label class="field__label" for="editName">Meal name</label>
      <input class="input" id="editName" type="text" value="${esc(m.name)}">
    </div>
    <div class="field">
      <label class="field__label" for="editKcal">Calories</label>
      <input class="input input--num" id="editKcal" type="number" inputmode="numeric" min="0" step="1" value="${round(m.kcal)}">
      ${m.kcalLow ? `<p class="field__hint">Originally estimated ${m.kcalLow.toLocaleString()}–${m.kcalHigh.toLocaleString()} kcal.</p>` : ''}
    </div>
    ${D.countsCarbs(profile()) ? `
      <div class="field">
        <label class="field__label" for="editCarb">Carbohydrate</label>
        <div class="measure">
          <input class="input input--num" id="editCarb" type="number" inputmode="numeric" min="0" max="${D.LIMITS.carbGrams.max}" step="1" value="${round(m.carb)}">
          <span class="measure__unit">g</span>
        </div>
        <p class="field__hint">Correcting this changes what the absorbing-carbs figure shows. It does not go back and change a dose you have already logged — that row is a record of what you took.</p>
      </div>` : ''}
    <div class="field">
      <label class="field__label">Meal</label>
      <div class="chips" id="editSlot"></div>
    </div>
    ${mealDoseNote(m)}
    ${comps.length ? `
      <div class="section-head"><h3 class="eyebrow">What this was built from</h3></div>
      <div class="components">
        ${comps.map((c) => `
          <div class="component">
            <div class="component__name">${esc(c.name)}</div>
            <div class="component__kcal num">${round(c.kcal)}</div>
            <div class="component__source">
              ${c.matched ? `<span class="tag">FDC ${esc(c.fdcId)}</span><span>${esc(c.fdcDescription)}</span>` : '<span class="tag tag--nomatch">no match</span>'}
              <span>· ${round(c.grams)} g</span>
            </div>
          </div>`).join('')}
      </div>` : ''}
    ${m.notes ? `<p class="field__hint" style="margin-top:1rem;">${esc(m.notes)}</p>` : ''}
  `;
  buildSlotChips($('editSlot'), m.slot);
  openSheet(el.mealScrim);
}

/* What was taken for this plate, if anything was. Read back out of the dose
   log rather than off the meal, because that is where it lives — and the
   absence of a row is itself worth saying to someone who counts carbs, since
   an unlogged dose is one the next suggestion will not subtract. */
function mealDoseNote(m) {
  if (!D.dosesInsulin(profile())) return '';
  const linked = store.dosesOn(viewKey).filter((d) => d.mealId === m.id && Number(d.units) > 0);
  if (!linked.length) {
    return Number(m.carb) > 0
      ? `<div class="notice notice--warn">No insulin is logged against this meal, so the ${round(m.carb)} g in it is not counted anywhere in your active-insulin window. Add it from the strip at the top if you dosed for it.</div>`
      : '';
  }
  const total = linked.reduce((a, d) => a + Number(d.units), 0);
  const when = new Date(linked[0].ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `<div class="notice notice--info">${r1(total)} units logged for this meal at ${esc(when)}${
    Number(linked[0].bg) > 0 ? `, glucose ${esc(gLabel(linked[0].bg))}` : ''
  }. Edit it from the strip at the top of the screen.</div>`;
}

function saveMeal() {
  if (!editing) return;
  const name = $('editName').value.trim();
  const kcal = parseInt($('editKcal').value, 10);
  if (!name) return toast('Give the meal a name.', 'risk');
  if (!Number.isFinite(kcal) || kcal < 0) return toast('Enter a valid calorie number.', 'risk');

  const patch = { name, kcal, slot: pickedSlot($('editSlot')) };
  const carbBox = $('editCarb');
  if (carbBox) patch.carb = Math.max(0, parseInt(carbBox.value, 10) || 0);

  store.updateMeal(viewKey, editing, patch);
  editing = null;
  closeSheet(el.mealScrim);
  render();
}

function deleteMeal() {
  if (!editing) return;
  store.removeMeal(viewKey, editing);
  editing = null;
  closeSheet(el.mealScrim);
  render();
  toast('Meal deleted.');
}

/* ------------------------------------------------------------ dose sheet */

/* Everything that is not a mealtime dose: a correction, the long-acting shot,
   a reading typed on its own, and any of the above needing a correction after
   the fact. `id` opens an existing row for editing; `seed` prefills a new one.

   Held in a plain object rather than read back off the DOM on save, so the
   suggestion under the boxes can be recomputed on every keystroke without the
   two ever disagreeing about what is in them. */
let doseForm = null;

function openDose(id = null, seed = {}) {
  const p = profile();
  if (!D.dosesInsulin(p)) return;

  const existing = id ? store.findDose(viewKey, id) : null;
  doseEdit = existing ? { key: viewKey, id } : null;

  doseForm = existing
    ? {
        kind: existing.kind || 'bolus',
        units: Number(existing.units) || 0,
        bg: Number(existing.bg) > 0 ? Number(existing.bg) : null,
        trend: existing.trend || null,
        carbGrams: Number(existing.carbGrams) || 0,
        ts: existing.ts,
        note: existing.note || '',
        mealId: existing.mealId || null,
        mealName: existing.mealName || null,
      }
    : {
        kind: 'bolus',
        units: 0,
        bg: null,
        trend: null,
        carbGrams: Number(seed.carbGrams) || 0,
        ts: Date.now(),
        note: '',
        mealId: seed.mealId || null,
        mealName: seed.mealName || null,
        slot: seed.slot || null,
      };

  el.doseTitle.textContent = existing ? 'Edit this entry' : doseForm.mealName ? `Dose for ${doseForm.mealName}` : 'Log insulin';
  el.doseDelete.hidden = !existing;
  renderDoseSheet();
  openSheet(el.doseScrim);
}

const DOSE_KINDS = [
  { id: 'bolus', label: 'Bolus', detail: 'Mealtime or correction — counts as active insulin' },
  { id: 'basal', label: 'Long-acting', detail: 'Background rate — deliberately not counted as active' },
  { id: 'reading', label: 'Reading only', detail: 'A glucose value with no insulin taken' },
];

function renderDoseSheet() {
  const p = profile();
  const f = doseForm;
  const timeValue = new Date(f.ts - new Date(f.ts).getTimezoneOffset() * 60000)
    .toISOString()
    .slice(11, 16);

  el.doseBody.innerHTML = `
    <div class="field" style="margin-top:0.5rem;">
      <span class="field__label">What is this?</span>
      <div class="chips" id="doseKind" role="group">
        ${DOSE_KINDS.map((k) => `
          <button type="button" class="chip${k.id === f.kind ? ' is-on' : ''}" data-kind="${k.id}"
                  aria-pressed="${k.id === f.kind}" title="${esc(k.detail)}">${esc(k.label)}</button>`).join('')}
      </div>
      <p class="field__hint" id="doseKindHint">${esc(DOSE_KINDS.find((k) => k.id === f.kind)?.detail || '')}</p>
    </div>

    <div class="field" id="doseUnitsField" ${f.kind === 'reading' ? 'hidden' : ''}>
      <label class="field__label" for="doseSheetUnits">Units</label>
      <div class="measure">
        <input class="input input--num" id="doseSheetUnits" type="number" inputmode="decimal" min="0" max="${D.LIMITS.units.max}" step="${p.doseIncrement || 0.5}" value="${f.units || ''}" placeholder="0">
        <span class="measure__unit">u</span>
      </div>
    </div>

    <div class="field">
      <label class="field__label" for="doseSheetBg">Glucose <span class="field__opt">optional</span></label>
      <div class="measure">
        <input class="input input--num" id="doseSheetBg" type="number" inputmode="decimal" step="${gStep()}" value="${f.bg == null ? '' : D.glucoseOut(f.bg, p.glucoseUnits)}" placeholder="—">
        <span class="measure__unit measure__unit--wide">${esc(gUnitName())}</span>
      </div>
    </div>

    ${p.useTrendArrows ? `
      <div class="field">
        <span class="field__label">Trend arrow</span>
        ${arrowPicker('doseSheetArrows', f.trend)}
      </div>` : ''}

    ${D.countsCarbs(p) ? `
      <div class="field" id="doseCarbField" ${f.kind !== 'bolus' ? 'hidden' : ''}>
        <label class="field__label" for="doseSheetCarb">Carbohydrate <span class="field__opt">optional</span></label>
        <div class="measure">
          <input class="input input--num" id="doseSheetCarb" type="number" inputmode="numeric" min="0" max="${D.LIMITS.carbGrams.max}" step="1" value="${f.carbGrams || ''}" placeholder="0">
          <span class="measure__unit">g</span>
        </div>
        <p class="field__hint">Anything you are eating with this. Leave it empty for a plain correction.</p>
      </div>` : ''}

    <div class="field">
      <label class="field__label" for="doseTime">Time</label>
      <input class="input" id="doseTime" type="time" value="${timeValue}">
      <p class="field__hint">When it actually went in. The active-insulin window is measured from here, so a dose backdated by an hour is counted as an hour older.</p>
    </div>

    <div class="field">
      <label class="field__label" for="doseNote">Note <span class="field__opt">optional</span></label>
      <input class="input" id="doseNote" type="text" value="${esc(f.note)}" placeholder="Site change · exercise coming up">
    </div>

    <div id="doseSheetResult"></div>`;

  for (const chip of el.doseBody.querySelectorAll('[data-kind]')) {
    chip.onclick = () => {
      f.kind = chip.dataset.kind;
      for (const c of el.doseBody.querySelectorAll('[data-kind]')) {
        const on = c === chip;
        c.classList.toggle('is-on', on);
        c.setAttribute('aria-pressed', String(on));
      }
      $('doseKindHint').textContent = DOSE_KINDS.find((k) => k.id === f.kind)?.detail || '';
      $('doseUnitsField').hidden = f.kind === 'reading';
      if ($('doseCarbField')) $('doseCarbField').hidden = f.kind !== 'bolus';
      paintDoseSheetResult();
    };
  }

  $('doseSheetUnits').oninput = () => {
    f.units = Math.max(0, Number($('doseSheetUnits').value) || 0);
  };
  $('doseSheetBg').oninput = () => {
    const raw = $('doseSheetBg').value.trim();
    f.bg = raw === '' ? null : D.glucoseIn(raw, p.glucoseUnits);
    paintDoseSheetResult();
  };
  if ($('doseSheetCarb')) {
    $('doseSheetCarb').oninput = () => {
      f.carbGrams = Math.max(0, Number($('doseSheetCarb').value) || 0);
      paintDoseSheetResult();
    };
  }
  $('doseTime').onchange = () => {
    const [h, m] = $('doseTime').value.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    const d = new Date(f.ts);
    d.setHours(h, m, 0, 0);
    f.ts = d.getTime();
    paintDoseSheetResult();
  };
  $('doseNote').oninput = () => { f.note = $('doseNote').value; };
  wireArrows('doseSheetArrows', (t) => { f.trend = t; paintDoseSheetResult(); });

  paintDoseSheetResult();
}

/* The suggestion beside a correction. Existing entries are not re-suggested:
   a row being edited is a record of what happened, and recomputing it against
   this afternoon's active insulin would be answering a different question. */
function paintDoseSheetResult() {
  const host = $('doseSheetResult');
  if (!host) return;
  const f = doseForm;
  if (doseEdit || f.kind !== 'bolus' || (f.bg == null && !f.carbGrams)) {
    host.innerHTML = '';
    return;
  }

  const w = windowAt(f.ts);
  const dose = D.bolus({
    carbGrams: f.carbGrams,
    bg: f.bg,
    trend: f.trend,
    slot: f.slot || store.slotForTime(new Date(f.ts)),
    iob: w.iob.units,
    profile: profile(),
  });

  host.innerHTML = `
    <div class="section-head" style="padding-top:1.25rem;"><h3 class="eyebrow">Your scale says</h3></div>
    <div class="dose">${doseVerdict(dose, w)}</div>
    ${dose.usable && dose.units > 0 ? `
      <button class="btn btn--ghost dose__accept" id="doseAccept" type="button">Use ${dose.units} units</button>` : ''}`;

  const accept = $('doseAccept');
  if (accept) {
    accept.onclick = () => {
      f.units = dose.units;
      $('doseSheetUnits').value = dose.units;
    };
  }
}

function saveDose() {
  const f = doseForm;
  if (!f) return;
  const units = f.kind === 'reading' ? 0 : Number(f.units) || 0;
  const hasReading = Number(f.bg) > 0;

  if (units <= 0 && !hasReading) {
    return toast('Enter the units, a glucose reading, or both.', 'risk');
  }
  if (units > D.LIMITS.units.max) {
    return toast(`${units} units is outside what this will record. Check the number.`, 'risk');
  }
  if (hasReading && (f.bg < D.LIMITS.bg.min || f.bg > D.LIMITS.bg.max)) {
    return toast('That glucose reading is outside the range a meter can report. Check the units.', 'risk');
  }

  const row = {
    kind: units > 0 ? f.kind : 'reading',
    units,
    bg: hasReading ? f.bg : null,
    trend: f.trend || null,
    carbGrams: f.carbGrams || null,
    ts: f.ts,
    note: f.note || '',
    mealId: f.mealId || null,
    mealName: f.mealName || null,
  };

  /* A backdated entry can land on a different day from the one on screen.
     Writing it under the day it happened is what keeps "insulin today" honest
     and what lets the window find it; the record moves keys rather than
     staying put with a lying timestamp. */
  const targetKey = store.dateKey(new Date(f.ts));

  if (doseEdit) {
    if (targetKey === doseEdit.key) {
      store.updateDose(doseEdit.key, doseEdit.id, row);
    } else {
      store.removeDose(doseEdit.key, doseEdit.id);
      store.addDose(targetKey, row);
    }
  } else {
    store.addDose(targetKey, row);
  }

  doseEdit = null;
  doseForm = null;
  closeSheet(el.doseScrim);
  render();
}

function deleteDose() {
  if (!doseEdit) return;
  store.removeDose(doseEdit.key, doseEdit.id);
  doseEdit = null;
  doseForm = null;
  closeSheet(el.doseScrim);
  render();
  toast('Entry deleted.');
}

/* ------------------------------------------------------------------ wire */

el.prevDay.onclick = () => { viewKey = store.shiftKey(viewKey, -1); render(); };
el.nextDay.onclick = () => {
  if (viewKey >= store.dateKey()) return;
  viewKey = store.shiftKey(viewKey, 1);
  render();
};

el.snapBtn.onclick = () => {
  viewKey = store.dateKey();
  resetAdd();
  openSheet(el.addScrim);
  takePhoto(receivePhoto);
};

el.manualBtn.onclick = () => {
  viewKey = store.dateKey();
  resetAdd();
  setMode('manual');
  openSheet(el.addScrim);
};

el.tabPhoto.onclick = () => setMode('photo');
el.tabManual.onclick = () => setMode('manual');
el.takeBtn.onclick = () => takePhoto(receivePhoto);
el.chooseBtn.onclick = () => choosePhoto(receivePhoto);
el.captureClear.onclick = () => {
  shot = null;
  el.capture.classList.remove('has-image');
  el.captureImg.removeAttribute('src');
};
el.addSubmit.onclick = submitAdd;
el.confirmSave.onclick = saveDraft;
el.mealSave.onclick = saveMeal;
el.mealDelete.onclick = deleteMeal;
el.doseBtn.onclick = () => {
  viewKey = store.dateKey();
  openDose(null);
};
el.doseSave.onclick = saveDose;
el.doseDelete.onclick = deleteDose;

for (const btn of document.querySelectorAll('[data-close]')) {
  btn.onclick = () => closeSheet($(btn.dataset.close));
}
for (const scrim of [el.addScrim, el.confirmScrim, el.mealScrim, el.doseScrim]) {
  scrim.onclick = (e) => { if (e.target === scrim) closeSheet(scrim); };
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const scrim of [el.doseScrim, el.mealScrim, el.confirmScrim, el.addScrim]) {
    if (scrim.classList.contains('is-open')) return closeSheet(scrim);
  }
});

/* Re-render on wake: a PWA left open overnight would otherwise still be
   showing yesterday's total as "Today". */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (viewKey !== store.dateKey() && !document.querySelector('.scrim.is-open')) {
    viewKey = store.dateKey();
  }
  render();
});

/* Signing out clears the session, never the log. The meals stay under this
   identity's namespace so the next sign-in reopens them where they were. */
el.signOut.onclick = () => {
  signOut();
  location.replace(LANDING_URL);
};

/* ------------------------------------------------------------- profile */

function saveProfile(patch) {
  store.setProfile(patch);
  render();
  /* The strip's timer only exists while there is a strip. Restarted on every
     save because this is the one place the answer can change. */
  watchWindow();
  toast(
    D.dosesInsulin(patch)
      ? `Saved. ${patch.goalKcal.toLocaleString()} kcal a day, and doses worked out from your ratios.`
      : `Daily target set to ${patch.goalKcal.toLocaleString()} kcal.`
  );
}

el.profileBtn.onclick = () => openOnboarding({
  profile: store.getProfile(),
  mode: 'edit',
  onSave: saveProfile,
});

/* Shown once, on the first load after sign-in, and never again unless the
   topbar asks for it. `setupSkipped` is what makes "not now" stick: without
   it the same five screens would ambush someone on every cold start of the
   PWA, which is a worse outcome than a log with no target on it. */
function offerSetup() {
  const profile = store.getProfile();
  if (profile.goalKcal || profile.setupSkipped) return;

  /* A beat, so the app is perceptibly there before the layer slides up over
     it. Straight off the first paint it reads as a page that loaded wrong. */
  setTimeout(() => openOnboarding({
    profile,
    mode: 'setup',
    onSave: saveProfile,
    onSkip: () => store.setProfile({ setupSkipped: true }),
  }), 260);
}

/* The gate decides who this is; storage decides where their log lives. With no
   session requireSession() has already started a redirect, so skip the render
   rather than paint a log that is about to be thrown away. */
const session = requireSession();
if (session) {
  store.init(namespaceFor(session));
  render();
  watchWindow();
  offerSetup();
}
