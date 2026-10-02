/**
 * chain.mjs — where the engine's tone goes, octave by octave.
 *
 *   node test/chain.mjs [engines...]
 *
 * Three rows per engine, dB relative to the 125 Hz octave:
 *   voices  the raw sum of every voice (the mix bus), before any processing
 *   chain   what everything after the bus does to each octave (output − bus)
 *   output  what reaches the speakers
 * "Muffled" reads as a falling `output` above 1 kHz; "boomy" as 31-125 Hz
 * standing above 250-1000.
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
await page.goto(`http://localhost:${server.address().port}/test/render.html`);
await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
const list = process.argv.slice(2).length ? process.argv.slice(2) : ['i4', 'v8cross', 'v12', 'v8tt'];
let hdr = false;
const outs = [];
for (const e of list) {
  const r = await page.evaluate(([e, tweak]) => window.chainResponse(e, { tweak }), [e, process.env.EXTRA || '']);
  if (!hdr) { console.log('engine    row     ' + r.octs.map(f => (f >= 1000 ? f / 1000 + 'k' : String(f)).padStart(6)).join('')); hdr = true; }
  outs.push(r.out);
  if (process.env.QUIET) continue;
  for (const k of ['voices', 'chain', 'output']) {
    const v = k === 'voices' ? r.bus : k === 'output' ? r.out : r.chain;
    console.log(`${(k === 'voices' ? e : '').padEnd(9)} ${k.padEnd(7)} ` + v.map(x => x.toFixed(1).padStart(6)).join(''));
  }
}
// Spread across engines: the std, per octave, of the engines' output curves,
// averaged over 63 Hz-4 kHz. Engines pushed toward one tonal balance (by a
// compressor, or by shared layers) have a small number here.
if (outs.length > 2) {
  let acc = 0, n = 0;
  for (let o = 1; o <= 7; o++) {
    const v = outs.map(r => r[o]), m = v.reduce((a, b) => a + b, 0) / v.length;
    acc += Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); n++;
  }
  console.log(`\ntonal-balance spread across ${outs.length} engines: ${(acc / n).toFixed(1)} dB (std per octave, 63 Hz-4 kHz)`);
}
await browser.close(); server.close();
