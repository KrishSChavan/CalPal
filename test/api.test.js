/* End-to-end test of POST /api/analyze — vision → FNDDS match → reconcile →
   the exact JSON shape public/js/app.js consumes.

   No Gemini key needed: the model client is injected. Run with npm run test:api
*/

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY = 'AIza-test-key';
/* Long enough to satisfy session.js's 32-char floor. Set before index.js is
   required so the secret resolves from the environment, not the dev fallback. */
process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-to-pass-32';

const vision = require('../server/vision');
const session = require('../server/session');
const rateLimit = require('../server/rate-limit');
const app = require('../index.js');

/* ------------------------------------------------------------------ setup */

/* A 1x1 JPEG. The route only base64s the bytes, so content doesn't matter —
   but it must be a real upload so multer's parsing is genuinely exercised. */
const JPEG_1PX = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

const CALL1 = {
  scale_references: [{ object: 'dinner plate', assumed_size_cm: 27, confidence: 0.7 }],
  plate_diameter_cm_estimate: 27,
  dish_name: 'Chicken curry with rice',
  cuisine: 'Indian',
  cooking_method: 'sauteed',
  components: [
    {
      name: 'butter chicken',
      search_terms: ['butter chicken', 'chicken curry'],
      state: 'cooked',
      visible_geometry: 'about one cup, judged against the 27 cm plate',
      household_measure: { amount: 1, unit: 'cup' },
      grams_low: 180, grams_likely: 240, grams_high: 300,
      edible_fraction: 1.0, confidence: 0.7,
    },
    {
      name: 'white rice',
      search_terms: ['white rice, boiled', 'rice, white, cooked'],
      state: 'cooked',
      visible_geometry: 'roughly one cup mounded',
      household_measure: { amount: 1, unit: 'cup' },
      grams_low: 120, grams_likely: 160, grams_high: 200,
      edible_fraction: 1.0, confidence: 0.65,
    },
    {
      name: 'zzzz unrecognisable garnish',
      search_terms: ['zzzz unrecognisable garnish'],
      state: 'raw',
      visible_geometry: 'small scattering',
      household_measure: { amount: 1, unit: 'tbsp' },
      grams_low: 3, grams_likely: 5, grams_high: 8,
      edible_fraction: 1.0, confidence: 0.2,
    },
  ],
  added_fat: { type: 'butter', grams_likely: 10 },
  hidden_ingredients_note: 'cream in the curry is likely',
  occlusion_risk: 'low',
};

const CALL2 = {
  reconciliation_notes: 'Portions consistent with the plate reference.',
  components: [
    { name: 'butter chicken', chosen_fdc_id: null, grams_final: 240, kcal: 257 },
    { name: 'white rice', chosen_fdc_id: null, grams_final: 160, kcal: 206 },
    { name: 'zzzz unrecognisable garnish', chosen_fdc_id: null, grams_final: 5, kcal: 12 },
  ],
  kcal_low: 400, kcal_likely: 475, kcal_high: 560,
  protein_g: 30, carb_g: 55, fat_g: 14,
  meal_slot: 'dinner',
  overall_confidence: 0.68,
  clarifying_question: 'Was the curry made with cream or yoghurt?',
};

function completionOf(text) {
  return { choices: [{ message: { content: text }, finish_reason: 'stop' }] };
}

/* Distinguishes the two calls the same way the module's own tests do. */
function scriptedClient(call1 = CALL1, call2 = CALL2) {
  const bodies = [];
  return {
    bodies,
    chat: {
      completions: {
        create: async (body) => {
          bodies.push(body);
          const isCall2 =
            body.response_format?.type === 'json_schema'
              ? body.response_format.json_schema.name === 'meal_reconciliation'
              : JSON.stringify(body.messages).includes('FIRST-PASS ESTIMATE');
          return completionOf(JSON.stringify(isCall2 ? call2 : call1));
        },
      },
    },
    models: { list: async () => ({ data: [{ id: 'gemini-3.5-flash-lite' }] }) },
  };
}

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => server?.close());

let tokenSeq = 0;

