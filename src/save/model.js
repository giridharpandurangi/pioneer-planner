// Turns a parsed .sav into a factory model: unlocks, buildings, belt graph, resource nodes, power, inventories.
import fs from 'node:fs';
import path from 'node:path';
import parserPkg from '@etothepii/satisfactory-file-parser';
import { machinePower, recipeRates } from '../gamedata/loader.js';
import { CACHE_DIR, ensureDir } from '../config.js';

const NODE_CACHE = path.join(CACHE_DIR, 'nodes.json');

/**
 * Newer saves store each node's resource + purity; older ones don't. Node ids are identical on every map,
 * so remember the table from any save that has it and fill it in for saves that don't.
 */
function syncNodeCache(nodes) {
  const known = nodes.filter((n) => n.resource && n.type !== 'geyser');
  if (known.length > nodes.length * 0.5) {
    try {
      ensureDir(CACHE_DIR);
      fs.writeFileSync(NODE_CACHE, JSON.stringify(Object.fromEntries(known.map((n) => [n.id, { resource: n.resource, purity: n.purity }]))));
    } catch { /* cache is optional */ }
    return { source: 'save' };
  }
  if (!fs.existsSync(NODE_CACHE)) return { source: 'missing' };
  try {
    const table = JSON.parse(fs.readFileSync(NODE_CACHE, 'utf8'));
    let filled = 0;
    for (const n of nodes) {
      const t = table[n.id];
      if (t && !n.resource) { n.resource = t.resource; n.purity = t.purity; filled++; }
    }
    return { source: filled ? 'cache' : 'missing' };
  } catch { return { source: 'missing' }; }
}

const { Parser } = parserPkg;
const CM = 0.01; // Unreal units (cm) -> metres
const NICE_NAMES = { Build_GeneratorIntegratedBiomass_C: 'HUB Biomass Burner', Build_StorageIntegrated_C: 'HUB Storage', Build_HubTerminal_C: 'HUB Terminal', Build_WorkBenchIntegrated_C: 'HUB Craft Bench', BUILD_Potty_mk1_C: 'Potty' };
const short = (p) => (p || '').split('.').pop();
const PURITY = { RP_Inpure: 'impure', RP_Impure: 'impure', RP_Normal: 'normal', RP_Pure: 'pure' };
export const PURITY_MULT = { impure: 0.5, normal: 1, pure: 2, unknown: 1 };

function pv(o, name) {
  const p = o?.properties?.[name];
  if (p === undefined) return undefined;
  if (Array.isArray(p.values)) return p.values;
  return p.value;
}
const ref = (o, name) => pv(o, name)?.pathName;

export function parseSaveFile(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return Parser.ParseSave(path.basename(file, '.sav'), ab);
}

const toM = (t) => (t ? { x: t.x * CM, y: t.y * CM, z: t.z * CM } : { x: 0, y: 0, z: 0 });
function yawDeg(q) {
  if (!q) return 0;
  const { x, y, z, w } = q;
  return Math.round((Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * 180) / Math.PI);
}

function readInventory(inv, gd) {
  const out = {};
  for (const s of pv(inv, 'mInventoryStacks') || []) {
    const item = short(s.properties?.Item?.value?.itemReference?.pathName);
    const n = s.properties?.NumItems?.value || 0;
    if (!item || !n) continue;
    const fluid = gd.items[item] && gd.items[item].form !== 'RF_SOLID';
    out[item] = (out[item] || 0) + (fluid ? n / 1000 : n);
  }
  return out;
}

function splineLength(o) {
  const pts = (pv(o, 'mSplineData') || []).map((p) => p.properties?.Location?.value).filter(Boolean);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
  return len * CM;
}

function portDir(category, portName) {
  if (category === 'belt' || category === 'lift') return /Any0$/.test(portName) ? 'in' : /Any1$/.test(portName) ? 'out' : 'any';
  if (/input/i.test(portName)) return 'in';
  if (/output/i.test(portName)) return 'out';
  return 'any';
}

