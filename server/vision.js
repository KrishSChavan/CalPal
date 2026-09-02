"use strict";

/**
 * server/vision.js
 * -----------------------------------------------------------------------------
 * Gemini vision client for the calorie analyzer, implementing the agreed
 * two-call pipeline:
 *
 *   Call 1  analyzeMeal()  image (+notes, clock label, plate diameter)
 *                          -> structured component list with gram RANGES
 *   (server/match.js retrieves candidate FNDDS rows for each component)
 *   Call 2  reconcile()    THE SAME IMAGE + Call-1 JSON + retrieved FNDDS rows
 *                          -> final per-component grams / fdc_id / kcal
 *
 * Provider is Google Gemini through its OpenAI-compatibility layer, so the
 * already-installed openai@5.6.0 SDK is reused with only a baseURL swap.
 *   https://ai.google.dev/gemini-api/docs/openai
 *
 * CommonJS only. No build step. No new dependencies.
 * -----------------------------------------------------------------------------
 */

const OpenAI = require("openai");

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Official OpenAI-compat endpoint. Confirmed: ai.google.dev/gemini-api/docs/openai */
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

/**
 * NEVER hardcode a model id at a call site. This is only the fallback when
 * VISION_MODEL is unset. The app already died once because a hardcoded model
 * (openai/gpt-4o-mini on models.github.ai) was retired.
 */
const DEFAULT_VISION_MODEL = "gemini-3.5-flash-lite";

/**
 * Gemini 3 bills a FLAT 1120 tokens per image at MEDIA_RESOLUTION_HIGH.
 * The old "258 tokens per 768x768 tile" rule is a Gemini-2.5-era rule and no
 * longer applies to Gemini 3.
 * https://ai.google.dev/gemini-api/docs/generate-content/media-resolution
 *
 * generationConfig uses the SCREAMING enum form (MEDIA_RESOLUTION_HIGH); the
 * newer Interactions API uses a per-part lowercase "high". The OpenAI-compat
 * layer maps onto generateContent, so the enum form is what we send.
 */
const DEFAULT_MEDIA_RESOLUTION = "MEDIA_RESOLUTION_HIGH";

const REQUEST_TIMEOUT_MS = Number(process.env.VISION_TIMEOUT_MS || 90000);

/** Substrings that mark a model as definitely not a vision chat model. */
const NON_VISION_HINTS = [
  "embedding", "tts", "transcribe", "veo", "imagen", "aqa", "text-bison", "gemma",
];

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Every failure the caller can hit is normalised into one of these codes, each
 * with a DIFFERENT, actionable user-facing message. The route handler is
 * expected to show `err.userMessage` verbatim.
 */
const ERROR_CODES = {
  NO_API_KEY: "NO_API_KEY",
  BAD_API_KEY: "BAD_API_KEY",
  RATE_LIMITED: "RATE_LIMITED",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  BAD_JSON: "BAD_JSON",
  BAD_REQUEST: "BAD_REQUEST",
  NETWORK: "NETWORK",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  BAD_INPUT: "BAD_INPUT",
};

const USER_MESSAGES = {
  NO_API_KEY:
    "Photo analysis is not set up yet. Add GEMINI_API_KEY to your .env file " +
    "(get a free key at https://aistudio.google.com/apikey) and restart the server.",
  BAD_API_KEY:
    "The Gemini API key was rejected. Check GEMINI_API_KEY in .env for typos or " +
    "extra quotes, or issue a new key at https://aistudio.google.com/apikey.",
  RATE_LIMITED:
    "Gemini's free-tier rate limit was hit. Wait a minute and take the photo again. " +
    "Your current limits are shown at https://aistudio.google.com/rate-limit.",
  MODEL_NOT_FOUND:
    "The configured vision model is not available on this API key. Set VISION_MODEL " +
    "in .env to a model your key can use, then restart the server.",
  BAD_JSON:
    "The model's answer came back malformed twice in a row. Retake the photo " +
    "(better light, less clutter) and try again.",
  BAD_REQUEST:
    "Gemini rejected the request. The photo may be too large or in an unsupported " +
    "format - try a JPEG under 4 MB.",
  NETWORK:
    "Could not reach Gemini. Check your internet connection and try again.",
  PROVIDER_ERROR:
    "Gemini had a server-side error. This is on their end - try again in a moment.",
  BAD_INPUT:
    "No usable photo was received. Take or choose a picture and try again.",
};

