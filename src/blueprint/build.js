// Layout -> in-game blueprint (.sbp + .sbpcfg), one per floor.
// Contains machines (recipe + clock set), splitters, mergers and connected belts. Foundations, power and lifts
// are left out on purpose (belts end where a lift goes). Port positions come from ports.js (learned from your saves).
import fs from 'node:fs';
import path from 'node:path';
import parserPkg from '@etothepii/satisfactory-file-parser';
import { portsFor, knownPorts } from './ports.js';
import { getTemplates, clone } from './templates.js';
import { footprint } from '../gamedata/footprints.js';

const { Parser } = parserPkg;
const CM = 100;
const BELT_Z = 100; // belt / port height above the floor (cm)
const MAX_BELT = 4800; // split belts longer than 48 m
const SPLITTER = 'Build_ConveyorAttachmentSplitter_C';
const MERGER = 'Build_ConveyorAttachmentMerger_C';

// ---------------------------------------------------------------- geometry helpers
const rot = (x, y, yaw) => ({ x: x * Math.cos(yaw) - y * Math.sin(yaw), y: x * Math.sin(yaw) + y * Math.cos(yaw) });
const quat = (yaw) => ({ x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) });

class Scene {
  constructor(gd, ports) {
    this.gd = gd;
    this.ports = ports;
    this.ents = [];
    this.paths = [];
    this.warnings = new Set();
  }
  add(cls, pos, yaw, extra = {}) {
    const e = { id: this.ents.length, cls, pos, yaw, ...extra };
    this.ents.push(e);
    return e;
  }
  port(ent, name) {
    const p = portsFor(ent.cls, this.ports)[name];
    if (!p) throw new Error(`No port ${name} on ${ent.cls}`);
    if (p.estimated) this.warnings.add(`${this.gd.buildings[ent.cls]?.name || ent.cls}: port positions are estimated (no belted one in your saves yet), so belt ends may look slightly off. Items still flow.`);
    const o = rot(p.x, p.y, ent.yaw);
    const d = rot(p.dir[0], p.dir[1], ent.yaw);
    return { x: ent.pos.x + o.x, y: ent.pos.y + o.y, z: ent.pos.z + p.z, dir: d, name };
  }
  /** pts: [{x,y,z}] world cm, from/to: {ent, port} | null */
  belt(pts, from, to, note) { this.paths.push({ pts, from, to, note }); }
}

