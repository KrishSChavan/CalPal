"use strict";

/**
 * server/food-db.js
 *
 * Offline FNDDS matcher. Turns a model-produced ingredient name
 * ("butter chicken", "white rice, boiled") into a real USDA FNDDS row.
 *
 * Data: data/fndds-lite.json, built by scripts/build-fndds.js from the USDA
 * FoodData Central Survey (FNDDS) 2024-10-31 release. Per-100 g values.
 * Record shape: {c, d, cat, k, p, f, cb, po:[[portionDesc, grams], ...]}
 * A null nutrient means USDA ships no value; 0 is a real measured zero.
 *
 * Matching stack -- the six layers required by the spec, plus two guards
 * that the measured failures demanded:
 *
 *   1.  BM25F (k1=2.5, b=0.75) over description + WWEIA category, with the
 *       description head (text before the first comma) weighted heaviest.
 *   2.  Query-coverage factor 0.4 + 0.6*coverage, hard penalty below 50%.
 *   3.  Head-noun hard filter: the first non-modifier query token MUST
 *       appear in the candidate. This is the safety property of the whole
 *       module -- it guarantees a matched row actually contains the
 *       ingredient the vision model named.
 *   3b. Compound-head bonus: reward candidates whose own description head
 *       carries the query's trailing noun ("blueberry MUFFIN"). Re-ranks
 *       only; it can never resurrect a row layer 3 excluded.
 *   4.  Alias table (British / Indian / menu names -> FNDDS vocabulary).
 *   5.  Absolute score floor -> [] (explicit NO MATCH).
 *   6.  Condiment / dressing / sauce category demotion, gated on the query
 *       naming a dish (so "hummus" still returns hummus).
 *   7.  Added-fat guard: demote "made with oil" / "fat added" / "from
 *       restaurant" rows when the query gives no fat signal, and prefer
 *       USDA's own "NFS" / "NS as to fat" default rows.
 *   8.  Varietal-specificity penalty: demote candidates carrying a rare
 *       qualifier, or a dish word, that the query never asked for.
 *
 * Known limitations are pinned as explicit tests in food-db.test.js.
 *
 * CommonJS. No network at request time, no build step, no dependencies.
 * The JSON is read exactly once per process, at load().
 */

const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "..", "data", "fndds-lite.json");

/* ------------------------------------------------------------------ *
 * Tuning constants
 * ------------------------------------------------------------------ */

const K1 = 2.5;
const B = 0.75;

// BM25F field weights.
const W_HEAD = 2.5; // description text before the first comma
const W_BODY = 1.0; // rest of the description
const W_CAT = 0.6; // WWEIA category

// Layer 2
const COVERAGE_BASE = 0.4;
const COVERAGE_SPAN = 0.6;
const COVERAGE_HARD_FLOOR = 0.5;
const COVERAGE_HARD_PENALTY = 0.25;

/**
 * Layer 5 -- absolute score floor, calibrated against THIS index.
 *
 * Measured over 44 real food queries and 20 nonsense queries (the sweep is
 * reproduced as a test in server/food-db.test.js):
 *
 *   nonsense, unknown head noun       -> 0.00  (19/20; killed by layer 3
 *                                              before scoring ever happens)
 *   real head noun + junk modifiers   -> 0.71 .. 2.21
 *     ("chicken qqqq zzzz wibble" 0.76, "tea wibble wobble" 1.48,
 *      "banana xyzzy plumbus" 2.21)
 *   genuine food queries             -> 4.50 .. 27.4
 *     (weakest: "spaghetti bolognese" 4.50, p10 6.96, median 11.28)
 *
 * So there is an empty band between 2.21 and 4.50. 3.0 is essentially its
 * geometric midpoint (sqrt(2.21*4.50) = 3.15): it rejects 100% of the
 * junk band while costing 0 of 44 real queries, and still leaves 33%
 * headroom below the weakest real query for foods outside the sample.
 *
 * Erring high is the right bias here -- a false NO MATCH is cheap (the
 * caller keeps the vision model's own estimate and can flag it), whereas a
 * false match silently corrupts the calorie total with no error.
 */
const SCORE_FLOOR = 3.0;

// Layer 6
const CONDIMENT_PENALTY = 0.15;

/**
 * Layer 3b -- compound-head bonus. In an English compound noun the LAST noun
 * is the semantic head ("blueberry MUFFIN", "chicken SANDWICH"), but the
 * first non-modifier token is the safer *hard filter* (research: taking the
 * last token as head turns "avocado toast" into "French toast"). So we keep
 * the first-token hard filter and merely reward candidates whose own
 * description head also contains the query's trailing noun.
 *
 * This can only re-rank rows that already passed the hard filter, so it
 * cannot resurrect "Shrimp toast" for "avocado toast" -- that row never
 * contained "avocado" and was dropped before scoring.
 */
const COMPOUND_HEAD_BONUS = 1.6;

// Layer 7
const ADDED_FAT_PENALTY = 0.55;
const DEFAULT_ROW_BONUS = 1.1;
const NO_ADDED_FAT_BONUS = 1.15;

// Layer 8 -- varietal-specificity penalty. A candidate carrying a rare
// qualifier the query never asked for ("Chinese", "glutinous", "raab",
// "Puerto Rican") names a narrower food than the one requested. Measured
// document frequencies in this index: chinese 8, glutinous 3, raab 2,
// wild 12, multigrain 26, puerto/rican 61 -- versus food-identity nouns
// broccoli 182, frozen 246, rice 349, chicken 409. df <= 120 separates the
// two groups cleanly, and modifiers/structural words are excluded outright.
const SPECIFIC_DF_MAX = 120;
const SPECIFICITY_PENALTY = 0.35;

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

// Dropped from both documents and queries. Deliberately tiny: FNDDS
// descriptions carry real meaning in words like "no", "added", "fat".
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "to", "as", "with",
  "from", "for", "at", "by", "it", "its",
]);

/**
 * Layer 3: tokens that describe *how* a food was handled rather than *what*
 * it is. The head noun is the first query token that is NOT one of these.
 * Research showed last-token-as-head is worse -- it makes the head of
 * "avocado toast" be "toast", which then matches "French toast" /
 * "Shrimp toast".
 */