/* A fresh subject per token keeps the per-identity rate limiter from leaking
   between tests — they share one process, and the windows are wall-clock. */
async function freshToken(kind = 'google') {
  return session.issue({ sub: `test-user-${++tokenSeq}`, kind });
}

async function postPhoto(fields = {}, { token, omitAuth = false } = {}) {
  const form = new FormData();
  form.append('image', new Blob([JPEG_1PX], { type: 'image/jpeg' }), 'meal.jpg');
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));

  const headers = {};
  if (!omitAuth) headers.Authorization = `Bearer ${token || (await freshToken())}`;

  const res = await fetch(`${base}/api/analyze`, { method: 'POST', body: form, headers });
  return { res, body: await res.json() };
}

/* ------------------------------------------------------------------ tests */

test('happy path returns the shape the frontend consumes', async () => {
  const client = scriptedClient();
  vision.setClientFactory(() => client);

  const { res, body } = await postPhoto({
    slot: 'dinner',
    notes: 'cooked in butter',
    localTimeLabel: '07:43 PM',
  });

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.dishName, 'Chicken curry with rice');
  assert.equal(body.cookingMethod, 'sauteed');
  assert.equal(body.slot, 'dinner');
  assert.equal(body.clarifyingQuestion, 'Was the curry made with cream or yoghurt?');
  assert.equal(body.components.length, 3);

  for (const c of body.components) {
    for (const k of ['name', 'grams', 'matched', 'fdcId', 'fdcDescription', 'kcal100', 'kcal']) {
      assert.ok(k in c, `component is missing ${k}, which app.js reads`);
    }
  }
});

test('calories come from the FNDDS row, not from the model', async () => {
  vision.setClientFactory(() => scriptedClient());
  const { body } = await postPhoto({ slot: 'dinner' });

  const curry = body.components.find((c) => c.name === 'butter chicken');
  assert.equal(curry.matched, true);
  assert.equal(curry.fdcDescription, 'Chicken curry');
  assert.equal(curry.kcal100, 107);
  assert.equal(curry.grams, 240);
  // 107 kcal/100g x 240 g = 256.8 — derived, not the model's 257
  assert.ok(Math.abs(curry.kcal - 256.8) < 0.01, `expected 256.8, got ${curry.kcal}`);

  const rice = body.components.find((c) => c.name === 'white rice');
  assert.equal(rice.kcal100, 129);
  assert.ok(Math.abs(rice.kcal - 129 * 1.6) < 0.01);
});

test('an unmatched component is flagged rather than silently priced', async () => {
  vision.setClientFactory(() => scriptedClient());
  const { body } = await postPhoto({ slot: 'dinner' });

  const garnish = body.components.find((c) => c.name.startsWith('zzzz'));
  assert.equal(garnish.matched, false);
  assert.equal(garnish.fdcId, null);
  assert.equal(garnish.kcal100, null);
  assert.equal(garnish.kcal, 12, "falls back to the model's own number");
});

test('the model total is kept only as a disagreement detector', async () => {
  vision.setClientFactory(() => scriptedClient());
  const { body } = await postPhoto({ slot: 'dinner' });

  assert.ok(body.disagreement, 'disagreement block must be present');
  assert.equal(body.disagreement.modelKcal, 475);
  // 256.8 + 206.4 + 12 = 475.2 — the two agree here
  assert.equal(body.disagreement.dbKcal, 475);
  assert.equal(body.disagreement.flagged, false);
});

test('a wildly disagreeing model total raises the flag', async () => {
  /* The whole range has to move together: vision.js sorts [low, likely, high]
     and takes the median, so a `likely` above its own `high` gets repaired
     rather than passed through. */
  vision.setClientFactory(() =>
    scriptedClient(CALL1, { ...CALL2, kcal_low: 1300, kcal_likely: 1500, kcal_high: 1700 })
  );
  const { body } = await postPhoto({ slot: 'dinner' });
  assert.equal(body.disagreement.modelKcal, 1500);
  assert.equal(body.disagreement.dbKcal, 475);
  assert.equal(body.disagreement.flagged, true, '475 vs 1500 must be flagged');
});

