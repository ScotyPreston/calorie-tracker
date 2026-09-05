// Trusted label overrides: nutrition hand-typed off the REAL package, for
// barcodes whose database data is proven wrong. Checked before any online
// lookup, so scans and "Refresh data" always land on these numbers.
//
// Why this exists (Sola bagels, 9-03): Open Food Facts had the label's
// per-SERVING carbs/fat/fiber/sodium typed into its per-100g fields while
// protein and calories were true per-100g — internally consistent, so no
// math can catch it — and USDA's entry was a discontinued formulation.
// When no database has the truth, the package is the only source.
//
// Keys are the barcode with leading zeros stripped. perServing values are
// exactly what the Nutrition Facts panel prints (sodium in mg).

const OVERRIDES = {
  // Hellmann's Light Mayonnaise — OFF has the label's per-SERVING macro row
  // typed into its per-100g fields (3.5g fat "per 100g" on 233 kcal mayo —
  // impossible). Label row below confirmed against USDA branded GTIN
  // 048001213586 (233 kcal / 23.3g fat / 6.67g carbs / 733mg sodium per
  // 100g = exactly these numbers scaled). Added 2026-09-04.
  '48001213586': {
    name: "Light Mayonnaise (Hellmann's)",
    servingName: 'tbsp', servingGrams: 15,
    perServing: { kcal: 35, protein: 0, carbs: 1, fat: 3.5, fiber: 0, sugar: 0, sodium: 110, satFat: 0.5 },
  },
  // Sola Plain Bagels — label read off the package 2026-09-03
  '851921006875': {
    name: 'Plain Bagels (Sola)',
    servingName: 'bagel', servingGrams: 85,
    perServing: { kcal: 110, protein: 15, carbs: 35, fat: 3, fiber: 30, sugar: 1, sodium: 290, satFat: 0 },
  },
  // Cary's Sugar Free Low Calorie Syrup — OFF has the label's per-SERVING
  // kcal typed into per-100g (10 kcal/100 on syrup that's really 25) and
  // sodium 1000× low; carbs are sugar alcohols so the Atwater checks can't
  // see any of it. USDA branded GTIN 053900000328 = 25 kcal / 10g carbs /
  // 0 fat / 0 protein / 183mg sodium per 100ml — these 2-tbsp numbers are
  // exactly that ÷ 100 × 30 (ml ≈ g for logging). Added 2026-09-05.
  '53900000328': {
    name: "Sugar Free Low Calorie Syrup (Cary's)",
    servingName: '2 tbsp (30 ml)', servingGrams: 30,
    perServing: { kcal: 7.5, protein: 0, carbs: 3, fat: 0, fiber: null, sugar: 0, sodium: 55, satFat: 0 },
  },
};

export function labelOverride(code) {
  return OVERRIDES[String(code || '').replace(/^0+/, '')] || null;
}
