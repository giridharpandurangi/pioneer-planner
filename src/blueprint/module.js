// Stand-alone machine modules for blueprints: "3 smelters on Iron Ingot", "constructors making 90 plates/min", ...
// Builds a one-step plan in the same shape the planner produces, so the normal layout + blueprint pipeline can draw it.
import { isFluid, itemName, machinePower, recipeRates, resolveItem } from '../gamedata/loader.js';
import { findRecipe } from '../planner/plan.js';

const r2 = (x) => Math.round(x * 100) / 100;

/** A recipe by its name, or the best recipe for an item ("Iron Plate" → the standard Iron Plate recipe you have). */
export function findModuleRecipe(gd, model, query) {
  let id = findRecipe(gd, query);
  if (!id) {
    const item = resolveItem(gd, query);
    const cands = (item && gd.producers[item] || []).map((r) => gd.recipes[r]);
    const have = (r) => !model || model.unlocks.hasRecipe(r.id);
    id = (cands.find((r) => have(r) && !r.alternate) || cands.find(have) || cands.find((r) => !r.alternate) || cands[0])?.id;
  }
  if (!id || gd.recipes[id].kind !== 'machine') throw new Error(`"${query}" is not a machine recipe or item.`);
  return gd.recipes[id];
}

/**
 * opts: { recipe, machines, clock (%), rate (main product per minute), beltTier }
 * - machines only → that many at `clock` (default 100%)
 * - rate only     → as few machines as possible at ≤ 100%, evenly underclocked
 * - both          → that many machines, clocked to hit the rate
 */
export function modulePlan(gd, model, opts = {}) {
  const r = findModuleRecipe(gd, model, opts.recipe);
  const rates = recipeRates(gd, r);
  const building = gd.buildings[rates.building];
  const main = rates.outputs[0];
  const warnings = [];
  let n = Math.max(0, Math.round(Number(opts.machines) || 0));
  let clock = opts.clock ? Number(opts.clock) / 100 : 1;
  const rate = Number(opts.rate) || 0;
  if (rate > 0) {
    if (!n) n = Math.max(1, Math.ceil(rate / main.rate - 1e-9));
    clock = rate / (n * main.rate);
  }
  n = Math.max(1, Math.min(n || 1, 40));
  clock = Math.min(2.5, Math.max(0.01, clock));
  if (clock > 1.0001) warnings.push(`Clock ${r2(clock * 100)}% needs power shards in every machine (max 100% without).`);

  const unlocked = model ? new Set(model.unlocks.buildings) : null;
  const tiers = gd.beltTiers;
  const belt = opts.beltTier ? tiers.find((b) => b.tier === Number(opts.beltTier)) : (unlocked && tiers.filter((b) => unlocked.has(b.id)).pop()) || tiers[0];
  const pipe = (unlocked && gd.pipeTiers.filter((b) => unlocked.has(b.id)).pop()) || gd.pipeTiers[0];
  if (model && !model.unlocks.hasRecipe(r.id)) warnings.push(`"${r.name}" is not unlocked in this save yet.`);
  if (unlocked && !unlocked.has(building.id)) warnings.push(`${building.name} is not unlocked in this save yet.`);
  if (unlocked && !unlocked.has(belt.id)) warnings.push(`${belt.name} is not unlocked in this save yet.`);
  for (const io of [...rates.inputs, ...rates.outputs]) {
    const cap = isFluid(gd, io.item) ? pipe?.flowPerMin ?? 300 : belt.itemsPerMin;
    if (io.rate * clock > cap + 0.01) warnings.push(`At ${r2(clock * 100)}% one machine needs ${r2(io.rate * clock)}/min ${itemName(gd, io.item)} on one port — more than a ${belt.name} carries (${cap}/min). Lower the clock or use a faster belt.`);
  }
  if (rates.inputs.some((i) => isFluid(gd, i.item)) || rates.outputs.some((o) => isFluid(gd, o.item))) warnings.push('This recipe uses fluids: pipes are not part of the blueprint, connect them by hand.');

  const per = (list) => list.map((x) => ({ item: x.item, name: itemName(gd, x.item), rate: r2(x.rate * clock) }));
  const tot = (list) => list.map((x) => ({ item: x.item, name: itemName(gd, x.item), rate: r2(x.rate * clock * n) }));
  const power = machinePower(gd, building.id, r, clock) * n;
  const step = {
    id: 'S1', recipe: r.id, recipeName: r.name, alternate: r.alternate, building: building.id, buildingName: building.name,
    machinesExact: r2(n * clock), machines: n, clockPercent: Math.ceil(clock * 1e6) / 1e4, clockAlt: null,
    perMachine: { inputs: per(rates.inputs), outputs: per(rates.outputs) }, inputs: tot(rates.inputs), outputs: tot(rates.outputs),
    powerMW: r2(power), depth: 0,
  };
  return {
    ok: true,
    targets: [],
    maximized: null,
    logistics: { belt: belt.name, beltCap: belt.itemsPerMin, pipe: pipe?.name ?? null, pipeCap: pipe?.flowPerMin ?? 300, miner: null, maxClockPercent: 250 },
    steps: [step],
    raw: [], nodes: [], inputsUsed: [], flows: [], surplus: [],
    totals: { machines: { [building.name]: n }, powerMW: r2(power), buildCost: [] },
    warnings,
    module: { recipe: r.name, building: building.name, machines: n, clockPercent: step.clockPercent, inputs: step.inputs, outputs: step.outputs, belt: belt.name, powerMW: r2(power) },
  };
}
