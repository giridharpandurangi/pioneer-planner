// Unlock-aware production planner (linear programming).
// Only uses recipes/buildings you have unlocked, raw supply limited to real nodes (purity, miner tier,
// belt cap), and sizes every connection in belts of your best unlocked tier.
import { solve } from 'yalps';
import { isFluid, itemName, machinePower, recipeRates, resolveItem } from '../gamedata/loader.js';
import { describeOffset, PURITY_MULT } from '../save/model.js';

const EPS = 1e-6;
const r2 = (x) => Math.round(x * 100) / 100;
const MANUAL_OK = new Set(); // items only obtainable by hand: never planned unless supplied as inputs

function bestTier(list, unlocked, override) {
  if (override) return list.find((b) => b.tier === Number(override)) || list[list.length - 1];
  if (!unlocked) return list[list.length - 1];
  return list.filter((b) => unlocked.has(b.id)).sort((a, b) => b.tier - a.tier)[0] || null;
}

function sitePos(model, site) {
  if (!model) return null;
  if (site && typeof site === 'object' && 'x' in site) return site;
  if (site === 'player') return model.playerPos;
  if (typeof site === 'string' && site.startsWith('BP_')) {
    const n = model.nodes.find((x) => x.short === site || x.id === site);
    if (n) return n.pos;
  }
  return model.hubPos || model.playerPos;
}

