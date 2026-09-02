const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');

require('dotenv').config();

const foodDb = require('./server/food-db');
const vision = require('./server/vision');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* Memory storage, not disk. The client re-encodes every photo to a ~100-250KB
   JPEG before upload, so there is nothing worth spooling — and nothing to
   clean up, which is where the old `fs.unlinkSync` in a finally block could
   throw over a file that was never written. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

/* --------------------------------------------------------------- helpers */

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, error: { code, message } });
}

/* Probe the index once per search term the model offered, then keep the best
   scoring row. Research verified that hit #1 from any single query is not
   trustworthy — "butter chicken" ranks "Chicken, back" and "Fruit butter"
   above the correct row — so a multi-probe plus re-rank is the minimum. */
function matchComponent(component) {
  const terms = [];
  if (Array.isArray(component.search_terms)) terms.push(...component.search_terms);
  if (component.name) terms.push(component.name);

  let best = null;
  const seen = new Set();
  for (const raw of terms) {
    const term = String(raw || '').trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    const [hit] = foodDb.search(term, { limit: 1 });
    if (hit && (!best || hit.score > best.score)) best = hit;
  }
  return best;
}

/* FNDDS gives portionDescription -> gramWeight. Restating the grams as "about
   1 cup" is the difference between a number the user can check and one they
   can only accept: nobody can eyeball 240 g, everybody can eyeball a cup. */
function pickPortionHint(row, grams) {
  if (!row || !Array.isArray(row.portions) || !row.portions.length) return null;
  if (!Number.isFinite(grams) || grams <= 0) return null;

  let closest = null;
  for (const p of row.portions) {
    const weight = Number(p?.grams);
    const desc = p?.description;
    // "Quantity not specified" is a real FNDDS row but tells the user nothing.
    if (!desc || !Number.isFinite(weight) || weight <= 0) continue;
    if (/quantity not specified/i.test(desc)) continue;
    const ratio = grams / weight;
    const dist = Math.abs(Math.log(ratio));
    if (!closest || dist < closest.dist) closest = { desc, ratio, dist };
  }
  if (!closest) return null;

  const n = closest.ratio;
  if (n < 0.15 || n > 12) return null; // too far off to read as a helpful multiple
  const amount = n >= 0.9 && n <= 1.1 ? '1' : Number(n.toFixed(1)).toString();
  return `≈ ${amount} × ${closest.desc}`;
}

/* --------------------------------------------------------------- analyze */