/** Build the scene for one floor. Layout coords: metres, x east, y north. World: cm, X east, Y south. */
function buildFloorScene(gd, plan, layout, floorIndex, ports) {
  const { rows, sources, sinks, conns, lanes, busW } = layout.internal;
  const floor = layout.floors[floorIndex];
  const ox = floor.width / 2;
  const oy = floor.usedLength / 2;
  const W = (x, y, z = 0) => ({ x: Math.round((x - ox) * CM), y: Math.round(-(y - oy) * CM), z });
  const S = new Scene(gd, ports);
  const NORTH = -Math.PI / 2; // splitter/merger yaw whose front points layout-north (world -Y)
  const SOUTH = Math.PI / 2;
  const EAST = 0;
  const WEST = Math.PI;

  const entries = new Map(); // row in-line -> {pts (layout, starting at corridor edge), to}
  const exits = new Map(); // row out-line -> {from, pts (world) ending at corridor edge}
  const layoutPt = (p) => ({ x: p.x / CM + ox, y: -p.y / CM + oy });

  for (const row of rows.filter((r) => r.floor === floorIndex)) {
    const step = row.step;
    const table = portsFor(step.building, ports);
    const inPorts = Object.keys(table).filter((n) => /^Input/.test(n)).sort();
    const outPorts = Object.keys(table).filter((n) => /^Output/.test(n)).sort();
    // items must flow north (world -Y): most machines flow along local +Y (yaw 180°), a few (refinery) along -Y
    const flowY = table[inPorts[0]]?.dir?.[1] ?? 1;
    const yaw = flowY >= 0 ? Math.PI : 0;
    const machines = row.machines.map((m) => S.add(step.building, W(m.x + m.w / 2, m.y + m.l / 2, 0), yaw, { recipe: step.recipe, clock: step.clockPercent / 100 }));
    const solid = (l) => (gd.items[l.item]?.form || 'RF_SOLID') === 'RF_SOLID';
    if ([...row.inLines, ...row.outLines].some((l) => !solid(l))) S.warnings.add('Pipes are not included in the blueprint — connect the fluids by hand (see the sketch).');

    for (const line of row.inLines.filter(solid)) {
      const portName = inPorts[line.portIndex] || inPorts[0];
      const laneY = W(0, line.y).y;
      const targets = [];
      for (let j = line.from; j <= line.to; j++) targets.push(S.port(machines[j], portName));
      // splitters in front of every machine but the last
      const splitters = targets.slice(0, -1).map((t) => S.add(SPLITTER, { x: t.x, y: laneY, z: BELT_Z }, EAST));
      splitters.forEach((sp, k) => {
        const side = sideToward(S, sp, targets[k]);
        S.belt([pt(S.port(sp, side)), pt(targets[k])], { ent: sp, port: side }, { ent: machines[line.from + k], port: portName });
      });
      for (let k = 0; k < splitters.length - 1; k++) {
        S.belt([pt(S.port(splitters[k], 'Output1')), pt(S.port(splitters[k + 1], 'Input1'))], { ent: splitters[k], port: 'Output1' }, { ent: splitters[k + 1], port: 'Input1' });
      }
      const last = targets[targets.length - 1];
      const lastMachine = machines[line.to];
      if (splitters.length) {
        const sp = splitters[splitters.length - 1];
        S.belt([pt(S.port(sp, 'Output1')), { x: last.x, y: laneY, z: BELT_Z }, pt(last)], { ent: sp, port: 'Output1' }, { ent: lastMachine, port: portName });
      }
      // entry: corridor edge -> first splitter input (or straight into the single machine)
      const first = splitters.length ? { at: S.port(splitters[0], 'Input1'), to: { ent: splitters[0], port: 'Input1' } } : null;
      const edge = W(busW, line.y, BELT_Z);
      entries.set(line, first
        ? { pts: [edge, pt(first.at)], to: first.to }
        : { pts: [edge, { x: last.x, y: laneY, z: BELT_Z }, pt(last)], to: { ent: lastMachine, port: portName } });
    }

    for (const line of row.outLines.filter(solid)) {
      const portName = outPorts[line.portIndex] || outPorts[0];
      const laneY = W(0, line.y).y;
      const srcs = [];
      for (let j = line.from; j <= line.to; j++) srcs.push(S.port(machines[j], portName));
      // mergers above every machine but the right-most (where the lane starts)
      const mergers = srcs.slice(0, -1).map((s) => S.add(MERGER, { x: s.x, y: laneY, z: BELT_Z }, WEST));
      mergers.forEach((mg, k) => {
        const side = sideToward(S, mg, srcs[k], true);
        S.belt([pt(srcs[k]), pt(S.port(mg, side))], { ent: machines[line.from + k], port: portName }, { ent: mg, port: side });
      });
      for (let k = mergers.length - 1; k > 0; k--) {
        S.belt([pt(S.port(mergers[k], 'Output1')), pt(S.port(mergers[k - 1], 'Input1'))], { ent: mergers[k], port: 'Output1' }, { ent: mergers[k - 1], port: 'Input1' });
      }
      const rightmost = srcs[srcs.length - 1];
      const rmMachine = machines[line.to];
      if (mergers.length) {
        const mg = mergers[mergers.length - 1];
        S.belt([pt(rightmost), { x: rightmost.x, y: laneY, z: BELT_Z }, pt(S.port(mg, 'Input1'))], { ent: rmMachine, port: portName }, { ent: mg, port: 'Input1' });
        exits.set(line, { from: { ent: mergers[0], port: 'Output1' }, pts: [pt(S.port(mergers[0], 'Output1')), W(busW, line.y, BELT_Z)] });
      } else {
        exits.set(line, { from: { ent: rmMachine, port: portName }, pts: [pt(rightmost), { x: rightmost.x, y: laneY, z: BELT_Z }, W(busW, line.y, BELT_Z)] });
      }
    }
  }

  // ---------------- corridor ----------------
  const lineOf = new Map();
  for (const r of rows) {
    for (const l of r.inLines) lineOf.set(`in|${r.id}|${l.y}|${l.item}`, l);
    for (const l of r.outLines) lineOf.set(`out|${r.id}|${l.y}|${l.item}`, l);
  }
  const sinkLine = (sk) => lineOf.get(`in|${sk.rowId}|${sk.y}|${sk.item}`);
  const srcLine = (s) => lineOf.get(`out|${s.rowId}|${s.y}|${s.item}`);
  const incoming = new Map();
  for (const c of conns) (incoming.get(c.sink) || incoming.set(c.sink, []).get(c.sink)).push(c);

  // corridor mergers where several lanes feed one row input
  const sinkMergers = new Map();
  for (const [k, list] of incoming) {
    const sk = sinks[k];
    if (sk.kind !== 'row' || sk.floor !== floorIndex || list.length < 2) continue;
    const mg = S.add(MERGER, W(busW - 1, sk.y, BELT_Z), EAST);
    const entry = entries.get(sinkLine(sk));
    if (entry) { entry.pts[0] = pt(S.port(mg, 'Output1')); entry.from = { ent: mg, port: 'Output1' }; entry.used = true; }
    if (list.length > 3) S.warnings.add(`${sk.label}: more than 3 lanes merge into one input — connect the extra ones by hand.`);
    sinkMergers.set(k, { mg, slots: ['Input1', 'Input2', 'Input3'], used: 0 });
  }
  // belt from each corridor merger to its row
  for (const [k, { mg }] of sinkMergers) {
    const entry = entries.get(sinkLine(sinks[k]));
    if (entry) S.belt(entry.pts, { ent: mg, port: 'Output1' }, entry.to);
  }

  for (const lane of lanes) {
    const src = sources[lane.source];
    const x = lane.x;
    const mine = conns.filter((c) => c.source === lane.source);
    // targets on this floor (as y in layout metres + how to finish the branch)
    const targets = [];
    for (const c of mine) {
      const sk = sinks[c.sink];
      if (sk.floor !== floorIndex) continue;
      if (sk.kind === 'row') {
        const m = sinkMergers.get(c.sink);
        if (m) {
          const slot = m.slots[m.used++];
          if (!slot) continue;
          const dy = slot === 'Input1' ? 0 : slot === 'Input2' ? -2 : 2;
          targets.push({ y: sk.y + dy, finish: (pts, from) => S.belt([...pts, W(busW - 1, sk.y + dy, BELT_Z), pt(S.port(m.mg, slot))].filter(dedupe()), from, { ent: m.mg, port: slot }) });
        } else {
          const entry = entries.get(sinkLine(sk));
          if (!entry) continue;
          entry.used = true;
          targets.push({ y: sk.y, finish: (pts, from) => S.belt([...pts, ...entry.pts].filter(dedupe()), from, entry.to) });
        }
      } else {
        targets.push({ y: sk.y + 2, finish: (pts, from) => S.belt(pts, from, null, `${sk.label}: belt ends here — connect it to storage / the next factory`) });
      }
    }
    const crossFloor = mine.some((c) => sinks[c.sink].floor !== src.floor);
    const onSourceFloor = src.floor === floorIndex;
    if (!onSourceFloor && !targets.length) continue;
    if (onSourceFloor && crossFloor) S.warnings.add('Belts that continue to another floor end at the corridor: add a conveyor lift there (shown on the sketch).');

    // start of the lane on this floor
    let startPts;
    let startFrom = null;
    let ys;
    if (!onSourceFloor) {
      ys = src.y; // arrives by lift
      startPts = [W(x, ys, BELT_Z)];
    } else if (src.kind === 'row') {
      const ex = exits.get(srcLine(src));
      if (!ex) continue;
      ex.used = true;
      ys = src.y;
      startPts = [...ex.pts, W(x, ys, BELT_Z)];
      startFrom = ex.from;
    } else {
      ys = -2; // raw input enters from the south edge
      startPts = [W(x, ys, BELT_Z)];
    }
    if (onSourceFloor && crossFloor) targets.push({ y: ys + (targets.some((t) => t.y > ys) || !targets.length ? Math.max(...targets.map((t) => t.y), ys) - ys + 2 : -2), finish: (pts, from) => S.belt(pts, from, null, 'lift up/down here') });
    if (!targets.length) {
      S.belt(startPts.filter(dedupe()), startFrom, null);
      continue;
    }
    const up = targets.filter((t) => t.y > ys).sort((a, b) => a.y - b.y);
    const down = targets.filter((t) => t.y <= ys).sort((a, b) => b.y - a.y);
    const runTrunk = (list, pts, from, dirYaw) => {
      let curPts = pts;
      let curFrom = from;
      list.forEach((t, i) => {
        const junction = W(x, t.y, BELT_Z);
        if (i === list.length - 1) {
          t.finish([...curPts, junction], curFrom);
          return;
        }
        const sp = S.add(SPLITTER, junction, dirYaw);
        S.belt([...curPts, pt(S.port(sp, 'Input1'))].filter(dedupe()), curFrom, { ent: sp, port: 'Input1' });
        const east = eastSide(S, sp);
        t.finish([pt(S.port(sp, east))], { ent: sp, port: east });
        curPts = [pt(S.port(sp, 'Output1'))];
        curFrom = { ent: sp, port: 'Output1' };
      });
    };
    if (up.length && down.length) {
      // split at the lane: one branch north, one south
      const sp = S.add(SPLITTER, W(x, ys, BELT_Z), src.kind === 'row' && onSourceFloor ? WEST : NORTH);
      S.belt([...startPts.slice(0, -1), pt(S.port(sp, 'Input1'))].filter(dedupe()), startFrom, { ent: sp, port: 'Input1' });
      const north = sideFacing(S, sp, -1);
      const south = sideFacing(S, sp, 1);
      runTrunk(up, [pt(S.port(sp, north))], { ent: sp, port: north }, NORTH);
      runTrunk(down, [pt(S.port(sp, south))], { ent: sp, port: south }, SOUTH);
    } else if (up.length) runTrunk(up, startPts, startFrom, NORTH);
    else runTrunk(down, startPts, startFrom, SOUTH);
  }

  // inputs/outputs nothing on this floor connects to (e.g. a stand-alone module) get an open belt end at the edge
  for (const entry of entries.values()) if (!entry.used) S.belt(entry.pts, null, entry.to, 'input: connect your supply here');
  for (const ex of exits.values()) if (!ex.used) S.belt(ex.pts, ex.from, null, 'output: connect to storage or the next machines');
  return S;

  function pt(p) { return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }; }
  void layoutPt;
}

