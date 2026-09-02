# Calorie Analyzer

Photograph a meal, get a calorie count that is **cross-referenced against the
USDA food database** rather than guessed by a language model.

## How the number is produced

```
photo ──▶ Call 1 (vision)          what is on the plate, and how many grams
      ──▶ local match              each component → a real USDA FNDDS row
      ──▶ Call 2 (vision + photo)  reconcile the estimate against those rows
      ──▶ Σ grams × kcal/100g      the number you see
```

The model never supplies the final figure. It identifies components and
estimates portions; the calories come from summing real FNDDS rows. The
model's own total is kept only as a **disagreement detector** — if it differs
from the database total by more than a third, the component list is probably
wrong and the UI says so instead of quietly showing a bad number.

Every component in the confirm screen shows the FNDDS row and gram weight it
was priced from, so the estimate is auditable and correctable.

## Setup

```bash
npm install
cp .env.example .env      # then add your key
npm start
```

You need one free API key: **https://aistudio.google.com/apikey** (Google AI
Studio — no credit card). Put it in `.env` as `GEMINI_API_KEY`.

No food-database key is needed. USDA FNDDS ships in this repo at
[`data/fndds-lite.json`](data/fndds-lite.json) (5,432 prepared foods, ~1.2 MB,
public domain / CC0). Nothing is fetched at request time, so there is no
per-IP rate limit shared across users and no key to leak.

To rebuild the dataset from USDA's current release:

```bash
npm run build:fndds
```

## Why FNDDS and not the other databases

FNDDS is the food-coding database behind NHANES dietary recalls, so it
contains **whole prepared dishes** — which is what a photo of a plate actually
shows — and it encodes cooking method and added fat, which is where a portion
estimate goes two-fold wrong:

| Broccoli, FNDDS | kcal/100 g |
| --- | --- |
| frozen, cooked, no added fat | 28 |
| raw | 39 |
| fresh, cooked, no added fat | 41 |
| cooked, fat added | 63 |
| cooked, from restaurant | 77 |

Foundation and SR Legacy carry raw commodities; the Branded set is 433k
packaged goods and runs to gigabytes. Open Food Facts is used only for
barcodes — searching it for "grilled cheese" returns blocks of halloumi.

## Accuracy — read this before trusting a number

A browser cannot reach the phone's depth sensor, and depth is the single
highest-value portion signal (on Nutrition5k it cut calorie error from 26.1%
to 16.5% with no change to food recognition). The realistic ceiling here is
the 2D vision band: **roughly 25–40% error, skewed low**, worsening as
portions grow. Shipping commercial apps miss by ~250–345 kcal per meal.

So the app shows a range, marks its confidence, and makes every component
editable. The two fields that most improve the estimate are the ones a photo
physically cannot show — **cooking fat** and **dairy fat content** — which is
why the notes box asks for them.

## Layout

```
index.js                 Express server, the analyze pipeline
server/food-db.js        FNDDS index + BM25 matcher
server/vision.js         Gemini client, both calls, JSON schemas
scripts/build-fndds.js   rebuilds data/fndds-lite.json from USDA
data/fndds-lite.json     the bundled database (committed on purpose)
public/js/camera.js      capture + canvas re-encode (EXIF, HEIC, downscale)
public/js/storage.js     day-keyed history in localStorage
public/js/app.js         screens
docs/RESEARCH.md         the sourced research this design rests on
```

## Deploying

Heroku: `Procfile` and `engines` are set, and the server binds `process.env.PORT`.
Set `GEMINI_API_KEY` as a config var — never commit `.env`.

**Camera capture needs a secure context.** It works on `https://` and on
`http://localhost`, but *not* on a bare LAN IP like `http://192.168.1.50:3000`
— `navigator.mediaDevices` is simply undefined there. To test on a phone
against a local dev server:

```bash
cloudflared tunnel --url http://localhost:3000
```

The tunnel subdomain changes on every restart, which breaks an
already-installed Home Screen icon — reinstall it each session.

## Privacy

Meal photos are sent to Google's Gemini API. On the **free tier** Google's
terms state it uses submitted content to improve its products and that human
reviewers may read it, with no opt-out short of enabling billing. If this is
ever used by anyone other than you, disclose that in the UI.
