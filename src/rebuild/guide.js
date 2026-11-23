// Visual rebuild guide: one card per step of the order of work, each with a small diagram and a time badge.
// renderGuide() returns a self-contained HTML fragment (scoped CSS) for the web UI; guidePage() a full page.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const BCOL = { Smelter: '#d9822b', Constructor: '#3b82c4', Assembler: '#8a63d2', Foundry: '#c2410c', Manufacturer: '#0f766e', Refinery: '#475569', Packager: '#64748b', Blender: '#0e7490', 'Storage Container': '#7c6f57', 'Industrial Storage Container': '#7c6f57', 'Conveyor Splitter': '#a16207', 'Conveyor Merger': '#15803d' };
const colorOf = (building) => (/Miner/.test(building || '') ? '#52606d' : BCOL[building] || '#6b7280');
const ITEM_PAL = ['#e6a23c', '#4fb3d9', '#9bd16b', '#f06d6d', '#c58af9', '#f4c95d', '#5ad1b0', '#ff9f68', '#8fa8ff', '#e98bc4'];
const itemColor = (name) => ITEM_PAL[[...String(name)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % ITEM_PAL.length];
const fmtN = (n) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : (Math.round(n * 10) / 10).toString());

let uid = 0;
function svgOpen(w, h) {
  const id = `rgA${++uid}`;
  return { id, head: `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px" xmlns="http://www.w3.org/2000/svg" font-family="Segoe UI, Roboto, sans-serif"><defs><marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs>` };
}
const arrow = (id, x1, y1, x2, y2, label, color = '#94a3b8') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2.2" marker-end="url(#${id})"/>${label ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" fill="#cbd5e1" font-size="11" text-anchor="middle">${esc(label)}</text>` : ''}`;
const chip = (x, y, w, name, amount) => `<g><rect x="${x}" y="${y}" width="${w}" height="34" rx="8" fill="#232a35" stroke="${itemColor(name)}" stroke-width="2"/><circle cx="${x + 16}" cy="${y + 17}" r="7" fill="${itemColor(name)}"/><text x="${x + 30}" y="${y + 22}" fill="#f1f5f9" font-size="13" font-weight="600">${esc(fmtN(amount))}</text><text x="${x + 30 + String(fmtN(amount)).length * 8 + 6}" y="${y + 22}" fill="#cbd5e1" font-size="12">${esc(name)}</text></g>`;
function machine(x, y, w, h, building, line1, line2, opt = {}) {
  const fill = colorOf(building);
  return `<g opacity="${opt.faded ? 0.45 : 1}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${fill}" fill-opacity="0.85" stroke="${opt.keep ? '#4ade80' : '#0b0d10'}" stroke-width="${opt.keep ? 3 : 1.5}"/>`
    + `<text x="${x + w / 2}" y="${y + h / 2 - (line2 ? 3 : -4)}" fill="#fff" font-size="12.5" font-weight="700" text-anchor="middle">${esc(line1)}</text>`
    + (line2 ? `<text x="${x + w / 2}" y="${y + h / 2 + 13}" fill="#e5e7eb" font-size="11" text-anchor="middle">${esc(line2)}</text>` : '')
    + `</g>`
    + (opt.cross ? `<line x1="${x + 6}" y1="${y + 6}" x2="${x + w - 6}" y2="${y + h - 6}" stroke="#ef4444" stroke-width="3.5"/><line x1="${x + w - 6}" y1="${y + 6}" x2="${x + 6}" y2="${y + h - 6}" stroke="#ef4444" stroke-width="3.5"/>` : '')
    + (opt.keep ? `<rect x="${x + w - 44}" y="${y - 10}" width="44" height="18" rx="9" fill="#166534"/><text x="${x + w - 22}" y="${y + 3}" fill="#bbf7d0" font-size="10.5" font-weight="700" text-anchor="middle">KEEP</text>` : '');
}
const crate = (x, y, label) => `<g><rect x="${x}" y="${y}" width="70" height="46" rx="5" fill="#7c6f57" stroke="#0b0d10"/><line x1="${x}" y1="${y + 15}" x2="${x + 70}" y2="${y + 15}" stroke="#4b4234" stroke-width="2"/><text x="${x + 35}" y="${y + 34}" fill="#fff" font-size="11" font-weight="600" text-anchor="middle">${esc(label || 'Storage')}</text></g>`;
const nodeDot = (x, y, name, purity) => `<g><circle cx="${x}" cy="${y}" r="22" fill="#1f2937" stroke="${purity === 'pure' ? '#facc15' : purity === 'impure' ? '#a8a29e' : '#cbd5e1'}" stroke-width="3"/><text x="${x}" y="${y + 4}" fill="#e5e7eb" font-size="10" text-anchor="middle">${esc(purity || '')}</text><text x="${x}" y="${y + 38}" fill="#94a3b8" font-size="10.5" text-anchor="middle">${esc(name)}</text></g>`;
function clockIcon(x, y, text) {
  return `<g><circle cx="${x}" cy="${y}" r="15" fill="#0f172a" stroke="#fbbf24" stroke-width="2.5"/><line x1="${x}" y1="${y}" x2="${x}" y2="${y - 9}" stroke="#fbbf24" stroke-width="2.5"/><line x1="${x}" y1="${y}" x2="${x + 7}" y2="${y + 3}" stroke="#fbbf24" stroke-width="2.5"/><text x="${x + 22}" y="${y + 5}" fill="#fde68a" font-size="13" font-weight="700">${esc(text)}</text></g>`;
}

// ---------------------------------------------------------------- diagrams per step kind
function craftSvg(c) {
  const ins = c.inputs.slice(0, 4);
  const h = Math.max(96, ins.length * 44 + 16);
  const { id, head } = svgOpen(620, h);
  const parts = [head];
  const bx = 250;
  const by = h / 2 - 36;
  ins.forEach((i, k) => {
    const y = 12 + k * 44 + (h - 16 - ins.length * 44) / 2;
    parts.push(chip(10, y, 190, i.name, i.amount), arrow(id, 202, y + 17, bx - 4, h / 2));
  });
  parts.push(`<g><rect x="${bx}" y="${by}" width="120" height="72" rx="8" fill="#334155" stroke="#94a3b8" stroke-width="2"/><rect x="${bx + 18}" y="${by + 14}" width="84" height="12" rx="3" fill="#94a3b8"/><line x1="${bx + 26}" y1="${by + 26}" x2="${bx + 26}" y2="${by + 44}" stroke="#94a3b8" stroke-width="4"/><line x1="${bx + 94}" y1="${by + 26}" x2="${bx + 94}" y2="${by + 44}" stroke="#94a3b8" stroke-width="4"/><text x="${bx + 60}" y="${by + 62}" fill="#f1f5f9" font-size="12" font-weight="600" text-anchor="middle">${esc(c.station)}</text></g>`);
  parts.push(arrow(id, bx + 122, h / 2, 418, h / 2), chip(422, h / 2 - 17, 190, c.output.name, c.output.amount));
  return parts.join('') + '</svg>';
}

function waitSvg(c) {
  const { id, head } = svgOpen(620, 110);
  const src = c.source ? `${c.source.recipes.slice(-2).join(' → ')}` : 'current factory';
  return head
    + machine(10, 30, 190, 50, 'Constructor', 'Your old factory', src.length > 28 ? `${src.slice(0, 27)}…` : src)
    + arrow(id, 204, 55, 292, 55, `${fmtN(c.perMin)}/min`)
    + crate(296, 32, 'Storage')
    + chip(384, 10, 200, c.item, c.amount)
    + clockIcon(404, 80, `~${c.minutes} min`)
    + '</svg>';
}

function emptySvg(c) {
  const n = Math.min(c.count, 4);
  const { id, head } = svgOpen(620, 100);
  let s = head;
  for (let k = 0; k < n; k++) s += crate(10 + k * 82, 26, 'Storage');
  if (c.count > n) s += `<text x="${10 + n * 82}" y="54" fill="#cbd5e1" font-size="13">+${c.count - n}</text>`;
  const px = 10 + n * 82 + 120;
  s += arrow(id, 10 + n * 82 + 6, 49, px - 30, 49, 'take items');
  s += `<g><circle cx="${px}" cy="30" r="13" fill="#fbbf24"/><rect x="${px - 14}" y="45" width="28" height="36" rx="10" fill="#f59e0b"/><text x="${px + 26}" y="58" fill="#e5e7eb" font-size="12">you (inventory)</text></g>`;
  return s + '</svg>';
}

function dismantleSvg(c) {
  const parts = c.line.parts.filter((p) => !['splitter', 'merger'].includes(p.kind));
  const w = 132;
  const gap = 34;
  const refund = c.line.refund.slice(0, 5);
  const chipW = (r) => Math.max(110, 50 + r.name.length * 7 + String(r.amount).length * 8);
  const W = Math.max(620, 10 + parts.length * (w + gap), 112 + refund.reduce((s, r) => s + chipW(r) + 8, 0) + 10);
  const H = 96 + (refund.length ? 46 : 0);
  const { id, head } = svgOpen(W, H);
  let s = head;
  parts.forEach((p, k) => {
    const x = 10 + k * (w + gap);
    const l1 = `${p.count > 1 ? `${p.count}× ` : ''}${p.kind === 'extractor' ? p.building : p.kind === 'storage' ? 'Storage' : p.building}`;
    const l2 = p.kind === 'extractor' ? `${p.purity} ${p.resource}` : p.recipe || '';
    s += machine(x, 22, w, 52, p.building, l1, l2, { keep: p.keep, cross: !p.keep, faded: !p.keep });
    if (k < parts.length - 1) s += arrow(id, x + w + 2, 48, x + w + gap - 2, 48);
  });
  const extra = c.line.parts.filter((p) => ['splitter', 'merger'].includes(p.kind)).reduce((a, p) => a + p.count, 0);
  s += `<text x="10" y="92" fill="#94a3b8" font-size="11">+ ${c.line.belts} belts${extra ? ` and ${extra} splitters/mergers` : ''} — all refunded</text>`;
  if (refund.length) {
    s += `<text x="10" y="${96 + 26}" fill="#86efac" font-size="12" font-weight="700">↩ you get back</text>`;
    let x = 112;
    for (const r of refund) { const cw = chipW(r); s += chip(x, 96 + 4, cw, r.name, r.amount); x += cw + 8; }
  }
  return s + '</svg>';
}

function stage1Svg(c) {
  const st = c.stage.plan;
  const steps = st.steps;
  const w = 128;
  const gap = 70;
  const startX = 140;
  const W = startX + steps.length * (w + gap) + 260;
  const { id, head } = svgOpen(W, 130);
  let s = head;
  const node = st.nodes[0];
  if (node) {
    s += nodeDot(28, 40, node.name, node.purity);
    s += machine(60, 18, 74, 46, node.building, node.building.replace('Miner ', 'Miner '), node.kind === 'node' ? 'new' : 'kept', { keep: node.kind !== 'node' });
  }
  let prevX = 136;
  let prevOut = node ? { name: node.name, rate: st.nodes.reduce((a, n) => a + n.rate, 0) } : null;
  steps.forEach((p, k) => {
    const x = startX + gap + k * (w + gap) - gap + gap;
    const xx = startX + k * (w + gap) + gap;
    const inp = p.inputs.find((i) => prevOut && i.name === prevOut.name) || p.inputs[0];
    s += arrow(id, prevX + 2, 41, xx - 4, 41, inp ? `${fmtN(inp.rate)} ${inp.name}` : '');
    s += machine(xx, 16, w, 50, p.building, `${p.machines}× ${p.building}`, `${p.recipe}${Math.abs(p.clock - 100) > 0.05 ? ` @ ${fmtN(p.clock)}%` : ''}`);
    prevX = xx + w;
    prevOut = p.outputs[0];
    void x;
  });
  const out = steps[steps.length - 1]?.outputs[0];
  s += arrow(id, prevX + 2, 41, prevX + 46, 41) + crate(prevX + 48, 18, 'Collect');
  if (out) s += `<text x="${prevX + 48}" y="84" fill="#fde68a" font-size="12" font-weight="700">${esc(fmtN(out.rate))}/min ${esc(out.name)}</text>`;
  s += clockIcon(startX + gap, 104, `let it run ~${c.minutes} min`);
  return s + '</svg>';
}

function buildSvg(c) {
  const steps = c.steps;
  const depthOf = (id) => steps.find((s) => s.id === id)?.depth ?? 0;
  const maxD = Math.max(0, ...steps.map((s) => s.depth));
  const cols = new Map();
  for (const s of steps) (cols.get(s.depth) || cols.set(s.depth, []).get(s.depth)).push(s);
  const w = 138;
  const h = 46;
  const colW = 180;
  const rowH = 62;
  const maxRows = Math.max(...[...cols.values()].map((v) => v.length), 1);
  const W = 120 + (maxD + 1) * colW + 120;
  const H = maxRows * rowH + 24;
  const pos = {};
  for (const [d, list] of cols) list.forEach((s, k) => { pos[s.id] = { x: 110 + d * colW, y: 12 + k * rowH + (maxRows - list.length) * rowH / 2 }; });
  pos.RAW = { x: 10, y: H / 2 - 22, w: 74 };
  pos.OUTPUT = { x: 110 + (maxD + 1) * colW, y: H / 2 - 22, w: 84 };
  const { id, head } = svgOpen(W, H);
  let s = head;
  const seen = new Set();
  for (const f of c.flows) {
    if (f.to === 'SURPLUS' || f.from === 'INPUT') continue;
    const key = `${f.from}>${f.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = pos[f.from];
    const b = pos[f.to];
    if (!a || !b) continue;
    const ax = a.x + (a.w || w);
    const bx = b.x;
    s += `<path d="M${ax} ${a.y + h / 2} C ${ax + 40} ${a.y + h / 2}, ${bx - 40} ${b.y + h / 2}, ${bx - 4} ${b.y + h / 2}" fill="none" stroke="${itemColor(f.item)}" stroke-width="2.2" opacity="0.9" marker-end="url(#${id})"/>`;
  }
  s += `<g><rect x="10" y="${pos.RAW.y}" width="74" height="${h}" rx="7" fill="#1f2937" stroke="#64748b"/><text x="47" y="${pos.RAW.y + 28}" fill="#e5e7eb" font-size="12" text-anchor="middle">Ore in</text></g>`;
  s += `<g><rect x="${pos.OUTPUT.x}" y="${pos.OUTPUT.y}" width="84" height="${h}" rx="7" fill="#14532d" stroke="#4ade80"/><text x="${pos.OUTPUT.x + 42}" y="${pos.OUTPUT.y + 28}" fill="#dcfce7" font-size="12" text-anchor="middle">Products</text></g>`;
  for (const st of steps) s += machine(pos[st.id].x, pos[st.id].y, w, h, st.building, `${st.machines}× ${st.building}`, st.recipe);
  void depthOf;
  return s + '</svg>';
}

function powerSvg(c) {
  const cap = Math.max(c.power.capacityMW, c.power.afterRebuildMW, 1);
  const W = 620;
  const scale = (W - 40) / cap;
  const { head } = svgOpen(W, 80);
  const keep = Math.max(0, c.nowMW - c.freedMW);
  const ok = c.power.ok;
  return head
    + `<rect x="20" y="20" width="${c.power.capacityMW * scale}" height="26" rx="6" fill="#1f2937" stroke="#475569"/>`
    + `<rect x="20" y="20" width="${keep * scale}" height="26" rx="6" fill="#64748b"/>`
    + `<rect x="${20 + keep * scale}" y="20" width="${c.needMW * scale}" height="26" fill="${ok ? '#22c55e' : '#ef4444'}"/>`
    + `<text x="20" y="64" fill="#cbd5e1" font-size="12">${fmtN(keep)} MW stays (biomass etc.) + <tspan fill="${ok ? '#86efac' : '#fca5a5'}" font-weight="700">${fmtN(c.needMW)} MW new factory</tspan> = ${fmtN(c.power.afterRebuildMW)} of ${fmtN(c.power.capacityMW)} MW</text>`
    + '</svg>';
}

const DIAGRAMS = { craft: craftSvg, wait: waitSvg, empty: emptySvg, dismantle: dismantleSvg, stage1: stage1Svg, build: buildSvg, power: powerSvg };
const PHASE = { craft: (c) => (c.when === 'after' ? 3 : 1), wait: () => 1, ok: () => 1, empty: () => 2, dismantle: () => 2, stage1: () => 3, note: () => 3, build: () => 4, power: () => 4 };
const PHASE_TITLE = { 1: 'Prepare — your old factory keeps running', 2: 'Tear down', 3: 'Stage 1 — make what the rest needs', 4: 'Build the rest' };

const CSS = `
.rg{--c:#1c2027;--l:#2a313c;color:#e2e8f0;font:14px/1.45 "Segoe UI",Roboto,sans-serif}
.rg-sum{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 14px}
.rg-pill{background:#232a35;border:1px solid var(--l);border-radius:999px;padding:4px 12px;font-size:13px}
.rg-pill b{color:#fbbf24}
.rg-phase{margin:18px 0 8px;color:#f59e0b;font-weight:700;font-size:13px;letter-spacing:.04em;text-transform:uppercase}
.rg-list{list-style:none;margin:0;padding:0;position:relative}
.rg-step{display:flex;gap:12px;position:relative;margin-bottom:12px}
.rg-step:not(:last-child)::before{content:"";position:absolute;left:17px;top:38px;bottom:-14px;width:2px;background:var(--l)}
.rg-num{flex:0 0 36px;height:36px;border-radius:50%;background:#f59e0b;color:#111;font-weight:800;display:flex;align-items:center;justify-content:center;z-index:1}
.rg-card{flex:1;min-width:0;background:var(--c);border:1px solid var(--l);border-radius:10px;padding:10px 14px}
.rg-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}
.rg-title{font-weight:700;font-size:15px}
.rg-tags{display:flex;gap:6px;flex-wrap:wrap}
.rg-tag{font-size:12px;border-radius:999px;padding:2px 10px;background:#273142;color:#cbd5e1;white-space:nowrap}
.rg-time{background:#422006;color:#fde68a;font-weight:700}
.rg-text{color:#94a3b8;margin:2px 0 6px;font-size:13px}
.rg-dia{overflow-x:auto}
.rg-step.rg-dismantle .rg-num{background:#ef4444;color:#fff}
.rg-step.rg-stage1 .rg-num,.rg-step.rg-build .rg-num{background:#22c55e}
`;

export function renderGuide(timeline, { goalMinutes, sketchUrl } = {}) {
  uid = 0;
  const waits = timeline.filter((c) => c.kind === 'wait').map((c) => c.minutes);
  const stage = timeline.find((c) => c.kind === 'stage1');
  const totalWait = (waits.length ? Math.max(...waits) : 0) + (stage?.minutes || 0);
  const out = [`<div class="rg"><style>${CSS}</style>`];
  out.push(`<div class="rg-sum"><span class="rg-pill">${timeline.length} steps</span>${totalWait ? `<span class="rg-pill">⏱ about <b>${totalWait} min</b> of waiting</span>` : ''}${goalMinutes ? `<span class="rg-pill">then the new factory finishes your milestones in <b>~${goalMinutes} min</b></span>` : ''}${sketchUrl ? `<a class="rg-pill" style="color:#7dd3fc" href="${esc(sketchUrl)}" target="_blank">full layout sketch ↗</a>` : ''}</div>`);
  let phase = 0;
  let n = 0;
  out.push('<ol class="rg-list">');
  for (const c of timeline) {
    const p = (PHASE[c.kind] || (() => 4))(c);
    if (p !== phase) { out.push(`</ol><div class="rg-phase">${PHASE_TITLE[p]}</div><ol class="rg-list">`); phase = p; }
    n++;
    const tags = [];
    if (c.kind === 'craft') tags.push(`<span class="rg-tag">${c.when === 'after' ? 'after stage 1' : 'before dismantling'}</span>`);
    if (c.kind === 'wait' || c.kind === 'stage1') tags.push(`<span class="rg-tag rg-time">⏱ ~${c.minutes} min</span>`);
    if (c.kind === 'dismantle') tags.push('<span class="rg-tag">100% refund</span>');
    if (c.kind === 'power') tags.push(`<span class="rg-tag" style="background:${c.power.ok ? '#14532d' : '#7f1d1d'}">${c.power.ok ? 'enough power' : 'not enough power'}</span>`);
    const dia = DIAGRAMS[c.kind] ? DIAGRAMS[c.kind](c) : '';
    out.push(`<li class="rg-step rg-${c.kind}"><div class="rg-num">${n}</div><div class="rg-card"><div class="rg-top"><div class="rg-title">${esc(c.title)}</div><div class="rg-tags">${tags.join('')}</div></div><div class="rg-text">${esc(c.text || '')}</div>${dia ? `<div class="rg-dia">${dia}</div>` : ''}</div></li>`);
  }
  out.push('</ol></div>');
  return out.join('').replace('<ol class="rg-list"></ol>', '');
}

export function guidePage(timeline, opts = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title || 'Rebuild guide')}</title><style>:root{color-scheme:dark}body{margin:0;background:#14171c}main{max-width:980px;margin:0 auto;padding:20px 16px 60px}h1{color:#f8fafc;font:700 22px "Segoe UI",Roboto,sans-serif;margin:0 0 6px}</style></head><body><main><h1>${esc(opts.title || 'Rebuild guide')}</h1>${renderGuide(timeline, opts)}</main></body></html>`;
}
