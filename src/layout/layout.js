// Turns a production plan into a buildable top-down layout (per floor):
// machine rows with input/output manifolds, a belt corridor that routes every connection,
// splitters/mergers where flows split or join, lifts between floors, foundations and a bill of materials.
// Every belt drawn carries at most the capacity of your best unlocked belt tier.
import { footprint, machinePitch, FOUNDATION, LANE_SPACING } from '../gamedata/footprints.js';
import { isFluid, itemName } from '../gamedata/loader.js';

const r2 = (x) => Math.round(x * 100) / 100;
const ceilTo = (x, m) => Math.ceil(x / m - 1e-9) * m;

/**
 * @param plan  result of planProduction (ok: true)
 * @param opts  { mode: 'foundation'|'ground', width, length, unit: 'm'|'foundations', floors: number|'auto',
 *                foundationThickness: 1|2|4, maxMachinesPerRow, title }
 */
export function generateLayout(gd, plan, opts = {}, model = null) {
  if (!plan?.ok) throw new Error('generateLayout needs a successful plan.');
  const unit = opts.unit === 'foundations' ? FOUNDATION : 1;
  const mode = opts.mode === 'ground' ? 'ground' : 'foundation';
  const beltCap = plan.logistics.beltCap;
  const pipeCap = plan.logistics.pipeCap;
  const capFor = (item) => (isFluid(gd, item) ? pipeCap : beltCap);
  const warnings = [];
  const maxPerRowOpt = opts.maxMachinesPerRow || 10;
  let floorsOpt = opts.floors === undefined || opts.floors === 'auto' ? 'auto' : Math.max(1, Number(opts.floors));
  if (mode === 'ground' && floorsOpt === 'auto') floorsOpt = 1;

  const steps = plan.steps;
  const gap = Math.max(0, Number(opts.machineGap) || 0); // extra walking space between machines (m)
  const widestPitch = Math.max(...steps.map((s) => machinePitch(s.building))) + gap;
  let W = opts.width ? Number(opts.width) * unit : null;
  let L = opts.length ? Number(opts.length) * unit : null;
  if (mode === 'foundation') {
    if (W) W = ceilTo(W, FOUNDATION);
    if (L) L = ceilTo(L, FOUNDATION);
  }

  let busW = opts.module ? 2 : 8; // a stand-alone module needs no belt corridor
  let result;
  for (let iter = 0; iter < 6; iter++) {
    const width = W ?? ceilTo(busW + 2 + Math.min(maxPerRowOpt, Math.max(...steps.map((s) => s.machines))) * widestPitch + 2, mode === 'foundation' ? FOUNDATION : 2);
    result = buildOnce({ gd, plan, steps, width, length: L, busW, floorsOpt, maxPerRowOpt, capFor, mode, gap });
    const needed = ceilTo(result.trackCount * LANE_SPACING + 4, 2);
    if (needed <= busW) break;
    busW = needed;
  }
  const { rows, floors, lanes, conns, sources, sinks, width, fits } = result;
  if (W && result.tooNarrow) warnings.push(`Width ${W} m is too narrow: one ${result.tooNarrow.name} row plus the ${busW} m belt corridor needs at least ${result.tooNarrow.minWidth} m.`);
  if (!fits) {
    const single = ceilTo(result.totalLength, FOUNDATION);
    warnings.push(`Does not fit in ${floors.length} floor(s) of ${result.length} m at ${width} m wide: it needs about ${single} m of length on one floor${mode === 'ground' ? ' — make the area longer/wider, or switch to a foundation build so it can stack floors' : ', or more floors/width'}. The red zone in the sketch is outside your area.`);
  }
  if (mode === 'ground' && floors.length > 1) warnings.push('Ground build with more than one floor: upper floors need foundations anyway.');

  // ---------- geometry for rendering ----------
  const floorH = floors.map((f) => ceilTo(Math.max(...f.rows.map((r) => footprint(r.step.building).h), 4) + 4, 4));
  const elements = floors.map(() => ({ belts: [], splitters: [], mergers: [], lifts: [], labels: [], machines: [], rows: [] }));
  const beltLen = {};
  const addBelt = (floor, pts, item, rate, kind = 'belt', meta = {}) => {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
    const fluid = isFluid(gd, item);
    const key = fluid ? plan.logistics.pipe || 'Pipeline' : plan.logistics.belt || 'Conveyor Belt';
    beltLen[key] = (beltLen[key] || 0) + len;
    elements[floor].belts.push({ pts, item, name: itemName(gd, item), rate: r2(rate), fluid, kind, ...meta });
  };

  let manifoldSplitters = 0;
  let manifoldMergers = 0;
  for (const row of rows) {
    const el = elements[row.floor];
    el.rows.push({ id: row.id, label: row.label, short: row.shortLabel, x: row.x0, y: row.y0, w: row.x1 - row.x0, h: row.height, step: row.step.id, labelOffset: row.labelOffset || 0 });
    for (const m of row.machines) el.machines.push(m);
    for (const line of row.inLines) {
      const lastPort = line.ports[line.ports.length - 1];
      addBelt(row.floor, [[busW, line.y], [lastPort, line.y], [lastPort, row.yMach]], line.item, line.rate, 'manifold-in');
      line.ports.slice(0, -1).forEach((px) => {
        el.splitters.push({ x: px, y: line.y, item: line.item });
        addBelt(row.floor, [[px, line.y], [px, row.yMach]], line.item, line.perMachine, 'feed');
        manifoldSplitters++;
      });
    }
    for (const line of row.outLines) {
      const lastPort = line.ports[line.ports.length - 1];
      const top = row.yMach + row.l;
      addBelt(row.floor, [[lastPort, top], [lastPort, line.y], [busW, line.y]], line.item, line.rate, 'manifold-out');
      line.ports.slice(0, -1).forEach((px) => {
        el.mergers.push({ x: px, y: line.y, item: line.item });
        addBelt(row.floor, [[px, top], [px, line.y]], line.item, line.perMachine, 'feed');
        manifoldMergers++;
      });
    }
  }

  // corridor routing
  let corridorSplitters = 0;
  let corridorMergers = 0;
  let liftCount = 0;
  const liftHeights = [];
  const incomingBySink = new Map();
  for (const c of conns) (incomingBySink.get(c.sink) || incomingBySink.set(c.sink, []).get(c.sink)).push(c);
  for (const lane of lanes) {
    const src = sources[lane.source];
    const myConns = conns.filter((c) => c.source === lane.source);
    const x = lane.x;
    // exit from the source into the lane
    if (src.kind === 'row') addBelt(src.floor, [[busW, src.y], [x, src.y]], src.item, src.rate, 'corridor');
    const perFloor = new Map();
    const touch = (f, y) => (perFloor.get(f) || perFloor.set(f, []).get(f)).push(y);
    touch(src.floor, src.y);
    const liftTargets = new Set();
    for (const c of myConns) {
      const sk = sinks[c.sink];
      touch(sk.floor, sk.y);
      if (sk.floor !== src.floor) { touch(sk.floor, src.y); liftTargets.add(sk.floor); }
    }
    for (const [f, ys] of perFloor) {
      const lo = Math.min(...ys);
      const hi = Math.max(...ys);
      if (hi - lo > 0.01) {
        // flow runs away from the source (or from the lift, which sits at the source's y)
        const pts = Math.abs(src.y - lo) <= Math.abs(src.y - hi) ? [[x, lo], [x, hi]] : [[x, hi], [x, lo]];
        addBelt(f, pts, src.item, src.rate, 'corridor');
      }
    }
    for (const tf of liftTargets) {
      const h = Math.abs(floorBase(floorH, tf) - floorBase(floorH, src.floor));
      elements[src.floor].lifts.push({ x, y: src.y, dir: tf > src.floor ? 'up' : 'down', toFloor: tf + 1, item: src.item, height: h });
      elements[tf].lifts.push({ x, y: src.y, dir: 'arrive', fromFloor: src.floor + 1, item: src.item, height: h });
      liftCount++;
      liftHeights.push(h);
    }
    const branches = myConns.length + (liftTargets.size ? 0 : 0);
    if (branches > 1) {
      corridorSplitters += branches - 1;
      myConns.slice(0, -1).forEach((c) => { const sk = sinks[c.sink]; elements[sk.floor].splitters.push({ x, y: sk.y, item: src.item, corridor: true }); });
    }
    for (const c of myConns) {
      const sk = sinks[c.sink];
      const ins = incomingBySink.get(c.sink);
      const mergeX = busW - 1;
      if (sk.kind === 'row') {
        addBelt(sk.floor, [[x, sk.y], [ins.length > 1 ? mergeX : busW, sk.y]], src.item, c.rate, 'corridor');
      } else {
        // outputs / surplus leave through the top edge of the floor
        addBelt(sk.floor, [[x, sk.y], [x, sk.y + 2]], src.item, c.rate, 'corridor');
      }
    }
  }
  for (const [sinkIdx, ins] of incomingBySink) {
    const sk = sinks[sinkIdx];
    if (ins.length > 1 && sk.kind === 'row') {
      elements[sk.floor].mergers.push({ x: busW - 1, y: sk.y, item: sk.item, corridor: true });
      addBelt(sk.floor, [[busW - 1, sk.y], [busW, sk.y]], sk.item, sk.rate, 'corridor');
      corridorMergers += ins.length - 1;
    }
  }
  // labels for raw inputs and outputs
  for (const s of sources) if (s.kind !== 'row' && s.lane != null) elements[s.floor].labels.push({ x: lanes[s.lane].x, y: s.y, text: `IN ${s.label}`, kind: 'input', item: s.item, rate: r2(s.rate) });
  for (const sk of sinks) if (sk.kind !== 'row') elements[sk.floor].labels.push({ x: lanesForSink(conns, lanes, sinks.indexOf(sk)), y: sk.y + 2, text: `${sk.kind === 'output' ? 'OUT' : 'SURPLUS'} ${sk.name} ${r2(sk.rate)}/min`, kind: sk.kind, item: sk.item, rate: r2(sk.rate) });

  // ---------- bill of materials ----------
  const machineCount = {};
  for (const s of steps) machineCount[s.buildingName] = (machineCount[s.buildingName] || 0) + s.machines;
  const usedLen = floors.map((f) => (fits ? Math.min(result.length ?? f.usedLength, ceilTo(f.usedLength, mode === 'foundation' ? FOUNDATION : 1)) : ceilTo(f.usedLength, FOUNDATION)));
  const floorsOut = floors.map((f, i) => ({
    index: i + 1,
    width,
    length: result.length ?? ceilTo(f.usedLength, mode === 'foundation' ? FOUNDATION : 2),
    usedLength: r2(f.usedLength),
    elevation: floorBase(floorH, i),
    heightToNext: floorH[i],
    foundations: mode === 'foundation' || i > 0 ? Math.ceil(width / FOUNDATION) * Math.ceil(usedLen[i] / FOUNDATION) : 0,
    rows: f.rows.map((r) => r.id),
  }));
  const foundations = floorsOut.reduce((s, f) => s + f.foundations, 0);
  const thickness = Number(opts.foundationThickness) || 1;
  const fRecipe = gd.recipes[`Recipe_Foundation_8x${thickness}_01_C`] || gd.recipes.Recipe_Foundation_8x1_01_C;
  const totalMachines = steps.reduce((s, x) => s + x.machines, 0);
  const pole = model?.unlocks?.has?.('Build_PowerPoleMk2_C') ? gd.buildings.Build_PowerPoleMk2_C : gd.buildings.Build_PowerPoleMk1_C;
  const poleConns = pole?.id === 'Build_PowerPoleMk2_C' ? 7 : 4;
  const poles = rows.reduce((s, r) => s + Math.ceil(r.machines.length / (poleConns - 1)), 0) + floors.length;
  const bom = {
    machines: machineCount,
    splitters: manifoldSplitters + corridorSplitters,
    mergers: manifoldMergers + corridorMergers,
    belts: Object.fromEntries(Object.entries(beltLen).map(([k, v]) => [k, Math.round(v * 1.1)])),
    lifts: liftCount ? { count: liftCount, type: model?.unlocks?.lift?.name || 'Conveyor Lift', heights: liftHeights } : null,
    foundations: foundations ? { count: foundations, type: fRecipe?.name || `Foundation (${thickness} m)` } : null,
    powerPoles: { count: poles, type: pole?.name || 'Power Pole' },
    powerMW: plan.totals.powerMW,
  };
  const materials = {};
  const addMat = (recipeId, n) => { for (const i of gd.recipes[recipeId]?.ingredients || []) materials[i.item] = (materials[i.item] || 0) + i.amount * n; };
  for (const s of steps) addMat(gd.buildings[s.building]?.buildRecipe, s.machines);
  addMat('Recipe_ConveyorAttachmentSplitter_C', bom.splitters);
  addMat('Recipe_ConveyorAttachmentMerger_C', bom.mergers);
  if (fRecipe && foundations) addMat(fRecipe.id, foundations);
  if (pole?.buildRecipe) addMat(pole.buildRecipe, poles);
  for (const n of plan.nodes.filter((x) => x.kind === 'node')) addMat(gd.buildings[n.buildingId]?.buildRecipe, 1);
  bom.materials = Object.entries(materials).map(([k, v]) => ({ item: k, name: itemName(gd, k), amount: Math.ceil(v), have: model ? Math.floor(model.inventoryTotals[k] || 0) : null }));

  const layout = {
    title: opts.title || `${plan.targets.map((t) => `${t.rate}/min ${t.name}`).join(' + ') || plan.maximized?.name} factory`,
    mode,
    unitNote: 'metres; 1 foundation = 8 m × 8 m',
    width,
    busWidth: busW,
    beltCap,
    belt: plan.logistics.belt,
    floors: floorsOut,
    rows: rows.map((r) => ({ id: r.id, floor: r.floor + 1, step: r.step.id, recipe: r.step.recipeName, building: r.step.buildingName, machines: r.machines.length, clockPercent: r.step.clockPercent, y: r.y0, x: r.x0, inputLines: r.inLines.map((l) => ({ item: l.name, rate: r2(l.rate), feeds: l.ports.length })), outputLines: r.outLines.map((l) => ({ item: l.name, rate: r2(l.rate), collects: l.ports.length })) })),
    connections: conns.map((c) => ({ from: sources[c.source].label, to: sinks[c.sink].label, item: itemName(gd, sources[c.source].item), rate: r2(c.rate), lane: sources[c.source].lane })),
    bom,
    elements,
    warnings: [...plan.warnings, ...warnings],
    fits,
  };
  layout.buildSteps = buildGuide(gd, plan, layout, rows, sources, sinks, conns, lanes);
  // routing internals for the blueprint exporter (not serialised into layout.json)
  Object.defineProperty(layout, 'internal', { value: { rows, floors, sources, sinks, conns, lanes, busW }, enumerable: false });
  return layout;
}

