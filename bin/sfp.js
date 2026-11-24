#!/usr/bin/env node
// Command-line interface. Run `node bin/sfp.js help`.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `Satisfactory factory planner

Usage: node bin/sfp.js <command> [args] [--save NAME]

  saves                         list save files (newest first)
  status                        current situation: tier, unlocks, power, extraction, production, balance
  improve [--limit 25]          problems + concrete fixes found in your factory
  unlocks                       buildings, belt tiers and every unlocked recipe
  nodes [resource] [--purity pure] [--all] [--limit 15]
  item <name>                   recipes for an item (locked ones show what unlocks them)
  plan  "Item:rate" ...         production plan with your unlocks, nodes and belt tier
  design "Item:rate" ...        plan + layout sketch (HTML/SVG) + build order
  needs [--active]              what your next milestones / space elevator still need vs storage
  rebuild ["Item:rate" ...]     tear down + rebuild plan (default goal: finish next milestones)
  upgrades                      what existing miners/lines gain from better belts / miners
  lines                         your production lines (numbered) + belt/miner tiers and how to unlock them
  upgrade-line <n> [--belt 2] [--miner 2]   full upgrade plan for an existing line (works before unlocking)
  compare [plan options] [--to-belt 2] [--to-miner 2]   same plan at your tiers vs better tiers
  blueprint module "Recipe" --machines 3 [--clock 100 | --rate 90] [--belt 1] [--gap 2]
                                in-game blueprint of a machine module (e.g. 3 smelters on Iron Ingot)
  blueprint plan "Item:rate" ...   blueprint of a planned factory (same options as design)
  blueprint rebuild | stage1    blueprint of the whole rebuild, or only its small stage 1
                                (all: --name "My blueprint", --install "Session name")
  saved                         plans you kept with --save-as (each has a report.html that opens in any browser)
  context                       markdown brief of your factory to paste into any AI
  web [--port 5178]             local web UI
  mcp                           MCP server on stdio (for Claude / other AI clients)

Don't know how much to make? Leave the amounts out:
  plan --goal milestones        whatever your next milestones + space elevator still need (default if no items),
                                sized to what your free power can run (never faster than 30 min);
                                --minutes 60 = finish in ~1 h, --minutes fastest = as big as the nodes allow
  plan --goal active            only your active milestone
  plan "Iron Plate" "Rotor"     these items, as much as your nodes allow (no ":rate" = automatic)

Plan / design options:
  --max "Item"                  maximize an item instead of fixed rates
  --input "Item:rate"           a supply you already have (repeatable)
  --no-alternates               don't use alternate recipes
  --resources free-nodes|all-nodes|existing-only|unlimited
  --distance 1500               max node distance from the HUB in metres
  --site hub|player|BP_ResourceNodeNNN
  --belt 2                      force a belt tier
  --overclock                   allow clocks above 100%
  --locked                      allow recipes you have not unlocked (plan ahead)
  --nodes BP_ResourceNode551,BP_ResourceNode586   use only these nodes (ids from "nodes")
  --nearest 3 [--node-res "Iron Ore"]             use only the 3 nearest nodes (of that resource)
  --rebuild                     nodes with a miner count as free (old lines get dismantled)
Rebuild:
  --dismantle near|all|none|1,3 which old lines to tear down (default near)
  --radius 250                  "near" = within this many metres of the HUB
  --dismantle-power             also tear down lines that feed generators
Design area:
  --mode foundation|ground      (default foundation)
  --width 64 --length 96        area per floor (metres; add --unit foundations for 8 m tiles)
  --floors 2|auto               (default auto)
  --thickness 1|2|4             foundation thickness
  --blueprint                   also write in-game blueprints (.sbp), one per floor
  --install "Session name"      copy those blueprints into the game's blueprint folder
  --open                        open the sketch in your browser
  --save-as "My plan"           keep the result of plan / design / rebuild / blueprint in saved/ (report.html + files)

Examples:
  node bin/sfp.js improve
  node bin/sfp.js plan "Reinforced Iron Plate:5"
  node bin/sfp.js blueprint module "Iron Ingot" --machines 3 --install "New Game"
  node bin/sfp.js design "Modular Frame:5" --width 10 --length 12 --unit foundations --floors 2 --open
