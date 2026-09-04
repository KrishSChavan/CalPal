const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');

require('dotenv').config();

const foodDb = require('./server/food-db');
const vision = require('./server/vision');
const session = require('./server/session');
const { limiters } = require('./server/rate-limit');
const { jose } = require('./server/jose');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* Per-address backstop over every /api route, so one added later is never
   wide open just because nobody remembered. Deliberately loose — the tight
   per-route ceilings below are what actually bind. Static files and the SPA
   shell are exempt: on Vercel the CDN answers those without ever reaching
   this process, and throttling them would only break the app for a user on a
   slow connection reloading assets. */
app.use('/api', (req, res, next) => apiLimit(req, res, next));
app.use(express.static(path.join(__dirname, 'public')));

/* Memory storage, not disk. The client re-encodes every photo to a ~100-250KB
   JPEG before upload, so there is nothing worth spooling — and nothing to
   clean up, which is where the old `fs.unlinkSync` in a finally block could
   throw over a file that was never written. */
/* One request per photo instead of two when disabled. See the RECONCILE note
   on the second vision call below. Read per-request rather than at boot so it
   is testable and so a config change needs no code path of its own. */
const reconcileEnabled = () => process.env.RECONCILE !== '0';

const upload = multer({
  storage: multer.memoryStorage(),
  /* 4 MB, not 8: Vercel rejects a request body over 4.5 MB at the edge with
     its own 413 page before multer sees the stream, which would make the
     too_large branch below dead code in production and hand the client an
     HTML body it cannot parse. The client uploads a ~100-250KB canvas
     re-encode, so this ceiling is still pure slack. */
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
});

/* --------------------------------------------------------------- helpers */

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, error: { code, message } });
}

/* Analysis costs the operator two Gemini requests per photo, so it is the one
   route that has to know who is asking. Set ANALYZE_REQUIRES_SIGNIN=0 to go
   back to an open endpoint — that is not a lighter form of protection, it is
   none, and it should only ever be a local convenience. */
const signinRequired = () => process.env.ANALYZE_REQUIRES_SIGNIN !== '0';

/* Gate first, parse second: an unauthorized caller should never get as far as
   having 4 MB of multipart read on its behalf. */
async function requireSession(req, res, next) {
  if (!signinRequired()) return next();

  try {
    req.session = await session.verify(session.bearer(req));
  } catch (err) {
    if (err instanceof session.SessionError) {
      /* A missing or malformed server secret is our fault and unfixable by the
         caller — say 503 so nobody is told to sign in again pointlessly. */
      const ours = err.code === 'no_secret' || err.code === 'bad_secret';
      if (ours) console.error('[auth]', err.message);
      return fail(res, ours ? 503 : 401, ours ? 'not_configured' : err.code, err.message);
    }
    return next(err);
  }
  return next();
}

/* Bound here rather than in rate-limit.js so that module never has to know
   this app's error envelope; fail() is the only thing it is missing. */
const apiLimit = limiters.api.middleware(fail);
const authLimit = limiters.auth.middleware(fail);
const configLimit = limiters.config.middleware(fail);
const healthLimit = limiters.health.middleware(fail);
const analyzeLimit = limiters.analyze.middleware(fail);

/* Per-identity ceiling, so one signed-in account cannot drain the day's quota
   for everyone else. With the gate off there is no identity to count against,
   and the per-address /api backstop is the only thing left holding the line. */
function rateLimitAnalyze(req, res, next) {
  if (!signinRequired()) return next();
  return analyzeLimit(req, res, next);
}

/* checkModelAvailable() is a live call to Google, so an uncached /api/health
   is a quota amplifier: anything that polls it — a crawler, an uptime monitor,
   a stuck client — spends the operator's API budget at whatever rate it likes.
   Cache the answer briefly. Health is a "is this deployment wired up" check,
   not a per-second liveness probe, so a slightly stale reading is the right
   trade. In-flight calls share one promise, so a burst cannot start several. */