function floorBase(floorH, i) { let s = 0; for (let k = 0; k < i; k++) s += floorH[k]; return s; }
function lanesForSink(conns, lanes, sinkIdx) {
  const c = conns.find((x) => x.sink === sinkIdx);
  return c ? lanes.find((l) => l.source === c.source)?.x ?? 0 : 0;
}

function buildOnce({ gd, plan, steps, width, length, busW, floorsOpt, maxPerRowOpt, capFor, gap = 0 }) {
  const x0 = busW + 2;
  const rows = [];
  let tooNarrow = null;
  // 1) chunk steps into rows that fit the width
  for (const s of steps) {
    const fp = footprint(s.building);
    const pitch = machinePitch(s.building) + gap;
    const fit = Math.floor((width - x0 - 2) / pitch);
    if (fit < 1) tooNarrow = { name: s.buildingName, minWidth: ceilTo(x0 + pitch + 2, FOUNDATION) };
    const perRow = Math.max(1, Math.min(fit, maxPerRowOpt));
    const nRows = Math.ceil(s.machines / perRow);
    const base = Math.floor(s.machines / nRows);
    let extra = s.machines % nRows;
    for (let k = 0; k < nRows; k++) {
      const n = base + (extra-- > 0 ? 1 : 0);
      rows.push(makeRow(gd, s, n, fp, pitch, x0, capFor, rows.length));
    }
  }
  // 2) pack small row segments side by side into bands, then stack bands on floors
  const avail = width - x0 - 2;
  const bands = [];
  for (const row of rows) {
    const w = row.n * row.pitch;
    const b = bands[bands.length - 1];
    if (b && b.segments.length < 4 && b.width + 4 + w <= avail) { b.segments.push(row); b.width += 4 + w; }
    else bands.push({ segments: [row], width: w });
  }
  for (const b of bands) {
    const nIn = b.segments.reduce((s, r) => s + r.inLines.length, 0);
    const nOut = b.segments.reduce((s, r) => s + r.outLines.length, 0);
    b.inBand = nIn * LANE_SPACING + 2;
    b.outBand = nOut * LANE_SPACING + 2;
    b.maxL = Math.max(...b.segments.map((r) => r.l));
    b.height = b.inBand + b.maxL + b.outBand + 6;
  }
  const floors = [{ rows: [], usedLength: 0 }];
  let y = 4;
  let fits = true;
  const maxFloors = floorsOpt === 'auto' ? 8 : floorsOpt;
  for (const band of bands) {
    if (length && y + band.height > length - 4 && floors[floors.length - 1].rows.length) {
      if (floors.length < maxFloors) { floors.push({ rows: [], usedLength: 0 }); y = 4; }
      else fits = false;
    }
    placeBand(band, y, x0, floors.length - 1);
    floors[floors.length - 1].rows.push(...band.segments);
    y += band.height;
    floors[floors.length - 1].usedLength = y + 4;
  }
  const minLength = ceilTo(Math.max(...bands.map((b) => b.height)) + 8, FOUNDATION);
  if (length && floors.some((f) => f.usedLength > length + 0.01)) fits = false;

  // 3) terminals
  const sources = [];
  const sinks = [];
  const rowStep = (id) => rows.filter((r) => r.step.id === id);
  for (const n of plan.nodes) {
    if (n.kind === 'water') {
      const per = n.rate / n.count;
      for (let i = 0; i < n.count; i++) sources.push({ kind: 'raw', item: n.resource, rate: per, floor: 0, y: 0, label: `${itemName(gd, n.resource)} ${r2(per)}/min (Water Extractor ${i + 1})` });
      continue;
    }
    sources.push({ kind: 'raw', item: n.resource, rate: n.rate, floor: 0, y: 0, label: `${n.name} ${r2(n.rate)}/min — ${n.kind === 'existing-spare' ? 'tap existing miner' : `${n.building} on ${n.purity} node`} (${n.where || n.node})` });
  }
  for (const i of plan.inputsUsed || []) sources.push({ kind: 'input', item: i.item, rate: i.rate, floor: 0, y: 0, label: `${i.name} ${r2(i.rate)}/min (your supply)` });
  for (const row of rows) {
    for (const l of row.outLines) sources.push({ kind: 'row', item: l.item, rate: l.rate, floor: row.floor, y: l.y, rowId: row.id, label: `${row.id} ${l.name}` });
    for (const l of row.inLines) sinks.push({ kind: 'row', item: l.item, rate: l.rate, floor: row.floor, y: l.y, rowId: row.id, label: `${row.id} ${l.name}`, name: l.name });
  }
  // split raw supply larger than one belt into several belts
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const cap = capFor(s.item);
    if (s.kind !== 'row' && s.rate > cap + 0.01) {
      const n = Math.ceil(s.rate / cap);
      s.rate /= n;
      for (let k = 1; k < n; k++) sources.splice(i + 1, 0, { ...s });
    }
  }
  const topY = (floor) => floors[floor].usedLength - 2;
  for (const t of plan.targets) {
    const cap = capFor(t.item);
    const n = Math.ceil(t.rate / cap - 1e-9);
    const lastRow = [...rows].reverse().find((r) => r.outLines.some((l) => l.item === t.item));
    const f = lastRow ? lastRow.floor : floors.length - 1;
    for (let k = 0; k < n; k++) sinks.push({ kind: 'output', item: t.item, rate: t.rate / n, floor: f, y: topY(f), name: itemName(gd, t.item), label: `OUTPUT ${itemName(gd, t.item)}` });
  }
  if (plan.maximized) {
    const lastRow = [...rows].reverse().find((r) => r.outLines.some((l) => l.item === plan.maximized.item));
    const f = lastRow ? lastRow.floor : floors.length - 1;
    sinks.push({ kind: 'output', item: plan.maximized.item, rate: plan.maximized.rate, floor: f, y: topY(f), name: plan.maximized.name, label: `OUTPUT ${plan.maximized.name}` });
  }

  // 4) match sources to sinks per item (greedy, in build order)
  const conns = [];
  const left = sources.map((s) => s.rate);
  const order = (s) => (s.kind === 'row' ? rows.findIndex((r) => r.id === s.rowId) + 1 : 0);
  const items = [...new Set(sinks.map((s) => s.item))];
  for (const item of items) {
    const srcIdx = sources.map((s, i) => i).filter((i) => sources[i].item === item).sort((a, b) => order(sources[a]) - order(sources[b]));
    const skIdx = sinks.map((s, i) => i).filter((i) => sinks[i].item === item).sort((a, b) => (sinks[a].kind === 'row' ? order(sinks[a]) : 1e9) - (sinks[b].kind === 'row' ? order(sinks[b]) : 1e9));
    for (const k of skIdx) {
      let need = sinks[k].rate;
      for (const i of srcIdx) {
        if (need <= 0.001) break;
        if (left[i] <= 0.001) continue;
        // never feed a row from a row that comes after it (keeps flow going one way)
        const take = Math.min(need, left[i]);
        conns.push({ source: i, sink: k, rate: take });
        left[i] -= take;
        need -= take;
      }
    }
  }
  // leftovers -> surplus
  sources.forEach((s, i) => {
    if (left[i] > 0.05 && s.kind === 'row') {
      const f = s.floor;
      sinks.push({ kind: 'surplus', item: s.item, rate: left[i], floor: f, y: topY(f), name: itemName(gd, s.item), label: `SURPLUS ${itemName(gd, s.item)}` });
      conns.push({ source: i, sink: sinks.length - 1, rate: left[i] });
    }
  });

  // 5) corridor lanes. Channel routing: connections share a track (same x) when their north-south runs do not
  //    overlap, so the corridor stays narrow and belts stay short. Track 0 is nearest the machines.
  const G = (floor, y) => floor * 100000 + y;
  const spans = [];
  sources.forEach((s, i) => {
    const cs = conns.filter((c) => c.source === i);
    if (!cs.length) return;
    const ys = [G(s.floor, s.kind === 'row' ? s.y : -2)];
    for (const c of cs) {
      const k = sinks[c.sink];
      ys.push(G(k.floor, k.y - 2), G(k.floor, k.y + 2));
      if (k.floor !== s.floor) ys.push(G(k.floor, s.y));
    }
    spans.push({ i, lo: Math.min(...ys) - 2, hi: Math.max(...ys) + 2 });
  });
  const ordered = [...spans].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const trackEnd = [];
  for (const sp of ordered) {
    let t = trackEnd.findIndex((end) => end < sp.lo);
    if (t < 0) { t = trackEnd.length; trackEnd.push(-Infinity); }
    trackEnd[t] = sp.hi;
    sp.track = t;
  }
  const lanes = [];
  for (const sp of spans) {
    sources[sp.i].lane = lanes.length;
    lanes.push({ source: sp.i, track: sp.track, x: busW - 2 - sp.track * LANE_SPACING });
  }
  const totalLength = 4 + bands.reduce((s, b) => s + b.height, 0) + 4;
  return { rows, floors, sources, sinks, conns, lanes, trackCount: trackEnd.length, width, length, fits, minLength, tooNarrow, totalLength };
}

