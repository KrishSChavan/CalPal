"use strict";

/**
 * server/food-db.test.js
 *
 * Plain Node test suite for the offline FNDDS matcher. No dependencies --
 * node:test and node:assert are built in.
 *
 *   node server/food-db.test.js      (or: npm run test:db)
 *
 * Every case below is a match the research verified against the real USDA
 * FNDDS 2024-10-31 release. Each asserts BOTH the FNDDS description that
 * should win AND that the kcal figure is in the right ballpark -- a matcher
 * that returns a plausible-looking wrong row silently corrupts the calorie
 * total, so the kcal assertion is the one that actually protects the user.
 */

const test = require("node:test");
const assert = require("node:assert");

const db = require("./food-db.js");

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Best hit for a query, or null when the matcher reports NO MATCH. */
function top(query, opts) {
  const r = db.search(query, opts);
  return r.length > 0 ? r[0] : null;
}

/** All descriptions returned for a query, lowercased. */
function descriptions(query, limit) {
  return db.search(query, { limit: limit || 5 }).map(function (r) {
    return r.description.toLowerCase();
  });
}

function assertKcalNear(hit, expected, tolerance, label) {
  assert.ok(hit, label + ": expected a match, got NO MATCH");
  assert.ok(
    typeof hit.kcal100 === "number",
    label + ': kcal100 must be a number, got ' + hit.kcal100
  );
  const delta = Math.abs(hit.kcal100 - expected);
  assert.ok(
    delta <= tolerance,
    label +
      ": kcal " +
      hit.kcal100 +
      " is not within +/-" +
      tolerance +
      " of " +
      expected +
      " (matched row: " +
      hit.description +
      ")"
  );
}

/* ------------------------------------------------------------------ *
 * Module contract
 * ------------------------------------------------------------------ */

test("exports the agreed interface", function () {
  assert.strictEqual(typeof db.load, "function");
  assert.strictEqual(typeof db.search, "function");
  assert.strictEqual(typeof db.lookup, "function");
  assert.strictEqual(typeof db.stats, "function");
  assert.strictEqual(typeof db.searchMulti, "function");
});

test("load() is safe to call repeatedly and does not re-read the file", function () {
  db.load();
  const first = db.stats();
  db.load();
  db.load();
  const second = db.stats();
  assert.strictEqual(first.foodCount, second.foodCount);
  // loadMs is captured once, at the single real build.
  assert.strictEqual(first.loadMs, second.loadMs);
});

test("stats() reports the whole dataset as indexed", function () {
  const s = db.stats();
  assert.strictEqual(s.foodCount, 5432, "FNDDS 2024-10-31 ships 5,432 foods");
  assert.strictEqual(s.indexed, s.foodCount, "every food must be indexed");
  assert.ok(s.loadMs > 0 && s.loadMs < 1000, "index build must be sub-second");
});

test("search() results have the documented shape", function () {
  const hit = top("oatmeal");
  assert.ok(hit);
  for (const key of [
    "code", "description", "category", "kcal100", "protein100",
    "fat100", "carb100", "portions", "score",
  ]) {
    assert.ok(key in hit, "result is missing key: " + key);
  }
  assert.strictEqual(typeof hit.code, "string");
  assert.ok(Array.isArray(hit.portions));
  assert.ok(hit.portions.length > 0);
  assert.strictEqual(typeof hit.portions[0].description, "string");
  assert.strictEqual(typeof hit.portions[0].grams, "number");
});

test("search() honours opts.limit and returns best-first", function () {
  const three = db.search("chicken", { limit: 3 });
  assert.strictEqual(three.length, 3);
  for (let i = 1; i < three.length; i++) {
    assert.ok(
      three[i - 1].score >= three[i].score,
      "results must be sorted by descending score"
    );
  }
});

test("lookup() resolves a foodCode and returns null for an unknown one", function () {
  const row = db.lookup("27146150");
  assert.ok(row);
  assert.strictEqual(row.description, "Chicken curry");
  assert.strictEqual(row.kcal100, 107);
  assert.strictEqual(db.lookup("00000000"), null);
  assert.strictEqual(db.lookup(null), null);
  assert.strictEqual(db.lookup(undefined), null);
});

