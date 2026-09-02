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
 * Matching stack. Layers 1-8 are the spec's; 8b onwards were added after an
 * adversarial pass measured a 13.6% wrong-answer rate on realistic
 * vision-model output (see food-db.adversarial.test.js, which pins every
 * case below as a regression test):
 *
 *   1.  BM25F (k1=2.5, b=0.75) over description + WWEIA category, with the
 *       description head (text before the first comma) weighted heaviest.
 *   2.  Weighted query-coverage factor 0.4 + 0.6*coverage, hard penalty
 *       below 34%. Size/cut/doneness modifiers carry reduced weight -- their
 *       absence from a row is not evidence against it -- but COOKING METHODS
 *       carry full weight, because method discrimination is the whole reason
 *       this project uses FNDDS.
 *   2b. Unknown-vocabulary penalty: the share of the query the index has
 *       never seen. This, not low coverage, is the real junk signal.
 *   3.  Head-noun hard filter: the first query token that is not a modifier,
 *       a flavour/sauce word, or a brand name MUST appear in the candidate's
 *       DESCRIPTION (not its category -- the category leaked head nouns into
 *       rows that do not contain them). This is the safety property of the
 *       whole module: a matched row really does contain the named food.
 *   3b. Compound-head bonus: reward candidates whose own description head
 *       carries the query's trailing noun ("blueberry MUFFIN").
 *   4.  Alias table (British / Indian / menu names -> FNDDS vocabulary).
 *   4b. Token expansions ("skinless" -> "skin not eaten"), additive.
 *   5.  Absolute score floor -> [] (explicit NO MATCH).
 *   6.  Condiment / dressing / sauce category demotion, gated on the query
 *       naming a dish (so "hummus" still returns hummus).
 *   6b. Recipe-ingredient-only row demotion.
 *   7.  Added-fat guard + USDA default-row preference.
 *   8.  Varietal-specificity penalty: demote candidates carrying a rare
 *       qualifier, or a dish word, that the query never asked for.
 *   8b. Processing-qualifier penalty: an unrequested "dried"/"canned"/
 *       "frozen" is worth up to 5x on energy density all by itself.
 *   8c. Different-food penalty: unmatched identity nouns in the candidate's
 *       pre-comma head, gated on the head noun being in that same head.
 *   9.  Raw-row guard: the query named a cooking method and did not say raw.
 *   10. Offal / anatomical-part guard: nobody photographs chicken skin.
 *   11. Dish-form coverage: the query named a dish the candidate is not.
 *       Harsher when the head noun is a one-row homograph ("poke").
 *
 * Failing closed is always preferred to a confident wrong number: the caller
 * keeps the vision model's own estimate, which is a visible fallback rather
 * than a silent corruption of the total.
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
/**
 * Layer 2 -- coverage.
 *
 * The hard penalty was 0.25 below 50% coverage, which was far too harsh once
 * the query is at all descriptive. Measured cases where the CORRECT row was
 * already ranked #1 and was killed only by this penalty:
 *
 *   "cheeseburger with lettuce and tomato" -> Cheeseburger, NFS   scored 1.44
 *   "deep fried breaded cod fillet"        -> Fish, cod, fried    scored 2.06
 *
 * Both are exactly what a vision model emits, and both returned NO MATCH.
 * The junk rejection this penalty was doing is now carried by
 * UNKNOWN_TERM_PENALTY, which keys on vocabulary the index has never seen
 * rather than on the query merely being wordy.
 */
const COVERAGE_HARD_FLOOR = 0.34;
const COVERAGE_HARD_PENALTY = 0.55;

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

/** Hard cap on opts.limit, so a bad caller cannot ask for a huge slice. */
const MAX_LIMIT = 200;

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

/**
 * Layer 8c -- unmatched food nouns in the candidate's pre-comma head.
 * See the comment at the use site; FNDDS's comma convention makes this a
 * reliable "different food" signal rather than a "narrower food" one, so it
 * is penalised harder than a varietal qualifier.
 */