function makeRow(gd, step, n, fp, pitch, x0, capFor, index) {
  const solidOrAll = (list) => list;
  const ins = solidOrAll(step.perMachine.inputs);
  const outs = solidOrAll(step.perMachine.outputs);
  const lineGroups = (perMachineRate, item) => {
    const cap = capFor(item);
    const perLine = Math.max(1, Math.floor(cap / perMachineRate + 1e-9));
    const lines = Math.ceil(n / perLine);
    const base = Math.floor(n / lines);
    let extra = n % lines;
    const groups = [];
    let start = 0;
    for (let k = 0; k < lines; k++) {
      const size = base + (extra-- > 0 ? 1 : 0);
      groups.push([start, start + size - 1]);
      start += size;
    }
    return groups;
  };
  const inLines = [];
  ins.forEach((io, pi) => {
    for (const [a, b] of lineGroups(io.rate, io.item)) inLines.push({ item: io.item, name: io.name, portIndex: pi, nPorts: ins.length, from: a, to: b, perMachine: io.rate, rate: io.rate * (b - a + 1) });
  });
  const outLines = [];
  outs.forEach((io, pi) => {
    for (const [a, b] of lineGroups(io.rate, io.item)) outLines.push({ item: io.item, name: io.name, portIndex: pi, nPorts: outs.length, from: a, to: b, perMachine: io.rate, rate: io.rate * (b - a + 1) });
  });
  const inBand = inLines.length * LANE_SPACING + 2;
  const outBand = outLines.length * LANE_SPACING + 2;
  const gap = 4;
  return {
    id: `R${index + 1}`,
    step,
    n,
    w: fp.w,
    l: fp.l,
    pitch,
    x0,
    x1: x0 + n * pitch,
    inLines,
    outLines,
    inBand,
    outBand,
    height: inBand + fp.l + outBand + gap,
    label: `${step.id} ${step.recipeName} — ${n}× ${step.buildingName} @ ${step.clockPercent}%`,
    shortLabel: `${step.id} ${step.recipeName} ×${n} @${step.clockPercent}%`,
  };
}

