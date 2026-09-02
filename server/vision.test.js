"use strict";

/**
 * server/vision.test.js
 * -----------------------------------------------------------------------------
 * Key-free test suite for server/vision.js. Every provider interaction goes
 * through an injected fake client, so this runs with GEMINI_API_KEY unset and
 * makes zero network calls.
 *
 *   node server/vision.test.js      (or: npm run test:vision)
 * -----------------------------------------------------------------------------
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Guarantee a key-free environment before the module is required.
delete process.env.GEMINI_API_KEY;
delete process.env.VISION_MODEL;
delete process.env.VISION_MEDIA_RESOLUTION;

const vision = require(path.join(__dirname, "vision.js"));
const I = vision.__internals;
const CODES = vision.ERROR_CODES;

// -----------------------------------------------------------------------------
// Fixtures / helpers
// -----------------------------------------------------------------------------

const IMG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/AL+AAAAAAAAAAAAAAAAAAA//2Q==";

/** Minimal fake completion whose message content is `text`. */
function completionOf(text) {
  return { choices: [{ index: 0, message: { role: "assistant", content: text } }] };
}

/**
 * Fake OpenAI client. `script` is an array of handlers, one per call; each is
 * either a function(body) or a literal to return. Records every request body.
 */
function fakeClient(script, modelsPage) {
  const calls = [];
  let i = 0;
  return {
    calls,
    chat: {
      completions: {
        create: async (body) => {
          calls.push(body);
          const step = script[Math.min(i, script.length - 1)];
          i += 1;
          const v = typeof step === "function" ? step(body, calls.length) : step;
          if (v instanceof Error) throw v;
          return v;
        },
      },
    },
    models: {
      list: async () => {
        if (modelsPage instanceof Error) throw modelsPage;
        return modelsPage;
      },
    },
  };
}

/** Build an SDK-shaped HTTP error (status + nested error.message). */
function httpError(status, message, headers) {
  const e = new Error(message);
  e.status = status;
  e.error = { message: message };
  if (headers) e.headers = headers;
  return e;
}

const VALID_CALL1 = {
  scale_references: [{ object: "dinner fork", assumed_size_cm: 18.5, confidence: 0.8 }],
  plate_diameter_cm_estimate: 27,
  dish_name: "Chicken curry with rice",
  cuisine: "Indian",
  cooking_method: "sauteed",
  components: [
    {
      name: "chicken curry",
      search_terms: ["chicken curry", "chicken in sauce", "chicken"],
      state: "cooked",
      visible_geometry: "Spans about 1.1 fork-lengths across the bowl, mounded ~3 cm deep.",
      household_measure: { amount: 1.25, unit: "cup" },
      grams_low: 240,
      grams_likely: 300,
      grams_high: 380,
      edible_fraction: 1,
      confidence: 0.7,
    },
  ],
  added_fat: { type: "olive_oil", grams_likely: 12 },
  hidden_ingredients_note: "Cream and ghee are likely in the sauce.",
  occlusion_risk: "medium",
};

const VALID_CALL2 = {
  reconciliation_notes: "Row 2706538 matches; the photo shows a deeper bowl than assumed.",
  components: [
    { name: "chicken curry", chosen_fdc_id: "2706538", grams_final: 320, kcal: 342 },
  ],
  kcal_low: 260,
  kcal_likely: 342,
  kcal_high: 430,
  protein_g: 22.9,
  carb_g: 43.5,
  fat_g: 7.6,
  meal_slot: "dinner",
  overall_confidence: 0.62,
  clarifying_question: null,
};

const DB_ROWS_GROUPED = [
  {
    component: "chicken curry",
    candidates: [
      { c: "27243100", d: "Biryani with chicken", cat: "Rice mixed dishes", k: 104, p: 7.15, f: 2.38, cb: 13.6, po: [["1 cup", 196]] },
      { fdc_id: 2706538, description: "Chicken curry", wweiaCategory: "Meat mixed dishes", kcal_per_100g: 107, protein: 9.1, fat: 5.4, carb: 4.2, portions: [{ desc: "1 cup", grams: 236 }] },
    ],
  },
  { component: "white rice", candidates: [] },
];

function resetAll() {
  I.resetCapabilities();
  vision.setClientFactory(null);
  delete process.env.GEMINI_API_KEY;
  delete process.env.VISION_MODEL;
  delete process.env.VISION_MEDIA_RESOLUTION;
}

// -----------------------------------------------------------------------------
// 1. Exported interface
// -----------------------------------------------------------------------------

test("exports exactly the four contract functions", () => {
  assert.deepEqual(Object.keys(vision).sort(), [
    "analyzeMeal", "checkModelAvailable", "isConfigured", "reconcile",
  ]);
  for (const k of ["analyzeMeal", "reconcile", "checkModelAvailable", "isConfigured"]) {
    assert.equal(typeof vision[k], "function", k + " must be a function");
  }
  // Test seams exist but are non-enumerable.
  assert.equal(typeof vision.setClientFactory, "function");
  assert.equal(Object.keys(vision).includes("setClientFactory"), false);
});

test("isConfigured() reflects GEMINI_API_KEY only", () => {
  resetAll();
  assert.equal(vision.isConfigured(), false);
  process.env.GEMINI_API_KEY = "   ";
  assert.equal(vision.isConfigured(), false, "whitespace-only key is not configured");
  process.env.GEMINI_API_KEY = "AIza-fake";
  assert.equal(vision.isConfigured(), true);
  resetAll();
});

test("model id comes from env with the documented default; never hardcoded", () => {
  resetAll();
  assert.equal(I.getModelId(), "gemini-3.5-flash-lite");
  process.env.VISION_MODEL = "gemini-3.8-flash";
  assert.equal(I.getModelId(), "gemini-3.8-flash");
  process.env.VISION_MODEL = "  ";
  assert.equal(I.getModelId(), "gemini-3.5-flash-lite", "blank env falls back");
  resetAll();
});

test("base URL is the official OpenAI-compat endpoint", () => {
  assert.equal(I.GEMINI_BASE_URL, "https://generativelanguage.googleapis.com/v1beta/openai/");
});