const HEAD_EXTRA_PENALTY = 0.6;

/** Layer 10 -- anatomical part the query did not ask for. */
const OFFAL_PENALTY = 0.3;

/**
 * Layer 11 -- the query named a dish form the candidate is not.
 * Deliberately severe: when the named dish does not exist in FNDDS, a
 * NO MATCH is worth far more than a same-ingredient row of a different form.
 */
const DISH_MISS_PENALTY = 0.4;

/**
 * Layer 11b -- the head noun matched only a handful of rows AND the query's
 * dish form is absent. See the use site: this is the homograph case.
 */
const RARE_HEAD_DF = 2;
const DISH_MISS_RARE_PENALTY = 0.12;

/**
 * Layer 2b -- fraction of the query that is vocabulary the index has never
 * seen. This, not low coverage, is what actually distinguishes junk
 * ("chicken qqqq zzzz wibble", 3/4 unknown) from a wordy real query
 * ("cheeseburger with lettuce and tomato", 0/3 unknown). Splitting the two
 * is what let COVERAGE_HARD_PENALTY be relaxed from 0.25 to a value that
 * does not destroy correct generic rows.
 */
const UNKNOWN_TERM_PENALTY = 0.85;

/**
 * Layer 2 -- weight of a preparation modifier in the coverage denominator.
 * See the use site: a modifier is a hint, not a required ingredient.
 */
const MODIFIER_COVERAGE_WEIGHT = 0.35;

/**
 * Which modifiers get the reduced coverage weight. Deliberately NOT all of
 * them: a COOKING METHOD must keep full weight, because discriminating
 * boiled / fried / restaurant preparations is the entire reason this project
 * uses FNDDS rather than a generic food table. Discounting methods regressed
 * "fried rice with egg" to "Rice, cooked, NFS" (129 vs the correct 174) and
 * "scrambled eggs cooked with butter" to a FRIED egg row.
 *
 * Only size, cut, doneness and presentation words are discounted -- words
 * FNDDS simply does not record, so their absence from a row is not evidence
 * against it.
 */
