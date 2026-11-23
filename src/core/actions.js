// High-level actions shared by the CLI, MCP server and web UI. Each returns { data, markdown }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportBlueprints } from '../blueprint/build.js';
import { milestoneNeeds, planForGoals } from '../planner/goals.js';
import { productionGroups, rebuildCheck } from '../rebuild/rebuild.js';
import { guidePage, renderGuide } from '../rebuild/guide.js';
import { upgradeOptions } from '../analysis/upgrade.js';
import { comparePlans, listLines, tierChoices, upgradeLine } from '../upgrade/upgrade.js';
import { verifyBlueprint } from '../blueprint/verify.js';
import { OUTPUT_DIR, ensureDir, listSaves } from '../config.js';
import { itemName, recipeRates, resolveItem } from '../gamedata/loader.js';
// (resolveItem / itemName are also used by resolvePlan for automatic amounts)
import { analyze, nextUnlocks } from '../analysis/analyze.js';
import { planProduction } from '../planner/plan.js';
import { generateLayout } from '../layout/layout.js';
import { renderFloorSvg, renderHtml, itemColors } from '../layout/render.js';
import { describeOffset } from '../save/model.js';
import { currentModel, gameData, loadSave } from './session.js';
import * as fmt from './format.js';

export function savesAction() {
  const saves = listSaves();
  return { data: saves, markdown: fmt.saves(saves) };
}

export function loadAction(query) {
  const m = loadSave(query, { force: true });
  const a = analyze(m, gameData());
  return { data: { file: m.file, header: m.header }, markdown: fmt.loaded(m, a) };
}

export function statusAction() {
  const m = currentModel();
  const a = analyze(m, gameData());
  const { issues, ...rest } = a;
  return { data: rest, markdown: fmt.status(m, a) };
}

export function improveAction({ limit = 25 } = {}) {
  const m = currentModel();
  const a = analyze(m, gameData());
  return { data: { issues: a.issues, next: a.progress.next, nearbyFreeNodes: a.nearbyFreeNodes }, markdown: fmt.improvements(m, a, limit) };
}

export function unlocksAction() {
  const m = currentModel();
  const gd = gameData();
  const u = m.unlocks;
  const data = {
    tier: u.maxMilestoneTier,
    activeMilestone: gd.schematics[u.activeMilestone]?.name || null,
    belt: u.belt?.name, beltPerMin: u.belt?.itemsPerMin,
    lift: u.lift?.name, pipe: u.pipe?.name || null, miner: u.miner?.name,
    buildings: u.buildings.map((b) => gd.buildings[b]?.name).filter(Boolean).sort(),
    machineRecipes: u.machineRecipes.map((r) => gd.recipes[r]).filter(Boolean).map((r) => ({ name: r.name, alternate: r.alternate, building: gd.buildings[recipeRates(gd, r).building]?.name, inputs: recipeRates(gd, r).inputs.map((i) => `${itemName(gd, i.item)} ${round(i.rate)}`), outputs: recipeRates(gd, r).outputs.map((o) => `${itemName(gd, o.item)} ${round(o.rate)}`) })),
    next: nextUnlocks(m, gd),
    powerShards: m.powerShards,
  };
  return { data, markdown: fmt.unlocks(data) };
}

export function nodesAction({ resource, purity, onlyFree = true, limit = 15, near = 'hub', maxDistance } = {}) {
  const m = currentModel();
  const gd = gameData();
  const res = resource ? resolveItem(gd, resource) : null;
  if (resource && !res) throw new Error(`Unknown resource "${resource}"`);
  const origin = near === 'player' ? m.playerPos : near && typeof near === 'object' ? near : m.hubPos;
  const list = m.nodes
    .filter((n) => n.resource && (!res || n.resource === res) && (!purity || n.purity === purity) && (!onlyFree || !n.occupiedBy) && n.type !== 'wellCore')
    .map((n) => ({ id: n.short, resource: itemName(gd, n.resource), type: n.type, purity: n.purity, occupied: !!n.occupiedBy, distM: origin ? Math.round(Math.hypot(n.pos.x - origin.x, n.pos.y - origin.y)) : null, where: describeOffset(m.hubPos, n.pos), pos: { x: Math.round(n.pos.x), y: Math.round(n.pos.y), z: Math.round(n.pos.z) } }))
    .filter((n) => !maxDistance || n.distM <= maxDistance)
    .sort((a, b) => a.distM - b.distM)
    .slice(0, limit);
  return { data: list, markdown: fmt.nodes(list, { resource: res && itemName(gd, res), near }) };
}