const HEALTH_TTL_MS = Number(process.env.HEALTH_CACHE_MS || 30000);
let modelCache = { at: 0, promise: null };

function checkModelCached() {
  const now = Date.now();
  if (modelCache.promise && now - modelCache.at < HEALTH_TTL_MS) return modelCache.promise;

  const promise = vision.checkModelAvailable()
    .then((r) => {
      /* The detail goes to the log, not the response — see the health route.
         Bounded by the cache, so this cannot be made to spam by polling. */
      if (!r.available) console.warn('[health] vision unavailable:', r.message || r.error || 'unknown');
      return r;
    })
    .catch((e) => {
      console.warn('[health] vision check failed:', e.message);
      return { ok: false, available: false, error: e.message };
    });
  modelCache = { at: now, promise };
  return promise;
}

const MAX_CANDIDATES = 4;

/* Probe the index once per search term the model offered, then keep the best
   scoring rows. Research verified that hit #1 from any single query is not
   trustworthy — "butter chicken" ranks "Chicken, back" and "Fruit butter"
   above the correct row — so a multi-probe plus re-rank is the minimum.
   Adversarial testing put the residual wrong rate at ~5.7% on unseen queries,
   so a shortlist goes to the model rather than one row taken on faith.

   When nothing clears the score floor the probe is repeated unfiltered. A
   rejected match is not the same as no information: shown "Beef, NFS" for
   "beef lasagna" the model can decline it, which is a better outcome than
   lowering the floor — that is what turns "avocado toast" into French toast. */
