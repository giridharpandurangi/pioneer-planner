// Saved plans: one folder per plan under saved/, holding
//   report.html  — everything in one self-contained page (opens in any browser, also without the planner running)
//   sketch.html, guide.html, blueprints/  — copies of the layout sketch, rebuild guide and blueprint files
//   saved.json   — what it is and the settings it was made with, so it can be run again later
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { OUTPUT_DIR, ROOT, SAVED_DIR, ensureDir } from '../config.js';
import { previewBlueprintSvg } from '../blueprint/preview.js';

export const KINDS = { plan: 'Plan', design: 'Design', rebuild: 'Rebuild', blueprint: 'Blueprint' };

// the same markdown renderer the web UI uses (a classic script with globals md / esc)
const md = (() => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'web', 'public', 'markdown.js'), 'utf8'), ctx);
  return ctx.md;
})();
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** A name that is safe as a Windows folder name. */
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 60).trim() || 'Saved plan';
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;

/** An output folder the planner made (direct child of output/), given as its name or absolute path. */
function outputFolder(dir) {
  const root = path.resolve(OUTPUT_DIR);
  const abs = path.resolve(root, String(dir));
  if (path.dirname(abs) !== root || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error('That result is not in the planner\'s output folder any more — run it again, then save.');
  return abs;
}

/** The folder of a saved plan, by id (its folder name). Only real saved-plan folders directly inside saved/. */
export function savedFolder(id) {
  const name = String(id || '');
  if (!name || /[\\/\x00-\x1f]/.test(name) || /^\.+$/.test(name)) throw new Error('Unknown saved plan.');
  const root = path.resolve(SAVED_DIR);
  const folder = path.resolve(root, name);
  if (path.dirname(folder) !== root || !fs.existsSync(path.join(folder, 'saved.json'))) throw new Error('Unknown saved plan.');
  return folder;
}

/**
 * Save a result. kind: plan | design | rebuild | blueprint; settings: what it was made with (to run it again);
 * markdown: the text result; dir: the output folder with its sketch / guide / blueprints (optional); save: {saveName, sessionName}.
 */
export function savePlan({ kind, name, settings = {}, markdown = '', dir = null, save = {} }) {
  if (!KINDS[kind]) throw new Error(`Unknown kind "${kind}".`);
  const src = dir ? outputFolder(dir) : null;
  const now = new Date();
  const title = safeName(name);
  const root = ensureDir(path.resolve(SAVED_DIR));
  let id = `${stamp(now)} ${title}`;
  for (let k = 2; fs.existsSync(path.join(root, id)); k++) id = `${stamp(now)} ${title} (${k})`;
  const folder = ensureDir(path.join(root, id));

  // copies, so the saved plan stays even if output/ is cleaned up
  let sketchHtml = null;
  let guideHtml = null;
  const blueprints = [];
  let text = String(markdown);
  if (src) {
    const sketch = path.join(src, 'index.html');
    if (fs.existsSync(sketch)) { sketchHtml = fs.readFileSync(sketch, 'utf8'); fs.writeFileSync(path.join(folder, 'sketch.html'), sketchHtml); }
    const guide = path.join(src, 'rebuild-guide.html');
    if (fs.existsSync(guide)) {
      guideHtml = fs.readFileSync(guide, 'utf8').replace(/href="index\.html"/g, 'href="sketch.html"');
      fs.writeFileSync(path.join(folder, 'guide.html'), guideHtml);
    }
    const bpSrc = path.join(src, 'blueprints');
    if (fs.existsSync(bpSrc)) {
      const bpDir = ensureDir(path.join(folder, 'blueprints'));
      for (const f of fs.readdirSync(bpSrc).filter((x) => /\.sbp(cfg)?$/i.test(x))) fs.copyFileSync(path.join(bpSrc, f), path.join(bpDir, f));
      for (const f of fs.readdirSync(bpDir).filter((x) => /\.sbp$/i.test(x))) {
        let preview = null;
        try { preview = previewBlueprintSvg(path.join(bpDir, f), { maxWidth: 640 }); } catch { /* drawn only if readable */ }
        blueprints.push({ name: f.replace(/\.sbp$/i, ''), file: f, preview: preview && preview.length < 400000 ? preview : null });
      }
    }
    // paths in the text pointed into output/: point them at the saved copies
    text = text.split(path.join(src, 'index.html')).join('sketch.html').split(path.join(src, 'rebuild-guide.html')).join('guide.html')
      .split(path.join(src, 'blueprints')).join('blueprints').split(src).join('(saved folder)');
  }

  const meta = {
    version: 1,
    id,
    kind,
    name: title,
    created: now.toISOString(),
    save: { saveName: save.saveName || null, sessionName: save.sessionName || null },
    summary: summaryOf(text),
    settings,
    has: { sketch: !!sketchHtml, guide: !!guideHtml, blueprints: blueprints.length },
  };
  fs.writeFileSync(path.join(folder, 'saved.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(folder, 'report.html'), renderReport(meta, text, { sketchHtml, guideHtml, blueprints }));
  return { id, folder, report: path.join(folder, 'report.html'), meta };
}

/** Saved plans, newest first. */
export function listSaved() {
  const root = path.resolve(SAVED_DIR);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, d.name, 'saved.json'), 'utf8'));
      out.push({ ...meta, id: d.name, folder: path.join(root, d.name), report: path.join(root, d.name, 'report.html') });
    } catch { /* not a saved plan */ }
  }
  return out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

