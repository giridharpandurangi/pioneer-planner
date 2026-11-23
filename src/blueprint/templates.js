// Known-good object templates for writing blueprints, taken from real blueprint files / saves of the same
// format version (the game itself wrote them). Stored in data/bp-templates.json so export works offline.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import parserPkg from '@etothepii/satisfactory-file-parser';
import { ROOT, ensureDir, listSaves } from '../config.js';

const { Parser } = parserPkg;
export const TEMPLATE_FILE = path.join(ROOT, 'data', 'bp-templates.json');

const RUNTIME_PROPS = new Set([
  'BuiltBy', 'mConveyorChainActor', 'mIsProducing', 'mCurrentManufacturingProgress', 'mProductivityMonitorEnabled',
  'mLastProductivityMeasurementProduceDuration', 'mLastProductivityMeasurementDuration', 'mCurrentProductivityMeasurementProduceDuration',
  'mCurrentProductivityMeasurementDuration', 'mCurrentPotential', 'mPendingPotential', 'mExtractableResource', 'mExtractStartupTimer',
  'mCurrentExtractProgress', 'mCurrentFuelAmount', 'mHasFuelCached', 'mCurrentFuelClass', 'mCurrentProductionBoost', 'mPendingProductionBoost',
]);

/** Only these building types are ever written into blueprints — nothing else is kept. */
export const NEEDED_CLASS = /^Build_(ConstructorMk1|SmelterMk1|AssemblerMk1|FoundryMk1|ManufacturerMk1|OilRefinery|Packager|Blender|HadronCollider|Converter|QuantumEncoder|ConveyorAttachmentSplitter|ConveyorAttachmentMerger|ConveyorBeltMk\d|ConveyorLiftMk\d)_C$/;
/** Property / field names that can identify a player or account (removed from every template, at any depth). */
const IDENTITY = /BuiltBy|PlayerInfo|AccountId|DisplayName|BackendName|CachedPlayerName|lastEditedBy|ClientIdentity|PlayerName|UserId|NetId/i;

/** Deep-removes identity fields so templates never carry who built something (Steam IDs, player names, ...). */
export function scrubIdentity(o) {
  if (Array.isArray(o)) { for (const v of o) scrubIdentity(v); return o; }
  if (!o || typeof o !== 'object') return o;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (IDENTITY.test(k) || (v && typeof v === 'object' && typeof v.name === 'string' && IDENTITY.test(v.name))) { delete o[k]; continue; }
    scrubIdentity(v);
  }
  return o;
}

export const bigintReplacer = (k, v) => (typeof v === 'bigint' ? { __bigint: v.toString() } : v);
export const bigintReviver = (k, v) => (v && typeof v === 'object' && '__bigint' in v ? BigInt(v.__bigint) : v);
export const clone = (o) => JSON.parse(JSON.stringify(o, bigintReplacer), bigintReviver);

function blueprintRoot() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'FactoryGame', 'Saved', 'SaveGames', 'blueprints');
}

export function listBlueprintFiles() {
  const root = blueprintRoot();
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const session of fs.readdirSync(root, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const dir = path.join(root, session.name);
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.sbp') && fs.existsSync(path.join(dir, f + 'cfg'))) out.push(path.join(dir, f));
  }
  return out;
}

const ab = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

function emptyInventory(comp) {
  const stacks = comp.properties?.mInventoryStacks?.values;
  if (!stacks) return;
  for (const s of stacks) {
    if (s.properties?.Item?.value) s.properties.Item.value = { itemReference: { levelName: '', pathName: '' }, itemState: { hasValidStruct: false } };
    if (s.properties?.NumItems) s.properties.NumItems.value = 0;
  }
}

function sanitize(entity, components) {
  const e = clone(entity);
  for (const k of Object.keys(e.properties || {})) if (RUNTIME_PROPS.has(k)) delete e.properties[k];
  if (e.specialProperties?.type === 'ConveyorSpecialProperties') {
    for (const [k, v] of Object.entries(e.specialProperties)) if (Array.isArray(v)) e.specialProperties[k] = [];
  }
  e.saveCustomVersion = 0;
  const comps = components.map((c) => {
    const x = clone(c);
    delete x.properties?.mConnectedComponent;
    x.saveCustomVersion = 0;
    emptyInventory(x);
    return x;
  });
  return { entity: scrubIdentity(e), components: scrubIdentity(comps) };
}