const dedupe = () => {
  let prev = null;
  return (p) => { const k = `${p.x},${p.y},${p.z}`; const keep = k !== prev; prev = k; return keep; };
};

/** Side output/input of a splitter/merger pointing toward a world point. */
function sideToward(S, ent, target, isInput = false) {
  const names = isInput ? ['Input2', 'Input3'] : ['Output2', 'Output3'];
  let best = names[0];
  let bestD = Infinity;
  for (const n of names) {
    const p = S.port(ent, n);
    const d = Math.hypot(p.x - target.x, p.y - target.y);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}
function eastSide(S, sp) {
  return ['Output2', 'Output3'].find((n) => S.port(sp, n).dir.x > 0.5) || 'Output2';
}
function sideFacing(S, sp, sign) {
  return ['Output2', 'Output3', 'Output1'].find((n) => Math.sign(S.port(sp, n).dir.y) === sign) || 'Output2';
}

// ---------------------------------------------------------------- serialization
let idCounter = 2140000000;
const nextId = () => idCounter--;

function splineFor(points) {
  // points: world cm, orthogonal polyline -> rounded corners (r = 1 m) as Hermite spline points relative to points[0]
  const o = points[0];
  const rel = points.map((p) => ({ x: p.x - o.x, y: p.y - o.y, z: p.z - o.z }));
  const out = [];
  const R = 100;
  const K = 1.657 * R;
  const dir = (a, b) => { const l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l, z: (b.z - a.z) / l, l }; };
  const add = (loc, arrive, leave) => out.push({ loc, arrive, leave });
  const mul = (d, k) => ({ x: d.x * k, y: d.y * k, z: d.z * k });
  for (let i = 0; i < rel.length; i++) {
    const p = rel[i];
    if (i === 0) { const d = dir(p, rel[1]); add(p, mul(d, 1), mul(d, d.l / 2)); continue; }
    const din = dir(rel[i - 1], p);
    if (i === rel.length - 1) { add(p, mul(din, din.l / 2), mul(din, 1)); continue; }
    const dout = dir(p, rel[i + 1]);
    const straight = Math.abs(din.x * dout.x + din.y * dout.y + din.z * dout.z - 1) < 1e-6;
    if (straight) { add(p, mul(din, din.l / 2), mul(dout, dout.l / 2)); continue; }
    const r = Math.min(R, din.l / 2, dout.l / 2);
    const a = { x: p.x - din.x * r, y: p.y - din.y * r, z: p.z - din.z * r };
    const b = { x: p.x + dout.x * r, y: p.y + dout.y * r, z: p.z + dout.z * r };
    add(a, mul(din, Math.max(1, (din.l - r) / 2)), mul(din, (K * r) / R));
    add(b, mul(dout, (K * r) / R), mul(dout, Math.max(1, (dout.l - r) / 2)));
  }
  // fix straight tangents to match their actual segment lengths
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i];
    const b = out[i + 1];
    const d = dir(a.loc, b.loc);
    const curve = Math.abs(Math.hypot(a.leave.x, a.leave.y) - (K * Math.min(R, d.l)) / R) < 1 && Math.abs(a.leave.x * d.x + a.leave.y * d.y) / Math.hypot(a.leave.x, a.leave.y, 1e-9) < 0.99;
    if (!curve) { a.leave = mul(d, d.l / 2); b.arrive = mul(d, d.l / 2); }
  }
  return out;
}

