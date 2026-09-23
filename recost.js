/* recost.js — the single source of truth for macros.
 *
 * Every option in the Meal Bank is costed bottom-up from its own raw/dry
 * ingredient list against ONE food table: the one inside Close the Carbs.
 * That is the table that logs the food every day, so it is the one the plan
 * has to agree with. Before 19 September the bank's stored figures came from
 * a different source and the two disagreed on 39 of 78 options.
 *
 *   node recost.js            report only — what would change
 *   node recost.js --write    rewrite p/f/c in meal-bank.html
 *   node recost.js --check    exit 1 if anything is out of date (used by the generator)
 */
const fs = require('fs');
const path = require('path');

const BANK = path.join(__dirname, '..', 'src', 'meal-bank.html');
const CTC  = path.join(__dirname, '..', 'src', 'close-the-carbs.html');

function loadBank() {
  const H = fs.readFileSync(BANK, 'utf8');
  const a = H.indexOf('var TARGET = {'), b = H.indexOf('var byId={};');
  const D = (new Function(H.slice(a, b) +
    '\nreturn {M:M, parseIng:parseIng, CTC_FOOD:CTC_FOOD, fibrePer100:fibrePer100, SLOT_TARGET:SLOT_TARGET};'))();
  return { H, D };
}
function loadFoods() {
  const C = fs.readFileSync(CTC, 'utf8');
  const i = C.indexOf('const FOODS'), j = C.indexOf('];', i);
  const F = (new Function(C.slice(i, j + 2) + '\nreturn FOODS;'))();
  const by = {};
  F.forEach(f => by[f.n.toLowerCase()] = f);
  return by;
}

const { H, D } = loadBank();
const FOOD = loadFoods();

function lookup(bankName) {
  const mapped = D.CTC_FOOD[bankName];
  if (mapped && FOOD[mapped.toLowerCase()]) return FOOD[mapped.toLowerCase()];
  if (FOOD[bankName.toLowerCase()]) return FOOD[bankName.toLowerCase()];
  return null;
}
function costOf(o) {
  let p = 0, f = 0, c = 0, fib = 0;
  const missing = [];
  D.parseIng(o.ing).forEach(it => {
    if (!it.qty) return;
    const fd = lookup(it.name);
    if (!fd) { missing.push(it.name); return; }
    p += it.qty * fd.p / 100;
    f += it.qty * fd.f / 100;
    c += it.qty * fd.c / 100;
    fib += it.qty * D.fibrePer100(it.name) / 100;
  });
  const r1 = n => Math.round(n * 10) / 10;
  return { p: r1(p), f: r1(f), c: r1(c), fib: r1(fib), missing };
}

const rows = D.M.map(o => {
  const r = costOf(o);
  return { o, r, drift: Math.abs(r.p - o.p) > 0.05 || Math.abs(r.f - o.f) > 0.05 || Math.abs(r.c - o.c) > 0.05 };
});
const missing = {};
rows.forEach(x => x.r.missing.forEach(m => missing[m] = 1));

const mode = process.argv[2] || '';

if (Object.keys(missing).length) {
  console.error('INGREDIENTS WITH NO FOOD ROW:', Object.keys(missing).join(', '));
  process.exit(2);
}

if (mode === '--check') {
  const bad = rows.filter(x => x.drift);
  if (bad.length) {
    console.error('STORED MACROS OUT OF DATE for ' + bad.length + ' option(s): ' +
      bad.map(x => x.o.id).join(', ') + '\nRun: node recost.js --write');
    process.exit(1);
  }
  console.log('recost check: all ' + rows.length + ' options agree with their ingredients');
  process.exit(0);
}

const drifted = rows.filter(x => x.drift);
console.log(drifted.length + ' of ' + rows.length + ' options differ from their ingredient list\n');
drifted.forEach(x => {
  const o = x.o, r = x.r;
  console.log(o.id.padEnd(5),
    (o.p + '/' + o.f + '/' + o.c).padEnd(20), '->',
    (r.p + '/' + r.f + '/' + r.c).padEnd(20),
    ('Δ ' + (r.p - o.p).toFixed(1) + '/' + (r.f - o.f).toFixed(1) + '/' + (r.c - o.c).toFixed(1)).padEnd(22),
    o.name);
});

if (mode === '--write') {
  let s = H;
  drifted.forEach(x => {
    const id = x.o.id, r = x.r;
    const start = s.indexOf('{id:"' + id + '"');
    let end = s.indexOf('\n{id:"', start);
    if (end < 0) end = s.indexOf('\n];', start);
    let blk = s.slice(start, end);
    blk = blk.replace(/\bp:[0-9.]+/, 'p:' + r.p)
             .replace(/\bf:[0-9.]+/, 'f:' + r.f)
             .replace(/\bc:[0-9.]+/, 'c:' + r.c);
    s = s.slice(0, start) + blk + s.slice(end);
  });
  fs.writeFileSync(BANK, s);
  console.log('\nrewrote ' + drifted.length + ' option(s) in meal-bank.html');
}