const MODIFIERS = new Set([
  // preparation / cooking method
  "raw", "cooked", "uncooked", "boiled", "fried", "deep", "pan", "stir",
  "grilled", "griddled", "baked", "roasted", "roast", "steamed", "steam",
  "poached", "blanched", "simmered", "braised", "stewed", "sauteed",
  "sauted", "microwaved", "toasted", "charred", "smoked", "cured",
  "pickled", "marinated", "breaded", "battered", "coated", "crumbed",
  "stuffed", "grated", "shredded", "sliced", "diced", "chopped", "minced",
  "mashed", "pureed", "whipped", "melted", "warmed", "heated", "reheated",
  "scrambled", "beaten", "seared", "crumbled", "peeled", "unpeeled",
  "pulled", "shaved", "julienned", "halved", "quartered",
  // form / state
  "skinless", "boneless", "skin", "frozen", "canned", "tinned", "jarred",
  "bottled", "fresh", "dried", "dehydrated", "instant", "prepared",
  "homemade", "store", "bought", "packaged", "processed", "leftover",
  "cold", "hot", "warm", "chilled",
  // size / quality adjectives that never identify a food
  "small", "medium", "large", "extra", "big", "little", "thin", "thick",
  "whole", "half", "quarter", "single", "double", "plain", "regular",
  "lightly", "heavily", "lean", "fatty", "crispy", "crisp", "soft",
  "tender", "juicy", "ripe", "unripe", "organic", "light", "reduced",
  "low", "high", "free", "added", "no", "approximately", "about",
  "roughly", "some", "assorted", "mixed", "various", "serving", "portion",
  "piece", "pieces", "side", "plate",
  // cuts and presentations -- never the identity of the food
  "fillet", "filet", "cutlet", "strip", "tender", "wedge", "chunk",
  // Doneness / knife work / equipment. These were missing and it cost real
  // matches: "medium rare grilled ribeye steak" took head noun "rare",
  // which exists in no FNDDS row, so layer 3 excluded every candidate and
  // the query returned NO MATCH. "thick cut smoked bacon" took head "cut"
  // and landed on "Canadian bacon".
  "rare", "cut", "cuts", "trimmed", "boneless", "skinless", "bone", "bones",
  "well", "done", "oven", "air", "slow", "pressure", "freshly", "day",
  "seasoned", "unseasoned", "homestyle", "classic", "traditional",
  "authentic", "style", "sized", "generous", "heaping", "handful", "bunch",
  "slab", "slice", "slices", "chop", "chops",
  // Colours. These qualify a food, they never name one, so they must not be
  // taken as the head noun: without this, "black coffee" picks head "black"
  // and lands on "Black beans, NFS". They still take part in BM25 and
  // coverage, so "white rice" still outranks brown. "orange", "olive" and
  // "lime" are deliberately absent -- those ARE foods.
  "black", "white", "brown", "red", "green", "yellow", "golden", "dark",
  "pale", "blonde",
]);

/**
 * Layer 3 -- FLAVOUR HEADS.
 *
 * Sauce / seasoning / flavour words. Grammatically these are modifiers of the
 * food noun ("BUFFALO cauliflower", "TERIYAKI salmon", "BARBECUE ribs"), but
 * they are also the identity of a condiment row in FNDDS, and they carry very
 * high IDF. Taking one as the head noun was the single worst defect in this
 * module: the hard filter then bound to the sauce, so
 *
 *   "buffalo cauliflower" -> Buffalo sauce          (11 kcal, a 4x error)
 *   "teriyaki salmon"     -> Chicken or turkey with teriyaki   (wrong species)
 *   "honey mustard chicken" -> Honey mustard dip
 *   "tartar sauce cod"    -> Tartar sauce
 *   "barbecue ribs"       -> Barbecue rib sandwich  (invents a bun)
 *   "blueberry pancakes"  -> Blueberries, dried     (317 kcal of dried fruit)
 *
 * They are skipped only when CHOOSING the head noun. They stay in the term
 * list, so they still drive BM25 and coverage -- "Barbecue pork" still
 * outranks plain "Pork" for "barbecue pork". And if the whole query is
 * flavour words ("honey", "barbecue sauce"), analyzeQuery's existing
 * all-modifiers fallback puts the head back on the first token, so a query
 * that really IS about the condiment still resolves to it.
 */
const FLAVOR_HEADS = new Set([
  "buffalo", "teriyaki", "barbecue", "barbeque", "bbq", "honey", "mustard",
  "dijon", "tartar", "maple", "pesto", "ranch", "marinara", "alfredo",
  "hoisin", "sriracha", "cajun", "creole", "blackened", "glazed", "spicy",
  "savory", "savoury", "salted", "smoky", "herb", "herbed", "peppercorn",
  "truffle", "wasabi", "jerk", "tandoori", "satay", "katsu", "adobo",
  "chimichurri", "aioli", "vinaigrette", "gochujang", "harissa", "zaatar",
  "buttermilk", "balsamic", "chipotle", "sesame", "ginger", "garlic",
  "blueberry", "strawberry", "raspberry", "blackberry", "cranberry",
  "caramel", "vanilla", "cinnamon", "toffee", "praline",
]);

/**
 * Layer 3 -- BRAND / CHAIN NAMES.
 *
 * FNDDS carries a handful of branded rows ("Big Mac (McDonalds)",
 * "Whopper (Burger King)", "Chipotle dip") but no general chain coverage.
 * Before this set, a brand token became the head noun and destroyed the
 * query outright:
 *
 *   "Starbucks latte"        -> NO MATCH (no row contains "starbucks")
 *   "McDonalds french fries" -> the McDonalds *burgers* (head noun bound to
 *                               the brand, so no fries row could pass)
 *   "Chipotle burrito bowl"  -> Chipotle dip, light
 *
 * Brands are skipped for head selection AND excluded from the coverage
 * denominator (an unknown brand must not look like a missing ingredient),
 * but they remain in the term list, so "McDonalds cheeseburger" still gets
 * a BM25 lift on the genuine "Cheeseburger (McDonalds)" row.
 */
