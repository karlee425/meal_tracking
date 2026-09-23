/* gen-bank-docs.js
 * Regenerates claude/Meal_Option_Bank.md and claude/Meal_Option_Bank_Index.csv
 * FROM THE LIVE BANK in meal-bank.html. Single source of truth = the artifact.
 * Usage: node gen-bank-docs.js            (writes ./out/Meal_Option_Bank.md and ./out/Meal_Option_Bank_Index.csv)
 * No calorie figure is ever emitted; the bank carries none.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'meal-bank.html'), 'utf8');

/* ---- pull the data block out of the page ------------------------------- */
const start = HTML.indexOf('var TARGET = {');
if (start < 0) throw new Error('could not find TARGET in meal-bank.html');
const endMark = 'var byId={};';
const end = HTML.indexOf(endMark);
if (end < 0) throw new Error('could not find byId anchor in meal-bank.html');
const block = HTML.slice(start, end);

const RET = 'return {M:M, SLOT_TARGET:SLOT_TARGET, TARGET:TARGET, NIGHT:NIGHT, SHIFT:SHIFT,' +
            ' SHIFT_FOOD:SHIFT_FOOD, YIELDS:YIELDS, COOKED_OVERRIDE:COOKED_OVERRIDE,' +
            ' FIBRE:FIBRE, SOLUBLE:SOLUBLE, FERMENTABLE:FERMENTABLE, STAPLES:STAPLES,' +
            ' parseIng:parseIng, fibrePer100:fibrePer100, yieldFor:yieldFor};';
const D = (new Function(block + '\n' + RET))();

const M = D.M, ST = D.SLOT_TARGET;

/* ---- helpers ----------------------------------------------------------- */
const r1 = n => (Math.round(n * 10) / 10).toFixed(1);
const SLOT_ORDER = ['breakfast', 'lunch', 'snack', 'dinner'];
const SLOT_HEAD = {
  breakfast: 'BREAKFASTS', lunch: 'LUNCHES',
  snack: 'AFTERNOON SNACKS', dinner: 'DINNERS'
};
const SLOT_TITLE = { breakfast: 'Breakfast', lunch: 'Lunch', snack: 'Snack', dinner: 'Dinner' };
const numOf = id => parseInt(id.replace(/^[A-Z]+/, ''), 10);
const inSlot = s => M.filter(o => o.slot === s).sort((a, b) => numOf(a.id) - numOf(b.id));

/* carb vs slot: a "native" day type per option (lift unless flagged) */
function slotRow(o) { return ST[o.slot][o.native || 'lift']; }
function slotCarb(o) { return slotRow(o)[2]; }
function slotP(o) { return slotRow(o)[0]; }
function slotF(o) { return slotRow(o)[1]; }

function vsSlot(o) {
  const d = o.c - slotCarb(o);
  return (d >= 0 ? '+' : '') + r1(d);
}

function laneTime(o) {
  const bits = [o.lane];
  if (o.min) bits.push(o.min + ' min');
  if (o.batch && o.batch > 1) bits.push('batches ' + o.batch);
  return bits.join(' · ');
}

const fromIG = o => /from Instagram/i.test(o.lane || '');

function nameCell(o) {
  let n = o.name;
  if (o.native === 'rest') n += ' *(rest-day build)*';
  if (o.native === 'long') n += ' *(long-run build)*';
  if (fromIG(o)) n += ' — **new, awaiting a verdict**';
  else if (o.isnew) n += ' — **new**';
  if (o.id === 'B8') n += ' ⚠️';
  return n;
}

function ingLine(o) {
  return D.parseIng(o.ing).map(it => it.name + ' ' + it.qty + ' g').join(' · ');
}

/* ---- markdown ---------------------------------------------------------- */
function slotSection(slot, blurb) {
  const rows = inSlot(slot);
  let md = '\n# ' + SLOT_HEAD[slot] + '\n*' + blurb + '*\n\n';
  md += '| | Option | P / F / C | vs slot carb | Starch base | Lane · time |\n';
  md += '|---|---|---|---|---|---|\n';
  rows.forEach(o => {
    md += '| **' + o.id + '** | ' + nameCell(o) + ' | ' +
      r1(o.p) + ' / ' + r1(o.f) + ' / ' + r1(o.c) + ' | ' +
      vsSlot(o) + ' | ' + (o.base || '—') + ' | ' + laneTime(o) + ' |\n';
  });
  md += '\n<details><summary>Raw / dry ingredients per serving</summary>\n\n';
  rows.forEach(o => {
    md += '**' + o.id + ' ' + o.name + '** — ' + ingLine(o) + '\n';
    md += '*Plated ' + (o.wt || '—') + '. Base: ' + (o.base || '—') + '.*\n\n';
  });
  md += '</details>\n\n';
  return md;
}