export function itemAction(query) {
  const gd = gameData();
  const id = resolveItem(gd, query);
  if (!id) throw new Error(`Unknown item "${query}"`);
  let m = null;
  try { m = currentModel(); } catch { /* no save */ }
  const has = (r) => (m ? m.unlocks.hasRecipe(r) : null);
  const unlockedBy = (rid) => Object.values(gd.schematics).filter((s) => s.unlockRecipes.includes(rid)).map((s) => `${s.name} (${s.type}${s.tier ? ` T${s.tier}` : ''})`);
  const mk = (rid) => {
    const r = gd.recipes[rid];
    const rr = recipeRates(gd, r);
    return { recipe: r.name, alternate: r.alternate, unlocked: has(rid), building: gd.buildings[rr.building]?.name, inputs: rr.inputs.map((i) => `${itemName(gd, i.item)} ${round(i.rate)}/min`), outputs: rr.outputs.map((o) => `${itemName(gd, o.item)} ${round(o.rate)}/min`), unlockedBy: has(rid) ? undefined : unlockedBy(rid) };
  };
  const data = {
    item: itemName(gd, id),
    id,
    form: gd.items[id].form,
    stackSize: gd.items[id].stackSize,
    sinkPoints: gd.items[id].sinkPoints,
    producedBy: (gd.producers[id] || []).map(mk),
    usedIn: (gd.consumers[id] || []).map((r) => ({ recipe: gd.recipes[r].name, unlocked: has(r) })),
    inStorage: m ? Math.floor(m.inventoryTotals[id] || 0) : null,
  };
  return { data, markdown: fmt.item(data) };
}

/**
 * Turns a request into a plan. request.goal:
 *  'targets'    fixed rates (default when targets with a rate, or maximize, are given)
 *  'milestones' automatic: everything the milestones you can buy now (+ next Space Elevator phase) still need
 *  'active'     automatic: only the active milestone
 *  'items'      automatic: request.autoItems (or targets given without a rate) — as much as the nodes allow,
 *               mixed in the ratio your milestones still need them (equal mix for items they don't need)
 * Returns { plan, goal } or { error: {data, markdown} }.
 */
function resolvePlan(gd, m, request) {
  const fixed = (request.targets || []).filter((t) => Number(t.rate) > 0);
  const autoItems = [...(request.autoItems || []), ...(request.targets || []).filter((t) => t.item && !(Number(t.rate) > 0)).map((t) => t.item)];
  let mode = request.goal;
  if (!mode || mode === 'targets') mode = autoItems.length ? 'items' : fixed.length || request.maximize ? 'targets' : 'milestones';
  if (mode === 'items' && !autoItems.length && !fixed.length) {
    return { error: { data: { ok: false }, markdown: '**No items picked.** Click **+ add item** and type what you want (e.g. Iron Plate) — leave the amount blank and the tool decides how much. Or choose **“Automatic: whatever my next milestones need”**, then you don\'t have to pick anything.' } };
  }
  if (mode === 'targets' && !fixed.length && !request.maximize) {
    return { error: { data: { ok: false }, markdown: '**No amounts given.** Add an item with how many per minute you want, or switch **How much?** to one of the automatic options.' } };
  }
  if (mode === 'targets') return { plan: planProduction(gd, m, { ...request, targets: fixed }), goal: null };
  if (!m) throw new Error('Automatic amounts need a loaded save (they are based on what you have and what you still need).');
  let needsInfo;
  if (mode === 'items') {
    const ms = milestoneNeeds(gd, m, { scope: 'tier' });
    const missingOf = Object.fromEntries(ms.needs.map((n) => [n.item, n.missing]));
    const ids = autoItems.map((q) => { const id = resolveItem(gd, q); if (!id) throw new Error(`Unknown item "${q}"`); return id; });
    const known = ids.map((id) => missingOf[id]).filter((x) => x > 0);
    const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 100;
    needsInfo = { goals: [], needs: [...new Set(ids)].map((id) => ({ item: id, name: itemName(gd, id), total: 0, have: 0, missing: missingOf[id] > 0 ? missingOf[id] : fallback })) };
  } else {
    needsInfo = milestoneNeeds(gd, m, { scope: mode === 'active' ? 'active' : request.goalScope || 'tier' });
  }
  const g = planForGoals(gd, m, { ...request, targets: fixed }, needsInfo);
  if (g.nothingNeeded) return { error: { data: g, markdown: `Nothing is missing: your storage already has everything ${mode === 'active' ? 'your active milestone' : 'the milestones you can buy now'} need${g.needs?.goals?.length ? ` (${g.needs.goals.map((x) => x.name).join(', ')})` : ''}. Go submit them at the HUB, or pick items / give amounts instead.` } };
  if (!g.ok) return { error: { data: g, markdown: `**No plan possible.** ${g.message}` } };
  return { plan: g.plan, goal: { mode, minutes: g.minutes, targets: g.targets, needs: g.needs, blocked: g.blocked } };
}

