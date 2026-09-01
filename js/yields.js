// Cooked-to-raw yield data. y = cooking yield = cooked weight ÷ raw weight.
//   raw = cooked ÷ y      (y < 1: moisture/fat lost — meats)
//   y > 1 means water absorbed (grains) — "raw" is the dry weight.
//
// Sources: USDA Table of Cooking Yields for Meat and Poultry (ARS, 2012) and
// the USDA SR per-lean-ratio ground beef values derived from the same study.
// Items with approx:true are typical values where USDA has no measurement —
// they're marked ≈ in the UI. Do not "round" these numbers casually; the whole
// point of this tool is that the conversion is right.

// Best-guess cook method from an ingredient's name — the recipe builder uses this
// to estimate the cooked batch weight. Factors come from the same USDA-based table
// below. Conservative: no match = assumed uncooked (×1). First matching rule wins.
const GUESSES = [
  [/chicken.*(breast|tender)|breast/i, 'Chicken breast, baked', 0.72],
  [/chicken.*thigh|thigh/i, 'Chicken thigh, baked', 0.69],
  [/rotisserie|whole chicken/i, 'Whole chicken, roasted', 0.78],
  [/chicken/i, 'Chicken, baked', 0.72],
  [/ground (beef|chuck)|beef.*ground|hamburger/i, 'Ground beef crumbles, 90/10', 0.71],
  [/ground turkey|turkey.*ground/i, 'Ground turkey, cooked', 0.74],
  [/steak|sirloin|ribeye|filet|beef/i, 'Steak, grilled', 0.76],
  [/bacon/i, 'Bacon, pan-fried', 0.31],
  [/sausage/i, 'Sausage, pan-fried', 0.80],
  [/pork.*tenderloin|tenderloin.*pork/i, 'Pork tenderloin, roasted', 0.80],
  [/pork/i, 'Pork chop / loin, cooked', 0.79],
  [/salmon/i, 'Salmon, baked', 0.78],
  [/tilapia|cod|haddock|fish/i, 'White fish, baked', 0.81],
  [/shrimp/i, 'Shrimp, cooked', 0.75],
  [/egg/i, 'Eggs, scrambled', 0.90],
  [/brown rice/i, 'Brown rice, cooked', 3.0],
  [/rice cake/i, null, null], // rice cakes are a snack, not raw rice
  [/rice/i, 'White rice, cooked', 2.8],
  [/quinoa/i, 'Quinoa, cooked', 3.0],
  [/pasta|spaghetti|penne|macaroni|noodle/i, 'Pasta, boiled', 2.25],
  [/lentil/i, 'Lentils, boiled', 2.5],
  [/oat/i, null, null], // oatmeal water varies too much to guess
  [/green bean/i, 'Vegetables, roasted', 0.8],
  [/bean/i, 'Beans (from dry), boiled', 2.6],
  [/sweet potato/i, 'Sweet potato, baked', 0.8],
  [/potato/i, 'Potato, baked', 0.83],
  [/mushroom/i, 'Mushrooms, sautéed', 0.55],
  [/spinach/i, 'Spinach, wilted', 0.35],
  [/broccoli|pepper|zucchini|squash|carrot|onion|cauliflower|asparagus|vegetable|veggie/i, 'Vegetables, roasted', 0.8],
];

export function guessYield(name) {
  for (const [re, label, factor] of GUESSES) {
    if (re.test(name || '')) return label ? { label, factor } : null;
  }
  return null;
}

// Best-guess converter CATEGORY from a food's name. Only the category — the
// exact cut / lean % is always picked per log, because 80/20 and 93/7 (or
// breast vs thigh) lose different amounts of weight.
const CAT_GUESSES = [
  [/ground|hamburger|meatloaf/i, 'Ground meat'],
  [/bacon|sausage|brat/i, 'Bacon & sausage'],
  [/chicken|drumstick|wing/i, 'Chicken'],
  [/steak|sirloin|ribeye|filet|brisket|beef|roast/i, 'Steak & roast'],
  [/potato/i, 'Potatoes'],
  [/pork|ham\b|loin|rib/i, 'Pork'],
  [/salmon|tilapia|cod|haddock|tuna|shrimp|fish/i, 'Fish & seafood'],
  [/rice|pasta|quinoa|lentil|bean|noodle|spaghetti|penne|macaroni/i, 'Rice & pasta'],
  [/mushroom|spinach|onion|broccoli|carrot|zucchini|squash|cauliflower|asparagus|pepper|vegetable|veggie/i, 'Vegetables'],
];

