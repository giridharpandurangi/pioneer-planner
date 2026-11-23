// End-to-end checks against the newest local save: `npm test`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OUTPUT_DIR } from '../src/config.js';
import * as A from '../src/core/actions.js';
import { currentModel, gameData } from '../src/core/session.js';
import { planProduction } from '../src/planner/plan.js';
import { generateLayout } from '../src/layout/layout.js';

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
};

const gd = gameData();
const m = currentModel();

test('game data has belts with real speeds', () => {
  assert.deepEqual(gd.beltTiers.map((b) => b.itemsPerMin).slice(0, 2), [60, 120]);
});
test('save parsed with unlocks and nodes', () => {
  assert.ok(m.unlocks.machineRecipes.length > 0);
  assert.ok(m.nodes.length > 300, 'expected the map resource nodes in the save');
  assert.ok(m.unlocks.belt, 'a belt tier is unlocked');
});
test('status / improvements / unlocks render', () => {
  for (const r of [A.statusAction(), A.improveAction(), A.unlocksAction(), A.contextAction()]) assert.ok(r.markdown.length > 100);
});
test('planner only uses unlocked recipes', () => {
  const item = gd.recipes[m.unlocks.machineRecipes.find((r) => gd.recipes[r].products[0])].products[0].item;
  const p = planProduction(gd, m, { targets: [{ item, rate: 10 }] });
  assert.ok(p.ok, p.message);
  for (const s of p.steps) assert.ok(m.unlocks.machineRecipes.includes(s.recipe), `${s.recipeName} is not unlocked`);
});
test('locked target explains what to unlock', () => {
  const locked = Object.values(gd.recipes).find((r) => r.kind === 'machine' && !r.alternate && !m.unlocks.hasRecipe(r.id) && !(gd.producers[r.products[0].item] || []).some((x) => m.unlocks.hasRecipe(x)));
  const p = planProduction(gd, m, { targets: [{ item: locked.products[0].item, rate: 1 }] });
  assert.equal(p.ok, false);
  assert.match(p.message, /unlock/i);
});
test('every belt in a layout respects the unlocked belt speed', () => {
  const target = m.unlocks.hasRecipe('Recipe_IronPlateReinforced_C') ? 'Reinforced Iron Plate' : 'Iron Plate';
  for (const area of [{ mode: 'foundation', width: 64, length: 64 }, { mode: 'foundation', width: 48, length: 48, floors: 'auto' }, { mode: 'ground' }]) {
    const p = planProduction(gd, m, { targets: [{ item: target, rate: target === 'Iron Plate' ? 90 : 7.5 }] });
    assert.ok(p.ok, p.message);
    const lay = generateLayout(gd, p, area, m);
    const cap = p.logistics.beltCap;
    for (const f of lay.elements) for (const b of f.belts) if (!b.fluid) assert.ok(b.rate <= cap + 0.01, `${b.name} belt carries ${b.rate}/min > ${cap}`);
    for (const s of p.steps) for (const io of [...s.perMachine.inputs, ...s.perMachine.outputs]) assert.ok(io.rate <= cap + 0.01, `${s.recipeName} port ${io.name} ${io.rate} > ${cap}`);
  }
});
test('blueprint export re-reads cleanly with all connections valid', () => {
  const r = A.designAction({ targets: [{ item: 'Iron Plate', rate: 30 }] }, { mode: 'foundation', blueprint: true });
  assert.ok(r.data.blueprints?.list.length, 'a blueprint was written');
  for (const b of r.data.blueprints.list) {
    assert.ok(b.verify.ok, b.verify.problems.join('; '));
    assert.ok(b.verify.connections > 0, 'has belt connections');
  }
  fs.rmSync(r.data.files.dir, { recursive: true, force: true });
});
test('node selection restricts raw supply to those nodes', () => {
  const iron = m.nodes.filter((n) => n.resource === 'Desc_OreIron_C').slice(0, 2).map((n) => n.short);
  const p = planProduction(gd, m, { targets: [{ item: 'Iron Plate', rate: 10 }], nodes: iron, rebuild: true });
  assert.ok(p.ok, p.message);
  for (const n of p.nodes) assert.ok(iron.includes(n.node), `used node ${n.node} outside the selection`);
});
test('rebuild never says to dismantle before shortages are covered', () => {
  const r = A.rebuildAction({ nearestNodes: 3, nodeResources: ['Iron Ore'] }, { mode: 'ground' }, { scope: 'near' });
  if (!r.data.check) return; // nothing to plan in this save
  const steps = r.data.check.steps;
  const firstDismantle = steps.findIndex((s) => /^Dismantle/.test(s));
  const waits = r.data.check.shortages.filter((a) => a.how === 'wait' || (a.how === 'craft' && !a.after.length));
  if (waits.length && firstDismantle >= 0) assert.ok(steps.findIndex((s) => /Before you dismantle/.test(s)) < firstDismantle, 'stock-up must come before dismantling');
  assert.ok(r.markdown.includes('Order of work'));
  // visual guide: one card per step, with diagrams, written next to the sketch
  const cards = (r.data.guideHtml.match(/class="rg-step /g) || []).length;
  assert.equal(cards, r.data.check.timeline.length, 'a card for every step');
  assert.ok(r.data.guideHtml.includes('<svg'), 'diagrams drawn');
  assert.ok(fs.existsSync(r.data.files.guide), 'rebuild-guide.html written');
  fs.rmSync(r.data.files.dir, { recursive: true, force: true });
});
test('automatic amounts: milestones and items modes', () => {
  const iron = m.nodes.filter((n) => n.resource === 'Desc_OreIron_C').slice(0, 3).map((n) => n.short);
  const ms = A.planAction({ goal: 'milestones', nodes: iron, rebuild: true });
  assert.ok(ms.data.goal || /Nothing is missing|No plan possible/.test(ms.markdown), 'milestones mode answered');
  const items = A.planAction({ targets: [{ item: 'Iron Plate' }], nodes: iron, rebuild: true });
  assert.equal(items.data.goal?.mode, 'items');
  assert.ok(items.data.goal.targets[0].rate > 0, 'picked a rate automatically');
});
test('upgrade line + compare plan at better tiers', () => {
  const lines = A.linesAction().data.lines.filter((l) => l.miners.length);
  if (lines.length) {
    const u = A.upgradeLineAction({ line: lines[0].line, beltTier: 6, minerTier: 3 });
    assert.ok(u.data.products.every((p) => p.after >= p.now - 0.5), 'upgrade never lowers output');
    assert.ok(u.markdown.includes('Steps'));
  }
  const iron = m.nodes.filter((n) => n.resource === 'Desc_OreIron_C').slice(0, 2).map((n) => n.short);
  const c = A.upgradePlanAction({ targets: [{ item: 'Iron Plate' }], nodes: iron, rebuild: true }, { beltTier: 6, minerTier: 3 });
  assert.ok(c.data.outputs?.length, c.markdown);
  assert.ok(c.data.outputs[0].after >= c.data.outputs[0].now, 'better tiers make at least as much');
});
test('map data has every node with a position', () => {
  const d = A.mapAction().data;
  assert.ok(d.nodes.length > 300);
  assert.ok(d.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
  assert.ok(d.hub || d.player, 'a reference point');
});
test('needs + upgrades render', () => {
  assert.ok(A.needsAction().markdown.includes('|'));
  assert.ok(A.upgradesAction().markdown.length > 20);
});
test('design writes an HTML sketch', () => {
  const r = A.designAction({ targets: [{ item: 'Iron Plate', rate: 20 }] }, { mode: 'foundation' });
  assert.ok(r.data.files?.html && fs.existsSync(r.data.files.html), 'html path');
  fs.rmSync(r.data.files.dir, { recursive: true, force: true });
});
test('blueprint modules: machine count, output rate and belt count', () => {
  const two = A.blueprintAction({ source: 'module', module: { recipe: 'Iron Ingot', machines: 2, beltTier: 1 } }).data;
  assert.equal(two.blueprints.length, 1);
  assert.ok(two.blueprints[0].ok, two.blueprints[0].problems.join('; '));
  assert.equal(two.blueprints[0].stats.machines, 2);
  assert.ok(two.blueprints[0].preview.startsWith('<svg'), 'preview drawn');
  const three = A.blueprintAction({ source: 'module', module: { recipe: 'Iron Ingot', machines: 3, beltTier: 1 } }).data;
  assert.match(three.summary, /90\/min Iron Ore \(2 belts\)/, 'Mk.1 carries 60/min, so 90/min needs two feed belts');
  assert.ok(three.blueprints[0].ok);
  const rate = A.blueprintAction({ source: 'module', module: { recipe: 'Iron Plate', rate: 60 }, name: 'Plates test' }).data;
  assert.equal(rate.blueprints[0].stats.machines, 3, '60 plates/min = 3 constructors at 100%');
  assert.equal(rate.blueprints[0].name, 'Plates test');
  for (const d of [two, three, rate]) fs.rmSync(path.join(OUTPUT_DIR, d.blueprints[0].file.split('/')[0]), { recursive: true, force: true });
});
test('blueprint from the plan settings', () => {
  const d = A.blueprintAction({ source: 'plan', request: { targets: [{ item: 'Iron Plate', rate: 20 }] }, area: { mode: 'foundation' } }).data;
  assert.ok(d.blueprints.length >= 1 && d.blueprints.every((b) => b.ok));
  fs.rmSync(path.join(OUTPUT_DIR, d.blueprints[0].file.split('/')[0]), { recursive: true, force: true });
});
test('blueprint install stays in the blueprints folder and never overwrites', () => {
  const saved = process.env.LOCALAPPDATA;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-bp-'));
  const d = A.blueprintAction({ source: 'module', module: { recipe: 'Iron Ingot', machines: 2 }, name: 'Install test' }).data;
  try {
    process.env.LOCALAPPDATA = tmp; // pretend game folder
    const first = A.blueprintInstallAction({ files: [d.blueprints[0].file], session: 'Test Session' }).data;
    assert.equal(first.installed.length, 2, '.sbp + .sbpcfg');
    assert.ok(first.installed.every((f) => f.startsWith(path.join(tmp, 'FactoryGame', 'Saved', 'SaveGames', 'blueprints', 'Test Session'))));
    const again = A.blueprintInstallAction({ files: [d.blueprints[0].file], session: 'Test Session' }).data;
    assert.equal(again.installed.length, 0, 'existing blueprint is not overwritten');
    assert.match(again.notes.join(' '), /already exists/);
    assert.throws(() => A.blueprintInstallAction({ files: [d.blueprints[0].file], session: '../evil' }), /not a valid session/);
    assert.throws(() => A.blueprintInstallAction({ files: ['../package.json'], session: 'Test Session' }), /Not a blueprint/);
    assert.throws(() => A.blueprintInstallAction({ files: [d.blueprints[0].file + 'cfg'], session: 'Test Session' }), /Not a blueprint/);
  } finally {
    process.env.LOCALAPPDATA = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.join(OUTPUT_DIR, d.blueprints[0].file.split('/')[0]), { recursive: true, force: true });
  }
});

console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
