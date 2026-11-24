// Markdown renderers: compact enough for an AI's context window, readable in a terminal.
const n = (x) => (Math.round(x * 100) / 100).toString();
const table = (head, rows) => (rows.length ? `| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n${rows.map((r) => `| ${r.join(' | ')} |`).join('\n')}` : '_none_');

export function saves(list) {
  if (!list.length) return 'No saves found.';
  return `## Saves (newest first)\n${table(['Name', 'Modified', 'Size'], list.slice(0, 20).map((s) => [s.name, s.modified.replace('T', ' ').slice(0, 16), `${s.sizeKB} KB`]))}`;
}

export function loaded(m, a) {
  return `Loaded **${m.header.saveName}** (session "${m.header.sessionName}", ${m.header.playtimeHours} h played, save v${m.header.saveVersion}).\n` +
    `Tier ${a.progress.milestoneTier}, working on **${a.progress.activeMilestone || '—'}**. Best belt: ${a.logistics.belt}. ` +
    `${Object.values(a.buildings).reduce((s, v) => s + v, 0)} logistics/production buildings, ${a.issues.length} things to improve.` +
    (m.nodeDataSource === 'cache' ? '\n_This older save does not store node purity; using the node table remembered from a newer save._' : m.nodeDataSource === 'missing' ? '\n_This save does not store node purity/resource. Load one of your newer saves once so the tool can learn the node table._' : '');
}

export function status(m, a) {
  const L = [];
  L.push(`# Factory status — ${m.header.saveName}`);
  L.push(`Session "${m.header.sessionName}" · ${m.header.playtimeHours} h played · saved ${m.header.saved?.slice(0, 16).replace('T', ' ') || '?'}`);
  L.push(`\n## Progress\n- Milestone tier: **${a.progress.milestoneTier}** (game phase ${a.progress.gamePhase})\n- Active milestone: **${a.progress.activeMilestone || 'none'}**\n- Milestones: ${a.progress.milestones.join(', ')}\n- MAM research: ${a.progress.mamResearch.length ? a.progress.mamResearch.join(', ') : 'none'}\n- Alternate recipes: ${a.progress.alternateRecipes.length ? a.progress.alternateRecipes.join(', ') : 'none'}`);
  L.push(`\n## Logistics you can build\n- Belt: **${a.logistics.belt}** · Lift: ${a.logistics.lift} · Pipe: ${a.logistics.pipe}\n- Miner: ${a.logistics.miner} · Splitter: ${a.logistics.splitter ? 'yes' : 'no'} · Merger: ${a.logistics.merger ? 'yes' : 'no'} · Smart splitter: ${a.logistics.smartSplitter ? 'yes' : 'no'}\n- Power shards in storage: ${a.logistics.powerShards} (${a.logistics.overclockingPossible ? 'overclocking possible' : 'no overclocking — max 100% clock'})`);
  L.push(`\n## Power\n${n(a.power.consumptionMW)} MW max draw / ${n(a.power.capacityMW)} MW capacity → **${n(a.power.headroomMW)} MW headroom**`);
  L.push(`\n## Extraction\n${table(['Extractor', 'Resource', 'Purity', 'Clock', 'Potential', 'Belt cap', 'Actual', 'Where'], a.extraction.map((x) => [x.building, x.resource, x.purity, x.clock, `${x.potentialPerMin}/min`, `${x.beltCapPerMin}/min`, `${x.actualPerMin}/min`, x.where]))}`);
  L.push(`\n## Production (measured productivity from the save)\n${table(['Recipe', 'Building', 'Qty', 'Clock', 'Running', 'Max out/min', 'Actual out/min'], a.production.map((p) => [p.recipe, p.building, p.machines, p.avgClock, p.measuredProductivity, fmtRates(p.maxOutputPerMin), fmtRates(p.actualOutputPerMin)]))}`);
  L.push(`\n## Item balance (/min, actual)\n${table(['Item', 'Made', 'Used', 'Net'], a.itemBalance.map((b) => [b.item, b.producedPerMin, b.consumedPerMin, b.netPerMin > 0 ? `+${b.netPerMin}` : b.netPerMin]))}`);
  L.push(`\n## Production lines\n${a.lines.map((l, i) => `${i + 1}. ${l.where}: ${l.resources.join(', ') || 'no miner'} → ${l.recipes.join(' → ')} (${l.machines} machines)`).join('\n')}`);
  const next = a.progress.next.slice(0, 6);
  L.push(`\n## Next milestones you can buy\n${next.map((x) => `- ${x.active ? '**' : ''}T${x.tier} ${x.name}${x.active ? ' (active)**' : ''} — cost: ${x.cost.map((c) => `${c.amount} ${c.item} (have ${c.have})`).join(', ')} — unlocks: ${x.unlocks.join(', ')}`).join('\n') || '_none_'}`);
  return L.join('\n');
}

