// Cooked-to-raw yield data. y = cooking yield = cooked weight ÷ raw weight.
//   raw = cooked ÷ y      (y < 1: moisture/fat lost — meats)
//   y > 1 means water absorbed (grains) — "raw" is the dry weight.
//
// Sources: USDA Table of Cooking Yields for Meat and Poultry (ARS, 2012) and
// the USDA SR per-lean-ratio ground beef values derived from the same study.
// Items with approx:true are typical values where USDA has no measurement —
// they're marked ≈ in the UI. Do not "round" these numbers casually; the whole
// point of this tool is that the conversion is right.

export const YIELD_CATS = [
  {
    name: 'Ground beef',
    items: [
      { name: 'Crumbles, drained, 80/20', y: 0.67 },
      { name: 'Crumbles, drained, 85/15', y: 0.69 },
      { name: 'Crumbles, drained, 90/10', y: 0.71 },
      { name: 'Crumbles, drained, 93/7', y: 0.72 },
      { name: 'Patties, pan-cooked, 80/20', y: 0.73 },
      { name: 'Patties, pan-cooked, 85/15', y: 0.75 },
      { name: 'Patties, pan-cooked, 90/10', y: 0.76 },
      { name: 'Patties, pan-cooked, 93/7', y: 0.77 },
      { name: 'Patties, grilled, 80/20', y: 0.69 },
      { name: 'Patties, grilled, 85/15', y: 0.70 },
      { name: 'Patties, grilled, 90/10', y: 0.72 },
      { name: 'Patties, grilled, 93/7', y: 0.73 },
      { name: 'Meatloaf, baked, 80/20–85/15', y: 0.70 },
      { name: 'Meatloaf, baked, 90/10+', y: 0.72 },
    ],
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