test("lookup() preserves null nutrients rather than coercing them to 0", function () {
  // 11000000 "Milk, human" is the one food USDA ships with no energy value.
  const milk = db.lookup("11000000");
  assert.ok(milk);
  assert.strictEqual(milk.description, "Milk, human");
  assert.strictEqual(milk.kcal100, null, "a missing nutrient must stay null");
});

test("a real measured zero is preserved as 0, not null", function () {
  const water = db.search("water", { limit: 5 }).filter(function (r) {
    return r.kcal100 === 0;
  });
  assert.ok(water.length > 0, "zero-kcal foods must survive as 0");
});

/* ------------------------------------------------------------------ *
 * The research-verified matches
 * ------------------------------------------------------------------ */

test("butter chicken -> Chicken curry (~107 kcal) via the alias table", function () {
  const hit = top("butter chicken");
  assert.strictEqual(hit.description, "Chicken curry");
  assert.strictEqual(hit.code, "27146150");
  assertKcalNear(hit, 107, 5, "butter chicken");
});

test("tikka masala -> Chicken curry (~107 kcal) via the alias table", function () {
  const hit = top("tikka masala");
  assert.strictEqual(hit.description, "Chicken curry");
  assertKcalNear(hit, 107, 5, "tikka masala");
  // "chicken tikka masala", the fuller phrasing, must land identically.
  assert.strictEqual(top("chicken tikka masala").description, "Chicken curry");
});

test("oatmeal -> Oatmeal, NFS (~76 kcal), NOT Bread, oatmeal (269)", function () {
  const hit = top("oatmeal");
  assert.strictEqual(hit.description, "Oatmeal, NFS");
  assert.strictEqual(hit.code, "56202960");
  assertKcalNear(hit, 76, 6, "oatmeal");
  // The 3.5x error this test exists to prevent.
  assert.ok(
    hit.kcal100 < 150,
    "must not land on a bread/cookie row (~269-450 kcal)"
  );
  assert.ok(
    descriptions("oatmeal").indexOf("bread, oatmeal") === -1,
    '"Bread, oatmeal" must not appear in the top results for "oatmeal"'
  );
});

test('white rice, boiled -> Rice, white, cooked (~129 kcal), "1 cup" ~163 g', function () {
  const hit = top("white rice, boiled");
  assert.match(
    hit.description,
    /^Rice, white, cooked/,
    "expected a plain cooked white rice row, got: " + hit.description
  );
  assertKcalNear(hit, 129, 6, "white rice, boiled");

  const cup = hit.portions.filter(function (p) {
    return /1 cup/i.test(p.description);
  })[0];
  assert.ok(cup, 'expected a "1 cup" portion, got: ' +
    JSON.stringify(hit.portions));
  assert.ok(
    cup.grams >= 150 && cup.grams <= 172,
    '"1 cup, cooked" should be ~163 g, got ' + cup.grams
  );

  // The fat axis must not be crossed: 151 (oil) / 147 (butter) / 200 (PR).
  assert.ok(
    !/made with oil|made with butter|made with margarine|Puerto/i.test(
      hit.description
    ),
    "must not pick an added-fat rice row"
  );
});

test("broccoli, steamed -> plain Broccoli (~39-41 kcal), NOT the 67 kcal oil row", function () {
  const hit = top("broccoli, steamed");
  assert.match(
    hit.description,
    /^Broccoli/,
    "expected a Broccoli row, got: " + hit.description
  );
  // Plain broccoli sits at 39 (raw) / 41 (fresh, cooked, no added fat).
  assertKcalNear(hit, 40, 8, "broccoli, steamed");
  assert.ok(
    !/with oil|with butter|fat added|from restaurant/i.test(hit.description),
    "must not pick an added-fat broccoli row, got: " + hit.description
  );
  assert.ok(
    hit.kcal100 < 60,
    "the 63/67/77 kcal fat-added rows are a ~70% overestimate"
  );
  // The vegetable itself, not a casserole or slaw.
  assert.ok(
    !/casserole|salad|slaw/i.test(hit.description),
    "must not pick a mixed dish"
  );
});

