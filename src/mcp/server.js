#!/usr/bin/env node
// MCP server (stdio). Works with Claude Desktop, Claude Code and any other MCP client.
// Nothing here may write to stdout except the protocol.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as A from '../core/actions.js';

const server = new McpServer(
  { name: 'pioneer-planner', version: '0.1.0' },
  {
    instructions: [
      'Satisfactory factory assistant backed by the player\'s real save file and the game\'s own data.',
      'Start with factory_status (it auto-loads the newest save) or load_save. Ground every suggestion in tool results:',
      'only use recipes/buildings the player has unlocked, respect their best belt speed, and use real resource nodes.',
      'Typical flow: factory_status → suggest_improvements → ask the player what they want to build and where',
      '(foundation or ground, width × length, floors) → plan_production → design_factory → hand over the sketch path and build order.',
      'If the player wants to replace temporary builds, use milestone_needs + find_nodes, ask which nodes to use, then plan_rebuild and',
      'walk them through its order of work (never tell them to dismantle before the shortages are covered). upgrade_options shows what',
      'existing lines gain from better belts/miners. make_blueprint writes in-game blueprints (.sbp): machine modules ("3 smelters"), a plan,',
      'a whole rebuild or its stage 1; install them only when the player asks. Blueprints need the FICSIT Blueprints milestone (Tier 4) in-game.',
    ].join(' '),
  },
);

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const wrap = (fn) => async (args) => {
  try { return text(fn(args || {}).markdown); } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
};

const target = z.object({ item: z.string().describe('Item name, e.g. "Reinforced Iron Plate"'), rate: z.number().positive().describe('Items (or m³) per minute') });
const planShape = {
  targets: z.array(target).optional().describe('What to produce and how fast'),
  maximize: z.string().optional().describe('Instead of fixed rates: maximize this item with the available resources'),
  inputs: z.array(target).optional().describe('Supplies you already have on a belt (e.g. spare Iron Ingot), used before mining more'),
  use_alternates: z.boolean().optional().describe('Allow unlocked alternate recipes (default true)'),
  exclude_recipes: z.array(z.string()).optional().describe('Recipe names to never use'),
  prefer_recipes: z.array(z.string()).optional().describe('Recipe names to favour'),
  resources: z.enum(['free-nodes', 'all-nodes', 'existing-only', 'unlimited']).optional().describe('free-nodes (default): free nodes within max_node_distance + spare capacity on existing miners; existing-only: only spare capacity of current miners; unlimited: ignore node limits'),
  max_node_distance: z.number().optional().describe('Metres from the site (default 1500)'),
  site: z.string().optional().describe('"hub" (default), "player", or a node id like BP_ResourceNode551 — where the factory will be'),
  belt_tier: z.number().int().min(1).max(6).optional().describe('Override the belt tier (default: best unlocked)'),
  allow_overclock: z.boolean().optional().describe('Allow clocks up to 250% (needs power shards)'),
  allow_locked: z.boolean().optional().describe('Plan with recipes you have NOT unlocked yet (planning ahead)'),
  nodes: z.array(z.string()).optional().describe('Use ONLY these resource nodes (ids from find_nodes, e.g. BP_ResourceNode551)'),
  nearest_nodes: z.number().int().optional().describe('Use only the N nearest nodes to the site'),
  node_resources: z.array(z.string()).optional().describe('With nearest_nodes: only count nodes of these resources, e.g. ["Iron Ore"]'),
  rebuild: z.boolean().optional().describe('Treat nodes that already have a miner as fully free (their old consumers will be dismantled; the miner is kept)'),
  goal: z.enum(['targets', 'milestones', 'active', 'items']).optional().describe('How amounts are chosen. targets: the rates you give. milestones: AUTOMATIC — everything the milestones the player can buy now (+ next Space Elevator phase) still need beyond storage, finishing all of it fastest. active: same for the active milestone only. items: AUTOMATIC — the auto_items as much as the nodes allow. Use milestones/items when the player does not know how much to make.'),
  auto_items: z.array(z.string()).optional().describe('With goal "items": items to make without fixed rates (amounts chosen automatically)'),
};
const toRequest = (a) => ({
  targets: a.targets || [],
  maximize: a.maximize,
  inputs: a.inputs,
  useAlternates: a.use_alternates ?? true,
  excludeRecipes: a.exclude_recipes,
  preferRecipes: a.prefer_recipes,
  resources: a.resources,
  maxNodeDistance: a.max_node_distance,
  site: a.site,
  beltTier: a.belt_tier,
  allowOverclock: a.allow_overclock,
  allowLocked: a.allow_locked,
  nodes: a.nodes,
  nearestNodes: a.nearest_nodes,
  nodeResources: a.node_resources,
  rebuild: a.rebuild,
  goal: a.goal,
  autoItems: a.auto_items,
});
const areaShape = {
  mode: z.enum(['foundation', 'ground']).optional().describe('foundation (default): on 8 m foundations, multi-floor allowed; ground: directly on flat terrain'),
  width: z.number().optional().describe('Area width (east-west). Default: auto'),
  length: z.number().optional().describe('Area length (north-south) per floor. Default: auto'),
  unit: z.enum(['m', 'foundations']).optional().describe('Unit for width/length (default m; 1 foundation = 8 m)'),
  floors: z.union([z.number().int().min(1), z.literal('auto')]).optional().describe('Number of floors or "auto"'),
  foundation_thickness: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional(),
  title: z.string().optional(),
  blueprint: z.boolean().optional().describe('Also write in-game blueprint files (.sbp), one per floor, verified by re-reading them'),
  install_blueprint_session: z.string().optional().describe('Copy the blueprints into the game\'s blueprint folder for this session name (only when the player asks)'),
};
const toArea = (a) => ({ mode: a.mode, width: a.width, length: a.length, unit: a.unit, floors: a.floors, foundationThickness: a.foundation_thickness, title: a.title, blueprint: a.blueprint, installSession: a.install_blueprint_session });