/**
 * Places a band of row segments side by side. Lanes of the left-most segment sit closest to the
 * machines, so belts heading to segments further right run on outer lanes and never cross a feed.
 */
function placeBand(band, y0, x0, floor) {
  const yMach = y0 + band.inBand;
  let cursor = x0;
  let kIn = 0;
  let kOut = 0;
  band.segments.forEach((row, si) => {
    row.floor = floor;
    row.y0 = y0;
    row.height = band.height;
    row.yMach = yMach;
    row.x0 = cursor;
    row.x1 = cursor + row.n * row.pitch;
    row.labelOffset = si % 2;
    cursor = row.x1 + 4;
    row.machines = [];
    for (let j = 0; j < row.n; j++) {
      const mx = row.x0 + j * row.pitch + (row.pitch - row.w) / 2;
      row.machines.push({ x: mx, y: yMach, w: row.w, l: row.l, building: row.step.building, label: footprint(row.step.building).short, recipe: row.step.recipeName, clock: row.step.clockPercent, row: row.id, index: j + 1 });
    }
    const portX = (j, pi, nPorts) => row.machines[j].x + (row.w * (pi + 1)) / (nPorts + 1);
    for (const l of row.inLines) {
      l.y = yMach - 2 - kIn++ * LANE_SPACING;
      l.ports = [];
      for (let j = l.from; j <= l.to; j++) l.ports.push(portX(j, l.portIndex, l.nPorts));
    }
    for (const l of row.outLines) {
      l.y = yMach + band.maxL + 2 + kOut++ * LANE_SPACING;
      l.ports = [];
      for (let j = l.from; j <= l.to; j++) l.ports.push(portX(j, l.portIndex, l.nPorts));
    }
  });
}