/** Extract templates from an already-parsed save (used by tools/learn.js for big saves). */
export function addTemplatesFromSave(save, label) {
  const version = save.header.saveVersion;
  let data = { version, classes: {} };
  try { data = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'), bigintReviver); } catch { /* first */ }
  if (data.version !== version) return 0;
  const objects = Object.values(save.levels).flatMap((l) => l.objects);
  const byName = new Map(objects.map((o) => [o.instanceName, o]));
  let added = 0;
  for (const o of objects) {
    if (o.type !== 'SaveEntity' || !/\/Buildable\/Factory\//.test(o.typePath)) continue;
    const cls = o.typePath.split('.').pop();
    if (data.classes[cls] || !NEEDED_CLASS.test(cls)) continue;
    const comps = (o.components || []).map((r) => byName.get(r.pathName)).filter(Boolean);
    data.classes[cls] = { ...sanitize(o, comps), source: 'save' }; // no save names: they can be personal
    added++;
  }
  void label;
  fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(data, bigintReplacer));
  memo = null;
  return added;
}

/** Scan blueprint files and small saves of the given format version for templates. */
export function buildTemplates({ version = 52, maxSaveKB = 1024 } = {}) {
  const classes = {};
  let meta = null;
  const take = (objects, srcVersion, source) => {
    if (srcVersion !== version) return;
    const byName = new Map(objects.map((o) => [o.instanceName, o]));
    for (const o of objects) {
      if (o.type !== 'SaveEntity' || !/\/Buildable\/Factory\//.test(o.typePath)) continue;
      const cls = o.typePath.split('.').pop();
      if (classes[cls] || !NEEDED_CLASS.test(cls)) continue;
      const comps = (o.components || []).map((r) => byName.get(r.pathName)).filter(Boolean);
      classes[cls] = { ...sanitize(o, comps), source: source.split(':')[0] }; // "blueprint" / "save" only — names can be personal
    }
  };
  for (const f of listBlueprintFiles()) {
    try {
      const bp = Parser.ParseBlueprintFiles(path.basename(f, '.sbp'), ab(f), ab(f + 'cfg'));
      if (!meta && bp.header.saveVersion === version) {
        meta = { header: clone({ ...bp.header, itemCosts: [], recipeReferences: [] }), config: clone(bp.config), compressionInfo: clone(bp.compressionInfo) };
      }
      take(bp.objects, bp.header.saveVersion, `blueprint:${path.basename(f)}`);
    } catch { /* unreadable blueprint: skip */ }
  }
  const seenSessions = new Set();
  for (const s of listSaves()) {
    if (s.sizeKB > maxSaveKB) continue;
    try {
      // cheap header check (int32 headerVersion, int32 saveVersion) before a full parse; one save per session is enough
      const fd = fs.openSync(s.path, 'r');
      const head = Buffer.alloc(8);
      fs.readSync(fd, head, 0, 8, 0);
      fs.closeSync(fd);
      if (head.readInt32LE(4) !== version) continue;
      const session = s.name.replace(/_(autosave_\d+|\d{6}-\d{6})$/, '');
      if (seenSessions.has(session)) continue;
      seenSessions.add(session);
      const save = Parser.ParseSave(s.name, ab(s.path));
      take(Object.values(save.levels).flatMap((l) => l.objects), save.header.saveVersion, `save:${s.name}`);
    } catch { /* skip */ }
  }
  if (!meta) {
    meta = {
      header: { headerVersion: 2, saveVersion: version, buildVersion: 463028, designerDimension: { x: 0, y: 0, z: 0 }, itemCosts: [], recipeReferences: [] },
      config: { configVersion: 4, description: '', color: { r: 0.98, g: 0.6, b: 0.1, a: 1 }, iconID: 782, referencedIconLibrary: 'None', iconLibraryType: 'None', lastEditedByLegacy: [] },
      compressionInfo: { chunkHeaderVersion: 572662306, packageFileTag: 2653586369, maxUncompressedChunkContentSize: 131072, compressionAlgorithm: 3 },
    };
  }
  scrubIdentity(meta);
  meta.config.description = '';
  meta.config.lastEditedByLegacy = [];
  const out = { version, builtFrom: new Date().toISOString(), ...meta, classes };
  ensureDir(path.dirname(TEMPLATE_FILE));
  // merge with existing templates so classes learned earlier are kept
  try {
    const prev = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'), bigintReviver);
    if (prev.version === version) out.classes = { ...prev.classes, ...out.classes };
  } catch { /* first run */ }
  fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(out, bigintReplacer));
  return out;
}

let memo = null;
export function getTemplates({ refresh = false } = {}) {
  if (memo && !refresh) return memo;
  if (!refresh && fs.existsSync(TEMPLATE_FILE)) return (memo = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'), bigintReviver));
  return (memo = buildTemplates());
}
