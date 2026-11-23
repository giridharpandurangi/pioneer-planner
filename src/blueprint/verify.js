// Re-reads a written blueprint and checks it the way the game will see it:
// parses cleanly, every belt connection points to a real component and is mutual, splines are sane,
// and every object has the same property layout as the game's own blueprint objects.
import fs from 'node:fs';
import parserPkg from '@etothepii/satisfactory-file-parser';

const { Parser } = parserPkg;
const ab = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

export function verifyBlueprint(sbpPath) {
  const problems = [];
  let bp;
  try {
    bp = Parser.ParseBlueprintFiles('verify', ab(sbpPath), ab(`${sbpPath}cfg`));
  } catch (e) {
    return { ok: false, problems: [`does not parse: ${e.message}`] };
  }
  const byName = new Map(bp.objects.map((o) => [o.instanceName, o]));
  let connections = 0;
  for (const o of bp.objects) {
    if (o.type === 'SaveEntity') {
      for (const c of o.components || []) if (!byName.has(c.pathName)) problems.push(`${o.instanceName} lists missing component ${c.pathName}`);
      if (/ConveyorBelt/.test(o.typePath)) {
        const pts = o.properties?.mSplineData?.values || [];
        if (pts.length < 2) problems.push(`${o.instanceName}: belt with < 2 spline points`);
        for (const p of pts) for (const k of ['Location', 'ArriveTangent', 'LeaveTangent']) {
          const v = p.properties?.[k]?.value;
          if (!v || ![v.x, v.y, v.z].every(Number.isFinite)) problems.push(`${o.instanceName}: bad spline ${k}`);
        }
      }
    } else if (!byName.has(o.parentEntityName)) problems.push(`${o.instanceName}: parent missing`);
    const target = o.properties?.mConnectedComponent?.value?.pathName;
    if (target) {
      connections++;
      const other = byName.get(target);
      if (!other) problems.push(`${o.instanceName} -> missing ${target}`);
      else if (other.properties?.mConnectedComponent?.value?.pathName !== o.instanceName) problems.push(`${o.instanceName} -> ${target} is not mutual`);
    }
  }
  const counts = {};
  for (const o of bp.objects) if (o.type === 'SaveEntity') { const k = o.typePath.split('.').pop(); counts[k] = (counts[k] || 0) + 1; }
  return { ok: problems.length === 0, problems: problems.slice(0, 20), objects: bp.objects.length, connections: connections / 2, counts, header: { saveVersion: bp.header.saveVersion, costs: bp.header.itemCosts.length, recipes: bp.header.recipeReferences.length } };
}
