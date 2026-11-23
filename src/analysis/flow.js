// Steady-state flow estimate over the save's real belt graph.
// Supply flows forward from extractors through machines/splitters/mergers; demand flows backward
// from consumers. Each link carries min(offered, belt capacity, downstream demand).
const EPS = 1e-6;
const STACK = { SS_ONE: 1, SS_SMALL: 50, SS_MEDIUM: 100, SS_BIG: 200, SS_HUGE: 500, SS_FLUID: 50, SS_UNLIMITED: 1e9 };
export function stackSize(gd, item) { return STACK[gd.items[item]?.stackSize] ?? 100; }

/** 0..1 fill level of a storage container. */
export function storageFill(gd, e) {
  const slots = /Mk2/.test(e.cls) ? 48 : e.cls === 'Build_StorageIntegrated_C' ? 1e6 : 24;
  return Object.entries(e.storageInv || {}).reduce((s, [k, v]) => s + v / stackSize(gd, k), 0) / slots;
}

function fuelDemandPerMin(gd, e, item) {
  const it = gd.items[item];
  if (!it || !it.energyMJ) return 0;
  const b = gd.buildings[e.cls];
  if (b?.fuels?.length && !b.fuels.some((f) => f.fuel === item)) return 0;
  const mw = e.capacityMW || b?.powerProduction || 30;
  const mj = it.form === 'RF_SOLID' ? it.energyMJ : it.energyMJ * 1000; // fluids: energy per litre in docs
  return (mw / mj) * 60;
}

