// Rebuild planning: what you get back by dismantling existing lines, what the new design costs,
// what is still short, how to cover it, and in which order to tear down and rebuild.
// Dismantling in Satisfactory refunds 100% of a building's cost; belts cost ~1 unit per 2 m.
import { itemName } from '../gamedata/loader.js';
import { describeOffset } from '../save/model.js';
import { analyze } from '../analysis/analyze.js';
import { planProduction } from '../planner/plan.js';

const r1 = (x) => Math.round(x * 10) / 10;
export const beltUnits = (lengthM) => Math.max(1, Math.ceil(lengthM / 2));

function addCost(gd, acc, buildingId, n = 1) {
  const r = gd.recipes[gd.buildings[buildingId]?.buildRecipe];
  if (!r) return;
  for (const i of r.ingredients) acc[i.item] = (acc[i.item] || 0) + i.amount * n;
}
const addAll = (acc, inv) => { for (const [k, v] of Object.entries(inv || {})) acc[k] = (acc[k] || 0) + v; };

/** How many processing steps a recipe is from raw ore (ingots 0, plates 1, …) — for left-to-right ordering. */
function recipeDepth(gd, recipeId, seen = new Set()) {
  const r = gd.recipes[recipeId];
  if (!r || seen.has(recipeId)) return 0;
  seen.add(recipeId);
  let d = 0;
  for (const i of r.ingredients) {
    if (gd.items[i.item]?.isRawResource) continue;
    const p = (gd.producers[i.item] || []).find((x) => !gd.recipes[x].alternate);
    if (p) d = Math.max(d, 1 + recipeDepth(gd, p, seen));
  }
  return d;
}

/** Connected production lines (same grouping as the analyzer), with what they contain. */
export function productionGroups(model) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const kinds = ['manufacturer', 'extractor', 'splitter', 'merger', 'storage', 'generator'];
  for (const e of model.entities.values()) if (kinds.includes(e.category) && e.cls !== 'Build_StorageIntegrated_C') parent.set(e.id, e.id);
  for (const l of model.links) if (l.to && parent.has(l.from) && parent.has(l.to)) parent.set(find(l.from), find(l.to));
  const groups = new Map();
  for (const id of parent.keys()) (groups.get(find(id)) || groups.set(find(id), []).get(find(id))).push(model.entities.get(id));
  let n = 0;
  return [...groups.values()]
    .filter((g) => g.some((e) => e.category === 'manufacturer' || e.category === 'extractor'))
    .map((members) => {
      const ids = new Set(members.map((e) => e.id));
      const conveyors = [...new Set(model.links.filter((l) => ids.has(l.from)).flatMap((l) => l.conveyors))].map((id) => model.entities.get(id)).filter(Boolean);
      const center = members.reduce((a, e) => ({ x: a.x + e.pos.x / members.length, y: a.y + e.pos.y / members.length }), { x: 0, y: 0 });
      return { index: ++n, members, conveyors, center, powersGrid: members.some((e) => e.category === 'generator'), recipes: [...new Set(members.filter((e) => e.recipe).map((e) => e.recipe))] };
    });
}

/**
 * Pick what to dismantle. scope: 'near' (lines within radius of the site, default), 'all', 'none', or [line numbers].
 * Power lines (anything feeding generators) are kept unless includePower. Miners whose node the new plan reuses are kept.
 */