// -----------------------------------------------------------------------------
// 2. Schema construction + KEY ORDER
// -----------------------------------------------------------------------------

test("call-1 schema top-level key order matches the contract", () => {
  assert.deepEqual(Object.keys(I.call1Schema().properties), [
    "scale_references", "plate_diameter_cm_estimate", "dish_name", "cuisine",
    "cooking_method", "components", "added_fat", "hidden_ingredients_note",
    "occlusion_risk",
  ]);
});

test("call-1 component keys put reasoning BEFORE the numbers it justifies", () => {
  const keys = Object.keys(I.call1Schema().properties.components.items.properties);
  assert.deepEqual(keys, [
    "name", "search_terms", "state", "visible_geometry", "household_measure",
    "grams_low", "grams_likely", "grams_high", "edible_fraction", "confidence",
  ]);
  assert.ok(
    keys.indexOf("visible_geometry") < keys.indexOf("grams_low"),
    "visible_geometry must precede grams_low (Let Me Speak Freely)"
  );
  assert.ok(keys.indexOf("household_measure") < keys.indexOf("grams_likely"));
});

test("call-2 schema key order puts reconciliation_notes first", () => {
  const keys = Object.keys(I.call2Schema().properties);
  assert.deepEqual(keys, [
    "reconciliation_notes", "components", "kcal_low", "kcal_likely", "kcal_high",
    "protein_g", "carb_g", "fat_g", "meal_slot", "overall_confidence",
    "clarifying_question",
  ]);
  assert.equal(keys[0], "reconciliation_notes");
  assert.ok(keys.indexOf("reconciliation_notes") < keys.indexOf("kcal_likely"));
  const comp = Object.keys(I.call2Schema().properties.components.items.properties);
  assert.deepEqual(comp, ["name", "chosen_fdc_id", "grams_final", "kcal"]);
});

test("schema enums match the agreed vocabularies", () => {
  const s1 = I.call1Schema().properties;
  assert.deepEqual(s1.cooking_method.enum, [
    "fried", "deep_fried", "grilled", "roasted", "boiled", "steamed", "raw", "baked", "sauteed",
  ]);
  assert.deepEqual(s1.scale_references.items.properties.object.enum, [
    "dinner fork", "dinner plate", "smartphone", "hand", "can", "mug",
  ]);
  assert.deepEqual(s1.components.items.properties.household_measure.properties.unit.enum, [
    "cup", "tbsp", "tsp", "oz", "slice", "piece", "fillet", "medium",
  ]);
  assert.deepEqual(s1.added_fat.properties.type.enum, ["olive_oil", "butter", "none", "unknown"]);
  assert.deepEqual(s1.occlusion_risk.enum, ["low", "medium", "high"]);
  assert.deepEqual(I.call2Schema().properties.meal_slot.enum, [
    "breakfast", "lunch", "dinner", "snack",
  ]);
  // Nullable fields use Google's `nullable`, not OpenAI's ["type","null"] union.
  assert.equal(s1.plate_diameter_cm_estimate.nullable, true);
  assert.equal(I.call2Schema().properties.clarifying_question.nullable, true);
});

test("buildResponseFormat emits both modes correctly", () => {
  const schema = I.call1Schema();
  const js = I.buildResponseFormat("meal_components", schema, "json_schema");
  assert.equal(js.type, "json_schema");
  assert.equal(js.json_schema.name, "meal_components");
  assert.equal(js.json_schema.strict, true);
  assert.deepEqual(Object.keys(js.json_schema.schema.properties)[0], "scale_references");

  const jo = I.buildResponseFormat("meal_components", schema, "json_object");
  assert.deepEqual(jo, { type: "json_object" });
});

// -----------------------------------------------------------------------------
// 3. media_resolution / extra_body construction
// -----------------------------------------------------------------------------

test("buildGoogleExtras sends BOTH documented extra_body nestings", () => {
  resetAll();
  const x = I.buildGoogleExtras();
  assert.equal(x.google.media_resolution, "MEDIA_RESOLUTION_HIGH");
  assert.equal(x.extra_body.google.media_resolution, "MEDIA_RESOLUTION_HIGH");
});

test("media resolution is env-overridable", () => {
  resetAll();
  assert.equal(I.getMediaResolution(), "MEDIA_RESOLUTION_HIGH");
  process.env.VISION_MEDIA_RESOLUTION = "MEDIA_RESOLUTION_MEDIUM";
  assert.equal(I.buildGoogleExtras().google.media_resolution, "MEDIA_RESOLUTION_MEDIUM");
  resetAll();
});

// -----------------------------------------------------------------------------
// 4. Prompt assembly
// -----------------------------------------------------------------------------

test("call-1 prompt carries notes, clock label and MEASURED plate diameter", () => {
  const t = I.buildCall1UserText(
    { notes: "homemade, lots of ghee", localTimeLabel: "07:43 AM - Breakfast", plateDiameterCm: 26.5 },
    "json_schema"
  );
  assert.ok(t.includes("homemade, lots of ghee"));
  assert.ok(t.includes("07:43 AM - Breakfast"));
  assert.ok(t.includes("MEASURED plate diameter: 26.5 cm"));
  assert.ok(t.includes("trust it over your own visual estimate"));
});

test("call-1 prompt asks the model to estimate the plate when none was measured", () => {
  const t = I.buildCall1UserText({}, "json_schema");
  assert.ok(t.includes("Plate diameter: not measured"));
  assert.ok(t.includes("none provided"));
  assert.ok(t.includes("not provided"));
  assert.ok(!t.includes("MEASURED plate diameter"));
});

test("json_object mode embeds the full schema in the prompt; json_schema mode does not", () => {
  const withSchema = I.buildCall1UserText({}, "json_object");
  const withoutSchema = I.buildCall1UserText({}, "json_schema");
  assert.ok(withSchema.includes("MUST conform exactly to this schema"));
  assert.ok(withSchema.includes('"grams_likely"'));
  assert.ok(withSchema.includes('"visible_geometry"'));
  assert.ok(!withoutSchema.includes("MUST conform exactly to this schema"));
  assert.ok(withSchema.length > withoutSchema.length);
});

