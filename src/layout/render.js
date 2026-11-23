// Renders a layout as SVG (one per floor) and a self-contained HTML build sheet.
const PX = 7; // pixels per metre
const PAD = { l: 16, r: 16, t: 40, b: 70 };

const BUILDING_COLORS = {
  Build_SmelterMk1_C: '#d9822b', Build_ConstructorMk1_C: '#3b82c4', Build_AssemblerMk1_C: '#8a63d2',
  Build_FoundryMk1_C: '#c2410c', Build_ManufacturerMk1_C: '#0f766e', Build_OilRefinery_C: '#475569',
  Build_Packager_C: '#64748b', Build_Blender_C: '#0e7490', Build_HadronCollider_C: '#7c3aed', Build_Converter_C: '#a16207', Build_QuantumEncoder_C: '#be185d',
};
const ITEM_PALETTE = ['#e6a23c', '#4fb3d9', '#9bd16b', '#f06d6d', '#c58af9', '#f4c95d', '#5ad1b0', '#ff9f68', '#8fa8ff', '#e98bc4'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function itemColors(layout) {
  const items = [...new Set(layout.elements.flatMap((f) => f.belts.map((b) => b.item)))];
  return Object.fromEntries(items.map((it, i) => [it, ITEM_PALETTE[i % ITEM_PALETTE.length]]));
}

export function renderFloorSvg(layout, floorIndex, colors = itemColors(layout)) {
  const f = layout.floors[floorIndex];
  const el = layout.elements[floorIndex];
  const W = f.width;
  const L = Math.max(f.length, f.usedLength);
  const X = (m) => PAD.l + m * PX;
  const Y = (m) => PAD.t + (L - m) * PX; // y up = north
  const w = PAD.l + W * PX + PAD.r;
  const h = PAD.t + L * PX + PAD.b;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="Segoe UI, Roboto, sans-serif" class="sfp-floor">`);
  parts.push(`<defs><marker id="arr${floorIndex}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>`);
  // floor
  const groundStyle = layout.mode === 'ground' && floorIndex === 0;
  parts.push(`<rect x="${X(0)}" y="${Y(L)}" width="${W * PX}" height="${L * PX}" fill="${groundStyle ? '#1f2a1c' : '#20242b'}" stroke="#596273" stroke-width="2" ${groundStyle ? 'stroke-dasharray="8 6"' : ''}/>`);
  if (!groundStyle) {
    for (let x = 8; x < W; x += 8) parts.push(`<line x1="${X(x)}" y1="${Y(0)}" x2="${X(x)}" y2="${Y(L)}" stroke="#2c323c" stroke-width="1"/>`);
    for (let y = 8; y < L; y += 8) parts.push(`<line x1="${X(0)}" y1="${Y(y)}" x2="${X(W)}" y2="${Y(y)}" stroke="#2c323c" stroke-width="1"/>`);
  }
  if (f.length < f.usedLength) parts.push(`<rect x="${X(0)}" y="${Y(f.usedLength)}" width="${W * PX}" height="${(f.usedLength - f.length) * PX}" fill="rgba(220,38,38,0.15)" stroke="#dc2626" stroke-dasharray="4 4"/><text x="${X(W) - 6}" y="${Y(f.usedLength) + 14}" fill="#f87171" font-size="12" text-anchor="end">outside your area</text>`);
  // corridor
  parts.push(`<rect x="${X(0)}" y="${Y(L)}" width="${layout.busWidth * PX}" height="${L * PX}" fill="rgba(255,255,255,0.035)"/>`);
  parts.push(`<text x="${X(layout.busWidth / 2)}" y="${Y(L) + 14}" fill="#7d8796" font-size="10" text-anchor="middle">CORRIDOR</text>`);
  // rows
  const packed = new Set(el.rows.filter((r) => el.rows.some((o) => o !== r && o.y === r.y)).map((r) => r.id));
  for (const r of el.rows) {
    const text = packed.has(r.id) ? r.short : r.label;
    parts.push(`<text x="${X(r.x)}" y="${Y(r.y + r.h - 1.4 - r.labelOffset * 2)}" fill="#cbd5e1" font-size="11" font-weight="600"><title>${esc(r.label)}</title>${esc(text)}</text>`);
  }
  // belts
  for (const b of el.belts) {
    const pts = b.pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
    const width = b.kind === 'feed' ? 2.2 : 3.2;
    parts.push(`<polyline points="${pts}" fill="none" stroke="${colors[b.item]}" stroke-width="${width}" ${b.fluid ? 'stroke-dasharray="6 3"' : ''} stroke-linejoin="round" ${b.kind !== 'feed' ? `marker-end="url(#arr${floorIndex})"` : ''} opacity="0.95"><title>${esc(b.name)} ${b.rate}/min${b.fluid ? ' (pipe)' : ''}</title></polyline>`);
  }
  // rate labels on manifold lanes
  for (const b of el.belts.filter((x) => x.kind === 'manifold-in' || x.kind === 'manifold-out')) {
    // label just right of the far end of the lane, clear of the corridor junctions
    const far = b.kind === 'manifold-in' ? b.pts[1] : b.pts[1];
    parts.push(`<text x="${X(far[0]) + 6}" y="${Y(far[1]) + 3}" fill="${colors[b.item]}" font-size="9">${esc(b.name)} ${b.rate}/min</text>`);
  }
  // machines
  for (const m of el.machines) {
    const fill = BUILDING_COLORS[m.building] || '#6b7280';
    parts.push(`<g><rect x="${X(m.x)}" y="${Y(m.y + m.l)}" width="${m.w * PX}" height="${m.l * PX}" rx="4" fill="${fill}" fill-opacity="0.85" stroke="#0b0d10" stroke-width="1.5"><title>${esc(m.label)} #${m.index} — ${esc(m.recipe)} @ ${m.clock}%</title></rect>`);
    const fs = Math.max(8, Math.min(12, m.w * 1.25));
    parts.push(`<text x="${X(m.x + m.w / 2)}" y="${Y(m.y + m.l / 2) - 2}" fill="#fff" font-size="${fs}" text-anchor="middle" font-weight="600">${esc(m.label)}</text>`);
    parts.push(`<text x="${X(m.x + m.w / 2)}" y="${Y(m.y + m.l / 2) + fs}" fill="#e5e7eb" font-size="${fs - 1}" text-anchor="middle">${m.clock}%</text></g>`);
  }
  // splitters / mergers / lifts
  for (const s of el.splitters) parts.push(`<g><rect x="${X(s.x - 1)}" y="${Y(s.y + 1)}" width="${2 * PX}" height="${2 * PX}" fill="#facc15" stroke="#111" stroke-width="1"/><text x="${X(s.x)}" y="${Y(s.y) + 4}" font-size="10" text-anchor="middle" font-weight="700" fill="#111">S</text></g>`);
  for (const s of el.mergers) parts.push(`<g><rect x="${X(s.x - 1)}" y="${Y(s.y + 1)}" width="${2 * PX}" height="${2 * PX}" fill="#34d399" stroke="#111" stroke-width="1"/><text x="${X(s.x)}" y="${Y(s.y) + 4}" font-size="10" text-anchor="middle" font-weight="700" fill="#111">M</text></g>`);
  for (const l of el.lifts) {
    const label = l.dir === 'arrive' ? `from F${l.fromFloor}` : `${l.dir === 'up' ? '↑' : '↓'} F${l.toFloor}`;
    parts.push(`<g><circle cx="${X(l.x)}" cy="${Y(l.y)}" r="${1.4 * PX}" fill="#f472b6" stroke="#111"/><text x="${X(l.x) + 1.8 * PX}" y="${Y(l.y) + 4}" font-size="10" fill="#f9a8d4">LIFT ${label} (${l.height} m)</text></g>`);
  }
  // IN / OUT labels
  for (const lab of el.labels) {
    const isIn = lab.kind === 'input';
    const y = isIn ? Y(0) + 14 + (el.labels.filter((x) => x.kind === 'input').indexOf(lab) % 4) * 12 : Y(lab.y) - 6;
    parts.push(`<text x="${X(lab.x)}" y="${y}" fill="${colors[lab.item] || '#ddd'}" font-size="10" ${isIn ? '' : 'font-weight="700"'}>${esc(lab.text)}</text>`);
  }
  // header & scale
  parts.push(`<text x="${PAD.l}" y="18" fill="#e2e8f0" font-size="14" font-weight="700">Floor ${f.index}${f.elevation ? ` (+${f.elevation} m)` : ''} — ${W} × ${f.length} m (${Math.ceil(W / 8)} × ${Math.ceil(f.length / 8)} foundations)</text>`);
  parts.push(`<text x="${PAD.l}" y="32" fill="#94a3b8" font-size="11">North is up · grid = 8 m foundation · belts ≤ ${layout.beltCap}/min (${esc(layout.belt || '')})</text>`);
  parts.push(`<g transform="translate(${w - PAD.r - 8 * 8 * PX / 2},${h - 14})"><line x1="0" y1="0" x2="${32 * PX}" y2="0" stroke="#94a3b8" stroke-width="2"/><text x="${16 * PX}" y="-4" fill="#94a3b8" font-size="10" text-anchor="middle">32 m (4 foundations)</text></g>`);
  parts.push('</svg>');
  return parts.join('\n');
}

export function renderHtml(layout, plan, extra = {}) {
  const colors = itemColors(layout);
  const floors = layout.floors.map((_, i) => renderFloorSvg(layout, i, colors)).reverse(); // top floor first
  const bom = layout.bom;
  const matRows = bom.materials.map((m) => `<tr><td>${esc(m.name)}</td><td class="n">${m.amount}</td><td class="n ${m.have != null && m.have < m.amount ? 'short' : ''}">${m.have ?? '—'}</td></tr>`).join('');
  const stepRows = plan.steps.map((s) => `<tr><td>${s.id}</td><td>${esc(s.recipeName)}${s.alternate ? ' <span class="tag">alt</span>' : ''}</td><td>${esc(s.buildingName)}</td><td class="n">${s.machines}</td><td class="n">${s.clockPercent}%</td><td>${s.inputs.map((i) => `${esc(i.name)} ${i.rate}`).join('<br>')}</td><td>${s.outputs.map((o) => `${esc(o.name)} ${o.rate}`).join('<br>')}</td><td class="n">${s.powerMW}</td></tr>`).join('');
  const nodes = plan.nodes.map((n) => `<li>${esc(n.name)} — ${esc(n.note || '')}${n.where ? ` · <em>${esc(n.where)}</em>` : ''}</li>`).join('');
  const warnings = layout.warnings.length ? `<div class="warn"><b>Heads-up</b><ul>${layout.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
  const legend = Object.entries(colors).map(([k, c]) => `<span class="sw" style="background:${c}"></span>${esc(layout.elements.flatMap((f) => f.belts).find((b) => b.item === k)?.name || k)}`).join(' ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(layout.title)}</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#14171c;color:#e2e8f0;font:14px/1.45 "Segoe UI",Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:20px 16px 60px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;color:#f8fafc}
.sub{color:#94a3b8}.cards{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}.card{background:#1c2027;border:1px solid #2a303a;border-radius:8px;padding:10px 14px;min-width:150px}
.card b{display:block;font-size:18px}.card span{color:#94a3b8;font-size:12px}.svgwrap{overflow-x:auto;background:#181b21;border:1px solid #2a303a;border-radius:8px;padding:8px;margin:10px 0}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #2a303a;padding:5px 8px;text-align:left;vertical-align:top}th{color:#94a3b8;font-weight:600}
td.n{text-align:right;font-variant-numeric:tabular-nums}.short{color:#f87171;font-weight:600}.tag{background:#7c3aed;border-radius:4px;padding:0 4px;font-size:11px}
ol li{margin:3px 0}.warn{background:#3b2a12;border:1px solid #a16207;border-radius:8px;padding:8px 14px;margin:12px 0}.sw{display:inline-block;width:12px;height:12px;border-radius:2px;margin:0 4px 0 12px;vertical-align:-1px}
.legend{color:#cbd5e1;font-size:12px}.sym{display:inline-block;width:12px;height:12px;margin:0 4px 0 12px;vertical-align:-1px;border:1px solid #111}
</style></head><body><main>
<h1>${esc(layout.title)}</h1>
<div class="sub">${layout.mode === 'foundation' ? 'Foundation build' : 'Ground build'} · ${layout.width} m wide · ${layout.floors.length} floor(s) · ${esc(plan.logistics.belt)} (${plan.logistics.beltCap}/min) · ${esc(plan.logistics.miner || '')}${extra.saveName ? ` · save: ${esc(extra.saveName)}` : ''}</div>
<div class="cards">
<div class="card"><b>${Object.values(bom.machines).reduce((a, b) => a + b, 0)}</b><span>machines (${Object.entries(bom.machines).map(([k, v]) => `${v} ${esc(k)}`).join(', ')})</span></div>
<div class="card"><b>${bom.powerMW} MW</b><span>power needed</span></div>
<div class="card"><b>${bom.splitters} / ${bom.mergers}</b><span>splitters / mergers</span></div>
<div class="card"><b>${Object.values(bom.belts).reduce((a, b) => a + b, 0)} m</b><span>belt (≈, incl. 10% slack)</span></div>
<div class="card"><b>${bom.foundations ? bom.foundations.count : 0}</b><span>${bom.foundations ? esc(bom.foundations.type) : 'foundations'}</span></div>
${bom.lifts ? `<div class="card"><b>${bom.lifts.count}</b><span>${esc(bom.lifts.type)}s</span></div>` : ''}
</div>
${warnings}
<h2>Layout</h2>
<div class="legend">${legend}<span class="sym" style="background:#facc15"></span>Splitter<span class="sym" style="background:#34d399"></span>Merger<span class="sym" style="background:#f472b6;border-radius:50%"></span>Lift</div>
${floors.map((s) => `<div class="svgwrap">${s}</div>`).join('')}
<h2>Raw inputs</h2><ul>${nodes || '<li>none</li>'}</ul>
<h2>Production steps</h2>
<table><tr><th>#</th><th>Recipe</th><th>Building</th><th>Qty</th><th>Clock</th><th>In /min (total)</th><th>Out /min (total)</th><th>MW</th></tr>${stepRows}</table>
<h2>Build order</h2><ol>${layout.buildSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
<h2>Materials to build it</h2>
<table><tr><th>Item</th><th class="n">Needed</th><th class="n">In your storage</th></tr>${matRows}</table>
<p class="sub">Belts and lifts are extra: their cost scales with length. Positions are a schematic on the 8 m foundation grid; port positions are approximate, so snap to the real ports in-game.</p>
</main></body></html>`;
}