class VisionError extends Error {
  constructor(code, opts) {
    const options = opts || {};
    const userMessage =
      options.userMessage || USER_MESSAGES[code] || USER_MESSAGES.PROVIDER_ERROR;
    super(options.message || userMessage);
    this.name = "VisionError";
    this.code = code;
    this.userMessage = userMessage;
    this.status = options.status === undefined ? null : options.status;
    this.retryable = options.retryable === undefined ? false : options.retryable;
    this.retryAfterSeconds =
      options.retryAfterSeconds === undefined ? null : options.retryAfterSeconds;
    if (options.cause) this.cause = options.cause;
    if (options.detail) this.detail = options.detail;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.userMessage,
      status: this.status,
      retryable: this.retryable,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}

/** Flatten every place a provider stuffs its error text into one string. */
function errString(err) {
  if (!err) return "";
  const parts = [];
  if (err.message) parts.push(String(err.message));
  if (err.error && err.error.message) parts.push(String(err.error.message));
  if (err.error && err.error.status) parts.push(String(err.error.status));
  if (typeof err.body === "string") parts.push(err.body);
  else if (Array.isArray(err.body)) {
    // Gemini's compat layer wraps /chat/completions errors in a JSON ARRAY,
    // which the OpenAI SDK does not unwrap. Measured live, 2026-09-02.
    for (const b of err.body) {
      if (b && b.error && b.error.message) parts.push(String(b.error.message));
      if (b && b.error && b.error.status) parts.push(String(b.error.status));
    }
  } else if (err.body && err.body.error && err.body.error.message) {
    parts.push(String(err.body.error.message));
  }
  return parts.join(" | ");
}

function retryAfterFrom(err) {
  const h = (err && err.headers) || null;
  if (!h) return null;
  const get =
    typeof h.get === "function" ? (k) => h.get(k) : (k) => h[k] || h[k.toLowerCase()];
  const n = Number(get("retry-after"));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Map anything thrown by the SDK (or by an injected fake) onto a VisionError.
 * Keys off numeric `.status` first so injected fakes need no SDK error classes.
 */
function classifyError(err) {
  if (err instanceof VisionError) return err;

  const status = err && typeof err.status === "number" ? err.status : null;
  const text = errString(err).toLowerCase();

  // (b) Bad key. Checked BEFORE the model check, because the live compat layer
  // reports an invalid key as 400 INVALID_ARGUMENT and a MISSING key as a
  // generic 404 - both of which would otherwise be misfiled. Verified against
  // the live endpoint on 2026-09-02.
  const looksLikeAuthText =
    text.indexOf("api key not valid") !== -1 ||
    text.indexOf("pass a valid api key") !== -1 ||
    text.indexOf("api_key_invalid") !== -1 ||
    text.indexOf("permission denied") !== -1 ||
    (text.indexOf("api key") !== -1 && text.indexOf("invalid_argument") !== -1);

  // A generic "requested entity was not found" with no model named is the
  // signature of an auth header that never arrived, not of a retired model.
  const genericNotFound =
    status === 404 &&
    text.indexOf("requested entity was not found") !== -1 &&
    text.indexOf("model") === -1;

  if (status === 401 || status === 403 || looksLikeAuthText || genericNotFound) {
    return new VisionError(ERROR_CODES.BAD_API_KEY, {
      status: status,
      retryable: false,
      message: errString(err),
      detail: errString(err),
    });
  }

  // (d) Model gone / never existed. NEVER retried.
  if (
    status === 404 ||
    status === 410 ||
    text.indexOf("is not found for api version") !== -1 ||
    text.indexOf("model not found") !== -1 ||
    text.indexOf("is not supported for generatecontent") !== -1 ||
    text.indexOf("unsupported model") !== -1
  ) {
    return new VisionError(ERROR_CODES.MODEL_NOT_FOUND, {
      status: status,
      retryable: false,
      message: errString(err) || "model not found",
      userMessage:
        'The vision model "' + getModelId() + '" is not available on this API key ' +
        "(the provider returned " + (status || "not-found") + "). Run the startup " +
        "model check, then set VISION_MODEL in .env to one of the ids it lists.",
      detail: errString(err),
    });
  }

  // (c) Rate limit.
  if (
    status === 429 ||
    text.indexOf("resource_exhausted") !== -1 ||
    text.indexOf("quota") !== -1
  ) {
    const ra = retryAfterFrom(err);
    return new VisionError(ERROR_CODES.RATE_LIMITED, {
      status: status || 429,
      retryable: true,
      retryAfterSeconds: ra,
      message: errString(err),
      userMessage: ra
        ? "Gemini's free-tier rate limit was hit. Try again in about " + ra + " seconds."
        : USER_MESSAGES.RATE_LIMITED,
      detail: errString(err),
    });
  }

  if (status === 400 || status === 422) {
    return new VisionError(ERROR_CODES.BAD_REQUEST, {
      status: status,
      retryable: false,
      message: errString(err),
      detail: errString(err),
    });
  }

  if (status && status >= 500) {
    return new VisionError(ERROR_CODES.PROVIDER_ERROR, {
      status: status,
      retryable: true,
      message: errString(err),
      detail: errString(err),
    });
  }

  const name = (err && err.name) || "";
  if (
    name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError" ||
    text.indexOf("econnrefused") !== -1 ||
    text.indexOf("enotfound") !== -1 ||
    text.indexOf("etimedout") !== -1 ||
    text.indexOf("connection error") !== -1 ||
    text.indexOf("fetch failed") !== -1 ||
    text.indexOf("network") !== -1
  ) {
    return new VisionError(ERROR_CODES.NETWORK, {
      status: null,
      retryable: true,
      message: errString(err),
      detail: errString(err),
    });
  }

  return new VisionError(ERROR_CODES.PROVIDER_ERROR, {
    status: status,
    retryable: false,
    message: errString(err) || "unknown provider error",
    detail: errString(err),
  });
}

// -----------------------------------------------------------------------------
// Config / client
// -----------------------------------------------------------------------------

function getApiKey() {
  const k = process.env.GEMINI_API_KEY;
  return typeof k === "string" && k.trim() ? k.trim() : null;
}

/** @returns {boolean} whether GEMINI_API_KEY is set. */
function isConfigured() {
  return getApiKey() !== null;
}

function getModelId() {
  const m = process.env.VISION_MODEL;
  return typeof m === "string" && m.trim() ? m.trim() : DEFAULT_VISION_MODEL;
}

/**
 * Model for the reconciliation pass. Gemini free-tier quota is bucketed per
 * project PER MODEL - Google's own 429s name the bucket
 * `GenerateRequestsPerDayPerProjectPerModel-FreeTier` - so pointing Call 2 at
 * a different model draws it from a separate daily pool instead of halving the
 * photos this app can analyze. Defaults to the Call-1 model, i.e. one pool,
 * which is the correct conservative default.
 */
function getReconcileModelId() {
  const m = process.env.RECONCILE_MODEL;
  return typeof m === "string" && m.trim() ? m.trim() : getModelId();
}

function getMediaResolution() {
  const m = process.env.VISION_MEDIA_RESOLUTION;
  return typeof m === "string" && m.trim() ? m.trim() : DEFAULT_MEDIA_RESOLUTION;
}

let _clientFactory = null;
let _memoClient = null;
let _memoKey = null;

/** Test seam: install a factory returning a fake client. Pass null to clear. */
function setClientFactory(fn) {
  _clientFactory = typeof fn === "function" ? fn : null;
  _memoClient = null;
  _memoKey = null;
}

function getClient(injected) {
  if (injected) return injected;
  if (_clientFactory) return _clientFactory();
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new VisionError(ERROR_CODES.NO_API_KEY, { status: null, retryable: false });
  }
  const cacheKey = apiKey + "|" + GEMINI_BASE_URL;
  if (_memoClient && _memoKey === cacheKey) return _memoClient;
  _memoClient = new OpenAI({
    apiKey: apiKey,
    baseURL: GEMINI_BASE_URL,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 0, // we own the retry policy; see runStructured()
  });
  _memoKey = cacheKey;
  return _memoClient;
}

// -----------------------------------------------------------------------------
// Runtime capability detection
//
// Two things about the compat layer are not contractually guaranteed, so we
// probe them for real on the first live call and remember the answer:
//   1. response_format {type:"json_schema"} vs {type:"json_object"}
//   2. whether extra_body.google.media_resolution is accepted or rejected
// Both degrade gracefully; neither costs an extra call unless it actually fails.
// -----------------------------------------------------------------------------

const capabilities = {
  responseFormatMode: "json_schema", // optimistic; can downgrade to json_object
  responseFormatConfirmed: false,
  mediaResolution: true, // optimistic; can downgrade to false
  mediaResolutionConfirmed: false,
  notes: [],
};

function getCapabilities() {
  return {
    responseFormatMode: capabilities.responseFormatMode,
    responseFormatConfirmed: capabilities.responseFormatConfirmed,
    mediaResolution: capabilities.mediaResolution,
    mediaResolutionValue: capabilities.mediaResolution ? getMediaResolution() : null,
    mediaResolutionConfirmed: capabilities.mediaResolutionConfirmed,
    baseURL: GEMINI_BASE_URL,
    model: getModelId(),
    notes: capabilities.notes.slice(),
  };
}

function resetCapabilities() {
  capabilities.responseFormatMode = "json_schema";
  capabilities.responseFormatConfirmed = false;
  capabilities.mediaResolution = true;
  capabilities.mediaResolutionConfirmed = false;
  capabilities.notes = [];
}

function noteCapability(msg) {
  if (capabilities.notes.indexOf(msg) === -1) capabilities.notes.push(msg);
}

const SCHEMA_REJECTION_PATTERNS = [
  "response_format",
  "json_schema",
  "responseschema",
  "response_schema",
  "no such field",
  "invalid json payload",
  'unknown name "schema"',
  "cannot find field",
  "response mime type",
];

function looksLikeSchemaRejection(err) {
  const t = errString(err).toLowerCase();
  if (!t) return false;
  return SCHEMA_REJECTION_PATTERNS.some((p) => t.indexOf(p) !== -1);
}

function looksLikeExtraBodyRejection(err) {
  const t = errString(err).toLowerCase();
  if (!t) return false;
  return (
    t.indexOf("media_resolution") !== -1 ||
    t.indexOf("mediaresolution") !== -1 ||
    t.indexOf("extra_body") !== -1 ||
    (t.indexOf("google") !== -1 && t.indexOf("unknown") !== -1)
  );
}

/**
 * Gemini-specific request extras.
 *
 * Google's own OpenAI-compat page shows TWO different nestings for extra_body
 * on the same page: `extra_body: {google: {...}}` (thinking_config example) and
 * `extra_body: {extra_body: {google: {...}}}` (cached_content example). The
 * compat layer silently ignores parameters it does not recognise, so we send
 * BOTH shapes; whichever the layer reads wins and the other is dropped.
 */
function buildGoogleExtras() {
  const g = { media_resolution: getMediaResolution() };
  return { google: { media_resolution: g.media_resolution }, extra_body: { google: { media_resolution: g.media_resolution } } };
}

// -----------------------------------------------------------------------------
// JSON schemas  (KEY ORDER IS LOAD-BEARING)
//
// "Let Me Speak Freely": constrained JSON decoding degrades reasoning, and the
// model fills keys in the order the schema declares them. So every free-text
// reasoning field comes BEFORE the number it justifies:
//     visible_geometry     -> household_measure -> grams_*
//     reconciliation_notes -> components        -> kcal_*
// Do not alphabetise these objects.
// -----------------------------------------------------------------------------

const COOKING_METHODS = [
  "fried", "deep_fried", "grilled", "roasted", "boiled", "steamed", "raw", "baked", "sauteed",
];
const SCALE_OBJECTS = ["dinner fork", "dinner plate", "smartphone", "hand", "can", "mug"];
const HOUSEHOLD_UNITS = ["cup", "tbsp", "tsp", "oz", "slice", "piece", "fillet", "medium"];
const FAT_TYPES = ["olive_oil", "butter", "none", "unknown"];
const OCCLUSION = ["low", "medium", "high"];
const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"];
const STATES = ["cooked", "raw"];

function call1Schema() {
  return {
    type: "object",
    properties: {
      scale_references: {
        type: "array",
        description: "Everyday objects in frame that you used to fix real-world scale.",
        items: {
          type: "object",
          properties: {
            object: { type: "string", enum: SCALE_OBJECTS },
            assumed_size_cm: { type: "number" },
            confidence: { type: "number" },
          },
          required: ["object", "assumed_size_cm", "confidence"],
        },
      },
      plate_diameter_cm_estimate: { type: "number", nullable: true },
      dish_name: { type: "string" },
      cuisine: { type: "string" },
      cooking_method: { type: "string", enum: COOKING_METHODS },
      components: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            search_terms: { type: "array", items: { type: "string" } },
            state: { type: "string", enum: STATES },
            visible_geometry: {
              type: "string",
              description:
                "REASON FIRST: how you judged this item's size, explicitly naming a scale_reference.",
            },
            household_measure: {
              type: "object",
              properties: {
                amount: { type: "number" },
                unit: { type: "string", enum: HOUSEHOLD_UNITS },
              },
              required: ["amount", "unit"],
            },
            grams_low: { type: "number" },
            grams_likely: { type: "number" },
            grams_high: { type: "number" },
            edible_fraction: { type: "number" },
            confidence: { type: "number" },
          },
          required: [
            "name", "search_terms", "state", "visible_geometry", "household_measure",
            "grams_low", "grams_likely", "grams_high", "edible_fraction", "confidence",
          ],
        },
      },
      added_fat: {
        type: "object",
        properties: {
          type: { type: "string", enum: FAT_TYPES },
          grams_likely: { type: "number" },
        },
        required: ["type", "grams_likely"],
      },
      hidden_ingredients_note: { type: "string" },
      occlusion_risk: { type: "string", enum: OCCLUSION },
    },
    required: [
      "scale_references", "plate_diameter_cm_estimate", "dish_name", "cuisine",
      "cooking_method", "components", "added_fat", "hidden_ingredients_note",
      "occlusion_risk",
    ],
  };
}