export function simulateFlow(model, gd, { iterations = 4 } = {}) {
  const ents = model.entities;
  const inLinks = new Map();
  const outLinks = new Map();
  for (const l of model.links) {
    if (!l.to) continue;
    (outLinks.get(l.from) || outLinks.set(l.from, []).get(l.from)).push(l);
    (inLinks.get(l.to) || inLinks.set(l.to, []).get(l.to)).push(l);
  }
  const eff = new Map(); // manufacturer effective run ratio (0..1)
  for (const e of ents.values()) if (e.category === 'manufacturer') eff.set(e.id, 1);

  // ---- demand (backward) ----
  let demandMemo;
  function demandOf(id, item, stack = new Set()) {
    const key = id + '|' + item;
    if (demandMemo.has(key)) return demandMemo.get(key);
    if (stack.has(id)) return 0;
    stack.add(id);
    const e = ents.get(id);
    let d = 0;
    if (!e) d = 0;
    else if (e.category === 'manufacturer') {
      const need = e.rates?.inputs.find((x) => x.item === item);
      d = need ? need.rate * (eff.get(id) ?? 1) : 0;
    } else if (e.category === 'generator') d = fuelDemandPerMin(gd, e, item);
    else if (e.category === 'sink') d = Infinity;
    else if (e.category === 'storage') {
      // a container is a buffer: it accepts everything until it is (nearly) full
      const outs = outLinks.get(id) || [];
      d = storageFill(gd, e) < 0.95 ? Infinity : outs.reduce((s, l) => s + linkDemand(l, item, stack), 0);
    } else if (e.category === 'splitter' || e.category === 'merger' || e.category === 'pipeJunction') {
      d = (outLinks.get(id) || []).reduce((s, l) => s + linkDemand(l, item, stack), 0);
    }
    stack.delete(id);
    demandMemo.set(key, d);
    return d;
  }
  function linkDemand(l, item, stack) {
    const cap = l.capacity ?? Infinity;
    return Math.min(cap, demandOf(l.to, item, stack));
  }

  // ---- topological order (cycles broken arbitrarily) ----
  const order = [];
  const indeg = new Map();
  for (const id of ents.keys()) indeg.set(id, (inLinks.get(id) || []).length);
  const queue = [...ents.keys()].filter((id) => indeg.get(id) === 0);
  const seen = new Set();
  while (order.length < ents.size) {
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      for (const l of outLinks.get(id) || []) {
        indeg.set(l.to, indeg.get(l.to) - 1);
        if (indeg.get(l.to) <= 0) queue.push(l.to);
      }
    }
    const rest = [...ents.keys()].find((id) => !seen.has(id));
    if (!rest) break;
    queue.push(rest);
  }

  let flows;
  for (let it = 0; it < iterations; it++) {
    demandMemo = new Map();
    flows = new Map(); // link -> {item: rate}
    const offered = new Map();
    const incoming = (id) => {
      const acc = {};
      for (const l of inLinks.get(id) || []) for (const [k, v] of Object.entries(flows.get(l) || {})) acc[k] = (acc[k] || 0) + v;
      return acc;
    };
    // water-fill an amount across links by their demand for that item
    const distribute = (links, item, amount, out) => {
      let remaining = amount;
      let open = links.map((l) => ({ l, want: linkDemand(l, item, new Set()) })).filter((x) => x.want > EPS);
      while (remaining > EPS && open.length) {
        const share = remaining / open.length;
        const next = [];
        for (const x of open) {
          const give = Math.min(share, x.want);
          out.set(x.l, (out.get(x.l) || 0) + give);
          x.want -= give;
          remaining -= give;
          if (x.want > EPS) next.push(x);
        }
        if (next.length === open.length && next.every((x) => x.want >= share - EPS)) break;
        open = next;
      }
      return remaining;
    };

    for (const id of order) {
      const e = ents.get(id);
      const outs = outLinks.get(id) || [];
      const inc = incoming(id);
      const produced = {};
      if (e.category === 'extractor') {
        if (e.resource) produced[e.resource] = e.potentialRate || 0;
      } else if (e.category === 'manufacturer' && e.rates) {
        let ratio = 1;
        for (const need of e.rates.inputs) {
          if (gd.items[need.item]?.form !== 'RF_SOLID') continue; // pipes not simulated
          ratio = Math.min(ratio, need.rate > 0 ? (inc[need.item] || 0) / need.rate : 1);
        }
        // output acceptance
        for (const p of e.rates.outputs) {
          if (gd.items[p.item]?.form !== 'RF_SOLID') continue;
          // unconnected output: keeps running until its internal buffer is full
          const bufferFree = !outs.length && (e.outputInv?.[p.item] || 0) < stackSize(gd, p.item) * 0.95;
          const accept = bufferFree ? Infinity : outs.reduce((s, l) => s + linkDemand(l, p.item, new Set()), 0);
          if (p.rate > 0) ratio = Math.min(ratio, accept / p.rate);
        }
        ratio = Math.max(0, Math.min(1, ratio));
        e._ratio = ratio;
        for (const p of e.rates.outputs) produced[p.item] = p.rate * ratio;
      } else if (['splitter', 'merger', 'pipeJunction'].includes(e.category)) {
        Object.assign(produced, inc);
      } else if (e.category === 'storage') {
        // stocked containers can supply what downstream asks for, otherwise they pass input through
        const items = new Set([...Object.keys(inc), ...Object.keys(e.storageInv || {})]);
        for (const item of items) {
          const want = outs.reduce((s, l) => s + linkDemand(l, item, new Set()), 0);
          produced[item] = (e.storageInv?.[item] || 0) > 0 ? Math.max(inc[item] || 0, Math.min(want, 1e6)) : inc[item] || 0;
        }
      }
      for (const [item, amount] of Object.entries(produced)) {
        if (!outs.length || amount <= EPS) continue;
        const alloc = new Map();
        // what would be offered with no belt cap: split evenly (for bottleneck reporting)
        for (const l of outs) offered.set(l, { ...(offered.get(l) || {}), [item]: amount / outs.length });
        distribute(outs, item, amount, alloc);
        for (const [l, v] of alloc) flows.set(l, { ...(flows.get(l) || {}), [item]: Math.min(v, l.capacity ?? Infinity) });
      }
    }
    // feed back effective ratios so upstream demand reflects real consumption
    let changed = false;
    for (const e of ents.values()) {
      if (e.category !== 'manufacturer' || e._ratio === undefined) continue;
      const prev = eff.get(e.id) ?? 1;
      // only lower demand because of output blockage, not input starvation
      const outLimited = (e.rates?.outputs || []).some((p) => {
        const outs = outLinks.get(e.id) || [];
        if (!outs.length) return (e.outputInv?.[p.item] || 0) >= stackSize(gd, p.item) * 0.95;
        const accept = outs.reduce((s, l) => s + linkDemand(l, p.item, new Set()), 0);
        return p.rate > 0 && accept / p.rate < 0.999;
      });
      const next = outLimited ? Math.max(e._ratio, 0) : 1;
      if (Math.abs(next - prev) > 1e-3) changed = true;
      eff.set(e.id, next);
    }
    // stash per-link offered for reporting
    for (const l of model.links) l._offered = offered.get(l) || {};
    if (!changed && it > 0) break;
  }

  for (const l of model.links) {
    const f = flows.get(l) || {};
    l.flow = Object.values(f).reduce((a, b) => a + b, 0);
    l.items = f;
    const offeredTotal = Object.values(l._offered || {}).reduce((a, b) => a + b, 0);
    const demandTotal = Object.keys(l._offered || {}).reduce((s, item) => s + Math.min(1e9, demandOf(l.to, item)), 0);
    l.beltLimited = l.capacity != null && offeredTotal > l.capacity + 0.01 && demandTotal > l.capacity + 0.01;
    l.utilization = l.capacity ? l.flow / l.capacity : null;
  }
  for (const e of ents.values()) {
    if (e.category === 'manufacturer') e.estRatio = e._ratio ?? 0;
    if (e.category === 'extractor') {
      const outs = outLinks.get(e.id) || [];
      e.estOutput = outs.reduce((s, l) => s + (l.flow || 0), 0);
      e.outCapacity = outs.length ? outs.reduce((s, l) => s + (l.capacity ?? Infinity), 0) : 0;
    }
  }
  return { inLinks, outLinks };
}