test('an inconsistent model range is repaired, not passed through', async () => {
  vision.setClientFactory(() =>
    scriptedClient(CALL1, { ...CALL2, kcal_low: 400, kcal_likely: 1500, kcal_high: 560 })
  );
  const { body } = await postPhoto({ slot: 'dinner' });
  assert.equal(body.disagreement.modelKcal, 560, 'median of [400, 560, 1500]');
});

test('portion hint is expressed in a household measure a person can check', async () => {
  vision.setClientFactory(() => scriptedClient());
  const { body } = await postPhoto({ slot: 'dinner' });
  const curry = body.components.find((c) => c.name === 'butter chicken');
  assert.match(curry.portionHint, /cup/i, `got ${curry.portionHint}`);
});

test('the photo is sent on BOTH calls, not just the first', async () => {
  const client = scriptedClient();
  vision.setClientFactory(() => client);
  await postPhoto({ slot: 'dinner' });

  assert.equal(client.bodies.length, 2, 'expected a two-call pipeline');
  for (const [i, body] of client.bodies.entries()) {
    const hasImage = JSON.stringify(body.messages).includes('data:image/jpeg;base64,');
    assert.ok(hasImage, `call ${i + 1} did not carry the image`);
  }
});

test("the user's slot choice wins over the model's", async () => {
  vision.setClientFactory(() => scriptedClient(CALL1, { ...CALL2, meal_slot: 'breakfast' }));
  const { body } = await postPhoto({ slot: 'dinner' });
  assert.equal(body.slot, 'dinner', 'meal slot is user intent, not a visual property');
});

test('a request with no image is rejected before any model call', async () => {
  const client = scriptedClient();
  vision.setClientFactory(() => client);
  const res = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    body: new FormData(),
    headers: { Authorization: `Bearer ${await freshToken()}` },
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'no_image');
  assert.equal(client.bodies.length, 0, 'must not burn a model call on an empty request');
});

test('a missing API key returns an actionable 503, not a crash', async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const { res, body } = await postPhoto({ slot: 'dinner' });
    assert.equal(res.status, 503);
    assert.equal(body.error.code, 'no_key');
    assert.match(body.error.message, /GEMINI_API_KEY/);
  } finally {
    process.env.GEMINI_API_KEY = saved;
  }
});

test('a photo with no identifiable food returns 422, not an empty meal', async () => {
  vision.setClientFactory(() => scriptedClient({ ...CALL1, components: [] }));
  const { res, body } = await postPhoto({ slot: 'dinner' });
  assert.equal(res.status, 422);
  assert.equal(body.error.code, 'no_food');
});

test('RECONCILE=0 halves the model calls and still returns DB-derived calories', async () => {
  const client = scriptedClient();
  vision.setClientFactory(() => client);
  process.env.RECONCILE = '0';
  try {
    const { res, body } = await postPhoto({ slot: 'lunch' });
    assert.equal(res.status, 200);
    assert.equal(client.bodies.length, 1, 'only the extraction call should be made');

    // Grams fall back to Call 1's grams_likely, and calories still come from FNDDS.
    const curry = body.components.find((c) => c.name === 'butter chicken');
    assert.equal(curry.grams, 240);
    assert.equal(curry.kcal100, 107);
    assert.ok(Math.abs(curry.kcal - 256.8) < 0.01);

    /* Call 1 emits grams but no calories, so an unmatched component has no
       model figure to fall back on and contributes nothing. 463 rather than
       475 is correct — the garnish's 12 kcal came from Call 2. */
    const garnish = body.components.find((c) => c.name.startsWith('zzzz'));
    assert.equal(garnish.matched, false);
    assert.equal(garnish.kcal, 0, 'an unmatched item must not be invented');

    // No second opinion exists, so the detector must say so rather than pass.
    assert.equal(body.disagreement.checked, false);
    assert.equal(body.disagreement.flagged, false);
    assert.equal(body.disagreement.modelKcal, null);
    assert.equal(body.disagreement.dbKcal, 463);

    // Confidence falls back to the mean of Call 1's per-component scores.
    assert.ok(body.confidence > 0 && body.confidence < 1, `got ${body.confidence}`);
    assert.equal(body.slot, 'lunch');
  } finally {
    delete process.env.RECONCILE;
  }
});