/** Compass direction + distance from a reference point. In Satisfactory +X is east and +Y is south. */
export function describeOffset(from, to) {
  if (!from || !to) return '';
  const dx = to.x - from.x;
  const dyNorth = -(to.y - from.y);
  const dist = Math.hypot(dx, dyNorth);
  if (dist < 15) return 'next to the HUB';
  const dirs = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
  const ang = (Math.atan2(dyNorth, dx) * 180) / Math.PI;
  const d = dirs[(Math.round(ang / 45) + 8) % 8];
  return `${Math.round(dist)} m ${d} of HUB`;
}

export function buildModel(save, gd, file) {
  const objs = Object.values(save.levels).flatMap((l) => l.objects);
  const byName = new Map(objs.map((o) => [o.instanceName, o]));
  const h = save.header;

  // ---------- unlocks ----------
  const schemMgr = objs.find((o) => /SchematicManager/.test(o.typePath));
  const purchased = (pv(schemMgr, 'mPurchasedSchematics') || []).map((v) => short(v.pathName));
  const recipeMgr = objs.find((o) => o.typePath.endsWith('FGRecipeManager'));
  let availableRecipes = (pv(recipeMgr, 'mAvailableRecipes') || []).map((v) => short(v.pathName));
  if (!availableRecipes.length) {
    availableRecipes = [...new Set(purchased.flatMap((s) => gd.schematics[s]?.unlockRecipes || []))];
  }
  const recipeSet = new Set(availableRecipes);
  const unlockedBuildings = new Set(availableRecipes.map((r) => gd.recipes[r]?.building).filter(Boolean));
  const best = (list) => list.filter((b) => unlockedBuildings.has(b.id)).sort((a, b) => b.tier - a.tier)[0] || null;
  const miners = Object.values(gd.buildings).filter((b) => b.category === 'extractor' && /Miner/.test(b.id));
  const phasePath = ref(objs.find((o) => /GamePhaseManager/.test(o.typePath)), 'mCurrentGamePhase');
  const phaseNum = Number((short(phasePath).match(/Phase_(\d+)/) || [])[1] ?? 0);
  const milestoneTiers = purchased.map((s) => gd.schematics[s]).filter((s) => s && s.type === 'Milestone').map((s) => s.tier);
  const activeMilestone = short(ref(schemMgr, 'mActiveSchematic')) || null;

  const unlocks = {
    purchasedSchematics: purchased,
    recipes: availableRecipes,
    machineRecipes: availableRecipes.filter((r) => gd.recipes[r]?.kind === 'machine'),
    alternates: availableRecipes.filter((r) => gd.recipes[r]?.alternate && gd.recipes[r]?.kind === 'machine'),
    buildings: [...unlockedBuildings],
    maxMilestoneTier: milestoneTiers.length ? Math.max(...milestoneTiers) : 0,
    accessibleTier: Math.min(9, 2 + 2 * phaseNum),
    gamePhase: short(phasePath) || null,
    gamePhaseNumber: phaseNum,
    activeMilestone,
    belt: best(gd.beltTiers),
    lift: best(gd.liftTiers),
    pipe: best(gd.pipeTiers),
    miner: best(miners),
    has: (id) => unlockedBuildings.has(id),
    hasRecipe: (id) => recipeSet.has(id),
  };

  // ---------- entities & ports ----------
  const entities = new Map();
  for (const o of objs) {
    if (o.type !== 'SaveEntity' || !o.typePath.includes('/Buildable/')) continue;
    const cls = short(o.typePath);
    const b = gd.buildings[cls];
    let category = b?.category;
    if (cls === 'Build_GeneratorIntegratedBiomass_C') category = 'generator';
    if (cls === 'Build_StorageIntegrated_C') category = 'storage';
    const e = {
      id: o.instanceName,
      cls,
      name: b?.name || NICE_NAMES[cls] || cls.replace(/^Build_|_C$/g, ''),
      category: category || (/Conveyor(Belt|Lift)/.test(cls) ? (cls.includes('Lift') ? 'lift' : 'belt') : 'other'),
      pos: toM(o.transform?.translation),
      yaw: yawDeg(o.transform?.rotation),
      ports: [],
    };
    for (const c of o.components || []) {
      const co = byName.get(c.pathName);
      if (!co || !/FactoryConnection|PipeConnection/.test(co.typePath)) continue;
      const pname = short(c.pathName);
      const connected = ref(co, 'mConnectedComponent');
      e.ports.push({
        name: pname,
        kind: /Pipe/.test(co.typePath) ? 'pipe' : 'belt',
        dir: portDir(e.category, pname),
        connectedComponent: connected || null,
        connectedEntity: connected ? byName.get(connected)?.parentEntityName || connected.replace(/\.[^.]+$/, '') : null,
      });
    }
    if (e.category === 'belt' || e.category === 'lift') {
      e.tier = b?.tier ?? Number((cls.match(/Mk(\d)/) || [])[1] || 1);
      e.capacity = b?.itemsPerMin ?? 60;
      e.length = e.category === 'belt' ? splineLength(o) : Math.abs(pv(o, 'mTopTransform')?.Translation?.z || 0) * CM;
    }
    if (e.category === 'pipe') e.length = splineLength(o);
    if (e.category === 'manufacturer' || e.category === 'extractor' || e.category === 'generator') {
      e.clock = pv(o, 'mCurrentPotential') ?? 1;
      e.boost = pv(o, 'mCurrentProductionBoost') ?? 1;
      const pd = pv(o, 'mLastProductivityMeasurementProduceDuration');
      const md = pv(o, 'mLastProductivityMeasurementDuration');
      e.productivity = md > 0 && pd !== undefined ? Math.min(1, pd / md) : null;
      e.isProducing = pv(o, 'mIsProducing') ?? null;
    }
    if (e.category === 'manufacturer') {
      e.recipe = short(ref(o, 'mCurrentRecipe')) || null;
      e.inputInv = readInventory(byName.get(ref(o, 'mInputInventory')), gd);
      e.outputInv = readInventory(byName.get(ref(o, 'mOutputInventory')), gd);
      const r = e.recipe && gd.recipes[e.recipe];
      if (r) {
        const rates = recipeRates(gd, r);
        const k = e.clock * e.boost;
        e.rates = {
          inputs: rates.inputs.map((x) => ({ item: x.item, rate: x.rate * e.clock })),
          outputs: rates.outputs.map((x) => ({ item: x.item, rate: x.rate * k })),
        };
      }
      e.powerMW = machinePower(gd, cls, r, e.clock) * e.boost * e.boost;
    }
    if (e.category === 'extractor') {
      e.node = ref(o, 'mExtractableResource') || null;
      e.outputInv = readInventory(byName.get(ref(o, 'mOutputInventory')), gd);
      e.powerMW = machinePower(gd, cls, null, e.clock);
    }
    if (e.category === 'generator') {
      e.fuelInv = readInventory(byName.get(ref(o, 'mFuelInventory')), gd);
      e.fuelClass = short(ref(o, 'mCurrentFuelClass')) || null;
      const pinfo = byName.get(ref(o, 'mPowerInfo'));
      e.capacityMW = pv(pinfo, 'mDynamicProductionCapacity') ?? (b?.powerProduction ?? 30) * e.clock;
      e.baseMW = b?.powerProduction ?? (e.capacityMW || 20);
    }
    if (e.category === 'storage') e.storageInv = readInventory(byName.get(ref(o, 'mStorageInventory')), gd);
    entities.set(e.id, e);
  }

  // ---------- belt graph: collapse belt/lift chains into logical links ----------
  const isConveyor = (e) => e && (e.category === 'belt' || e.category === 'lift');
  const outEdges = (e) => e.ports.filter((p) => p.kind === 'belt' && p.dir === 'out');
  const links = [];
  for (const e of entities.values()) {
    if (isConveyor(e)) continue;
    for (const p of outEdges(e)) {
      const link = { from: e.id, fromPort: p.name, to: null, toPort: null, conveyors: [], capacity: Infinity, minTier: 9, lengthM: 0, lifts: 0, dangling: false };
      let cur = p.connectedEntity ? entities.get(p.connectedEntity) : null;
      let curComp = p.connectedComponent;
      const seen = new Set();
      while (cur && isConveyor(cur) && !seen.has(cur.id)) {
        seen.add(cur.id);
        link.conveyors.push(cur.id);
        link.capacity = Math.min(link.capacity, cur.capacity);
        link.minTier = Math.min(link.minTier, cur.tier);
        link.lengthM += cur.length || 0;
        if (cur.category === 'lift') link.lifts++;
        const out = cur.ports.find((q) => q.dir === 'out');
        curComp = out?.connectedComponent;
        cur = out?.connectedEntity ? entities.get(out.connectedEntity) : null;
      }
      if (!p.connectedEntity) continue; // port not connected at all
      if (cur && !isConveyor(cur)) {
        link.to = cur.id;
        link.toPort = short(curComp);
      } else link.dangling = true;
      if (link.capacity === Infinity) link.capacity = null; // direct machine-to-machine snap
      links.push(link);
    }
  }

  // ---------- resource nodes ----------
  const nodeTypes = { BP_ResourceNode_C: 'node', BP_FrackingSatellite_C: 'well', BP_FrackingCore_C: 'wellCore', BP_ResourceNodeGeyser_C: 'geyser' };
  const occupied = new Map();
  for (const e of entities.values()) if (e.node) occupied.set(e.node, e.id);
  const nodes = [];
  for (const o of objs) {
    const type = nodeTypes[short(o.typePath)];
    if (!type) continue;
    const pur = pv(o, 'mPurityOverride');
    nodes.push({
      id: o.instanceName,
      short: short(o.instanceName),
      type,
      resource: short(ref(o, 'mResourceClassOverride')) || (type === 'geyser' ? 'Geyser' : null),
      purity: PURITY[pur?.value] || (pur ? 'normal' : 'unknown'),
      pos: toM(o.transform?.translation),
      occupiedBy: occupied.get(o.instanceName) || null,
    });
  }

  const nodeData = syncNodeCache(nodes);
  for (const n of nodes) if (n.occupiedBy === undefined) n.occupiedBy = null;

  // ---------- extractor rates (needs nodes) ----------
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const e of entities.values()) {
    if (e.category !== 'extractor') continue;
    const b = gd.buildings[e.cls];
    const n = e.node ? nodeById.get(e.node) : null;
    const resource = n?.resource || b?.allowedResources?.[0] || null;
    const fluid = resource && gd.items[resource] && gd.items[resource].form !== 'RF_SOLID';
    const base = b ? (60 / b.cycleTime) * b.itemsPerCycle * (fluid ? 0.001 : 1) : 60;
    e.resource = resource;
    e.purity = n?.purity || (e.cls === 'Build_WaterPump_C' ? 'normal' : 'unknown');
    e.potentialRate = base * PURITY_MULT[e.purity] * e.clock;
  }

  // ---------- inventories & misc ----------
  const totals = {};
  const addInv = (inv) => { for (const [k, v] of Object.entries(inv || {})) totals[k] = (totals[k] || 0) + v; };
  for (const e of entities.values()) addInv(e.storageInv);
  const player = objs.find((o) => /Char_Player_C/.test(o.typePath));
  const playerInv = readInventory(byName.get(ref(player, 'mInventory')), gd);
  addInv(playerInv);
  const hub = [...entities.values()].find((e) => e.category === 'hub');

  let consumption = 0;
  let capacity = 0;
  for (const e of entities.values()) {
    if (e.powerMW) consumption += e.powerMW;
    if (e.capacityMW) capacity += e.capacityMW;
  }

  return {
    file,
    header: {
      sessionName: h.sessionName,
      saveName: h.saveName,
      playtimeHours: +(h.playDurationSeconds / 3600).toFixed(1),
      saveVersion: h.saveVersion,
      buildVersion: h.buildVersion,
      saved: (() => {
        const n = Number(h.saveDateTime);
        if (!Number.isFinite(n)) return null;
        // newer saves store unix ms, older ones .NET ticks (100 ns since year 1)
        const ms = n > 1e15 ? n / 10000 - 62135596800000 : n;
        return new Date(ms).toISOString();
      })(),
    },
    unlocks,
    entities,
    links,
    nodes,
    nodeDataSource: nodeData.source,
    hubPos: hub?.pos || null,
    playerPos: player ? toM(player.transform?.translation) : null,
    inventoryTotals: totals,
    playerInventory: playerInv,
    powerShards: Math.floor(totals.Desc_CrystalShard_C || 0),
    somersloops: Math.floor(totals.Desc_WAT1_C || 0),
    power: { consumptionMW: consumption, capacityMW: capacity },
  };
}
