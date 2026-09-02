#!/usr/bin/env node
'use strict';

/**
 * build-fndds.js
 *
 * Builds the bundled offline food database used by CalPal.
 *
 * Downloads the USDA FoodData Central "Survey (FNDDS)" JSON bulk dataset,
 * unzips it, projects every food down to a compact record, and writes:
 *
 *   data/fndds-lite.json       - JSON array of compact food records
 *   data/fndds-lite.meta.json  - provenance metadata
 *
 * No API key is required for the bulk download. Nothing here runs at request
 * time; this is a build step whose output is committed to the repo.
 *
 * Usage:
 *   node scripts/build-fndds.js
 *   node scripts/build-fndds.js --keep-temp    (leave the download in place)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Current Survey (FNDDS) JSON release as listed on
// https://fdc.nal.usda.gov/download-datasets  (verified 2026-09-02).
const SOURCE_URL =
  'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10-31.zip';

// The release date is taken from the source filename, never from the clock, so
// that reruns produce byte-identical output.
const RELEASE_DATE = '2024-10-31';

const ROOT = path.resolve(__dirname, '..');
const TEMP_DIR = path.join(ROOT, '.tmp-fndds');
const DATA_DIR = path.join(ROOT, 'data');
const ZIP_PATH = path.join(TEMP_DIR, 'survey-food-json.zip');
const OUT_JSON = path.join(DATA_DIR, 'fndds-lite.json');
const OUT_META = path.join(DATA_DIR, 'fndds-lite.meta.json');

// FoodData Central nutrient ids.
const N_PROTEIN = 1003; // Protein (g)
const N_FAT = 1004; // Total lipid (fat) (g)
const N_CARB = 1005; // Carbohydrate, by difference (g)
const N_ENERGY_KCAL = 1008; // Energy (kcal)
const N_ENERGY_KJ = 1062; // Energy (kJ)

const KJ_PER_KCAL = 4.184;

const KEEP_TEMP = process.argv.includes('--keep-temp');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(msg + '\n');
}

/** Round to `places` decimals and normalise -0 / float noise away. */
function round(value, places) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const f = Math.pow(10, places);
  const r = Math.round(value * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MiB';
}

// ---------------------------------------------------------------------------
// Step 1: download
// ---------------------------------------------------------------------------

async function download(url, destPath) {
  log('Downloading ' + url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(
      'Download failed: HTTP ' +
        res.status +
        ' ' +
        res.statusText +
        '\nThe Survey (FNDDS) release may have been superseded. Check ' +
        'https://fdc.nal.usda.gov/download-datasets for the current JSON link.'
    );
  }
  if (!res.body) throw new Error('Download failed: response had no body.');

  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));

  const size = fs.statSync(destPath).size;
  if (size === 0) throw new Error('Download failed: wrote an empty file.');
  log('  saved ' + formatBytes(size) + ' -> ' + destPath);
  return size;
}

// ---------------------------------------------------------------------------
// Step 2: unzip (no npm dependency)
// ---------------------------------------------------------------------------

/**
 * Node has no built-in ZIP reader, so shell out. On Windows we use the bsdtar
 * that ships in System32 (the `tar` on PATH under Git Bash is GNU tar, which
 * cannot read ZIP), falling back to PowerShell's Expand-Archive. Elsewhere we
 * try `unzip`, then `tar` (bsdtar on macOS reads ZIP fine).
 */
function unzip(zipPath, destDir) {
  const attempts = [];

  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:/Windows';
    attempts.push({
      label: 'bsdtar (System32)',
      file: path.join(systemRoot, 'System32', 'tar.exe'),
      args: ['-x', '-f', zipPath, '-C', destDir],
    });
    attempts.push({
      label: 'PowerShell Expand-Archive',
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath ' +
          JSON.stringify(zipPath) +
          ' -DestinationPath ' +
          JSON.stringify(destDir) +
          ' -Force',
      ],
    });
  } else {
    attempts.push({
      label: 'unzip',
      file: 'unzip',
      args: ['-o', '-q', zipPath, '-d', destDir],
    });
    attempts.push({
      label: 'bsdtar',
      file: 'tar',
      args: ['-x', '-f', zipPath, '-C', destDir],
    });
  }

  const failures = [];
  for (const attempt of attempts) {
    try {
      execFileSync(attempt.file, attempt.args, { stdio: 'pipe' });
      log('  unzipped with ' + attempt.label);
      return;
    } catch (err) {
      failures.push(attempt.label + ': ' + String(err.message || err).trim());
    }
  }
  throw new Error('Could not unzip the archive.\n  ' + failures.join('\n  '));
}