app.post('/api/analyze', upload.single('image'), async (req, res) => {
  if (!req.file || !req.file.buffer?.length) {
    return fail(res, 400, 'no_image', 'No photo reached the server.');
  }
  if (!vision.isConfigured()) {
    return fail(res, 503, 'no_key', 'The server has no GEMINI_API_KEY set. Add one to .env and restart.');
  }

  /* The client normalizes every capture through a canvas, so the bytes are
     always JPEG regardless of what the phone called the file. Never derive
     the MIME type from originalname — that is what produced `image/heic` and
     a confusing model-side error on every iPhone upload. */
  const imageDataUrl = `data:image/jpeg;base64,${req.file.buffer.toString('base64')}`;

  const notes = (req.body.notes || '').toString().slice(0, 500);
  const slot = ['breakfast', 'lunch', 'dinner', 'snack'].includes(req.body.slot) ? req.body.slot : null;
  const localTimeLabel = (req.body.localTimeLabel || '').toString().slice(0, 40);
  const plateDiameterCm = Number(req.body.plateDiameterCm) || null;

  try {
    /* Call 1 — what is on the plate, and how much of it. */
    const call1 = await vision.analyzeMeal({
      imageDataUrl,
      notes,
      localTimeLabel: slot ? `${localTimeLabel} - ${slot}` : localTimeLabel,
      plateDiameterCm,
    });

    const components = Array.isArray(call1.components) ? call1.components : [];
    if (!components.length) {
      return fail(res, 422, 'no_food', "Couldn't identify any food in that photo. Try a clearer shot of the plate.");
    }

    /* Local step — cross-reference against the bundled FNDDS snapshot. */
    const matched = components.map((c) => ({ component: c, row: matchComponent(c) }));

    const dbRows = matched.map(({ component, row }, i) => ({
      index: i,
      component: component.name,
      grams_estimated: component.grams_likely,
      match: row
        ? {
            fdc_id: row.code,
            description: row.description,
            category: row.category,
            kcal_per_100g: row.kcal100,
            protein_per_100g: row.protein100,
            carb_per_100g: row.carb100,
            fat_per_100g: row.fat100,
            portions: row.portions,
          }
        : null,
    }));

    /* Call 2 — reconcile the estimate against the retrieved rows, with the
       image still in the request. Feeding only the list is measurably worse
       (53.3 vs 66.5 kcal MAE), so the photo goes back in. */
    const call2 = await vision.reconcile({ imageDataUrl, call1, dbRows });

    const finals = Array.isArray(call2.components) ? call2.components : [];

    const out = matched.map(({ component, row }, i) => {
      const final = finals[i] || {};
      const grams = Number(final.grams_final) || Number(component.grams_likely) || 0;
      const kcal100 = row && Number.isFinite(row.kcal100) ? row.kcal100 : null;

      return {
        name: final.name || component.name,
        grams: Math.round(grams),
        matched: !!row && kcal100 !== null,
        fdcId: row ? row.code : null,
        fdcDescription: row ? row.description : null,
        portionHint: row ? pickPortionHint(row, grams) : null,
        kcal100,
        protein100: row?.protein100 ?? null,
        carb100: row?.carb100 ?? null,
        fat100: row?.fat100 ?? null,
        /* Falls back to the model's own per-component number only where FNDDS
           had nothing. The UI marks these so the user knows which figures are
           unsourced. */
        kcal: kcal100 !== null ? (kcal100 * grams) / 100 : Number(final.kcal) || 0,
      };
    });

    const dbKcal = out.reduce((s, c) => s + (Number(c.kcal) || 0), 0);
    const modelKcal = Number(call2.kcal_likely) || 0;
    const mean = (dbKcal + modelKcal) / 2;
    const flagged = mean > 0 && Math.abs(dbKcal - modelKcal) / mean > 0.35;

    res.json({
      ok: true,
      dishName: call1.dish_name || 'Meal',
      cuisine: call1.cuisine || null,
      cookingMethod: call1.cooking_method || null,
      slot: slot || call2.meal_slot || null,
      components: out,
      confidence: Number(call2.overall_confidence) || null,
      clarifyingQuestion: call2.clarifying_question || null,
      reconciliation: call2.reconciliation_notes || null,
      /* The model's own total is never shown as the answer — it exists only
         to catch a component list that went wrong. */
      disagreement: { dbKcal: Math.round(dbKcal), modelKcal: Math.round(modelKcal), flagged },
    });
  } catch (err) {
    const code = err && err.code;
    const known = ['no_key', 'bad_key', 'rate_limited', 'model_missing', 'bad_response'];
    if (known.includes(code)) {
      const status = code === 'rate_limited' ? 429 : code === 'bad_key' ? 502 : 503;
      return fail(res, status, code, err.message);
    }
    console.error('[analyze]', err);
    return fail(res, 500, 'unknown', 'Analysis failed. Try again in a moment.');
  }
});

/* ---------------------------------------------------------------- health */

app.get('/api/health', async (req, res) => {
  const db = foodDb.stats();
  const model = await vision.checkModelAvailable().catch((e) => ({ ok: false, error: e.message }));
  res.json({
    ok: true,
    foodDb: db,
    vision: { configured: vision.isConfigured(), ...model },
  });
});

/* SPA fallback. Express 5 moved to path-to-regexp v8, which rejects a bare
   '*' route — a plain middleware avoids the wildcard syntax entirely. */
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* Multer surfaces its own errors (file too large, wrong field) as a thrown
   MulterError rather than a route rejection, so it needs an error handler. */
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'too_large' : 'no_image';
    return fail(res, 400, code, err.code === 'LIMIT_FILE_SIZE'
      ? 'That photo was too large. It should have been downscaled before upload.'
      : 'The upload was malformed.');
  }
  console.error('[server]', err);
  return fail(res, 500, 'unknown', 'Something went wrong.');
});

/* ------------------------------------------------------------------ boot */

foodDb.load();

/* Only listen when run directly, so the integration test can mount the app on
   an ephemeral port without racing a second listener. */
if (require.main === module) {
  app.listen(PORT, () => {
    const db = foodDb.stats();
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`FNDDS index: ${db.foodCount} foods (${db.loadMs} ms)`);
    if (!vision.isConfigured()) {
      console.warn('GEMINI_API_KEY is not set — photo analysis will return a 503 until it is.');
    } else {
      vision.checkModelAvailable()
        .then((r) => {
          if (r.available) console.log(`Vision model: ${r.configured}`);
          else console.warn(`Vision model "${r.configured}" was not in the provider's list. ${r.suggestion || ''}`);
        })
        .catch((e) => console.warn('Could not verify the vision model:', e.message));
    }
  });
}

module.exports = app;