function splitLong(points) {
  // split an orthogonal polyline into pieces of at most MAX_BELT
  const pieces = [];
  let cur = [points[0]];
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    let a = cur[cur.length - 1];
    const b = points[i];
    let seg = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    while (len + seg > MAX_BELT) {
      const t = (MAX_BELT - len) / seg;
      const m = { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t), z: Math.round(a.z + (b.z - a.z) * t) };
      cur.push(m);
      pieces.push(cur);
      cur = [m];
      a = m;
      seg = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      len = 0;
    }
    cur.push(b);
    len += seg;
  }
  pieces.push(cur);
  return pieces.filter((p) => p.length > 1);
}

function setProp(props, name, sample, value) {
  const p = clone(sample); // keeps the sample's type tag (the writer needs it)
  p.name = name;
  p.value = value;
  props[name] = p;
}

export function sceneToBlueprint(gd, scene, { name, description, beltTier }) {
  const T = getTemplates();
  const objects = [];
  const refOf = (e) => `Persistent_Level:PersistentLevel.${e.cls}_${e.uid}`;
  const objSample = T.classes.Build_ConstructorMk1_C?.entity.properties.mCurrentRecipe;
  const floatSample = T.classes.Build_ConstructorMk1_C?.entity.properties.mTimeSinceStartStopProducing;
  if (!objSample || !floatSample) throw new Error('Blueprint templates are missing a Constructor. Build one blueprint containing a constructor in-game (or keep an older save) and re-run.');
  const connections = new Map(); // "entRef.port" -> other path

  for (const e of scene.ents) e.uid = nextId();
  const beltEnts = [];
  for (const p of scene.paths) {
    if (p.pts.length < 2) continue;
    const pieces = splitLong(p.pts);
    const ids = pieces.map(() => nextId());
    pieces.forEach((pts, i) => {
      const b = { cls: `Build_ConveyorBeltMk${beltTier}_C`, uid: ids[i], pts, note: p.note };
      beltEnts.push(b);
      const bref = refOf(b);
      if (i === 0 && p.from) link(`${bref}.ConveyorAny0`, `${refOf(p.from.ent)}.${p.from.port}`);
      if (i === pieces.length - 1 && p.to) link(`${bref}.ConveyorAny1`, `${refOf(p.to.ent)}.${p.to.port}`);
      if (i > 0) link(`${bref}.ConveyorAny0`, `${refOf({ cls: b.cls, uid: ids[i - 1] })}.ConveyorAny1`);
    });
  }
  function link(a, b) { connections.set(a, b); connections.set(b, a); }

  const recipeRefs = new Set();
  const costs = {};
  const addCost = (buildingId, n) => {
    const r = gd.recipes[gd.buildings[buildingId]?.buildRecipe];
    if (!r) return;
    recipeRefs.add(r.path);
    for (const i of r.ingredients) costs[i.item] = (costs[i.item] || 0) + i.amount * n;
  };

  const emit = (cls, uid, transform, configure) => {
    const tpl = T.classes[cls] || synthesize(gd, T, cls);
    const oldName = tpl.entity.instanceName;
    const newName = `Persistent_Level:PersistentLevel.${cls}_${uid}`;
    const json = JSON.stringify(tpl, (k, v) => (typeof v === 'bigint' ? { __bigint: v.toString() } : v)).split(oldName).join(newName);
    const t = JSON.parse(json, (k, v) => (v && typeof v === 'object' && '__bigint' in v ? BigInt(v.__bigint) : v));
    const ent = t.entity;
    ent.typePath = gd.buildings[cls]?.path || ent.typePath;
    ent.transform = transform;
    ent.saveCustomVersion = 0;
    if (gd.buildings[cls]?.buildRecipe) setProp(ent.properties, 'mBuiltWithRecipe', objSample, { levelName: '', pathName: gd.recipes[gd.buildings[cls].buildRecipe].path });
    const comps = t.components;
    for (const c of comps) {
      const key = c.instanceName;
      const other = connections.get(key);
      if (other && /FactoryConnection/.test(c.typePath)) {
        setProp(c.properties, 'mConnectedComponent', objSample, { levelName: 'Persistent_Level', pathName: other });
        c.flags = 262152;
      }
    }
    configure?.(ent, comps);
    objects.push(ent, ...comps);
    addCost(cls, 1);
  };

  for (const e of scene.ents) {
    emit(e.cls, e.uid, { rotation: quat(e.yaw), translation: e.pos, scale3d: { x: 1, y: 1, z: 1 } }, (ent, comps) => {
      if (!e.recipe) return;
      const r = gd.recipes[e.recipe];
      setProp(ent.properties, 'mCurrentRecipe', objSample, { levelName: '', pathName: r.path });
      if (Math.abs(e.clock - 1) > 1e-6) {
        setProp(ent.properties, 'mCurrentPotential', floatSample, e.clock);
        setProp(ent.properties, 'mPendingPotential', floatSample, e.clock);
      }
      configureInventories(gd, comps, r);
    });
  }
  for (const b of beltEnts) {
    const sp = splineFor(b.pts);
    const origin = b.pts[0];
    emit(b.cls, b.uid, { rotation: { x: 0, y: 0, z: 0, w: 1 }, translation: { x: origin.x, y: origin.y, z: origin.z }, scale3d: { x: 1, y: 1, z: 1 } }, (ent) => {
      const arr = ent.properties.mSplineData;
      const proto = arr.values[0];
      arr.values = sp.map((s) => {
        const v = clone(proto);
        v.properties.Location.value = s.loc;
        v.properties.ArriveTangent.value = s.arrive;
        v.properties.LeaveTangent.value = s.leave;
        return v;
      });
    });
    // belts cost per metre of length
    const len = b.pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - b.pts[i - 1].x, p.y - b.pts[i - 1].y, p.z - b.pts[i - 1].z) : 0), 0) / 100;
    costs.__beltM = (costs.__beltM || 0) + len;
  }
  // belt costs: the cost of one build-gun belt unit per metre
  const beltR = gd.recipes[gd.buildings[`Build_ConveyorBeltMk${beltTier}_C`]?.buildRecipe];
  if (beltR) for (const i of beltR.ingredients) costs[i.item] = (costs[i.item] || 0) + Math.ceil(costs.__beltM * i.amount);
  const beltMetres = costs.__beltM || 0;
  delete costs.__beltM;
  // the beltR cost above double-counts one unit per belt entity from emit(); remove it
  for (const i of beltR?.ingredients || []) costs[i.item] -= i.amount * beltEnts.length;

  const header = clone(T.header);
  header.itemCosts = Object.entries(costs).filter(([, n]) => n > 0).map(([item, n]) => [{ levelName: '', pathName: gd.items[item]?.path || item }, Math.ceil(n)]);
  header.recipeReferences = [...recipeRefs].map((p) => ({ levelName: '', pathName: p }));
  const config = clone(T.config);
  config.description = (description || '').slice(0, 1000);
  config.lastEditedByLegacy = [];
  return { name, compressionInfo: clone(T.compressionInfo), header, config, objects, stats: { machines: scene.ents.filter((e) => e.recipe).length, attachments: scene.ents.filter((e) => !e.recipe).length, belts: beltEnts.length, beltMetres: Math.round(beltMetres) } };
}