const fmtRates = (o) => Object.entries(o).map(([k, v]) => `${v} ${k}`).join(', ');

export function improvements(m, a, limit = 25) {
  const L = [`# Improvements — ${m.header.saveName}`];
  const active = a.progress.next.find((x) => x.active);
  if (active) {
    const missing = active.cost.filter((c) => c.have < c.amount);
    L.push(`**Active milestone: ${active.name}** — ${missing.length ? `still missing ${missing.map((c) => `${c.amount - c.have} ${c.item}`).join(', ')}` : 'you have everything, go submit it at the HUB!'}`);
  }
  if (!a.issues.length) L.push('No problems found.');
  a.issues.slice(0, limit).forEach((i, k) => {
    L.push(`\n${k + 1}. **[${i.severity}] ${i.title}**${i.where ? ` — _${i.where}_` : ''}\n   - ${i.detail}\n   - Fix: ${i.fix}`);
  });
  if (a.issues.length > limit) L.push(`\n…and ${a.issues.length - limit} more.`);
  if (a.nearbyFreeNodes.length) {
    L.push(`\n## Free nodes near your HUB (pure first)\n${a.nearbyFreeNodes.map((r) => `- ${r.resource}: ${r.nodes.map((x) => `${x.purity} ${x.where}`).join('; ')}`).join('\n')}`);
  }
  return L.join('\n');
}

export function unlocks(d) {
  const L = [`# Unlocks (tier ${d.tier}, active: ${d.activeMilestone || '—'})`];
  L.push(`- Belt: **${d.belt} (${d.beltPerMin}/min)** · Lift: ${d.lift} · Pipe: ${d.pipe || 'not unlocked'} · Miner: ${d.miner} · Power shards: ${d.powerShards}`);
  L.push(`\n## Buildings\n${d.buildings.join(', ')}`);
  L.push(`\n## Machine recipes (per machine at 100%)\n${table(['Recipe', 'Building', 'In /min', 'Out /min'], d.machineRecipes.map((r) => [r.name + (r.alternate ? ' (alt)' : ''), r.building, r.inputs.join(', '), r.outputs.join(', ')]))}`);
  L.push(`\n## Next milestones\n${d.next.map((x) => `- T${x.tier} ${x.name}${x.active ? ' (active)' : ''}: ${x.unlocks.join(', ')}`).join('\n')}`);
  return L.join('\n');
}

export function nodes(list, { resource, near }) {
  return `## ${resource || 'Resource'} nodes (nearest to ${near === 'player' ? 'player' : 'HUB'})\n${table(['Node', 'Resource', 'Type', 'Purity', 'Used', 'Distance', 'Where'], list.map((x) => [x.id, x.resource, x.type, x.purity, x.occupied ? 'yes' : 'free', `${x.distM} m`, x.where]))}`;
}

export function item(d) {
  const L = [`# ${d.item}${d.inStorage != null ? ` — you have ${d.inStorage}` : ''}`];
  L.push(`Form: ${d.form} · stack: ${d.stackSize} · sink points: ${d.sinkPoints}`);
  L.push(`\n## Made by\n${d.producedBy.map((r) => `- ${r.unlocked === false ? '🔒 ' : ''}**${r.recipe}** in ${r.building}: ${r.inputs.join(' + ')} → ${r.outputs.join(' + ')}${r.unlockedBy ? ` — unlock via ${r.unlockedBy.join(' / ')}` : ''}`).join('\n') || '_raw resource / not craftable in machines_'}`);
  L.push(`\n## Used in\n${d.usedIn.map((r) => `${r.unlocked === false ? '🔒' : ''}${r.recipe}`).join(', ') || '_nothing_'}`);
  return L.join('\n');
}