/** Find the extracted payload; USDA names it surveyDownload.json. */
function findExtractedJson(dir) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'));
  if (entries.length === 0) {
    throw new Error('No .json file found in ' + dir + ' after unzipping.');
  }
  // Prefer the canonical name, else the largest JSON present.
  const preferred = entries.find((e) => e.name === 'surveyDownload.json');
  if (preferred) return path.join(dir, preferred.name);

  let best = null;
  let bestSize = -1;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const size = fs.statSync(p).size;
    if (size > bestSize) {
      bestSize = size;
      best = p;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Step 3: project each food to the compact record
// ---------------------------------------------------------------------------

/**
 * Pull one nutrient amount out of a food's foodNutrients array.
 *
 * The bulk download nests it as foodNutrients[].nutrient.{id,number} with the
 * value on foodNutrients[].amount (verified against the 2024-10-31 file).
 *
 * Returns null when the nutrient is absent, so a genuinely-zero value (black
 * coffee, plain water) stays distinguishable from missing data.
 */
function nutrientAmount(foodNutrients, nutrientId) {
  for (const fn of foodNutrients) {
    const n = fn && fn.nutrient;
    if (!n) continue;
    // Match on the numeric id, falling back to the legacy `number` string.
    if (n.id === nutrientId || n.number === String(nutrientId)) {
      const amount = fn.amount;
      return typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
    }
  }
  return null;
}

function buildRecords(foods, stats) {
  const records = [];

  for (const food of foods) {
    const foodNutrients = Array.isArray(food.foodNutrients) ? food.foodNutrients : [];

    // --- energy -----------------------------------------------------------
    let kcal = nutrientAmount(foodNutrients, N_ENERGY_KCAL);
    if (kcal === null) {
      const kj = nutrientAmount(foodNutrients, N_ENERGY_KJ);
      if (kj !== null) {
        kcal = kj / KJ_PER_KCAL;
        stats.kjConverted++;
      }
    }
    if (kcal === null) {
      stats.missingKcal++;
      stats.missingKcalFoods.push({
        foodCode: food.foodCode,
        description: food.description,
      });
    } else if (kcal === 0) {
      stats.zeroKcal++;
      stats.zeroKcalFoods.push({
        foodCode: food.foodCode,
        description: food.description,
      });
    }

    // --- portions ---------------------------------------------------------
    const portions = (Array.isArray(food.foodPortions) ? food.foodPortions : [])
      .slice()
      // USDA does not store portions in sequence order; restore it so the most
      // representative portion ("1 cup") comes first.
      .sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0))
      .filter((p) => {
        const g = p && p.gramWeight;
        // A zero-gram portion carries no information for a gram estimate.
        if (typeof g !== 'number' || !Number.isFinite(g) || g <= 0) {
          stats.droppedPortions++;
          return false;
        }
        return true;
      })
      .map((p) => [
        String(p.portionDescription || '').trim(),
        round(p.gramWeight, 2),
      ]);

    stats.keptPortions += portions.length;

    const category =
      (food.wweiaFoodCategory && food.wweiaFoodCategory.wweiaFoodCategoryDescription) ||
      '';
    if (!category) stats.missingCategory++;

    records.push({
      c: String(food.foodCode),
      d: String(food.description || ''),
      cat: String(category),
      // kcal in this dataset are whole numbers; 1 decimal leaves room for a
      // kJ-derived value without bloating the file.
      k: round(kcal, 1),
      p: round(nutrientAmount(foodNutrients, N_PROTEIN), 2),
      f: round(nutrientAmount(foodNutrients, N_FAT), 2),
      cb: round(nutrientAmount(foodNutrients, N_CARB), 2),
      po: portions,
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup() {
  if (KEEP_TEMP) {
    log('--keep-temp given; leaving ' + TEMP_DIR + ' in place.');
    return;
  }
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    log('Removed temp dir ' + TEMP_DIR);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  await download(SOURCE_URL, ZIP_PATH);

  log('Unzipping...');
  unzip(ZIP_PATH, TEMP_DIR);

  const jsonPath = findExtractedJson(TEMP_DIR);
  const sourceFile = path.basename(jsonPath);
  log('  extracted ' + sourceFile + ' (' + formatBytes(fs.statSync(jsonPath).size) + ')');

  log('Parsing...');
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const foods = parsed.SurveyFoods;
  if (!Array.isArray(foods)) {
    throw new Error(
      'Unexpected payload shape: expected a top-level "SurveyFoods" array, got keys: ' +
        Object.keys(parsed).join(', ')
    );
  }
  log('  ' + foods.length + ' survey foods');

  const stats = {
    kjConverted: 0,
    missingKcal: 0,
    missingKcalFoods: [],
    zeroKcal: 0,
    zeroKcalFoods: [],
    droppedPortions: 0,
    keptPortions: 0,
    missingCategory: 0,
  };

  log('Projecting to compact records...');
  const records = buildRecords(foods, stats);

  // Provenance derived from the data itself, never from the build clock.
  const coverage = [
    ...new Set(
      foods
        .map((f) => (f.startDate && f.endDate ? f.startDate + '..' + f.endDate : null))
        .filter(Boolean)
    ),
  ];
  const builtFrom =
    'USDA FNDDS Survey Foods, release ' +
    RELEASE_DATE +
    (coverage.length === 1 ? ' (survey coverage ' + coverage[0] + ')' : '');

  fs.writeFileSync(OUT_JSON, JSON.stringify(records), 'utf8');

  const meta = {
    sourceUrl: SOURCE_URL,
    sourceFile: sourceFile,
    builtFrom: builtFrom,
    foodCount: records.length,
    generatedNote:
      'Generated by scripts/build-fndds.js (npm run build:fndds) from the USDA ' +
      'FoodData Central Survey (FNDDS) bulk JSON release dated ' +
      RELEASE_DATE +
      '. Values are per 100 g. Keys: c=foodCode, d=description, cat=WWEIA ' +
      'category, k=kcal, p=protein g, f=fat g, cb=carbohydrate g, ' +
      'po=[[portionDescription, gramWeight], ...]. A null nutrient means USDA ' +
      'ships no value for that food; 0 is a real measured zero. This file is ' +
      'deterministic - rebuilding from the same release reproduces it byte for byte.',
  };
  fs.writeFileSync(OUT_META, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  cleanup();

  // --- report --------------------------------------------------------------
  const outSize = fs.statSync(OUT_JSON).size;
  log('');
  log('Wrote ' + OUT_JSON);
  log('  foods:            ' + records.length);
  log('  bytes:            ' + outSize + ' (' + formatBytes(outSize) + ')');
  log('  portions kept:    ' + stats.keptPortions);
  log('  portions dropped: ' + stats.droppedPortions + ' (gramWeight <= 0)');
  log('  kJ->kcal rows:    ' + stats.kjConverted);
  log('  missing kcal:     ' + stats.missingKcal);
  for (const f of stats.missingKcalFoods) {
    log('      - ' + f.foodCode + '  ' + f.description);
  }
  log('  kcal === 0:       ' + stats.zeroKcal + ' (real zeros, not missing)');
  log('  missing category: ' + stats.missingCategory);
  log('Wrote ' + OUT_META);
  log('Done in ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
}

main().catch((err) => {
  console.error('\nbuild-fndds failed: ' + (err && err.stack ? err.stack : err));
  try {
    cleanup();
  } catch (_) {
    /* best effort */
  }
  process.exit(1);
});