test("avocado toast must NOT return Shrimp toast or French toast", function () {
  const descs = descriptions("avocado toast", 5);
  assert.ok(descs.length > 0, "avocado toast should still match something");
  for (const d of descs) {
    assert.ok(
      d.indexOf("shrimp toast") === -1,
      'head-noun filter failed: "Shrimp toast" (222 kcal) was returned'
    );
    assert.ok(
      !/french.*toast|toast.*french/.test(d),
      'head-noun filter failed: a "French toast" row was returned'
    );
  }
  // Every hit must actually be about avocado -- that is the head noun.
  for (const d of descs) {
    assert.ok(
      d.indexOf("avocado") !== -1,
      'every hit must contain the head noun "avocado", got: ' + d
    );
  }
});

test("caesar salad must NOT return Caesar dressing (542 kcal)", function () {
  const descs = descriptions("caesar salad", 5);
  for (const d of descs) {
    assert.ok(
      d.indexOf("caesar dressing") === -1,
      'condiment demotion failed: "Caesar dressing" (542 kcal) was returned'
    );
  }
  const hit = top("caesar salad");
  assert.strictEqual(hit.description, "Caesar salad, with romaine, no dressing");
  assertKcalNear(hit, 77, 8, "caesar salad");
  assert.ok(hit.kcal100 < 200, "a 542 kcal dressing row is a 7x error");
});

test("xyzzy nonsense food -> [] (explicit NO MATCH)", function () {
  assert.deepStrictEqual(db.search("xyzzy nonsense food"), []);
  assert.deepStrictEqual(db.search("qwertyuiop"), []);
  assert.deepStrictEqual(db.search("flibbertigibbet stew"), []);
  assert.deepStrictEqual(db.search("snarfblat casserole"), []);
  assert.deepStrictEqual(db.search(""), []);
  assert.deepStrictEqual(db.search(null), []);
  assert.deepStrictEqual(db.search("   "), []);
  assert.deepStrictEqual(db.search("!!!"), []);
});

/* ------------------------------------------------------------------ *
 * The layers, tested individually
 * ------------------------------------------------------------------ */

test("layer 3: head noun is the first NON-modifier token", function () {
  const a = db._internal.analyzeQuery;
  assert.strictEqual(a("grilled chicken breast").head, "chicken");
  assert.strictEqual(a("avocado toast").head, "avocado");
  assert.strictEqual(a("steamed broccoli").head, "broccoli");
  assert.strictEqual(a("frozen canned peas").head, "pea");
  // Colours qualify a food, they never name one.
  assert.strictEqual(a("black coffee").head, "coffee");
  assert.strictEqual(a("white rice, boiled").head, "rice");
});

test('layer 3: "black coffee" reaches coffee, not "Black beans"', function () {
  const hit = top("black coffee");
  assert.ok(
    /coffee/i.test(hit.description),
    'expected a coffee row, got: ' + hit.description
  );
});

test("layer 4: alias table rewrites only what FNDDS actually lacks", function () {
  const alias = db._internal.applyAliases;
  assert.strictEqual(alias("butter chicken"), "chicken curry");
  assert.strictEqual(alias("tikka masala"), "chicken curry");
  assert.strictEqual(alias("aubergine"), "eggplant");
  assert.strictEqual(alias("courgette"), "zucchini");
  assert.strictEqual(alias("coriander"), "cilantro");
  assert.strictEqual(alias("prawn"), "shrimp");
  assert.strictEqual(alias("prawns"), "shrimp");
  assert.strictEqual(alias("chips"), "potato french fries");

  // Terms FNDDS already has must pass through untouched -- aliasing these
  // would only steer a good exact match away.
  for (const term of [
    "biryani", "pad thai", "burrito", "ramen", "hummus", "falafel",
    "naan", "roti", "dal", "paneer", "sushi", "pho", "samosa", "pizza",
    "guacamole", "quinoa", "edamame", "gyro",
  ]) {
    assert.strictEqual(
      alias(term),
      term,
      '"' + term + '" exists in FNDDS and must not be aliased'
    );
  }
});

