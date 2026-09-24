// Captures README demo media (screenshots + GIF frames) from a running local server
// by driving headless Chrome over the DevTools protocol.
//   node scripts/capture-demo.mjs   (then: python scripts/make-gif.py)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.URL || 'http://localhost:3000/?ai=local&capture=1&red=kane&blue=zola';
const OUT = path.resolve('docs');
const FRAMES = path.join(tmpdir(), 'jevbox-frames');
const PORT = 9333;
mkdirSync(OUT, { recursive: true });
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const profile = path.join(tmpdir(), 'jevbox-chrome');
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--window-size=1280,720',
  '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (file, { scale = 1, fmt = 'png' } = {}) => {
  const r = await send('Page.captureScreenshot', { format: fmt, quality: fmt === 'jpeg' ? 82 : undefined, clip: { x: 0, y: 0, width: 1280, height: 720, scale } });
  writeFileSync(file, Buffer.from(r.result.data, 'base64'));
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });
await sleep(6000);
await shot(path.join(OUT, 'select.png'));
console.log('select.png');

await evaluate(`document.getElementById('start').click()`);
await sleep(1300);
await shot(path.join(OUT, 'vs.png'));
console.log('vs.png');
await sleep(2000);
// fast-forward the walkout to the opening bell
await evaluate(`(async () => { for (let t = 0; t < 14; t += 0.25) { __sim.advance(0.25, 60, false); await new Promise(r => setTimeout(r, 20)); } })()`);

// GIF frames: 15 fps of sim time, rendered one by one (fetches for Jev decisions resolve between frames)
let n = 0;
const frame = async () => { await shot(path.join(FRAMES, `f${String(n++).padStart(4, '0')}.jpg`), { scale: 0.5, fmt: 'jpeg' }); };
for (let i = 0; i < 70; i++) {
  await evaluate(`__sim.advance(1/15, 60, false); __sim.advance(1/120, 120, true); 1`);
  await frame();
}
// super move moment
await evaluate(`__sim.fighters.red.meter = 100; 1`);
for (let i = 0; i < 60; i++) {
  await evaluate(`__sim.advance(1/15, 60, false); __sim.advance(1/120, 120, true); 1`);
  await frame();
  if (i === 30) await shot(path.join(OUT, 'fight.png'));
}
// knockdown / finish
await evaluate(`__sim.fighters.blue.hp = 2; __sim.fighters.blue.knockdowns = 2; __sim.fighters.blue.poise = 2; 1`);
for (let i = 0; i < 110; i++) {
  await evaluate(`__sim.advance(1/15, 60, false); __sim.advance(1/120, 120, true); 1`);
  await frame();
  if (await evaluate(`__sim.phase === 'over' && __sim.real > 0`) && i % 2) break;
}
for (let i = 0; i < 24; i++) {
  await evaluate(`__sim.advance(1/15, 60, false); __sim.advance(1/120, 120, true); 1`);
  await frame();
}
await shot(path.join(OUT, 'finish.png'));
console.log(`frames: ${n} in ${FRAMES}`);
const errs = await evaluate(`JSON.stringify(__sim.errors.slice(-3))`);
console.log('errors:', errs);
ws.close();
chrome.kill();
