// Dev helper: print full objects of a class from a save.  node tools/dump-save-objects.js "<save>" <ClassRegex> [count]
import fs from 'node:fs';
import parserPkg from '@etothepii/satisfactory-file-parser';
import { resolveSave } from '../src/core/session.js';

const { Parser } = parserPkg;
const file = resolveSave(process.argv[2]);
const re = new RegExp(process.argv[3]);
const count = Number(process.argv[4] || 1);
const b = fs.readFileSync(file);
const save = Parser.ParseSave('s', b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const objs = Object.values(save.levels).flatMap((l) => l.objects);
const byName = new Map(objs.map((o) => [o.instanceName, o]));
const types = {};
for (const o of objs) { const t = o.typePath.split('.').pop(); if (/Conveyor|Chain|Lift|Splitter|Merger|Foundation|Lightweight/.test(t)) types[t] = (types[t] || 0) + 1; }
console.log('relevant types:', JSON.stringify(types));
const rep = (k, v) => (typeof v === 'bigint' ? v.toString() : v);
for (const o of objs.filter((x) => re.test(x.typePath)).slice(0, count)) {
  console.log('\n=== ENTITY', JSON.stringify(o, rep).slice(0, 6000));
  for (const c of o.components || []) {
    const co = byName.get(c.pathName);
    console.log('--- COMPONENT', JSON.stringify(co, rep).slice(0, 1500));
  }
}