const STAMP = process.env.BANK_STAMP || '12 September 2026';
const VER = process.env.BANK_VER || 'v10';

let md = '';
md += '# Standing Meal Option Bank\n';
md += '**Generated from the live Meal Bank page (' + VER + ') on ' + STAMP + ' — ' + M.length + ' options.**\n';
md += 'All figures in grams. No calorie column anywhere in this file, by standing instruction.\n\n';
md += '> **This file is generated, not hand-maintained.** The Meal Bank page is the source of truth;\n';
md += '> `gen-bank-docs.js` reads its option array and writes this document and\n';
md += '> `Meal_Option_Bank_Index.csv` together. Anything added to the bank is regenerated into both\n';
md += '> in the same turn, so the three can no longer drift. If you are about to edit a number here\n';
md += '> by hand, edit the page instead and regenerate.\n\n';
md += '---\n\n';
md += '## Slot targets — Revision 4, agreed 30 August 2026\n\n';
md += 'See `Per_Meal_Distribution_Rev4_30Aug2026.md`. Daily totals: **lifting ' +
  D.TARGET.lift.p + ' P / ' + D.TARGET.lift.f + ' F / ' + D.TARGET.lift.c +
  ' C · long run ' + D.TARGET.long.p + ' / ' + D.TARGET.long.f + ' / ' + D.TARGET.long.c +
  ' · rest ' + D.TARGET.rest.p + ' / ' + D.TARGET.rest.f + ' / ' + D.TARGET.rest.c + '.**\n\n';
md += '| Slot | Lifting (Mon–Fri) | Rest (Sun) | Long run (Sat) |\n|---|---|---|---|\n';
SLOT_ORDER.forEach(s => {
  const t = ST[s];
  md += '| ' + SLOT_TITLE[s] + ' | ' + t.lift[0] + ' P · ' + t.lift[1] + ' F · ' + t.lift[2] + ' C | ' +
    t.rest.join(' · ') + ' | ' + t.long.join(' · ') + ' |\n';
});
md += '| Night snack (fixed) | ' + Math.round(D.NIGHT.p) + ' P · ' + Math.round(D.NIGHT.f) +
  ' F · ' + Math.round(D.NIGHT.c) + ' C | same | same |\n\n';
md += '**Everything below is written at lifting-day size** unless a row says otherwise. Protein and fat\n';
md += 'hold constant across day types; only carbohydrate scales. The scaling table at the end gives the\n';
md += 'exact food changes for Saturday and Sunday.\n\n';

const counts = SLOT_ORDER.map(s => inSlot(s).length);
md += '**A normal week is** one or two breakfasts, two lunches batched across five weekday servings,\n';
md += 'five dinners, and a couple of snacks rotated. **' + M.length + ' options** — ' +
  counts[0] + ' breakfasts, ' + counts[1] + ' lunches, ' + counts[2] + ' snacks, ' +
  counts[3] + ' dinners.\n\n';
md += '**Two deliberate absences.** No fish in any office lunch: smell is a hard requirement and salmon\n';
md += 'or tuna in a shared fridge fails it regardless of macros. And nothing here relies on a protein\n';
md += 'portion that crowds the starch off the plate — if an option looks light on meat, that is the\n';
md += 'design.\n\n---\n';

md += slotSection('breakfast', 'Hers only. Most are eaten in the car, so anything here either travels in a jar or is handheld.');
md += slotSection('lunch', 'Batched, packable, low smell, good cold or reheated. Per-serving weights — multiply by the number of servings you are batching.');
md += slotSection('snack', 'Rebuilt 30 August at 15 g of protein. Most need no spoon, several need no fridge, and none needs protein powder.');
md += slotSection('dinner', 'Cooked for two, 30–45 minutes, leftover-friendly. Weights shown are her plate — cook the full protein and weigh her portion off it.');