export function planAction(request) {
  let m = null;
  try { m = currentModel(); } catch (e) { if (!request.allowLocked) throw e; }
  const r = resolvePlan(gameData(), m, request);
  if (r.error) return r.error;
  return { data: { ...r.plan, goal: r.goal }, markdown: fmt.goalHeader(r.goal) + fmt.plan(r.plan) };
}

/** Plan + layout + files on disk. area: { mode, width, length, unit, floors, foundationThickness, blueprint, installSession } */
export function designAction(request, area = {}) {
  const gd = gameData();
  let m = null;
  try { m = currentModel(); } catch (e) { if (!request.allowLocked) throw e; }
  const r = resolvePlan(gd, m, request);
  if (r.error) return r.error;
  const { plan, goal } = r;
  if (!plan.ok) return { data: plan, markdown: fmt.plan(plan) };
  const layout = generateLayout(gd, plan, { ...area, title: area.title || request.title || goalTitle(goal) }, m);
  const files = writeDesign(layout, plan, m);
  let blueprints = null;
  if (area.blueprint || area.installSession) blueprints = blueprintsFor(gd, plan, layout, files.dir, m, area.installSession);
  return { data: { plan, goal, layout: stripElements(layout), files, blueprints }, markdown: fmt.goalHeader(goal) + fmt.design(plan, layout, files) + (blueprints ? fmt.blueprints(blueprints) : '') };
}

const goalTitle = (goal) => (!goal ? undefined : goal.mode === 'items' ? `Auto mix: ${goal.targets.map((t) => t.name).join(', ')}`.slice(0, 60) : `Milestone factory (${goal.minutes} min to finish)`);

/** Write one blueprint per floor, re-read each to verify it, optionally copy into the game's blueprint folder. */
function blueprintsFor(gd, plan, layout, dir, m, installSession) {
  const bpDir = ensureDir(path.join(dir, 'blueprints'));
  const list = exportBlueprints(gd, plan, layout, bpDir, { baseName: layout.title.replace(/ factory$/, '') });
  for (const b of list) b.verify = verifyBlueprint(b.sbp);
  const notes = [];
  if (m && !m.unlocks.buildings.includes('Build_BlueprintDesigner_C')) {
    notes.push('This save has not unlocked blueprints yet (milestone "FICSIT Blueprints", Tier 4). Until then, build from the sketch — the blueprint files are ready for later or for another save.');
  }
  let installed = null;
  if (installSession) {
    // a session name is a single folder name: no separators, no "..", no drive letters
    const name = String(installSession).trim();
    if (!name || name.length > 100 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || name === '.' || name === '..' || /^\.+$/.test(name)) {
      throw new Error(`"${installSession}" is not a valid session name (use the save's session name, e.g. "New Game").`);
    }
    const root = path.resolve(gameBlueprintRoot());
    const target = path.resolve(root, name);
    if (path.dirname(target) !== root) throw new Error('Blueprint folder must be directly inside the game\'s blueprints folder.');
    ensureDir(target);
    installed = [];
    for (const b of list) {
      if (!b.verify.ok) continue;
      for (const f of [b.sbp, b.sbpcfg]) {
        const to = path.join(target, path.basename(f));
        if (fs.existsSync(to)) { notes.push(`Skipped ${path.basename(f)}: a blueprint with that name already exists (not overwritten).`); continue; }
        fs.copyFileSync(f, to);
        installed.push(to);
      }
    }
  }
  return { dir: bpDir, list, notes, installed, installFolder: installSession ? path.join(gameBlueprintRoot(), installSession) : null, sessions: blueprintSessions() };
}

