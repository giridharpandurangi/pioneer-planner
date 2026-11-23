// Upgrade planning: what an existing line (or a plan) becomes with better belts / miners —
// new output, machines to add, exactly which belts and miners to swap, the cost after refunds, and what's short.
import { itemName, machinePower } from '../gamedata/loader.js';
import { describeOffset, PURITY_MULT } from '../save/model.js';
import { planProduction } from '../planner/plan.js';
import { planForGoals } from '../planner/goals.js';
import { productionGroups, beltUnits } from '../rebuild/rebuild.js';
import { simulateFlow } from '../analysis/flow.js';

const r1 = (x) => Math.round(x * 10) / 10;

function unlockOf(gd, buildingId) {
  const s = Object.values(gd.schematics).find((x) => x.unlockRecipes.includes(gd.buildings[buildingId]?.buildRecipe) && ['Milestone', 'MAM'].includes(x.type));
  return s ? `${s.name}${s.tier ? ` (Tier ${s.tier})` : ''}` : 'a later milestone';
}

/** Belt / miner tiers with unlock status, for pickers. */
export function tierChoices(gd, model) {
  const has = (id) => model.unlocks.buildings.includes(id);
  const miners = Object.values(gd.buildings).filter((b) => b.category === 'extractor' && /^Build_MinerMk\d_C$/.test(b.id)).sort((a, b) => a.tier - b.tier);
  return {
    belts: gd.beltTiers.map((b) => ({ tier: b.tier, name: b.name, perMin: b.itemsPerMin, unlocked: has(b.id), unlock: has(b.id) ? null : unlockOf(gd, b.id) })),
    miners: miners.map((b) => ({ tier: b.tier, name: b.name, perMinNormal: (60 / b.cycleTime) * b.itemsPerCycle, unlocked: has(b.id), unlock: has(b.id) ? null : unlockOf(gd, b.id) })),
    current: { belt: model.unlocks.belt?.tier || 1, miner: model.unlocks.miner?.tier || 1 },
  };
}

/** Short description of each existing production line, for pickers. */
export function listLines(gd, model) {
  return productionGroups(model).map((g) => ({
    line: g.index,
    where: describeOffset(model.hubPos, { ...g.center, z: 0 }),
    recipes: g.recipes.map((r) => gd.recipes[r]?.name || r),
    miners: g.members.filter((e) => e.category === 'extractor').map((e) => `${e.name} on ${e.purity} ${itemName(gd, e.resource)}`),
    machines: g.members.filter((e) => e.category === 'manufacturer').length,
    powersGrid: g.powersGrid,
  }));
}

function addCost(gd, acc, buildingId, n = 1, sign = 1) {
  const r = gd.recipes[gd.buildings[buildingId]?.buildRecipe];
  for (const i of r?.ingredients || []) acc[i.item] = (acc[i.item] || 0) + sign * i.amount * n;
}
const beltCost = (gd, acc, beltId, metres, sign = 1) => {
  const r = gd.recipes[gd.buildings[beltId]?.buildRecipe];
  for (const i of r?.ingredients || []) acc[i.item] = (acc[i.item] || 0) + sign * i.amount * beltUnits(metres);
};

/**
 * Upgrade one existing line. beltTier / minerTier default to the next belt tier and your best miner.
 * The line keeps making the same products in the same ratio, as much as the upgraded supply allows.
 */
