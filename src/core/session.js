// Shared state for CLI / MCP / web: game data + the currently loaded save.
import fs from 'node:fs';
import path from 'node:path';
import { listSaves } from '../config.js';
import { loadGameData } from '../gamedata/loader.js';
import { buildModel, parseSaveFile } from '../save/model.js';

const state = { gd: null, model: null, file: null, mtime: null };

export function gameData() {
  if (!state.gd) state.gd = loadGameData();
  return state.gd;
}

/** Resolve a save by full path, file name, or save name; default = most recently modified save. */
export function resolveSave(query) {
  if (query && fs.existsSync(query)) {
    // only real save files, never arbitrary files on disk
    if (!/\.sav$/i.test(query) || !fs.statSync(query).isFile()) throw new Error('That is not a .sav save file.');
    return path.resolve(query);
  }
  const saves = listSaves();
  if (!saves.length) throw new Error('No .sav files found. Pass a full path to your save file.');
  if (!query) return saves[0].path;
  const q = String(query).toLowerCase().replace(/\.sav$/, '');
  const hit = saves.find((s) => s.name.toLowerCase() === q) || saves.find((s) => s.name.toLowerCase().includes(q));
  if (!hit) throw new Error(`No save matching "${query}". Available: ${saves.slice(0, 10).map((s) => s.name).join(', ')}`);
  return hit.path;
}

export function loadSave(query, { force = false } = {}) {
  const file = resolveSave(query);
  const mtime = fs.statSync(file).mtimeMs;
  if (!force && state.model && state.file === file && state.mtime === mtime) return state.model;
  const gd = gameData();
  const save = parseSaveFile(file);
  state.model = buildModel(save, gd, file);
  state.file = file;
  state.mtime = mtime;
  return state.model;
}

/** Returns the loaded model, loading the newest save on first use. Reloads automatically if the file changed. */
export function currentModel() {
  if (!state.file) return loadSave();
  return loadSave(state.file);
}

export function hasModel() { return !!state.model; }
