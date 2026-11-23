// Port geometry (local offsets of belt connection points) for each building class.
// Learned from real belts in your saves: every connected belt end sits exactly on the port it plugs into.
// Learned values are cached in cache/ports.json; DEFAULT_PORTS covers classes you have not belted yet.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ensureDir } from '../config.js';

const PORT_CACHE = path.join(ROOT, 'data', 'ports.json');

/**
 * Local frame: X = building forward (cm), Y = right, Z = up. dir = unit vector of item flow at the port, local.
 * Defaults are estimates (marked estimated:true); learned values replace them.
 */
export const DEFAULT_PORTS = {
  // splitter / merger: 2 m box, ports on its four faces at belt height (center of the attachment)
  Build_ConveyorAttachmentSplitter_C: {
    Input1: { x: -100, y: 0, z: 0, dir: [1, 0, 0] },
    Output1: { x: 0, y: -100, z: 0, dir: [0, -1, 0] },
    Output2: { x: 100, y: 0, z: 0, dir: [1, 0, 0] },
    Output3: { x: 0, y: 100, z: 0, dir: [0, 1, 0] },
  },
  Build_ConveyorAttachmentMerger_C: {
    Input1: { x: 0, y: -100, z: 0, dir: [0, 1, 0] },
    Input2: { x: -100, y: 0, z: 0, dir: [1, 0, 0] },
    Input3: { x: 0, y: 100, z: 0, dir: [0, -1, 0] },
    Output1: { x: 100, y: 0, z: 0, dir: [1, 0, 0] },
  },
};

/**
 * Estimates for machines with no belted sample in any save. Same convention as the learned data:
 * items flow along local +Y (inputs at -Y, outputs at +Y), X is lateral, ports 1 m above the floor.
 */
const ESTIMATED_MACHINES = {
  Build_SmelterMk1_C: { inY: -300, outY: 200, inputs: [0], outputs: [0], outputNames: ['Output2'] },
  Build_ConstructorMk1_C: { inY: -300, outY: 300, inputs: [0], outputs: [0] },
  Build_AssemblerMk1_C: { inY: -600, outY: 500, inputs: [200, -200], outputs: [0] },
  Build_FoundryMk1_C: { inY: -300, outY: 200, inputs: [200, -200], outputs: [-200], outputNames: ['Output2'] },
  Build_ManufacturerMk1_C: { inY: -875, outY: 800, inputs: [600, 200, -200, -600], outputs: [0] },
  Build_Packager_C: { inY: -300, outY: 300, inputs: [200], outputs: [200] },
  Build_Blender_C: { inY: -700, outY: 700, inputs: [200, -200], outputs: [200] },
  Build_HadronCollider_C: { inY: -1800, outY: 1800, inputs: [200, -200], outputs: [0] },
  Build_Converter_C: { inY: -700, outY: 700, inputs: [200, -200], outputs: [200, -200] },
  Build_QuantumEncoder_C: { inY: -2300, outY: 2300, inputs: [200, 0, -200], outputs: [200, -200] },
};

function estimated(cls) {
  const e = ESTIMATED_MACHINES[cls];
  if (!e) return null;
  const out = {};
  e.inputs.forEach((x, i) => { out[`Input${i}`] = { x, y: e.inY, z: 100, dir: [0, 1, 0], estimated: true }; });
  e.outputs.forEach((x, i) => { out[(e.outputNames || [])[i] || `Output${i}`] = { x, y: e.outY, z: 100, dir: [0, 1, 0], estimated: true }; });
  return out;
}

const yawOf = (q) => Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
function toLocal(v, origin, yaw) {
  const dx = v.x - origin.x;
  const dy = v.y - origin.y;
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  return { x: dx * c - dy * s, y: dx * s + dy * c, z: v.z - origin.z };
}
function rotDir(d, yaw) {
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  return [d.x * c - d.y * s, d.x * s + d.y * c, d.z];
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const norm = (v) => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };

/** Learn port offsets from all belts in a parsed save. Returns { cls: { port: {x,y,z,dir,samples} } }. */
export function learnPorts(save) {
  const objs = Object.values(save.levels).flatMap((l) => l.objects);
  const byName = new Map(objs.map((o) => [o.instanceName, o]));
  const samples = {};
  for (const belt of objs) {
    if (!/Build_ConveyorBeltMk\d_C$/.test(belt.typePath)) continue;
    const pts = (belt.properties?.mSplineData?.values || []).map((p) => ({
      loc: p.properties?.Location?.value, arrive: p.properties?.ArriveTangent?.value, leave: p.properties?.LeaveTangent?.value,
    }));
    if (pts.length < 2) continue;
    const t = belt.transform;
    const yawB = yawOf(t.rotation);
    const world = (v) => {
      const c = Math.cos(yawB);
      const s = Math.sin(yawB);
      return { x: t.translation.x + v.x * c - v.y * s, y: t.translation.y + v.x * s + v.y * c, z: t.translation.z + v.z };
    };
    const worldDir = (v) => { const c = Math.cos(yawB); const s = Math.sin(yawB); return norm({ x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z }); };
    for (const end of ['ConveyorAny0', 'ConveyorAny1']) {
      const comp = byName.get(`${belt.instanceName}.${end}`);
      const target = comp?.properties?.mConnectedComponent?.value?.pathName;
      if (!target) continue;
      const portName = target.split('.').pop();
      const owner = byName.get(target)?.parentEntityName || target.replace(/\.[^.]+$/, '');
      const b = byName.get(owner);
      if (!b?.transform || /ConveyorBelt|ConveyorLift/.test(b.typePath)) continue;
      const p = end === 'ConveyorAny0' ? pts[0] : pts[pts.length - 1];
      const dirWorld = worldDir(end === 'ConveyorAny0' ? p.leave : p.arrive);
      const yaw = yawOf(b.transform.rotation);
      const local = toLocal(world(p.loc), b.transform.translation, yaw);
      const cls = b.typePath.split('.').pop();
      ((samples[cls] ||= {})[portName] ||= []).push({ ...local, dir: rotDir(dirWorld, yaw) });
    }
  }
  const out = {};
  for (const [cls, ports] of Object.entries(samples)) {
    out[cls] = {};
    for (const [name, list] of Object.entries(ports)) {
      out[cls][name] = {
        x: Math.round(median(list.map((s) => s.x))), y: Math.round(median(list.map((s) => s.y))), z: Math.round(median(list.map((s) => s.z))),
        dir: [0, 1, 2].map((i) => Math.round(median(list.map((s) => s.dir[i])) * 1000) / 1000),
        samples: list.length,
      };
    }
  }
  return out;
}

/** Merge newly learned ports into the cache. */
export function rememberPorts(learned) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(PORT_CACHE, 'utf8')); } catch { /* new */ }
  for (const [cls, ports] of Object.entries(learned)) {
    cache[cls] ||= {};
    for (const [name, p] of Object.entries(ports)) if (!cache[cls][name] || cache[cls][name].samples <= p.samples) cache[cls][name] = p;
  }
  ensureDir(path.dirname(PORT_CACHE));
  fs.writeFileSync(PORT_CACHE, JSON.stringify(cache, null, 1));
  return cache;
}

export function knownPorts() {
  try { return JSON.parse(fs.readFileSync(PORT_CACHE, 'utf8')); } catch { return {}; }
}

/** Port table for a class: learned > default > estimated. */
export function portsFor(cls, learned = knownPorts()) {
  return { ...(estimated(cls) || {}), ...(DEFAULT_PORTS[cls] || {}), ...(learned[cls] || {}) };
}