/** Raw supply that the world offers: free nodes near the site + spare capacity on your existing extractors. */
export function rawSupply(gd, model, opts = {}) {
  const unlocked = model ? new Set(model.unlocks.buildings) : null;
  const belt = bestTier(gd.beltTiers, unlocked, opts.beltTier);
  const pipe = bestTier(gd.pipeTiers, unlocked, opts.pipeTier);
  const beltCap = belt?.itemsPerMin ?? 60;
  const pipeCap = pipe?.flowPerMin ?? 300;
  const maxClock = opts.allowOverclock ? 2.5 : 1;
  const extractors = Object.values(gd.buildings).filter((b) => b.category === 'extractor');
  const miners = extractors.filter((b) => /Miner/.test(b.id)).filter((b) => !unlocked || unlocked.has(b.id)).sort((a, b) => b.tier - a.tier);
  const miner = opts.minerTier ? extractors.find((b) => b.id === `Build_MinerMk${opts.minerTier}_C`) : miners[0];
  const has = (id) => !unlocked || opts.allowLocked || unlocked.has(id);
  const site = sitePos(model, opts.site);
  const maxDist = opts.maxNodeDistance ?? 1500;
  const sources = [];

  if (model) {
    const usedByPlan = new Set(opts.excludeNodes || []);
    const distOf = (n) => (site ? Math.hypot(n.pos.x - site.x, n.pos.y - site.y) : 0);
    // explicit node list, or the N nearest nodes (optionally of some resources only)
    let only = opts.nodes?.length ? new Set(opts.nodes.flatMap((x) => [String(x), `Persistent_Level:PersistentLevel.${x}`])) : null;
    if (!only && opts.nearestNodes) {
      const filter = opts.nodeResources?.length ? new Set(opts.nodeResources.map((r) => resolveItem(gd, r)).filter(Boolean)) : null;
      const usable = (n) => n.type === 'node' && n.resource && (!isFluid(gd, n.resource) ? !!miner : n.resource === 'Desc_LiquidOil_C' && has('Build_OilPump_C'));
      only = new Set(model.nodes.filter((n) => usable(n) && (!filter || filter.has(n.resource))).sort((a, b) => distOf(a) - distOf(b)).slice(0, Number(opts.nearestNodes)).map((n) => n.short));
    }
    for (const n of model.nodes) {
      if (!n.resource || usedByPlan.has(n.short)) continue;
      if (only && !only.has(n.short) && !only.has(n.id)) continue;
      const dist = distOf(n);
      if (!only && dist > maxDist && opts.resources !== 'all-nodes') continue;
      let building = null;
      let base = 0;
      if (n.type === 'node' && !isFluid(gd, n.resource) && miner) { building = miner; base = (60 / miner.cycleTime) * miner.itemsPerCycle; }
      else if (n.type === 'node' && n.resource === 'Desc_LiquidOil_C' && has('Build_OilPump_C')) { building = gd.buildings.Build_OilPump_C; base = (60 / building.cycleTime) * building.itemsPerCycle / 1000; }
      else if (n.type === 'well' && has('Build_FrackingExtractor_C') && has('Build_FrackingSmasher_C')) { building = gd.buildings.Build_FrackingExtractor_C; base = (60 / building.cycleTime) * building.itemsPerCycle / 1000; }
      if (!building) continue;
      const cap = isFluid(gd, n.resource) ? pipeCap : beltCap;
      const potential = base * PURITY_MULT[n.purity] * (building.canOverclock === false ? 1 : maxClock);
      if (n.occupiedBy) {
        const ex = model.entities.get(n.occupiedBy);
        if (!ex) continue;
        if (opts.rebuild) {
          // rebuilding: the old consumers go away, so the whole node is available; keep the miner that is already there
          // with an explicit miner tier (upgrade planning) the kept miner is swapped for the better one
          const exB = opts.minerTier && miner && miner.tier > (gd.buildings[ex.cls]?.tier || 0) ? miner : gd.buildings[ex.cls];
          const exBase = exB ? (60 / exB.cycleTime) * exB.itemsPerCycle * (isFluid(gd, n.resource) ? 0.001 : 1) : base;
          const pot = exBase * PURITY_MULT[n.purity] * (exB?.canOverclock === false ? 1 : maxClock);
          sources.push({ kind: 'existing-reuse', node: n.short, resource: n.resource, purity: n.purity, rate: Math.min(pot, cap), potential: pot, capLimited: pot > cap, building: exB?.name || ex.name, buildingId: exB?.id || ex.cls, existing: ex.id, upgradedFrom: exB && exB.id !== ex.cls ? ex.name : null, dist, where: describeOffset(model.hubPos, n.pos) });
          continue;
        }
        if (opts.useExistingSpare === false) continue;
        const outCap = Math.min(...model.links.filter((l) => l.from === ex.id).map((l) => l.capacity ?? Infinity), Infinity);
        const usable = Math.min(ex.potentialRate || 0, outCap === Infinity ? cap : outCap);
        const used = (ex.potentialRate || 0) * (ex.productivity ?? 1);
        const spare = usable - used;
        if (spare > 1) sources.push({ kind: 'existing-spare', node: n.short, resource: n.resource, purity: n.purity, rate: spare, building: ex.name, dist, where: describeOffset(model.hubPos, n.pos), note: `tap the existing ${ex.name}'s belt (it only uses ${r2(used)} of ${r2(usable)}/min)` });
        continue;
      }
      if (opts.resources === 'existing-only') continue;
      sources.push({ kind: 'node', node: n.short, resource: n.resource, purity: n.purity, rate: Math.min(potential, cap), potential, capLimited: potential > cap, building: building.name, buildingId: building.id, dist, where: describeOffset(model.hubPos, n.pos) });
    }
  }
  const water = has('Build_WaterPump_C');
  return { sources, beltCap, pipeCap, belt, pipe, miner, water, maxClock };
}

/** Scarcity weights: rarer resources cost more in the objective. */
function resourceWeights(gd, model) {
  const totals = {};
  if (model) for (const n of model.nodes) if (n.type === 'node' && n.resource) totals[n.resource] = (totals[n.resource] || 0) + PURITY_MULT[n.purity] * 60;
  const fallback = { Desc_OreIron_C: 70000, Desc_Stone_C: 52000, Desc_OreCopper_C: 36000, Desc_Coal_C: 30000, Desc_LiquidOil_C: 12000, Desc_OreGold_C: 15000, Desc_RawQuartz_C: 13000, Desc_Sulfur_C: 11000, Desc_OreBauxite_C: 12000, Desc_OreUranium_C: 2100, Desc_NitrogenGas_C: 12000, Desc_SAM_C: 10000 };
  const t = Object.keys(totals).length ? totals : fallback;
  const max = Math.max(...Object.values(t));
  const w = {};
  for (const [k, v] of Object.entries(t)) w[k] = max / v;
  w.Desc_Water_C = 0.05;
  return w;
}

