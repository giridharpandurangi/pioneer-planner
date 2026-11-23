// Renders launcher/pioneer.svg to PNG with headless Edge/Chrome and packs it into launcher/pioneer.ico.
//   node tools/make-icon.js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(ROOT, 'launcher', 'pioneer.svg');
const ICO = path.join(ROOT, 'launcher', 'pioneer.ico');

const teeth = Array.from({ length: 8 }, (_, i) => `<rect x="-19" y="-96" width="38" height="44" rx="7" transform="rotate(${i * 45})"/>`).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect x="6" y="6" width="244" height="244" rx="58" fill="#f59e0b"/>
  <rect x="6" y="6" width="244" height="244" rx="58" fill="none" stroke="#b45309" stroke-width="6"/>
  <g transform="translate(128 120)" fill="#1c2027">${teeth}<circle r="66"/></g>
  <circle cx="128" cy="120" r="27" fill="#f59e0b"/>
  <rect x="44" y="206" width="168" height="16" rx="8" fill="#1c2027"/>
  <circle cx="64" cy="214" r="4" fill="#f59e0b"/><circle cx="96" cy="214" r="4" fill="#f59e0b"/><circle cx="128" cy="214" r="4" fill="#f59e0b"/><circle cx="160" cy="214" r="4" fill="#f59e0b"/><circle cx="192" cy="214" r="4" fill="#f59e0b"/>
</svg>
`;
fs.writeFileSync(SVG, svg);

const browser = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((b) => fs.existsSync(b));
if (!browser) throw new Error('No Edge/Chrome found.');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfp-icon-'));
const html = path.join(tmp, 'icon.html');
fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="256" height="256" style="display:block"></body></html>`);
const png = path.join(tmp, 'icon.png');
execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${path.join(tmp, 'profile')}`, '--default-background-color=00000000', '--window-size=256,256', '--force-device-scale-factor=1', `--screenshot=${png}`, `file:///${html.replace(/\\/g, '/')}`], { stdio: 'ignore', timeout: 60000 });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let i = 0; i < 120 && !(fs.existsSync(png) && fs.statSync(png).size > 0); i++) sleep(500);
sleep(500);
const data = fs.readFileSync(png);

// ICO container with one 256x256 PNG image (Windows scales it for smaller sizes)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); entry.writeUInt8(0, 1); // 0 = 256 px
entry.writeUInt8(0, 2); entry.writeUInt8(0, 3);
entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(data.length, 8); entry.writeUInt32LE(22, 12);
fs.writeFileSync(ICO, Buffer.concat([header, entry, data]));
fs.copyFileSync(png, path.join(ROOT, 'launcher', 'pioneer.png'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${path.relative(ROOT, ICO)} (${data.length} bytes PNG inside)`);