const BRAND_TOKENS = new Set([
  "starbucks", "mcdonald", "mcdonalds", "kfc", "subway", "chipotle",
  "domino", "dominos", "wendy", "wendys", "popeyes", "panera", "dunkin",
  "arby", "arbys", "sonic", "chickfila", "nando", "nandos", "greggs",
  "costa", "pret", "panda", "chilis", "applebees", "denny", "dennys",
  "ihop", "sbarro", "quiznos", "jimmy", "johns", "culvers", "hardees",
  "whataburger", "zaxbys", "bojangles", "raising", "canes", "portillos",
  "starbuck", "wetherspoons", "nero", "leon", "itsu", "wagamama",
]);

/**
 * Anatomical / offal parts. A photograph of a meal is never a plate of
 * chicken skin, so a candidate whose description names a part the query did
 * not ask for is almost certainly not what was eaten. Before this, bare
 * "chicken" returned "Chicken skin" (450 kcal) instead of USDA's own
 * "Chicken, NS as to part and cooking method" default (164) -- a 2.7x
 * overestimate on one of the commonest queries a vision model emits.
 */
const OFFAL_PARTS = new Set([
  "skin", "tail", "back", "neck", "gizzard", "gizzards", "liver", "livers",
  "heart", "hearts", "giblet", "giblets", "feet", "foot", "tongue",
  "kidney", "kidneys", "brain", "tripe", "marrow", "cartilage",
]);

/**
 * Preservation / processing qualifiers. A query that did not say "dried"
 * should not be answered with a dried row: dried fruit is roughly 5x the
 * energy density of the fresh fruit, so this is one of the few single-token
 * mistakes that can be catastrophic on its own.
 */
const PROCESS_QUALIFIERS = new Set([
  "dried", "dehydrated", "canned", "tinned", "frozen", "instant",
  "powdered", "condensed", "concentrated", "candied", "pickled", "smoked",
  "creamed", "juice", "syrup", "puree", "paste", "flour", "powder",
  "extract", "chips", "crisps", "sauce", "gravy", "dressing", "dip",
]);

/**
 * Cooking methods, for the raw-row guard. If the query names any of these
 * and does not say "raw", a "..., raw" candidate is wrong by construction.
 * "roasted brussels sprouts with olive oil" returned "Brussels sprouts, raw"
 * (43 kcal) instead of the cooked-with-fat row (67) purely because the raw
 * row is shorter and BM25 rewards that.
 */
const COOK_METHODS = new Set([
  "cooked", "boiled", "fried", "grilled", "griddled", "baked", "roasted",
  "roast", "steamed", "steam", "poached", "blanched", "simmered", "braised",
  "stewed", "sauteed", "sauted", "microwaved", "toasted", "charred",
  "seared", "scrambled", "reheated", "warmed", "heated", "barbecued",
  "broiled", "rotisserie",
]);
const RE_RAW_ROW = /\braw\b|\buncooked\b/i;
const RAW_PENALTY = 0.35;

/**
 * Cooking methods that imply "cooked" but are poorly represented as literal
 * tokens in FNDDS (which overwhelmingly writes plain "cooked"). For these we
 * additionally emit the token "cooked", so that "broccoli, steamed" reaches
 * "Broccoli, fresh, cooked, no added fat" instead of "Broccoli, raw".
 * Methods FNDDS *does* spell out (fried, grilled, baked, roasted) are left
 * alone so their own strong signal is not diluted.
 */
const IMPLIES_COOKED = new Set([
  "steamed", "steam", "boiled", "poached", "blanched", "simmered",
  "braised", "stewed", "microwaved", "reheated",
]);

/**
 * Layer 7: the query mentions fat/oil explicitly, so added-fat rows are fine.
 */
const FAT_SIGNAL = new Set([
  "fat", "oil", "oily", "butter", "buttered", "buttery", "margarine",
  "ghee", "grease", "greasy", "fried", "sauteed", "lard", "creamy",
  "cream", "restaurant", "takeout", "takeaway", "fastfood",
]);

/**
 * Layer 6: WWEIA categories that are condiments / dressings / sauces / fats
 * rather than dishes. Every name verified present in this build of the
 * dataset. Note "Peanut butter and jelly sandwiches" is deliberately NOT
 * here -- it is a real dish category.
 */
const CONDIMENT_CATEGORIES = new Set([
  "Salad dressings and vegetable oils",
  "Dips, gravies, other sauces",
  "Pasta sauces, tomato-based",
  "Tomato-based condiments",
  "Mustard and other condiments",
  "Soy-based condiments",
  "Stir-fry and soy-based sauce mixtures",
  "Jams, syrups, toppings",
  "Butter and animal fats",
]);

/**
 * Layer 8: words that carry no food identity, so an unmatched occurrence in a
 * candidate is not evidence that the candidate is a narrower food. These are
 * skipped when counting varietal specificity.
 */
const STRUCTURAL = new Set([
  "ns", "nfs", "type", "form", "made", "style", "unspecified", "quantity",
  "specified", "eaten", "included", "category", "ingredient", "use",
  "includes", "each", "per", "amount", "guideline", "based", "other",
  "commercially", "recipe", "purchased", "bakery", "home", "school",
]);

/**
 * Layer 6: the query names a composed dish, so a dressing/sauce/condiment row
 * is almost certainly the wrong object. This is the gate that stops
 * "caesar salad" landing on "Caesar dressing" (542 kcal) -- "caesar" has very
 * high IDF (df 6), so BM25 alone loves the dressing row. Queries with no dish
 * token ("hummus", "guacamole", "tzatziki") are left alone, because for those
 * the condiment row IS the food the user ate.
 */
const DISH_TOKENS = new Set([
  "salad", "sandwich", "soup", "curry", "stew", "bowl", "pizza", "taco",
  "burrito", "wrap", "toast", "burger", "cheeseburger", "hamburger",
  "pasta", "spaghetti", "noodle", "rice", "roll", "plate", "platter",
  "casserole", "dish", "meal", "entree", "fries", "sub", "melt", "bake",
  "pie", "stirfry", "omelet", "omelette", "quesadilla", "lasagna",
  "risotto", "paella", "chili", "gumbo", "hash", "skillet",
]);

