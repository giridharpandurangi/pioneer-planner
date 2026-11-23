// Learn blueprint templates + belt port positions from one or more saves (useful for big saves that
// contain buildings you have not belted yet).   node tools/learn.js "<save name>" ["<another save>"]
import { resolveSave } from '../src/core/session.js';
import { parseSaveFile } from '../src/save/model.js';
import { learnPorts, rememberPorts } from '../src/blueprint/ports.js';
import { addTemplatesFromSave, buildTemplates, TEMPLATE_FILE } from '../src/blueprint/templates.js';
import fs from 'node:fs';

if (!fs.existsSync(TEMPLATE_FILE)) buildTemplates();
for (const q of process.argv.slice(2)) {
  const t = Date.now();
  const file = resolveSave(q);
  const save = parseSaveFile(file);
  const ports = learnPorts(save);
  rememberPorts(ports);
  const added = addTemplatesFromSave(save, q);
  console.log(`${q}: v${save.header.saveVersion}, ports for ${Object.keys(ports).length} classes, ${added} new templates (${Math.round((Date.now() - t) / 1000)} s)`);
}
