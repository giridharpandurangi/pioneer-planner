// Locates the game install (for Docs JSON) and the save-game folder.
// Everything can be overridden with environment variables or sfp.config.json in the project root.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = path.join(ROOT, 'cache');
export const OUTPUT_DIR = path.join(ROOT, 'output');

function readUserConfig() {
  const p = path.join(ROOT, 'sfp.config.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}
export const userConfig = readUserConfig();

function steamLibraries() {
  const roots = [
    'C:/Program Files (x86)/Steam',
    'C:/Program Files/Steam',
    path.join(os.homedir(), '.steam/steam'),
    path.join(os.homedir(), '.local/share/Steam'),
  ];
  const libs = new Set();
  for (const r of roots) {
    const vdf = path.join(r, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    libs.add(r);
    const txt = fs.readFileSync(vdf, 'utf8');
    for (const m of txt.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '/'));
  }
  return [...libs];
}

export function findGameDirs() {
  const candidates = [];
  if (process.env.SATISFACTORY_GAME_DIR) candidates.push(process.env.SATISFACTORY_GAME_DIR);
  if (userConfig.gameDir) candidates.push(userConfig.gameDir);
  for (const lib of steamLibraries()) {
    candidates.push(path.join(lib, 'steamapps/common/Satisfactory'));
    candidates.push(path.join(lib, 'steamapps/common/SatisfactoryDedicatedServer'));
  }
  for (const d of ['C', 'D', 'E', 'F', 'G']) {
    candidates.push(`${d}:/Program Files/Epic Games/SatisfactoryEarlyAccess`);
    candidates.push(`${d}:/Program Files/Epic Games/Satisfactory`);
    candidates.push(`${d}:/Epic Games/Satisfactory`);
    candidates.push(`${d}:/SteamLibrary/steamapps/common/Satisfactory`);
  }
  return [...new Set(candidates)].filter((d) => fs.existsSync(d));
}

/** Path to the game's CommunityResources/Docs/en-US.json (recipes, buildings, schematics). */
export function findDocsJson() {
  const explicit = process.env.SATISFACTORY_DOCS || userConfig.docsJson;
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const dir of findGameDirs()) {
    for (const name of ['en-US.json', 'Docs.json', 'en-GB.json']) {
      const p = path.join(dir, 'CommunityResources', 'Docs', name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** Folder(s) that hold .sav files. */
export function findSaveDirs() {
  const dirs = [];
  const explicit = process.env.SATISFACTORY_SAVE_DIR || userConfig.saveDir;
  if (explicit) dirs.push(explicit);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const base = path.join(local, 'FactoryGame', 'Saved', 'SaveGames');
  if (fs.existsSync(base)) {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'blueprints') dirs.push(path.join(base, e.name));
    }
  }
  return dirs.filter((d) => fs.existsSync(d));
}

export function listSaves() {
  const out = [];
  for (const dir of findSaveDirs()) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.sav')) continue;
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (st.size < 10_000) continue; // skip settings/telemetry stubs
      out.push({ name: f.replace(/\.sav$/i, ''), path: full, modified: st.mtime.toISOString(), sizeKB: Math.round(st.size / 1024) });
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

export function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }
