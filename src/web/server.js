// Local web UI + JSON API (no AI needed). http://localhost:5178
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT_DIR, listSaves } from '../config.js';
import * as A from '../core/actions.js';
import { currentModel, gameData } from '../core/session.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.SFP_PORT) || 5178;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

/** Serves a file only if it is really inside `base` (no ../ tricks, no sibling folders with a similar name). */
function serveFile(res, base, rel) {
  const root = path.resolve(base);
  const p = path.resolve(root, rel);
  const inside = path.relative(root, p);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return send(res, 404, { error: 'not found' });
  send(res, 200, fs.readFileSync(p), TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream');
}

/**
 * The UI only talks to itself. Reject requests from other websites (cross-site requests / DNS rebinding):
 * the Host must be this machine, a browser Origin must be this server, and POST bodies must be JSON
 * (which other sites cannot send without a CORS preflight this server never approves).
 */
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
function allowed(req) {
  if (!LOCAL_HOSTS.has(String(req.headers.host || '').toLowerCase())) return false;
  const origin = req.headers.origin;
  if (origin && !LOCAL_HOSTS.has(origin.replace(/^https?:\/\//, '').toLowerCase())) return false;
  if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return false;
  return true;
}

/** The web UI may only load saves from your save folders (not arbitrary files on disk). */
function knownSave(save) {
  if (!save) return undefined;
  const hit = listSaves().find((s) => s.path === save || s.name === save);
  if (!hit) throw new Error('Unknown save — pick one from the list.');
  return hit.path;
}
/**
 * Design / rebuild requests never install. Blueprints go into the game folder only through /api/blueprint-install:
 * files the planner made (inside output/, .sbp), into an existing blueprint folder or this save's session, never overwriting.
 */
const noInstall = (area = {}) => { const { installSession, ...rest } = area; void installSession; return rest; };

function knownSession(session) {
  const known = A.blueprintOptionsAction().data.sessions;
  if (!known.includes(session)) throw new Error('Unknown blueprint folder — pick one from the list.');
  return session;
}

function itemsList() {
  const gd = gameData();
  let unlocked = null;
  try { unlocked = new Set(currentModel().unlocks.machineRecipes); } catch { /* no save */ }
  const out = new Map();
  for (const r of Object.values(gd.recipes)) {
    if (r.kind !== 'machine') continue;
    for (const p of r.products) {
      const name = gd.items[p.item]?.name;
      if (!name) continue;
      const u = !unlocked || unlocked.has(r.id);
      out.set(name, (out.get(name) || false) || u);
    }
  }
  return [...out].map(([name, unlockedFlag]) => ({ name, unlocked: unlockedFlag })).sort((a, b) => b.unlocked - a.unlocked || a.name.localeCompare(b.name));
}

const STARTED = Date.now();

const routes = {
  // the launcher uses this to restart an older running copy after an update
  'GET /api/health': () => ({ data: { pid: process.pid, started: STARTED } }),
  'GET /api/saves': () => A.savesAction(),
  'POST /api/load': (b) => A.loadAction(knownSave(b.save)),
  'GET /api/status': () => A.statusAction(),
  'GET /api/improve': () => A.improveAction({ limit: 50 }),
  'GET /api/unlocks': () => A.unlocksAction(),
  'GET /api/items': () => ({ data: itemsList() }),
  'POST /api/nodes': (b) => A.nodesAction(b),
  'POST /api/item': (b) => A.itemAction(b.item),
  'POST /api/plan': (b) => A.planAction(b.request || b),
  'POST /api/design': (b) => {
    const r = A.designAction(b.request || {}, noInstall(b.area));
    if (r.data?.files) r.data.url = '/output/' + path.relative(OUTPUT_DIR, r.data.files.html).split(path.sep).join('/');
    return r;
  },
  'GET /api/context': () => A.contextAction(),
  'GET /api/needs': () => A.needsAction({}),
  'GET /api/upgrades': () => A.upgradesAction(),
  'GET /api/lines': () => A.linesAction(),
  'GET /api/map': () => A.mapAction(),
  'POST /api/upgrade-line': (b) => A.upgradeLineAction(b),
  'POST /api/upgrade-plan': (b) => A.upgradePlanAction(b.request || {}, b.tiers || {}),
  'POST /api/rebuild': (b) => {
    const r = A.rebuildAction(b.request || {}, noInstall(b.area), b.scope || {});
    if (r.data?.files) r.data.url = '/output/' + path.relative(OUTPUT_DIR, r.data.files.html).split(path.sep).join('/');
    return r;
  },
  'GET /api/bp-options': () => A.blueprintOptionsAction(),
  'POST /api/blueprint': (b) => A.blueprintAction({ source: b.source, module: b.module || {}, request: b.request || {}, area: noInstall(b.area), scope: b.scope || {}, name: b.name }),
  'POST /api/blueprint-install': (b) => A.blueprintInstallAction({ files: Array.isArray(b.files) ? b.files.slice(0, 20).map(String) : [], session: knownSession(String(b.session || '')) }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!allowed(req)) return send(res, 403, { ok: false, error: 'forbidden' });
  try {
    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const r = routes[key](body);
      return send(res, 200, { ok: true, data: r.data, markdown: r.markdown });
    }
    if (url.pathname.startsWith('/output/')) return serveFile(res, OUTPUT_DIR, decodeURIComponent(url.pathname.slice('/output/'.length)));
    return serveFile(res, PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  } catch (e) {
    send(res, 200, { ok: false, error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Pioneer Planner UI: http://localhost:${PORT}`);
});