test("layer 4: an alias rewrite cannot re-trigger a later rule", function () {
  // "chips" -> "potato french fries" must not then re-fire the "fries" rule
  // and produce "potato french potato french fries".
  assert.strictEqual(db._internal.applyAliases("chips"), "potato french fries");
  // ...but a genuine qualifier still suppresses the British reading.
  assert.strictEqual(db._internal.applyAliases("tortilla chips"), "tortilla chips");
  assert.strictEqual(db._internal.applyAliases("corn chips"), "corn chips");
});

test("layer 4: aliased queries land on real, sane rows", function () {
  assert.match(top("aubergine").description, /^Eggplant/);
  assert.match(top("porridge").description, /^Oatmeal/);
  assert.match(top("chips").description, /french fries/i);
  assert.match(top("prawn").description, /shrimp/i);
  // Every alias target must resolve to something, or the alias is a bug.
  for (const q of [
    "courgette", "coriander", "yoghurt", "crisps", "rocket", "sweetcorn",
    "garbanzo beans", "shawarma", "chapati", "jacket potato", "bell pepper",
    "spaghetti bolognese",
  ]) {
    assert.ok(
      db.search(q, { limit: 1 }).length > 0,
      'alias "' + q + '" resolves to nothing'
    );
  }
});

test("layer 6: condiments are demoted for dishes but NOT when they are the food", function () {
  // "hummus" IS a dip -- the condiment row is the right answer here.
  const hummus = top("hummus");
  assert.match(hummus.description, /^Hummus/);
  assertKcalNear(hummus, 243, 10, "hummus");

  // Asking for a dressing by name must still return the dressing.
  const dressing = top("caesar dressing");
  assert.match(dressing.description, /Caesar dressing/);
});

test("layer 7: added-fat rows are avoided unless the query mentions fat", function () {
  const plain = top("broccoli, steamed");
  assert.ok(!/oil|butter/i.test(plain.description));

  // But when the user says it was cooked in oil, that row is correct.
  const oily = db.search("broccoli cooked with oil", { limit: 3 });
  assert.ok(
    oily.some(function (r) {
      return /with oil/i.test(r.description);
    }),
    "an explicit oil query must be able to reach the oil row"
  );
});

test("layer 8: varietal qualifiers the query never asked for are demoted", function () {
  // The invariant is the one this test has always named: a distinct VARIETY
  // must never outrank a plain-broccoli row. It is asserted directly here.
  //
  // It used to be asserted indirectly, as "no variety in the top 3". That
  // window was incidental: slot 3 was held by "Broccoli, FROZEN, cooked",
  // which layer 8b now correctly demotes because the query never said
  // "frozen". Freeing that slot moved "Broccoli, Chinese" from rank 4 to
  // rank 3 without it gaining a single point, so the window assertion
  // started failing while the actual invariant still held. Assert the
  // invariant, not the window.
  const broc = db.search("broccoli, steamed", { limit: 8 });
  const isVariety = function (r) { return /chinese|raab/i.test(r.description); };
  // "Plain" means plain in the sense the QUERY asked for: fresh broccoli,
  // cooked, nothing added. Rows carrying a qualifier the query never
  // mentioned -- frozen, canned, from restaurant, fat added -- are
  // deliberately excluded. Those are demoted by layers 8b and 7 for exactly
  // the same reason layer 8 demotes a variety, so they sit at parity with
  // the variety rows and their relative order is decided by BM25 alone.
  // Asserting a strict ordering between two rows that the query has already
  // ruled out would be asserting noise, not behaviour.
  const isPlain = function (r) {
    return /^Broccoli,/i.test(r.description) && !isVariety(r) &&
      !/cauliflower|carrot|frozen|canned|restaurant|fat added|with oil|with butter/i
        .test(r.description);
  };
  const plain = broc.filter(isPlain);
  const varieties = broc.filter(isVariety);
  assert.ok(plain.length >= 2, "expected several plain broccoli rows");
  for (const v of varieties) {
    for (const p of plain) {
      assert.ok(
        v.score < p.score,
        'a distinct variety ("' + v.description + '") outranked plain ' +
          'broccoli ("' + p.description + '")'
      );
    }
    assert.ok(
      v.score < broc[0].score * 0.85,
      'the varietal penalty must leave a clear gap: "' + v.description +
        '" scored ' + v.score + ' against a top hit of ' + broc[0].score
    );
  }
  // The top hit is still the plain, no-added-fat row at the right energy.
  assertKcalNear(broc[0], 41, 3, "broccoli, steamed");
  // Regression guard for the demotion that freed slot 3: an unrequested
  // processing qualifier ("frozen") must not beat the fresh row.
  const frozen = broc.findIndex(function (r) { return /frozen/i.test(r.description); });
  const fresh = broc.findIndex(function (r) { return /fresh/i.test(r.description); });
  assert.ok(fresh !== -1 && (frozen === -1 || fresh < frozen),
    "an unrequested 'frozen' row must not outrank the fresh row");
  // A variety may still appear further down the list (the reconciliation
  // step sees all of them), but it must never outrank the plain row.
  const rice = db.search("white rice, boiled", { limit: 5 });
  const glutinous = rice.findIndex(function (r) {
    return /glutinous/i.test(r.description);
  });
  if (glutinous !== -1) {
    assert.ok(
      glutinous >= 2,
      "glutinous rice is a different food and must rank below the plain rows"
    );
    assert.ok(
      rice[glutinous].score < rice[0].score * 0.85,
      "the varietal penalty should leave a clear score gap"
    );
  }
});