function configureInventories(gd, comps, recipe) {
  const pathOf = (item) => gd.items[item]?.path || '';
  const fill = (comp, items, padTo) => {
    if (!comp?.properties?.mInventoryStacks) return;
    const stacks = comp.properties.mInventoryStacks.values;
    const proto = stacks[0];
    const n = Math.max(items.length, padTo || 0, 1);
    comp.properties.mInventoryStacks.values = Array.from({ length: n }, () => clone(proto));
    if (comp.properties.mArbitrarySlotSizes) comp.properties.mArbitrarySlotSizes.values = Array.from({ length: n }, () => 0);
    if (comp.properties.mAllowedItemDescriptors) {
      comp.properties.mAllowedItemDescriptors.values = Array.from({ length: n }, (_, i) => ({ levelName: '', pathName: items[i] ? pathOf(items[i]) : '/Script/FactoryGame.FGItemDescriptor' }));
    }
  };
  const byName = (n) => comps.find((c) => c.instanceName.endsWith(`.${n}`));
  fill(byName('InputInventory'), recipe.ingredients.map((i) => i.item));
  const out = byName('OutputInventory');
  fill(out, recipe.products.map((p) => p.item), out?.properties?.mInventoryStacks?.values.length);
}

/** A template for a machine class we have no sample of: derived from the Constructor template. */
function synthesize(gd, T, cls) {
  const base = T.classes.Build_ConstructorMk1_C;
  if (!base) throw new Error(`No template for ${cls}`);
  const t = clone(base);
  const oldName = t.entity.instanceName;
  const newName = `Persistent_Level:PersistentLevel.${cls}_0`;
  const fix = (s) => s.split(oldName).join(newName);
  const json = fix(JSON.stringify(t, (k, v) => (typeof v === 'bigint' ? { __bigint: v.toString() } : v)));
  const out = JSON.parse(json, (k, v) => (v && typeof v === 'object' && '__bigint' in v ? BigInt(v.__bigint) : v));
  out.entity.typePath = gd.buildings[cls]?.path || out.entity.typePath;
  // keep generic components, replace belt connection components with this class's ports
  const ports = Object.keys(portsFor(cls)).filter((n) => /^(Input|Output)\d/.test(n));
  const proto = out.components.find((c) => /FactoryConnection/.test(c.typePath));
  out.components = out.components.filter((c) => !/FactoryConnection|PowerConnection/.test(c.typePath));
  for (const p of ports) {
    const c = clone(proto);
    c.instanceName = `${newName}.${p}`;
    out.components.push(c);
  }
  out.entity.components = out.components.map((c) => ({ levelName: 'Persistent_Level', pathName: c.instanceName }));
  out.synthesized = true;
  return out;
}