function call2Schema() {
  return {
    type: "object",
    properties: {
      reconciliation_notes: {
        type: "string",
        description:
          "REASON FIRST: where the photo disagrees with the Call-1 estimate or with the FNDDS rows, and what you changed.",
      },
      components: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            chosen_fdc_id: { type: "string", nullable: true },
            grams_final: { type: "number" },
            kcal: { type: "number" },
          },
          required: ["name", "chosen_fdc_id", "grams_final", "kcal"],
        },
      },
      kcal_low: { type: "number" },
      kcal_likely: { type: "number" },
      kcal_high: { type: "number" },
      protein_g: { type: "number" },
      carb_g: { type: "number" },
      fat_g: { type: "number" },
      meal_slot: { type: "string", enum: MEAL_SLOTS },
      overall_confidence: { type: "number" },
      clarifying_question: { type: "string", nullable: true },
    },
    required: [
      "reconciliation_notes", "components", "kcal_low", "kcal_likely", "kcal_high",
      "protein_g", "carb_g", "fat_g", "meal_slot", "overall_confidence",
      "clarifying_question",
    ],
  };
}

function buildResponseFormat(name, schema, mode) {
  if (mode === "json_object") return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: { name: name, strict: true, schema: schema },
  };
}

// -----------------------------------------------------------------------------
// Prompts
// -----------------------------------------------------------------------------

const UNDERESTIMATION_WARNING =
  "CALIBRATION - READ THIS BEFORE ESTIMATING ANY GRAM WEIGHT.\n" +
  "Vision models estimate food portions with roughly 25-40% MAPE, and the error is " +
  "not symmetric: it is systematic UNDER-estimation, and it gets worse as the true " +
  "portion gets larger. Your untrained first instinct for a gram weight is too low. " +
  "Counteract it deliberately:\n" +
  "  - Form your naive gram guess, then revise it UPWARD before writing it down. " +
  "For anything that looks like a large or generous serving, revise it upward more.\n" +
  "  - Food has depth. A plate photographed from above hides height; a mound of rice " +
  "is far heavier than its footprint suggests.\n" +
  "  - Restaurant and home-plated portions are routinely 1.5-2x a reference serving.\n" +
  "  - grams_low..grams_high must be a genuine interval you believe contains the " +
  "truth, not decoration around grams_likely. If you are unsure, widen it.";

const SCALE_GUIDANCE =
  "SCALE. You cannot judge grams without a size reference. Find one and record it in " +
  "scale_references before you size anything:\n" +
  "  - dinner fork ~18-19 cm long\n" +
  "  - dinner plate ~26-28 cm across (a salad/side plate is ~20 cm)\n" +
  "  - smartphone ~14-16 cm long\n" +
  "  - adult palm (no fingers) ~9-10 cm; a closed fist is about 1 cup of volume\n" +
  "  - standard drink can 12 oz, ~12.2 cm tall, ~6.6 cm across\n" +
  "  - coffee mug ~9 cm tall, ~8 cm across, ~350 ml full\n" +
  "In visible_geometry, name the reference you used and the comparison you made " +
  '("the chicken breast spans about 1.2 fork-lengths across the plate"). ' +
  "If no reference is present, say so and widen every gram range.";