function buildGuide(gd, plan, layout, rows, sources, sinks, conns, lanes) {
  const out = [];
  const L = layout;
  out.push(`Belt tier: ${plan.logistics.belt} (${plan.logistics.beltCap}/min). Every belt in this sketch carries ≤ ${plan.logistics.beltCap}/min.`);
  if (L.mode === 'foundation') {
    for (const f of L.floors) out.push(`Floor ${f.index}${f.elevation ? ` (+${f.elevation} m)` : ''}: lay ${Math.ceil(f.width / 8)} × ${Math.ceil(f.usedLength / 8)} foundations (${f.foundations} × ${L.bom.foundations?.type || 'Foundation'}).`);
  } else {
    out.push(`Ground build: pick a flat area of about ${L.width} × ${L.floors[0].length} m. The save does not contain terrain, so check slopes in-game (machine legs absorb small bumps).`);
  }
  out.push(`Keep the left ${L.busWidth} m as the belt corridor: one lane per source, 2 m apart.`);
  for (const r of rows) {
    const s = r.step;
    out.push(`Row ${r.id} (floor ${r.floor + 1}, x ${r.x0}–${r.x1} m, y ${r.yMach} m): place ${r.machines.length}× ${s.buildingName} for "${s.recipeName}"${r.machines.length > 1 ? ` ${r.pitch} m apart` : ''}, inputs facing south, set clock to ${s.clockPercent}%${s.clockAlt ? ` (or ${s.clockAlt})` : ''}.`);
    for (const l of r.inLines) {
      out.push(l.ports.length === 1
        ? `   ↳ input: ${l.name} ${r2(l.rate)}/min belt straight into machine ${l.from + 1}.`
        : `   ↳ input manifold: ${l.name} ${r2(l.rate)}/min feeding machines ${l.from + 1}–${l.to + 1} (${l.ports.length - 1} splitter${l.ports.length - 1 === 1 ? '' : 's'}, last machine takes the belt end).`);
    }
    for (const l of r.outLines) {
      out.push(l.ports.length === 1
        ? `   ↳ output: ${l.name} ${r2(l.rate)}/min belt from machine ${l.from + 1} to the corridor.`
        : `   ↳ output manifold: ${l.name} ${r2(l.rate)}/min from machines ${l.from + 1}–${l.to + 1} (${l.ports.length - 1} merger${l.ports.length - 1 === 1 ? '' : 's'}).`);
    }
  }
  for (const lane of lanes) {
    const s = sources[lane.source];
    const targets = conns.filter((c) => c.source === lane.source).map((c) => `${sinks[c.sink].label} ${r2(c.rate)}/min`);
    out.push(`Corridor lane ${lane.source + 1} (x=${lane.x} m): ${s.label} → ${targets.join(', ')}${targets.length > 1 ? ' — use a splitter at each branch' : ''}.`);
  }
  const multi = [...new Set(conns.map((c) => c.sink))].filter((k) => conns.filter((c) => c.sink === k).length > 1);
  for (const k of multi) out.push(`Merge ${conns.filter((c) => c.sink === k).length} lanes into ${sinks[k].label} with a merger at the corridor edge.`);
  out.push(`Power: ${L.bom.powerMW} MW. About ${L.bom.powerPoles.count} × ${L.bom.powerPoles.type}.`);
  return out;
}