export function guessYieldCat(name) {
  for (const [re, catName] of CAT_GUESSES) {
    if (re.test(name || '')) {
      const i = YIELD_CATS.findIndex(c => c.name === catName);
      if (i >= 0) return i;
    }
  }
  return null;
}

export const YIELD_CATS = [
  {
    name: 'Ground meat',
    items: [
      { name: 'Beef crumbles, drained, 80/20', y: 0.67 },
      { name: 'Beef crumbles, drained, 85/15', y: 0.69 },
      { name: 'Beef crumbles, drained, 90/10', y: 0.71 },
      { name: 'Beef crumbles, drained, 93/7', y: 0.72 },
      { name: 'Beef patties, pan-cooked, 80/20', y: 0.73 },
      { name: 'Beef patties, pan-cooked, 85/15', y: 0.75 },
      { name: 'Beef patties, pan-cooked, 90/10', y: 0.76 },
      { name: 'Beef patties, pan-cooked, 93/7', y: 0.77 },
      { name: 'Beef patties, grilled, 80/20', y: 0.69 },
      { name: 'Beef patties, grilled, 85/15', y: 0.70 },
      { name: 'Beef patties, grilled, 90/10', y: 0.72 },
      { name: 'Beef patties, grilled, 93/7', y: 0.73 },
      { name: 'Meatloaf, baked, 80/20–85/15', y: 0.70 },
      { name: 'Meatloaf, baked, 90/10+', y: 0.72 },
      { name: 'Turkey crumbles, 85/15', y: 0.72, approx: true },
      { name: 'Turkey crumbles, 93/7', y: 0.74, approx: true },
      { name: 'Turkey crumbles, 99/1 breast', y: 0.76, approx: true },
      { name: 'Turkey patties, 85/15', y: 0.74, approx: true },
      { name: 'Turkey patties, 93/7', y: 0.76, approx: true },
      { name: 'Chicken crumbles, regular (~92/8)', y: 0.73, approx: true },
      { name: 'Chicken crumbles, 99/1 breast', y: 0.75, approx: true },
    ],
    note: 'Lean % matters — fattier grinds lose more weight. Beef values are USDA-measured; turkey and chicken grinds are typical values scaled the same way.',
  },
  {
    name: 'Chicken',
    items: [
      { name: 'Breast, grilled or pan-cooked', y: 0.71, approx: true },
      { name: 'Breast, baked / roasted', y: 0.72 },
      { name: 'Breast, poached or simmered', y: 0.77 },
      { name: 'Thigh, baked / roasted', y: 0.69 },
      { name: 'Thigh, simmered', y: 0.74 },
      { name: 'Drumstick, baked / roasted', y: 0.76 },
      { name: 'Wings, baked / roasted', y: 0.74 },
      { name: 'Wings, deep-fried', y: 0.66 },
      { name: 'Whole bird, roasted', y: 0.78 },
    ],
  },
  {
    name: 'Steak & roast',
    items: [
      { name: 'Steak, average cut, grilled', y: 0.76 },
      { name: 'Ribeye, grilled', y: 0.84 },
      { name: 'NY strip, grilled', y: 0.82 },
      { name: 'Top sirloin, grilled', y: 0.80 },
      { name: 'Tenderloin / filet, grilled', y: 0.80 },
      { name: 'Flank steak, grilled', y: 0.81 },
      { name: 'Skirt steak, grilled', y: 0.70 },
      { name: 'Top round / London broil', y: 0.72 },
      { name: 'Roast, oven-roasted', y: 0.79 },
      { name: 'Eye of round roast', y: 0.81 },
      { name: 'Tri-tip roast', y: 0.84 },
      { name: 'Prime rib / ribeye roast', y: 0.77 },
      { name: 'Pot roast (chuck), braised', y: 0.66 },
      { name: 'Brisket, braised', y: 0.69 },
      { name: 'Short ribs, braised', y: 0.66 },
      { name: 'Stew meat, simmered', y: 0.67 },
    ],
  },
  {
    name: 'Potatoes',
    items: [
      { name: 'Baked, whole', y: 0.83 },
      { name: 'Boiled, whole', y: 0.97, approx: true },
      { name: 'Mashed (before milk/butter)', y: 0.97, approx: true },
      { name: 'Roasted chunks / home fries', y: 0.75, approx: true },
      { name: 'Air-fried chunks or fries', y: 0.75, approx: true },
      { name: 'Sweet potato, baked', y: 0.80, approx: true },
    ],
    note: 'Log potatoes raw-peeled weight. Boiled whole potatoes barely change weight; roasting dries them out.',
  },
  {
    name: 'Pork',
    items: [
      { name: 'Chop, boneless, grilled', y: 0.79 },
      { name: 'Chop, bone-in, grilled', y: 0.82 },
      { name: 'Chop, pan-fried', y: 0.78 },
      { name: 'Tenderloin, roasted', y: 0.80 },
      { name: 'Loin roast, roasted', y: 0.79 },
      { name: 'Shoulder / blade steak, braised', y: 0.65 },
      { name: 'Shoulder picnic, braised (pulled)', y: 0.74 },
      { name: 'Spareribs, roasted', y: 0.76 },
      { name: 'Back ribs, roasted', y: 0.82 },
      { name: 'Ham, baked, bone-in', y: 0.90 },
      { name: 'Ground pork, crumbles', y: 0.67 },
      { name: 'Ground pork, patties', y: 0.68 },
    ],
  },
  {
    name: 'Bacon & sausage',
    items: [
      { name: 'Bacon, pan-fried', y: 0.31 },
      { name: 'Bacon, baked', y: 0.32 },
      { name: 'Bacon, microwaved', y: 0.29 },
      { name: 'Pork sausage, pan-fried', y: 0.80 },
      { name: 'Turkey sausage, grilled', y: 0.77 },
    ],
  },
  {
    name: 'Fish & seafood',
    items: [
      { name: 'Salmon, baked or grilled', y: 0.78, approx: true },
      { name: 'White fish (cod, tilapia), baked', y: 0.81, approx: true },
      { name: 'Tuna steak, grilled', y: 0.80, approx: true },
      { name: 'Shrimp, sautéed or boiled', y: 0.75, approx: true },
    ],
    note: 'Fish isn\'t in the USDA yield table — these are typical values. Weigh one batch raw and cooked to dial in your own.',
  },
  {
    name: 'Air fryer',
    items: [
      { name: 'Chicken breast', y: 0.72 },
      { name: 'Chicken thighs', y: 0.69 },
      { name: 'Chicken drumsticks', y: 0.76 },
      { name: 'Chicken wings', y: 0.74 },
      { name: 'Steak', y: 0.78 },
      { name: 'Pork chops', y: 0.79 },
      { name: 'Pork tenderloin', y: 0.80 },
      { name: 'Bacon', y: 0.32 },
      { name: 'Salmon', y: 0.78, approx: true },
      { name: 'Frozen fries / breaded items', y: 0.92, approx: true },
    ],
    note: 'Air frying is convection roasting, so these use USDA oven-roasted yields — the closest measured match.',
  },
  {
    name: 'Rice & pasta',
    items: [
      { name: 'White rice, cooked', y: 2.8 },
      { name: 'Brown rice, cooked', y: 3.0 },
      { name: 'Quinoa, cooked', y: 3.0 },
      { name: 'Pasta, al dente', y: 2.25 },
      { name: 'Pasta, well-cooked', y: 2.4 },
      { name: 'Lentils, boiled', y: 2.5, approx: true },
      { name: 'Beans (from dry), boiled', y: 2.6, approx: true },
    ],
    note: 'Raw = DRY weight. Grains vary with how much water you use — weigh your usual batch once for a precise personal factor.',
  },
  {
    name: 'Baked & whole dishes',
    items: [
      { name: 'Cheesecake, baked', y: 0.90, approx: true },
      { name: 'Cake / muffins / brownies', y: 0.88, approx: true },
      { name: 'Banana / quick bread', y: 0.88, approx: true },
      { name: 'Bread, baked', y: 0.87, approx: true },
      { name: 'Casserole / pasta bake', y: 0.85, approx: true },
      { name: 'Lasagna', y: 0.85, approx: true },
      { name: 'Meatloaf, baked', y: 0.70 },
      { name: 'Soup / stew, simmered uncovered', y: 0.85, approx: true },
      { name: 'Slow cooker (lid on)', y: 0.95, approx: true },
    ],
    note: 'Whole-dish baking losses are typical values (ovens and bake times vary) — weighing the finished dish once beats any estimate.',
  },
  {
    name: 'Vegetables',
    items: [
      { name: 'Vegetables, roasted', y: 0.80, approx: true },
      { name: 'Vegetables, steamed', y: 0.95, approx: true },
      { name: 'Mushrooms, sautéed', y: 0.55, approx: true },
      { name: 'Spinach, wilted', y: 0.35, approx: true },
      { name: 'Onions, caramelized', y: 0.45, approx: true },
    ],
  },
];