const CALL1_SYSTEM =
  "You are a dietetics-trained food photo analyst. You decompose a meal photograph " +
  "into weighable components so a nutrient database can be queried. You do not report " +
  "calories - a database does that downstream. Your one job is an honest, well-scaled " +
  "component list.\n\n" +
  SCALE_GUIDANCE + "\n\n" +
  UNDERESTIMATION_WARNING + "\n\n" +
  "RULES.\n" +
  '  - Split the meal into components that can each be looked up separately ("grilled ' +
  'chicken thigh", "white rice", "steamed broccoli"), not into a single dish blob - ' +
  "unless it genuinely is one indivisible mixed dish (biryani, lasagna, stew), in " +
  "which case one component is correct.\n" +
  "  - search_terms: give exactly three, ordered most-specific to most-generic, in " +
  'plain USDA-style American English ("chicken curry", not "butter chicken"; ' +
  '"eggplant", not "aubergine"; "shrimp", not "prawn"; "cilantro", not "coriander"). ' +
  "Include the cooking method in at least one term when it is visible.\n" +
  '  - state: "cooked" or "raw" - grams must refer to the food AS SHOWN, in that state.\n' +
  "  - edible_fraction: 1.0 for anything already edible; below 1.0 only when bone, " +
  "shell, rind, pit or peel is included in your gram figure.\n" +
  "  - added_fat: cooking oil and butter are usually invisible and are the single " +
  "biggest source of error. Vegetables cooked with fat run 60-77 kcal/100 g against " +
  "28-41 kcal/100 g without. Judge from sheen, browning, pooling and cuisine, and say " +
  "what you inferred in hidden_ingredients_note.\n" +
  "  - hidden_ingredients_note: dressings, sauces, sugar, cream, glaze, breading - " +
  "anything real you cannot see but the dish almost certainly contains.\n" +
  '  - occlusion_risk: "high" when food is stacked, in an opaque bowl, or partly out ' +
  "of frame, so the visible surface understates the amount.\n" +
  "  - DO NOT infer which meal this is. Breakfast/lunch/dinner/snack is the user's own " +
  "intent, taken from their clock, and is not a property of the food. The time label " +
  "below is context for portion size only.\n\n" +
  "Return ONE JSON object and nothing else. No prose, no markdown fence. Answer the " +
  "keys in the exact order the schema gives them: every explanation field comes before " +
  "the number it justifies, and you must actually write the explanation first and let " +
  "it drive the number.";

const CALL2_SYSTEM =
  "You are reconciling a first-pass photo estimate against real USDA FNDDS database " +
  "rows. You are looking at THE SAME PHOTOGRAPH again - use it. Do not do arithmetic " +
  "on the list alone; re-checking the numbers against the actual image is measurably " +
  "more accurate than reasoning from text (53.3 kcal MAE with the image vs 66.5 " +
  "without).\n\n" +
  "YOUR TASKS, in order.\n" +
  "  1. For each component, pick the ONE candidate FNDDS row that truly matches what " +
  "is in the picture and put its fdc_id in chosen_fdc_id. Match on the food AND on the " +
  'cooking method and added fat - "broccoli, cooked with butter" and "broccoli, ' +
  'cooked, no added fat" differ by more than 2x. If no candidate row is genuinely that ' +
  "food, set chosen_fdc_id to null rather than forcing a wrong match, and say so in " +
  "reconciliation_notes.\n" +
  "  2. Re-examine the photo and settle grams_final. The Call-1 range is a prior, not " +
  'an answer. Where a row carries a household portion ("1 cup cooked = 163 g"), prefer ' +
  "a gram figure consistent with a sensible count of those portions.\n" +
  "  3. kcal per component = row kcal_per_100g * grams_final / 100. The rows are PER " +
  "100 GRAMS, not per portion. Getting this wrong under-reports by about 2x.\n" +
  "  4. kcal_likely is the sum of the component kcal. kcal_low and kcal_high must " +
  "follow from the Call-1 gram ranges, so kcal_low < kcal_likely < kcal_high with a " +
  "real, honest spread. Do not collapse the interval to look confident.\n\n" +
  UNDERESTIMATION_WARNING + "\n\n" +
  "  - meal_slot: the caller already determined this from the user's clock and passes " +
  "it in. Echo it back unchanged. Override it only if the photo makes it flatly " +
  "impossible, and then explain why in reconciliation_notes. Time of day does not " +
  "determine meal type.\n" +
  "  - clarifying_question: AT MOST ONE, and only if a single answer would " +
  'meaningfully move the calorie total ("Was the chicken skin eaten?"). A list of ' +
  "questions makes people abandon the app. If nothing important is unresolved, set it " +
  "to null. Never ask more than one thing.\n" +
  "  - overall_confidence: 0.0-1.0. Be honest. Heavy occlusion, no scale reference, or " +
  "a forced database match all mean low confidence.\n\n" +
  "Return ONE JSON object and nothing else. Answer the keys in schema order: " +
  "reconciliation_notes is FIRST because it must be written before the numbers, and it " +
  "must actually drive them.";

function schemaHintBlock(schema) {
  return (
    "The JSON object MUST conform exactly to this schema, with keys in this exact " +
    "order:\n" + JSON.stringify(schema, null, 2)
  );
}

function safeText(v, max) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  if (!s) return "";
  const cap = max || 2000;
  return s.length > cap ? s.slice(0, cap) + "..." : s;
}

function buildCall1UserText(input, mode) {
  const notes = safeText(input.notes, 1200);
  const timeLabel = safeText(input.localTimeLabel, 120);
  const plate = num(input.plateDiameterCm, null);
  const lines = [];

  lines.push("Analyse this meal photograph.");
  lines.push("");
  lines.push(
    "Local time label (context for portion size ONLY - do NOT infer meal type from it): " +
      (timeLabel || "not provided")
  );
  lines.push("User notes about the food: " + (notes || "none provided"));

  if (Number.isFinite(plate) && plate > 0) {
    lines.push(
      "MEASURED plate diameter: " + plate + " cm. This is a real measurement supplied " +
      "by the user - trust it over your own visual estimate, use it as the primary " +
      "scale reference for every component, and copy it into plate_diameter_cm_estimate."
    );
  } else {
    lines.push(
      "Plate diameter: not measured. Estimate it from the scale references you can " +
      "find and put your estimate in plate_diameter_cm_estimate, or null if there is " +
      "no plate."
    );
  }

  lines.push("");
  if (mode === "json_object") {
    lines.push(schemaHintBlock(call1Schema()));
    lines.push("");
  }
  lines.push("Respond with the JSON object only.");
  return lines.join("\n");
}

/** Accepts both the verbose FDC shape and the compact fndds-lite shape. */
function normaliseDbRow(row) {
  if (!row || typeof row !== "object") return null;

  const id =
    row.fdc_id != null ? row.fdc_id :
    row.fdcId != null ? row.fdcId :
    row.foodCode != null ? row.foodCode :
    row.c != null ? row.c :
    row.id != null ? row.id : null;

  const desc = row.description || row.d || row.name || "";
  const cat = row.wweiaCategory || row.category || row.cat || "";
  const kcal = num(
    row.kcal_per_100g != null ? row.kcal_per_100g : (row.kcal != null ? row.kcal : row.k),
    null
  );
  const protein = num(row.protein != null ? row.protein : row.p, null);
  const fat = num(row.fat != null ? row.fat : row.f, null);
  const carb = num(row.carb != null ? row.carb : row.cb, null);

  const portionsRaw = row.portions || row.po || [];
  const portions = Array.isArray(portionsRaw)
    ? portionsRaw
        .map((p) => {
          if (Array.isArray(p)) return { desc: String(p[0]), grams: num(p[1], 0) };
          if (p && typeof p === "object") {
            return {
              desc: String(p.desc || p.portionDescription || ""),
              grams: num(p.grams != null ? p.grams : p.gramWeight, 0),
            };
          }
          return null;
        })
        .filter(Boolean)
    : [];

  if (id === null && !desc) return null;

  return {
    fdc_id: id === null ? null : String(id),
    description: String(desc),
    category: String(cat),
    kcal_per_100g: kcal,
    protein_g_per_100g: protein,
    fat_g_per_100g: fat,
    carb_g_per_100g: carb,
    portions: portions,
  };
}