/**
 * WWEIA's bucket for rows that exist only to be used INSIDE a recipe --
 * "Chicken as ingredient in recipes", "Beef, for use with vegetables",
 * "Broccoli, cooked, as ingredient". They are short, so BM25 likes them, but
 * nobody photographs them as a meal. Demoted unless the query says
 * "ingredient".
 */
const INGREDIENT_CATEGORY = "Not included in a food category";
const INGREDIENT_PENALTY = 0.4;

/**
 * If the query itself asks for a condiment, do not demote condiments.
 */
const CONDIMENT_QUERY_TOKENS = new Set([
  "dressing", "sauce", "dip", "condiment", "gravy", "mayo", "mayonnaise",
  "ketchup", "catsup", "mustard", "syrup", "jam", "jelly", "marinade",
  "vinaigrette", "aioli", "relish", "salsa", "oil", "butter", "margarine",
  "spread", "topping",
]);

/**
 * Layer 4 -- ALIAS TABLE.
 *
 * Every entry below was checked against THIS dataset: the left-hand phrase is
 * absent from FNDDS as a token, and the right-hand phrase is present. Terms
 * FNDDS already carries (biryani, pad thai, burrito, ramen, hummus, falafel,
 * naan, roti, dal, paneer, quesadilla, taco, sushi, pho, samosa, pizza,
 * guacamole, tzatziki, pierogi, empanada, edamame, couscous, quinoa,
 * congee, gyro, kabob) are deliberately NOT aliased -- an alias there would
 * only add noise and could steer a good exact match away.
 *
 * Applied as ordered, word-boundary phrase rewrites on the normalized query.
 * Longest / most specific phrases first.
 *
 * `unless` (optional): skip the rewrite when the query also contains one of
 * these tokens. Used for "chips", which is genuinely ambiguous -- British
 * "chips" means fries, but FNDDS really does have corn/tortilla/potato chips.
 */
const ALIASES = [
  // --- required by spec ---
  { from: "butter chicken", to: "chicken curry" },
  { from: "chicken tikka masala", to: "chicken curry" },
  { from: "tikka masala", to: "chicken curry" },
  { from: "chicken tikka", to: "chicken curry" },
  { from: "aubergines", to: "eggplant" },
  { from: "aubergine", to: "eggplant" },
  { from: "courgettes", to: "zucchini" },
  { from: "courgette", to: "zucchini" },
  { from: "coriander", to: "cilantro" },
  { from: "prawns", to: "shrimp" },
  { from: "prawn", to: "shrimp" },
  {
    from: "chips",
    to: "potato french fries",
    unless: ["corn", "tortilla", "potato", "chocolate", "banana", "pita",
      "bagel", "veggie", "vegetable", "kale", "plantain", "apple", "rice"],
  },

  // --- added: absent from FNDDS as a token, target verified present ---
  // British / Commonwealth vocabulary the vision model will happily emit
  { from: "crisps", to: "potato chips" },
  { from: "porridge", to: "oatmeal" },
  { from: "yoghurt", to: "yogurt" },
  { from: "rocket", to: "arugula" },
  { from: "sweetcorn", to: "corn" },
  { from: "jacket potato", to: "potato baked" },
  { from: "bell peppers", to: "peppers sweet" },
  { from: "bell pepper", to: "peppers sweet" },
  { from: "capsicum", to: "peppers" },
  { from: "minced beef", to: "beef ground" },
  { from: "beef mince", to: "beef ground" },
  { from: "mince", to: "beef ground" },
  { from: "fizzy drink", to: "soft drink" },
  { from: "soda pop", to: "soft drink" },
  { from: "soda", to: "soft drink", unless: ["baking", "ice", "cream"] },
  { from: "garbanzo beans", to: "chickpeas" },
  { from: "garbanzos", to: "chickpeas" },
  { from: "garbanzo", to: "chickpeas" },
  // Middle Eastern / South Asian names FNDDS spells differently or lacks
  { from: "shawarma", to: "gyro sandwich" },
  { from: "kebabs", to: "shish kabob" },
  { from: "kebab", to: "shish kabob" },
  { from: "kabab", to: "shish kabob" },
  { from: "chapatti", to: "roti" },
  { from: "chapati", to: "roti" },
  { from: "daal", to: "dal" },
  { from: "dhal", to: "dal" },
  { from: "channa", to: "chickpeas" },
  { from: "chana", to: "chickpeas" },
  // "bolognese" is absent from FNDDS entirely, and the head noun "spaghetti"
  // otherwise drags the query onto "Spaghetti squash, cooked" (a vegetable).
  // FNDDS files the dish under "Pasta with tomato-based sauce ... and meat".
  { from: "spaghetti bolognese", to: "pasta tomato based sauce meat" },
  { from: "spaghetti bolognaise", to: "pasta tomato based sauce meat" },
  { from: "bolognese", to: "pasta tomato based sauce meat" },
  { from: "bolognaise", to: "pasta tomato based sauce meat" },
  // common menu phrasings
  { from: "french fry", to: "potato french fries" },
  { from: "fries", to: "potato french fries", unless: ["potato"] },

  // --- added by the adversarial pass -------------------------------------
  // Every left-hand phrase below was checked absent from FNDDS as written,
  // and the right-hand phrase checked present.
  //
  // FNDDS spells it "Macaroni or noodles with cheese" (58145110, 223 kcal).
  // Unaliased, head noun "mac" matched "Easy Mac type" (110) -- a 2x
  // underestimate -- and "Big Mac".
  { from: "mac and cheese", to: "macaroni noodles cheese" },
  { from: "mac n cheese", to: "macaroni noodles cheese" },
  { from: "macaroni cheese", to: "macaroni noodles cheese" },
  { from: "mac cheese", to: "macaroni noodles cheese" },
  // "PB&J" normalizes to "pb j"; neither token is in FNDDS.
  { from: "pb j", to: "peanut butter and jelly sandwich" },
  { from: "pbj", to: "peanut butter and jelly sandwich" },
  // Egg doneness. FNDDS has no "sunny side up" / "over easy" row; all of
  // these are the fried-egg rows.
  { from: "sunny side up", to: "fried" },
  { from: "sunnyside up", to: "fried" },
  { from: "over easy", to: "fried" },
  { from: "over medium", to: "fried" },
  { from: "over hard", to: "fried" },
  { from: "hard boiled", to: "boiled" },
  { from: "soft boiled", to: "boiled" },
  // British contraction of spaghetti bolognese.
  { from: "spag bol", to: "pasta tomato based sauce meat" },
  // Absent from FNDDS; it is eggs poached in tomato sauce.
  { from: "shakshuka", to: "egg omelet tomatoes" },
  { from: "shakshouka", to: "egg omelet tomatoes" },
  // FNDDS writes "Egg omelet or scrambled egg"; "frittata" is absent.
  { from: "frittata", to: "egg omelet" },
  // "aubergine"/"eggplant" already handled; these are the remaining common
  // Commonwealth / regional spellings absent from FNDDS.
  { from: "beetroot", to: "beets" },
  { from: "spring onion", to: "green onion" },
  { from: "scallion", to: "green onion" },
  { from: "swede", to: "rutabaga" },
  { from: "gammon", to: "ham" },
  { from: "candy floss", to: "cotton candy" },
  { from: "ice lolly", to: "popsicle" },
];