/** Writes <dir>/<name>.sbp + .sbpcfg. Returns paths. */
export function writeBlueprint(bp, dir) {
  const chunks = [];
  let headerBytes = null;
  const { configFileBinary } = Parser.WriteBlueprintFiles(bp, (h) => { headerBytes = h; }, (c) => chunks.push(c));
  const main = Buffer.concat([Buffer.from(headerBytes), ...chunks.map((c) => Buffer.from(c))]);
  const safe = bp.name.replace(/[<>:"/\\|?*]+/g, '-').slice(0, 60);
  const sbp = path.join(dir, `${safe}.sbp`);
  fs.writeFileSync(sbp, main);
  fs.writeFileSync(`${sbp}cfg`, Buffer.from(configFileBinary));
  return { sbp, sbpcfg: `${sbp}cfg` };
}

/** Builds and writes one blueprint per floor for a layout. */
export function exportBlueprints(gd, plan, layout, dir, { baseName } = {}) {
  if (!layout.internal) throw new Error('Layout has no routing data; regenerate it.');
  const ports = knownPorts();
  const tier = Number((plan.logistics.belt || '').match(/Mk\.?(\d)/)?.[1] || 1);
  const results = [];
  layout.floors.forEach((f, i) => {
    const scene = buildFloorScene(gd, plan, layout, i, ports);
    const name = `${baseName || layout.title}${layout.floors.length > 1 ? ` - floor ${f.index}` : ''}`.slice(0, 60);
    const bp = sceneToBlueprint(gd, scene, { name, description: `${layout.title}. Floor ${f.index}. Generated by Satisfactory Factory Planner.`, beltTier: tier });
    const files = writeBlueprint(bp, dir);
    const size = { x: Math.ceil(f.width), y: Math.ceil(f.usedLength) };
    results.push({ floor: f.index, name, ...files, stats: bp.stats, sizeM: size, warnings: [...scene.warnings] });
  });
  return results;
}

export { buildFloorScene };
void footprint;