function gameBlueprintRoot() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'FactoryGame', 'Saved', 'SaveGames', 'blueprints');
}
/** Existing blueprint folders (one per session name). */
export function blueprintSessions() {
  try { return fs.readdirSync(gameBlueprintRoot(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
}

/** What the next milestones / space elevator still need, minus your storage. */
export function needsAction({ scope = 'tier', elevator = true } = {}) {
  const m = currentModel();
  const n = milestoneNeeds(gameData(), m, { scope, elevator });
  return { data: n, markdown: fmt.needs(n) };
}

/** Upgrade options for your existing miners/lines (now and after the next unlocks). */
export function upgradesAction() {
  const m = currentModel();
  const u = upgradeOptions(gameData(), m);
  return { data: u, markdown: fmt.upgrades(u) };
}

/**
 * Rebuild planner: plan a new factory (fixed targets, a maximize item, or goal "milestones"), lay it out, then check
 * what dismantling the old lines returns vs what the new factory costs, and give the tear-down / build order.
 * request: planner options (+ goal, goalScope); area: layout options (+ blueprint); scope: { scope, radius, includePower }
 */
export function rebuildAction(request = {}, area = {}, scope = {}) {
  const gd = gameData();
  const m = currentModel();
  const req = { rebuild: true, ...request };
  const r = resolvePlan(gd, m, req);
  if (r.error) return r.error;
  const { plan, goal } = r;
  if (!plan.ok) return { data: plan, markdown: fmt.plan(plan) };
  const title = area.title || goalTitle(goal);
  const layout = generateLayout(gd, plan, { mode: 'foundation', ...area, title }, m);
  const files = writeDesign(layout, plan, m);
  const check = rebuildCheck(gd, m, { plan, layout }, { ...scope, request: req });
  let blueprints = null;
  if (area.blueprint || area.installSession) blueprints = blueprintsFor(gd, plan, layout, files.dir, m, area.installSession);
  fs.writeFileSync(path.join(files.dir, 'rebuild.json'), JSON.stringify({ goal: goal && { minutes: goal.minutes, targets: goal.targets, blocked: goal.blocked }, check }, null, 2));
  // visual order of work: one card + small diagram per step
  const guideOpts = { goalMinutes: goal && goal.mode !== 'items' ? goal.minutes : null, title: `Rebuild guide — ${layout.title}` };
  const guideFile = path.join(files.dir, 'rebuild-guide.html');
  fs.writeFileSync(guideFile, guidePage(check.timeline, { ...guideOpts, sketchUrl: 'index.html' }));
  files.guide = guideFile;
  const guideHtml = renderGuide(check.timeline, guideOpts);
  return {
    data: { plan, goal: goal && { minutes: goal.minutes, targets: goal.targets, needs: goal.needs, blocked: goal.blocked }, check, files, blueprints, guideHtml },
    markdown: fmt.rebuild(plan, goal, check, layout, files) + `\n**Visual step-by-step guide:** ${guideFile}` + (blueprints ? fmt.blueprints(blueprints) : ''),
  };
}

/** Everything the node map needs: every node (metres), HUB, player, your lines and miners. */
export function mapAction() {
  const gd = gameData();
  const m = currentModel();
  const hub = m.hubPos || m.playerPos;
  const nodes = m.nodes.filter((n) => n.type !== 'wellCore').map((n) => ({
    id: n.short,
    resource: n.resource ? itemName(gd, n.resource) : n.type === 'geyser' ? 'Geyser' : 'Unknown',
    type: n.type,
    purity: n.purity,
    x: Math.round(n.pos.x),
    y: Math.round(n.pos.y),
    used: !!n.occupiedBy,
    miner: n.occupiedBy ? m.entities.get(n.occupiedBy)?.name : null,
    dist: hub ? Math.round(Math.hypot(n.pos.x - hub.x, n.pos.y - hub.y)) : null,
    where: describeOffset(m.hubPos, n.pos),
  }));
  const lines = productionGroups(m).map((g) => ({
    line: g.index,
    x: Math.round(g.center.x),
    y: Math.round(g.center.y),
    recipes: g.recipes.map((r) => gd.recipes[r]?.name || r),
    where: describeOffset(m.hubPos, { ...g.center, z: 0 }),
  }));
  const pt = (p) => (p ? { x: Math.round(p.x), y: Math.round(p.y) } : null);
  const counts = {};
  for (const n of nodes) counts[n.resource] = (counts[n.resource] || 0) + 1;
  return { data: { nodes, hub: pt(m.hubPos), player: pt(m.playerPos), lines, counts }, markdown: `${nodes.length} nodes on the map.` };
}

/** Existing production lines + belt/miner tiers (with unlock status) for the upgrade pickers. */
export function linesAction() {
  const gd = gameData();
  const m = currentModel();
  const lines = listLines(gd, m);
  const tiers = tierChoices(gd, m);
  return { data: { lines, tiers }, markdown: fmt.lines(lines, tiers) };
}

/** Upgrade one existing line to better belts / miners. */
export function upgradeLineAction({ line, beltTier, minerTier } = {}) {
  const gd = gameData();
  const m = currentModel();
  const u = upgradeLine(gd, m, { line, beltTier, minerTier });
  const { plan, ...data } = u;
  return { data, markdown: fmt.lineUpgrade(u) };
}

/** The same plan at your current tiers vs. better belts / miners, and the upgrade path between them. */
export function upgradePlanAction(request = {}, { beltTier, minerTier } = {}) {
  const gd = gameData();
  const m = currentModel();
  const tiers = tierChoices(gd, m);
  const bt = Number(beltTier) || Math.min(tiers.current.belt + 1, 6);
  const mt = Number(minerTier) || tiers.current.miner;
  const base = resolvePlan(gd, m, request);
  if (base.error) return base.error;
  if (!base.plan.ok) return { data: base.plan, markdown: fmt.plan(base.plan) };
  const up = resolvePlan(gd, m, { ...request, beltTier: bt, minerTier: mt });
  if (up.error) return up.error;
  if (!up.plan.ok) return { data: up.plan, markdown: fmt.plan(up.plan) };
  const belt = tiers.belts.find((b) => b.tier === bt);
  const miner = tiers.miners.find((x) => x.tier === mt);
  const cmp = comparePlans(gd, base, up, { now: `${m.unlocks.belt?.name} + ${m.unlocks.miner?.name}`, after: `${belt.name} + ${miner.name}` });
  cmp.locked = [belt, miner].filter((x) => !x.unlocked).map((x) => `${x.name} ← ${x.unlock}`);
  return { data: cmp, markdown: fmt.planCompare(cmp) };
}

export function contextAction() {
  const m = currentModel();
  const gd = gameData();
  const a = analyze(m, gd);
  return { data: a, markdown: fmt.context(m, a) };
}

function writeDesign(layout, plan, m) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const slug = layout.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'design';
  const dir = ensureDir(path.join(OUTPUT_DIR, `${stamp}-${slug}`));
  const colors = itemColors(layout);
  const files = { dir, html: path.join(dir, 'index.html'), json: path.join(dir, 'layout.json'), svgs: [] };
  fs.writeFileSync(files.html, renderHtml(layout, plan, { saveName: m?.header.saveName }));
  fs.writeFileSync(files.json, JSON.stringify({ plan, layout }, null, 2));
  layout.floors.forEach((f, i) => {
    const p = path.join(dir, `floor-${f.index}.svg`);
    fs.writeFileSync(p, renderFloorSvg(layout, i, colors));
    files.svgs.push(p);
  });
  return files;
}

function stripElements(layout) {
  const { elements, ...rest } = layout;
  return rest;
}

const round = (x) => Math.round(x * 100) / 100;