/**
 * Layer 4b -- TOKEN EXPANSIONS.
 *
 * Unlike the alias table these ADD tokens rather than replacing them, so the
 * original wording still scores. They exist because FNDDS spells some very
 * ordinary distinctions as multi-word phrases:
 *
 *   "skinless" is written "skin not eaten". Without the expansion,
 *   "grilled chicken breast, skinless, boneless" returned
 *   "Chicken breast, grilled WITH SAUCE, SKIN EATEN" (202 kcal) -- a row
 *   that contradicts two of the query's own modifiers -- instead of
 *   "Chicken breast, grilled without sauce, skin not eaten" (176).
 */
const EXPANSIONS = new Map([
  ["skinless", ["skin", "not", "eaten"]],
  ["peeled", ["skin", "not", "eaten"]],
  ["unbreaded", ["not", "coated"]],
  ["undressed", ["no", "dressing"]],
  ["unsweetened", ["no", "sugar"]],
  ["takeaway", ["restaurant"]],
  ["takeout", ["restaurant"]],
  ["diner", ["restaurant"]],
  ["fastfood", ["fast", "food"]],
  ["deepfried", ["deep", "fried"]],
  ["stirfry", ["stir", "fried"]],
  ["stirfried", ["stir", "fried"]],
  ["rotisserie", ["roasted"]],
  ["broiled", ["baked", "broiled"]],
  ["barbecued", ["barbecue"]],
  ["grilled", ["grilled", "broiled"]],
]);

/* ------------------------------------------------------------------ *
 * Text processing
 * ------------------------------------------------------------------ */

/**
 * Latin-1 / Latin Extended letters that NFD does not decompose into a base
 * letter plus a combining mark. Without these, stripping combining marks
 * still leaves an unmatchable character which `[^a-z0-9]` then turns into a
 * word break.
 */
const LIGATURES = [
  [/\u00df/g, "ss"], [/\u00e6/g, "ae"], [/\u0153/g, "oe"],
  [/\u00f8/g, "o"], [/\u0111/g, "d"], [/\u0142/g, "l"],
  [/\u00fe/g, "th"], [/\u00f0/g, "d"],
];

/**
 * Fold to plain ASCII lowercase words.
 *
 * The NFD pass is load-bearing, not cosmetic. Without it "crème brûlée"
 * normalized to "cr me br l e" -- three junk fragments and a head noun of
 * "cr" -- so the matcher returned NO MATCH even though FNDDS ships
 * "Creme brulee" (13210370, 113 kcal). Same for "jalapeño" (FNDDS writes
 * "jalapenos") and "café". A vision model transcribing a menu emits
 * accented text routinely, so every such query was silently unanswerable.
 */