test('RECONCILE_MODEL sends the two calls to different quota buckets', async () => {
  const client = scriptedClient();
  vision.setClientFactory(() => client);
  process.env.VISION_MODEL = 'gemini-3.5-flash-lite';
  process.env.RECONCILE_MODEL = 'gemini-3.8-flash';
  try {
    await postPhoto({ slot: 'dinner' });
    assert.equal(client.bodies.length, 2);
    assert.equal(client.bodies[0].model, 'gemini-3.5-flash-lite');
    assert.equal(client.bodies[1].model, 'gemini-3.8-flash');
  } finally {
    delete process.env.VISION_MODEL;
    delete process.env.RECONCILE_MODEL;
  }
});

test('both calls share one model when RECONCILE_MODEL is unset', async () => {
  const client = scriptedClient();
  vision.setClientFactory(() => client);
  process.env.VISION_MODEL = 'gemini-3.5-flash-lite';
  try {
    await postPhoto({ slot: 'dinner' });
    assert.equal(client.bodies[0].model, 'gemini-3.5-flash-lite');
    assert.equal(client.bodies[1].model, 'gemini-3.5-flash-lite', 'conservative default');
  } finally {
    delete process.env.VISION_MODEL;
  }
});

test('two-call mode marks the disagreement check as actually run', async () => {
  vision.setClientFactory(() => scriptedClient());
  const { body } = await postPhoto({ slot: 'dinner' });
  assert.equal(body.disagreement.checked, true);
});

/* ------------------------------------------ model override of the DB row */

test("the model's chosen_fdc_id overrides the matcher's row", async () => {
  /* The matcher lands "white rice" on 56205001 "NS as to fat" (129 kcal). The
     notes said it was cooked in oil, so the model picks 56205002 (151). The
     override is the safeguard against a confident wrong match — without it a
     ~5.7% mismatch rate lands in the total unchallenged. */
  const call2 = {
    ...CALL2,
    components: [
      { name: 'butter chicken', chosen_fdc_id: null, grams_final: 240, kcal: 257 },
      { name: 'white rice', chosen_fdc_id: '56205002', grams_final: 160, kcal: 242 },
      { name: 'zzzz unrecognisable garnish', chosen_fdc_id: null, grams_final: 5, kcal: 12 },
    ],
  };
  vision.setClientFactory(() => scriptedClient(CALL1, call2));
  const { body } = await postPhoto({ slot: 'dinner', notes: 'rice fried in oil' });

  const rice = body.components.find((c) => c.name === 'white rice');
  assert.equal(rice.fdcId, '56205002');
  assert.equal(rice.fdcDescription, 'Rice, white, cooked, made with oil');
  assert.equal(rice.kcal100, 151, "the model's row must win over the matcher's");
  assert.ok(Math.abs(rice.kcal - 151 * 1.6) < 0.01);

  // A component the model did not override keeps the matcher's row.
  const curry = body.components.find((c) => c.name === 'butter chicken');
  assert.equal(curry.fdcDescription, 'Chicken curry');
});

test('an unknown fdc id from the model falls back rather than crashing', async () => {
  const call2 = {
    ...CALL2,
    components: [
      { name: 'butter chicken', chosen_fdc_id: '99999999', grams_final: 240, kcal: 257 },
      { name: 'white rice', chosen_fdc_id: null, grams_final: 160, kcal: 206 },
      { name: 'zzzz unrecognisable garnish', chosen_fdc_id: null, grams_final: 5, kcal: 12 },
    ],
  };
  vision.setClientFactory(() => scriptedClient(CALL1, call2));
  const { res, body } = await postPhoto({ slot: 'dinner' });
  assert.equal(res.status, 200);
  const curry = body.components.find((c) => c.name === 'butter chicken');
  assert.equal(curry.fdcDescription, 'Chicken curry', 'falls back to the matcher');
});