export function selectDismantle(gd, model, { scope = 'near', radius = 250, site = null, includePower = false, reuseExtractors = [] } = {}) {
  const groups = productionGroups(model);
  const origin = site || model.hubPos || model.playerPos;
  const keepIds = new Set(reuseExtractors);
  const chosen = groups.filter((g) => {
    if (scope === 'none') return false;
    if (g.powersGrid && !includePower) return false;
    if (Array.isArray(scope)) return scope.map(Number).includes(g.index);
    if (scope === 'all') return true;
    return Math.hypot(g.center.x - origin.x, g.center.y - origin.y) <= radius;
  });
  const refund = {};
  const buffers = {};
  const removed = [];
  let powerFreed = 0;
  const lineRefund = new Map();
  for (const g of chosen) {
    const lr = {};
    for (const e of g.members) {
      if (keepIds.has(e.id)) continue;
      addCost(gd, refund, e.cls);
      addCost(gd, lr, e.cls);
      addAll(buffers, e.inputInv);
      addAll(buffers, e.outputInv);
      powerFreed += e.powerMW || 0;
      removed.push(e);
    }
    for (const c of g.conveyors) {
      const r = gd.recipes[gd.buildings[c.cls]?.buildRecipe];
      const units = c.category === 'belt' ? beltUnits(c.length || 0) : 1;
      for (const i of r?.ingredients || []) {
        refund[i.item] = (refund[i.item] || 0) + i.amount * units;
        lr[i.item] = (lr[i.item] || 0) + i.amount * units;
      }
      removed.push(c);
    }
    lineRefund.set(g.index, lr);
  }
  // what each line is made of, in flow order (miners → machines by recipe → storage), for diagrams
  const partsOf = (g) => {
    const order = { extractor: 0, manufacturer: 1, splitter: 2, merger: 2, storage: 3, generator: 4 };
    const by = new Map();
    for (const e of g.members) {
      const key = e.category === 'manufacturer' ? `${e.cls}|${e.recipe}` : e.category === 'extractor' ? `${e.cls}|${e.id}` : e.cls;
      const p = by.get(key) || { kind: e.category, building: e.name, recipe: e.recipe ? gd.recipes[e.recipe]?.name : null, resource: e.resource ? itemName(gd, e.resource) : null, purity: e.purity, count: 0, keep: keepIds.has(e.id), depth: e.recipe ? recipeDepth(gd, e.recipe) : 0 };
      p.count++;
      by.set(key, p);
    }
    return [...by.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.depth - b.depth);
  };
  const lines = chosen.map((g) => ({
    line: g.index,
    where: describeOffset(model.hubPos, { ...g.center, z: 0 }),
    recipes: g.recipes.map((r) => gd.recipes[r]?.name || r),
    buildings: g.members.filter((e) => !keepIds.has(e.id)).length,
    belts: g.conveyors.length,
    keptMiners: g.members.filter((e) => keepIds.has(e.id)).map((e) => e.name),
    storageWithItems: g.members.filter((e) => e.category === 'storage' && Object.keys(e.storageInv || {}).length).length,
    parts: partsOf(g),
    refund: toList(gd, lineRefund.get(g.index) || {}),
  }));
  const kept = groups.filter((g) => !chosen.includes(g)).map((g) => ({ line: g.index, where: describeOffset(model.hubPos, { ...g.center, z: 0 }), recipes: g.recipes.map((r) => gd.recipes[r]?.name || r), why: g.powersGrid && !includePower ? 'feeds your power' : 'outside the area' }));
  return { lines, kept, removed, refund, buffers, powerFreedMW: powerFreed };
}

/** What the new design costs (machines, attachments, foundations, poles, new miners + belts by length). */
export function designCost(gd, layout, plan) {
  const cost = {};
  for (const m of layout.bom.materials) cost[m.item] = (cost[m.item] || 0) + m.amount;
  for (const [beltName, metres] of Object.entries(layout.bom.belts)) {
    const b = Object.values(gd.buildings).find((x) => x.name === beltName && (x.category === 'belt' || x.category === 'pipe'));
    const r = gd.recipes[b?.buildRecipe];
    for (const i of r?.ingredients || []) cost[i.item] = (cost[i.item] || 0) + i.amount * beltUnits(metres);
  }
  if (layout.bom.lifts) {
    const lift = Object.values(gd.buildings).find((x) => x.name === layout.bom.lifts.type);
    addCost(gd, cost, lift?.id, layout.bom.lifts.count);
  }
  void plan;
  return cost;
}

