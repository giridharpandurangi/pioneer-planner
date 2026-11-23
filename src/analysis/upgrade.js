// Upgrade options for what you already have: what each miner/line could deliver with better belts or miners,
// how many machines you'd add, and what the belt swap costs (building a faster belt over an old one refunds the old one).
import { itemName, recipeRates } from '../gamedata/loader.js';
import { describeOffset, PURITY_MULT } from '../save/model.js';
import { beltUnits, productionGroups } from '../rebuild/rebuild.js';
import { nextUnlocks } from './analyze.js';

const r1 = (x) => Math.round(x * 10) / 10;

export function upgradeOptions(gd, model) {
  const belts = gd.beltTiers;
  const miners = Object.values(gd.buildings).filter((b) => b.category === 'extractor' && /Miner/.test(b.id)).sort((a, b) => a.tier - b.tier);
  const bestBelt = model.unlocks.belt;
  const nextBelt = belts.find((b) => b.tier === (bestBelt?.tier || 0) + 1);
  const bestMiner = model.unlocks.miner;
  const nextMiner = miners.find((b) => b.tier === (bestMiner?.tier || 0) + 1);
  const unlockOf = (buildingId) => {
    const s = Object.values(gd.schematics).find((x) => x.unlockRecipes.includes(gd.buildings[buildingId]?.buildRecipe) && x.type === 'Milestone');
    return s ? `${s.name} (T${s.tier})` : 'a later milestone';
  };
  const groups = productionGroups(model);
  const out = [];
  for (const g of groups) {
    const ex = g.members.filter((e) => e.category === 'extractor');
    for (const x of ex) {
      const b = gd.buildings[x.cls];
      const base = (60 / b.cycleTime) * b.itemsPerCycle;
      const outLinks = model.links.filter((l) => l.from === x.id);
      const capNow = Math.min(...outLinks.map((l) => l.capacity ?? Infinity), Infinity);
      const usedNow = (x.potentialRate || 0) * (x.productivity ?? 1);
      const options = [];
      const consumer = outLinks.map((l) => model.entities.get(l.to)).find((e) => e?.category === 'manufacturer');
      const perMachine = consumer?.rates?.inputs.find((i) => i.item === x.resource)?.rate;
      const extraMachines = (extra) => (perMachine ? `${Math.ceil(extra / perMachine - 0.05)} more ${consumer.name}(s) for "${gd.recipes[consumer.recipe]?.name}"` : 'more consumers');
      const usableNow = Math.min(x.potentialRate, capNow === Infinity ? 0 : capNow);
      if (usedNow < usableNow - 1) options.push({ when: 'now', change: 'use what the belt already carries', from: r1(usedNow), to: r1(usableNow), add: extraMachines(usableNow - usedNow) });
      const beltLen = g.conveyors.filter((c) => c.category === 'belt' && outLinks.some((l) => l.conveyors.includes(c.id))).reduce((s, c) => s + (c.length || 0), 0);
      for (const nb of [bestBelt, nextBelt].filter(Boolean)) {
        if (nb.itemsPerMin <= capNow) continue;
        const to = Math.min(x.potentialRate, nb.itemsPerMin);
        if (to <= usableNow + 0.5) continue;
        const cost = (gd.recipes[nb.buildRecipe]?.ingredients || []).map((i) => `${i.amount * beltUnits(beltLen)} ${itemName(gd, i.item)}`).join(' + ');
        options.push({ when: model.unlocks.has(nb.id) ? 'now' : `after ${unlockOf(nb.id)}`, change: `replace the miner's belt (${Math.round(beltLen)} m) with ${nb.name}`, from: r1(usableNow), to: r1(to), add: extraMachines(to - usableNow), cost: cost || null });
      }
      for (const nm of [bestMiner, nextMiner].filter(Boolean)) {
        if (nm.tier <= b.tier) continue;
        const pot = (60 / nm.cycleTime) * nm.itemsPerCycle * PURITY_MULT[x.purity];
        const beltFor = belts.find((bt) => bt.itemsPerMin >= pot) || belts[belts.length - 1];
        options.push({ when: model.unlocks.has(nm.id) ? 'now' : `after ${unlockOf(nm.id)}`, change: `${nm.name} (needs ${beltFor.name} to carry ${r1(pot)}/min${model.unlocks.has(beltFor.id) ? '' : `, unlocked by ${unlockOf(beltFor.id)}`})`, from: r1(usableNow), to: r1(Math.min(pot, beltFor.itemsPerMin)), add: extraMachines(Math.min(pot, beltFor.itemsPerMin) - usableNow) });
      }
      out.push({ line: g.index, extractor: x.name, resource: itemName(gd, x.resource), purity: x.purity, where: describeOffset(model.hubPos, x.pos), nowPerMin: r1(usedNow), base: r1(base * PURITY_MULT[x.purity]), options });
    }
  }
  const milestones = nextUnlocks(model, gd).filter((n) => n.unlocks.some((u) => /Conveyor Belt|Miner/.test(u)));
  void recipeRates;
  return { belt: bestBelt?.name, nextBelt: nextBelt ? { name: nextBelt.name, perMin: nextBelt.itemsPerMin, unlock: unlockOf(nextBelt.id) } : null, nextMiner: nextMiner ? { name: nextMiner.name, unlock: unlockOf(nextMiner.id) } : null, extractors: out, relevantMilestones: milestones.map((m) => m.name) };
}
