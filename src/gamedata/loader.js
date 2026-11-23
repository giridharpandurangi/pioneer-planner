// Reads the game's own CommunityResources/Docs/en-US.json and normalises it into
// items / recipes / buildings / schematics. All rates in the rest of the tool come from here,
// so the numbers always match the game version you have installed.
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, ensureDir, findDocsJson } from '../config.js';

const CACHE_FILE = path.join(CACHE_DIR, 'gamedata.json');
const CACHE_FORMAT = 4;

/** "BlueprintGeneratedClass /Game/.../Desc_X.Desc_X_C" -> "/Game/.../Desc_X.Desc_X_C" (what saves/blueprints reference) */
const assetPath = (c) => String(c.FullName || '').replace(/^\S+\s+/, '') || null;

const lastSeg = (s) => String(s).replace(/["'()]/g, '').trim().split('.').pop().trim();

/** "((ItemClass=\"...Desc_IronIngot.Desc_IronIngot_C'\",Amount=3),(...))" -> [{item, amount}] */
export function parseItemAmounts(str) {
  if (!str) return [];
  const out = [];
  for (const m of String(str).matchAll(/ItemClass=([^,]+?),\s*Amount=([\d.]+)/g)) {
    out.push({ item: lastSeg(m[1]), amount: Number(m[2]) });
  }
  return out;
}

/** '("/Game/.../Build_X.Build_X_C","/Script/FactoryGame.FGBuildGun")' -> ['Build_X_C', 'FGBuildGun'] */
export function parseClassList(str) {
  if (!str) return [];
  return String(str).replace(/^\(|\)$/g, '').split(',').map(lastSeg).filter(Boolean);
}

/** Pull every `.Something_C` class reference out of an Unreal text blob. */
function classRefs(str) {
  return [...new Set([...String(str ?? '').matchAll(/\.([A-Za-z0-9_-]+_C)\b/g)].map((m) => m[1]))];
}

const num = (v, d = 0) => (v === undefined || v === '' || v === null ? d : Number(v));
const bool = (v) => String(v).toLowerCase() === 'true';

function categoryFor(nativeClass) {
  const n = nativeClass;
  if (/FGBuildableManufacturer(VariablePower)?$/.test(n)) return 'manufacturer';
  if (/FGBuildableResourceExtractor$|FGBuildableWaterPump$|FGBuildableFrackingExtractor$/.test(n)) return 'extractor';
  if (/FGBuildableFrackingActivator$/.test(n)) return 'frackingActivator';
  if (/FGBuildableGenerator/.test(n)) return 'generator';
  if (/FGBuildableConveyorBelt$/.test(n)) return 'belt';
  if (/FGBuildableConveyorLift$/.test(n)) return 'lift';
  if (/Splitter/.test(n)) return 'splitter';
  if (/Merger/.test(n)) return 'merger';
  if (/FGBuildablePipeline$/.test(n)) return 'pipe';
  if (/FGBuildablePipelineJunction$/.test(n)) return 'pipeJunction';
  if (/FGBuildablePipelinePump$/.test(n)) return 'pump';
  if (/FGBuildablePipeReservoir$/.test(n)) return 'fluidBuffer';
  if (/FGBuildableStorage$|FGCentralStorageContainer$/.test(n)) return 'storage';
  if (/FGBuildablePowerPole$|FGBuildableWire$|PowerSwitch|CircuitSwitch|FGBuildablePowerStorage$|FGBuildablePowerBooster$/.test(n)) return 'power';
  if (/Foundation|Ramp|Wall|Pillar|Walkway|Stair|Beam|Corner|Door|Ladder|Barrier|Passthrough/.test(n)) return 'structure';
  if (/FGBuildableResourceSink$/.test(n)) return 'sink';
  if (/FGBuildableSpaceElevator$/.test(n)) return 'spaceElevator';
  if (/FGBuildableTradingPost$/.test(n)) return 'hub';
  if (/FGBuildableMAM$/.test(n)) return 'mam';
  if (/Railroad|Train|Vehicle|DockingStation|DroneStation/.test(n)) return 'transport';
  return 'other';
}

function stripNative(nc) { return nc.replace(/^.*\./, '').replace(/'$/, ''); }

export function buildGameData(docsPath) {
  const raw = fs.readFileSync(docsPath);
  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le').replace(/^﻿/, '') : raw.toString('utf8').replace(/^﻿/, '');
  const groups = JSON.parse(text);

  const items = {};
  const recipes = {};
  const buildings = {};
  const schematics = {};
  const buildingDescriptors = {};

  for (const g of groups) {
    const native = stripNative(g.NativeClass);
    for (const c of g.Classes) {
      const id = c.ClassName;
      if (/Descriptor|AmmoType|FGConsumable|FGEquipment|FGItemDescriptor/.test(native) && native !== 'FGBuildingDescriptor' && native !== 'FGVehicleDescriptor') {
        items[id] = {
          id,
          name: c.mDisplayName || id,
          path: assetPath(c),
          form: c.mForm || 'RF_SOLID',
          stackSize: c.mStackSize,
          energyMJ: num(c.mEnergyValue),
          sinkPoints: num(c.mResourceSinkPoints),
          isRawResource: native === 'FGResourceDescriptor',
          native,
        };
      } else if (native === 'FGBuildingDescriptor') {
        buildingDescriptors[id] = { id, name: c.mDisplayName };
      } else if (native === 'FGRecipe') {
        const producedIn = parseClassList(c.mProducedIn);
        recipes[id] = {
          id,
          name: c.mDisplayName || id,
          path: assetPath(c),
          alternate: /Alternate/i.test(id) || /^Alternate:/i.test(c.mDisplayName || ''),
          duration: num(c.mManufactoringDuration, 1),
          ingredients: parseItemAmounts(c.mIngredients),
          products: parseItemAmounts(c.mProduct),
          producedIn,
          varPowerConstant: num(c.mVariablePowerConsumptionConstant),
          varPowerFactor: num(c.mVariablePowerConsumptionFactor, 1),
        };
      } else if (native === 'FGSchematic') {
        const unlockRecipes = [];
        const unlockSchematics = [];
        for (const u of Array.isArray(c.mUnlocks) ? c.mUnlocks : []) {
          if (u.mRecipes) unlockRecipes.push(...classRefs(u.mRecipes));
          if (u.mSchematics) unlockSchematics.push(...classRefs(u.mSchematics));
        }
        const deps = [];
        for (const d of Array.isArray(c.mSchematicDependencies) ? c.mSchematicDependencies : []) {
          if (d.mSchematics) deps.push(...classRefs(d.mSchematics));
        }
        schematics[id] = {
          id,
          name: c.mDisplayName || id,
          type: (c.mType || '').replace('EST_', ''),
          tier: num(c.mTechTier),
          cost: parseItemAmounts(c.mCost),
          unlockRecipes: [...new Set(unlockRecipes)],
          unlockSchematics: [...new Set(unlockSchematics)],
          dependencies: [...new Set(deps)],
          subCategories: classRefs(c.mSubCategories),
          menuPriority: num(c.mMenuPriority),
        };
      } else if (native.startsWith('FGBuildable')) {
        const b = {
          id,
          name: c.mDisplayName || id,
          path: assetPath(c),
          native,
          category: categoryFor(native),
          power: num(c.mPowerConsumption),
          powerExponent: num(c.mPowerConsumptionExponent, 1.321929),
          speed: num(c.mManufacturingSpeed, 1),
          canOverclock: c.mCanChangePotential === undefined ? false : bool(c.mCanChangePotential),
          canSomersloop: c.mCanChangeProductionBoost === undefined ? false : bool(c.mCanChangeProductionBoost),
        };
        if (b.category === 'belt' || b.category === 'lift') {
          b.itemsPerMin = num(c.mSpeed) / 2; // mSpeed is stored doubled
          b.tier = Number((id.match(/Mk(\d)/i) || [])[1] || 1);
        }
        if (b.category === 'pipe') {
          b.flowPerMin = num(c.mFlowLimit) * 60;
          b.tier = /MK2/i.test(id) ? 2 : 1;
        }
        if (b.category === 'extractor') {
          b.cycleTime = num(c.mExtractCycleTime, 1);
          b.itemsPerCycle = num(c.mItemsPerCycle, 1);
          b.allowedResources = classRefs(c.mAllowedResources);
          b.allowedForms = String(c.mAllowedResourceForms || '').replace(/[()]/g, '').split(',').filter(Boolean);
          b.tier = Number((id.match(/Mk(\d)/i) || [])[1] || 1);
        }
        if (b.category === 'generator') {
          b.powerProduction = num(c.mPowerProduction);
          b.fuels = (Array.isArray(c.mFuel) ? c.mFuel : []).map((f) => ({
            fuel: f.mFuelClass, supplemental: f.mSupplementalResourceClass || null,
            byproduct: f.mByproduct || null, byproductAmount: num(f.mByproductAmount),
          }));
          b.supplementalToPowerRatio = num(c.mSupplementalToPowerRatio);
        }
        if (native === 'FGBuildableManufacturerVariablePower') {
          b.variablePower = true;
          b.powerMin = num(c.mEstimatedMininumPowerConsumption);
          b.powerMax = num(c.mEstimatedMaximumPowerConsumption);
        }
        buildings[id] = b;
      }
    }
  }

  // Map build-gun recipes -> building classes, so we know which buildings each recipe unlocks.
  for (const r of Object.values(recipes)) {
    const isBuildGun = r.producedIn.some((p) => /BuildGun/i.test(p));
    r.kind = isBuildGun ? 'building' : r.producedIn.some((p) => buildings[p]?.category === 'manufacturer') ? 'machine' : 'manual';
    if (isBuildGun) {
      const desc = r.products[0]?.item;
      const guess = desc?.replace(/^Desc_/, 'Build_');
      if (guess && buildings[guess]) r.building = guess;
      else if (desc && buildingDescriptors[desc]) {
        const byName = Object.values(buildings).find((b) => b.name === buildingDescriptors[desc].name);
        if (byName) r.building = byName.id;
      }
      if (r.building) buildings[r.building].buildRecipe = r.id;
    }
    // fluids are stored in litres in the docs; convert to m³ like the in-game UI
    for (const list of [r.ingredients, r.products]) {
      for (const x of list) {
        const it = items[x.item];
        x.amountUi = it && it.form !== 'RF_SOLID' ? x.amount / 1000 : x.amount;
      }
    }
  }

  return {
    format: CACHE_FORMAT,
    source: docsPath,
    sourceMtime: fs.statSync(docsPath).mtime.toISOString(),
    items, recipes, buildings, schematics,
  };
}

let memo = null;

/** Loads game data, using cache/gamedata.json when the docs file has not changed. */
export function loadGameData({ refresh = false } = {}) {
  if (memo && !refresh) return memo;
  const docs = findDocsJson();
  if (!refresh && fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const fresh = !docs || (cached.source === docs && cached.sourceMtime === fs.statSync(docs).mtime.toISOString());
      if (cached.format === CACHE_FORMAT && fresh) return (memo = enrich(cached));
    } catch { /* rebuild */ }
  }
  if (!docs) {
    throw new Error('Could not find the game Docs file (CommunityResources/Docs/en-US.json). Set SATISFACTORY_GAME_DIR or "gameDir" in sfp.config.json.');
  }
  const gd = buildGameData(docs);
  ensureDir(CACHE_DIR);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(gd));
  return (memo = enrich(gd));
}

/** Adds lookup helpers (non-serialised). */
function enrich(gd) {
  const byName = new Map();
  for (const it of Object.values(gd.items)) byName.set(it.name.toLowerCase(), it.id);
  const producers = {};
  const consumers = {};
  for (const r of Object.values(gd.recipes)) {
    if (r.kind !== 'machine') continue;
    for (const p of r.products) (producers[p.item] ||= []).push(r.id);
    for (const i of r.ingredients) (consumers[i.item] ||= []).push(r.id);
  }
  gd.producers = producers;
  gd.consumers = consumers;
  gd.itemByName = byName;
  gd.beltTiers = Object.values(gd.buildings).filter((b) => b.category === 'belt').sort((a, b) => a.tier - b.tier);
  gd.liftTiers = Object.values(gd.buildings).filter((b) => b.category === 'lift').sort((a, b) => a.tier - b.tier);
  gd.pipeTiers = Object.values(gd.buildings).filter((b) => b.category === 'pipe' && !/NoIndicator/.test(b.id)).sort((a, b) => a.tier - b.tier);
  return gd;
}

/** Resolve "iron plate", "Iron Plate", "Desc_IronPlate_C", "IronPlate" to an item id. */
export function resolveItem(gd, query) {
  if (!query) return null;
  if (gd.items[query]) return query;
  const q = String(query).trim().toLowerCase();
  if (gd.itemByName.has(q)) return gd.itemByName.get(q);
  const asDesc = `Desc_${String(query).replace(/\s+/g, '')}_C`;
  if (gd.items[asDesc]) return asDesc;
  const loose = q.replace(/[^a-z0-9]/g, '');
  for (const [name, id] of gd.itemByName) if (name.replace(/[^a-z0-9]/g, '') === loose) return id;
  for (const [name, id] of gd.itemByName) if (name.includes(q)) return id;
  return null;
}

export const isFluid = (gd, itemId) => (gd.items[itemId]?.form ?? 'RF_SOLID') !== 'RF_SOLID';
export const itemName = (gd, id) => gd.items[id]?.name ?? gd.buildings[id]?.name ?? id;

/** Per-minute rates of a recipe at 100% clock, in UI units (items or m³). */
export function recipeRates(gd, recipe) {
  const building = gd.buildings[recipe.producedIn.find((p) => gd.buildings[p]?.category === 'manufacturer')];
  const speed = building?.speed || 1;
  const perMin = 60 / (recipe.duration / speed);
  return {
    building: building?.id,
    inputs: recipe.ingredients.map((x) => ({ item: x.item, rate: x.amountUi * perMin })),
    outputs: recipe.products.map((x) => ({ item: x.item, rate: x.amountUi * perMin })),
  };
}

/** Average MW a building draws for a recipe at a given clock (0-2.5). */
export function machinePower(gd, buildingId, recipe, clock = 1) {
  const b = gd.buildings[buildingId];
  if (!b) return 0;
  let base = b.power;
  if (b.variablePower) {
    base = recipe && (recipe.varPowerConstant || recipe.varPowerFactor) ? recipe.varPowerConstant + recipe.varPowerFactor / 2 : (b.powerMin + b.powerMax) / 2;
  }
  return base * Math.pow(Math.max(clock, 0), b.powerExponent || 1.321929);
}
