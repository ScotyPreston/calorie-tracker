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
  [/chicken.*tender|tender.*chicken/i, 'Chicken tenderloins, cooked', 0.71],
  [/turkey.*breast|breast.*turkey/i, 'Turkey breast, roasted', 0.70],
  [/chicken.*breast|breast/i, 'Chicken breast, baked', 0.72],
  [/chicken.*thigh|thigh/i, 'Chicken thigh, baked', 0.69],
  [/rotisserie|whole chicken/i, 'Whole chicken, roasted', 0.78],
  [/chicken/i, 'Chicken, baked', 0.72],
  [/ground (beef|chuck)|beef.*ground|hamburger/i, 'Ground beef crumbles, 90/10', 0.71],
  [/ground turkey|turkey.*ground/i, 'Ground turkey, cooked', 0.74],
  [/turkey/i, 'Turkey, roasted', 0.72],
  [/duck/i, 'Duck, cooked', 0.70],
  [/lamb/i, 'Lamb, cooked', 0.78],
  [/veal/i, 'Veal, cooked', 0.78],
  [/brisket/i, 'Brisket, braised', 0.69],
  // fish before the beef-steak rule: "swordfish steak" / "ahi tuna steak" must not hit it
  [/salmon/i, 'Salmon, baked', 0.78],
  [/tuna.*steak|\bahi\b/i, 'Tuna steak, grilled', 0.80], // plain "tuna" is usually canned (already cooked) — no rule
  [/halibut|mahi|swordfish|grouper|snapper|sea bass|striped bass|trout|walleye|perch/i, 'Fish fillet, cooked', 0.80],
  [/catfish/i, 'Catfish, pan-fried', 0.78],
  [/flounder|sole/i, 'Flounder / sole, baked', 0.81],
  [/tilapia|cod|haddock|pollock|fish/i, 'White fish, baked', 0.81],
  [/shrimp|prawn/i, 'Shrimp, cooked', 0.75],
  [/scallop/i, 'Scallops, seared', 0.70],
  [/lobster/i, 'Lobster, steamed', 0.85],
  [/crab/i, 'Crab, steamed', 0.90],
  [/calamari|squid/i, 'Calamari / squid, cooked', 0.65],
  [/octopus/i, 'Octopus, simmered', 0.60],
  [/mussel|clam|oyster/i, 'Mussels / clams, steamed', 0.95],
  [/thin.*(steak|ribeye|sirloin|cut)|(steak|ribeye|sirloin).*thin/i, 'Steak, thin-cut, pan-seared', 0.72],
  [/steak|sirloin|ribeye|filet|beef/i, 'Steak, grilled', 0.76],
  [/bacon/i, 'Bacon, pan-fried', 0.31],
  [/sausage/i, 'Sausage, pan-fried', 0.80],
  [/pork.*tenderloin|tenderloin.*pork/i, 'Pork tenderloin, roasted', 0.80],
  [/pork/i, 'Pork chop / loin, cooked', 0.79],
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

// Lean-ratio-aware ground meat guessing: "80/20 Ground Beef" in a recipe must
// use the 80/20 crumbles factor, not the generic 90/10 default. Keyed by the
// lean number; nearest key wins. Crumbles factors — the typical recipe use.
const GROUND_LEAN = {
  beef: { 80: ['Ground beef crumbles, 80/20', 0.67], 85: ['Ground beef crumbles, 85/15', 0.69], 90: ['Ground beef crumbles, 90/10', 0.71], 93: ['Ground beef crumbles, 93/7', 0.72] },
  turkey: { 85: ['Ground turkey crumbles, 85/15', 0.72], 93: ['Ground turkey crumbles, 93/7', 0.74], 99: ['Ground turkey crumbles, 99/1', 0.76] },
  chicken: { 92: ['Ground chicken crumbles', 0.73], 99: ['Ground chicken crumbles, 99/1', 0.75] },
};

