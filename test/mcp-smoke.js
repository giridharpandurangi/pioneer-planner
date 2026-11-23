// Starts the MCP server over stdio and calls a few tools like an AI client would.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp/server.js')] });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));
const prompts = await client.listPrompts();
console.log('prompts:', prompts.prompts.map((p) => p.name).join(', '));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content[0].text;
  console.log(`\n=== ${name} ${r.isError ? '(ERROR)' : ''} — ${t.length} chars\n${t.slice(0, 400)}${t.length > 400 ? '\n…' : ''}`);
  return r;
};
await call('load_save');
await call('factory_status');
await call('suggest_improvements', { limit: 3 });
await call('find_nodes', { resource: 'Iron Ore', limit: 3 });
await call('plan_production', { targets: [{ item: 'Reinforced Iron Plate', rate: 5 }] });
await call('plan_production', { targets: [{ item: 'Computer', rate: 1 }] });
const d = await call('design_factory', { targets: [{ item: 'Reinforced Iron Plate', rate: 5 }], mode: 'foundation', width: 8, length: 12, unit: 'foundations' });
const ok = !d.isError && /Sketch:/.test(d.content[0].text);
const dir = d.content[0].text.match(/layout\.json in (.+)\)/)?.[1];
if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
await client.close();
console.log(ok ? '\nMCP smoke test passed' : '\nMCP smoke test FAILED');
process.exit(ok ? 0 : 1);