/** Deletes one saved plan folder (only folders the planner saved: they contain saved.json). */
export function deleteSaved(id) {
  const folder = savedFolder(id);
  fs.rmSync(folder, { recursive: true, force: true });
  return folder;
}

/** Opens a saved plan's folder in Explorer / Finder (no shell, validated path). */
export function openSavedFolder(id) {
  const folder = id ? savedFolder(id) : ensureDir(path.resolve(SAVED_DIR));
  const c = process.platform === 'win32' ? ['explorer.exe', [folder]] : process.platform === 'darwin' ? ['open', [folder]] : ['xdg-open', [folder]];
  spawn(c[0], c[1], { detached: true, stdio: 'ignore', shell: false }).unref();
  return folder;
}

// ------------------------------------------------------------------------------------------------ report

function summaryOf(text) {
  const line = String(text).split('\n').map((l) => l.replace(/^[#>\s-]+/, '').replace(/\*\*/g, '').trim()).find((l) => l && !/^\|/.test(l)) || '';
  return line.length > 220 ? `${line.slice(0, 217)}…` : line;
}

const GOALS = { milestones: 'automatic: what my next milestones need', active: 'automatic: my active milestone', items: 'automatic: these items, as much as my nodes allow', targets: 'the amounts I typed' };
const minutesText = (m) => (m === 'fastest' ? 'as fast as the nodes allow' : Number(m) > 0 ? `finish in ~${m} min` : 'sized to my free power');

function requestLines(r = {}) {
  const L = [];
  if (r.goal) L.push(['How much', `${GOALS[r.goal] || r.goal}${r.goal === 'milestones' || r.goal === 'active' ? ` (${minutesText(r.goalMinutes)})` : ''}`]);
  const t = (r.targets || []).filter((x) => x.item);
  if (t.length) L.push(['Items', t.map((x) => `${x.item}${x.rate ? ` ${x.rate}/min` : ''}`).join(', ')]);
  if (r.maximize) L.push(['Maximize', r.maximize]);
  if (r.nodes?.length) L.push(['Nodes', `${r.nodes.length} picked${r.rebuild ? ' (nodes with my miners count as free)' : ''}`]);
  return L;
}
function areaLine(a = {}) {
  if (!a || !a.mode) return null;
  const size = a.width || a.length ? `${a.width || 'auto'} × ${a.length || 'auto'} ${a.unit || 'm'}` : 'auto size';
  return ['Build area', `${a.mode === 'ground' ? 'plain ground' : 'foundations'}, ${size}, floors ${a.floors || 'auto'}`];
}

function settingsLines(kind, s = {}) {
  const L = [];
  if (kind === 'blueprint') {
    const m = s.module || {};
    L.push(['Blueprint of', { module: 'a machine module', plan: 'the Plan & Design settings', rebuild: 'the whole rebuild', stage1: 'stage 1 of the rebuild' }[s.source] || s.source]);
    if (s.source === 'module') L.push(['Module', `${m.recipe}${m.rate ? `, ${m.rate}/min` : `, ${m.machines || 1} machine(s) @ ${m.clock || 100}%`}${m.beltTier ? `, belt Mk.${m.beltTier}` : ''}${m.gap ? `, ${m.gap} m gap` : ''}`]);
    else L.push(...requestLines(s.request));
  } else L.push(...requestLines(s.request));
  const a = areaLine(s.area);
  if (a && !(kind === 'blueprint' && s.source === 'module')) L.push(a);
  if (s.scope?.scope) L.push(['Dismantle', s.scope.scope === 'near' ? `old lines within ${s.scope.radius || 250} m` : `${s.scope.scope}`]);
  return L;
}

const srcdoc = (html) => esc(html).replace(/\n/g, '&#10;');

function renderReport(meta, text, { sketchHtml, guideHtml, blueprints }) {
  const when = new Date(meta.created).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const settings = settingsLines(meta.kind, meta.settings);
  const nav = [guideHtml && ['guide', 'Order of work'], ['plan', meta.kind === 'blueprint' ? 'Summary' : 'Plan'], sketchHtml && ['sketch', 'Layout sketch'], blueprints.length && ['blueprints', 'Blueprints']].filter(Boolean);
  const bpCards = blueprints.map((b) => `<div class="card"><h3>${esc(b.name)}</h3>${b.preview ? `<div class="pv">${b.preview}</div>` : '<p class="hint">Too big to draw here: see the layout sketch.</p>'}<p class="hint">Files: <code>blueprints/${esc(b.file)}</code> + <code>${esc(b.file)}cfg</code> (both are needed). Copy them into <code>%LOCALAPPDATA%\\FactoryGame\\Saved\\SaveGames\\blueprints\\&lt;session name&gt;\\</code>, or use Install in the planner.</p></div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.name)} · Pioneer Planner</title>
<style>
:root{color-scheme:dark;--bg:#12151a;--panel:#1a1e25;--line:#2a313c;--text:#e3e8ef;--muted:#93a0b2;--accent:#f59e0b;--accent2:#38bdf8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI",Roboto,system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:20px 16px 60px}a{color:var(--accent2)}
.top{border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:12px}.kind{color:var(--accent);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
h1{font-size:24px;margin:2px 0 4px}h2{font-size:18px;margin:28px 0 8px}.meta,.hint{color:var(--muted);font-size:13px}
.settings{display:grid;grid-template-columns:max-content 1fr;gap:3px 14px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:10px 0;font-size:13px}.settings b{color:var(--muted);font-weight:500}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}nav a{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:3px 12px;text-decoration:none}
.md table{border-collapse:collapse;width:100%;margin:6px 0 14px;font-size:13px}.md th,.md td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}.md th{color:var(--muted)}
.md h1{font-size:20px;margin:6px 0}.md h2{font-size:16px;margin:20px 0 6px}.md code,code{background:#0f1217;padding:1px 4px;border-radius:4px}.md li{margin:3px 0}
.md .note{background:#1d2a1f;border:1px solid #2f5d3a;border-left:4px solid #4ade80;border-radius:8px;padding:10px 14px;margin:10px 0}
.sev-high{color:#f87171}.sev-medium{color:#fbbf24}.sev-low{color:var(--muted)}
iframe{width:100%;height:85vh;border:1px solid var(--line);border-radius:8px;background:#14171c}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:12px 0}.card h3{margin:0 0 8px;font-size:16px}.pv svg{max-width:100%;height:auto}
footer{margin-top:40px;color:var(--muted);font-size:12px}
@media print{iframe{height:auto;min-height:60vh}nav{display:none}}
</style></head><body><main>
<div class="top">
  <div class="kind">${esc(KINDS[meta.kind])} · saved ${esc(when)}</div>
  <h1>${esc(meta.name)}</h1>
  <div class="meta">${meta.save.saveName ? `Made from save <b>${esc(meta.save.saveName)}</b>${meta.save.sessionName ? ` (session ${esc(meta.save.sessionName)})` : ''}. ` : ''}Numbers are as they were at that moment; to plan again with your current save, use <b>Load settings</b> in the planner's Saved tab.</div>
  ${settings.length ? `<div class="settings">${settings.map(([k, v]) => `<b>${esc(k)}</b><span>${esc(v)}</span>`).join('')}</div>` : ''}
  ${nav.length > 1 ? `<nav>${nav.map(([id, label]) => `<a href="#${id}">${esc(label)}</a>`).join('')}</nav>` : ''}
</div>
${guideHtml ? `<section id="guide"><h2>Order of work</h2><p class="hint"><a href="guide.html" target="_blank">Open the guide on its own ↗</a></p><iframe title="Rebuild guide" srcdoc="${srcdoc(guideHtml)}"></iframe></section>` : ''}
<section id="plan"><h2>${meta.kind === 'blueprint' ? 'Summary' : 'Plan'}</h2><div class="md">${md(text)}</div></section>
${sketchHtml ? `<section id="sketch"><h2>Layout sketch</h2><p class="hint"><a href="sketch.html" target="_blank">Open the sketch on its own ↗</a></p><iframe title="Layout sketch" srcdoc="${srcdoc(sketchHtml)}"></iframe></section>` : ''}
${blueprints.length ? `<section id="blueprints"><h2>Blueprints</h2>${bpCards}</section>` : ''}
<footer>Saved with Pioneer Planner. This file works on its own: keep it, share it, or open it any time in a browser.</footer>
</main></body></html>`;
}