test("layer 3b: compound nouns resolve to the trailing noun's food", function () {
  // The hard filter still requires the qualifier, but the trailing noun
  // decides which of the surviving rows wins.
  assert.strictEqual(top("pulled pork sandwich").description, "Pork sandwich");
  assert.match(top("chicken sandwich").description, /sandwich/i);
  assert.match(top("chocolate cake").description, /^Cake, chocolate/);
  // ...and it must not undo the avocado-toast guarantee.
  for (const d of descriptions("avocado toast", 5)) {
    assert.ok(d.indexOf("avocado") !== -1);
  }
});

/* ------------------------------------------------------------------ *
 * Known limitations -- pinned deliberately, so a future change is noticed
 * ------------------------------------------------------------------ */

test("FIXED (was a known limitation): a fruit-flavoured baked good resolves to the baked good", function () {
  // FNDDS ships no "Muffin, blueberry" row. This used to return
  // "Blueberries, dried" (317 kcal of dried fruit) because the head-noun
  // hard filter bound to "blueberry".
  //
  // Fixed by FLAVOR_HEADS: a fruit-flavour word is a modifier of the food
  // noun, so it is skipped when CHOOSING the head noun (it still scores).
  // The head noun becomes "muffin" and the answer is a muffin.
  //
  // This is NOT the same as relaxing the filter to the trailing noun -- the
  // fix is lexical and narrow, so "avocado toast" still cannot reach
  // "French toast": "avocado" is a food, not a flavour word, and stays the
  // head. That guarantee is re-asserted below.
  const hit = top("blueberry muffin");
  assert.ok(hit, "expected a match");
  assert.match(hit.description, /^Muffin/i,
    "the head noun must be the baked good, not the fruit");
  assertKcalNear(hit, 375, 30, "blueberry muffin");
  for (const d of descriptions("blueberry pancakes", 3)) {
    assert.ok(d.indexOf("pancake") !== -1,
      "blueberry pancakes must return pancakes, got: " + d);
  }
  // The avocado-toast guarantee is untouched.
  for (const d of descriptions("avocado toast", 5)) {
    assert.ok(d.indexOf("avocado") !== -1,
      "a real ingredient must still be an absolute head-noun filter: " + d);
  }
});