export function guessYield(name) {
  const n = name || '';
  const lean = /(\d{2})\s*\/\s*(\d{1,2})/.exec(n);
  if (lean && /ground|hamburger|beef|turkey|chicken/i.test(n)) {
    const table = /turkey/i.test(n) ? GROUND_LEAN.turkey : /chicken/i.test(n) ? GROUND_LEAN.chicken : GROUND_LEAN.beef;
    const want = +lean[1];
    const key = Object.keys(table).reduce((a, b) => Math.abs(b - want) < Math.abs(a - want) ? b : a);
    const [label, factor] = table[key];
    return { label, factor };
  }
  for (const [re, label, factor] of GUESSES) {
    if (re.test(n)) return label ? { label, factor } : null;
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
  [/turkey|duck/i, 'Turkey & duck'],
  [/lamb|veal/i, 'Lamb & veal'],
  // fish before steak: "swordfish steak" / "tuna steak" must not fall into Steak & roast
  [/salmon|tilapia|cod|haddock|pollock|tuna|\bahi\b|halibut|mahi|swordfish|grouper|snapper|bass|trout|walleye|perch|catfish|flounder|sole|shrimp|prawn|scallop|lobster|crab|calamari|squid|octopus|mussel|clam|oyster|fish/i, 'Fish & seafood'],
  // pork before steak: "pork loin roast" must not fall into Steak & roast via "roast"
  [/pork|\bham\b/i, 'Pork'],
  [/steak|sirloin|ribeye|filet|brisket|beef|roast|liver/i, 'Steak & roast'],
  [/potato/i, 'Potatoes'],
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
      { name: 'Beef patties, air-fried, 80/20', y: 0.69, approx: true },
      { name: 'Beef patties, air-fried, 85/15', y: 0.70, approx: true },
      { name: 'Beef patties, air-fried, 90/10', y: 0.72, approx: true },
      { name: 'Beef patties, air-fried, 93/7', y: 0.73, approx: true },
      { name: 'Turkey patties, air-fried', y: 0.75, approx: true },
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
      { name: 'Breast, air-fried', y: 0.72 },
      { name: 'Breast, poached or simmered', y: 0.77 },
      { name: 'Tenderloins, baked / roasted', y: 0.71, approx: true },
      { name: 'Tenderloins, air-fried', y: 0.71, approx: true },
      { name: 'Tenderloins, grilled or pan-cooked', y: 0.70, approx: true },
      { name: 'Breast cutlets, thin-sliced, pan-cooked', y: 0.68, approx: true },
      { name: 'Breast, bone-in, roasted', y: 0.75, approx: true },
      { name: 'Thigh, baked / roasted', y: 0.69 },
      { name: 'Thigh, grilled or pan-cooked', y: 0.68, approx: true },
      { name: 'Thigh, air-fried', y: 0.69 },
      { name: 'Thigh, simmered', y: 0.74 },
      { name: 'Thigh, bone-in, roasted', y: 0.72, approx: true },
      { name: 'Drumstick, baked / roasted', y: 0.76 },
      { name: 'Drumstick, air-fried', y: 0.76 },
      { name: 'Drumstick, grilled', y: 0.74, approx: true },
      { name: 'Wings, baked / roasted', y: 0.74 },
      { name: 'Wings, air-fried', y: 0.74 },
      { name: 'Wings, grilled', y: 0.72, approx: true },
      { name: 'Wings, deep-fried', y: 0.66 },
      { name: 'Leg quarter, roasted', y: 0.74, approx: true },
      { name: 'Whole bird, roasted', y: 0.78 },
    ],
    note: 'Air frying is convection roasting, so air-fried uses the same yield as baked. Tenderloins aren\'t USDA-measured — they run just under breast because they\'re thinner.',
  },
  {
    name: 'Steak & roast',
    items: [
      { name: 'Steak, average cut, grilled', y: 0.76 },
      { name: 'Steak, average cut, pan-seared', y: 0.76, approx: true },
      { name: 'Steak, average cut, broiled', y: 0.76, approx: true },
      { name: 'Steak, average cut, baked / oven', y: 0.76, approx: true },
      { name: 'Steak, average cut, air-fried', y: 0.78, approx: true },
      { name: 'Steak, thin-cut (any), pan-seared', y: 0.72, approx: true },
      { name: 'Steak, sous vide + seared', y: 0.85, approx: true },
      { name: 'Ribeye, grilled', y: 0.84 },
      { name: 'Ribeye, thin-cut, pan-seared or grilled', y: 0.78, approx: true },
      { name: 'NY strip, grilled', y: 0.82 },
      { name: 'T-bone / porterhouse, grilled', y: 0.79, approx: true },
      { name: 'Top sirloin, grilled', y: 0.80 },
      { name: 'Tenderloin / filet mignon, grilled', y: 0.80 },
      { name: 'Flat iron, grilled', y: 0.79, approx: true },
      { name: 'Flank steak, grilled', y: 0.81 },
      { name: 'Skirt steak, grilled', y: 0.70 },
      { name: 'Hanger steak, grilled', y: 0.78, approx: true },
      { name: 'Chuck steak, grilled', y: 0.74, approx: true },
      { name: 'Cube steak, pan-fried', y: 0.72, approx: true },
      { name: 'Top round / London broil', y: 0.72 },
      { name: 'Roast, oven-roasted', y: 0.79 },
      { name: 'Roast, air-fried', y: 0.79, approx: true },
      { name: 'Beef tenderloin roast, roasted', y: 0.82, approx: true },
      { name: 'Eye of round roast', y: 0.81 },
      { name: 'Sirloin tip roast', y: 0.78, approx: true },
      { name: 'Tri-tip roast', y: 0.84 },
      { name: 'Prime rib / ribeye roast', y: 0.77 },
      { name: 'Pot roast (chuck), braised', y: 0.66 },
      { name: 'Brisket, braised', y: 0.69 },
      { name: 'Brisket, smoked', y: 0.60, approx: true },
      { name: 'Corned beef, simmered', y: 0.62, approx: true },
      { name: 'Short ribs, braised', y: 0.66 },
      { name: 'Stew meat, simmered', y: 0.67 },
      { name: 'Beef kabobs, grilled', y: 0.75, approx: true },
      { name: 'Liver, pan-fried', y: 0.72, approx: true },
    ],
    note: 'Thin cuts lose a little more than thick ones (more surface area drying out). Smoking loses the most — long cook, low moisture.',
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
      { name: 'Chop, baked / roasted', y: 0.79, approx: true },
      { name: 'Chop, air-fried', y: 0.79, approx: true },
      { name: 'Chop, thin-cut, pan-fried', y: 0.74, approx: true },
      { name: 'Cutlets, thin-sliced, pan-cooked', y: 0.74, approx: true },
      { name: 'Tenderloin, roasted', y: 0.80 },
      { name: 'Tenderloin, grilled', y: 0.79, approx: true },
      { name: 'Tenderloin, air-fried', y: 0.80, approx: true },
      { name: 'Loin roast, roasted', y: 0.79 },
      { name: 'Shoulder / blade steak, braised', y: 0.65 },
      { name: 'Shoulder butt, smoked (pulled)', y: 0.60, approx: true },
      { name: 'Shoulder picnic, braised (pulled)', y: 0.74 },
      { name: 'Country-style ribs, baked', y: 0.72, approx: true },
      { name: 'Spareribs, roasted', y: 0.76 },
      { name: 'Back ribs, roasted', y: 0.82 },
      { name: 'Ribs, smoked', y: 0.65, approx: true },
      { name: 'Pork belly, roasted', y: 0.65, approx: true },
      { name: 'Ham, baked, bone-in', y: 0.90 },
      { name: 'Ham steak, pan-cooked', y: 0.85, approx: true },
      { name: 'Ground pork, crumbles', y: 0.67 },
      { name: 'Ground pork, patties', y: 0.68 },
    ],
  },
  {
    name: 'Turkey & duck',
    items: [
      { name: 'Turkey breast, roasted', y: 0.70, approx: true },
      { name: 'Turkey breast, air-fried', y: 0.70, approx: true },
      { name: 'Turkey breast cutlets, pan-cooked', y: 0.68, approx: true },
      { name: 'Turkey tenderloin, roasted', y: 0.74, approx: true },
      { name: 'Turkey thigh, roasted', y: 0.72, approx: true },
      { name: 'Turkey legs, roasted or smoked', y: 0.70, approx: true },
      { name: 'Whole turkey, roasted', y: 0.78, approx: true },
      { name: 'Duck breast, pan-seared', y: 0.70, approx: true },
      { name: 'Whole duck, roasted', y: 0.72, approx: true },
    ],
    note: 'Ground turkey lives under Ground meat; turkey sausage under Bacon & sausage.',
  },
  {
    name: 'Lamb & veal',
    items: [
      { name: 'Lamb chop, grilled or broiled', y: 0.80, approx: true },
      { name: 'Lamb chop, air-fried', y: 0.80, approx: true },
      { name: 'Lamb leg, roasted', y: 0.77, approx: true },
      { name: 'Lamb shoulder, braised', y: 0.66, approx: true },
      { name: 'Ground lamb, crumbles', y: 0.67, approx: true },
      { name: 'Veal chop, grilled', y: 0.80, approx: true },
      { name: 'Veal cutlet, pan-fried', y: 0.78, approx: true },
    ],
  },
  {
    name: 'Bacon & sausage',
    items: [
      { name: 'Bacon, pan-fried', y: 0.31 },
      { name: 'Bacon, baked', y: 0.32 },
      { name: 'Bacon, microwaved', y: 0.29 },
      { name: 'Bacon, air-fried', y: 0.32, approx: true },
      { name: 'Pork sausage, pan-fried', y: 0.80 },
      { name: 'Pork sausage, air-fried', y: 0.80, approx: true },
      { name: 'Turkey sausage, grilled', y: 0.77 },
      { name: 'Turkey sausage, air-fried', y: 0.77, approx: true },
    ],
  },
  {
    name: 'Fish & seafood',
    items: [
      { name: 'Salmon, baked or grilled', y: 0.78, approx: true },
      { name: 'Salmon, pan-seared', y: 0.78, approx: true },
      { name: 'Salmon, air-fried', y: 0.78, approx: true },
      { name: 'Salmon, poached', y: 0.83, approx: true },
      { name: 'Salmon, hot-smoked', y: 0.70, approx: true },
      { name: 'White fish (cod, tilapia, haddock), baked', y: 0.81, approx: true },
      { name: 'White fish (cod, tilapia, haddock), grilled', y: 0.79, approx: true },
      { name: 'White fish (cod, tilapia, haddock), pan-fried', y: 0.79, approx: true },
      { name: 'White fish (cod, tilapia, haddock), air-fried', y: 0.81, approx: true },
      { name: 'White fish, steamed or poached', y: 0.85, approx: true },
      { name: 'Firm fish (halibut, mahi, swordfish), grilled', y: 0.80, approx: true },
      { name: 'Firm fish (halibut, mahi, swordfish), baked', y: 0.80, approx: true },
      { name: 'Firm fish (halibut, mahi, swordfish), pan-seared', y: 0.79, approx: true },
      { name: 'Firm fish (halibut, mahi, swordfish), air-fried', y: 0.80, approx: true },
      { name: 'Tuna steak, grilled or pan-seared', y: 0.80, approx: true },
      { name: 'Tuna steak, air-fried', y: 0.80, approx: true },
      { name: 'Catfish, pan-fried', y: 0.78, approx: true },
      { name: 'Catfish, baked or air-fried', y: 0.79, approx: true },
      { name: 'Trout, baked or grilled', y: 0.80, approx: true },
      { name: 'Trout, pan-cooked', y: 0.79, approx: true },
      { name: 'Snapper / sea bass, baked', y: 0.80, approx: true },
      { name: 'Snapper / sea bass, pan-seared', y: 0.79, approx: true },
      { name: 'Flounder / sole, baked', y: 0.81, approx: true },
      { name: 'Flounder / sole, pan-fried', y: 0.79, approx: true },
      { name: 'Shrimp, sautéed or boiled', y: 0.75, approx: true },
      { name: 'Shrimp, grilled', y: 0.73, approx: true },
      { name: 'Shrimp, air-fried', y: 0.75, approx: true },
      { name: 'Shrimp, steamed', y: 0.80, approx: true },
      { name: 'Scallops, pan-seared', y: 0.70, approx: true },
      { name: 'Scallops, baked or broiled', y: 0.72, approx: true },
      { name: 'Scallops, air-fried', y: 0.70, approx: true },
      { name: 'Lobster tail, steamed or boiled', y: 0.85, approx: true },
      { name: 'Lobster tail, grilled or broiled', y: 0.80, approx: true },
      { name: 'Crab legs, steamed', y: 0.90, approx: true },
      { name: 'Mussels / clams, steamed (in shell)', y: 0.95, approx: true },
      { name: 'Calamari / squid, sautéed or fried', y: 0.65, approx: true },
      { name: 'Octopus, simmered', y: 0.60, approx: true },
    ],
    note: 'Fish isn\'t in the USDA yield table — these are typical values. Scallops, squid and octopus shrink the most (lots of water). Weigh one batch raw and cooked to dial in your own.',
  },
  {
    name: 'Air fryer',
    items: [
      { name: 'Chicken breast', y: 0.72 },
      { name: 'Chicken tenderloins', y: 0.71, approx: true },
      { name: 'Chicken thighs', y: 0.69 },
      { name: 'Chicken drumsticks', y: 0.76 },
      { name: 'Chicken wings', y: 0.74 },
      { name: 'Steak', y: 0.78 },
      { name: 'Pork chops', y: 0.79 },
      { name: 'Pork tenderloin', y: 0.80 },
      { name: 'Turkey breast', y: 0.70, approx: true },
      { name: 'Lamb chops', y: 0.80, approx: true },
      { name: 'Bacon', y: 0.32 },
      { name: 'Sausage', y: 0.80, approx: true },
      { name: 'Salmon', y: 0.78, approx: true },
      { name: 'White fish (cod, tilapia)', y: 0.81, approx: true },
      { name: 'Tuna steak', y: 0.80, approx: true },
      { name: 'Shrimp', y: 0.75, approx: true },
      { name: 'Scallops', y: 0.70, approx: true },
      { name: 'Vegetables', y: 0.80, approx: true },
      { name: 'Potato chunks or fries', y: 0.75, approx: true },
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
      { name: 'Sheet-pan bake (meat + veg), oven', y: 0.78, approx: true },
      { name: 'Air-fried batch', y: 0.76, approx: true },
      { name: 'Pan-cooked / sautéed batch', y: 0.78, approx: true },
      { name: 'Pan-fried batch', y: 0.75, approx: true },
      { name: 'Stir-fry, wok or skillet', y: 0.78, approx: true },
      { name: 'Soup / stew, simmered uncovered', y: 0.85, approx: true },
      { name: 'Slow cooker (lid on)', y: 0.95, approx: true },
      { name: 'Instant Pot / pressure cooker', y: 0.95, approx: true },
    ],
    note: 'Whole-dish baking losses are typical values (ovens and bake times vary) — weighing the finished dish once beats any estimate.',
  },
  {
    name: 'Vegetables',
    items: [
      { name: 'Vegetables, roasted', y: 0.80, approx: true },
      { name: 'Vegetables, air-fried', y: 0.80, approx: true },
      { name: 'Vegetables, steamed', y: 0.95, approx: true },
      { name: 'Mushrooms, sautéed', y: 0.55, approx: true },
      { name: 'Spinach, wilted', y: 0.35, approx: true },
      { name: 'Onions, caramelized', y: 0.45, approx: true },
    ],
  },
];
