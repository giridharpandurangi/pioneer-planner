// Captures README screenshots of the running web UI with a headless Edge/Chrome.
//   1. npm run web            (in another terminal)
//   2. node tools/screenshots.js [<output folder name for the rebuild guide + sketch>]
// Writes docs/screenshots/*.png. Uses a throw-away browser profile.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const BASE = process.env.SFP_URL || 'http://localhost:5178';
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = BROWSERS.find((b) => fs.existsSync(b));
if (!browser) throw new Error('No Edge/Chrome found.');

const designDir = process.argv[2] || fs.readdirSync(path.join(ROOT, 'output')).filter((d) => fs.existsSync(path.join(ROOT, 'output', d, 'rebuild-guide.html'))).sort().pop();
const nodes = 'BP_ResourceNode586,BP_ResourceNode551,BP_ResourceNode497_1';
const shots = [
  { name: 'overview', url: '/?tab=overview', size: [1400, 1000] },
  { name: 'node-map', url: '/?tab=nodes&q=Iron%20Ore&purity=pure', size: [1400, 960] },
  { name: 'plan-automatic', url: `/?tab=plan&goal=milestones&nodes=${nodes}&rebuild=1&run=plan`, size: [1400, 1250] },
  { name: 'upgrade-line', url: '/?tab=upgrade&line=1&belt=2&miner=1', size: [1400, 1350] },
  designDir && { name: 'rebuild-guide', url: `/output/${designDir}/rebuild-guide.html`, size: [1100, 2350] },
  designDir && { name: 'layout-sketch', url: `/output/${designDir}/index.html`, size: [1250, 1500] },
].filter(Boolean);

fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sfp-shot-'));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Edge's launcher can return before the headless browser has written the file: wait until it exists and stops growing
function waitForFile(file, ms = 90000) {
  let last = -1;
  for (let t = 0; t < ms; t += 500) {
    sleep(500);
    if (!fs.existsSync(file)) continue;
    const size = fs.statSync(file).size;
    if (size > 0 && size === last) return true;
    last = size;
  }
  return false;
}
for (const s of shots) {
  const file = path.join(OUT, `${s.name}.png`);
  if (fs.existsSync(file)) fs.rmSync(file);
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--window-size=${s.size[0]},${s.size[1]}`, '--virtual-time-budget=20000',
    '--force-device-scale-factor=1', `--screenshot=${file}`, BASE + s.url,
  ], { stdio: 'ignore', timeout: 90000 });
  if (!waitForFile(file)) { console.log(`${s.name}.png  FAILED (no file)`); continue; }
  console.log(`${s.name}.png  ${Math.round(fs.statSync(file).size / 1024)} KB`);
}
fs.rmSync(profile, { recursive: true, force: true });