test('the model receives a shortlist to choose from, not a single verdict', async () => {
  const client = scriptedClient();
  vision.setClientFactory(() => client);
  await postPhoto({ slot: 'dinner' });

  const call2Text = JSON.stringify(client.bodies[1].messages);
  assert.ok(call2Text.includes('candidates'), 'call 2 must carry the candidate shortlist');
  // The correct row for "butter chicken" is among them.
  assert.ok(call2Text.includes('27146150'), 'the matched fdc id should be offered');
});

test('below-threshold candidates are still offered, flagged as such', async () => {
  /* "beef lasagna" clears no score floor — FNDDS files it as "Lasagna with
     meat". Rather than lower the floor (which is what turns "avocado toast"
     into French toast) the unfiltered candidates go to the model to judge. */
  const call1 = {
    ...CALL1,
    components: [
      { ...CALL1.components[0], name: 'beef lasagna', search_terms: ['beef lasagna'] },
    ],
  };
  const client = scriptedClient(call1, {
    ...CALL2,
    components: [{ name: 'beef lasagna', chosen_fdc_id: null, grams_final: 300, kcal: 400 }],
  });
  vision.setClientFactory(() => client);
  const { res, body } = await postPhoto({ slot: 'dinner' });

  assert.equal(res.status, 200);
  const sent = JSON.parse(
    JSON.stringify(client.bodies[1].messages)
  );
  const text = JSON.stringify(sent);
  assert.ok(text.includes('candidates_below_threshold'), 'the model must be told these are unconfirmed');

  // Rejected by the model, so it stays unmatched and keeps the model's number.
  const item = body.components[0];
  assert.equal(item.matched, false);
  assert.equal(item.kcal, 400);
});

test('health reports the food db and whether vision works', async () => {
  const res = await fetch(`${base}/api/health`);
  const body = await res.json();
  assert.equal(body.foodDb.foodCount, 5432);
  assert.equal(typeof body.vision.ok, 'boolean');
});

/* /api/health is public and unauthenticated. checkModelAvailable() knows every
   model enabled on the operator's API key; none of that belongs in a response
   a stranger can fetch. The assertion is on the whole serialized body, not on
   named fields, so re-spreading the check result would fail this test. */
test('health leaks nothing about the API key beyond a yes/no', async () => {
  vision.setClientFactory(() => ({
    chat: { completions: { create: async () => { throw new Error('not used here'); } } },
    models: {
      list: async () => ({
        data: [
          { id: 'gemini-3.5-flash-lite' },
          { id: 'gemini-private-preview-model' },
          { id: 'some-other-enabled-model' },
        ],
      }),
    },
  }));

  const res = await fetch(`${base}/api/health`);
  const raw = await res.text();

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(raw).vision), ['ok'], 'vision must expose exactly one field');
  for (const leaked of ['gemini-private-preview-model', 'some-other-enabled-model', 'models', 'suggestion', 'VISION_MODEL']) {
    assert.ok(!raw.includes(leaked), `health must not disclose "${leaked}"`);
  }
});

test('an unknown path serves the app shell', async () => {
  const res = await fetch(`${base}/some/deep/link`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>CalPal<\/title>/);
});

/* ==========================================================================
   Server-side authorization on /api/analyze.

   The gate exists to stop an anonymous caller spending the operator's Gemini
   quota, so the load-bearing assertion in most of these is not the status code
   — it is that the model was never called.
   ========================================================================== */

const { SignJWT } = require('jose');

test('an unauthenticated photo is rejected before any model call', async () => {
  const client = scriptedClient();
  vision.setClientFactory(() => client);

  const { res, body } = await postPhoto({}, { omitAuth: true });

  assert.equal(res.status, 401);
  assert.equal(body.error.code, 'no_session');
  assert.equal(client.bodies.length, 0, 'must not burn a model call on an anonymous request');
});

test('a garbage bearer token is rejected before any model call', async () => {
  const client = scriptedClient();
  vision.setClientFactory(() => client);

  const { res, body } = await postPhoto({}, { token: 'not.a.jwt' });

  assert.equal(res.status, 401);
  assert.equal(body.error.code, 'bad_session');
  assert.equal(client.bodies.length, 0);
});

/* The whole point of signing: a token this server did not mint is worthless,
   even when it is a structurally perfect JWT with all the right claims. */