export function planProduction(gd, model, request) {
  const opts = { resources: 'free-nodes', useAlternates: true, ...request };
  const warnings = [];
  const unlockedRecipes = model && !opts.allowLocked ? new Set(model.unlocks.machineRecipes) : null;
  const unlockedBuildings = model && !opts.allowLocked ? new Set(model.unlocks.buildings) : null;
  const exclude = new Set((opts.excludeRecipes || []).map((r) => findRecipe(gd, r)).filter(Boolean));
  const prefer = new Set((opts.preferRecipes || []).map((r) => findRecipe(gd, r)).filter(Boolean));

  const targets = (opts.targets || []).map((t) => ({ item: resolveItem(gd, t.item), rate: Number(t.rate) || 0, raw: t.item }));
  for (const t of targets) if (!t.item) throw new Error(`Unknown item "${t.raw}"`);
  const maximize = opts.maximize ? resolveItem(gd, opts.maximize.item || opts.maximize) : null;
  const goalVector = (opts.goalVector || []).filter((g) => g.amount > 0);
  if (!targets.length && !maximize && !goalVector.length) throw new Error('Give at least one target {item, rate} or a maximize item.');
  const inputs = (opts.inputs || []).map((t) => ({ item: resolveItem(gd, t.item), rate: Number(t.rate) || 0 })).filter((t) => t.item);

  const supply = rawSupply(gd, model, opts);
  const weights = resourceWeights(gd, model);

  // ---- candidate recipes ----
  const known = model ? new Set(model.unlocks.machineRecipes) : null;
  const knownBuildings = model ? new Set(model.unlocks.buildings) : null;
  const recipes = Object.values(gd.recipes).filter((r) => {
    if (r.kind !== 'machine' || !r.ingredients.length || !r.products.length) return false;
    if (exclude.has(r.id)) return false;
    if (r.alternate && !opts.useAlternates) return false;
    if (opts.allowLocked && !opts.lockedAlternates && known && r.alternate && !known.has(r.id)) return false; // plan ahead with standard recipes
    if (opts.allowLocked && knownBuildings && r.producedIn.some((p) => ['Build_Converter_C', 'Build_QuantumEncoder_C'].includes(p)) && !r.producedIn.some((p) => knownBuildings.has(p))) return false;
    if (unlockedRecipes && !unlockedRecipes.has(r.id)) return false;
    const b = r.producedIn.find((p) => gd.buildings[p]?.category === 'manufacturer');
    if (!b) return false;
    if (unlockedBuildings && !unlockedBuildings.has(b)) return false;
    return true;
  });

  // ---- LP ----
  const variables = {};
  const constraints = {};
  const items = new Set();
  const costScale = maximize || goalVector.length ? -1e-4 : 1;
  for (const r of recipes) {
    const rates = recipeRates(gd, r);
    const v = {};
    for (const x of rates.outputs) { v[x.item] = (v[x.item] || 0) + x.rate; items.add(x.item); }
    for (const x of rates.inputs) { v[x.item] = (v[x.item] || 0) - x.rate; items.add(x.item); }
    const power = machinePower(gd, rates.building, r, 1);
    v.cost = (0.02 + power * 0.002) * (prefer.has(r.id) ? 0.2 : 1) * costScale;
    variables[`r:${r.id}`] = v;
  }
  // raw supply variables
  const rawAvail = {};
  for (const s of supply.sources) rawAvail[s.resource] = (rawAvail[s.resource] || 0) + s.rate;
  if (supply.water) rawAvail.Desc_Water_C = Infinity;
  const unlimited = opts.resources === 'unlimited';
  for (const item of items) {
    const it = gd.items[item];
    if (!it?.isRawResource) continue;
    const cap = unlimited ? Infinity : rawAvail[item] ?? 0;
    if (cap <= 0) continue;
    variables[`raw:${item}`] = { [item]: 1, cost: (weights[item] ?? 1) * costScale, ...(cap !== Infinity ? { [`cap:${item}`]: 1 } : {}) };
    if (cap !== Infinity) constraints[`cap:${item}`] = { max: cap };
  }
  for (const inp of inputs) {
    variables[`in:${inp.item}`] = { [inp.item]: 1, cost: 0, [`incap:${inp.item}`]: 1 };
    constraints[`incap:${inp.item}`] = { max: inp.rate };
    items.add(inp.item);
  }
  for (const item of items) constraints[item] = { min: 0 };
  for (const t of targets) constraints[t.item] = { min: (constraints[t.item]?.min || 0) + t.rate };
  if (maximize) {
    variables[`out:${maximize}`] = { [maximize]: -1, cost: 1 };
    constraints[maximize] = constraints[maximize] || { min: 0 };
  }

  if (goalVector.length) {
    // maximize t: produce every goal item at t × its remaining amount per minute (finishes all of them together in 1/t min)
    variables['goal:t'] = { cost: 1 };
    for (const g of goalVector) {
      variables['goal:t'][g.item] = -g.amount;
      constraints[g.item] = constraints[g.item] || { min: 0 };
    }
  }

  const lp = { direction: maximize || goalVector.length ? 'maximize' : 'minimize', objective: 'cost', constraints, variables };
  const sol = solve(lp);
  if (goalVector.length) return { ok: sol.status === 'optimal', goalT: sol.status === 'optimal' ? Object.fromEntries(sol.variables)['goal:t'] || 0 : 0, status: sol.status };
  if (sol.status !== 'optimal') {
    const diag = diagnoseInfeasible(gd, model, opts, targets, recipes);
    return { ok: false, status: sol.status, message: diag.message, shortages: diag.shortages, supply: summarizeSupply(gd, supply) };
  }
  const vals = Object.fromEntries(sol.variables);

  // ---- steps ----
  const steps = [];
  for (const r of recipes) {
    const x = vals[`r:${r.id}`] || 0;
    if (x < EPS) continue;
    const rates = recipeRates(gd, r);
    const b = gd.buildings[rates.building];
    // each machine port is one belt/pipe: per-machine rate must fit the best unlocked tier
    let portLimit = 1;
    for (const io of [...rates.inputs, ...rates.outputs]) {
      const cap = isFluid(gd, io.item) ? supply.pipeCap : supply.beltCap;
      portLimit = Math.min(portLimit, cap / io.rate);
    }
    const maxClock = Math.min(supply.maxClock, portLimit);
    const machines = Math.max(1, Math.ceil(x / maxClock - 1e-6));
    const clock = x / machines;
    if (portLimit < 1) warnings.push(`${r.name}: one machine at 100% needs more than one ${supply.belt?.name} per port, so it is capped at ${r2(portLimit * 100)}% clock (${machines} machines).`);
    steps.push({
      recipe: r.id,
      recipeName: r.name,
      alternate: r.alternate,
      building: rates.building,
      buildingName: b?.name,
      machinesExact: r2(x),
      machines,
      clockPercent: Math.ceil(clock * 1e6) / 1e4,
      clockAlt: machines > 1 && Math.abs(x - Math.round(x)) > 1e-3 ? `${machines - 1} @ ${r2(maxClock * 100)}% + 1 @ ${r2((x - (machines - 1) * maxClock) * 100)}%` : null,
      perMachine: {
        inputs: rates.inputs.map((i) => ({ item: i.item, name: itemName(gd, i.item), rate: r2(i.rate * clock) })),
        outputs: rates.outputs.map((o) => ({ item: o.item, name: itemName(gd, o.item), rate: r2(o.rate * clock) })),
      },
      inputs: rates.inputs.map((i) => ({ item: i.item, name: itemName(gd, i.item), rate: r2(i.rate * x) })),
      outputs: rates.outputs.map((o) => ({ item: o.item, name: itemName(gd, o.item), rate: r2(o.rate * x) })),
      powerMW: r2(machinePower(gd, rates.building, r, clock) * machines),
    });
  }
  // order: raw-consuming first (by depth in the item graph)
  const depth = new Map();
  const producerOf = (item) => steps.filter((s) => s.outputs.some((o) => o.item === item));
  const depthOf = (s, seen = new Set()) => {
    if (depth.has(s.recipe)) return depth.get(s.recipe);
    if (seen.has(s.recipe)) return 0;
    seen.add(s.recipe);
    let d = 0;
    for (const i of s.inputs) for (const p of producerOf(i.item)) if (p !== s) d = Math.max(d, depthOf(p, seen) + 1);
    depth.set(s.recipe, d);
    return d;
  };
  steps.forEach((s) => depthOf(s));
  steps.sort((a, b) => depth.get(a.recipe) - depth.get(b.recipe));
  steps.forEach((s, i) => { s.id = `S${i + 1}`; s.depth = depth.get(s.recipe); });

  // ---- raw resources & node assignment ----
  const raw = [];
  for (const [k, v] of Object.entries(vals)) {
    if (!k.startsWith('raw:') || v < EPS) continue;
    const item = k.slice(4);
    raw.push({ item, name: itemName(gd, item), rate: r2(v) });
  }
  const nodePlan = assignNodes(gd, supply, raw);

  // ---- flows between steps (who feeds whom) ----
  const flows = buildFlows(gd, steps, raw, inputs.map((i) => ({ ...i, rate: vals[`in:${i.item}`] || 0 })), targets, maximize ? { item: maximize, rate: vals[`out:${maximize}`] || 0 } : null, supply);

  // ---- surplus ----
  const net = {};
  for (const s of steps) {
    for (const o of s.outputs) net[o.item] = (net[o.item] || 0) + o.rate;
    for (const i of s.inputs) net[i.item] = (net[i.item] || 0) - i.rate;
  }
  for (const r of raw) net[r.item] = (net[r.item] || 0) + r.rate;
  for (const i of inputs) net[i.item] = (net[i.item] || 0) + (vals[`in:${i.item}`] || 0);
  for (const t of targets) net[t.item] = (net[t.item] || 0) - t.rate;
  if (maximize) net[maximize] = (net[maximize] || 0) - (vals[`out:${maximize}`] || 0);
  const surplus = Object.entries(net).filter(([, v]) => v > 0.01).map(([k, v]) => ({ item: k, name: itemName(gd, k), rate: r2(v) }));

  // ---- totals ----
  const buildingsCount = {};
  let power = 0;
  for (const s of steps) { buildingsCount[s.buildingName] = (buildingsCount[s.buildingName] || 0) + s.machines; power += s.powerMW; }
  for (const n of nodePlan.filter((n) => n.kind === 'node')) buildingsCount[n.building] = (buildingsCount[n.building] || 0) + 1;
  const buildCost = {};
  for (const s of steps) addCost(gd, buildCost, s.building, s.machines);
  for (const n of nodePlan.filter((n) => n.kind === 'node')) addCost(gd, buildCost, n.buildingId, 1);
  const minerPower = nodePlan.filter((n) => n.kind === 'node').reduce((sum, n) => sum + machinePower(gd, n.buildingId, null, n.clock || 1), 0);
  power += minerPower;

  if (model) {
    const head = model.power.capacityMW - model.power.consumptionMW;
    if (power > head) warnings.push(`Needs ${r2(power)} MW but your grid only has ~${r2(head)} MW headroom — add generators first.`);
  }
  for (const s of steps) if (s.alternate) warnings.push(`Uses alternate recipe "${s.recipeName}".`);
  if (known) {
    const locked = steps.filter((s) => !known.has(s.recipe));
    const lockedB = [...new Set(steps.map((s) => s.building).filter((b) => !knownBuildings.has(b)))];
    const unlockOf = (rid) => Object.values(gd.schematics).filter((sc) => sc.unlockRecipes.includes(rid) && ['Milestone', 'MAM', 'Alternate', 'Tutorial'].includes(sc.type)).map((sc) => `${sc.name}${sc.tier ? ` (T${sc.tier})` : ''}`)[0] || 'unknown';
    if (locked.length) warnings.push(`Not unlocked yet — recipes: ${locked.map((s) => `${s.recipeName} ← ${unlockOf(s.recipe)}`).join('; ')}`);
    if (lockedB.length) warnings.push(`Not unlocked yet — buildings: ${lockedB.map((b) => `${gd.buildings[b]?.name} ← ${unlockOf(gd.buildings[b]?.buildRecipe)}`).join('; ')}`);
  }

  return {
    ok: true,
    targets: targets.map((t) => ({ item: t.item, name: itemName(gd, t.item), rate: t.rate })),
    maximized: maximize ? { item: maximize, name: itemName(gd, maximize), rate: r2(vals[`out:${maximize}`] || 0) } : null,
    logistics: { belt: supply.belt?.name, beltCap: supply.beltCap, pipe: supply.pipe?.name ?? null, pipeCap: supply.pipeCap, miner: supply.miner?.name ?? null, maxClockPercent: supply.maxClock * 100 },
    steps,
    raw,
    nodes: nodePlan,
    inputsUsed: inputs.map((i) => ({ item: i.item, name: itemName(gd, i.item), rate: r2(vals[`in:${i.item}`] || 0) })).filter((i) => i.rate > 0),
    flows,
    surplus,
    totals: { machines: buildingsCount, powerMW: r2(power), buildCost: Object.entries(buildCost).map(([k, v]) => ({ item: k, name: itemName(gd, k), amount: Math.ceil(v) })) },
    warnings: [...new Set(warnings)],
  };
}