function fmtNum(v) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? "?" : String(v);
}

/**
 * dbRows may arrive as a flat array of rows, as
 * [{component:"rice", candidates:[row,...]}, ...], or as {rice:[row,...]}.
 * All three are formatted the same way: grouped by component, ids quoted,
 * PER 100 G shouted (the single most expensive mistake in this pipeline).
 */
function formatDbRows(dbRows) {
  const groups = [];

  if (Array.isArray(dbRows) && dbRows.length) {
    const looksGrouped =
      dbRows.length > 0 &&
      dbRows.every(
        (g) =>
          g && typeof g === "object" &&
          (Array.isArray(g.candidates) || Array.isArray(g.rows) || Array.isArray(g.matches))
      );
    if (looksGrouped) {
      for (const g of dbRows) {
        const rows = (g.candidates || g.rows || g.matches || [])
          .map(normaliseDbRow)
          .filter(Boolean);
        groups.push({
          component: safeText(g.component || g.name || g.query, 120) || "(unnamed)",
          rows: rows,
          belowThreshold: g.candidates_below_threshold === true,
        });
      }
    } else {
      groups.push({
        component: "all components",
        rows: dbRows.map(normaliseDbRow).filter(Boolean),
      });
    }
  } else if (dbRows && typeof dbRows === "object") {
    for (const key of Object.keys(dbRows)) {
      const rows = (Array.isArray(dbRows[key]) ? dbRows[key] : [])
        .map(normaliseDbRow)
        .filter(Boolean);
      groups.push({ component: safeText(key, 120), rows: rows });
    }
  }

  const out = [];
  let total = 0;

  for (const g of groups) {
    out.push("### candidates for component: " + g.component);
    if (!g.rows.length) {
      out.push(
        "  (no database row scored above the match floor - this component has NO " +
        "candidate. Set chosen_fdc_id to null for it, estimate its kcal from the " +
        "closest analogue you know, and say so in reconciliation_notes.)"
      );
      continue;
    }
    if (g.belowThreshold) {
      /* The matcher rejected all of these as too weak. They are shown anyway
         because a rejected candidate still carries information the model can
         judge — but it must not read them as confirmed matches. */
      out.push(
        "  (candidates_below_threshold: NOTHING here scored above the match floor. " +
        "These are weak guesses, NOT confirmed matches. Accept one only if it is " +
        "genuinely the same food; otherwise set chosen_fdc_id to null and estimate " +
        "the kcal yourself.)"
      );
    }
    for (const r of g.rows) {
      total += 1;
      const p = r.portions.length
        ? r.portions.map((x) => x.desc + " = " + x.grams + " g").join("; ")
        : "no household portions listed";
      out.push(
        '  - fdc_id="' + (r.fdc_id === null ? "null" : r.fdc_id) + '" | ' + r.description +
        (r.category ? " [" + r.category + "]" : "") +
        " | PER 100 G: " +
        (r.kcal_per_100g === null
          ? "kcal MISSING - do not use this row"
          : r.kcal_per_100g + " kcal") +
        ", protein " + fmtNum(r.protein_g_per_100g) + " g" +
        ", fat " + fmtNum(r.fat_g_per_100g) + " g" +
        ", carb " + fmtNum(r.carb_g_per_100g) + " g" +
        " | portions: " + p
      );
    }
  }

  if (!out.length) {
    return { text: "(the matcher returned no database rows at all)", count: 0 };
  }
  return { text: out.join("\n"), count: total };
}

function buildCall2UserText(input, mode) {
  const lines = [];
  const slot = normaliseSlot(input.mealSlot, null);

  lines.push(
    "Reconcile the first-pass estimate against the retrieved database rows, using the " +
    "SAME photograph attached to this message."
  );
  lines.push("");
  lines.push("--- FIRST-PASS ESTIMATE (Call 1 output) ---");
  lines.push(JSON.stringify(input.call1, null, 2));
  lines.push("");

  const rows = formatDbRows(input.dbRows);
  lines.push(
    "--- RETRIEVED USDA FNDDS CANDIDATE ROWS (" + rows.count +
    " rows). ALL NUTRIENT VALUES ARE PER 100 GRAMS. ---"
  );
  lines.push(rows.text);
  lines.push("");

  lines.push("--- MEAL SLOT (already decided from the user's clock; echo it back) ---");
  lines.push(
    "meal_slot = " +
      (slot || "unknown - pick the most plausible of breakfast/lunch/dinner/snack")
  );
  if (safeText(input.localTimeLabel, 120)) {
    lines.push("(the clock label it came from: " + safeText(input.localTimeLabel, 120) + ")");
  }

  if (safeText(input.notes, 1200)) {
    lines.push("");
    lines.push("--- USER NOTES ---");
    lines.push(safeText(input.notes, 1200));
  }

  lines.push("");
  if (mode === "json_object") {
    lines.push(schemaHintBlock(call2Schema()));
    lines.push("");
  }
  lines.push("Respond with the JSON object only.");
  return lines.join("\n");
}

function buildMessages(systemPrompt, userText, imageDataUrl) {
  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ];
}

// -----------------------------------------------------------------------------
// JSON extraction + repair
// -----------------------------------------------------------------------------

function tryParse(s) {
  if (typeof s !== "string" || !s.trim()) return undefined;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : undefined;
  } catch (_) {
    return undefined;
  }
}

/** Conservative repairs: strip fences, drop trailing commas, close what's open. */
function repairJson(s) {
  if (typeof s !== "string") return "";
  let out = s.trim();
  out = out.replace(/^```(?:json|JSON)?/, "").replace(/```$/, "").trim();
  out = out.replace(/,(\s*[}\]])/g, "$1"); // trailing commas

  let inStr = false;
  let esc = false;
  const stack = [];
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, "");
  while (stack.length) {
    const open = stack.pop();
    out += open === "{" ? "}" : "]";
  }
  return out;
}

/**
 * Models wrap JSON in fences, prepend "Here is the JSON:", and leave trailing
 * commas. Recover from all of that WITHOUT a network round-trip; only if this
 * fails do we spend the single permitted retry.
 */
function extractJson(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new VisionError(ERROR_CODES.BAD_JSON, {
      message: "empty completion body",
      retryable: true,
    });
  }

  const raw = text.trim();
  const candidates = [raw];

  const fence = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) candidates.push(fence[1].trim());

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
  if (first !== -1) candidates.push(raw.slice(first)); // truncated tail

  for (const c of candidates) {
    const parsed = tryParse(c);
    if (parsed !== undefined) return parsed;
    const repaired = tryParse(repairJson(c));
    if (repaired !== undefined) return repaired;
  }

  throw new VisionError(ERROR_CODES.BAD_JSON, {
    message: "could not parse JSON from completion",
    retryable: true,
    detail: raw.slice(0, 400),
  });
}

