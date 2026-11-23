// Draws a .sbp top-down from the file itself (what the game will place), to check alignment by eye.
import fs from 'node:fs';
import parserPkg from '@etothepii/satisfactory-file-parser';
import { footprint } from '../gamedata/footprints.js';
import { portsFor, knownPorts } from './ports.js';

const { Parser } = parserPkg;
const ab = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const yawOf = (q) => Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
const rot = (x, y, a) => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });

function hermite(p0, m0, p1, m1, t) {
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  return { x: h00 * p0.x + h10 * m0.x + h01 * p1.x + h11 * m1.x, y: h00 * p0.y + h10 * m0.y + h01 * p1.y + h11 * m1.y };
}

export function previewBlueprintSvg(sbpPath) {
  const bp = Parser.ParseBlueprintFiles('p', ab(sbpPath), ab(`${sbpPath}cfg`));
  const ports = knownPorts();
  const shapes = [];
  const pts = [];
  for (const o of bp.objects) {
    if (o.type !== 'SaveEntity') continue;
    const cls = o.typePath.split('.').pop();
    const t = o.transform;
    const yaw = yawOf(t.rotation);
    if (/ConveyorBelt/.test(cls)) {
      const sp = (o.properties.mSplineData?.values || []).map((v) => ({ loc: v.properties.Location.value, a: v.properties.ArriveTangent.value, l: v.properties.LeaveTangent.value }));
      const line = [];
      for (let i = 0; i < sp.length - 1; i++) {
        for (let k = 0; k <= 12; k++) {
          const p = hermite(sp[i].loc, sp[i].l, sp[i + 1].loc, sp[i + 1].a, k / 12);
          const w = rot(p.x, p.y, yaw);
          line.push({ x: t.translation.x + w.x, y: t.translation.y + w.y });
        }
      }
      pts.push(...line);
      shapes.push({ kind: 'belt', line });
      continue;
    }
    const isAttach = /Splitter|Merger/.test(cls);
    const fp = isAttach ? { w: 2, l: 2 } : footprint(cls);
    const corners = [[-fp.w / 2, -fp.l / 2], [fp.w / 2, -fp.l / 2], [fp.w / 2, fp.l / 2], [-fp.w / 2, fp.l / 2]]
      .map(([x, y]) => { const r = rot(x * 100, y * 100, yaw); return { x: t.translation.x + r.x, y: t.translation.y + r.y }; });
    pts.push(...corners);
    const portDots = Object.entries(portsFor(cls, ports)).map(([n, p]) => { const r = rot(p.x, p.y, yaw); return { n, x: t.translation.x + r.x, y: t.translation.y + r.y }; });
    const recipe = o.properties?.mCurrentRecipe?.value?.pathName?.split('.').pop()?.replace(/^Recipe_|_C$/g, '') || '';
    const clock = o.properties?.mCurrentPotential?.value;
    shapes.push({ kind: isAttach ? (/Splitter/.test(cls) ? 'splitter' : 'merger') : 'machine', corners, portDots, label: isAttach ? '' : `${recipe}${clock ? ` ${Math.round(clock * 1000) / 10}%` : ''}`, cx: t.translation.x, cy: t.translation.y });
  }
  const minX = Math.min(...pts.map((p) => p.x)) - 300, maxX = Math.max(...pts.map((p) => p.x)) + 300;
  const minY = Math.min(...pts.map((p) => p.y)) - 300, maxY = Math.max(...pts.map((p) => p.y)) + 300;
  const S = 0.08; // px per cm
  const X = (x) => (x - minX) * S, Y = (y) => (y - minY) * S; // world +Y (south) drawn downward => north up
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${(maxX - minX) * S}" height="${(maxY - minY) * S}" style="background:#1b1f26;font-family:sans-serif">`];
  for (const s of shapes.filter((x) => x.kind !== 'belt')) {
    const fill = s.kind === 'splitter' ? '#facc15' : s.kind === 'merger' ? '#34d399' : '#3b82c4';
    out.push(`<polygon points="${s.corners.map((c) => `${X(c.x)},${Y(c.y)}`).join(' ')}" fill="${fill}" fill-opacity="${s.kind === 'machine' ? 0.5 : 0.9}" stroke="#000"/>`);
    if (s.label) out.push(`<text x="${X(s.cx)}" y="${Y(s.cy)}" fill="#fff" font-size="10" text-anchor="middle">${s.label}</text>`);
    for (const d of s.portDots) out.push(`<circle cx="${X(d.x)}" cy="${Y(d.y)}" r="2.5" fill="${/Input/.test(d.n) ? '#f87171' : '#a3e635'}"><title>${d.n}</title></circle>`);
  }
  for (const s of shapes.filter((x) => x.kind === 'belt')) out.push(`<polyline points="${s.line.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ')}" fill="none" stroke="#f59e0b" stroke-width="2.5" opacity="0.85"/>`);
  out.push('</svg>');
  return out.join('\n');
}