function addCost(gd, acc, buildingId, count) {
  const r = gd.recipes[gd.buildings[buildingId]?.buildRecipe];
  if (!r) return;
  for (const i of r.ingredients) acc[i.item] = (acc[i.item] || 0) + i.amount * count;
}

export function findRecipe(gd, q) {
  if (gd.recipes[q]) return q;
  const s = String(q).toLowerCase().trim();
  const hit = Object.values(gd.recipes).find((r) => r.kind === 'machine' && (r.name.toLowerCase() === s || r.name.toLowerCase() === `alternate: ${s}`));
  return hit?.id || null;
}

function assignNodes(gd, supply, raw) {
  const out = [];
  for (const r of raw) {
    if (r.item === 'Desc_Water_C') {
      const ex = gd.buildings.Build_WaterPump_C;
      const per = (60 / ex.cycleTime) * ex.itemsPerCycle / 1000;
      const n = Math.ceil(r.rate / per - 1e-6);
      out.push({ kind: 'water', resource: 'Desc_Water_C', name: 'Water', building: ex.name, buildingId: ex.id, count: n, rate: r.rate, note: `${n} × Water Extractor (${per} m³/min each) on any water surface` });
      continue;
    }
    let left = r.rate;
    const cands = supply.sources.filter((s) => s.resource === r.item)
      .sort((a, b) => (b.kind !== 'node') - (a.kind !== 'node') || (b.purity === 'pure') - (a.purity === 'pure') || a.dist - b.dist);
    for (const s of cands) {
      if (left <= 0.01) break;
      const take = Math.min(left, s.rate);
      left -= take;
      const entry = { kind: s.kind, resource: r.item, name: itemName(gd, r.item), node: s.node, purity: s.purity, where: s.where, rate: r2(take), building: s.building, buildingId: s.buildingId, existing: s.existing };
      if (s.kind === 'node' || s.kind === 'existing-reuse') {
        entry.clock = Math.min(1, take / (s.potential / (supply.maxClock || 1)));
        entry.note = `${s.kind === 'existing-reuse' ? `keep your ${s.building}` : s.building} on ${s.purity} node @ ${r2(entry.clock * 100)}% → ${r2(take)}/min${s.capLimited ? ` (belt-capped: miner could do ${r2(s.potential)}/min)` : ''}`;
      } else entry.note = s.note;
      out.push(entry);
    }
  }
  return out;
}