function handCraftable(gd, model, item) {
  const r = Object.values(gd.recipes).find((x) => x.products.some((p) => p.item === item) && x.producedIn.some((p) => /WorkBench|Workshop/i.test(p)) && (!model || model.unlocks.hasRecipe(x.id)));
  if (r) r.station = r.producedIn.some((p) => /Workshop/i.test(p)) ? 'Equipment Workshop' : 'Craft Bench';
  return r;
}

/**
 * Full rebuild check. design = { plan, layout }. Returns balance per item, shortages with how to cover them,
 * a tear-down / build sequence and a power check.
 */
export function rebuildCheck(gd, model, design, opts = {}) {
  const reuse = (design.plan.nodes || []).filter((n) => n.kind === 'existing-reuse' && n.existing).map((n) => n.existing);
  const dis = selectDismantle(gd, model, { ...opts, reuseExtractors: reuse });
  const need = designCost(gd, design.layout, design.plan);
  const analysis = analyze(model, gd);
  const rate = Object.fromEntries(analysis.itemBalance.map((b) => [b.item, b.netPerMin]));

  const items = new Set([...Object.keys(need)]);
  const balance = [];
  for (const item of items) {
    const have = Math.floor(model.inventoryTotals[item] || 0);
    const back = Math.floor((dis.refund[item] || 0) + (dis.buffers[item] || 0));
    const needed = Math.ceil(need[item] || 0);
    const short = Math.max(0, needed - have - back);
    const shortBeforeDismantle = Math.max(0, needed - have);
    balance.push({ item, name: itemName(gd, item), need: needed, have, fromDismantle: back, short, shortBeforeDismantle });
  }
  balance.sort((a, b) => b.short - a.short || b.need - a.need);

  // how to cover each shortage
  const actions = [];
  let waitMin = 0;
  for (const b of balance.filter((x) => x.short > 0)) {
    const perMin = rate[b.name] || 0;
    const craft = handCraftable(gd, model, b.item);
    if (perMin > 0.05) {
      const mins = b.short / perMin;
      waitMin = Math.max(waitMin, mins);
      actions.push({ item: b.name, short: b.short, how: 'wait', detail: `your factory makes ~${r1(perMin)}/min into storage → ~${Math.ceil(mins)} min${craft ? ' (or hand-craft some)' : ''}` });
    } else if (craft) {
      const per = craft.products.find((p) => p.item === b.item).amount;
      const crafts = Math.ceil(b.short / per);
      const mats = craft.ingredients.map((i) => `${i.amount * crafts} ${itemName(gd, i.item)}`).join(' + ');
      actions.push({ item: b.name, short: b.short, how: 'craft', detail: `hand-craft at the ${craft.station}: ${crafts}× "${craft.name}" = ${mats}` });
    } else {
      actions.push({ item: b.name, short: b.short, how: 'build-first', detail: 'nothing makes it yet — build this part of the new factory first (or a small temporary line), then the rest' });
    }
  }

  // staged rebuild: if the new factory itself makes a short item, build that part first and let it pay for the rest
  const stage = stagedBuild(gd, design, need, balance, model, opts.request);
  if (stage) {
    for (const a of actions) if (stage.covers.includes(a.item)) { a.how = 'stage'; a.detail = `build a small stage 1 first (${stage.steps.join(', ')}) on the miner you keep: it makes ~${r1(stage.rates[a.item])}/min → the rest in ~${Math.ceil(stage.minutes[a.item])} min`; }
    waitMin = Math.max(0, ...actions.filter((a) => a.how === 'wait').map((a) => a.short / (rate[a.item] || 1)));
  }

  // hand-crafts that need something still short (e.g. plates) must wait until that is covered
  const shortNames = new Set(actions.map((a) => a.item));
  for (const a of actions.filter((x) => x.how === 'craft')) {
    const craft = handCraftable(gd, model, balance.find((b) => b.name === a.item).item);
    a.after = craft.ingredients.map((i) => itemName(gd, i.item)).filter((n) => shortNames.has(n));
  }

  // stage 1 must also make what the later hand-crafts consume (e.g. 6 plates per hand-crafted RIP)
  if (stage) {
    for (const a of actions.filter((x) => x.how === 'craft' && x.after.length)) {
      const b = balance.find((x) => x.name === a.item);
      const craft = handCraftable(gd, model, b.item);
      const n = Math.ceil(a.short / craft.products.find((p) => p.item === b.item).amount);
      for (const i of craft.ingredients) {
        const nm = itemName(gd, i.item);
        if (stage.rates[nm]) stage.minutes[nm] += (i.amount * n) / stage.rates[nm];
      }
    }
    stage.maxMinutes = Math.max(...Object.values(stage.minutes));
    for (const a of actions) if (a.how === 'stage') a.detail = a.detail.replace(/~\d+ min$/, `~${Math.ceil(stage.minutes[a.item])} min (incl. plates for the hand-crafts)`);
  }

  // tear-down & build sequence, in phases
  const steps = [];
  const nowCrafts = actions.filter((a) => a.how === 'craft' && !a.after.length);
  const laterCrafts = actions.filter((a) => a.how === 'craft' && a.after.length);
  const waits = actions.filter((a) => a.how === 'wait');
  const missing = actions.filter((a) => a.how === 'build-first');
  if (!actions.length) {
    steps.push(dis.lines.length
      ? `You can afford it: storage + what dismantling returns covers the whole new factory${balance.some((b) => b.shortBeforeDismantle > 0) ? ' (some items only after you dismantle, so dismantle first)' : ' (you could even build it before tearing the old one down)'}.`
      : 'You can afford the whole new factory from storage — build it next to the old one.');
  }
  if (nowCrafts.length || waits.length) {
    steps.push(`**Before you dismantle anything:**${nowCrafts.map((a) => ` hand-craft ${a.short} ${a.item};`).join('')}${waits.length ? ` let your current factory run ~${Math.ceil(waitMin)} min to stock up ${waits.map((a) => `${a.short} ${a.item}`).join(', ')}.` : ''}`);
  }
  if (dis.lines.length) {
    if (dis.lines.some((l) => l.storageWithItems)) steps.push('Empty the storage containers you are about to remove (dismantling drops their items into a crate you must pick up).');
    for (const l of dis.lines) steps.push(`Dismantle line ${l.line} (${l.where}: ${l.recipes.join(', ') || 'miner only'}) — ${l.buildings} buildings + ${l.belts} belts${l.keptMiners.length ? `; keep the ${l.keptMiners.join(', ')} (reused)` : ''}.`);
  } else steps.push('Nothing to dismantle in the chosen area.');
  if (stage) {
    steps.push(`**Stage 1:** build ${stage.steps.join(', ')} (${stage.machines} machines) next to the miner you keep (${stage.feeds.join("; ")}). Storage + refunds cover it.`);
    steps.push(`Let stage 1 run ~${Math.ceil(stage.maxMinutes)} min and collect its ${Object.entries(stage.rates).map(([k, v]) => `${r1(v)}/min ${k}`).join(', ')} in a storage container.`);
  }
  if (laterCrafts.length) steps.push(`Then hand-craft ${laterCrafts.map((a) => `${a.short} ${a.item}`).join(', ')} (they need ${[...new Set(laterCrafts.flatMap((a) => a.after))].join(', ')} from the step before).`);
  for (const a of missing) steps.push(`${a.item}: ${a.detail}.`);
  steps.push(`${stage ? '**Stage 2:** build' : 'Build'} the rest of the new factory row by row from the sketch (or place the blueprint once blueprints are unlocked), then connect power.`);
  const cap = model.power.capacityMW;
  const after = model.power.consumptionMW - dis.powerFreedMW + design.plan.totals.powerMW;
  const power = { capacityMW: r1(cap), afterRebuildMW: r1(after), ok: after <= cap * 0.95 };
  if (!power.ok) steps.push(`Power: the new factory needs ${r1(design.plan.totals.powerMW)} MW → ${r1(after)} MW total vs ${r1(cap)} MW capacity. Add generators (or underclock) before switching it on.`);

  // the same order of work as structured cards, for the visual guide
  const timeline = [];
  const craftCard = (a, when) => {
    const b = balance.find((x) => x.name === a.item);
    const craft = handCraftable(gd, model, b.item);
    const per = craft.products.find((p) => p.item === b.item).amount;
    const n = Math.ceil(a.short / per);
    return {
      kind: 'craft', when,
      title: `Hand-craft ${n * per} ${a.item}`,
      text: `At the ${craft.station}.${when === 'after' ? ` Uses ${a.after.join(', ')} from the step before.` : ''}`,
      station: craft.station,
      inputs: craft.ingredients.map((i) => ({ name: itemName(gd, i.item), amount: i.amount * n })),
      output: { name: a.item, amount: n * per },
    };
  };
  if (!actions.length) timeline.push({ kind: 'ok', title: 'You can afford the whole rebuild', text: steps[0] });
  for (const a of nowCrafts) timeline.push(craftCard(a, 'now'));
  for (const a of waits) {
    const src = analysis.lines.find((l) => l.recipes.some((r) => r === a.item || r.startsWith(a.item.replace(/s$/, ''))));
    timeline.push({ kind: 'wait', when: 'now', title: `Let your factory make ${a.short} more ${a.item}`, text: 'Keep the old factory running and collect it from its storage.', item: a.item, amount: a.short, perMin: r1(rate[a.item] || 0), minutes: Math.ceil(a.short / (rate[a.item] || 1)), source: src ? { recipes: src.recipes, where: src.where } : null });
  }
  const storages = dis.lines.reduce((s, l) => s + l.storageWithItems, 0);
  if (storages) timeline.push({ kind: 'empty', title: `Empty ${storages} storage container${storages > 1 ? 's' : ''}`, text: 'The ones on the lines you are about to remove — dismantling drops their items into a crate.', count: storages });
  for (const l of dis.lines) timeline.push({ kind: 'dismantle', title: `Dismantle line ${l.line}: ${l.recipes.join(', ') || 'miner'}`, text: `${l.where} · ${l.buildings} buildings + ${l.belts} belts · everything is refunded${l.keptMiners.length ? ` · keep the ${l.keptMiners.join(', ')}` : ''}`, line: l });
  if (stage) {
    timeline.push({
      kind: 'stage1', title: `Stage 1: a small ${stage.covers.join(' + ')} line`,
      text: `Build it next to the miner you keep — storage + refunds already cover it. Collect what it makes in a storage container.`,
      minutes: Math.ceil(stage.maxMinutes), stage,
    });
  }
  for (const a of laterCrafts) timeline.push(craftCard(a, 'after'));
  for (const a of missing) timeline.push({ kind: 'note', title: a.item, text: a.detail });
  timeline.push({
    kind: 'build', title: stage ? 'Stage 2: build the rest of the factory' : 'Build the new factory',
    text: 'Row by row from the sketch (or the blueprint once you have unlocked blueprints).',
    steps: design.plan.steps.map((s) => ({ id: s.id, recipe: s.recipeName, building: s.buildingName, buildingId: s.building, machines: s.machines, clock: s.clockPercent, depth: s.depth })),
    flows: design.plan.flows.map((f) => ({ from: f.from, to: f.to, item: f.name, rate: f.rate, lines: f.lines })),
  });
  timeline.push({ kind: 'power', title: power.ok ? 'Connect power and switch it on' : 'Add power before switching it on', text: `The new factory needs ${r1(design.plan.totals.powerMW)} MW.`, power, needMW: r1(design.plan.totals.powerMW), freedMW: r1(dis.powerFreedMW), nowMW: r1(model.power.consumptionMW) });

  return {
    timeline,
    stage,
    dismantle: { lines: dis.lines, kept: dis.kept, refund: toList(gd, dis.refund), buffers: toList(gd, dis.buffers), powerFreedMW: r1(dis.powerFreedMW) },
    cost: toList(gd, need),
    balance,
    shortages: actions,
    canRebuildNow: actions.length === 0,
    waitMinutes: Math.ceil(waitMin),
    power,
    steps,
  };
}

