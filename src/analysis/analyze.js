// Current-situation summary + rule-based improvement suggestions for a loaded save.
import { itemName, recipeRates } from '../gamedata/loader.js';
import { describeOffset, PURITY_MULT } from '../save/model.js';
import { simulateFlow, stackSize, storageFill } from './flow.js';

const MANUAL_ITEMS = ['Desc_Leaves_C', 'Desc_Wood_C', 'Desc_Mycelia_C', 'Desc_HogParts_C', 'Desc_SpitterParts_C', 'Desc_HatcherParts_C', 'Desc_StingerParts_C'];
const r1 = (x) => Math.round(x * 10) / 10;
const pct = (x) => `${Math.round(x * 100)}%`;

export { stackSize };

/** Upcoming milestones/research worth working towards. */
export function nextUnlocks(model, gd) {
  const owned = new Set(model.unlocks.purchasedSchematics);
  const milestones = Object.values(gd.schematics)
    .filter((s) => s.type === 'Milestone' && !owned.has(s.id) && s.tier <= model.unlocks.accessibleTier && s.tier > 0)
    .filter((s) => s.dependencies.every((d) => owned.has(d)))
    .sort((a, b) => a.tier - b.tier || a.menuPriority - b.menuPriority);
  return milestones.map((s) => ({
    id: s.id,
    name: s.name,
    tier: s.tier,
    active: s.id === model.unlocks.activeMilestone,
    cost: s.cost.map((c) => ({ item: itemName(gd, c.item), amount: c.amount, have: Math.floor(model.inventoryTotals[c.item] || 0) })),
    unlocks: s.unlockRecipes.map((r) => gd.recipes[r]?.name).filter(Boolean),
  }));
}

function productionLines(model) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { parent.set(find(a), find(b)); };
  for (const e of model.entities.values()) if (['manufacturer', 'extractor', 'splitter', 'merger', 'storage', 'generator'].includes(e.category)) parent.set(e.id, e.id);
  for (const l of model.links) if (l.to && parent.has(l.from) && parent.has(l.to)) union(l.from, l.to);
  const groups = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    (groups.get(root) || groups.set(root, []).get(root)).push(model.entities.get(id));
  }
  return [...groups.values()].filter((g) => g.some((e) => e.category === 'manufacturer' || e.category === 'extractor'));
}