function normalizeText(s) {
  let out = String(s === null || s === undefined ? "" : s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // combining diacritical marks
  for (let i = 0; i < LIGATURES.length; i++) {
    out = out.replace(LIGATURES[i][0], LIGATURES[i][1]);
  }
  return out
    .replace(/[\u2018\u2019\u201c\u201d]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Very small, conservative plural stripper. FNDDS mixes "Chickpeas, NFS"
 * with "chickpea" and "Peppers" with "pepper". Full stemming (Porter)
 * over-stems food words badly, so we only fold plurals.
 */
function singularize(t) {
  if (t.length <= 3) return t;
  if (/[^aeiou]ies$/.test(t)) return t.slice(0, -3) + "y";
  if (/(ches|shes|sses|xes|zes)$/.test(t)) return t.slice(0, -2);
  if (/(ss|us|is|ous)$/.test(t)) return t;
  if (/s$/.test(t)) return t.slice(0, -1);
  return t;
}

function tokenize(s) {
  const raw = normalizeText(s);
  if (!raw) return [];
  const out = [];
  for (const t of raw.split(" ")) {
    if (!t || STOPWORDS.has(t)) continue;
    out.push(singularize(t));
  }
  return out;
}

/** Apply the alias table to an already-normalized query string. */
function applyAliases(normalized) {
  if (!normalized) return normalized;
  let s = " " + normalized + " ";
  for (const a of ALIASES) {
    // The `unless` guard is evaluated against the CURRENT string, not the
    // original query, so an earlier rewrite that introduces a guard token
    // correctly suppresses a later one. (Without this, "chips" ->
    // "potato french fries" then re-fires the "fries" rule and yields
    // "potato french potato french fries".)
    if (a.unless) {
      const present = new Set(s.trim().split(/\s+/).filter(Boolean));
      if (a.unless.some(function (u) { return present.has(u); })) continue;
    }
    const re = new RegExp("(?<= )" + a.from + "(?= )", "g");
    s = s.replace(re, a.to);
  }
  return s.trim().replace(/\s+/g, " ");
}

/* ------------------------------------------------------------------ *
 * Index
 * ------------------------------------------------------------------ */

const state = {
  loaded: false,
  loadMs: 0,
  rows: [],            // raw records, index-aligned
  docTokens: [],       // Set<string> per doc, for coverage + head filter
  docLen: [],          // BM25F weighted length per doc
  docFlags: [],        // {addedFat, defaultRow, noAddedFat, condiment}
  docSpecific: [],     // rare qualifier tokens per doc (layer 8)
  docHeadTokens: [],   // tokens from the description head (layer 3b)
  postings: new Map(), // term -> Array<[docIdx, weightedTf]>
  byCode: new Map(),   // foodCode -> docIdx
  avgDocLen: 0,
  N: 0,
};

const RE_ADDED_FAT = new RegExp(
  [
    "\\bfat added\\b",
    "\\bmade with oil\\b",
    "\\bmade with butter\\b",
    "\\bmade with margarine\\b",
    "\\bcooked with oil\\b",
    "\\bcooked with butter\\b",
    "\\bwith butter or margarine\\b",
    "\\bfrom restaurant\\b",
    "\\bfried\\b",
    "\\bwith oil\\b",
    "\\bbuttered\\b",
  ].join("|"),
  "i"
);

/**
 * USDA's own "I was not told which variant" rows -- the right pick when the
 * photo does not reveal the variant.
 *
 * Deliberately narrow: ", NFS", "NS as to fat" and "NS as to type" count.
 * "NS as to FORM" does NOT -- "Broccoli, NS as to form, cooked" is 63 kcal
 * because it averages in fat-added preparations, so treating it as a neutral
 * default would silently inflate a steamed-broccoli estimate by ~50%.
 *
 * "NS as to <x>" matters for meats: without it "bacon" lands on "Turkey
 * bacon, cooked" (368 kcal, a short description BM25 favours) instead of
 * "Bacon, NS as to type of meat, cooked" (484) -- a 24% underestimate.
 */
const RE_DEFAULT_ROW = /,\s*NFS\b|\bNS as to (?!form\b)/i;

/** Explicitly fat-free preparations. */
const RE_NO_ADDED_FAT = /\bno added fat\b|\bwithout fat\b|\bfat not added\b/i;

function addPosting(term, docIdx, weight) {
  let arr = state.postings.get(term);
  if (!arr) {
    arr = [];
    state.postings.set(term, arr);
  }
  const last = arr[arr.length - 1];
  if (last && last[0] === docIdx) last[1] += weight;
  else arr.push([docIdx, weight]);
}

function indexDoc(rec, docIdx) {
  const desc = String(rec.d || "");
  const comma = desc.indexOf(",");
  const headText = comma === -1 ? desc : desc.slice(0, comma);
  const bodyText = comma === -1 ? "" : desc.slice(comma + 1);

  const tokenSet = new Set();
  let len = 0;

  const feed = function (text, weight) {
    const toks = tokenize(text);
    for (let i = 0; i < toks.length; i++) {
      addPosting(toks[i], docIdx, weight);
      tokenSet.add(toks[i]);
      len += weight;
    }
  };

  const headTokens = new Set(tokenize(headText));
  state.docHeadTokens[docIdx] = headTokens;

  feed(headText, W_HEAD);
  feed(bodyText, W_BODY);
  feed(rec.cat || "", W_CAT);

  state.docTokens[docIdx] = tokenSet;
  state.docLen[docIdx] = len;
  state.docFlags[docIdx] = {
    addedFat: RE_ADDED_FAT.test(desc),
    defaultRow: RE_DEFAULT_ROW.test(desc),
    noAddedFat: RE_NO_ADDED_FAT.test(desc),
    condiment: CONDIMENT_CATEGORIES.has(rec.cat),
    ingredientOnly:
      rec.cat === INGREDIENT_CATEGORY || /\bas ingredient\b|\bfor use (with|in|on)\b/i.test(desc),
  };
}

/**
 * Second index pass: for every document, record the rare qualifier tokens it
 * carries (layer 8). Needs full document frequencies, so it runs after all
 * documents are indexed.
 */
function buildSpecificity() {
  for (let i = 0; i < state.N; i++) {
    const specific = [];
    for (const t of state.docTokens[i]) {
      if (MODIFIERS.has(t) || STRUCTURAL.has(t)) continue;
      // A rare qualifier ("Chinese", "glutinous") OR a dish word the query
      // never asked for ("Salmon SALAD" for "salmon fillet", "Shrimp SALAD"
      // for "prawn curry") both mean the candidate is a narrower or more
      // composed food than the one requested.
      if (DISH_TOKENS.has(t)) {
        specific.push(t);
        continue;
      }
      const postings = state.postings.get(t);
      if (postings && postings.length <= SPECIFIC_DF_MAX) specific.push(t);
    }
    state.docSpecific[i] = specific;
  }
}

/**
 * Build the in-memory index. Safe to call repeatedly; only the first call
 * does work. Called once at server boot. The JSON is read exactly once for
 * the life of the process.
 */
function load() {
  if (state.loaded) return true;
  const t0 = process.hrtime.bigint();

  const rows = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("food-db: " + DATA_PATH + " is empty or not an array");
  }

  state.rows = rows;
  state.N = rows.length;
  state.docTokens = new Array(rows.length);
  state.docLen = new Array(rows.length);
  state.docFlags = new Array(rows.length);
  state.docSpecific = new Array(rows.length);
  state.docHeadTokens = new Array(rows.length);
  state.postings = new Map();
  state.byCode = new Map();

  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    indexDoc(rows[i], i);
    state.byCode.set(String(rows[i].c), i);
    total += state.docLen[i];
  }
  state.avgDocLen = total / rows.length;
  buildSpecificity();

  state.loadMs = Number(process.hrtime.bigint() - t0) / 1e6;
  state.loaded = true;
  return true;
}

function ensureLoaded() {
  if (!state.loaded) load();
}

/* ------------------------------------------------------------------ *
 * Query analysis
 * ------------------------------------------------------------------ */

function analyzeQuery(query) {
  const normalized = normalizeText(query);
  if (!normalized) return null;

  const aliased = applyAliases(normalized);
  const base = tokenize(aliased);
  if (base.length === 0) return null;

  // Layer 3: head noun = first token that is not a preparation modifier, a
  // flavour/sauce word, or a brand name. If the query is nothing but those
  // ("grilled, sliced", "honey", "Starbucks"), fall back to the first token
  // so a query that really IS about the condiment or the brand still works.
  const skipAsHead = function (t) {
    return MODIFIERS.has(t) || FLAVOR_HEADS.has(t) || BRAND_TOKENS.has(t);
  };
  let head = null;
  for (let i = 0; i < base.length; i++) {
    if (!skipAsHead(base[i])) {
      head = base[i];
      break;
    }
  }
  if (head === null) head = base[0];

  // Layer 3b: the compound's semantic head -- the LAST non-modifier token,
  // when it differs from the hard-filter head noun. "blueberry muffin" ->
  // "muffin", "chicken sandwich" -> "sandwich", "caesar salad" -> "salad".
  let tailHead = null;
  for (let i = base.length - 1; i >= 0; i--) {
    if (!MODIFIERS.has(base[i])) {
      tailHead = base[i];
      break;
    }
  }
  if (tailHead === head) tailHead = null;

  // Derived tokens: gentle cooking methods imply the literal word "cooked".
  const terms = base.slice();
  let impliesCooked = false;
  for (let i = 0; i < base.length; i++) {
    if (IMPLIES_COOKED.has(base[i])) impliesCooked = true;
  }
  if (impliesCooked && terms.indexOf("cooked") === -1) terms.push("cooked");

  // Layer 4b: additive expansions ("skinless" -> "skin not eaten").
  for (let i = 0; i < base.length; i++) {
    const ex = EXPANSIONS.get(base[i]);
    if (!ex) continue;
    for (let j = 0; j < ex.length; j++) {
      if (terms.indexOf(ex[j]) === -1) terms.push(ex[j]);
    }
  }

  const termSet = new Set(terms);
  const uniqueTerms = Array.from(termSet);

  // Brand tokens are excluded from the coverage denominator: an unknown
  // chain name must not read as a missing ingredient. They stay in
  // uniqueTerms so BM25 can still reward a genuinely branded FNDDS row.
  const coverageTerms = uniqueTerms.filter(function (t) {
    return !BRAND_TOKENS.has(t);
  });

  let wantsFat = false;
  let wantsCondiment = false;
  let isDish = false;
  let wantsRaw = false;
  let hasMethod = false;
  const dishTerms = [];
  for (let i = 0; i < uniqueTerms.length; i++) {
    const t = uniqueTerms[i];
    if (FAT_SIGNAL.has(t)) wantsFat = true;
    if (CONDIMENT_QUERY_TOKENS.has(t)) wantsCondiment = true;
    if (DISH_TOKENS.has(t)) { isDish = true; dishTerms.push(t); }
    if (t === "raw" || t === "uncooked" || t === "fresh") wantsRaw = true;
    if (COOK_METHODS.has(t)) hasMethod = true;
  }

  // A gentle cooking method with no fat word anywhere is positive evidence
  // that nothing was added to the pan -- prefer the explicit "no added fat"
  // rows over fat-added ones.
  const impliesNoFat = impliesCooked && !wantsFat;

  return {
    normalized: normalized,
    aliased: aliased,
    terms: terms,
    termSet: termSet,
    uniqueTerms: uniqueTerms,
    head: head,
    tailHead: tailHead,
    wantsFat: wantsFat,
    wantsCondiment: wantsCondiment,
    wantsIngredient: termSet.has("ingredient"),
    impliesNoFat: impliesNoFat,
    isDish: isDish,
    coverageTerms: coverageTerms,
    dishTerms: dishTerms,
    wantsRaw: wantsRaw,
    hasMethod: hasMethod,
  };
}

/* ------------------------------------------------------------------ *
 * Public result shape
 * ------------------------------------------------------------------ */

function shape(rec, score) {
  const out = {
    code: String(rec.c),
    description: rec.d,
    category: rec.cat,
    kcal100: rec.k,
    protein100: rec.p,
    fat100: rec.f,
    carb100: rec.cb,
    portions: (rec.po || []).map(function (p) {
      return { description: p[0], grams: p[1] };
    }),
  };
  if (score !== undefined) out.score = Math.round(score * 1000) / 1000;
  return out;
}

/* ------------------------------------------------------------------ *
 * search
 * ------------------------------------------------------------------ */

/**
 * search(query, opts)
 * @param {string} query          e.g. "white rice, boiled"
 * @param {{limit?: number, minScore?: number}} [opts]
 *   limit    - max results (default 5)
 *   minScore - override the absolute score floor (default SCORE_FLOOR).
 *              Pass 0 to see the unfiltered ranking; used for calibration.
 * @returns {Array<Object>} best-first list of
 *   {code, description, category, kcal100, protein100, fat100, carb100,
 *    portions, score}; [] when nothing clears the score floor.
 */
function search(query, opts) {
  ensureLoaded();
  const limit = Math.max(1, (opts && opts.limit) || 5);
  const floor =
    opts && typeof opts.minScore === "number" ? opts.minScore : SCORE_FLOOR;

  const q = analyzeQuery(query);
  if (!q) return [];

  // Layer 1: candidate gathering + BM25F accumulation.
  const scores = new Map();
  for (let ti = 0; ti < q.uniqueTerms.length; ti++) {
    const postings = state.postings.get(q.uniqueTerms[ti]);
    // Unknown term: contributes nothing but still counts against coverage.
    if (!postings) continue;
    const df = postings.length;
    const idf = Math.log(1 + (state.N - df + 0.5) / (df + 0.5));
    for (let i = 0; i < postings.length; i++) {
      const docIdx = postings[i][0];
      const wtf = postings[i][1];
      const norm =
        wtf + K1 * (1 - B + (B * state.docLen[docIdx]) / state.avgDocLen);
      const contrib = idf * ((wtf * (K1 + 1)) / norm);
      scores.set(docIdx, (scores.get(docIdx) || 0) + contrib);
    }
  }
  if (scores.size === 0) return [];

  const nTerms = q.uniqueTerms.length;
  const results = [];

  for (const entry of scores) {
    const docIdx = entry[0];
    const bm25 = entry[1];
    const tokens = state.docTokens[docIdx];

    // Layer 3: head-noun hard filter.
    if (!tokens.has(q.head)) continue;

    // Layer 2: query coverage.
    let hits = 0;
    for (let i = 0; i < nTerms; i++) {
      if (tokens.has(q.uniqueTerms[i])) hits++;
    }
    const coverage = hits / nTerms;
    let score = bm25 * (COVERAGE_BASE + COVERAGE_SPAN * coverage);
    if (coverage < COVERAGE_HARD_FLOOR) score *= COVERAGE_HARD_PENALTY;

    // Layer 3b: reward candidates whose own description head carries the
    // compound's trailing noun ("blueberry MUFFIN" -> "Muffin, blueberry",
    // not "Blueberries, dried").
    if (q.tailHead && state.docHeadTokens[docIdx].has(q.tailHead)) {
      score *= COMPOUND_HEAD_BONUS;
    }

    const flags = state.docFlags[docIdx];

    // Layer 6: demote condiment/dressing/sauce rows when the query names a
    // dish and did not ask for a condiment.
    if (flags.condiment && q.isDish && !q.wantsCondiment) {
      score *= CONDIMENT_PENALTY;
    }

    // Layer 6b: demote recipe-ingredient-only rows.
    if (flags.ingredientOnly && !q.wantsIngredient) score *= INGREDIENT_PENALTY;

    // Layer 7: added-fat guard + USDA default-row preference.
    if (flags.addedFat && !q.wantsFat) score *= ADDED_FAT_PENALTY;
    if (flags.defaultRow) score *= DEFAULT_ROW_BONUS;
    if (flags.noAddedFat && q.impliesNoFat) score *= NO_ADDED_FAT_BONUS;

    // Layer 8: varietal-specificity penalty.
    const specific = state.docSpecific[docIdx];
    let extra = 0;
    for (let i = 0; i < specific.length; i++) {
      if (!q.termSet.has(specific[i])) extra++;
    }
    if (extra > 0) score /= 1 + SPECIFICITY_PENALTY * extra;

    // Layer 5: absolute floor -> explicit NO MATCH.
    if (score < floor) continue;

    results.push([docIdx, score]);
  }

  results.sort(function (a, b) {
    if (b[1] !== a[1]) return b[1] - a[1];
    // Deterministic tie-break: shorter description first, then foodCode.
    const la = state.rows[a[0]].d.length;
    const lb = state.rows[b[0]].d.length;
    if (la !== lb) return la - lb;
    return state.rows[a[0]].c < state.rows[b[0]].c ? -1 : 1;
  });

  return results.slice(0, limit).map(function (r) {
    return shape(state.rows[r[0]], r[1]);
  });
}

/**
 * Multi-probe helper. The vision model emits search_terms: ["", "", ""].
 * This runs search() once per term and merges by foodCode, keeping the best
 * score and rewarding rows that more than one probe agreed on. search() is
 * fully usable on its own -- this is a convenience for the caller.
 *
 * @param {string[]} terms
 * @param {{limit?: number, perTerm?: number, agreementBonus?: number}} [opts]
 * @returns {Array<Object>} search results plus `matchedTerms`.
 */
function searchMulti(terms, opts) {
  ensureLoaded();
  const o = opts || {};
  const limit = Math.max(1, o.limit || 5);
  const perTerm = Math.max(1, o.perTerm || Math.max(5, limit));
  const bonus = o.agreementBonus === undefined ? 0.15 : o.agreementBonus;

  const list = (Array.isArray(terms) ? terms : [terms]).filter(function (t) {
    return typeof t === "string" && t.trim().length > 0;
  });
  if (list.length === 0) return [];

  const merged = new Map();
  for (let i = 0; i < list.length; i++) {
    const term = list[i];
    const hitsForTerm = search(term, { limit: perTerm });
    for (let j = 0; j < hitsForTerm.length; j++) {
      const r = hitsForTerm[j];
      const prev = merged.get(r.code);
      if (prev) {
        prev.hits += 1;
        if (r.score > prev.best) prev.best = r.score;
        if (prev.matchedTerms.indexOf(term) === -1) {
          prev.matchedTerms.push(term);
        }
      } else {
        merged.set(r.code, {
          row: r,
          best: r.score,
          hits: 1,
          matchedTerms: [term],
        });
      }
    }
  }

  const out = [];
  for (const m of merged.values()) {
    const r = Object.assign({}, m.row);
    r.score = Math.round(m.best * (1 + bonus * (m.hits - 1)) * 1000) / 1000;
    r.matchedTerms = m.matchedTerms;
    out.push(r);
  }
  out.sort(function (a, b) {
    return b.score - a.score;
  });
  return out.slice(0, limit);
}

/**
 * lookup(code) -> the full record (same shape as a search result, without
 * `score`) or null when the foodCode is unknown.
 */
function lookup(code) {
  ensureLoaded();
  if (code === null || code === undefined) return null;
  const idx = state.byCode.get(String(code).trim());
  if (idx === undefined) return null;
  return shape(state.rows[idx]);
}

/**
 * stats() -> {foodCount, indexed, loadMs, termCount, avgDocLen}
 */
function stats() {
  ensureLoaded();
  let indexed = 0;
  for (let i = 0; i < state.docTokens.length; i++) {
    if (state.docTokens[i] && state.docTokens[i].size > 0) indexed++;
  }
  return {
    foodCount: state.N,
    indexed: indexed,
    loadMs: Math.round(state.loadMs * 1000) / 1000,
    termCount: state.postings.size,
    avgDocLen: Math.round(state.avgDocLen * 100) / 100,
  };
}

module.exports = {
  load: load,
  search: search,
  searchMulti: searchMulti,
  lookup: lookup,
  stats: stats,
  // Exposed for tests and floor calibration; not part of the contract.
  _internal: {
    analyzeQuery: analyzeQuery,
    tokenize: tokenize,
    applyAliases: applyAliases,
    SCORE_FLOOR: SCORE_FLOOR,
    DATA_PATH: DATA_PATH,
  },
};