function matchComponent(component) {
  const terms = [];
  if (Array.isArray(component.search_terms)) terms.push(...component.search_terms);
  if (component.name) terms.push(component.name);

  const probe = (opts) => {
    const pool = new Map();
    const seen = new Set();
    for (const raw of terms) {
      const term = String(raw || '').trim();
      if (!term || seen.has(term.toLowerCase())) continue;
      seen.add(term.toLowerCase());
      for (const hit of foodDb.search(term, opts)) {
        const prev = pool.get(hit.code);
        if (!prev || hit.score > prev.score) pool.set(hit.code, hit);
      }
    }
    return [...pool.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
  };

  const confident = probe({ limit: 3 });
  if (confident.length) return { best: confident[0], candidates: confident, confident: true };

  return { best: null, candidates: probe({ limit: 3, minScore: 0 }), confident: false };
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

app.post('/api/analyze', requireSession, rateLimitAnalyze, upload.single('image'), async (req, res) => {
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
    const matched = components.map((c) => ({ component: c, ...matchComponent(c) }));

    const asRow = (r) => ({
      fdc_id: r.code,
      description: r.description,
      category: r.category,
      kcal_per_100g: r.kcal100,
      protein_per_100g: r.protein100,
      carb_per_100g: r.carb100,
      fat_per_100g: r.fat100,
      portions: r.portions,
    });

    /* The model gets the shortlist, not a verdict. It picks one by fdc_id in
       chosen_fdc_id, or picks none — the safeguard that catches a confident
       wrong match like "Banana, raw" for banana bread. */
    const dbRows = matched.map(({ component, best, candidates, confident }, i) => ({
      index: i,
      component: component.name,
      grams_estimated: component.grams_likely,
      match: best ? asRow(best) : null,
      candidates: candidates.map(asRow),
      candidates_below_threshold: !confident,
    }));

    /* Call 2 — reconcile the estimate against the retrieved rows, with the
       image still in the request. Feeding only the list is measurably worse
       (53.3 vs 66.5 kcal MAE), so the photo goes back in.

       Set RECONCILE=0 to skip it. That halves requests per photo, which is the
       difference that matters on a shared free-tier quota. The published gain
       from two-step is ~12%, but it was measured on a paid model that has since
       been retired and it REVERSED on a Qwen model — so it is worth measuring
       on your own photos rather than assuming. */
    const call2 = reconcileEnabled()
      ? await vision.reconcile({ imageDataUrl, call1, dbRows })
      : null;

    const finals = call2 && Array.isArray(call2.components) ? call2.components : [];

    const out = matched.map(({ component, best, confident }, i) => {
      const final = finals[i] || {};
      const grams = Number(final.grams_final) || Number(component.grams_likely) || 0;

      /* Resolve which FNDDS row actually prices this component:
           - the model named one          -> its choice wins over the matcher's
           - the model named none, and the matcher was confident -> matcher's row
           - neither                      -> unmatched; the model's own kcal, or zero
         Letting the model override is the load-bearing safeguard. Without it a
         5.7% wrong-match rate goes straight into the total unchallenged. */
      const picked = final.chosen_fdc_id ? foodDb.lookup(String(final.chosen_fdc_id)) : null;
      const row = picked || (confident ? best : null);
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

    /* With one call there is no second opinion to disagree with, so the
       detector reports itself inactive rather than quietly passing. */
    let disagreement = { dbKcal: Math.round(dbKcal), modelKcal: null, flagged: false, checked: false };
    if (call2) {
      const modelKcal = Number(call2.kcal_likely) || 0;
      const mean = (dbKcal + modelKcal) / 2;
      disagreement = {
        dbKcal: Math.round(dbKcal),
        modelKcal: Math.round(modelKcal),
        flagged: mean > 0 && Math.abs(dbKcal - modelKcal) / mean > 0.35,
        checked: true,
      };
    }

    /* Call 1 scores every component, and averaging those is the only
       confidence signal left when the reconciliation pass is switched off. */
    const call1Confidence = components.length
      ? components.reduce((a, c) => a + (Number(c.confidence) || 0), 0) / components.length
      : null;

    res.json({
      ok: true,
      dishName: call1.dish_name || 'Meal',
      cuisine: call1.cuisine || null,
      cookingMethod: call1.cooking_method || null,
      slot: slot || call2?.meal_slot || null,
      components: out,
      confidence: (call2 ? Number(call2.overall_confidence) : call1Confidence) || null,
      clarifyingQuestion: call2?.clarifying_question || null,
      reconciliation: call2?.reconciliation_notes || null,
      /* The model's own total is never shown as the answer — it exists only
         to catch a component list that went wrong. */
      disagreement,
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

app.get('/api/health', healthLimit, async (req, res) => {
  const db = foodDb.stats();
  const model = await checkModelCached();
  res.json({
    ok: true,
    foodDb: db,
    /* One boolean: can photo analysis run right now, or not.

       This endpoint is public and unauthenticated, and checkModelAvailable()
       returns every model id enabled on the API key, the configured model
       name, and a suggested replacement — an inventory of the operator's
       Google account that no client of this app has any use for. Why a
       failure happened goes to the server log, where the operator can read it
       and a stranger cannot. */
    vision: { ok: vision.isConfigured() && !!model?.available },
    /* No token needed to read this: a deployment whose AUTH_SECRET is missing
       cannot issue sign-ins at all, so requiring one to find that out would be
       a locked door with the key inside. Reports whether a secret resolves and
       where it came from — never the secret. */
    auth: { signinRequired: signinRequired(), secret: session.secretStatus() },
  });
});


const PROVIDERS = {
  google: {
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: () => process.env.GOOGLE_CLIENT_ID,
  },
  apple: {
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    issuer: 'https://appleid.apple.com',
    audience: () => process.env.APPLE_SERVICE_ID,
  },
};

/* Built on first use, not at import: createRemoteJWKSet itself is cheap and
   makes no network call, but reaching it required a synchronous require() of
   an ESM-only package, which is what took the whole deployment down.

   Memoized per URL because the returned function owns the key cache — a fresh
   one per request would refetch Google's JWKS every time. */
const jwksCache = new Map();
async function jwksFor(provider) {
  if (!jwksCache.has(provider.jwksUrl)) {
    const { createRemoteJWKSet } = await jose();
    jwksCache.set(provider.jwksUrl, createRemoteJWKSet(new URL(provider.jwksUrl)));
  }
  return jwksCache.get(provider.jwksUrl);
}

app.get('/api/auth/config', configLimit, (req, res) => {
  res.json({
    google: process.env.GOOGLE_CLIENT_ID || null,
    apple: process.env.APPLE_SERVICE_ID || null,
  });
});

/* Verify only. Nothing is stored: the sub goes back to the browser, which uses
   it to name the localStorage bucket the log already lives in. */
app.post('/api/auth/:provider', authLimit, async (req, res) => {
  const p = PROVIDERS[req.params.provider];
  if (!p) return fail(res, 404, 'unknown_provider', 'No such sign-in provider.');

  const audience = p.audience();
  if (!audience) return fail(res, 503, 'not_configured', 'That sign-in is not configured on this server.');

  const token = String(req.body?.token || '');
  if (!token) return fail(res, 400, 'no_token', 'No identity token was sent.');

  try {
    const { jwtVerify } = await jose();
    const { payload } = await jwtVerify(token, await jwksFor(p), {
      issuer: p.issuer, audience, clockTolerance: 60,
    });

    /* The provider has now vouched for this person, so mint our own token.
       This is the only place one is ever issued — which is what makes holding
       one mean "Google or Apple said so", rather than "asked nicely". */
    const sessionToken = await session.issue({ sub: payload.sub, kind: req.params.provider });

    res.json({
      ok: true,
      sub: payload.sub,
      email: payload.email || '',
      name: payload.name || '',
      nonce: payload.nonce || null,
      sessionToken,
    });
  } catch (err) {
    if (err instanceof session.SessionError) {
      console.error('[auth] cannot issue a session:', err.message);
      return fail(res, 503, 'not_configured', err.message);
    }
    /* A JWKS fetch that failed — DNS, blocked egress, jose's timeout on a
       cold instance — and a genuinely bad token both land here, and both
       used to return the same 401 with nothing written down. Log before
       answering, or the runtime log has nothing to say about a valid Google
       token being refused. */
    console.error('[auth]', req.params.provider, err);
    return fail(res, 401, 'rejected', 'That sign-in token did not check out.');
  }
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

/* Warm the index at import so the first request does not pay for it — but a
   throw here is unrecoverable on a serverless host: the exception escapes
   module init, the platform never gets the exported app back, and EVERY
   request fails (Vercel calls it FUNCTION_INVOCATION_FAILED) instead of just
   the routes that needed the file. Every public food-db export calls
   ensureLoaded() itself, so a failed warm-up only costs a retry on
   /api/analyze and /api/health while the SPA and /api/auth/* keep working. */
try {
  foodDb.load();
  const db = foodDb.stats();
  console.log(`FNDDS index: ${db.foodCount} foods (${db.loadMs} ms)`);
} catch (err) {
  console.error('[boot] FNDDS index failed to load; food lookups will fail:', err);
}

if (!vision.isConfigured()) {
  console.warn('GEMINI_API_KEY is not set — photo analysis will return a 503 until it is.');
}

/* Only listen when run directly, so the integration test can mount the app on
   an ephemeral port without racing a second listener. A serverless host
   imports this file instead of running it, so nothing inside this block runs
   there — anything the deploy needs in its log belongs above. */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    if (vision.isConfigured()) {
      vision.checkModelAvailable()
        .then((r) => {
          if (r.available) console.log(`Vision model: ${r.model}`);
          else console.warn(`Vision model "${r.model}" is not available on this key. ${r.suggestion ? `Try VISION_MODEL=${r.suggestion}` : r.message || ''}`);
        })
        .catch((e) => console.warn('Could not verify the vision model:', e.message));
    }
  });
}

module.exports = app;