function buildFlows(gd, steps, raw, inputs, targets, maximized, supply) {
  // distribute each item from producers to consumers proportionally
  const flows = [];
  const items = new Set([...steps.flatMap((s) => [...s.inputs, ...s.outputs].map((x) => x.item)), ...targets.map((t) => t.item)]);
  for (const item of items) {
    const producers = [];
    for (const s of steps) for (const o of s.outputs) if (o.item === item) producers.push({ id: s.id, rate: o.rate });
    for (const r of raw) if (r.item === item) producers.push({ id: 'RAW', rate: r.rate });
    for (const i of inputs) if (i.item === item && i.rate > 0) producers.push({ id: 'INPUT', rate: i.rate });
    const consumers = [];
    for (const s of steps) for (const i of s.inputs) if (i.item === item) consumers.push({ id: s.id, rate: i.rate });
    for (const t of targets) if (t.item === item) consumers.push({ id: 'OUTPUT', rate: t.rate });
    if (maximized && maximized.item === item) consumers.push({ id: 'OUTPUT', rate: maximized.rate });
    const totalP = producers.reduce((a, b) => a + b.rate, 0);
    const totalC = consumers.reduce((a, b) => a + b.rate, 0);
    if (totalP < EPS) continue;
    const cap = isFluid(gd, item) ? supply.pipeCap : supply.beltCap;
    for (const p of producers) {
      for (const c of consumers) {
        const rate = (p.rate / totalP) * c.rate;
        if (rate > 0.005) flows.push({ from: p.id, to: c.id, item, name: itemName(gd, item), rate: r2(rate), fluid: isFluid(gd, item), lines: Math.ceil(rate / cap - 1e-9) });
      }
      const extra = p.rate - (p.rate / totalP) * totalC;
      if (extra > 0.01) flows.push({ from: p.id, to: 'SURPLUS', item, name: itemName(gd, item), rate: r2(extra), fluid: isFluid(gd, item), lines: Math.ceil(extra / cap - 1e-9) });
    }
  }
  return flows;
}

