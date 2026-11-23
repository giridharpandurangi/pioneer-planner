// Dev helper: print the structure of a .sbp blueprint.  node tools/dump-blueprint.js "<path to .sbp>" [--full]
import fs from 'node:fs';
import parserPkg from '@etothepii/satisfactory-file-parser';

const { Parser } = parserPkg;
const file = process.argv[2];
const full = process.argv.includes('--full');
const ab = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const bp = Parser.ParseBlueprintFiles('bp', ab(file), ab(file.replace(/\.sbp$/, '.sbpcfg')));
const short = (s) => (s || '').split('.').pop();
console.log('HEADER', JSON.stringify(bp.header, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
console.log('CONFIG', JSON.stringify(bp.config));
console.log('COMPRESSION', JSON.stringify(bp.compressionInfo));
for (const o of bp.objects) {
  const props = Object.fromEntries(Object.entries(o.properties || {}).map(([k, v]) => [k, v.values ? `[${v.values.length}] ${JSON.stringify(v.values).slice(0, full ? 4000 : 160)}` : JSON.stringify(v.value ?? v).slice(0, full ? 4000 : 160)]));
  console.log(`\n${o.type} ${short(o.typePath)}  ${o.instanceName}`);
  if (o.transform) console.log('  transform', JSON.stringify(o.transform));
  if (o.parentEntityName) console.log('  parent', o.parentEntityName);
  if (o.components) console.log('  components', o.components.map((c) => short(c.pathName)).join(', '));
  console.log('  props', JSON.stringify(props, null, 1).slice(0, full ? 20000 : 1200));
  if (o.specialProperties && o.specialProperties.type !== 'EmptySpecialProperties') console.log('  special', JSON.stringify(o.specialProperties).slice(0, full ? 4000 : 400));
  console.log('  meta', JSON.stringify({ flags: o.flags, needTransform: o.needTransform, wasPlacedInLevel: o.wasPlacedInLevel, parentObject: o.parentObject, rootObject: o.rootObject, saveCustomVersion: o.saveCustomVersion, trailing: o.trailingData?.length, migrate: o.shouldMigrateObjectRefsToPersistent }));
}