export function plan(p) {
  if (!p.ok) return `**No plan possible.** ${p.message}${p.supply?.length ? `\n\nRaw supply in reach: ${p.supply.map((s) => `${s.item} ${s.availablePerMin}/min`).join(', ')}` : ''}`;
  const L = [];
  const goal = [...p.targets.map((t) => `${t.rate}/min ${t.name}`), ...(p.maximized ? [`max ${p.maximized.name} = **${p.maximized.rate}/min**`] : [])].join(' + ');
  L.push(`# Plan: ${goal}`);
  L.push(`Using ${p.logistics.belt} (${p.logistics.beltCap}/min per belt), ${p.logistics.miner || 'no miner'}, max clock ${p.logistics.maxClockPercent}%. Power: **${p.totals.powerMW} MW**.`);
  L.push(`\n## Machines\n${table(['#', 'Recipe', 'Building', 'Qty', 'Clock', 'Inputs /min', 'Outputs /min'], p.steps.map((s) => [s.id, s.recipeName + (s.alternate ? ' (alt)' : ''), s.buildingName, s.machines, `${s.clockPercent}%${s.clockAlt ? ` (or ${s.clockAlt})` : ''}`, s.inputs.map((i) => `${i.rate} ${i.name}`).join(', '), s.outputs.map((o) => `${o.rate} ${o.name}`).join(', ')]))}`);
  L.push(`\n## Raw resources\n${p.nodes.map((x) => `- ${x.name}: ${x.note}${x.where ? ` — ${x.where}` : ''}`).join('\n') || '_none_'}`);
  L.push(`\n## Connections (belts needed at ${p.logistics.beltCap}/min)\n${p.flows.map((f) => `- ${f.from} → ${f.to}: ${f.rate}/min ${f.name}${f.lines > 1 ? ` — **${f.lines} ${f.fluid ? 'pipes' : 'belts'}**` : ''}`).join('\n')}`);
  if (p.surplus.length) L.push(`\n## Surplus\n${p.surplus.map((s) => `- ${s.rate}/min ${s.name}`).join('\n')}`);
  L.push(`\n## Build cost (machines${p.nodes.some((x) => x.kind === 'node') ? ' + miners' : ''})\n${p.totals.buildCost.map((c) => `${c.amount} ${c.name}`).join(', ')}`);
  if (p.warnings.length) L.push(`\n## Notes\n${p.warnings.map((w) => `- ${w}`).join('\n')}`);
  return L.join('\n');
}