server.registerTool('list_saves', { title: 'List save files', description: 'List Satisfactory save files on this PC, newest first.', inputSchema: {} }, wrap(() => A.savesAction()));

server.registerTool('load_save', {
  title: 'Load a save',
  description: 'Load a save by name or full path (default: newest). Other tools auto-load the newest save if none is loaded.',
  inputSchema: { save: z.string().optional().describe('Save name (partial ok) or full path to a .sav') },
}, wrap((a) => A.loadAction(a.save)));

server.registerTool('factory_status', {
  title: 'Current factory status',
  description: 'Progress (tier, milestones, MAM, alternates), logistics unlocked (belt/lift/pipe/miner tiers), power, every extractor with node purity, production per recipe with measured productivity, item balance, production lines and next milestones with costs vs. what is in storage.',
  inputSchema: {},
}, wrap(() => A.statusAction()));

server.registerTool('suggest_improvements', {
  title: 'Find problems and improvements',
  description: 'Scans the real belt graph: belt-capped miners, under-used nodes, starved or backed-up machines (with the reason), unconnected inputs/outputs, full storage, low fuel, power headroom, belts below your best tier, milestone blockers and free nodes nearby.',
  inputSchema: { limit: z.number().int().optional().describe('Max findings (default 25)') },
}, wrap((a) => A.improveAction({ limit: a.limit })));

server.registerTool('get_unlocks', {
  title: 'What is unlocked',
  description: 'Unlocked buildings, belt/lift/pipe/miner tiers, every unlocked machine recipe with per-minute rates, and the next milestones.',
  inputSchema: {},
}, wrap(() => A.unlocksAction()));

server.registerTool('find_nodes', {
  title: 'Find resource nodes',
  description: 'Resource nodes from the save (type, purity, free/used, distance and compass direction from the HUB).',
  inputSchema: {
    resource: z.string().optional().describe('e.g. "Iron Ore", "Coal", "Crude Oil"'),
    purity: z.enum(['impure', 'normal', 'pure']).optional(),
    include_used: z.boolean().optional().describe('Include nodes that already have a miner'),
    near: z.enum(['hub', 'player']).optional(),
    max_distance: z.number().optional(),
    limit: z.number().int().optional(),
  },
}, wrap((a) => A.nodesAction({ resource: a.resource, purity: a.purity, onlyFree: !a.include_used, near: a.near, maxDistance: a.max_distance, limit: a.limit })));

server.registerTool('item_info', {
  title: 'Item / recipe info',
  description: 'All recipes that make an item (unlocked or locked + what unlocks them), what it is used in, and how many you have.',
  inputSchema: { item: z.string() },
}, wrap((a) => A.itemAction(a.item)));

server.registerTool('plan_production', {
  title: 'Plan production',
  description: 'Optimal production chain using ONLY unlocked recipes and buildings, raw supply from real nodes (purity × miner tier, capped by the best belt), machine counts and clock speeds, node assignments, belts needed per connection, power and build cost.',
  inputSchema: planShape,
}, wrap((a) => A.planAction(toRequest(a))));

server.registerTool('design_factory', {
  title: 'Design a factory layout',
  description: 'Plan + buildable layout sketch: machine rows with splitter/merger manifolds, a belt corridor routing every connection, floors with lifts, foundations, bill of materials vs. your storage, and a step-by-step build order. Writes an HTML sketch + SVG per floor + JSON and returns the paths.',
  inputSchema: { ...planShape, ...areaShape },
}, wrap((a) => A.designAction(toRequest(a), toArea(a))));