const WEAK_MODIFIERS = new Set([
  "small", "medium", "large", "extra", "big", "little", "thin", "thick",
  "whole", "half", "quarter", "single", "double", "regular", "lightly",
  "heavily", "approximately", "about", "roughly", "some", "assorted",
  "serving", "portion", "piece", "pieces", "side", "plate", "rare", "cut",
  "cuts", "trimmed", "well", "done", "sized", "generous", "heaping",
  "handful", "bunch", "slab", "slice", "slices", "sliced", "diced",
  "chopped", "minced", "grated", "shredded", "julienned", "halved",
  "quartered", "shaved", "crumbled", "freshly", "day", "classic",
  "traditional", "authentic", "homestyle", "style", "fresh", "leftover",
  "cold", "hot", "warm", "chilled", "ripe", "unripe", "juicy", "tender",
  "crispy", "crisp", "soft", "organic",
]);

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
  // Meal occasions. Never the identity of a food, but FNDDS does have
  // "Breakfast bar" / "Breakfast pastry" rows, so taking "breakfast" as the
  // head noun sent "breakfast sausage patty" to "Breakfast bar, NFS" (376).
  "breakfast", "lunch", "dinner", "brunch", "supper",
  "appetizer", "starter", "course", "helping", "leftovers",
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
  // Condiment CLASS nouns. "tartar sauce cod" took head noun "sauce" (the
  // flavour word "tartar" was already skipped) and returned Tartar sauce.
  // When the query is only about the condiment ("barbecue sauce") the
  // all-flavour fallback in analyzeQuery puts the head back on the first
  // token, so those still resolve.
  "sauce", "dressing", "dip", "gravy", "marinade", "glaze", "seasoning",
  "spice", "rub", "relish", "chutney", "salsa", "syrup", "condiment",
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
  // Added by the adversarial pass. Without "chowder", "Clams, NFS" (143)
  // beat "Soup, New England clam chowder" (93); without "enchilada",
  // "cheese enchiladas" returned "Cheese, NFS" (381) -- more than double.
  "chowder", "bisque", "broth", "enchilada", "tostada", "pancake",
  "waffle", "muffin", "bagel", "croissant", "doughnut", "donut", "pretzel",
  "cookie", "brownie", "cupcake", "pudding", "smoothie", "shake", "kabob",
  "skewer", "dumpling", "wonton", "curry", "biryani", "congee", "pho",
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
  // "popper" is absent from FNDDS; the dish is "Stuffed jalapeno pepper".
  { from: "poppers", to: "stuffed" },
  { from: "popper", to: "stuffed" },
  // "cherry"/"grape" as a tomato SIZE, not the fruit. Unaliased, the head
  // noun was "cherry" and "cherry tomatoes" returned "Cherries, dried"
  // (333 kcal) for a 20 kcal food -- a 16x error.
  { from: "cherry tomatoes", to: "tomatoes raw" },
  { from: "cherry tomato", to: "tomatoes raw" },
  { from: "grape tomatoes", to: "tomatoes raw" },
  { from: "grape tomato", to: "tomatoes raw" },
  { from: "plum tomatoes", to: "tomatoes raw" },
  // Absent from FNDDS as written; the verified target is in parentheses.
  // FNDDS has no spring-roll row; its nearest analogue is the meatless egg
  // roll. Aliasing to bare "egg roll" was worse than nothing -- head noun
  // "egg" landed on "Roll, egg bread" (287 kcal, a bread).
  { from: "spring rolls", to: "egg roll meatless" },
  { from: "spring roll", to: "egg roll meatless" },
  { from: "cornflakes", to: "cereal corn flakes" },  // Cereal, corn flakes
  { from: "corn flakes", to: "cereal corn flakes" },
  { from: "skewers", to: "shish kabob" },            // ... shish kabob ...
  { from: "skewer", to: "shish kabob" },
  { from: "satay", to: "shish kabob" },
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
  // FNDDS has no "wrap" category; it files them as sandwiches, so demanding
  // the literal token left "falafel wrap" scoring 0.81 against "Falafel
  // sandwich" (265 kcal), which is exactly the right row.
  ["wrap", ["wrap", "sandwich"]],
  ["sub", ["sub", "sandwich"]],
  ["hoagie", ["sub", "sandwich"]],
  ["baguette", ["bread", "french"]],
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
  // "-oes" plurals. Stripping only the trailing "s" produced "potatoe" and
  // "tomatoe", neither of which equals FNDDS's own "potato"/"tomato", so the
  // head-noun hard filter EXCLUDED every correct row: "boiled white
  // potatoes" could only reach "Stewed potatoes" (the one row whose text is
  // also plural), and any query naming tomatoes was similarly cut off from
  // the Tomatoes rows. "shoes"/"canoes" keep the e, but neither is a food.
  if (/[^aeiou]oes$/.test(t)) return t.slice(0, -2);
  // "-ves" plurals: loaves -> loaf, halves -> half, leaves -> leaf.
  // "olives"/"chives" are not plurals of an -f word, so they are excluded by
  // requiring a consonant or "a"/"l" before the "ves".
  if (/(l|a|r)ves$/.test(t)) return t.slice(0, -3) + "f";
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
  docProcess: [],      // processing qualifiers per doc (layer 8b)
  docHeadExtra: [],    // food nouns in the pre-comma head (layer 8c)
  docParts: [],        // anatomical / offal parts per doc (layer 10)
  docDescTokens: [],   // description-only tokens, for the layer 3 filter
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

  // Layer 8c: food nouns carried by the description head. Modifiers,
  // structural filler and flavour words are excluded -- only an extra
  // *identity* noun means a different food.
  const headExtra = [];
  for (const t of headTokens) {
    if (MODIFIERS.has(t) || STRUCTURAL.has(t) || FLAVOR_HEADS.has(t)) continue;
    if (OFFAL_PARTS.has(t)) continue; // handled by layer 10
    headExtra.push(t);
  }
  state.docHeadExtra[docIdx] = headExtra;

  feed(headText, W_HEAD);
  feed(bodyText, W_BODY);
  // Snapshot the DESCRIPTION-only vocabulary before the category is folded
  // in. The layer 3 hard filter must use this, not the combined set: the
  // WWEIA category leaked head nouns into rows that do not contain them, so
  // "bagel with cream cheese" matched "Muffin, English, cheese" -- a row
  // with no "bagel" in its description at all, admitted purely because its
  // category is "Bagels and English muffins". That silently broke the one
  // guarantee this module makes about a matched row.
  state.docDescTokens[docIdx] = new Set(tokenSet);
  feed(rec.cat || "", W_CAT);

  state.docTokens[docIdx] = tokenSet;
  state.docLen[docIdx] = len;

  // Layer 8b / layer 10 lists.
  const proc = [];
  const parts = [];
  for (const t of tokenSet) {
    if (PROCESS_QUALIFIERS.has(t)) proc.push(t);
    if (OFFAL_PARTS.has(t)) parts.push(t);
  }
  state.docProcess[docIdx] = proc;
  state.docParts[docIdx] = parts;

  state.docFlags[docIdx] = {
    raw: RE_RAW_ROW.test(desc),
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
      if (PROCESS_QUALIFIERS.has(t)) continue; // counted once, by layer 8b
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
  state.docProcess = new Array(rows.length);
  state.docHeadExtra = new Array(rows.length);
  state.docParts = new Array(rows.length);
  state.docDescTokens = new Array(rows.length);
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

  /**
   * Coverage denominator. Everything here still takes part in BM25 -- this
   * only decides what counts as "the query asked for N things".
   *
   *  - Derived tokens (the implied "cooked", the EXPANSIONS output) are not
   *    things the user said, so counting them inflated the denominator and
   *    pushed correct rows under the coverage penalty. "medium rare grilled
   *    ribeye steak" scored 2.83 with the right row already ranked #1.
   *  - Brand names: an unknown chain must not read as a missing ingredient.
   *  - Flavour words: "honey mustard chicken" is one food with two
   *    seasonings, not three ingredients, and demanding a row match all
   *    three left the whole query under the floor at 1.47.
   */
  const derived = new Set();
  if (impliesCooked) derived.add("cooked");
  for (let i = 0; i < base.length; i++) {
    const ex = EXPANSIONS.get(base[i]);
    if (!ex) continue;
    for (let j = 0; j < ex.length; j++) {
      if (base.indexOf(ex[j]) === -1) derived.add(ex[j]);
    }
  }
  let coverageTerms = uniqueTerms.filter(function (t) {
    return !BRAND_TOKENS.has(t) && !FLAVOR_HEADS.has(t) && !derived.has(t);
  });
  // A query that is ENTIRELY flavour or brand words ("salsa", "barbecue
  // sauce", "Starbucks") would otherwise be left with an empty denominator,
  // scoring coverage 0 and taking the hard penalty -- "salsa" scored 2.59
  // and returned NO MATCH even though "Salsa, NFS" is an exact row.
  if (coverageTerms.length === 0) coverageTerms = uniqueTerms.slice();

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
  // Both options are clamped to finite values. `minScore: NaN` used to
  // disable the floor completely -- every `score < NaN` comparison is false
  // -- so a junk query came back with real-looking rows scoring 0.49. That
  // is the one direction this module must never fail in.
  const rawLimit = opts && Number(opts.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1
    ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
    : 5;
  const rawFloor = opts && opts.minScore;
  const floor = typeof rawFloor === "number" && Number.isFinite(rawFloor)
    ? rawFloor
    : SCORE_FLOOR;

  // Contract: the query is a string. Anything else is a caller bug, and
  // coercing it hides that bug behind a plausible-looking calorie number --
  // String(["chicken"]) is "chicken", so an accidental array used to return
  // a real row. Fail closed instead.
  if (typeof query !== "string") return [];

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

  const cTerms = q.coverageTerms;
  const results = [];

  /**
   * Coverage weights. A preparation modifier is a HINT, not an ingredient
   * the row is obliged to contain: FNDDS writes "Turkey, NFS", never "Turkey,
   * roast, sliced". Counting "roast" and "sliced" at full weight dropped
   * "roast turkey breast, sliced" to 1/4 coverage and NO MATCH, and did the
   * same to "pan seared tuna steak". Modifiers still score through BM25 when
   * they DO match, so method discrimination (the whole reason for FNDDS) is
   * unaffected -- this only removes the punishment for their absence.
   */
  const cWeights = new Array(cTerms.length);
  let denom = 0;
  for (let i = 0; i < cTerms.length; i++) {
    cWeights[i] = WEAK_MODIFIERS.has(cTerms[i]) ? MODIFIER_COVERAGE_WEIGHT : 1;
    denom += cWeights[i];
  }
  if (denom === 0) denom = 1;

  // How much of the query is vocabulary the index has never seen? This is
  // the real junk signal -- "chicken qqqq zzzz wibble" is 3/4 unknown --
  // and separating it from "known but unmatched" is what lets the coverage
  // penalty be gentle enough for genuine descriptive queries. Before this
  // split, "cheeseburger with lettuce and tomato" scored 1.44 (the correct
  // "Cheeseburger, NFS" row was already ranked #1) and fell under the floor
  // purely because the user named two garnishes.
  let unknown = 0;
  for (let i = 0; i < cTerms.length; i++) {
    if (!state.postings.has(cTerms[i])) unknown++;
  }
  const unknownFrac = cTerms.length ? unknown / cTerms.length : 0;
  const unknownFactor = 1 - UNKNOWN_TERM_PENALTY * unknownFrac;

  // Document frequency of the head noun -- used by layer 11b.
  const headPostings = state.postings.get(q.head);
  const headDf = headPostings ? headPostings.length : 0;

  for (const entry of scores) {
    const docIdx = entry[0];
    const bm25 = entry[1];
    const tokens = state.docTokens[docIdx];

    // Layer 3: head-noun hard filter -- against the DESCRIPTION only.
    if (!state.docDescTokens[docIdx].has(q.head)) continue;

    // Layer 2: weighted query coverage, over non-brand terms only.
    let hits = 0;
    for (let i = 0; i < cTerms.length; i++) {
      if (tokens.has(cTerms[i])) hits += cWeights[i];
    }
    const coverage = hits / denom;
    let score = bm25 * (COVERAGE_BASE + COVERAGE_SPAN * coverage);
    if (coverage < COVERAGE_HARD_FLOOR) score *= COVERAGE_HARD_PENALTY;
    score *= unknownFactor;

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

    // Layer 8b: processing qualifiers the query never asked for. Folded into
    // the same `extra` count. "blueberry pancakes" was answered with
    // "Blueberries, DRIED" (317 kcal); dried fruit is ~5x the energy density
    // of the fresh food, so an unrequested processing word is one of the few
    // single tokens that can be catastrophic on its own.
    const proc = state.docProcess[docIdx];
    for (let i = 0; i < proc.length; i++) {
      if (!q.termSet.has(proc[i])) extra++;
    }

    // Layer 8c: unmatched food nouns in the candidate's own description HEAD
    // (the text before the first comma). FNDDS puts the food's identity
    // there and its qualifiers after the comma, so an extra identity word in
    // the head means a DIFFERENT food, not a narrower one:
    //   "potato, fried" -> "SWEET potato fries" (192) not "Potato, french
    //   fries, NFS" (225); "thick cut smoked bacon" -> "CANADIAN bacon"
    //   (146) not "Pork bacon, smoked or cured, cooked" (468).
    //
    // Gated on the query's head noun being IN that same description head.
    // Without the gate the rule misfires on FNDDS's genus-prefix convention
    // -- "Potato, hash brown", "Soup, pho", "Beef, steak, ribeye",
    // "Peppers, jalapenos" all put a classifier before the comma that the
    // query legitimately omits, and penalising it broke "hash browns",
    // "pho", "ribeye steak" and "jalapeno" outright. When the head noun is
    // absent from the head, the extra words are a classifier, not a
    // competing identity; when it is present, they genuinely modify it.
    if (state.docHeadTokens[docIdx].has(q.head)) {
      const headExtras = state.docHeadExtra[docIdx];
      let headExtra = 0;
      for (let i = 0; i < headExtras.length; i++) {
        if (!q.termSet.has(headExtras[i])) headExtra++;
      }
      if (headExtra > 0) score /= 1 + HEAD_EXTRA_PENALTY * headExtra;
    }

    if (extra > 0) score /= 1 + SPECIFICITY_PENALTY * extra;

    // Layer 9: raw-row guard. The query named a cooking method and did not
    // say "raw", so a raw row is wrong by construction. "roasted brussels
    // sprouts with olive oil" returned "Brussels sprouts, raw" (43) over the
    // cooked-with-fat row (67) only because the raw row is shorter.
    if (q.hasMethod && !q.wantsRaw && state.docFlags[docIdx].raw) {
      score *= RAW_PENALTY;
    }

    // Layer 10: offal / anatomical-part guard. Nobody photographs a plate of
    // chicken skin. Bare "chicken" used to return "Chicken skin" (450 kcal)
    // instead of USDA's own "Chicken, NS as to part and cooking method"
    // default (164) -- a 2.7x overestimate on a very common query.
    const parts = state.docParts[docIdx];
    let partExtra = 0;
    for (let i = 0; i < parts.length; i++) {
      if (!q.termSet.has(parts[i])) partExtra++;
    }
    if (partExtra > 0) score *= OFFAL_PENALTY;

    // Layer 11: dish-word coverage. The query named a dish form ("bowl",
    // "sandwich", "pancakes") and this candidate is not that form. FNDDS
    // "poke" is only "Poke greens" -- a leaf vegetable -- so "poke bowl"
    // was answered with 42 kcal, roughly a quarter of the real figure.
    // Failing closed here is the correct outcome: the caller keeps the
    // vision model's own estimate rather than a confidently wrong row.
    if (q.dishTerms.length > 0) {
      let dishHit = false;
      for (let i = 0; i < q.dishTerms.length; i++) {
        if (tokens.has(q.dishTerms[i])) { dishHit = true; break; }
      }
      if (!dishHit) {
        // A head noun that occurs in only one or two rows of a 5,432-row
        // database is almost certainly a homograph, not the food: FNDDS's
        // sole "poke" row is "Poke greens" (pokeweed, a boiled leaf), so
        // "poke bowl" was answered with 42 kcal. One accidental row is not
        // evidence, and with the dish form also missing there is nothing
        // left supporting the match, so it fails closed.
        score *= headDf <= RARE_HEAD_DF ? DISH_MISS_RARE_PENALTY
                                        : DISH_MISS_PENALTY;
      }
    }

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
  const rawLimit = Number(o.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1
    ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
    : 5;
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
  // String(x) THROWS for a null-prototype object or a Symbol -- it is not a
  // safe coercion. lookup(Object.create(null)) used to raise
  // "TypeError: Cannot convert object to primitive value" straight out of
  // the module, which would take an Express handler down with it.
  let key;
  try {
    key = String(code).trim();
  } catch (e) {
    return null;
  }
  const idx = state.byCode.get(key);
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