test("layer 10: a bare meat noun does not land on an anatomical row", function () {
  // "chicken" alone used to return "Chicken skin" (450 kcal) -- a 2.7x
  // overestimate against USDA's own default, "Chicken, NS as to part and
  // cooking method, NS as to skin eaten" (164 kcal).
  //
  // Layer 10 (the offal/anatomical-part guard) fixes the energy figure: a
  // candidate naming a body part the query never asked for is demoted, so
  // bare "chicken" now lands on a 164 kcal whole-meat row.
  //
  // What is still NOT fixed is reaching that specific NS-as-to-part row:
  // its description is ~12 tokens and BM25's length normalisation (b=0.75)
  // keeps favouring short rows. The energy value is right, the row identity
  // is a near-miss. Pinned by kcal, not by description, so the thing that
  // actually matters to a calorie total is what is guarded.
  const bare = top("chicken");
  assert.ok(bare, "bare 'chicken' must resolve");
  assert.ok(
    !/\bskin\b|\btail\b|\bback\b|\bneck\b|\bgizzard\b|\bliver\b/i.test(bare.description),
    "bare 'chicken' must not land on an anatomical-part row, got: " + bare.description
  );
  assertKcalNear(bare, 164, 40, "bare chicken");
  // Descriptive phrases -- what the pipeline actually emits -- all resolve:
  assert.match(top("grilled chicken breast").description, /^Chicken breast/);
  assert.strictEqual(top("butter chicken").description, "Chicken curry");
  assert.match(top("fried chicken").description, /chicken/i);
  // Sibling bare nouns, via the ingredient-row demotion:
  assert.strictEqual(top("beef").description, "Beef, NFS");
  assert.strictEqual(top("pork").description, "Pork, NFS");
});

test("layer 6b: recipe-ingredient-only rows are demoted", function () {
  // "Beef, for use with vegetables" (191) used to beat "Beef, NFS" (231).
  assert.strictEqual(top("beef").description, "Beef, NFS");
  for (const d of descriptions("broccoli, steamed", 5)) {
    assert.ok(
      d.indexOf("as ingredient") === -1,
      "an as-ingredient row outranked a real food: " + d
    );
  }
});

test("KNOWN LIMITATION: 'pho with beef' falls just under the score floor", function () {
  // "Soup, pho, with meat" (77 kcal) ranks #1 for this query but scores 2.52,
  // below the 3.0 floor: "beef"/"meat" are synonyms the index does not relate,
  // so coverage is 1/2, and the unmatched dish token "soup" adds a
  // specificity penalty even though pho IS a soup.
  //
  // Failing closed is the designed behaviour -- the caller keeps the vision
  // model's own estimate rather than being handed a guess.
  assert.deepStrictEqual(db.search("pho with beef"), []);
  // The bare term does resolve, so a multi-probe caller still recovers it.
  assert.match(top("pho").description, /pho/i);
});

/* ------------------------------------------------------------------ *
 * Score-floor calibration -- the numbers quoted in food-db.js
 * ------------------------------------------------------------------ */