test("system prompt counteracts systematic UNDER-estimation", () => {
  assert.ok(I.CALL1_SYSTEM.includes("25-40% MAPE"));
  assert.ok(I.CALL1_SYSTEM.includes("UNDER-estimation"));
  assert.ok(I.CALL1_SYSTEM.includes("revise it UPWARD"));
  assert.ok(I.CALL2_SYSTEM.includes("revise it UPWARD"));
});

test("call-1 explicitly forbids inferring the meal slot from the image", () => {
  assert.ok(I.CALL1_SYSTEM.includes("DO NOT infer which meal this is"));
  assert.ok(I.CALL1_SYSTEM.includes("not a property of the food"));
  assert.equal(
    Object.keys(I.call1Schema().properties).includes("meal_slot"),
    false,
    "meal_slot must NOT appear in the call-1 schema at all"
  );
});

test("call-2 prompt demands the image be used and states the per-100g rule", () => {
  assert.ok(I.CALL2_SYSTEM.includes("SAME PHOTOGRAPH"));
  assert.ok(I.CALL2_SYSTEM.includes("53.3"));
  assert.ok(I.CALL2_SYSTEM.includes("66.5"));
  assert.ok(I.CALL2_SYSTEM.includes("PER 100 GRAMS"));
  assert.ok(I.CALL2_SYSTEM.includes("AT MOST ONE"));
});

test("call-2 prompt passes the meal slot IN rather than asking for it", () => {
  const t = I.buildCall2UserText(
    { call1: VALID_CALL1, dbRows: DB_ROWS_GROUPED, mealSlot: "Dinner", localTimeLabel: "7:10 PM - Dinner" },
    "json_schema"
  );
  assert.ok(t.includes("meal_slot = dinner"), "slot normalised and injected");
  assert.ok(t.includes("already decided from the user's clock"));
  assert.ok(t.includes("7:10 PM - Dinner"));
});

test("call-2 prompt renders grouped FNDDS rows with quoted ids and per-100g labels", () => {
  const t = I.buildCall2UserText({ call1: VALID_CALL1, dbRows: DB_ROWS_GROUPED }, "json_schema");
  assert.ok(t.includes("ALL NUTRIENT VALUES ARE PER 100 GRAMS"));
  assert.ok(t.includes("### candidates for component: chicken curry"));
  assert.ok(t.includes('fdc_id="27243100"'), "compact fndds-lite shape supported");
  assert.ok(t.includes('fdc_id="2706538"'), "verbose FDC shape supported");
  assert.ok(t.includes("Biryani with chicken"));
  assert.ok(t.includes("1 cup = 196 g"), "array portion tuples rendered");
  assert.ok(t.includes("1 cup = 236 g"), "object portions rendered");
  assert.ok(t.includes("### candidates for component: white rice"));
  assert.ok(t.includes("NO candidate"), "empty candidate list is called out explicitly");
});

test("formatDbRows accepts flat arrays and plain maps too, and flags missing kcal", () => {
  const flat = I.formatDbRows([{ c: "11000000", d: "Milk, human", k: null }]);
  assert.equal(flat.count, 1);
  assert.ok(flat.text.includes("kcal MISSING - do not use this row"));

  const mapped = I.formatDbRows({ rice: [{ c: "1", d: "Rice, white, cooked", k: 129 }] });
  assert.ok(mapped.text.includes("### candidates for component: rice"));
  assert.equal(mapped.count, 1);

  assert.equal(I.formatDbRows([]).count, 0);
  assert.ok(I.formatDbRows([]).text.includes("no database rows at all"));
});

test("buildMessages attaches the image as an OpenAI-compat image_url part", () => {
  const m = I.buildMessages("SYS", "USER", IMG);
  assert.equal(m.length, 2);
  assert.equal(m[0].role, "system");
  assert.equal(m[1].role, "user");
  assert.equal(m[1].content[0].type, "text");
  assert.equal(m[1].content[1].type, "image_url");
  assert.equal(m[1].content[1].image_url.url, IMG);
});

// -----------------------------------------------------------------------------
// 5. JSON extraction / repair
// -----------------------------------------------------------------------------

