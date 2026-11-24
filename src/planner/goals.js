// "What do I still need?" — remaining milestone / space-elevator costs minus what you have,
// and a planner mode that builds the factory finishing all of it in a chosen time (or as fast as the nodes allow).
import { itemName, resolveItem } from '../gamedata/loader.js';
import { nextUnlocks } from '../analysis/analyze.js';
import { planProduction } from './plan.js';

// Space Elevator deliveries (1.0). Phase index = current game phase number (GP_Project_Assembly_Phase_N).
const ELEVATOR = {
  0: { name: 'Space Elevator Phase 1 (unlocks Tier 3–4)', cost: [['Desc_SpaceElevatorPart_1_C', 50]] },
  1: { name: 'Space Elevator Phase 2 (unlocks Tier 5–6)', cost: [['Desc_SpaceElevatorPart_1_C', 1000], ['Desc_SpaceElevatorPart_2_C', 1000], ['Desc_SpaceElevatorPart_3_C', 100]] },
};

/**
 * scope: 'active' (active milestone only), 'tier' (all milestones you can buy now, default), or a list of milestone names.
 * Returns { goals: [{name, cost}], needs: [{item, name, total, have, missing}] }.
 */
export function milestoneNeeds(gd, model, { scope = 'tier', elevator = true } = {}) {
  const next = nextUnlocks(model, gd);
  let chosen = next;
  if (scope === 'active') chosen = next.filter((x) => x.active);
  else if (Array.isArray(scope)) chosen = next.filter((x) => scope.some((s) => x.name.toLowerCase().includes(String(s).toLowerCase())));
  const goals = chosen.map((x) => ({ name: `T${x.tier} ${x.name}${x.active ? ' (active)' : ''}`, cost: x.cost.map((c) => ({ item: resolveItem(gd, c.item), amount: c.amount })) }));
  const phase = ELEVATOR[model.unlocks.gamePhaseNumber];
  if (elevator && phase && scope !== 'active') goals.push({ name: phase.name, cost: phase.cost.map(([item, amount]) => ({ item, amount })) });
  const total = {};
  for (const g of goals) for (const c of g.cost) total[c.item] = (total[c.item] || 0) + c.amount;
  const needs = Object.entries(total).map(([item, t]) => {
    const have = Math.floor(model.inventoryTotals[item] || 0);
    return { item, name: itemName(gd, item), total: t, have, missing: Math.max(0, t - have) };
  }).sort((a, b) => b.missing - a.missing);
  return { goals, needs };
}

/** Default finish time for the automatic milestone modes: big enough to matter, small enough to afford. */
export const DEFAULT_GOAL_MINUTES = 30;

/**
 * Plan the factory that produces every missing goal item in proportion, finishing them all at the same time.
 * opts.minutes: finish in about this many minutes (a smaller factory); if the nodes can't make it that fast, or
 * minutes is not given, the factory is as fast as the nodes allow.
 * opts.maxPowerMW: also slow it down until the factory runs on this much power (your free power).
 * Items that cannot be made with your unlocks / selected nodes are reported and left out.
 */
export function planForGoals(gd, model, request, needsInfo, { minutes, maxPowerMW } = {}) {
  const missing = needsInfo.needs.filter((n) => n.missing > 0);
  if (!missing.length) return { ok: true, nothingNeeded: true, needs: needsInfo };
  // which items can be produced at all with these rules?
  const producible = [];
  const blocked = [];
  for (const n of missing) {
    const test = planProduction(gd, model, { ...request, targets: [{ item: n.item, rate: 0.01 }], goalVector: undefined, maximize: undefined });
    (test.ok ? producible : blocked).push({ ...n, reason: test.ok ? null : test.message });
  }
  if (!producible.length) return { ok: false, message: `None of the missing items can be made with the selected nodes/unlocks. ${blocked.map((b) => `${b.name}: ${b.reason}`).join(' ')}`, needs: needsInfo, blocked };
  const goal = planProduction(gd, model, { ...request, goalVector: producible.map((n) => ({ item: n.item, amount: n.missing })) });
  if (!goal.ok || !goal.goalT) return { ok: false, message: 'Could not find a production mix for the missing items with these nodes.', needs: needsInfo, blocked };
  const fastest = 1 / goal.goalT;
  const wanted = Number(minutes) > 0 ? Number(minutes) : null;
  // slower than the nodes could go = fewer machines and nodes; never faster than they allow
  let finish = wanted !== null && wanted > fastest ? wanted : null;
  let limitedBy = finish ? 'time' : 'nodes';
  const build = (t) => {
    const targets = producible.map((n) => ({ item: n.item, rate: Math.round(n.missing * t * 1000) / 1000 })).filter((x) => x.rate > 0);
    return { targets, plan: planProduction(gd, model, { ...request, targets: [...(request.targets || []), ...targets], goalVector: undefined }) };
  };
  let t = finish ? 1 / finish : goal.goalT * 0.999;
  let { targets, plan } = build(t);
  // too much for your power: slow down until it fits (power falls about in step with the rate; a bit extra for whole machines)
  for (let k = 0; k < 6 && maxPowerMW > 0 && plan.ok && plan.totals.powerMW > maxPowerMW; k++) {
    finish = (1 / t) * (plan.totals.powerMW / maxPowerMW) * 1.03;
    limitedBy = 'power';
    t = 1 / finish;
    ({ targets, plan } = build(t));
  }
  return {
    ok: plan.ok,
    plan,
    minutes: Math.round((finish || fastest) * 10) / 10,
    fastestMinutes: Math.round(fastest * 10) / 10,
    wantedMinutes: wanted,
    limitedBy,
    powerBudgetMW: maxPowerMW > 0 ? Math.round(maxPowerMW) : null,
    targets: targets.map((x) => ({ ...x, name: itemName(gd, x.item) })),
    needs: needsInfo,
    blocked,
    message: plan.ok ? null : plan.message,
  };
}