export function analyze(model, gd) {
  simulateFlow(model, gd);
  const ents = [...model.entities.values()];
  const hub = model.hubPos;
  const where = (e) => describeOffset(hub, e.pos);
  const machines = ents.filter((e) => e.category === 'manufacturer');
  const extractors = ents.filter((e) => e.category === 'extractor');
  const generators = ents.filter((e) => e.category === 'generator');
  const linksFrom = (id) => model.links.filter((l) => l.from === id);
  const linksTo = (id) => model.links.filter((l) => l.to === id);
  const recipeName = (id) => gd.recipes[id]?.name || id;
  const belt = model.unlocks.belt;
  const beltCap = belt?.itemsPerMin ?? 60;
  const next = nextUnlocks(model, gd);
  const nextBelt = next.find((n) => n.unlocks.some((u) => /Conveyor Belt Mk/.test(u)));

  // ---------- production summary ----------
  const byRecipe = new Map();
  for (const m of machines) {
    const key = m.recipe || '(no recipe)';
    const g = byRecipe.get(key) || { recipe: key, name: m.recipe ? recipeName(m.recipe) : 'No recipe set', building: m.name, count: 0, clockSum: 0, prodSum: 0, prodN: 0, outputs: {}, inputs: {} };
    g.count++;
    g.clockSum += m.clock ?? 1;
    if (m.productivity != null) { g.prodSum += m.productivity; g.prodN++; }
    for (const o of m.rates?.outputs || []) g.outputs[o.item] = (g.outputs[o.item] || 0) + o.rate;
    for (const i of m.rates?.inputs || []) g.inputs[i.item] = (g.inputs[i.item] || 0) + i.rate;
    byRecipe.set(key, g);
  }
  const production = [...byRecipe.values()].map((g) => ({
    recipe: g.name,
    building: g.building,
    machines: g.count,
    avgClock: pct(g.clockSum / g.count),
    measuredProductivity: g.prodN ? pct(g.prodSum / g.prodN) : 'n/a',
    maxOutputPerMin: Object.fromEntries(Object.entries(g.outputs).map(([k, v]) => [itemName(gd, k), r1(v)])),
    actualOutputPerMin: Object.fromEntries(Object.entries(g.outputs).map(([k, v]) => [itemName(gd, k), r1(v * (g.prodN ? g.prodSum / g.prodN : 1))])),
  }));

  // item balance based on measured productivity
  const balance = {};
  for (const m of machines) {
    const p = m.productivity ?? 1;
    for (const o of m.rates?.outputs || []) (balance[o.item] ||= { produced: 0, consumed: 0 }).produced += o.rate * p;
    for (const i of m.rates?.inputs || []) (balance[i.item] ||= { produced: 0, consumed: 0 }).consumed += i.rate * p;
  }
  for (const x of extractors) if (x.resource) (balance[x.resource] ||= { produced: 0, consumed: 0 }).produced += (x.potentialRate || 0) * (x.productivity ?? 1);
  const itemBalance = Object.entries(balance).map(([k, v]) => ({ item: itemName(gd, k), producedPerMin: r1(v.produced), consumedPerMin: r1(v.consumed), netPerMin: r1(v.produced - v.consumed) }))
    .sort((a, b) => b.producedPerMin - a.producedPerMin);

  // ---------- issues ----------
  const issues = [];
  const add = (severity, kind, title, detail, fix, e) => issues.push({ severity, kind, title, detail, fix, where: e ? where(e) : undefined, position: e ? { x: Math.round(e.pos.x), y: Math.round(e.pos.y), z: Math.round(e.pos.z) } : undefined });

  for (const x of extractors) {
    const outs = linksFrom(x.id);
    const res = itemName(gd, x.resource);
    const cap = outs.reduce((s, l) => s + (l.capacity ?? Infinity), 0);
    const actual = (x.potentialRate || 0) * (x.productivity ?? 1);
    if (!outs.length) {
      add('high', 'extractor-unconnected', `${x.name} on ${x.purity} ${res} node has no output belt`, 'It fills its internal buffer and stops.', 'Connect a belt from the miner output to a smelter or storage.', x);
      continue;
    }
    if (x.potentialRate > cap + 0.01) {
      const fix = nextBelt
        ? `Unlock "${nextBelt.name}" (Tier ${nextBelt.tier}${nextBelt.active ? ', your active milestone' : ''}) for ${nextBelt.unlocks.find((u) => /Belt/.test(u))} and rebuild this belt. Until then 60/min is the ceiling, so make sure downstream can use all of it.`
        : `Upgrade the belt (and any lift) on this miner to a faster tier.`;
      add('medium', 'belt-cap-extractor', `${x.name} on ${x.purity} ${res} node is capped by its belt: ${r1(x.potentialRate)}/min possible, belt carries ${r1(cap)}/min`, `You lose ${r1(x.potentialRate - cap)}/min of ${res} from this node.`, fix, x);
      issues[issues.length - 1].lost = x.potentialRate - cap;
      issues[issues.length - 1].short = `${res} (${x.purity}, ${where(x)}): ${r1(x.potentialRate)} → ${r1(cap)}/min`;
    }
    const usable = Math.min(x.potentialRate, cap);
    if (actual < usable * 0.8) {
      const downstream = outs.map((l) => model.entities.get(l.to)).filter(Boolean);
      const consumers = downstream.filter((d) => d.category === 'manufacturer');
      const perMachine = consumers[0]?.rates?.inputs.find((i) => i.item === x.resource)?.rate;
      const spare = usable - actual;
      let fix = `Feed more consumers from this belt: about ${r1(spare)}/min of ${res} is left unused.`;
      const extra = perMachine ? Math.floor(spare / perMachine + 0.2) : 0;
      const blocked = consumers.find((c) => Object.entries(c.outputInv || {}).some(([k, v]) => v >= stackSize(gd, k) * 0.9));
      if (blocked) fix = `Adding more ${blocked.name}s will not help yet: the ${blocked.name} (${recipeName(blocked.recipe)}) is already backed up with a full output. Add consumers further down the chain for ${itemName(gd, blocked.rates?.outputs[0]?.item)} first, then add ${blocked.name}s to use the spare ${r1(spare)}/min.`;
      else if (perMachine && extra < 1) fix = `The unused ${r1(spare)}/min is less than one more ${consumers[0].name} needs (${r1(perMachine)}/min). Add one underclocked to ~${Math.round((spare / perMachine) * 100)}%, or leave it.`;
      else if (perMachine) fix = `Add ~${extra} more ${consumers[0].name}(s) running "${recipeName(consumers[0].recipe)}" (each uses ${r1(perMachine)}/min) via a splitter manifold — that turns the unused ${r1(spare)}/min into product.`;
      add('medium', 'extractor-underused', `${x.name} (${x.purity} ${res}) runs at ${pct(x.productivity ?? 0)} — only ~${r1(actual)}/min of ${r1(usable)}/min usable`, `Downstream: ${downstream.map((d) => d.name + (d.recipe ? ` (${recipeName(d.recipe)})` : '')).join(', ') || 'nothing'}. The miner is backing up because consumers take less than it can supply.`, fix, x);
    }
  }

  // machines fed (directly or further upstream) by hand-gathered items
  const manualFed = new Set();
  const stackIds = machines.filter((m) => gd.recipes[m.recipe]?.ingredients.some((i) => MANUAL_ITEMS.includes(i.item))).map((m) => m.id);
  while (stackIds.length) {
    const id = stackIds.pop();
    if (manualFed.has(id)) continue;
    manualFed.add(id);
    for (const l of linksFrom(id)) if (l.to) stackIds.push(l.to);
  }

  for (const m of machines) {
    const label = `${m.name}${m.recipe ? ` [${recipeName(m.recipe)}]` : ''}`;
    if (!m.recipe) { add('low', 'no-recipe', `${m.name} has no recipe set`, 'It is idle.', 'Set a recipe or deconstruct it to recover materials.', m); continue; }
    const r = gd.recipes[m.recipe];
    const solidIn = r.ingredients.filter((i) => gd.items[i.item]?.form === 'RF_SOLID').length;
    const connectedIn = m.ports.filter((p) => p.kind === 'belt' && p.dir === 'in' && p.connectedEntity).length;
    const connectedOut = m.ports.filter((p) => p.kind === 'belt' && p.dir === 'out' && p.connectedEntity).length;
    const solidOut = r.products.filter((i) => gd.items[i.item]?.form === 'RF_SOLID').length;
    const prod = m.productivity;
    if (connectedIn < solidIn) {
      const fed = Object.keys(m.inputInv || {}).length > 0;
      add(fed ? 'low' : 'high', 'input-missing', `${label}: ${solidIn - connectedIn} input belt(s) not connected`, fed ? 'It is being hand-fed (items in its input slot).' : 'It cannot run.', 'Connect a belt to each input port, or keep hand-feeding if intended.', m);
    }
    if (connectedOut < solidOut) {
      const out = Object.entries(m.outputInv || {}).map(([k, v]) => `${Math.floor(v)}/${stackSize(gd, k)} ${itemName(gd, k)}`).join(', ');
      add('high', 'output-unconnected', `${label}: output not connected`, `Output buffer: ${out || 'empty'}. The machine stops as soon as the buffer is full.`, 'Belt the output into the next machine or a storage container.', m);
      continue;
    }
    if (prod != null && prod < 0.85) {
      const need = m.rates.inputs.filter((i) => gd.items[i.item]?.form === 'RF_SOLID');
      const ins = linksTo(m.id);
      const got = {};
      for (const l of ins) for (const [k, v] of Object.entries(l.items || {})) got[k] = (got[k] || 0) + v;
      const outFull = Object.entries(m.outputInv || {}).some(([k, v]) => v >= stackSize(gd, k) * 0.9);
      if (outFull) {
        const outItem = r.products[0].item;
        add('medium', 'output-blocked', `${label} runs at ${pct(prod)}: its output is backing up`, `Output buffer is full of ${itemName(gd, outItem)} — downstream takes less than the ${r1(m.rates.outputs[0].rate)}/min it makes.`, 'Add consumers for this item, or underclock this machine and use the power elsewhere.', m);
      } else {
        const short = need.map((n) => ({ ...n, got: got[n.item] || 0 })).filter((n) => n.got < n.rate * 0.95);
        const reasons = short.map((n) => `${itemName(gd, n.item)}: needs ${r1(n.rate)}/min, gets ~${r1(n.got)}/min`);
        const limited = ins.filter((l) => l.beltLimited);
        if (manualFed.has(m.id)) {
          add('low', 'starved-manual', `${label} runs at ${pct(prod)}: its supply chain is hand-fed`, reasons.join('; ') || 'Input depends on leaves/wood you gather by hand.', 'Expected for biomass. Refill the input storage, or replace biomass with coal power once you reach Tier 3.', m);
          continue;
        }
        add('medium', 'starved', `${label} runs at ${pct(prod)}: starved for input`, reasons.length ? reasons.join('; ') + (limited.length ? ' (incoming belt is at capacity)' : '') : 'Input arrives irregularly (shared manifold, hand-fed, or upstream also slow).', limited.length ? 'Upgrade the incoming belt or add a second input line.' : 'Increase upstream supply (more miners/smelters) or reduce the number of machines sharing this supply.', m);
      }
    }
    // manual inputs
    for (const i of r.ingredients) {
      if (MANUAL_ITEMS.includes(i.item)) {
        add('low', 'manual-input', `${label} depends on hand-gathered ${itemName(gd, i.item)}`, 'This cannot be automated — it stops when you stop feeding it.', 'Plan coal power (Tier 3) to replace biomass, or accept periodic refills.', m);
        break;
      }
    }
  }

  for (const l of model.links) {
    if (!l.beltLimited) continue;
    const a = model.entities.get(l.from);
    if (a?.category === 'extractor') continue; // reported above
    const b = model.entities.get(l.to);
    add('medium', 'belt-bottleneck', `Belt from ${a?.name} to ${b?.name} is at capacity (${r1(l.capacity)}/min, Mk${l.minTier})`, `Both sides want more than ${r1(l.capacity)}/min.`, nextBelt ? `Unlock ${nextBelt.name} or run a second parallel belt.` : 'Upgrade to a faster belt or run a second parallel belt.', a);
  }

  for (const s of ents.filter((e) => e.category === 'storage' && e.cls !== 'Build_StorageIntegrated_C')) {
    const entries = Object.entries(s.storageInv || {});
    if (!entries.length) continue;
    const slots = /Mk2/.test(s.cls) ? 48 : 24;
    const [item, n] = entries.sort((a, b) => b[1] - a[1])[0];
    const cap = slots * stackSize(gd, item);
    const used = storageFill(gd, s);
    if (used > 0.9) add('high', 'storage-full', `Storage container full (${pct(used)}) of ${itemName(gd, item)}`, `${Math.floor(n)}/${cap}. Everything feeding it will stop.`, 'Empty it, add a second container, or route overflow into an AWESOME Sink.', s);
    else if (used > 0.7) add('low', 'storage-filling', `Storage container ${pct(used)} full of ${itemName(gd, item)}`, `${Math.floor(n)}/${cap}.`, 'Plan where this item goes next (a milestone, a new line, or the AWESOME Sink).', s);
  }

  const cap = model.power.capacityMW;
  const use = model.power.consumptionMW;
  if (cap > 0 && use / cap > 0.85) add('high', 'power', `Power grid at ${pct(use / cap)} (${r1(use)} / ${r1(cap)} MW)`, 'A small expansion will trip the fuse.', 'Add generators before building more machines.');
  for (const g of generators) {
    const fuel = Object.entries(g.fuelInv || {});
    const fedByBelt = g.ports.some((p) => p.dir === 'in' && p.connectedEntity);
    if (!fuel.length && !fedByBelt) add('medium', 'no-fuel', `${g.name} has no fuel`, `${r1(g.baseMW)} MW of capacity is offline.`, 'Refill it, or belt Solid Biofuel into it.', g);
    else if (!fedByBelt && fuel.length) {
      const [item, n] = fuel[0];
      const mj = gd.items[item]?.energyMJ || 0;
      const minutes = mj ? (n * mj) / (g.baseMW || 30) / 60 : null;
      if (minutes != null && minutes < 30) add('medium', 'low-fuel', `${g.name}: fuel runs out in ~${Math.round(minutes)} min`, `${Math.floor(n)} ${itemName(gd, item)} left, hand-fed.`, 'Refill, or connect a belt of Solid Biofuel.', g);
    }
  }

  // belts below the best unlocked tier
  if (belt) {
    const old = ents.filter((e) => e.category === 'belt' && e.tier < belt.tier);
    if (old.length) add('low', 'belt-upgrade', `${old.length} belts are below ${belt.name}`, `Total length ≈ ${Math.round(old.reduce((s, e) => s + (e.length || 0), 0))} m.`, `Upgrade bottlenecked ones first (build ${belt.name} over the old belt to replace it in place).`);
  }

  // one combined finding instead of one per miner
  const capped = issues.filter((i) => i.kind === 'belt-cap-extractor');
  if (capped.length > 1) {
    for (const c of capped) issues.splice(issues.indexOf(c), 1);
    const lost = capped.reduce((s, c) => s + c.lost, 0);
    issues.push({ severity: 'medium', kind: 'belt-cap-extractor', title: `${capped.length} miners are capped by their belts — ${r1(lost)}/min of ore lost in total`, detail: capped.map((c) => c.short).join('; '), fix: capped[0].fix, where: 'several sites' });
  }

  const sev = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => sev[a.severity] - sev[b.severity]);

  // ---------- nodes ----------
  const freeNodes = model.nodes.filter((n) => n.type === 'node' && !n.occupiedBy && n.resource);
  const nearest = (resource, k = 3) => freeNodes.filter((n) => n.resource === resource)
    .map((n) => ({ ...n, dist: hub ? Math.hypot(n.pos.x - hub.x, n.pos.y - hub.y) : 0 }))
    .sort((a, b) => (b.purity === 'pure') - (a.purity === 'pure') || a.dist - b.dist).slice(0, k);
  const resources = [...new Set(freeNodes.map((n) => n.resource))];
  const nearbyFree = resources.map((res) => ({
    resource: itemName(gd, res),
    nodes: nearest(res, 3).filter((n) => n.dist < 1500).map((n) => ({ id: n.short, purity: n.purity, where: describeOffset(hub, n.pos), distM: Math.round(n.dist) })),
  })).filter((r) => r.nodes.length);

  const lines = productionLines(model).map((g) => {
    const recipes = [...new Set(g.filter((e) => e.recipe).map((e) => recipeName(e.recipe)))];
    const res = [...new Set(g.filter((e) => e.category === 'extractor').map((e) => `${itemName(gd, e.resource)} (${e.purity})`))];
    const center = g.reduce((a, e) => ({ x: a.x + e.pos.x / g.length, y: a.y + e.pos.y / g.length, z: a.z + e.pos.z / g.length }), { x: 0, y: 0, z: 0 });
    return { where: describeOffset(hub, center), resources: res, recipes, machines: g.filter((e) => e.category === 'manufacturer').length, buildings: g.length };
  });

  return {
    save: model.header,
    progress: {
      milestoneTier: model.unlocks.maxMilestoneTier,
      gamePhase: model.unlocks.gamePhase,
      activeMilestone: gd.schematics[model.unlocks.activeMilestone]?.name || null,
      milestones: model.unlocks.purchasedSchematics.map((s) => gd.schematics[s]).filter((s) => s && s.type === 'Milestone').map((s) => `T${s.tier} ${s.name}`),
      mamResearch: model.unlocks.purchasedSchematics.map((s) => gd.schematics[s]).filter((s) => s && s.type === 'MAM').map((s) => s.name),
      alternateRecipes: model.unlocks.alternates.map((r) => gd.recipes[r].name),
      next,
    },
    logistics: {
      belt: belt ? `${belt.name} (${belt.itemsPerMin}/min)` : 'none',
      lift: model.unlocks.lift ? `${model.unlocks.lift.name} (${model.unlocks.lift.itemsPerMin}/min)` : 'none',
      pipe: model.unlocks.pipe ? `${model.unlocks.pipe.name} (${model.unlocks.pipe.flowPerMin} m³/min)` : 'not unlocked',
      miner: model.unlocks.miner?.name || 'none',
      splitter: model.unlocks.has('Build_ConveyorAttachmentSplitter_C'),
      merger: model.unlocks.has('Build_ConveyorAttachmentMerger_C'),
      smartSplitter: model.unlocks.has('Build_ConveyorAttachmentSplitterSmart_C'),
      powerShards: model.powerShards,
      overclockingPossible: model.powerShards > 0,
      beltCap,
    },
    buildings: Object.fromEntries(Object.entries(ents.reduce((acc, e) => { if (!['power', 'structure', 'other'].includes(e.category)) acc[e.name] = (acc[e.name] || 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1])),
    power: { consumptionMW: r1(use), capacityMW: r1(cap), headroomMW: r1(cap - use) },
    extraction: extractors.map((x) => ({ building: x.name, resource: itemName(gd, x.resource), purity: x.purity, clock: pct(x.clock), potentialPerMin: r1(x.potentialRate), beltCapPerMin: r1(Math.min(...linksFrom(x.id).map((l) => l.capacity ?? Infinity), Infinity)), actualPerMin: r1((x.potentialRate || 0) * (x.productivity ?? 1)), where: where(x) })),
    production,
    itemBalance,
    lines,
    issues,
    nearbyFreeNodes: nearbyFree,
  };
}

export { PURITY_MULT, recipeRates };