function summarizeSupply(gd, supply) {
  const by = {};
  for (const s of supply.sources) by[s.resource] = (by[s.resource] || 0) + s.rate;
  return Object.entries(by).map(([k, v]) => ({ item: itemName(gd, k), availablePerMin: r2(v) }));
}

function diagnoseInfeasible(gd, model, opts, targets, recipes) {
  // re-solve with unlimited resources to see what is short
  if (opts.resources !== 'unlimited') {
    const relaxed = planProduction(gd, model, { ...opts, resources: 'unlimited' });
    if (relaxed.ok) {
      const supply = rawSupply(gd, model, opts);
      const avail = {};
      for (const s of supply.sources) avail[s.resource] = (avail[s.resource] || 0) + s.rate;
      const shortages = relaxed.raw.filter((r) => r.item !== 'Desc_Water_C' && r.rate > (avail[r.item] || 0) + 0.01)
        .map((r) => ({ item: r.name, needPerMin: r.rate, availablePerMin: r2(avail[r.item] || 0) }));
      return { message: `Not enough raw resources within reach with ${supply.miner?.name || 'no miner'} + ${supply.belt?.name || 'no belt'}. Shortages: ${shortages.map((s) => `${s.item} need ${s.needPerMin}/min, have ${s.availablePerMin}/min`).join('; ')}. Try a lower rate, a larger node radius (max_node_distance, CLI --distance), or resources "unlimited" to see the full requirement.`, shortages };
    }
  }
  const missing = targets.filter((t) => !recipes.some((r) => r.products.some((p) => p.item === t.item)));
  if (missing.length) return { message: `No unlocked recipe produces: ${missing.map((m) => itemName(gd, m.item)).join(', ')}. Unlock it first, or plan ahead with allow_locked (CLI: --locked).`, shortages: [] };
  return { message: 'No feasible plan with your unlocked recipes. Some ingredient is not producible yet (check unlocks), or needs hand-gathered items — pass them as inputs.', shortages: [] };
}

export { MANUAL_OK };
