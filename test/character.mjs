/**
 * character.mjs — how tonal, and how DISTINCT, the engines are.
 *
 *   node test/character.mjs [engines...]
 *
 * Each engine on a dyno (render.html runDyno): full throttle in 3rd, the
 * brake holding ~60 % of redline. Prints, per engine, how much of the sound is
 * on the engine's harmonics (tonal, and A-weighted) — a noise layer drags this
 * down — and the first orders' levels. Then the DISTINCTIVENESS: the mean
 * pairwise RMS difference, in dB, between engines' order profiles (orders
 * 0.5-12). Homogenised engines have a small number here.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const require = createRequire(import.meta.url);
const pw = [process.env.PLAYWRIGHT_PATH, 'playwright', '/opt/node-tools/node_modules/playwright']
  .filter(Boolean).map(t => { try { return require(t); } catch (e) { return null; } }).find(Boolean);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = createServer(async (req, res) => {
  try {
    const p = normalize(join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    if (!p.startsWith(ROOT)) throw new Error('outside');
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(body);
  } catch (e) { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage();
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto(`http://localhost:${server.address().port}/test/render.html`);
await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
const all = await page.evaluate(() => window.engines());
const list = process.argv.slice(2).length ? process.argv.slice(2) : all;
const res = [];
console.log('engine     source rpm(target)  tonal  tonalA   orders 0.5 1 1.5 2 2.5 3 3.5 4 ... (dB re strongest)');
for (const e of list) {
  const r = await page.evaluate(([e, tweak, wavetables]) => window.runDyno(e, { tweak, wavetables }), [e, process.env.EXTRA || '', !!process.env.WAVETABLES]);
  res.push(r);
  console.log(`${e.padEnd(10)} ${r.source.slice(0, 5).padEnd(6)}${String(r.rpm).padStart(5)}(${r.target})  ${(r.tonal * 100).toFixed(0).padStart(4)}%  ${(r.tonalA * 100).toFixed(0).padStart(5)}%   ` +
    r.orders.slice(0, 16).map(v => v.toFixed(0).padStart(4)).join(''));
}
let sum = 0, n = 0;
for (let i = 0; i < res.length; i++) for (let j = i + 1; j < res.length; j++) {
  let d = 0; for (let h = 0; h < 24; h++) d += (Math.max(-50, res[i].orders[h]) - Math.max(-50, res[j].orders[h])) ** 2;
  sum += Math.sqrt(d / 24); n++;
}
const mean = (k) => res.reduce((a, r) => a + r[k], 0) / res.length;
console.log(`\nmean tonal ${(mean('tonal') * 100).toFixed(0)}%, A-weighted ${(mean('tonalA') * 100).toFixed(0)}%;  distinctiveness ${(sum / Math.max(1, n)).toFixed(1)} dB (mean pairwise RMS difference of order profiles, orders 0.5-12)`);
await browser.close(); server.close();