export function upgradeLine(gd, model, { line, beltTier, minerTier } = {}) {
  simulateFlow(model, gd);
  const groups = productionGroups(model);
  const g = groups.find((x) => x.index === Number(line));
  if (!g) throw new Error(`No line ${line}. Lines: ${groups.map((x) => `${x.index} (${x.recipes.map((r) => gd.recipes[r]?.name).join(', ')})`).join('; ')}`);
  const tiers = tierChoices(gd, model);
  const bTier = Number(beltTier) || Math.min(tiers.current.belt + 1, 6);
  const mTier = Number(minerTier) || tiers.current.miner;
  const belt = gd.beltTiers.find((b) => b.tier === bTier);
  const miner = gd.buildings[`Build_MinerMk${mTier}_C`];
  const notes = [];
  if (!model.unlocks.buildings.includes(belt.id)) notes.push(`${belt.name} is not unlocked yet — unlock ${unlockOf(gd, belt.id)} first. This is a plan for later.`);
  if (miner && !model.unlocks.buildings.includes(miner.id)) notes.push(`${miner.name} is not unlocked yet — unlock ${unlockOf(gd, miner.id)} first.`);

  const machines = g.members.filter((e) => e.category === 'manufacturer' && e.recipe);
  const extractors = g.members.filter((e) => e.category === 'extractor');
  if (!extractors.length) throw new Error(`Line ${g.index} has no miner — it is fed by hand or from storage, so better belts/miners do not change it.`);

  // what the line makes now (measured), and what leaves it
  const made = {};
  const used = {};
  for (const mch of machines) {
    const p = mch.productivity ?? 1;
    for (const o of mch.rates?.outputs || []) made[o.item] = (made[o.item] || 0) + o.rate * p;
    for (const i of mch.rates?.inputs || []) used[i.item] = (used[i.item] || 0) + i.rate * p;
  }
  for (const x of extractors) made[x.resource] = (made[x.resource] || 0) + (x.potentialRate || 0) * (x.productivity ?? 1);
  const products = Object.keys(made).filter((k) => made[k] - (used[k] || 0) > 0.05 && !gd.items[k]?.isRawResource)
    .map((k) => ({ item: k, name: itemName(gd, k), now: made[k] - (used[k] || 0) }));
  if (!products.length) throw new Error(`Line ${g.index} has no output leaving it, so there is nothing to scale up.`);

  // re-plan the line on the same nodes with the new tiers, same product mix
  const request = { nodes: extractors.map((x) => x.node?.split('.').pop()).filter(Boolean), rebuild: true, beltTier: bTier, minerTier: mTier };
  const goal = planForGoals(gd, model, request, { goals: [], needs: products.map((p) => ({ item: p.item, name: p.name, missing: p.now })) });
  if (!goal.ok) throw new Error(goal.message || 'Could not plan the upgraded line.');
  const plan = goal.plan;

  // machines: now vs upgraded
  const nowBy = {};
  for (const mch of machines) nowBy[mch.recipe] = (nowBy[mch.recipe] || 0) + 1;
  const recipes = new Set([...Object.keys(nowBy), ...plan.steps.map((s) => s.recipe)]);
  const machineDiff = [...recipes].map((r) => {
    const step = plan.steps.find((s) => s.recipe === r);
    return { recipe: gd.recipes[r]?.name || r, building: step?.buildingName || machines.find((m) => m.recipe === r)?.name, now: nowBy[r] || 0, after: step?.machines || 0, clock: step?.clockPercent ?? null, building_id: step?.building || machines.find((m) => m.recipe === r)?.cls };
  });

  // which existing belts must be swapped: links whose new flow exceeds their capacity
  const newMade = {};
  for (const s of plan.steps) for (const o of s.outputs) newMade[o.item] = (newMade[o.item] || 0) + o.rate;
  for (const n of plan.nodes) newMade[n.resource] = (newMade[n.resource] || 0) + n.rate;
  const ids = new Set(g.members.map((e) => e.id));
  const beltSwaps = [];
  for (const l of model.links.filter((x) => ids.has(x.from) && x.conveyors.length)) {
    const from = model.entities.get(l.from);
    let newFlow;
    if (from?.category === 'extractor') newFlow = plan.nodes.find((n) => `Persistent_Level:PersistentLevel.${n.node}` === from.node || n.node === from.node?.split('.').pop())?.rate ?? l.flow;
    else newFlow = Object.entries(l.items || {}).reduce((s, [item, v]) => s + v * ((newMade[item] || 0) / Math.max(made[item] || 0, 0.01)), 0);
    if (newFlow > (l.capacity ?? Infinity) + 0.05) {
      const conveyors = l.conveyors.map((id) => model.entities.get(id)).filter(Boolean);
      const metres = conveyors.filter((c) => c.category === 'belt').reduce((s, c) => s + (c.length || 0), 0);
      beltSwaps.push({
        from: `${from?.name}${from?.recipe ? ` [${gd.recipes[from.recipe]?.name}]` : ''}`,
        to: `${model.entities.get(l.to)?.name || 'end'}${model.entities.get(l.to)?.recipe ? ` [${gd.recipes[model.entities.get(l.to).recipe]?.name}]` : ''}`,
        where: describeOffset(model.hubPos, from.pos),
        nowCap: l.capacity, newFlow: r1(newFlow), metres: Math.round(metres), belts: conveyors.filter((c) => c.category === 'belt').length,
        lifts: conveyors.filter((c) => c.category === 'lift').length,
        oldTiers: [...new Set(conveyors.map((c) => c.cls))],
        needsSecondBelt: newFlow > belt.itemsPerMin + 0.05,
      });
    }
  }

  // miner swaps
  const minerSwaps = extractors.filter((x) => miner && (gd.buildings[x.cls]?.tier || 1) < mTier).map((x) => ({ from: x.name, to: miner.name, resource: itemName(gd, x.resource), purity: x.purity, where: describeOffset(model.hubPos, x.pos), before: r1(Math.min(x.potentialRate, belt.itemsPerMin)), after: r1(Math.min((60 / miner.cycleTime) * miner.itemsPerCycle * PURITY_MULT[x.purity], belt.itemsPerMin)) }));

  // cost: new machines + attachments + belt for them, belt swaps, miner swaps — minus refunds
  const cost = {};
  const refund = {};
  let added = 0;
  for (const d of machineDiff) {
    const extra = d.after - d.now;
    if (extra > 0 && d.building_id) {
      added += extra;
      addCost(gd, cost, d.building_id, extra);
      addCost(gd, cost, 'Build_ConveyorAttachmentSplitter_C', extra);
      addCost(gd, cost, 'Build_ConveyorAttachmentMerger_C', extra);
    }
  }
  // the short feed belts of new machines carry < 60/min, so the cheapest belt does
  if (added) beltCost(gd, cost, gd.beltTiers[0].id, added * 12);
  for (const s of beltSwaps) {
    beltCost(gd, cost, belt.id, s.metres);
    for (const t of s.oldTiers) if (/Belt/.test(t)) beltCost(gd, refund, t, s.metres);
  }
  for (const s of minerSwaps) {
    addCost(gd, cost, miner.id, 1);
    addCost(gd, refund, extractors.find((x) => x.name === s.from)?.cls, 1);
  }
  const items = new Set([...Object.keys(cost), ...Object.keys(refund)]);
  const balance = [...items].map((k) => {
    const need = Math.ceil(cost[k] || 0);
    const back = Math.floor(refund[k] || 0);
    const have = Math.floor(model.inventoryTotals[k] || 0);
    return { item: k, name: itemName(gd, k), need, refund: back, have, short: Math.max(0, need - back - have) };
  }).filter((b) => b.need > 0).sort((a, b) => b.short - a.short || b.need - a.need);

  const powerNow = machines.reduce((s, m) => s + (m.powerMW || 0), 0) + extractors.reduce((s, x) => s + (x.powerMW || 0), 0);
  const steps = [];
  if (notes.length) steps.push(...notes);
  if (balance.some((b) => b.short)) steps.push(`Collect first: ${balance.filter((b) => b.short).map((b) => `${b.short} ${b.name}`).join(', ')}.`);
  for (const s of minerSwaps) steps.push(`Replace the ${s.from} on the ${s.purity} ${s.resource} node (${s.where}) with a ${s.to} — build it over the old one; the old one is refunded.`);
  for (const s of beltSwaps) steps.push(`Upgrade the belt ${s.from} → ${s.to} (${s.metres} m${s.lifts ? ` + ${s.lifts} lift(s)` : ''}) to ${belt.name}: it will carry ${s.newFlow}/min${s.needsSecondBelt ? ` — more than one ${belt.name} carries, so run a second belt` : ''}. Build the new belt over the old one to swap it in place.`);
  for (const d of machineDiff.filter((x) => x.after > x.now)) steps.push(`Add ${d.after - d.now} × ${d.building} for "${d.recipe}" to the existing manifold (extend it with a splitter + merger each)${d.clock && d.clock < 99.99 ? `; set all ${d.after} to ${d.clock}%` : ''}.`);
  for (const d of machineDiff.filter((x) => x.after < x.now)) steps.push(`"${d.recipe}" needs only ${d.after} machine(s) after the upgrade — you can leave the extra ${d.now - d.after} idle or remove them.`);

  return {
    line: g.index,
    where: describeOffset(model.hubPos, { ...g.center, z: 0 }),
    tiers: { belt: belt.name, beltPerMin: belt.itemsPerMin, miner: miner?.name },
    products: products.map((p) => ({ name: p.name, now: r1(p.now), after: r1(goal.targets.find((t) => t.item === p.item)?.rate || 0) })),
    machines: machineDiff.map(({ building_id, ...rest }) => rest),
    beltSwaps,
    minerSwaps,
    cost: balance,
    power: { nowMW: r1(powerNow), afterMW: r1(plan.totals.powerMW) },
    steps,
    plan,
  };
}