/**
 * Smallest part of the new factory that makes the short items (plus everything upstream of it). If you can afford
 * it now, building it first lets the new factory produce the materials for the rest.
 */
function stagedBuild(gd, design, need, balance, model, request = {}) {
  const plan = design.plan;
  // the miners you keep feed stage 1, so it needs no new miners
  const keptNodes = plan.nodes.filter((n) => n.kind === 'existing-reuse' || n.kind === 'existing-spare').map((n) => n.node);
  if (!keptNodes.length) return null;
  const avail = Object.fromEntries(balance.map((b) => [b.item, b.have + b.fromDismantle]));
  const availOf = (k) => avail[k] ?? Math.floor(model.inventoryTotals[k] || 0);
  const beltR = gd.recipes[Object.values(gd.buildings).find((b) => b.name === plan.logistics.belt)?.buildRecipe];
  const costOf = (p) => {
    const cost = {};
    let machines = 0;
    for (const s of p.steps) {
      machines += s.machines;
      addCost(gd, cost, s.building, s.machines);
      addCost(gd, cost, 'Build_ConveyorAttachmentSplitter_C', Math.max(0, s.machines - 1) * s.inputs.length);
      addCost(gd, cost, 'Build_ConveyorAttachmentMerger_C', Math.max(0, s.machines - 1));
    }
    const beltM = machines * 12 + 40; // a compact stage: ~12 m of belt per machine + the feed from the miner
    for (const i of beltR?.ingredients || []) cost[i.item] = (cost[i.item] || 0) + i.amount * beltUnits(beltM);
    return { cost, machines };
  };
  const fits = (c) => Object.entries(c).every(([k, v]) => availOf(k) >= v);
  // try the biggest shortage the new factory makes, then the next one
  const candidates = balance.filter((b) => b.short > 0 && plan.steps.some((s) => s.outputs.some((o) => o.item === b.item))).sort((a, b) => b.short - a.short);
  const base = { ...request, targets: [], goalVector: undefined, maximize: undefined, nodes: keptNodes, rebuild: true, nearestNodes: undefined };
  for (const c of candidates) {
    const max = planProduction(gd, model, { ...base, maximize: c.item });
    if (!max.ok || !max.maximized?.rate) continue;
    let rate = max.maximized.rate;
    for (let k = 0; k < 20 && rate > 0.5; k++) {
      const p = k === 0 ? max : planProduction(gd, model, { ...base, targets: [{ item: c.item, rate }] });
      if (!p.ok) break;
      const { cost, machines } = costOf(p);
      if (fits(cost)) {
        const stillShort = Math.max(0, (need[c.item] || 0) - (availOf(c.item) - (cost[c.item] || 0)));
        const minutes = stillShort / rate;
        return withFullPlan(p, {
          steps: p.steps.map((s) => `${s.recipeName} ×${s.machines}${Math.abs(s.clockPercent - 100) > 0.01 ? ` @ ${s.clockPercent}%` : ''}`),
          machines,
          cost: toList(gd, cost),
          covers: [c.name],
          rates: { [c.name]: rate },
          minutes: { [c.name]: minutes },
          maxMinutes: minutes,
          feeds: p.nodes.map((n) => n.note),
          plan: {
            steps: p.steps.map((s) => ({ recipe: s.recipeName, building: s.buildingName, buildingId: s.building, machines: s.machines, clock: s.clockPercent, inputs: s.inputs, outputs: s.outputs })),
            nodes: p.nodes.map((n) => ({ name: n.name, purity: n.purity, building: n.building, rate: n.rate, where: n.where, kind: n.kind })),
          },
        });
      }
      rate *= 0.75;
    }
  }
  return null;
}

/** Attaches the full stage-1 plan without putting it into JSON output. */
const withFullPlan = (plan, obj) => Object.defineProperty(obj, 'fullPlan', { value: plan, enumerable: false });

const toList = (gd, o) => Object.entries(o).filter(([, v]) => v > 0).map(([k, v]) => ({ item: k, name: itemName(gd, k), amount: Math.floor(v) })).sort((a, b) => b.amount - a.amount);
