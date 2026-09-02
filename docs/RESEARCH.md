# Food Analyzer — Rebuild Decision Brief
**Date: 2026-09-02** · Prepared from 5 verified research tracks + adversarial fact-check

> **Headline:** GitHub Models is not deprecated, it is **gone** — `https://models.github.ai/inference/` returns **HTTP 410 Gone** on every route, permanently, since July 30 2026 ([docs.github.com/en/github-models](https://docs.github.com/en/github-models), [changelog](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/)). No model id, token, or config change revives it. The good news: `index.js:28` already uses `new OpenAI({ baseURL, apiKey })`, and `baseURL` override is still supported (confirmed in your `node_modules/openai@5.6.0/client.d.ts:51`, and still present in published v7.9.0). **Lines 24–26 are the whole fix.**

---

## 1. Vision model — the shortlist

| Provider | Exact model id | Truly free? | Free-tier limits | JSON schema output? | OpenAI-SDK drop-in? | Food quality | Verdict |
|---|---|---|---|---|---|---|---|
| **Google Gemini** | `gemini-3.5-flash-lite` (cheap) / `gemini-3.8-flash` (better) | **Yes** — API key from AI Studio, no card, no waitlist ([rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits): Free tier = "Active project or free trial"; billing only moves you to Tier 1) | ⚠️ **Google no longer publishes numbers.** The page says limits "can be viewed in Google AI Studio" → [aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit). Community figures (~10–15 RPM, 250–1,500 RPD) are **UNVERIFIED**. | Yes — `response_format` w/ `mime_type: application/json` + `schema`; image+schema combination documented by Google (Firebase AI Logic page) though no combined code sample exists → **likely, not certified** | **Yes, one line**: `baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"` ([official Node example](https://ai.google.dev/gemini-api/docs/openai)) | Best free option. Gemini-class models sit in the 165–211 kcal MAE frontier band ([ACETADA](https://arxiv.org/abs/2507.07048)) | ✅ **PRIMARY** |
| **Groq** | `qwen/qwen3.6-27b` (JSON mode + images explicitly demoed) or `qwen/qwen3.8-27b` | Yes, no card (secondary sources; Groq's own pricing page shows no tier detail — **UNVERIFIED from primary**) | Contested. Rate-limit table shows **30 RPM / 1K RPD / 8K TPM / 200K TPD** for both — but one verification pass could not confirm that tab was the *Free* plan vs Developer. Binding constraint is TPM: image = 2,048 tokens, so ≈**3 req/min, ~72 analyses/day** | 3.6: JSON mode ✅ + images ✅ (explicitly documented). Strict `json_schema` overlaps vision on **only** `qwen3.8-27b` ([structured-outputs](https://console.groq.com/docs/structured-outputs), [vision](https://console.groq.com/docs/vision)) | Yes: `https://api.groq.com/openai/v1` | Qwen-3 class; mid-pack. Notably Gemma-3-27B (187 kcal MAE) beat frontier Gemini-2.5-Pro (211) in ACETADA — **open weights are NOT 3× worse** | ✅ **FAILOVER** |
| Cloudflare Workers AI | `@cf/meta/llama-3.2-11b-vision-instruct`, `@cf/google/gemma-4-26b-a4b-it` | Yes, 10,000 Neurons/day, free account only ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)) | ~400–450 analyses/day on the cheap vision models (my arithmetic from published neuron rates) | ❌ **No vision model is on the JSON-mode list** ([json-mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)) | Yes: `.../ai/v1` | Llama-3.2-Vision is the *worst* model in both benchmarks (496 kcal MAE) | ⚠️ Third failover only |
| OpenRouter | `google/gemma-4-31b-it:free`, `dots-studio/dots-3-note-preview:free` | Yes | **50 requests/DAY** until you buy $10 lifetime credit, then 1,000/day ([limits](https://openrouter.ai/docs/api-reference/limits)) | Only `dots-3-note-preview:free` advertises `structured_outputs` | Yes | Gemma-4 class, decent | ⚠️ **Privacy problem** — `:free` requires data-policy toggles permitting providers to train on and in some cases *publicly publish* your prompts. These are photos of people's meals. |
| Hugging Face Router | any | $0.10/mo credits | ~a couple dozen images/month | n/a | Yes | n/a | ❌ Money, not integration, is the blocker |
| Together AI | — | No free vision tier | — | — | Yes | — | ❌ |
| Microsoft Foundry | — | **No** — "An Azure subscription with a valid payment method" ([migration guide](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/quickstart-github-models)) | — | — | — | — | ❌ Disqualified on budget |
| Ollama (local) | `qwen3-vl`, `gemma4:12b` | Free forever, zero data sharing | Unlimited | Yes | Yes: `http://localhost:11434/v1/` (base64 images only — which is what `getImageDataUrl()` already produces) | Good | ✅ **Dev-only** — needs a GPU box on 24/7; no free PaaS has one |

### The lowest-friction fix (smallest possible diff)

Change three lines in `index.js` and one env var. Nothing else:

```js
// index.js:24-26
const token     = process.env.GEMINI_API_KEY;
const endpoint  = "https://generativelanguage.googleapis.com/v1beta/openai/";
const modelName = process.env.VISION_MODEL || "gemini-3.5-flash-lite";
```

`.env`: delete `OPENAI_TOKEN`, add `GEMINI_API_KEY`. **Then revoke the old token at github.com/settings/tokens** — it's a real GitHub PAT sitting in an untracked `.env` and it may carry repo scopes.

Your existing message shape (`{ type: "image_url", image_url: { url: dataUrl } }`) is already correct for Gemini's OpenAI-compat layer. This gets you a *working app in ~5 minutes* with zero architecture change.

### The best-quality free option

Same provider, better model: **`gemini-3.8-flash`** with `media_resolution: "high"`, structured JSON output, and the two-call pipeline in §4. If you're willing to add ~150 lines, this is where the accuracy actually lives — but note the strongest finding in the literature is that **model architecture explains 99.6% of performance variance while prompt engineering showed no significant effect after correction** ([Sci Rep, 25 Jun 2026](https://www.nature.com/articles/s41598-026-58755-w)). Pick the best model you can get; don't over-tune prompts.

### Never hard-code the model id again

Both Groq vision models are **Preview status** ("intended for evaluation purposes only"), and Groq has already retired LLaVA → Llama-3.2-Vision → Llama-4-Scout/Maverick in under two years ([deprecations](https://console.groq.com/docs/deprecations)). Put the id in `.env` and add a startup check that GETs the provider's model list and logs a warning if your configured id is missing. That single check is what would have given you a week's warning last time.

---

## 2. Food database — the recommendation

**Use USDA FoodData Central, filtered to `Survey (FNDDS)`, shipped OFFLINE as a bundled file. Do not call the API at request time.**

### Why FNDDS specifically

FNDDS is the food-coding database behind NHANES dietary recalls, so it contains **whole prepared dishes**, which is what a photo of a plate actually shows. Verified live: `fdcId 2706538` = "Biryani with chicken" (foodCode 27243100, WWEIA category "Rice mixed dishes", 104 kcal/100g); "Grilled cheese sandwich, NFS" = 343 kcal/100g with a `1 sandwich = 116 g` portion. Foundation/SR Legacy are raw commodities; Branded (433k items) is packaged goods and bloats to gigabytes.

It also encodes **cooking method and added fat**, which is where a vision model's guess goes 2× wrong. Broccoli in FNDDS: raw 39, frozen cooked no added fat 28, fresh cooked no added fat 41, cooked with butter/margarine 60, cooked with oil 67, from restaurant 77 kcal/100g. That 28→77 spread is the error you're trying to eliminate. (Correction to earlier research: SR Legacy *also* has method granularity for meats — FNDDS's unique advantage is the **fat-added-in-cooking axis on vegetables**, 448 entries.)

License: **CC0 1.0 / public domain**, "no permission is needed for their use" ([api-guide](https://fdc.nal.usda.gov/api-guide/)). You can commit the data to a public repo. Materially better than Open Food Facts (ODbL share-alike) or CalorieNinjas (free tier forbids commercial use).

### Ship it offline — this is already built

Downloaded and verified: [`FoodData_Central_survey_food_json_2024-10-31.zip`](https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10-31.zip) — **3,835,292 bytes** zipped (HTTP 200, no key, no auth, no rate limit), 66,294,426 unzipped, **5,432 foods**. Projected to `{foodCode, description, wweiaCategory, kcal, protein, fat, carb, portions[[desc,grams]]}` it is **1,101,922 bytes JSON / 153,433 gzipped** — commit it to the repo. Loads in **15 ms / 8.3 MB heap**.

Files are sitting in your scratchpad now: `…\scratchpad\fndds-lite.json`, `fndds-lite.json.gz`, `bm25.js`, `bm25b.js`.

Sample row: `{"c":"27243100","d":"Biryani with chicken","cat":"Rice mixed dishes","k":104,"p":7.15,"f":2.38,"cb":13.6,"po":[["1 cup",196]]}`

**Two caveats:** values are **per 100 g**, not per portion — `kcal = k * grams / 100` or you under-report ~2×. And **5,431 of 5,432** rows have kcal; `Milk, human` (foodCode 11000000) ships with an empty `foodNutrients` array in USDA's own source. Guard for it.

FNDDS updates on the two-year NHANES cycle. 2021–2023 is still the current release as of today — a bundled snapshot does not go stale fast.

### If you do use the live API

- Base: `https://api.nal.usda.gov/fdc/v1/`
- Search: `GET /foods/search?api_key=KEY&query=chicken+biryani&dataType=Survey%20(FNDDS)&pageSize=10`
- Detail: `GET /food/{fdcId}?api_key=KEY` → `foodPortions: [{portionDescription:"1 cup", gramWeight:196}]`
- Batch: `POST /foods?api_key=KEY` with `{"fdcIds":[...],"format":"abridged"}` — one call per meal
- Energy is `nutrient.id 1008` (kcal); protein 1003, fat 1004, carb 1005
- **Shape trap:** search results flatten to `foodNutrients[].nutrientId/.value`; detail results nest as `foodNutrients[].nutrient.id/.amount`. One parser will not serve both.

**Key signup:** [fdc.nal.usda.gov/api-key-signup](https://fdc.nal.usda.gov/api-key-signup/) — email only, no credit card, key issued immediately.

**Rate limits — corrected:** docs claim 1,000 req/hour per **IP** for a registered key (**UNVERIFIED by measurement**; api.data.gov lets agencies override defaults). But `DEMO_KEY` is **NOT** the documented 30/hr + 50/day — live measurement today returned `X-Ratelimit-Limit: 10`, i.e. **~10 requests total per day**, resetting at 00:00 UTC, with a ~6-hour lockout on exceed. Confirmed on a second agency (NASA APOD) to rule out an FDC quirk. **Register a real key before writing any code; do not plan a DEMO_KEY dev path.** One 6-ingredient photo would burn half a day's DEMO quota.

### Ingredient name → DB entry matching (the part that will silently corrupt your totals)

**Do not trust hit #1 from anything.** Verified failures with naive token-overlap over FNDDS: `butter chicken` → "Chicken, back" (298 kcal, wrong food); `tikka masala` → "Milk, human" (no kcal at all); `oatmeal` → "Bread, oatmeal" (269 instead of Oatmeal NFS at 76 — a **3.5× error**); `avocado toast` → "Shrimp toast".

FDC's own Lucene ranking is no better: `query=butter chicken&dataType=Survey (FNDDS)` returns 655 hits topped by "Chicken, chicken roll, roasted" (266), "Fruit butter" (256), "Butter, tub" (255). The correct answer ("Chicken curry", 107 kcal) never surfaces because Lucene splits the two tokens.

**The strategy that fixed every case in testing** (`bm25b.js`):

1. **BM25** (k1=2.5, b=0.75) over `description + wweiaCategory`
2. × **query-coverage multiplier** `(0.4 + 0.6 * coverage)`, hard penalty below 50% coverage
3. **Head-noun hard filter** — classify `{raw, cooked, boiled, fried, grilled, baked, roasted, steamed, poached, breaded, coated, skinless, frozen, canned…}` as MODIFIERS, take the **first** non-modifier token as head noun, require it present in the candidate. (Last-noun-as-head is worse: it breaks `avocado toast` → "French toast".)
4. **Alias table**: `{'butter chicken':'chicken curry', 'tikka masala':'chicken curry', 'aubergine':'eggplant', 'courgette':'zucchini', 'coriander':'cilantro', 'prawn':'shrimp', 'chips':'potato french fries'}`
5. **Absolute score floor → explicit NO MATCH.** Nonsense input scored 0.82 vs 8–14 for real hits. Clean separation.
6. **Demote dressing/sauce/condiment WWEIA categories** when the query head is a dish — `caesar salad` still lands on "Caesar dressing" (542 kcal) without this, because `caesar` has high IDF.

After: `butter chicken`→Chicken curry (107) · `tikka masala`→Chicken curry (107) · `oatmeal`→Oatmeal NFS (76) · `white rice, boiled`→Rice, white, cooked (129, "1 cup cooked"=163g) · `broccoli, steamed`→Broccoli (39) · `xyzzy nonsense food`→**NO MATCH**.

**Surface the matched FNDDS description and grams back to the user.** That is what converts a guess into a cross-reference — and it lets them fix a bad match, which is worth more accuracy than any model swap.

### Open Food Facts — barcode path only

No API key, just a `User-Agent: AppName/Version (email)`. **15 req/min/IP** for product reads, **10 req/min/IP** for search ([API docs](https://openfoodfacts.github.io/openfoodfacts-server/api/), rate-limit block last revised 2026-04-26). Verified live: `GET /api/v2/product/3017624010701` → `energy-kcal_100g: 539`.

But it is **wrong for plated food** — searching "grilled cheese" returns blocks of halloumi, not sandwiches. Use it for exactly one job: barcode/packaged item lookup.

⚠️ **v2 is now deprecated** (v3.6 is current) and **v3 broke the shape**: `nutriments` returns `{}` and data moved to `product.nutrition.aggregated_set.nutrients["energy-kcal"].value`. Code written against `nutriments.energy-kcal_100g` silently reads `undefined` on v3. Also plan for **HTTP 503** — there are global limits independent of IP.

Ruled out: **FatSecret** (OAuth 2.0 IP whitelisting breaks on dynamic-IP free hosting), **Edamam** ($14/mo minimum), **Spoonacular** (50 *points*/day, not requests), **Nutritionix** (their pages 402'd; free tier **UNVERIFIED** — treat as not free), **CIQUAL/CoFID** (no API, and if you're shipping a file anyway, FNDDS is the better file).

---

## 3. Camera capture — what to build

**Ship `<input type="file" accept="image/*" capture="environment">` as the primary, default path. Treat `getUserMedia` as an optional enhancement you may never build.**

```html
<input type="file" accept="image/*" capture="environment" id="camera">
```

This is not a compromise for a one-shot "photograph my plate" interaction — it's better. No permission prompt, no secure context needed, no manifest changes, and the user gets Apple's/Google's native camera with real focus, flash and HDR. Supported iOS Safari 6→26.6, Chrome Android, **and Firefox Android** (since FF79 — the "no Firefox" claim was a misread of caniuse's desktop row). Desktop silently degrades to a file picker, which is correct behavior. Never feature-detect it; just ship it.

### Why you should not lead with getUserMedia on iOS

Your app is installed to the iOS Home Screen in standalone mode — exactly the configuration WebKit is still broken in:

- **[Bug 282327](https://bugs.webkit.org/show_bug.cgi?id=282327)** "Camera doesn't start in PWA" — filed Oct 30 2024, **still status NEW** today. PWA-only; direct Safari works. One reporter measured ~1% of 200k monthly iPhone users hitting it.
- **[Bug 252465](https://bugs.webkit.org/show_bug.cgi?id=252465)** — marked RESOLVED FIXED (Jul 2023) but reproduces through iOS 18.5 (iPhone 15 Pro Max / 18.5; iPhone 16 Pro / 18.4.1).
- **Permission is not persisted across app launches** ([bug 215884](https://bugs.webkit.org/show_bug.cgi?id=215884); STRICH's vendor KB, updated **Aug 27 2026**, still warns about this). Every single meal photo costs an extra permission tap.
- **iOS 26 removed the escape hatch.** "Every website added to the Home Screen opens as a web app" and "there are now zero requirements for installability" ([WebKit Safari 26.0 notes](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)). Stripping `apple-mobile-web-app-capable` no longer forces Safari. The only opt-out is a user-side "Open as Web App" toggle you cannot set from code.
- iOS 26 also brought *new* PWA-only regressions: rotated 90° getUserMedia feed with `screen.orientation.type` stuck at `portrait-primary` (Apple Dev Forums 801146).

### The failure mode is NOT a hang — this is the detail that trips everyone

Common advice says "wrap getUserMedia in a timeout." **That does not catch the dominant bug.** In 252465 the promise **resolves successfully** and you hold a real `MediaStreamTrack` — but `track.muted === true`, the `<video>` never fires `canplay`, and you get a black frame. In 282327 the camera opens, the red indicator appears, then it closes with **no stream and no error**.

So if you do build a preview, guard on **video readiness**, not on the promise:

```js
const stream = await navigator.mediaDevices?.getUserMedia({
  video: { facingMode: { ideal: 'environment' } }   // ideal, NOT exact — exact throws OverconstrainedError on any laptop
});
const track = stream.getVideoTracks()[0];
// wait for BOTH: loadedmetadata AND videoWidth>0 AND !track.muted, with a 3-5s wall clock
// on timeout: stream.getTracks().forEach(t => t.stop()); showFileInputFallback();
```

Also: `<video playsinline autoplay muted>` set **in HTML** (not JS, to avoid a race), assign `srcObject` never `src`, attach `loadedmetadata` *before* assigning, stop all tracks on `visibilitychange`, and subscribe to the track's `mute`/`unmute`/`ended` events.

`ImageCapture.takePhoto()` shipped in **Safari 18.4** (not 26.0 — `grabFrame` was the *last* method to land, in 26.0). Ladder: `takePhoto()` → `grabFrame()` → hidden `<video>` + canvas. But `grabFrame` does **not** work around 252465 — it reads from the same starved track and returns black.

### The one client-side function everything must go through

Regardless of which path fired:

```js
async function normalize(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(bmp.width * scale, bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });  // ~100-250KB
}
```

This does four jobs at once: kills EXIF rotation, kills the **HEIC hazard** (see §6), cuts a 12MP/6MB phone photo ~30×, and lets your server hardcode `image/jpeg` instead of trusting `originalname`. `imageOrientation` defaults to `'from-image'` and the API is Baseline since Sept 2021 — but **pass it explicitly** and delete any manual EXIF rotation code, since the default used to be `'none'` and old StackOverflow snippets will now double-rotate.

⚠️ **Downscaling does NOT save you tokens on Gemini 3.** The widely-quoted "258 tokens per 768×768 tile" rule is **pre-Gemini-3** — it's still printed unqualified on the image-understanding page but contradicted by [media-resolution](https://ai.google.dev/gemini-api/docs/media-resolution): Gemini 3 bills a **flat** 1120 tokens/image by default, `low`=280, `medium`=560, `high`=1120, `ultra_high`=2240. Downscale for **upload bandwidth and latency**, and set `media_resolution` explicitly for cost. Given that high-quality photography significantly beat lab imaging (RMSLE 0.548 vs 0.616, p=0.020, [Sci Rep](https://www.nature.com/articles/s41598-026-58755-w)), use **`high`**.

### Testing on your actual phone

You're on **Windows 11**, so the Mac-only escape hatch (Safari Web Inspector → Device Settings → "Allow Media Capture on Insecure Sites") is unavailable to you.

`http://192.168.1.50:3000` is **not a secure context** — `navigator.mediaDevices` will be `undefined` and you'll get a `TypeError` on a missing property, not a rejected promise. Only `127.0.0.0/8`, `::1`, `localhost`/`*.localhost`, `file://`, and Chrome's `--unsafely-treat-insecure-origin-as-secure` flag qualify.

**Use:** `cloudflared tunnel --url http://localhost:3000` — free, no account, no credit card, real HTTPS origin you can install to the Home Screen to test true standalone behavior ([TryCloudflare docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)). Caps at 200 concurrent requests, no SSE, dev-only. **The subdomain changes on every restart, which breaks an already-installed Home Screen icon** — reinstall each session.

Android also has `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (Enabled + type the origin in the text field) and DevTools port forwarding, but the tunnel covers both platforms with one command.

**Nothing to add to `manifest.json`.** The default Permissions-Policy allowlist for `camera` is already `self`. Only act if you add `helmet` (verify it doesn't emit a restrictive `Permissions-Policy` — a blocked policy rejects with `NotAllowedError`, indistinguishable from user denial) or if the camera UI ends up in an iframe (needs `<iframe allow="camera">`).

---

## 4. Accuracy — the pipeline that gets the best number

### Set expectations honestly first

A browser PWA **cannot reach LiDAR/depth** (Apple exposes it only via native AVFoundation/ARKit; no depth track is exposed to web content — **UNVERIFIED as an explicit prohibition**, but strong absence of evidence). Depth is the single highest-value portion signal: on Nutrition5k, adding depth-derived volume to the *same model* cut calorie error from **26.1% → 16.5%** with zero change to food recognition ([CVPR 2021](https://ar5iv.labs.arxiv.org/html/2103.03375)). SnapCalorie's ~15% claim rests entirely on it.

Your realistic ceiling is the 2D-VLM band: **~25–40% energy MAPE**, with systematic **under**-estimation that worsens with portion size (regression slopes −0.23 to −0.50, [Curr Dev Nutr](https://pmc.ncbi.nlm.nih.gov/articles/PMC12513282/)). Shipping apps (MyFitnessPal, LoseIt!, Cal AI) miss by ~250–345 kcal/meal, ~33% low, and under-count fat by ~30 g (NIH/NIDDK, NUTRITION 2026 — **conference abstract, preliminary, not peer-reviewed**).

**Compete on speed of logging and honest ranges, not fake precision.**

### The pipeline: two calls, DB-derived number, model as cross-check

**Call 1** — image + notes + local timestamp/meal-slot + saved plate diameter → strict JSON component list with gram ranges.
**Local step** — BM25 match each component against bundled FNDDS, get kcal/100g.
**Call 2** — same image + Call-1 JSON + retrieved DB rows → reconciled final range.

**Report the DB-derived total. Keep the model's own kcal purely as a disagreement detector.**

```
kcal_db = Σ grams_final × (kcal_per_100g / 100) × edible_fraction
if |kcal_db − kcal_model| / mean < 0.35  → show kcal_db (auditable, unit-consistent)
else → the component list is probably wrong: widen the range, highlight the
        disagreeing component, ask EXACTLY ONE clarifying question
```

**Why a blend and not either extreme:**
- DB-only is capped by the model's ingredient-set accuracy — **Jaccard ≈ 0.31–0.35** against ground truth ([CVPR 2025W two-step](https://openaccess.thecvf.com/content/CVPR2025W/MTF/papers/Khlaisamniang_Decomposing_Food_Images_for_Better_Nutrition_Analysis_A_Nutritionist-Inspired_Two-Step_CVPRW_2025_paper.pdf)). Two-thirds of the ingredient set is wrong, missing, or named differently — and fuzzy-match error stacks on top.
- Model-only carries the 33–36% systematic low bias plus rare catastrophic misidentifications (falafel→meatballs = 360% protein overestimate; scrambled eggs→pasta = 1788% carb overestimate).
- **The image must stay in Call 2.** SNAPMe Case 3 (image + ingredients + amounts) = **53.33 kcal MAE**; Case 4 (ingredients + amounts, no image) = **66.51**. Arithmetic from a list alone is *worse* ([Nutrients 17(22):3613](https://pmc.ncbi.nlm.nih.gov/articles/PMC12655113/)).

### The single biggest cheap win: ask four structured questions

Same SNAPMe study, kcal MAE: **image only 123.03 → image + standardized non-visual descriptors 92.04 → image + ingredients with amounts 53.33.** The Case-2 descriptor set is exactly the four things a photo cannot show:

1. **Type and amount of fat** (cooking oil/butter — the classic invisible ingredient, and the NIH audit found fat under by ~30 g)
2. **Type and amount of sweetener**
3. **Fat content of dairy** (whole/2%/skim)
4. **Type of meat**

Four fast chips beat every prompt trick in the literature combined.

### Deliberately skip these — the evidence says they don't work

- **Multi-angle capture** — RMSLE 0.627 vs 0.623, p=0.182. No benefit. ([Sci Rep](https://www.nature.com/articles/s41598-026-58755-w))
- **SAM/YOLO/FoodSAM segmentation preprocessing** — all eight variants lost to plain two-step for GPT-4o. (CVPR 2025W)
- **Self-consistency / median-of-N** — no food-specific validation exists (**UNVERIFIED**), and theoretically it reduces *variance* while the dominant error is *systematic bias*. It also multiplies your free-tier call count by N, which is the one budget you don't have.
- **Fiducial markers** — users will not place a checkerboard next to their dinner.
- **Prompt-persona / few-shot / CoT phrasing** — ⚠️ **corrected finding.** The widely-cited ACETADA "Expert Persona −75.39 kcal" numbers are **metadata effects measured on top of a fixed modifier**, not modifier-vs-plain comparisons. ACETADA never compares any modifier to a no-modifier prompt. The 40-model Sci Rep study found prompts n.s. after correction (all p>0.05). **What replicates across both studies is information injection**, not phrasing: ingredient descriptions (p=0.039) and image quality (p=0.020).
- **"Forbid the model from reading text in the image"** — ⚠️ **refuted.** The cited R²=0.23→0.60 figure is a Haiku-vs-Sonnet *model* comparison, not a prompt comparison, and it came from a packaged-goods dataset where labels exist. Near-inert for plated meals.
- **Metadata magnitude** — ⚠️ **corrected.** "76 kcal MAE reduction" is a best-of-7-combinations post-hoc oracle whose average is dominated by two models you'd never ship (Janus-Pro −246, LLaMA-3.2 −193). **Median is 34.6 kcal; closed-model mean is 24.4.** And ACETADA's "food items" input was a *dietitian-verified ground-truth list*, not a user's notes field. Still worth doing — GPS/timestamp appeared in every winning combination and cost nothing — just budget tens of kcal, not 76.

### Exact JSON schema

**Design rule that matters:** every free-text reasoning field must precede the number it justifies. JSON-mode is known to place answer keys before reason keys and bypass chain-of-thought entirely (the "Let Me Speak Freely" effect).

**Call 1** — in: image (`media_resolution: "high"`), notes, `"07:43 AM - Breakfast"`, saved plate diameter.

```json
{
  "scale_references": [
    {"object": "dinner fork|dinner plate|smartphone|hand|can|mug",
     "assumed_size_cm": 0, "confidence": 0.0}
  ],
  "plate_diameter_cm_estimate": null,
  "dish_name": "",
  "cuisine": "",
  "cooking_method": "fried|deep_fried|grilled|roasted|boiled|steamed|raw|baked|sauteed",
  "components": [{
    "name": "",
    "search_terms": ["", "", ""],
    "state": "cooked|raw",
    "visible_geometry": "how you judged the size, referencing scale_references",
    "household_measure": {"amount": 0, "unit": "cup|tbsp|tsp|oz|slice|piece|fillet|medium"},
    "grams_low": 0, "grams_likely": 0, "grams_high": 0,
    "edible_fraction": 1.0,
    "confidence": 0.0
  }],
  "added_fat": {"type": "olive_oil|butter|none|unknown", "grams_likely": 0},
  "hidden_ingredients_note": "",
  "occlusion_risk": "low|medium|high"
}
```

**Call 2** — in: same image + Call-1 JSON + your retrieved FNDDS rows.

```json
{
  "reconciliation_notes": "",
  "components": [{"name": "", "chosen_fdc_id": null, "grams_final": 0, "kcal": 0}],
  "kcal_low": 0, "kcal_likely": 0, "kcal_high": 0,
  "protein_g": 0, "carb_g": 0, "fat_g": 0,
  "meal_slot": "breakfast|lunch|dinner|snack",
  "overall_confidence": 0.0,
  "clarifying_question": null
}
```

Notes: `search_terms` is an array so you can multi-probe the BM25 index instead of one brittle string. Household measures are mandatory because FNDDS gives you `portionDescription → gramWeight` and users can verify "1 cup" but not "196 g". **Exactly one** `clarifying_question` — a list makes people abandon the flow.

**Do not display sodium.** Salt MedAPE was 34–64% across all models tested ([Nutrients 18(12):2017](https://doi.org/10.3390/nu18122017)).

### Two-step is worth ~12% — but it's model-dependent

GPT-4o: 89.305 → 78.489 kcal MAE on Nutrition320 (12.11%). But **Qwen2.5-VL got *worse* with two-step** on the full Nutrition5k ablation (96.95 → 100.22), and Gemini-2.0-Flash did better with bounding boxes. The paper evaluated `gpt-4o-2024-11-20`, a paid model now retired. **Whether the two-step gain transfers to your free model is UNVERIFIED — measure it on 20 of your own photos before committing to two calls.** If it doesn't help, one call halves your rate-limit consumption.

### Meal slot

Derive from the **browser's** local clock (never server time): 04:00–10:30 breakfast, 10:30–15:00 lunch, 15:00–21:00 dinner, 21:00–04:00 snack. Show as a pre-selected chip, other three one tap away. NHANES defines meal type by respondent self-designation and states verbatim: **"The time an eating occasion occurs has no implication as to the type of meal"** ([NHANES/WWEIA](https://www.ncbi.nlm.nih.gov/books/NBK604191/)). NHANES mean times for calibration: breakfast 8:17, lunch 12:50, dinner 18:27, snack 15:17. Interpolate the resulting string into the prompt too — free, and timestamp flags appeared in every winning ACETADA combination. **Never ask the model to classify the slot from the image** — breakfast-vs-snack is user intent, not a visual property.

### Ranges: widen them yourself

Emit `kcal_low/likely/high`, but **do not treat them as a statistical interval.** No study measures coverage of LLM-emitted calorie intervals against weighed ground truth, and LLMs are documented to be overconfident (**UNVERIFIED for this domain**). Widen the model's spread to span roughly **±35%** for mixed dishes, more for soups/stews/smoothies/anything oily. Present as "roughly 520–780 kcal."

**Then log every user correction.** A per-user multiplicative calibration factor directly attacks the systematic low bias that median-of-N provably cannot, and it's the labelled calibration set conformal prediction would need later. This is the highest-value thing you can build that no competitor's model swap can match.

---

## 5. Open questions the owner must answer

Research cannot settle these. Answer them before writing code.

1. **Is it acceptable that Google trains on the meal photos?** Gemini's free tier terms (effective 2026-03-23) state: *"Google uses the content you submit... to provide, improve, and develop Google products,"* *"human reviewers may read, annotate, and process your API input and output,"* and *"Do not submit sensitive, confidential, or personal information to the Unpaid Services."* Google does disconnect data from your account/key before review. There is **no free-tier opt-out** — the only exit is enabling billing. Is this app private, or will you share it? Will you put a disclosure in the UI? ([terms](https://ai.google.dev/gemini-api/terms))

2. **Just you, or other people?** This changes everything. OpenRouter's 50 req/day and Groq's ~72 analyses/day are fine for one person and a hard wall for ten. It also changes whether the FDC 1,000/hr **per-IP** limit matters (it's shared across all users of one deployment) — and whether the offline FNDDS bundle is a nice-to-have or mandatory.

3. **Are you in the EEA/Switzerland/UK?** If so, Google applies **paid-tier data terms even to your unpaid quota** — which would delete question 1 entirely.

4. **Where will this be hosted?** Render/Fly/Vercel free tiers have no GPU (rules out Ollama in production) and dynamic egress IPs (rules out FatSecret regardless). Is it running on your own always-on machine? If yes, Ollama becomes viable and every rate limit disappears.

5. **What's your usual plate diameter, in cm?** Single-image portion estimation is *mathematically ill-posed* — infinite 3D volumes project to the same 2D image. A known referent is the documented fix, and a one-time settings field costs the user one interaction ever. What's your standard dinner plate and cereal bowl?

6. **Do you want a visible range, or a single number?** The honest answer is a range with one-tap correction. The answer that feels like a product is a single number. You cannot have both, and every competitor chose fake precision.

7. **Will you actually correct wrong estimates?** The per-user calibration loop in §4 only works if you tap "that was more like 600." If you won't, skip building it and skip the correction UI, which changes the schema.

8. **Two calls or one?** Two costs double your rate-limit budget for a ~12% gain that was measured on a paid, now-retired model and *reversed* on a Qwen model. Decide after testing on 20 of your own photos, not before.

9. **How much are you willing to build?** Path A is 3 lines and a working app today with a guessing model. Path B is ~150 lines + a 150KB data file for a real cross-referenced number. There is no middle.

10. **Do you want barcode scanning?** It's a genuinely different code path (Open Food Facts v3, no FNDDS, a barcode-detection library) and a real fraction of logged food. In or out for v1?

---

## 6. Landmines

**Will cost you money or break silently.**

1. 🔴 **Revoke the GitHub PAT in `.env` now.** It's inert for inference but it's a real GitHub token that may carry repo scopes, sitting in an untracked file. Also add `.env` to `.gitignore` — `git status` currently shows it as untracked, one `git add .` from being committed.

2. 🔴 **The 410 response body lies.** It reads `{"error":{"code":"github_models_retirement_brownout","message":"GitHub Models is temporarily unavailable as part of a scheduled retirement brownout."}}` — verified byte-identical today. That text is stale copy from the July 16/23 brownouts. **Do not add retry/backoff logic.** The 410 status is the truth; nothing is coming back. Also: the legacy host `models.inference.ai.azure.com` now **NXDOMAINs**, so old tutorials will fail as a "network error" rather than an HTTP status and get misdiagnosed as your firewall.

3. 🔴 **`index.js:49` HEIC bug.** `path.extname(req.file.originalname).slice(1)` → `data:image/heic;base64,...` when iOS hands you `IMG_0001.heic`, which fails with a confusing model-side error. **Never put `image/heic` in the `accept` attribute** (Safari 17+ then auto-converts *to* HEIC — [Apple Forums 743049](https://developer.apple.com/forums/thread/743049)). Fix architecturally: canvas-re-encode client-side and hardcode `image/jpeg` server-side. Never trust `originalname` for a MIME type.

4. 🟡 **`index.js:86` has a typo: `details: "low"` — the spec parameter is `detail`.** It has been silently ignored this whole time. **Do not "fix" it to `"low"`** — high-quality imaging significantly outperformed lab imaging (p=0.020), so low-detail is the wrong direction. On Gemini 3 the correct control is `media_resolution: "high"` anyway.

5. 🟡 **Both prose-parsing sites must die together.** `index.js:79` instructs the model to emit `'Description'` and `'Estimated Calories'`; `public/script.js:277-299` (`extractDescriptionAndCalories`) regex-parses it with `/\*\*Estimated Calories:\*\*\s*(\d+)/i` plus a `split()` fallback. Change one without the other and the app returns `undefined` calories with no error.

6. 🟡 **`index.js:106` `/api/ask` also uses the dead endpoint.** It'll 500 on every call. Easy to forget.

7. 🟡 **FNDDS is per 100 g.** `kcal = k * grams / 100`. Forget the `/100` and you under-report ~2× on every meal. Also handle the one row (`Milk, human`) with no nutrients, and the 28 rows that legitimately have kcal 0 (black coffee, unsweetened tea, stevia) — those are real zeros, not missing data.

8. 🟡 **`DEMO_KEY` is ~10 requests/day, not the documented 30/hr + 50/day.** Measured live. One 6-ingredient photo eats over half of it, and the lockout runs to 00:00 UTC. Get a real key or ship the offline bundle. Corollary: call FDC **from Express, never the browser** — the limit is IP-scoped and the key must stay server-side.

9. 🟡 **Groq's vision models are Preview.** "Intended for evaluation purposes only," with "limited advance warning" before discontinuation. Also the docs contradict themselves on max images (vision page says 5 for `qwen3.6-27b`; the model card says 3) — **assume 3**. And the free-tier numbers themselves are contested; verify in your own console before relying on them.

10. 🟡 **OpenRouter `:free` requires enabling data-policy toggles** that let providers train on — and for some endpoints **publicly publish** — your prompts. With them off, every free model returns 404 "No endpoints available matching your guardrail restrictions." For photos of people's meals (possibly with faces or homes in frame), this is materially worse than Gemini's free tier.

11. 🟡 **Open Food Facts v2 → v3 shape break.** `nutriments` returns `{}` on v3.6; data moved to `product.nutrition.aggregated_set.nutrients[...].value`. Silent `undefined`, not an error. Also `serving_size` is frequently absent — don't assume it exists.

12. 🟡 **Never take hit #1 from FDC search.** Its Lucene ranking put "Chicken, chicken roll, roasted," "Fruit butter," and "Butter, tub" above the correct answer for `butter chicken`. Take top 5–10 and re-rank locally, always.

13. 🟡 **Cloudflare tunnel URLs are ephemeral.** The subdomain changes on every `cloudflared` restart, which breaks any already-installed iOS Home Screen icon. Reinstall each session — or you'll spend an hour debugging a "broken PWA" that's just pointing at a dead URL.

14. 🟢 **If you ever add `helmet`**, verify it doesn't emit a `Permissions-Policy` omitting `camera`. A policy block rejects `getUserMedia` with `NotAllowedError` — byte-identical to a user denial. Nasty debugging trap.

15. 🟢 **Don't upgrade `openai` to v7.** It requires Node 22 (Node 20 hit EOL 2026-04-30). Your v5.6.0 works unchanged and `baseURL` is unchanged through v7.9.0. Separately, `max_tokens` (line 121) is deprecated in favor of `max_completion_tokens` — still accepted by most compat endpoints, but worth changing while you're in there.