test('a well-formed token signed with the wrong secret is rejected', async () => {
  const client = scriptedClient();
  vision.setClientFactory(() => client);

  const forged = await new SignJWT({ kind: 'google' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('attacker')
    .setIssuer('calpal')
    .setAudience('calpal-api')
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(new TextEncoder().encode('a-different-secret-that-is-long-enough!!'));

  const { res, body } = await postPhoto({}, { token: forged });

  assert.equal(res.status, 401);
  assert.equal(body.error.code, 'bad_session');
  assert.equal(client.bodies.length, 0);
});

test('an expired token is rejected and says so distinctly', async () => {
  const client = scriptedClient();
  vision.setClientFactory(() => client);

  const stale = await new SignJWT({ kind: 'google' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('lapsed-user')
    .setIssuer('calpal')
    .setAudience('calpal-api')
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET));

  const { res, body } = await postPhoto({}, { token: stale });

  assert.equal(res.status, 401);
  /* Distinct from bad_session on purpose: the client signs the user out and
     bounces to the gate for this one, rather than just showing a toast. */
  assert.equal(body.error.code, 'session_expired');
  assert.equal(client.bodies.length, 0);
});

test('the per-identity rate limit stops a signed-in account draining the quota', async () => {
  const client = scriptedClient();
  vision.setClientFactory(() => client);
  rateLimit.resetAll();

  const hourly = rateLimit.limiters.analyze.windows.find((w) => w.key === 'hour').max;
  const token = await session.issue({ sub: 'greedy-user', kind: 'google' });

  for (let i = 0; i < hourly; i++) {
    const { res } = await postPhoto({}, { token });
    assert.equal(res.status, 200, `request ${i + 1} of ${hourly} should still be allowed`);
  }

  const callsBefore = client.bodies.length;
  const { res, body } = await postPhoto({}, { token });

  assert.equal(res.status, 429);
  assert.equal(body.error.code, 'rate_limited');
  assert.ok(res.headers.get('retry-after'), 'a 429 must say when to come back');
  assert.equal(client.bodies.length, callsBefore, 'a throttled request must not reach the model');

  rateLimit.resetAll();
});

test('the limit is per identity, not global', async () => {
  const client = scriptedClient();
  vision.setClientFactory(() => client);
  rateLimit.resetAll();

  const hourly = rateLimit.limiters.analyze.windows.find((w) => w.key === 'hour').max;
  const heavy = await session.issue({ sub: 'heavy-user', kind: 'google' });
  for (let i = 0; i < hourly; i++) await postPhoto({}, { token: heavy });

  assert.equal((await postPhoto({}, { token: heavy })).res.status, 429);

  const bystander = await session.issue({ sub: 'quiet-user', kind: 'apple' });
  const { res } = await postPhoto({}, { token: bystander });
  assert.equal(res.status, 200, 'one noisy account must not lock everyone else out');

  rateLimit.resetAll();
});

test('a guest identity cannot be minted a token at all', async () => {
  await assert.rejects(
    () => session.issue({ sub: 'local', kind: 'guest' }),
    /Refusing to issue a session/,
    'signing a self-asserted guest identity would launder it through our key'
  );
});

test('health reports whether sign-in is enforced and a secret resolved', async () => {
  const res = await fetch(`${base}/api/health`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.auth.signinRequired, true);
  assert.equal(body.auth.secret.ok, true);
  assert.equal(body.auth.secret.source, 'env');
  assert.ok(!JSON.stringify(body).includes(process.env.AUTH_SECRET), 'never leak the secret itself');
});

/* ==========================================================================
   Rate limiting across the rest of the API.

   /api/analyze is covered above (per identity). These cover the routes that
   have no identity to key on, plus the health cache — which is the actual fix
   for /api/health being a Gemini quota amplifier; its limiter is a backstop.
   ========================================================================== */

test('sign-in attempts are capped per address', async () => {
  rateLimit.resetAll();
  const max = rateLimit.limiters.auth.windows.find((w) => w.key === 'minute').max;

  /* Deliberately invalid tokens: this is about the ceiling, not verification.
     Each still costs a signature check, which is what the cap protects. */
  const attempt = () =>
    fetch(`${base}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'nope' }),
    });

  for (let i = 0; i < max; i++) {
    const res = await attempt();
    assert.notEqual(res.status, 429, `attempt ${i + 1} of ${max} should not be throttled yet`);
  }

  const res = await attempt();
  const body = await res.json();
  assert.equal(res.status, 429);
  assert.equal(body.error.code, 'rate_limited');
  assert.ok(res.headers.get('retry-after'), 'a 429 must say when to come back');
  rateLimit.resetAll();
});

test('health is capped, and every answer carries the standard headers', async () => {
  rateLimit.resetAll();
  const max = rateLimit.limiters.health.windows.find((w) => w.key === 'minute').max;

  for (let i = 0; i < max; i++) {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('ratelimit-limit'), 'RateLimit-Limit should always be present');
    assert.ok(res.headers.get('ratelimit-remaining') !== null);
  }

  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 429);
  rateLimit.resetAll();
});

/* The load-bearing one: without the cache, N health hits are N calls to
   Google, which is how an uptime monitor quietly drains a free-tier quota. */
test('repeated health checks do not each call the model', async () => {
  rateLimit.resetAll();

  let modelCalls = 0;
  vision.setClientFactory(() => ({
    chat: { completions: { create: async () => { throw new Error('not used here'); } } },
    models: {
      list: async () => {
        modelCalls++;
        return { data: [{ id: 'gemini-3.5-flash-lite' }] };
      },
    },
  }));

  /* Warm the cache, then hit it again well inside the TTL. */
  await fetch(`${base}/api/health`);
  const afterFirst = modelCalls;
  await fetch(`${base}/api/health`);
  await fetch(`${base}/api/health`);

  assert.equal(
    modelCalls,
    afterFirst,
    'health must serve a cached model check rather than calling Google every hit'
  );
  rateLimit.resetAll();
});

test('the /api backstop keys on the caller, not the route', async () => {
  rateLimit.resetAll();
  const limiter = rateLimit.limiters.api;
  const max = limiter.windows.find((w) => w.key === 'minute').max;

  /* Consumed directly: driving 120 real requests through fetch would make the
     suite slow for no extra confidence in the engine itself. */
  for (let i = 0; i < max; i++) {
    assert.equal(limiter.consume('api:1.2.3.4').ok, true, `hit ${i + 1} should pass`);
  }
  assert.equal(limiter.consume('api:1.2.3.4').ok, false, 'the ceiling should bind');
  assert.equal(limiter.consume('api:5.6.7.8').ok, true, 'a different address is unaffected');

  rateLimit.resetAll();
});

test('a limiter reports the binding window when several are configured', async () => {
  const limiter = rateLimit.createLimiter({
    name: 'test-two-windows',
    keyBy: () => 'k',
    windows: [
      { key: 'minute', ms: 60000, max: 5 },
      { key: 'hour', ms: 3600000, max: 3 },
    ],
  });

  assert.equal(limiter.consume('k').remaining, 2, 'headroom is the tightest window, not the loosest');
  limiter.consume('k');
  limiter.consume('k');

  const blocked = limiter.consume('k');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.window, 'hour', 'the hour cap of 3 binds before the minute cap of 5');
});

test('the client address survives a proxy header only when a proxy is trusted', async () => {
  const spoofed = { headers: { 'x-forwarded-for': '9.9.9.9' }, socket: { remoteAddress: '::ffff:127.0.0.1' } };

  const wasVercel = process.env.VERCEL;
  const wasTrust = process.env.TRUST_PROXY;
  delete process.env.VERCEL;
  delete process.env.TRUST_PROXY;

  assert.equal(
    rateLimit.clientIp(spoofed),
    '127.0.0.1',
    'an untrusted X-Forwarded-For must not let a caller pick their own bucket'
  );

  process.env.TRUST_PROXY = '1';
  assert.equal(rateLimit.clientIp(spoofed), '9.9.9.9', 'behind a trusted proxy the header is the client');

  if (wasVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = wasVercel;
  if (wasTrust === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = wasTrust;
});