server.registerTool('milestone_needs', {
  title: 'What do I still need?',
  description: 'Items still needed for the milestones you can buy now (and the next Space Elevator phase), minus what is in storage. Use it to decide what to build.',
  inputSchema: {
    scope: z.enum(['tier', 'active']).optional().describe('tier (default): all milestones you can buy now; active: only the active one'),
    elevator: z.boolean().optional().describe('Include the next Space Elevator phase (default true)'),
  },
}, wrap((a) => A.needsAction({ scope: a.scope, elevator: a.elevator })));

server.registerTool('plan_rebuild', {
  title: 'Plan a tear-down and rebuild',
  description: 'For replacing temporary builds: plans the new factory (default goal: finish the next milestones as fast as possible from the chosen nodes), lays it out, then compares its cost with storage + what dismantling the old lines refunds (100%). Lists shortages and how to cover each (wait for current production, hand-craft, or build a small affordable stage 1 first) and gives the order of work: what to craft first, when to dismantle, what to build first.',
  inputSchema: {
    ...planShape,
    dismantle: z.union([z.enum(['near', 'all', 'none']), z.array(z.number().int())]).optional().describe('Which old lines to tear down: near (default, within dismantle_radius of the site), all, none, or line numbers from the result'),
    dismantle_radius: z.number().optional().describe('Metres from the site (default 250)'),
    dismantle_power: z.boolean().optional().describe('Also dismantle lines that feed generators (default false)'),
    ...areaShape,
  },
}, wrap((a) => A.rebuildAction(toRequest(a), toArea(a), { scope: a.dismantle, radius: a.dismantle_radius, includePower: a.dismantle_power })));

server.registerTool('make_blueprint', {
  title: 'Make an in-game blueprint',
  description: 'Write verified in-game blueprints (.sbp + .sbpcfg). source "module": a machine module, e.g. 2 or 3 smelters on Iron Ingot (recipe + machines, or recipe + rate for the fewest machines); "plan": the factory from the plan options (like design_factory); "rebuild": the whole new factory from a rebuild; "stage1": only the small first stage of a rebuild. Belts that feed the module and carry its output end open, ready to connect. Returns sizes, which Blueprint Designer it fits, and file paths. Blueprints need the FICSIT Blueprints milestone (Tier 4).',
  inputSchema: {
    source: z.enum(['module', 'plan', 'rebuild', 'stage1']).describe('module (default) | plan | rebuild | stage1'),
    recipe: z.string().optional().describe('module: recipe or item name, e.g. "Iron Ingot", "Screw", "Alternate: Iron Wire"'),
    machines: z.number().int().min(1).max(40).optional().describe('module: number of machines (default 1, or as few as needed for rate)'),
    clock: z.number().min(1).max(250).optional().describe('module: clock speed in % (default 100; above 100 needs power shards)'),
    rate: z.number().positive().optional().describe('module: wanted output of the main product per minute (sets the clock, and the machine count if machines is not given)'),
    belt_tier: z.number().int().min(1).max(6).optional().describe('module: belt tier (default: best unlocked)'),
    gap: z.number().min(0).max(8).optional().describe('module: extra metres between machines (default 0)'),
    name: z.string().max(60).optional().describe('Blueprint name shown in the game'),
    ...planShape,
    dismantle: z.union([z.enum(['near', 'all', 'none']), z.array(z.number().int())]).optional().describe('rebuild/stage1: which old lines to tear down'),
    dismantle_radius: z.number().optional(),
    ...areaShape,
  },
}, wrap((a) => {
  const source = a.source || 'module';
  const installSession = a.install_blueprint_session;
  if (source === 'module') {
    if (!a.recipe) throw new Error('Give a recipe (or item) for the module, e.g. "Iron Ingot".');
    return A.blueprintAction({ source, name: a.name, installSession, module: { recipe: a.recipe, machines: a.machines, clock: a.clock, rate: a.rate, beltTier: a.belt_tier, gap: a.gap } });
  }
  const request = toRequest(a);
  if (source !== 'plan') request.rebuild = true;
  return A.blueprintAction({ source, name: a.name, installSession, request, area: toArea(a), scope: { scope: a.dismantle, radius: a.dismantle_radius } });
}));

server.registerTool('list_lines', {
  title: 'Existing production lines',
  description: 'The player\'s existing production lines (numbered), their miners, and every belt/miner tier with its unlock status. Use the line numbers with upgrade_line.',
  inputSchema: {},
}, wrap(() => A.linesAction()));