test("extractJson handles clean JSON, fences, preamble, trailing commas, truncation", () => {
  assert.deepEqual(I.extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(I.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(I.extractJson('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(I.extractJson('Here is the JSON:\n{"a":1}\nHope that helps!'), { a: 1 });
  assert.deepEqual(I.extractJson('{"a":1,"b":[1,2,],}'), { a: 1, b: [1, 2] });
  assert.deepEqual(I.extractJson('{"a":1,"b":{"c":2'), { a: 1, b: { c: 2 } });
  assert.deepEqual(I.extractJson('{"a":"unterminated'), { a: "unterminated" });
});

test("repairJson does not corrupt braces that live inside strings", () => {
  const src = '{"note":"a } b { c","n":1}';
  assert.deepEqual(I.extractJson(src), { note: "a } b { c", n: 1 });
  const esc = '{"note":"quote \\" and brace }","n":2}';
  assert.deepEqual(I.extractJson(esc), { note: 'quote " and brace }', n: 2 });
});

test("extractJson throws BAD_JSON on unrecoverable text", () => {
  for (const bad of ["", "   ", "I cannot analyse this photograph.", "<<<>>>"]) {
    assert.throws(
      () => I.extractJson(bad),
      (e) => e.code === CODES.BAD_JSON,
      "should be BAD_JSON for " + JSON.stringify(bad)
    );
  }
});

// -----------------------------------------------------------------------------
// 6. Normalisation
// -----------------------------------------------------------------------------

test("normaliseCall1 preserves exact contract key order", () => {
  const out = I.normaliseCall1(VALID_CALL1, {});
  assert.deepEqual(Object.keys(out), [
    "scale_references", "plate_diameter_cm_estimate", "dish_name", "cuisine",
    "cooking_method", "components", "added_fat", "hidden_ingredients_note",
    "occlusion_risk",
  ]);
  assert.deepEqual(Object.keys(out.components[0]), [
    "name", "search_terms", "state", "visible_geometry", "household_measure",
    "grams_low", "grams_likely", "grams_high", "edible_fraction", "confidence",
  ]);
});

test("normaliseCall1 repairs junk the model emits", () => {
  const out = I.normaliseCall1(
    {
      scale_references: [{ object: "DINNER FORK", assumed_size_cm: "18.5 cm", confidence: 85 }],
      plate_diameter_cm_estimate: "27",
      cooking_method: "Deep-Fried",
      components: [
        {
          name: "  rice  ",
          search_terms: [],
          state: "COOKED",
          grams_low: 300,
          grams_likely: 150,
          grams_high: 200,
          edible_fraction: 2,
          confidence: -1,
          household_measure: { amount: "1 cup", unit: "Cup" },
        },
      ],
      added_fat: { type: "OLIVE OIL", grams_likely: -5 },
      occlusion_risk: "HIGH",
    },
    {}
  );
  const c = out.components[0];
  assert.equal(out.scale_references[0].object, "dinner fork");
  assert.equal(out.scale_references[0].assumed_size_cm, 18.5);
  assert.equal(out.scale_references[0].confidence, 0.85, "percent confidence rescaled");
  assert.equal(out.plate_diameter_cm_estimate, 27);
  assert.equal(out.cooking_method, "deep_fried", "hyphen + case normalised to the enum");
  assert.equal(out.added_fat.type, "olive_oil");
  assert.equal(out.added_fat.grams_likely, 0, "negative grams clamped");
  assert.equal(out.occlusion_risk, "high");
  assert.equal(c.name, "rice");
  assert.deepEqual(c.search_terms, ["rice"], "empty search_terms backfilled from name");
  assert.equal(c.state, "cooked");
  assert.deepEqual([c.grams_low, c.grams_likely, c.grams_high], [150, 200, 300], "ranges re-sorted");
  assert.equal(c.edible_fraction, 1, "clamped to <= 1");
  assert.equal(c.confidence, 0, "clamped to >= 0");
  assert.equal(c.household_measure.amount, 1);
  assert.equal(c.household_measure.unit, "cup");
});

test("normaliseCall1 survives a totally empty / wrong-typed model reply", () => {
  const out = I.normaliseCall1(null, {});
  assert.deepEqual(out.scale_references, []);
  assert.deepEqual(out.components, []);
  assert.equal(out.plate_diameter_cm_estimate, null);
  assert.equal(out.dish_name, "unidentified meal");
  assert.equal(out.added_fat.type, "unknown");
  assert.equal(out.occlusion_risk, "medium");
});

test("a measured plate diameter always wins over the model's guess", () => {
  const out = I.normaliseCall1({ plate_diameter_cm_estimate: 12 }, { plateDiameterCm: 26.5 });
  assert.equal(out.plate_diameter_cm_estimate, 26.5);
});

test("normaliseCall2 preserves exact contract key order", () => {
  const out = I.normaliseCall2(VALID_CALL2, { mealSlot: "dinner" });
  assert.deepEqual(Object.keys(out), [
    "reconciliation_notes", "components", "kcal_low", "kcal_likely", "kcal_high",
    "protein_g", "carb_g", "fat_g", "meal_slot", "overall_confidence",
    "clarifying_question",
  ]);
  assert.deepEqual(Object.keys(out.components[0]), [
    "name", "chosen_fdc_id", "grams_final", "kcal",
  ]);
});

test("meal_slot defaults to the caller's value and is never invented", () => {
  assert.equal(I.normaliseCall2({}, { mealSlot: "breakfast" }).meal_slot, "breakfast");
  assert.equal(I.normaliseCall2({ meal_slot: "" }, { mealSlot: "lunch" }).meal_slot, "lunch");
  assert.equal(I.normaliseCall2({ meal_slot: "brunch" }, { mealSlot: "lunch" }).meal_slot, "lunch",
    "an out-of-enum override falls back to the caller's slot");
  assert.equal(I.normaliseCall2({ meal_slot: "Dinner" }, { mealSlot: "lunch" }).meal_slot, "dinner",
    "a valid model override is honoured");
  assert.equal(I.normaliseCall2({}, {}).meal_slot, "snack", "last-resort default");
});

test("at most ONE clarifying question survives normalisation", () => {
  assert.equal(I.normaliseCall2({ clarifying_question: null }, {}).clarifying_question, null);
  assert.equal(I.normaliseCall2({ clarifying_question: "none" }, {}).clarifying_question, null);
  assert.equal(I.normaliseCall2({ clarifying_question: "" }, {}).clarifying_question, null);
  assert.equal(
    I.normaliseCall2({ clarifying_question: ["Was the skin eaten?", "Was it fried?"] }, {}).clarifying_question,
    "Was the skin eaten?",
    "an array collapses to the first question"
  );
  assert.equal(
    I.normaliseCall2({ clarifying_question: "Was the skin eaten? Was there oil? Any sauce?" }, {}).clarifying_question,
    "Was the skin eaten?",
    "a run-on multi-question string is truncated to the first"
  );
});

test("normaliseCall2 orders the kcal interval and falls back to the component sum", () => {
  const out = I.normaliseCall2(
    {
      components: [
        { name: "a", chosen_fdc_id: 1, grams_final: 100, kcal: 200 },
        { name: "b", chosen_fdc_id: "null", grams_final: 50, kcal: 90 },
      ],
      kcal_low: 500, kcal_likely: 290, kcal_high: 100,
    },
    {}
  );
  assert.deepEqual([out.kcal_low, out.kcal_likely, out.kcal_high], [100, 290, 500]);
  assert.equal(out.components[0].chosen_fdc_id, "1", "numeric ids become strings");
  assert.equal(out.components[1].chosen_fdc_id, null, 'the string "null" becomes real null');

  const summed = I.normaliseCall2(
    { components: [{ name: "a", chosen_fdc_id: null, grams_final: 100, kcal: 200 }] },
    {}
  );
  assert.equal(summed.kcal_likely, 200, "missing kcal_likely falls back to the component sum");
});

// -----------------------------------------------------------------------------
// 7. Happy path through the fake client
// -----------------------------------------------------------------------------

test("analyzeMeal: json_schema mode, media_resolution attached, no key needed", async () => {
  resetAll();
  const client = fakeClient([completionOf(JSON.stringify(VALID_CALL1))]);
  const out = await vision.analyzeMeal({
    imageDataUrl: IMG,
    notes: "restaurant portion",
    localTimeLabel: "07:43 AM - Breakfast",
    plateDiameterCm: 26.5,
    _client: client,
  });

  assert.equal(client.calls.length, 1);
  const body = client.calls[0];
  assert.equal(body.model, "gemini-3.5-flash-lite");
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.name, "meal_components");
  assert.equal(body.extra_body.google.media_resolution, "MEDIA_RESOLUTION_HIGH");
  assert.equal(body.extra_body.extra_body.google.media_resolution, "MEDIA_RESOLUTION_HIGH");
  assert.equal(body.messages[1].content[1].image_url.url, IMG);

  assert.equal(out.dish_name, "Chicken curry with rice");
  assert.equal(out.plate_diameter_cm_estimate, 26.5);
  assert.equal(out.components[0].grams_likely, 300);
  assert.equal(vision.getCapabilities().responseFormatMode, "json_schema");
  assert.equal(vision.getCapabilities().responseFormatConfirmed, true);
  resetAll();
});

test("reconcile: sends the SAME image again plus call1 and the db rows", async () => {
  resetAll();
  const client = fakeClient([completionOf(JSON.stringify(VALID_CALL2))]);
  const out = await vision.reconcile({
    imageDataUrl: IMG,
    call1: VALID_CALL1,
    dbRows: DB_ROWS_GROUPED,
    mealSlot: "dinner",
    _client: client,
  });

  const body = client.calls[0];
  const parts = body.messages[1].content;
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url.url, IMG, "call 2 MUST carry the image (53.3 vs 66.5 kcal MAE)");
  assert.ok(parts[0].text.includes("FIRST-PASS ESTIMATE"));
  assert.ok(parts[0].text.includes("Chicken curry with rice"));
  assert.ok(parts[0].text.includes('fdc_id="2706538"'));
  assert.equal(body.response_format.json_schema.name, "meal_reconciliation");

  assert.equal(out.kcal_likely, 342);
  assert.equal(out.meal_slot, "dinner");
  assert.equal(out.clarifying_question, null);
  resetAll();
});

test("setClientFactory injects a client for the whole module", async () => {
  resetAll();
  const client = fakeClient([completionOf(JSON.stringify(VALID_CALL1))]);
  vision.setClientFactory(() => client);
  const out = await vision.analyzeMeal({ imageDataUrl: IMG });
  assert.equal(out.dish_name, "Chicken curry with rice");
  assert.equal(client.calls.length, 1);
  resetAll();
});

// -----------------------------------------------------------------------------
// 8. Capability detection / graceful degradation
// -----------------------------------------------------------------------------

test("json_schema rejection downgrades to json_object and embeds the schema", async () => {
  resetAll();
  const client = fakeClient([
    httpError(400, "Invalid JSON payload received. Unknown name \"json_schema\" at 'response_format'."),
    completionOf(JSON.stringify(VALID_CALL1)),
  ]);
  const out = await vision.analyzeMeal({ imageDataUrl: IMG, _client: client });

  assert.equal(client.calls.length, 2, "exactly one downgrade retry");
  assert.equal(client.calls[0].response_format.type, "json_schema");
  assert.equal(client.calls[1].response_format.type, "json_object");
  assert.ok(
    client.calls[1].messages[1].content[0].text.includes("MUST conform exactly to this schema"),
    "the schema moves into the prompt on fallback"
  );
  assert.equal(out.dish_name, "Chicken curry with rice");

  const caps = vision.getCapabilities();
  assert.equal(caps.responseFormatMode, "json_object");
  assert.ok(caps.notes.some((n) => n.includes("json_schema REJECTED")));

  // The downgrade is remembered: the next call starts in json_object.
  const client2 = fakeClient([completionOf(JSON.stringify(VALID_CALL1))]);
  await vision.analyzeMeal({ imageDataUrl: IMG, _client: client2 });
  assert.equal(client2.calls[0].response_format.type, "json_object", "downgrade is sticky");
  resetAll();
});

test("extra_body rejection drops media_resolution and is remembered", async () => {
  resetAll();
  const client = fakeClient([
    httpError(400, "Invalid JSON payload received. Unknown name \"media_resolution\"."),
    completionOf(JSON.stringify(VALID_CALL1)),
  ]);
  await vision.analyzeMeal({ imageDataUrl: IMG, _client: client });

  assert.equal(client.calls.length, 2);
  assert.ok(client.calls[0].extra_body, "first attempt carries extras");
  assert.equal(client.calls[1].extra_body, undefined, "second attempt drops them");
  assert.equal(client.calls[1].response_format.type, "json_schema", "schema mode untouched");
  assert.equal(vision.getCapabilities().mediaResolution, false);
  assert.ok(vision.getCapabilities().notes.some((n) => n.includes("extra_body REJECTED")));
  resetAll();
});

test("an unattributable 400 speculatively degrades both knobs, then gives up", async () => {
  resetAll();
  const client = fakeClient([httpError(400, "Bad Request")]);
  await assert.rejects(
    () => vision.analyzeMeal({ imageDataUrl: IMG, _client: client }),
    (e) => e.code === CODES.BAD_REQUEST
  );
  assert.equal(client.calls.length, 3, "json_schema -> json_object -> no extras -> throw");
  assert.equal(client.calls[1].response_format.type, "json_object");
  assert.equal(client.calls[2].extra_body, undefined);
  resetAll();
});

// -----------------------------------------------------------------------------
// 9. Malformed-JSON retry policy: exactly once, and only for JSON
// -----------------------------------------------------------------------------

test("malformed JSON is retried EXACTLY once, and the retry succeeds", async () => {
  resetAll();
  const client = fakeClient([
    completionOf("I'm sorry, I can't determine the calories from this photo."),
    completionOf(JSON.stringify(VALID_CALL1)),
  ]);
  const out = await vision.analyzeMeal({ imageDataUrl: IMG, _client: client });

  assert.equal(client.calls.length, 2);
  const retryText = client.calls[1].messages[1].content[0].text;
  assert.ok(retryText.includes("--- RETRY ---"));
  assert.ok(retryText.includes("was not valid JSON"));
  assert.ok(retryText.includes("I'm sorry"), "the unparseable reply is quoted back");
  assert.equal(client.calls[1].temperature, 0, "the retry drops temperature to 0");
  assert.equal(out.dish_name, "Chicken curry with rice");
  resetAll();
});

test("two malformed replies in a row throw BAD_JSON without a third call", async () => {
  resetAll();
  const client = fakeClient([completionOf("nope"), completionOf("still nope")]);
  await assert.rejects(
    () => vision.analyzeMeal({ imageDataUrl: IMG, _client: client }),
    (e) => {
      assert.equal(e.code, CODES.BAD_JSON);
      assert.ok(e.userMessage.includes("malformed twice"));
      return true;
    }
  );
  assert.equal(client.calls.length, 2, "never a third attempt");
  resetAll();
});

test("a fenced / preambled reply is repaired locally with NO retry call", async () => {
  resetAll();
  const client = fakeClient([
    completionOf("Sure! Here you go:\n```json\n" + JSON.stringify(VALID_CALL1) + ",\n```"),
  ]);
  const out = await vision.analyzeMeal({ imageDataUrl: IMG, _client: client });
  assert.equal(client.calls.length, 1, "the repair path costs zero extra requests");
  assert.equal(out.dish_name, "Chicken curry with rice");
  resetAll();
});

test("a rate limit is NOT retried as if it were malformed JSON", async () => {
  resetAll();
  const client = fakeClient([httpError(429, "RESOURCE_EXHAUSTED: quota exceeded")]);
  await assert.rejects(
    () => vision.analyzeMeal({ imageDataUrl: IMG, _client: client }),
    (e) => e.code === CODES.RATE_LIMITED
  );
  assert.equal(client.calls.length, 1);
  resetAll();
});

test("a 410 Gone is NEVER retried", async () => {
  resetAll();
  const client = fakeClient([httpError(410, "Gone")]);
  await assert.rejects(
    () => vision.analyzeMeal({ imageDataUrl: IMG, _client: client }),
    (e) => e.code === CODES.MODEL_NOT_FOUND
  );
  assert.equal(client.calls.length, 1, "410 is terminal - one call, no retry");
  resetAll();
});

test("a 404 model-not-found is NEVER retried", async () => {
  resetAll();
  const client = fakeClient([
    httpError(404, "models/gemini-9-flash is not found for API version v1beta"),
  ]);
  await assert.rejects(
    () => vision.reconcile({ imageDataUrl: IMG, call1: VALID_CALL1, dbRows: [], _client: client }),
    (e) => e.code === CODES.MODEL_NOT_FOUND
  );
  assert.equal(client.calls.length, 1);
  resetAll();
});

// -----------------------------------------------------------------------------
// 10. Every error branch has its own actionable message
// -----------------------------------------------------------------------------

test("(a) no API key: analyzeMeal fails fast with NO_API_KEY", async () => {
  resetAll();
  await assert.rejects(
    () => vision.analyzeMeal({ imageDataUrl: IMG }),
    (e) => {
      assert.equal(e.code, CODES.NO_API_KEY);
      assert.ok(e.userMessage.includes("GEMINI_API_KEY"));
      assert.ok(e.userMessage.includes("aistudio.google.com/apikey"));
      assert.equal(e.retryable, false);
      return true;
    }
  );
  resetAll();
});

test("(b) 401 and 403 both map to BAD_API_KEY", () => {
  for (const s of [401, 403]) {
    const v = I.classifyError(httpError(s, "API key not valid. Please pass a valid API key."));
    assert.equal(v.code, CODES.BAD_API_KEY, "status " + s);
    assert.ok(v.userMessage.includes("rejected"));
    assert.equal(v.retryable, false);
  }
  // Status-free bodies still classify off the text.
  assert.equal(I.classifyError(new Error("API_KEY_INVALID")).code, CODES.BAD_API_KEY);
});

test("(c) 429 surfaces retry-after when the provider sends it", () => {
  const plain = I.classifyError(httpError(429, "Too Many Requests"));
  assert.equal(plain.code, CODES.RATE_LIMITED);
  assert.equal(plain.retryable, true);
  assert.ok(plain.userMessage.includes("rate limit"));

  const withHeader = I.classifyError(
    httpError(429, "Too Many Requests", new Map([["retry-after", "37"]]))
  );
  assert.equal(withHeader.retryAfterSeconds, 37);
  assert.ok(withHeader.userMessage.includes("37 seconds"));
});

test("(d) model-not-found is detected by status AND by message text", () => {
  const byStatus = I.classifyError(httpError(404, "Not Found"));
  assert.equal(byStatus.code, CODES.MODEL_NOT_FOUND);
  assert.ok(byStatus.userMessage.includes("VISION_MODEL"));

  const byText = I.classifyError(
    new Error("models/gemini-x is not supported for generateContent")
  );
  assert.equal(byText.code, CODES.MODEL_NOT_FOUND);
  assert.equal(I.classifyError(httpError(410, "Gone")).code, CODES.MODEL_NOT_FOUND);
});

test("(e) malformed JSON has its own distinct message", () => {
  const v = I.classifyError(new (vision.VisionError)(CODES.BAD_JSON, {}));
  assert.equal(v.code, CODES.BAD_JSON);
  assert.ok(v.userMessage.includes("malformed"));
});

test("network, 5xx and unknown failures are all distinguishable", () => {
  const net = new Error("Connection error.");
  net.name = "APIConnectionError";
  assert.equal(I.classifyError(net).code, CODES.NETWORK);
  assert.equal(I.classifyError(new Error("fetch failed")).code, CODES.NETWORK);
  assert.equal(I.classifyError(httpError(503, "Service Unavailable")).code, CODES.PROVIDER_ERROR);
  assert.equal(I.classifyError(httpError(503, "x")).retryable, true);
  assert.equal(I.classifyError(new Error("something odd")).code, CODES.PROVIDER_ERROR);
});

test("all nine error codes carry DIFFERENT user messages", () => {
  const msgs = Object.keys(I.USER_MESSAGES).map((k) => I.USER_MESSAGES[k]);
  assert.equal(new Set(msgs).size, msgs.length, "no two codes share a message");
  assert.equal(msgs.length, 9);
  for (const m of msgs) assert.ok(m.length > 40, "messages must be actionable, not terse");
});

test("VisionError serialises for an HTTP response body", () => {
  const v = new (vision.VisionError)(CODES.RATE_LIMITED, { status: 429, retryable: true, retryAfterSeconds: 12 });
  assert.deepEqual(v.toJSON(), {
    error: "RATE_LIMITED",
    message: I.USER_MESSAGES.RATE_LIMITED,
    status: 429,
    retryable: true,
    retryAfterSeconds: 12,
  });
});

test("bad input is rejected before any network call", async () => {
  resetAll();
  const client = fakeClient([completionOf("{}")]);
  for (const bad of [undefined, "", "not-a-data-url", "https://example.com/a.jpg", "data:text/plain;base64,AA"]) {
    await assert.rejects(
      () => vision.analyzeMeal({ imageDataUrl: bad, _client: client }),
      (e) => e.code === CODES.BAD_INPUT
    );
  }
  await assert.rejects(
    () => vision.reconcile({ imageDataUrl: IMG, call1: null, dbRows: [], _client: client }),
    (e) => e.code === CODES.BAD_INPUT
  );
  assert.equal(client.calls.length, 0, "no request is ever sent for bad input");
  resetAll();
});

// -----------------------------------------------------------------------------
// 11. checkModelAvailable()
// -----------------------------------------------------------------------------

test("checkModelAvailable reports NO_API_KEY when unconfigured", async () => {
  resetAll();
  const r = await vision.checkModelAvailable();
  assert.deepEqual(
    { ok: r.ok, configured: r.configured, available: r.available, suggestion: r.suggestion, code: r.code },
    { ok: false, configured: false, available: false, suggestion: null, code: CODES.NO_API_KEY }
  );
  assert.ok(r.message.includes("GEMINI_API_KEY"));
  resetAll();
});

test("checkModelAvailable: configured model present -> ok", async () => {
  resetAll();
  const client = fakeClient([], {
    data: [
      { id: "models/gemini-3.8-flash" },
      { id: "models/gemini-3.5-flash-lite" },
      { id: "models/gemini-embedding-001" },
    ],
  });
  const r = await vision.checkModelAvailable({ _client: client });
  assert.equal(r.ok, true);
  assert.equal(r.available, true);
  assert.equal(r.suggestion, null);
  assert.equal(r.model, "gemini-3.5-flash-lite");
  assert.ok(r.models.includes("gemini-3.5-flash-lite"), "models/ prefix is stripped");
  resetAll();
});

test("checkModelAvailable: retired model -> available:false with a real suggestion", async () => {
  resetAll();
  process.env.VISION_MODEL = "gemini-2.0-flash"; // shut down
  const client = fakeClient([], {
    data: [
      { id: "models/gemini-3.8-flash" },
      { id: "models/gemini-3.5-flash-lite" },
      { id: "models/gemini-3.1-flash-lite-image" },
      { id: "models/gemini-3.1-flash-tts-preview" },
      { id: "models/gemini-embedding-001" },
      { id: "models/veo-3.1-generate-preview" },
    ],
  });
  const r = await vision.checkModelAvailable({ _client: client });
  assert.equal(r.ok, false);
  assert.equal(r.available, false);
  assert.equal(r.suggestion, "gemini-3.5-flash-lite", "prefers a real flash-lite chat model");
  assert.ok(r.message.includes("VISION_MODEL=gemini-3.5-flash-lite"));
  resetAll();
});

test("suggestModel filters out non-chat models entirely", () => {
  assert.equal(
    I.suggestModel(["models/gemini-embedding-001", "models/veo-3.1-generate-preview", "models/gemini-3.5-transcribe"], "x"),
    null
  );
  assert.equal(I.suggestModel(["models/gemini-3.8-flash", "models/gemini-3-pro"], "x"), "gemini-3.8-flash");
  assert.equal(I.suggestModel([], "x"), null);
});

test("checkModelAvailable maps list-endpoint failures to the right codes", async () => {
  resetAll();
  const cases = [
    [httpError(401, "API key not valid"), CODES.BAD_API_KEY],
    [httpError(429, "quota"), CODES.RATE_LIMITED],
    [httpError(500, "boom"), CODES.PROVIDER_ERROR],
  ];
  for (const [err, code] of cases) {
    const r = await vision.checkModelAvailable({ _client: fakeClient([], err) });
    assert.equal(r.ok, false);
    assert.equal(r.code, code);
    assert.equal(r.available, false);
    assert.ok(r.message.length > 20);
  }
  resetAll();
});

test("checkModelAvailable accepts a plain array and an async-iterable page", async () => {
  resetAll();
  const arr = await vision.checkModelAvailable({
    _client: fakeClient([], [{ id: "gemini-3.5-flash-lite" }]),
  });
  assert.equal(arr.available, true);

  const iterable = {
    async *[Symbol.asyncIterator]() {
      yield { id: "models/gemini-3.5-flash-lite" };
    },
  };
  const it = await vision.checkModelAvailable({ _client: fakeClient([], iterable) });
  assert.equal(it.available, true);
  resetAll();
});

// -----------------------------------------------------------------------------
// 12. End-to-end pipeline through fakes
// -----------------------------------------------------------------------------

test("full two-call pipeline: same image both times, db-derived numbers returned", async () => {
  resetAll();
  const seen = [];
  const client = {
    chat: {
      completions: {
        create: async (body) => {
          seen.push(body);
          const isCall2 = body.response_format.type === "json_schema"
            ? body.response_format.json_schema.name === "meal_reconciliation"
            : body.messages[1].content[0].text.includes("FIRST-PASS ESTIMATE");
          return completionOf(JSON.stringify(isCall2 ? VALID_CALL2 : VALID_CALL1));
        },
      },
    },
    models: { list: async () => ({ data: [] }) },
  };

  const call1 = await vision.analyzeMeal({
    imageDataUrl: IMG,
    notes: "takeaway curry",
    localTimeLabel: "7:10 PM - Dinner",
    _client: client,
  });
  const final = await vision.reconcile({
    imageDataUrl: IMG,
    call1: call1,
    dbRows: DB_ROWS_GROUPED,
    mealSlot: "dinner",
    _client: client,
  });

  assert.equal(seen.length, 2);
  assert.equal(
    seen[0].messages[1].content[1].image_url.url,
    seen[1].messages[1].content[1].image_url.url,
    "the identical image is sent to both calls"
  );
  assert.equal(final.kcal_likely, 342);
  assert.equal(final.components[0].chosen_fdc_id, "2706538");
  assert.equal(final.meal_slot, "dinner");
  assert.ok(final.kcal_low < final.kcal_likely && final.kcal_likely < final.kcal_high);
  assert.equal(JSON.parse(JSON.stringify(final)).clarifying_question, null);
  resetAll();
});

test("the returned objects serialise to exactly the contract JSON shape", () => {
  const c1 = JSON.parse(JSON.stringify(I.normaliseCall1(VALID_CALL1, {})));
  const c2 = JSON.parse(JSON.stringify(I.normaliseCall2(VALID_CALL2, { mealSlot: "dinner" })));
  assert.equal(Object.keys(c1).join(","),
    "scale_references,plate_diameter_cm_estimate,dish_name,cuisine,cooking_method,components,added_fat,hidden_ingredients_note,occlusion_risk");
  assert.equal(Object.keys(c2).join(","),
    "reconciliation_notes,components,kcal_low,kcal_likely,kcal_high,protein_g,carb_g,fat_g,meal_slot,overall_confidence,clarifying_question");
  assert.equal(Object.keys(c1).includes("_meta"), false, "_meta must be non-enumerable");
});

// -----------------------------------------------------------------------------
// 13. Regression tests pinning error shapes MEASURED against the live endpoint
//     on 2026-09-02. These are the shapes the docs do not describe.
// -----------------------------------------------------------------------------

test("LIVE-MEASURED: a bad key is 400 INVALID_ARGUMENT, not 401 -> BAD_API_KEY", () => {
  // Exact body from GET https://generativelanguage.googleapis.com/v1beta/openai/models
  const e = httpError(400, "400 Please pass a valid API key");
  e.error = { code: 400, message: "Please pass a valid API key", status: "INVALID_ARGUMENT" };
  const v = I.classifyError(e);
  assert.equal(v.code, CODES.BAD_API_KEY, "must NOT be filed as BAD_REQUEST");
  assert.ok(v.userMessage.includes("GEMINI_API_KEY"));
  assert.equal(v.retryable, false);
});

test("LIVE-MEASURED: a missing auth header is a generic 404 -> BAD_API_KEY, not MODEL_NOT_FOUND", () => {
  const e = httpError(404, "404 Requested entity was not found.");
  e.error = { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" };
  const v = I.classifyError(e);
  assert.equal(v.code, CODES.BAD_API_KEY,
    "telling the user to change VISION_MODEL over a key problem is a wrong answer");

  // A genuinely retired model DOES name the model, and must still be MODEL_NOT_FOUND.
  const gone = httpError(404, "models/gemini-2.0-flash is not found for API version v1beta");
  assert.equal(I.classifyError(gone).code, CODES.MODEL_NOT_FOUND);
});

test("LIVE-MEASURED: /chat/completions wraps its error body in a JSON ARRAY", () => {
  // openai@5.6.0 cannot parse this and reports "400 status code (no body)".
  const e = httpError(400, "400 status code (no body)");
  e.error = undefined;
  e.body = [{ error: { code: 400, message: "Please pass a valid API key", status: "INVALID_ARGUMENT" } }];
  assert.ok(I.errString(e).includes("Please pass a valid API key"), "array bodies must be unwrapped");
  assert.equal(I.classifyError(e).code, CODES.BAD_API_KEY);
});

test("an OPAQUE 400 is disambiguated by probing GET /models", async () => {
  resetAll();
  // The chat endpoint 400s with a body the SDK dropped; models.list can read it.
  const authErr = httpError(400, "400 Please pass a valid API key");
  authErr.error = { code: 400, message: "Please pass a valid API key", status: "INVALID_ARGUMENT" };

  let listCalls = 0;
  const client = {
    chat: { completions: { create: async () => { throw httpError(400, "400 status code (no body)"); } } },
    models: { list: async () => { listCalls += 1; throw authErr; } },
  };

  await assert.rejects(
    () => vision.analyzeMeal({ imageDataUrl: IMG, _client: client }),
    (e) => {
      assert.equal(e.code, CODES.BAD_API_KEY, "opaque 400 resolved to the real cause");
      return true;
    }
  );
  assert.equal(listCalls, 1, "exactly one cheap probe");
  resetAll();
});

test("the probe leaves a genuine bad-request as BAD_REQUEST when the key is fine", async () => {
  resetAll();
  const client = {
    chat: { completions: { create: async () => { throw httpError(400, "400 status code (no body)"); } } },
    models: { list: async () => ({ data: [{ id: "models/gemini-3.5-flash-lite" }] }) },
  };
  await assert.rejects(
    () => vision.analyzeMeal({ imageDataUrl: IMG, _client: client }),
    (e) => e.code === CODES.BAD_REQUEST
  );
  resetAll();
});
