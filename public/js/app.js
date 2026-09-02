/* ==========================================================================
   app.js — screen logic.
   ========================================================================== */

import * as store from './storage.js';
import { takePhoto, choosePhoto, normalize, formatBytes } from './camera.js';
import { analyzeMeal, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);

const el = {
  dateLabel: $('dateLabel'), prevDay: $('prevDay'), nextDay: $('nextDay'),
  dayKcal: $('dayKcal'), dayMeta: $('dayMeta'),
  dayProtein: $('dayProtein'), dayCarb: $('dayCarb'), dayFat: $('dayFat'),
  meals: $('meals'), mealCount: $('mealCount'),
  snapBtn: $('snapBtn'), manualBtn: $('manualBtn'),

  addScrim: $('addScrim'), tabPhoto: $('tabPhoto'), tabManual: $('tabManual'),
  panePhoto: $('panePhoto'), paneManual: $('paneManual'),
  capture: $('capture'), captureImg: $('captureImg'), captureSize: $('captureSize'),
  captureClear: $('captureClear'), takeBtn: $('takeBtn'), chooseBtn: $('chooseBtn'),
  photoSlot: $('photoSlot'), photoNotes: $('photoNotes'),
  manualName: $('manualName'), manualKcal: $('manualKcal'), manualSlot: $('manualSlot'),
  addSubmit: $('addSubmit'),

  confirmScrim: $('confirmScrim'), confirmBody: $('confirmBody'), confirmSave: $('confirmSave'),
  mealScrim: $('mealScrim'), mealBody: $('mealBody'), mealTitle: $('mealTitle'),
  mealDelete: $('mealDelete'), mealSave: $('mealSave'),

  busy: $('busy'), busyLabel: $('busyLabel'), toast: $('toast'),
};

const SLOT_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };
const SLOT_GLYPH = { breakfast: '🍳', lunch: '🥗', dinner: '🍽️', snack: '🍎' };

let viewKey = store.dateKey();
let mode = 'photo';
let shot = null;      // normalized capture: {blob, dataUrl, thumb, bytes}
let draft = null;     // pending analysis being confirmed
let editing = null;   // meal id open in the meal sheet

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

/* ----------------------------------------------------------------- render */

function render() {
  const today = store.dateKey();
  el.dateLabel.textContent = store.labelForKey(viewKey);
  el.nextDay.disabled = viewKey >= today;

  const t = store.totalsOn(viewKey);
  el.dayKcal.textContent = t.kcal.toLocaleString();
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

    const res = store.addMeal(viewKey, {
      name, kcal, slot: pickedSlot(el.manualSlot),
      source: 'manual',
      thumb: shot?.thumb,   // a photo is optional here, but kept if one was taken
    });
    if (!res.persisted) toast("Saved, but storage is full — clear some old days.", 'risk');
    closeSheet(el.addScrim);
    render();
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
  `;

  buildSlotChips($('draftSlot'), draft.slot, (s) => { draft.slot = s; });
  renderComponents();
}

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

  draft = null;
  closeSheet(el.confirmScrim);
  render();
  if (!res.persisted) toast('Saved, but storage is full — older photos were dropped.', 'risk');
  else if (res.thumbEvicted) toast('Saved. Storage was tight so the photo was not kept.');
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
    <div class="field">
      <label class="field__label">Meal</label>
      <div class="chips" id="editSlot"></div>
    </div>
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

function saveMeal() {
  if (!editing) return;
  const name = $('editName').value.trim();
  const kcal = parseInt($('editKcal').value, 10);
  if (!name) return toast('Give the meal a name.', 'risk');
  if (!Number.isFinite(kcal) || kcal < 0) return toast('Enter a valid calorie number.', 'risk');

  store.updateMeal(viewKey, editing, { name, kcal, slot: pickedSlot($('editSlot')) });
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

for (const btn of document.querySelectorAll('[data-close]')) {
  btn.onclick = () => closeSheet($(btn.dataset.close));
}
for (const scrim of [el.addScrim, el.confirmScrim, el.mealScrim]) {
  scrim.onclick = (e) => { if (e.target === scrim) closeSheet(scrim); };
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const scrim of [el.mealScrim, el.confirmScrim, el.addScrim]) {
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

store.init();
render();