// -----------------------------------------------------------------------------
// Normalisation - guarantees the exact contract shape AND key order regardless
// of what the model actually emitted. This is the real schema enforcement.
// -----------------------------------------------------------------------------

function num(v, dflt) {
  if (v === null || v === undefined || v === "") return dflt;
  const n = typeof v === "string" ? Number(v.replace(/[^0-9eE+.\-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Pure 0..1 clamp. No percent guessing - for ratios such as edible_fraction. */
function clamp01(v, dflt) {
  const n = num(v, dflt);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(1, Math.max(0, n));
}

/**
 * Confidence only. Models routinely answer 85 when the schema wants 0.85, so
 * rescale that ONE case. Deliberately NOT applied to edible_fraction, where a
 * bogus 2 must clamp to 1 rather than silently become 0.02.
 */
function clampConfidence(v, dflt) {
  let n = num(v, dflt);
  if (!Number.isFinite(n)) return dflt;
  if (n > 1 && n <= 100) n = n / 100;
  return Math.min(1, Math.max(0, n));
}

function str(v, dflt) {
  if (v === null || v === undefined) return dflt;
  const s = String(v).trim();
  return s || dflt;
}

function oneOf(v, allowed, dflt) {
  const s = String(v === null || v === undefined ? "" : v)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (allowed.indexOf(s) !== -1) return s;
  const spaced = s.replace(/_/g, " ");
  if (allowed.indexOf(spaced) !== -1) return spaced;
  return dflt;
}

function normaliseSlot(v, dflt) {
  return oneOf(v, MEAL_SLOTS, dflt);
}

function normaliseCall1(raw, input) {
  const src = raw && typeof raw === "object" ? raw : {};
  const suppliedPlate = num(input && input.plateDiameterCm, null);

  const scale = (Array.isArray(src.scale_references) ? src.scale_references : [])
    .map((r) => {
      const o = r && typeof r === "object" ? r : {};
      return {
        object: oneOf(o.object, SCALE_OBJECTS, str(o.object, "hand")),
        assumed_size_cm: Math.max(0, num(o.assumed_size_cm, 0)),
        confidence: clampConfidence(o.confidence, 0.5),
      };
    })
    .slice(0, 8);

  const components = (Array.isArray(src.components) ? src.components : []).map((c) => {
    const o = c && typeof c === "object" ? c : {};

    let low = Math.max(0, num(o.grams_low, 0));
    let likely = Math.max(0, num(o.grams_likely, 0));
    let high = Math.max(0, num(o.grams_high, 0));
    if (likely === 0 && (low || high)) likely = high ? (low + high) / 2 : low;
    if (low === 0 && likely) low = likely;
    if (high === 0 && likely) high = likely;
    const sorted = [low, likely, high].sort((a, b) => a - b);
    low = sorted[0];
    likely = sorted[1];
    high = sorted[2];

    const name = str(o.name, "unidentified item");
    const terms = (Array.isArray(o.search_terms) ? o.search_terms : [])
      .map((t) => str(t, ""))
      .filter(Boolean)
      .slice(0, 5);
    if (!terms.length) terms.push(name);

    const hm =
      o.household_measure && typeof o.household_measure === "object"
        ? o.household_measure
        : {};

    return {
      name: name,
      search_terms: terms,
      state: oneOf(o.state, STATES, "cooked"),
      visible_geometry: str(o.visible_geometry, ""),
      household_measure: {
        amount: Math.max(0, num(hm.amount, 0)),
        unit: oneOf(hm.unit, HOUSEHOLD_UNITS, "piece"),
      },
      grams_low: low,
      grams_likely: likely,
      grams_high: high,
      edible_fraction: clamp01(o.edible_fraction, 1),
      confidence: clampConfidence(o.confidence, 0.5),
    };
  });

  const fatRaw = src.added_fat && typeof src.added_fat === "object" ? src.added_fat : {};

  const modelPlate = num(src.plate_diameter_cm_estimate, null);
  const plate =
    Number.isFinite(suppliedPlate) && suppliedPlate > 0
      ? suppliedPlate
      : modelPlate === null
        ? null
        : Math.max(0, modelPlate);

  // KEY ORDER IS THE CONTRACT.
  return {
    scale_references: scale,
    plate_diameter_cm_estimate: plate,
    dish_name: str(src.dish_name, "unidentified meal"),
    cuisine: str(src.cuisine, "unknown"),
    cooking_method: oneOf(src.cooking_method, COOKING_METHODS, "baked"),
    components: components,
    added_fat: {
      type: oneOf(fatRaw.type, FAT_TYPES, "unknown"),
      grams_likely: Math.max(0, num(fatRaw.grams_likely, 0)),
    },
    hidden_ingredients_note: str(src.hidden_ingredients_note, ""),
    occlusion_risk: oneOf(src.occlusion_risk, OCCLUSION, "medium"),
  };
}

function normaliseCall2(raw, input) {
  const src = raw && typeof raw === "object" ? raw : {};
  const fallbackSlot = normaliseSlot(input && input.mealSlot, "snack");

  const components = (Array.isArray(src.components) ? src.components : []).map((c) => {
    const o = c && typeof c === "object" ? c : {};
    let id = o.chosen_fdc_id;
    if (id === undefined || id === null || id === "" || id === "null") id = null;
    else id = String(id);
    return {
      name: str(o.name, "unidentified item"),
      chosen_fdc_id: id,
      grams_final: Math.max(0, num(o.grams_final, 0)),
      kcal: Math.max(0, num(o.kcal, 0)),
    };
  });

  const sumKcal = components.reduce((a, c) => a + c.kcal, 0);
  let likely = Math.max(0, num(src.kcal_likely, sumKcal));
  let low = Math.max(0, num(src.kcal_low, likely));
  let high = Math.max(0, num(src.kcal_high, likely));
  const s = [low, likely, high].sort((a, b) => a - b);
  low = s[0];
  likely = s[1];
  high = s[2];

  // At most ONE clarifying question, ever.
  let q = src.clarifying_question;
  if (Array.isArray(q)) q = q.length ? q[0] : null;
  q = str(q, null);
  if (q && /^(null|none|n\/a|no question|no)$/i.test(q)) q = null;
  if (q) {
    const parts = q.split(/(?<=\?)\s+/).filter(Boolean);
    if (parts.length > 1) q = parts[0].trim();
  }

  // KEY ORDER IS THE CONTRACT.
  return {
    reconciliation_notes: str(src.reconciliation_notes, ""),
    components: components,
    kcal_low: low,
    kcal_likely: likely,
    kcal_high: high,
    protein_g: Math.max(0, num(src.protein_g, 0)),
    carb_g: Math.max(0, num(src.carb_g, 0)),
    fat_g: Math.max(0, num(src.fat_g, 0)),
    meal_slot: normaliseSlot(src.meal_slot, fallbackSlot),
    overall_confidence: clampConfidence(src.overall_confidence, 0.5),
    clarifying_question: q,
  };
}

// -----------------------------------------------------------------------------
// Core request runner
// -----------------------------------------------------------------------------

function assertImage(imageDataUrl) {
  if (
    typeof imageDataUrl !== "string" ||
    !/^data:image\/[a-z0-9.+-]+;base64,/i.test(imageDataUrl.trim())
  ) {
    throw new VisionError(ERROR_CODES.BAD_INPUT, {
      message: "imageDataUrl must be a data:image/<type>;base64,<data> URL",
      retryable: false,
    });
  }
  return imageDataUrl.trim();
}

function readContent(completion) {
  if (!completion || !Array.isArray(completion.choices) || !completion.choices.length) {
    throw new VisionError(ERROR_CODES.BAD_JSON, {
      message: "provider returned no choices",
      retryable: true,
    });
  }
  const msg = completion.choices[0].message || {};
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
  }
  throw new VisionError(ERROR_CODES.BAD_JSON, {
    message: "provider returned no message content",
    retryable: true,
  });
}

/**
 * One provider call, with CAPABILITY downgrades (which are not retries of a
 * working call):
 *   json_schema rejected -> json_object + schema-in-prompt, remembered
 *   extra_body rejected  -> extras dropped, remembered
 * Each downgrade is attempted at most once per call. 404/410 is never retried.
 */
async function callOnce(client, opts) {
  let mode = capabilities.responseFormatMode;
  let useExtras = capabilities.mediaResolution;
  let schemaTried = false;
  let extrasTried = false;

  for (;;) {
    const body = {
      model: opts.model || getModelId(),
      messages: buildMessages(opts.systemPrompt, opts.buildUserText(mode), opts.imageDataUrl),
      response_format: buildResponseFormat(opts.schemaName, opts.schema, mode),
      temperature: opts.temperature,
    };
    if (useExtras) body.extra_body = buildGoogleExtras();

    try {
      const completion = await client.chat.completions.create(body);

      // The call worked: lock in whatever combination succeeded.
      capabilities.responseFormatMode = mode;
      capabilities.responseFormatConfirmed = true;
      capabilities.mediaResolution = useExtras;
      capabilities.mediaResolutionConfirmed = true;
      noteCapability("response_format=" + mode + " accepted by " + GEMINI_BASE_URL);
      noteCapability(
        useExtras
          ? "extra_body.google.media_resolution=" + getMediaResolution() + " accepted"
          : "extra_body rejected by provider - media_resolution not sent"
      );
      return { completion: completion, mode: mode };
    } catch (err) {
      const v = classifyError(err);

      // 404/410 are terminal: the model is gone. NEVER retry.
      if (v.code === ERROR_CODES.MODEL_NOT_FOUND) throw v;

      if (v.code === ERROR_CODES.BAD_REQUEST) {
        // Attribute to extra_body FIRST. Its signature is specific, whereas the
        // schema signature includes generic strings ("invalid json payload")
        // that a media_resolution rejection also carries.
        if (!extrasTried && useExtras && looksLikeExtraBodyRejection(err)) {
          extrasTried = true;
          useExtras = false;
          capabilities.mediaResolution = false;
          capabilities.mediaResolutionConfirmed = true;
          noteCapability(
            "extra_body REJECTED (" + errString(err).slice(0, 160) +
            ") - media_resolution dropped"
          );
          continue;
        }
        if (!schemaTried && mode === "json_schema" && looksLikeSchemaRejection(err)) {
          schemaTried = true;
          mode = "json_object";
          capabilities.responseFormatMode = "json_object";
          capabilities.responseFormatConfirmed = true;
          noteCapability(
            "json_schema REJECTED (" + errString(err).slice(0, 160) +
            ") - fell back to json_object with the schema embedded in the prompt"
          );
          continue;
        }
        // A 400 we cannot attribute: try the two safest downgrades once each
        // before giving up, since the compat layer's 400 bodies are terse.
        if (!schemaTried && mode === "json_schema") {
          schemaTried = true;
          mode = "json_object";
          noteCapability("unattributed 400 - speculatively downgraded response_format to json_object");
          continue;
        }
        if (!extrasTried && useExtras) {
          extrasTried = true;
          useExtras = false;
          noteCapability("unattributed 400 - speculatively dropped extra_body");
          continue;
        }
        // Still a 400 and we cannot read why: Gemini's compat layer wraps
        // /chat/completions errors in a JSON array the SDK drops on the floor,
        // so a bad API key is indistinguishable from a bad photo here. GET
        // /models does return a readable body - spend one cheap request to say
        // something true to the user.
        throw await disambiguate400(client, v);
      }
      throw v;
    }
  }
}

/**
 * Resolve an unreadable 400 by probing GET /models, whose error body the SDK
 * can parse. Returns a better-attributed VisionError, or the original.
 */
async function disambiguate400(client, original) {
  try {
    await client.models.list();
    return original; // the key is fine; the request body really was bad
  } catch (probeErr) {
    const p = classifyError(probeErr);
    if (
      p.code === ERROR_CODES.BAD_API_KEY ||
      p.code === ERROR_CODES.RATE_LIMITED ||
      p.code === ERROR_CODES.MODEL_NOT_FOUND
    ) {
      return p;
    }
    return original;
  }
}

/**
 * callOnce + JSON extraction, with EXACTLY ONE retry and only for malformed
 * JSON. Rate limits, auth failures and 404/410 are never retried here.
 */
async function runStructured(client, opts) {
  let lastBadJson = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const runOpts =
      attempt === 0
        ? opts
        : Object.assign({}, opts, {
            temperature: 0,
            buildUserText: (mode) =>
              opts.buildUserText(mode) +
              "\n\n--- RETRY ---\nYour previous reply was not valid JSON and could not " +
              "be parsed. Reply with ONE syntactically valid JSON object and NOTHING " +
              "else: no prose, no markdown fence, no trailing commas, all strings " +
              "quoted, every brace closed." +
              (lastBadJson
                ? "\nThe unparseable reply began: " +
                  JSON.stringify(String(lastBadJson).slice(0, 300))
                : ""),
          });

    const res = await callOnce(client, runOpts);
    let text = null;
    try {
      text = readContent(res.completion);
      return {
        data: extractJson(text),
        mode: res.mode,
        attempts: attempt + 1,
        raw: text,
      };
    } catch (err) {
      const v = classifyError(err);
      if (v.code !== ERROR_CODES.BAD_JSON) throw v;
      lastBadJson = text;
      if (attempt === 1) throw v; // one retry, then stop
    }
  }

  throw new VisionError(ERROR_CODES.BAD_JSON, {});
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * CALL 1 - decompose the photo into weighable components with gram ranges.
 * @param {object} p
 * @param {string} p.imageDataUrl      data:image/jpeg;base64,...
 * @param {string} [p.notes]           free text from the user
 * @param {string} [p.localTimeLabel]  e.g. "07:43 AM - Breakfast"
 * @param {number} [p.plateDiameterCm] measured plate diameter, if known
 * @param {object} [p._client]         test seam
 * @returns {Promise<object>} the Call-1 contract object
 */
async function analyzeMeal(p) {
  const input = p || {};
  const imageDataUrl = assertImage(input.imageDataUrl);
  const client = getClient(input._client);

  const result = await runStructured(client, {
    schemaName: "meal_components",
    schema: call1Schema(),
    systemPrompt: CALL1_SYSTEM,
    imageDataUrl: imageDataUrl,
    temperature: 0.2,
    buildUserText: (mode) => buildCall1UserText(input, mode),
  });

  const out = normaliseCall1(result.data, input);
  Object.defineProperty(out, "_meta", {
    enumerable: false,
    value: {
      model: getModelId(),
      responseFormatMode: result.mode,
      attempts: result.attempts,
      mediaResolution: capabilities.mediaResolution ? getMediaResolution() : null,
    },
  });
  return out;
}

/**
 * CALL 2 - reconcile the Call-1 estimate against retrieved FNDDS rows, WITH the
 * same image attached (image + list beats list alone: 53.3 vs 66.5 kcal MAE).
 * @param {object} p
 * @param {string} p.imageDataUrl  MUST be the same image passed to analyzeMeal
 * @param {object} p.call1         the object analyzeMeal returned
 * @param {Array|object} p.dbRows  matcher output (flat rows, grouped, or a map)
 * @param {string} [p.mealSlot]    breakfast|lunch|dinner|snack, from the clock
 * @param {object} [p._client]     test seam
 * @returns {Promise<object>} the Call-2 contract object
 */
async function reconcile(p) {
  const input = p || {};
  const imageDataUrl = assertImage(input.imageDataUrl);

  if (!input.call1 || typeof input.call1 !== "object") {
    throw new VisionError(ERROR_CODES.BAD_INPUT, {
      message: "reconcile() requires the call1 object from analyzeMeal()",
      retryable: false,
      userMessage:
        "Internal error: the first analysis pass produced nothing to reconcile. " +
        "Try the photo again.",
    });
  }

  const client = getClient(input._client);

  const result = await runStructured(client, {
    schemaName: "meal_reconciliation",
    schema: call2Schema(),
    systemPrompt: CALL2_SYSTEM,
    imageDataUrl: imageDataUrl,
    temperature: 0.1,
    model: getReconcileModelId(),
    buildUserText: (mode) => buildCall2UserText(input, mode),
  });

  const out = normaliseCall2(result.data, input);
  Object.defineProperty(out, "_meta", {
    enumerable: false,
    value: {
      model: getReconcileModelId(),
      responseFormatMode: result.mode,
      attempts: result.attempts,
      mediaResolution: capabilities.mediaResolution ? getMediaResolution() : null,
    },
  });
  return out;
}

function stripModelsPrefix(id) {
  return String(id || "").replace(/^models\//, "");
}

function suggestModel(ids, wanted) {
  const clean = ids
    .map(stripModelsPrefix)
    .filter((id) => id.indexOf("gemini") === 0)
    .filter((id) => !NON_VISION_HINTS.some((h) => id.indexOf(h) !== -1));
  if (!clean.length) return null;

  const score = (id) => {
    let s = 0;
    if (id.indexOf("flash-lite") !== -1) s += 100; // cheapest that still sees
    else if (id.indexOf("flash") !== -1) s += 80;
    else if (id.indexOf("pro") !== -1) s += 40;
    if (id.indexOf("preview") !== -1) s -= 30;
    if (id.indexOf("exp") !== -1) s -= 30;
    if (id.indexOf("image") !== -1) s -= 60; // image GENERATION models
    if (id.indexOf("thinking") !== -1) s -= 10;
    if (wanted) {
      const fam = String(wanted).split("-").slice(0, 2).join("-");
      if (id.indexOf(fam) === 0) s += 15;
    }
    const v = id.match(/gemini-(\d+(?:\.\d+)?)/);
    if (v) s += Math.min(20, Number(v[1]) * 4); // newer family wins ties
    return s;
  };

  clean.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  return clean[0];
}

/**
 * Startup health check. GETs the provider's model list and reports whether the
 * configured VISION_MODEL is actually there. This is the check that would have
 * given a week's warning before the last model retirement.
 * @param {object} [p]
 * @param {object} [p._client] test seam
 * @returns {Promise<{ok:boolean, configured:boolean, available:boolean,
 *   suggestion:(string|null), model:string, models?:string[], error?:string,
 *   code?:string, message:string}>}
 */
async function checkModelAvailable(p) {
  const opts = p || {};
  const model = getModelId();
  const configured = isConfigured() || Boolean(opts._client) || Boolean(_clientFactory);

  if (!configured) {
    return {
      ok: false,
      configured: false,
      available: false,
      suggestion: null,
      model: model,
      code: ERROR_CODES.NO_API_KEY,
      error: ERROR_CODES.NO_API_KEY,
      message: USER_MESSAGES.NO_API_KEY,
    };
  }

  let client;
  try {
    client = getClient(opts._client);
  } catch (err) {
    const v = classifyError(err);
    return {
      ok: false, configured: configured, available: false, suggestion: null,
      model: model, code: v.code, error: v.code, message: v.userMessage,
    };
  }

  let ids = [];
  try {
    const page = await client.models.list();
    let items = [];
    if (Array.isArray(page)) items = page;
    else if (page && Array.isArray(page.data)) items = page.data;
    else if (page && typeof page[Symbol.asyncIterator] === "function") {
      for await (const m of page) items.push(m);
    }
    ids = items.map((m) => (typeof m === "string" ? m : (m && m.id) || "")).filter(Boolean);
  } catch (err) {
    const v = classifyError(err);
    return {
      ok: false, configured: configured, available: false, suggestion: null,
      model: model, code: v.code, error: v.code, message: v.userMessage,
    };
  }

  const normalised = ids.map(stripModelsPrefix);
  const available = normalised.indexOf(stripModelsPrefix(model)) !== -1;
  const suggestion = available ? null : suggestModel(ids, model);

  return {
    ok: available,
    configured: configured,
    available: available,
    suggestion: suggestion,
    model: model,
    models: normalised,
    message: available
      ? 'Vision model "' + model + '" is available.'
      : 'Vision model "' + model + '" is NOT in this key\'s model list' +
        (suggestion
          ? ". Set VISION_MODEL=" + suggestion + " in .env and restart."
          : ". No vision-capable Gemini model was found on this key."),
  };
}

// -----------------------------------------------------------------------------
// Exports. Object.keys(module.exports) is EXACTLY the four contract functions;
// the test seams below are non-enumerable and are not part of the public API.
// -----------------------------------------------------------------------------

module.exports = {
  analyzeMeal,
  reconcile,
  checkModelAvailable,
  isConfigured,
};

Object.defineProperty(module.exports, "setClientFactory", {
  enumerable: false, value: setClientFactory,
});
Object.defineProperty(module.exports, "VisionError", {
  enumerable: false, value: VisionError,
});
Object.defineProperty(module.exports, "ERROR_CODES", {
  enumerable: false, value: ERROR_CODES,
});
Object.defineProperty(module.exports, "getCapabilities", {
  enumerable: false, value: getCapabilities,
});
Object.defineProperty(module.exports, "__internals", {
  enumerable: false,
  value: {
    GEMINI_BASE_URL, DEFAULT_VISION_MODEL, DEFAULT_MEDIA_RESOLUTION, USER_MESSAGES,
    COOKING_METHODS, SCALE_OBJECTS, HOUSEHOLD_UNITS, FAT_TYPES, OCCLUSION,
    MEAL_SLOTS, STATES,
    getModelId, getMediaResolution, getApiKey,
    call1Schema, call2Schema, buildResponseFormat, buildGoogleExtras,
    buildCall1UserText, buildCall2UserText, buildMessages, schemaHintBlock,
    formatDbRows, normaliseDbRow,
    extractJson, repairJson, tryParse,
    normaliseCall1, normaliseCall2, normaliseSlot, oneOf, clamp01, clampConfidence, num, str,
    classifyError, errString, looksLikeSchemaRejection, looksLikeExtraBodyRejection,
    disambiguate400,
    suggestModel, stripModelsPrefix, assertImage, readContent,
    resetCapabilities, getCapabilities, capabilities,
    CALL1_SYSTEM, CALL2_SYSTEM,
  },
});