`;

function parseArgs(argv) {
  const pos = [];
  const opts = { input: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    const flag = ['all', 'no-alternates', 'overclock', 'locked', 'open', 'json', 'rebuild', 'blueprint', 'active', 'dismantle-power'].includes(key);
    const val = flag || next === undefined || next.startsWith('--') ? true : argv[++i];
    if (key === 'input') opts.input.push(val);
    else opts[key] = val;
  }
  return { pos, opts };
}

// "Iron Plate:30" = fixed rate; "Iron Plate" alone = automatic amount
const parseTarget = (s) => {
  const m = String(s).match(/^(.*?)[:=@]\s*([\d.]+)\s*$/);
  return m ? { item: m[1].trim(), rate: Number(m[2]) } : { item: String(s).trim() };
};

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const { pos, opts } = parseArgs(rest);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (cmd === 'mcp') { await import('../src/mcp/server.js'); return; }
  if (cmd === 'web') { process.env.SFP_PORT = opts.port || process.env.SFP_PORT || ''; await import('../src/web/server.js'); return; }

  const A = await import('../src/core/actions.js');
  const { loadSave } = await import('../src/core/session.js');
  if (opts.save) loadSave(opts.save);
  const out = (r) => console.log(opts.json ? JSON.stringify(r.data, null, 2) : r.markdown);

  const request = () => ({
    targets: pos.map(parseTarget),
    maximize: opts.max,
    inputs: opts.input.map(parseTarget),
    useAlternates: !opts['no-alternates'],
    resources: opts.resources,
    maxNodeDistance: opts.distance ? Number(opts.distance) : undefined,
    site: opts.site,
    beltTier: opts.belt ? Number(opts.belt) : undefined,
    allowOverclock: !!opts.overclock,
    allowLocked: !!opts.locked,
    nodes: opts.nodes ? String(opts.nodes).split(',').map((s) => s.trim()) : undefined,
    nearestNodes: opts.nearest ? Number(opts.nearest) : undefined,
    nodeResources: opts['node-res'] ? String(opts['node-res']).split(',') : undefined,
    rebuild: !!opts.rebuild,
    goal: opts.goal,
    goalMinutes: ['fastest', 'auto'].includes(opts.minutes) ? opts.minutes : opts.minutes ? Number(opts.minutes) : undefined,
  });
  const area = () => ({
    mode: opts.mode, width: opts.width && Number(opts.width), length: opts.length && Number(opts.length), unit: opts.unit,
    floors: opts.floors === 'auto' || !opts.floors ? 'auto' : Number(opts.floors), foundationThickness: opts.thickness && Number(opts.thickness), title: opts.title,
    blueprint: !!opts.blueprint, installSession: typeof opts.install === 'string' ? opts.install : undefined,
  });
  // --save-as "name": keep the result in saved/ (a report.html that opens in any browser + the settings to run it again)
  const keep = (kind, settings, r) => {
    if (typeof opts['save-as'] !== 'string') return;
    const s = A.saveResult(kind, opts['save-as'], settings, r);
    console.log(`\nSaved: ${s.data.report}`);
  };
  // open with the default browser without going through a shell (paths with & or spaces stay safe)
  const openFile = (f) => {
    if (!opts.open || !f) return;
    const c = process.platform === 'win32' ? ['explorer.exe', [f]] : process.platform === 'darwin' ? ['open', [f]] : ['xdg-open', [f]];
    spawn(c[0], c[1], { detached: true, stdio: 'ignore', shell: false }).unref();
  };

  switch (cmd) {
    case 'saves': return out(A.savesAction());
    case 'load': return out(A.loadAction(pos[0]));
    case 'status': return out(A.statusAction());
    case 'improve': return out(A.improveAction({ limit: Number(opts.limit) || 25 }));
    case 'unlocks': return out(A.unlocksAction());
    case 'nodes': return out(A.nodesAction({ resource: pos[0], purity: opts.purity, onlyFree: !opts.all, limit: Number(opts.limit) || 15 }));
    case 'item': return out(A.itemAction(pos.join(' ')));
    case 'context': return out(A.contextAction());
    case 'plan': {
      const r = A.planAction(request());
      out(r);
      return keep('plan', { request: request() }, r);
    }
    case 'saved': return out(A.savedListAction());
    case 'design': {
      const r = A.designAction(request(), area());
      out(r);
      keep('design', { request: request(), area: area() }, r);
      return openFile(r.data?.files?.html);
    }
    case 'needs': return out(A.needsAction({ scope: opts.active ? 'active' : 'tier' }));
    case 'upgrades': return out(A.upgradesAction());
    case 'lines': return out(A.linesAction());
    case 'upgrade-line': return out(A.upgradeLineAction({ line: Number(pos[0] || opts.line), beltTier: opts.belt && Number(opts.belt), minerTier: opts.miner && Number(opts.miner) }));
    case 'compare': {
      const req = request();
      delete req.beltTier;
      return out(A.upgradePlanAction(req, { beltTier: opts['to-belt'] && Number(opts['to-belt']), minerTier: opts['to-miner'] && Number(opts['to-miner']) }));
    }
    case 'blueprint': {
      const source = pos.shift() || 'module';
      const installSession = typeof opts.install === 'string' ? opts.install : undefined;
      const name = typeof opts.name === 'string' ? opts.name : undefined;
      const num = (v) => (v === undefined || v === true ? undefined : Number(v));
      const dis = opts.dismantle;
      const scope = { scope: dis && /^[\d,]+$/.test(String(dis)) ? String(dis).split(',').map(Number) : dis || 'near', radius: num(opts.radius), includePower: !!opts['dismantle-power'] };
      const body = source === 'module'
        ? { source, name, module: { recipe: pos.join(' '), machines: num(opts.machines), clock: num(opts.clock), rate: num(opts.rate), beltTier: num(opts.belt), gap: num(opts.gap) } }
        : { source, name, request: { ...request(), rebuild: source !== 'plan' || !!opts.rebuild }, area: area(), scope };
      const r = A.blueprintAction({ ...body, installSession });
      out(r);
      keep('blueprint', body, r);
      return openFile(r.data?.sketchUrl && r.data.blueprints?.[0] ? path.join(ROOT, 'output', r.data.blueprints[0].file.split('/')[0], 'index.html') : null);
    }
    case 'rebuild': {
      const dis = opts.dismantle;
      const scope = { scope: dis && /^[\d,]+$/.test(String(dis)) ? String(dis).split(',').map(Number) : dis || 'near', radius: opts.radius ? Number(opts.radius) : undefined, includePower: !!opts['dismantle-power'] };
      const r = A.rebuildAction({ ...request(), rebuild: true }, area(), scope);
      out(r);
      keep('rebuild', { request: { ...request(), rebuild: true }, area: area(), scope }, r);
      return openFile(r.data?.files?.html);
    }
    default:
      console.log(`Unknown command "${cmd}".\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => { console.error(`Error: ${e.message}`); process.exitCode = 1; });
void ROOT;