md += '---\n\n# SCALING BETWEEN DAY TYPES\n\nProtein and fat hold. **Only carbohydrate moves.**\n\n';
md += '| Slot | Rest day (Sun) | Long-run day (Sat) |\n|---|---|---|\n';
SLOT_ORDER.forEach(s => {
  const sh = D.SHIFT[s];
  md += '| ' + SLOT_TITLE[s] + ' | ' + sh.rest + ' g carb | +' + sh.long + ' g carb |\n';
});
md += '\n**What that is in food:**\n\n';
md += '| Move | −18 g C | −22 g C | −27 g C | +12 g C | +15 g C | +18 g C |\n';
md += '|---|---|---|---|---|---|---|\n';
md += '| White/jasmine rice, dry | −23 g | −28 g | — | +15 g | +19 g | +23 g |\n';
md += '| *(cooked equivalent)* | *−69 g* | *−85 g* | — | *+46 g* | *+58 g* | *+69 g* |\n';
md += '| Pasta / orzo, dry | −24 g | −29 g | — | +16 g | +20 g | +24 g |\n';
md += '| Potato, raw | −103 g | −126 g | — | +69 g | +86 g | +103 g |\n';
md += '| Sweet potato, raw | −90 g | −109 g | — | +60 g | +75 g | +90 g |\n';
md += '| Rolled oats, dry | — | — | −40 g | — | — | +27 g |\n';
md += '| Banana | −79 g | −96 g | −118 g | +53 g | +66 g | +79 g |\n';
md += '| Sourdough | — | — | −54 g | — | — | +36 g |\n\n';
md += '**Saturday is a window, not a plate.** ' + ST.breakfast.long[2] +
  ' g of breakfast carbohydrate does not go on one plate, and\n';
md += 'Saturday is the only day breakfast is not the post-lift meal. B9 is built that way already:\n';
md += 'about 60 g of carbohydrate pre-run, 15–20 g an hour during, the rest in a protein-and-fat bowl\n';
md += 'within 45 minutes after.\n\n---\n\n';

/* assembly rules + retired are editorial; carried forward verbatim */
md += fs.readFileSync(path.join(__dirname, 'bank-tail.md'), 'utf8');

/* ---- csv --------------------------------------------------------------- */
function q(v) {
  v = (v === undefined || v === null) ? '' : String(v);
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
const HEAD = ['Option', 'Slot', 'Status', 'Lane', 'Native_day', 'Servings_per_batch', 'Prep_min',
  'Protein_g', 'Fat_g', 'Carbs_g', 'Slot_protein_g', 'Slot_fat_g', 'Slot_carb_g', 'Carb_vs_slot',
  'Plated_serving', 'Starch_base', 'Ingredients_raw_dry_per_serving'];
const lines = [HEAD.join(',')];
SLOT_ORDER.forEach(s => {
  inSlot(s).forEach(o => {
    lines.push([
      o.id + ' ' + o.name, SLOT_TITLE[s],
      fromIG(o) ? 'NEW 12Sep - unverdicted' : (o.isnew ? 'NEW Rev4' : 'Rev4'), o.lane,
      o.native === 'rest' ? 'rest' : (o.native === 'long' ? 'long' : 'lifting'),
      o.batch || 1, o.min || '',
      r1(o.p), r1(o.f), r1(o.c),
      slotP(o), slotF(o), slotCarb(o), vsSlot(o).replace('+', ''),
      (o.wt || '').replace(/^≈\s*/, ''), o.base || '',
      D.parseIng(o.ing).map(it => it.name + ' ' + it.qty + ' g').join('; ')
    ].map(q).join(','));
  });
});
const csv = lines.join('\r\n') + '\r\n';

/* ---- guard: stored macros must still match the ingredient lists --------- */
try {
  require('child_process').execFileSync(process.execPath,
    [path.join(__dirname, 'recost.js'), '--check'], { stdio: 'pipe' });
} catch (e) {
  const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
  throw new Error('refusing to generate — the bank disagrees with its own ingredients:\n' + out);
}

/* ---- guard: no calorie figure may leave this script -------------------- */
const BAD = /\b(kcal|calorie|calories|cals)\b/i;
[['md', md], ['csv', csv]].forEach(([k, v]) => {
  const hit = v.split('\n').find(l => BAD.test(l) && !/No calorie column/i.test(l));
  if (hit) throw new Error('calorie figure leaked into ' + k + ': ' + hit);
});

fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'out', 'Meal_Option_Bank.md'), md);
fs.writeFileSync(path.join(__dirname, 'out', 'Meal_Option_Bank_Index.csv'), csv);
console.log('wrote', M.length, 'options —', counts.join('/'), '(b/l/s/d);',
  lines.length - 1, 'csv rows');