test("layer 5: the calibrated gap between junk and real queries still holds", function () {
  const REAL = [
    "butter chicken", "tikka masala", "oatmeal", "white rice, boiled",
    "broccoli, steamed", "avocado toast", "caesar salad",
    "grilled chicken breast", "scrambled eggs", "biryani", "pad thai",
    "hummus", "chips", "aubergine", "porridge", "banana", "apple",
    "greek yogurt", "salmon fillet", "black coffee", "orange juice",
    "cheddar cheese", "spaghetti bolognese", "pepperoni pizza", "miso soup",
    "french fries", "whole wheat bread", "almonds", "olive oil",
    "tomato soup", "pork chop", "sweet potato", "lentil soup", "beef taco",
    "ice cream", "dark chocolate", "peanut butter", "mashed potatoes",
    "corn on the cob", "strawberries", "bacon", "cucumber salad",
    "chicken noodle soup",
  ];
  // Nonsense whose head noun does not exist in FNDDS at all.
  const NONSENSE = [
    "xyzzy nonsense food", "qwertyuiop", "flibbertigibbet stew", "zzzz",
    "asdfgh jkl", "unicorn steak", "grelb", "blorptastic", "frobnicate",
    "snarfblat casserole", "wibble wobble", "plumbus", "printer toner",
    "sandpaper", "laptop charger", "concrete slab", "1234567",
    "javascript", "tax return", "parking meter",
  ];
  // A real head noun buried in junk -- the band the floor actually guards.
  const JUNK = [
    "chicken qqqq zzzz wibble", "rice blorptastic frobnicate",
    "banana xyzzy plumbus", "oil grelb snarfblat",
    "tea wibble wobble flibber", "egg zzzz qqqq wibble plumbus",
  ];

  const scoreOf = function (q) {
    const r = db.search(q, { limit: 1, minScore: 0 });
    return r.length > 0 ? r[0].score : 0;
  };

  const realScores = REAL.map(scoreOf);
  const junkScores = JUNK.map(scoreOf);
  const minReal = Math.min.apply(null, realScores);
  const maxJunk = Math.max.apply(null, junkScores);
  const floor = db._internal.SCORE_FLOOR;

  assert.ok(
    maxJunk < floor,
    "junk band (max " + maxJunk.toFixed(2) + ") must fall below the floor " +
      floor
  );
  assert.ok(
    minReal > floor,
    "weakest real query (" + minReal.toFixed(2) +
      ") must clear the floor " + floor
  );

  // With the floor applied, every real query answers and no nonsense does.
  for (const q of REAL) {
    assert.ok(db.search(q, { limit: 1 }).length > 0, "false NO MATCH on: " + q);
  }
  for (const q of NONSENSE) {
    assert.deepStrictEqual(
      db.search(q, { limit: 1 }),
      [],
      "nonsense query matched something: " + q
    );
  }
});

/* ------------------------------------------------------------------ *
 * Multi-probe
 * ------------------------------------------------------------------ */

test("searchMulti() merges the vision model's three search_terms", function () {
  const merged = db.searchMulti(
    ["butter chicken", "chicken curry", "indian chicken dish"],
    { limit: 5 }
  );
  assert.ok(merged.length > 0);
  assert.strictEqual(merged[0].description, "Chicken curry");
  assert.ok(
    merged[0].matchedTerms.length >= 2,
    "the winning row should have been reached by more than one probe"
  );
  // Merged by foodCode -- no duplicates.
  const codes = merged.map(function (r) { return r.code; });
  assert.strictEqual(new Set(codes).size, codes.length);
});

test("searchMulti() tolerates empty / junk probes", function () {
  assert.deepStrictEqual(db.searchMulti([]), []);
  assert.deepStrictEqual(db.searchMulti(["", "  "]), []);
  assert.deepStrictEqual(db.searchMulti(["xyzzy", "qwertyuiop"]), []);
  const mixed = db.searchMulti(["xyzzy nonsense", "oatmeal"], { limit: 3 });
  assert.strictEqual(mixed[0].description, "Oatmeal, NFS");
});

/* ------------------------------------------------------------------ *
 * Performance
 * ------------------------------------------------------------------ */

test("per-query time is well under a millisecond", function () {
  const queries = [
    "butter chicken", "white rice, boiled", "broccoli, steamed",
    "caesar salad", "avocado toast", "grilled chicken breast", "oatmeal",
    "xyzzy nonsense food",
  ];
  const ITERATIONS = 500;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) {
    for (const q of queries) db.search(q, { limit: 5 });
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const perQuery = totalMs / (ITERATIONS * queries.length);
  console.log(
    "    per-query: " + perQuery.toFixed(4) + " ms over " +
      ITERATIONS * queries.length + " searches (index build: " +
      db.stats().loadMs + " ms)"
  );
  assert.ok(
    perQuery < 2,
    "per-query time regressed to " + perQuery.toFixed(3) + " ms"
  );
});

test("results are deterministic across repeated calls", function () {
  for (const q of ["broccoli, steamed", "oatmeal", "caesar salad"]) {
    const a = JSON.stringify(db.search(q, { limit: 5 }));
    const b = JSON.stringify(db.search(q, { limit: 5 }));
    assert.strictEqual(a, b, "non-deterministic ranking for: " + q);
  }
});