export function design(p, layout, files) {
  const L = [plan(p)];
  const b = layout.bom;
  L.push(`\n# Layout sketch — ${layout.mode === 'foundation' ? 'foundation build' : 'ground build'}`);
  L.push(`- Area: ${layout.width} m wide; ${layout.floors.map((f) => `floor ${f.index}: ${f.length} m long (${f.usedLength} m used)${f.elevation ? ` at +${f.elevation} m` : ''}`).join('; ')}`);
  L.push(`- Splitters: ${b.splitters} · Mergers: ${b.mergers} · Belts: ${Object.entries(b.belts).map(([k, v]) => `${v} m ${k}`).join(', ')}${b.lifts ? ` · Lifts: ${b.lifts.count} × ${b.lifts.type}` : ''}${b.foundations ? ` · Foundations: ${b.foundations.count} × ${b.foundations.type}` : ''} · Power poles: ~${b.powerPoles.count} × ${b.powerPoles.type}`);
  const short = b.materials.filter((m) => m.have != null && m.have < m.amount);
  L.push(`- Materials: ${b.materials.map((m) => `${m.amount} ${m.name}`).join(', ')}${short.length ? `\n- **You are short:** ${short.map((m) => `${m.amount - m.have} ${m.name}`).join(', ')}` : ''}`);
  if (layout.warnings.length) L.push(`\n**Warnings:**\n${layout.warnings.map((w) => `- ${w}`).join('\n')}`);
  L.push(`\n## Build order\n${layout.buildSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
  L.push(`\n**Sketch:** ${files.html}\n(SVG per floor + layout.json in ${files.dir})`);
  return L.join('\n');
}

/** One-paragraph explanation of automatically chosen amounts (empty for fixed targets). */
export function goalHeader(goal) {
  if (!goal) return '';
  const list = goal.targets.map((t) => `**${t.rate}/min ${t.name}**`).join(', ');
  const blocked = goal.blocked?.length ? `\nCan't make with these nodes/unlocks: ${goal.blocked.map((b) => b.name).join(', ')}.` : '';
  if (goal.mode === 'items') return `> **Automatic amounts** — as much as your nodes allow: ${list}. The mix follows what your milestones still need (equal share for items they don't need).${blocked}\n\n`;
  const missing = goal.needs.needs.filter((n) => n.missing > 0).map((n) => `${n.missing} ${n.name}`).join(', ');
  const fastest = ` Your nodes could do it in ~${duration(goal.fastestMinutes)} with a much bigger factory (and more power).`;
  const speed = goal.limitedBy === 'power'
    ? ` Sized to run on your free power (~${goal.powerBudgetMW} MW).${fastest} Pick a finish time to plan bigger, e.g. after adding generators.`
    : goal.limitedBy === 'time'
      ? ` Sized to finish in that time${goal.wantedMinutes ? ' (you picked it)' : ''}.${fastest}`
      : goal.wantedMinutes || goal.powerBudgetMW
        ? ' That\'s as fast as these nodes allow: tick more or better nodes to go faster.'
        : ' That\'s as fast as these nodes allow.';
  const noPower = goal.noFreePower ? '\n**You have no spare power right now**: build generators first (this plan is sized for ~30 min).' : '';
  return `> **Automatic amounts** — you still need ${missing} for ${goal.needs.goals.map((g) => g.name).join(', ')}. This factory makes ${list}, which finishes all of it in **~${duration(goal.minutes)}**.${speed}${noPower}${blocked}\n\n`;
}

/** 45 → "45 min", 135 → "2.3 h" */
export const duration = (min) => (min >= 90 ? `${Math.round((min / 60) * 10) / 10} h` : `${Math.round(min)} min`);

export function needs(n) {
  const L = ['# What your next goals still need'];
  L.push(n.goals.map((g) => `- ${g.name}`).join('\n'));
  L.push(`\n${table(['Item', 'Total', 'In storage', 'Still missing'], n.needs.map((x) => [x.name, x.total, x.have, x.missing ? `**${x.missing}**` : '✓']))}`);
  return L.join('\n');
}

export function upgrades(u) {
  const L = [`# Upgrade options (now: ${u.belt}${u.nextBelt ? `; next belt: ${u.nextBelt.name} ${u.nextBelt.perMin}/min via ${u.nextBelt.unlock}` : ''}${u.nextMiner ? `; next miner: ${u.nextMiner.name} via ${u.nextMiner.unlock}` : ''})`];
  for (const x of u.extractors) {
    L.push(`\n**${x.extractor} on ${x.purity} ${x.resource}** — ${x.where} (line ${x.line}), now ~${x.nowPerMin}/min`);
    if (!x.options.length) L.push('- already at its best for your unlocks');
    for (const o of x.options) L.push(`- [${o.when}] ${o.change}: ${o.from} → **${o.to}/min**; add ${o.add}${o.cost ? `; belt cost ${o.cost} (old belt refunded)` : ''}`);
  }
  return L.join('\n');
}

export function rebuild(p, goal, c, layout, files) {
  const L = [];
  if (goal) {
    L.push(goal.mode === 'items' ? '# Rebuild plan — as much as your nodes allow' : `# Rebuild plan — finish your next milestones in ~${goal.minutes} min`);
    L.push(goalHeader(goal).trim());
  } else L.push(`# Rebuild plan — ${p.targets.map((t) => `${t.rate}/min ${t.name}`).join(' + ') || p.maximized?.name}`);
  L.push(`\n## New factory\n${table(['Recipe', 'Building', 'Qty', 'Clock'], p.steps.map((s) => [s.recipeName, s.buildingName, s.machines, `${s.clockPercent}%`]))}`);
  L.push(`Nodes: ${p.nodes.map((n) => `${n.name} — ${n.note}${n.where ? ` (${n.where})` : ''}`).join('; ')}. Power ${p.totals.powerMW} MW.`);
  L.push(`\n## Dismantle\n${c.dismantle.lines.map((l) => `- Line ${l.line} (${l.where}): ${l.recipes.join(', ') || 'miner'} — ${l.buildings} buildings, ${l.belts} belts${l.keptMiners.length ? ` (keeps ${l.keptMiners.join(', ')})` : ''}`).join('\n') || '- nothing in the chosen area'}`);
  if (c.dismantle.kept.length) L.push(`Kept: ${c.dismantle.kept.map((k) => `line ${k.line} ${k.recipes.join('/')} (${k.why})`).join('; ')}`);
  L.push(`Refund: ${c.dismantle.refund.map((x) => `${x.amount} ${x.name}`).join(', ') || 'nothing'}${c.dismantle.buffers.length ? `; items in their buffers: ${c.dismantle.buffers.map((x) => `${x.amount} ${x.name}`).join(', ')}` : ''}`);
  L.push(`\n## Materials (new build vs storage + refund)\n${table(['Item', 'Need', 'In storage', 'From dismantling', 'Short'], c.balance.map((b) => [b.name, b.need, b.have, b.fromDismantle, b.short ? `**${b.short}**` : '✓']))}`);
  L.push('_Belt amounts come from the sketch\'s routing (~1 unit per 2 m) and are on the high side; a tighter hand-built layout uses less._');
  if (c.shortages.length) L.push(`\n## Covering the shortages\n${c.shortages.map((a) => `- **${a.short} ${a.item}**: ${a.detail}`).join('\n')}`);
  L.push(`\n## Order of work\n${c.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
  L.push(`\nPower after rebuild: ${c.power.afterRebuildMW} / ${c.power.capacityMW} MW${c.power.ok ? '' : ' — **over capacity**'}`);
  L.push(`\n**Sketch:** ${files.html}`);
  void layout;
  return L.join('\n');
}

export function lines(list, tiers) {
  const L = ['# Your production lines'];
  L.push(table(['Line', 'Where', 'Makes', 'Miners', 'Machines'], list.map((l) => [l.line, l.where, l.recipes.join(', '), l.miners.join(', ') || (l.powersGrid ? 'none (power line)' : 'none'), l.machines])));
  L.push(`\nBelts: ${tiers.belts.map((b) => `${b.name} ${b.perMin}/min${b.unlocked ? ' ✓' : ` (${b.unlock})`}`).join(' · ')}`);
  L.push(`Miners: ${tiers.miners.map((x) => `${x.name}${x.unlocked ? ' ✓' : ` (${x.unlock})`}`).join(' · ')}`);
  return L.join('\n');
}

export function lineUpgrade(u) {
  const L = [`# Upgrade line ${u.line} (${u.where}) → ${u.tiers.belt}${u.tiers.miner ? ` + ${u.tiers.miner}` : ''}`];
  L.push(`\n## Output\n${table(['Item', 'Now /min', 'After /min'], u.products.map((p) => [p.name, p.now, `**${p.after}**`]))}`);
  L.push(`\n## Machines\n${table(['Recipe', 'Building', 'Now', 'After', 'Change'], u.machines.map((d) => [d.recipe, d.building, d.now, d.after, d.after > d.now ? `**+${d.after - d.now}**` : d.after < d.now ? `${d.after - d.now} (spare)` : '—']))}`);
  if (u.minerSwaps.length) L.push(`\n## Miners to swap\n${u.minerSwaps.map((s) => `- ${s.from} → **${s.to}** on ${s.purity} ${s.resource} (${s.where}): ${s.before} → ${s.after}/min`).join('\n')}`);
  L.push(`\n## Belts to swap (${u.tiers.belt}, ${u.tiers.beltPerMin}/min)\n${u.beltSwaps.map((s) => `- ${s.from} → ${s.to} (${s.where}): ${s.metres} m, now ${s.nowCap}/min → will carry **${s.newFlow}/min**${s.needsSecondBelt ? ' — needs a second belt' : ''}`).join('\n') || '- none — the current belts already carry enough'}`);
  L.push(`\n## Cost (after refunds of what you replace)\n${table(['Item', 'Need', 'Refund', 'In storage', 'Short'], u.cost.map((c) => [c.name, c.need, c.refund, c.have, c.short ? `**${c.short}**` : '✓']))}`);
  L.push(`\nPower for this line: ${u.power.nowMW} → **${u.power.afterMW} MW**`);
  L.push(`\n## Steps\n${u.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
  return L.join('\n');
}

export function planCompare(c) {
  const L = [`# Same plan, better tiers: ${c.labels.now} → ${c.labels.after}`];
  if (c.locked?.length) L.push(`_Not unlocked yet: ${c.locked.join('; ')} — this shows what you gain once you do._`);
  if (c.minutes) L.push(`\nTime to finish the milestones: ${c.minutes.now} min → **${c.minutes.after} min**`);
  L.push(`\n## Output /min\n${table(['Item', 'Now', 'With upgrade'], c.outputs.map((o) => [o.name, o.now, `**${o.after}**`]))}`);
  L.push(`\n## Machines\n${table(['Recipe', 'Building', 'Now', 'With upgrade', 'Change'], c.machines.map((x) => [x.recipe, x.building, x.now, x.after, x.after > x.now ? `**+${x.after - x.now}**` : x.after < x.now ? `${x.after - x.now}` : '—']))}`);
  L.push(`\nBelt lines between steps: ${c.beltLines.now} → **${c.beltLines.after}** · Power: ${c.power.now} → **${c.power.after} MW**`);
  L.push(`\n## Raw supply\n- Now: ${c.raw.now.join('; ')}\n- With upgrade: ${c.raw.after.join('; ')}`);
  const swapLines = c.swaps.map((s) => `   - ${s.from} → ${s.to} ${s.item}: ${s.rateNow}/min on ${s.linesNow} belt(s) now → **${s.rate}/min on ${s.linesAfter} upgraded belt(s)**`).join('\n');
  L.push(`\n## Upgrade path\n1. Build the current version now.\n2. When the new tier is unlocked, upgrade the belts on these connections (build the new belt over the old one — the old one is refunded):\n${swapLines || '   - none'}\n3. Add the machines marked + above to the existing rows (extend each manifold with a splitter + merger) and set the new clocks.\n4. Once built, use **Upgrade line** on it for the exact belts, lengths and costs.`);
  return L.join('\n');
}

export function blueprints(b) {
  const L = ['\n# In-game blueprints'];
  for (const x of b.list) {
    const v = x.verify;
    L.push(`- **${x.name}** (${x.sizeM.x} × ${x.sizeM.y} m): ${x.stats.machines} machines with recipes + clocks set, ${x.stats.attachments} splitters/mergers, ${x.stats.belts} belts (${x.stats.beltMetres} m) — ${v.ok ? `checked: ${v.connections} belt connections all valid` : `**failed check:** ${v.problems.join('; ')}`}\n  ${x.sbp}`);
    for (const w of x.warnings) L.push(`  - ${w}`);
  }
  L.push('- Not included: foundations, power poles/lines, lifts, miners and pipes (place those yourself; the sketch shows where).');
  for (const n of b.notes) L.push(`- ${n}`);
  if (b.installed) L.push(`- Installed into **${b.installFolder}** — open the build menu → Blueprints in that session.`);
  else L.push(`- To use: copy the .sbp + .sbpcfg into \`%LOCALAPPDATA%\\FactoryGame\\Saved\\SaveGames\\blueprints\\<session name>\\\`${b.sessions.length ? ` (existing: ${b.sessions.join(', ')})` : ''}, or re-run with the install option. Try it in a test save first.`);
  return L.join('\n');
}

export function context(m, a) {
  return [
    `# My Satisfactory factory (auto-generated from save "${m.header.saveName}")`,
    'Use this as ground truth. Only suggest recipes/buildings I have unlocked; belts max at the speed listed.',
    status(m, a),
    improvements(m, a, 15).replace(/^# .*\n/, '\n# Issues found\n'),
  ].join('\n');
}

export function savedList(list) {
  if (!list.length) return 'Nothing saved yet. Add `--save-as "a name"` to plan / design / rebuild / blueprint (or press Save in the web UI).';
  return `# Saved plans\n\n${table(['Name', 'Kind', 'Saved', 'From save', 'Report'], list.map((x) => [x.name, x.kind, new Date(x.created).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }), x.save?.saveName || '—', x.report]))}`;
}