server.registerTool('upgrade_line', {
  title: 'Upgrade an existing line',
  description: 'What an existing line becomes with better belts and/or miners (works for tiers not unlocked yet — plan ahead): new output, machines to add, exactly which belts and miners to swap, the cost after refunds vs storage, power, and the steps.',
  inputSchema: {
    line: z.number().int().describe('Line number from list_lines'),
    belt_tier: z.number().int().min(1).max(6).optional().describe('Target belt tier (default: next tier)'),
    miner_tier: z.number().int().min(1).max(3).optional().describe('Target miner tier (default: your best)'),
  },
}, wrap((a) => A.upgradeLineAction({ line: a.line, beltTier: a.belt_tier, minerTier: a.miner_tier })));

server.registerTool('compare_upgrade', {
  title: 'Compare a plan at better tiers',
  description: 'Plans the same goal twice — at the current belt/miner tiers and at better ones — and shows output, time to finish, machines to add, belts to upgrade, and the upgrade path from one to the other.',
  inputSchema: {
    ...planShape,
    upgrade_belt_tier: z.number().int().min(1).max(6).optional().describe('Belt tier to compare with (default: next tier)'),
    upgrade_miner_tier: z.number().int().min(1).max(3).optional().describe('Miner tier to compare with (default: your best)'),
  },
}, wrap((a) => A.upgradePlanAction(toRequest(a), { beltTier: a.upgrade_belt_tier, minerTier: a.upgrade_miner_tier })));

server.registerTool('upgrade_options', {
  title: 'Upgrade options for existing production',
  description: 'For each existing miner/line: what it delivers now, what it could deliver now, with the next belt tier and with the next miner tier (and which milestone unlocks them), how many machines to add, and the belt swap cost.',
  inputSchema: {},
}, wrap(() => A.upgradesAction()));

server.registerTool('export_context', {
  title: 'Export factory brief',
  description: 'One markdown document with status + issues, for pasting into another AI or keeping notes.',
  inputSchema: {},
}, wrap(() => A.contextAction()));

server.registerPrompt('review_factory', {
  title: 'Review my factory',
  description: 'Scan the latest save, explain the current situation, list the most valuable improvements and ask what to build next.',
  argsSchema: { save: z.string().optional() },
}, ({ save }) => ({
  messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: `Review my Satisfactory factory${save ? ` from save "${save}"` : ''}.
1. Call load_save${save ? ` with "${save}"` : ''}, then factory_status and suggest_improvements.
2. Summarise where I am (tier, active milestone and what is missing for it, power headroom, best belt).
3. Give the top 5 improvements, most valuable first, each with where it is and the concrete fix.
4. Then ask me what I want to build next. Offer 2–3 sensible goals based on my milestone and unlocks, and ask: foundation or ground build, available width × length (metres or foundations), and how many floors.
Do not suggest anything I have not unlocked. Belts are limited to my best belt tier.`,
    },
  }],
}));

server.registerPrompt('design_build', {
  title: 'Design a build',
  description: 'Plan and sketch a production line for a goal.',
  argsSchema: {
    goal: z.string().describe('e.g. "10/min Modular Frame"'),
    area: z.string().optional().describe('e.g. "8x12 foundations, 2 floors" or "ground 60x80 m"'),
  },
}, ({ goal, area }) => ({
  messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: `I want to build: ${goal}.${area ? ` Area: ${area}.` : ''}
Use plan_production first and check it is feasible with my unlocks, nodes and belt tier; if not, explain what limits it and propose the closest feasible target.
Then call design_factory${area ? ' with that area' : ' (ask me for foundation/ground, width × length and floors first if I did not say)'}.
Hand over: machine list with clock speeds, which nodes to mine, the build order, the materials I am short of, and the path to the HTML sketch.`,
    },
  }],
}));

server.registerPrompt('rebuild_base', {
  title: 'Replace my temporary base',
  description: 'Work out what to build from nearby nodes, whether you can afford to tear down and rebuild, and in what order.',
  argsSchema: { nodes: z.string().optional().describe('e.g. "the 3 iron nodes near the HUB"'), area: z.string().optional() },
}, ({ nodes, area }) => ({
  messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: `My current factory is temporary and I want to replace it${nodes ? ` using ${nodes}` : ''}${area ? `, area: ${area}` : ''}.
1. Call milestone_needs and tell me in short what my next milestones still need beyond what I have.
2. Call find_nodes (include_used: true, max_distance 300) and agree with me which nodes to use (say which ones are useless right now and why).
3. Call plan_rebuild with those nodes (rebuild: true)${area ? ' and the area' : ' — ask me foundation/ground, width × length and floors if I did not say'}.
4. Explain: how long the new factory takes to finish the milestones, what I get back from dismantling, what is still short and how to cover it, and the exact order of work (what to craft first, WHEN to dismantle, what to build first). Never suggest dismantling before shortages are covered.
5. Mention one or two upgrade_options for later.`,
    },
  }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