/** Compare two plans (same goal, different tiers) and describe the upgrade path from the first to the second. */
export function comparePlans(gd, base, up, labels = {}) {
  const machines = {};
  for (const s of base.plan.steps) machines[s.recipe] = { recipe: s.recipeName, building: s.buildingName, now: s.machines, after: 0, nowClock: s.clockPercent };
  for (const s of up.plan.steps) machines[s.recipe] = { ...(machines[s.recipe] || { recipe: s.recipeName, building: s.buildingName, now: 0 }), after: s.machines, afterClock: s.clockPercent };
  const out = (p) => Object.fromEntries((p.goal?.targets || p.plan.targets).map((t) => [t.name, t.rate]));
  const o1 = out(base);
  const o2 = out(up);
  const outputs = [...new Set([...Object.keys(o1), ...Object.keys(o2)])].map((n) => ({ name: n, now: r1(o1[n] || 0), after: r1(o2[n] || 0) }));
  const beltsNeeded = (p) => p.plan.flows.reduce((s, f) => s + (f.fluid ? 0 : f.lines), 0);
  const swaps = up.plan.flows.filter((f) => !f.fluid && f.rate > base.plan.logistics.beltCap + 0.05).map((f) => {
    const before = base.plan.flows.find((b) => b.from === f.from && b.to === f.to && b.item === f.item);
    return { from: f.from, to: f.to, item: f.name, rate: f.rate, rateNow: before?.rate ?? 0, linesNow: before?.lines ?? 0, linesAfter: f.lines };
  });
  return {
    labels: { now: labels.now || base.plan.logistics.belt, after: labels.after || up.plan.logistics.belt },
    minutes: base.goal?.minutes && up.goal?.minutes ? { now: base.goal.minutes, after: up.goal.minutes } : null,
    outputs,
    machines: Object.values(machines),
    beltLines: { now: beltsNeeded(base), after: beltsNeeded(up) },
    raw: { now: base.plan.nodes.map((n) => n.note), after: up.plan.nodes.map((n) => n.note) },
    power: { now: base.plan.totals.powerMW, after: up.plan.totals.powerMW },
    swaps,
  };
}

export { machinePower, planProduction };
