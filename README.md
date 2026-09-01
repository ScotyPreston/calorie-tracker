# Calorie Tracker

Offline-first calorie & macro tracker PWA. Static site — no backend, no build step.

## Deploy

Drag this whole folder onto https://app.netlify.com/drop (or push it to a GitHub repo connected to Netlify). Then on iPhone Safari: open the site → Share → **Add to Home Screen**.

HTTPS (which Netlify provides) is required for the camera/barcode scanner.

## What's inside

- **Diary** — daily dashboard: date pager, energy bar, protein/carbs/fat segmented bars, meal groups (Breakfast/Lunch/Dinner/Snacks — can be turned off in Settings), tap an entry to edit or delete.
- **Foods** — search, favorites (⭐ one-tap logs your usual portion), recents, barcode scan (ZXing), USDA search for generic foods, manual entry from a nutrition label.
- **Recipes** — a recipe IS a food: raw ingredient weights for macros, cooked batch weight for portioning, per-100g footer for meal prep, custom servings ("1 burrito — 285g"), FDA-style printable nutrition label with honest dashes for missing data.
- **Convert** — cooked ⇄ raw yield converter, also hooked into the recipe builder (⇄ buttons).
- **Settings** — daily targets, USDA API key, and **Export/Import JSON** (do this regularly — iOS can evict site storage).

## Data rules

- Every food stores nutrition **per 1 gram**; servings are just named gram amounts.
- Missing nutrients are `null` and display as a dash — never treated as zero.
- Log entries store resolved grams, so editing a food never rewrites history.
- All data lives in IndexedDB on the device. The JSON export is the backup.

## Update a deployed version

Edit files, bump `VERSION` in `sw.js` (so installed phones pick up the change), re-drop the folder on Netlify.


