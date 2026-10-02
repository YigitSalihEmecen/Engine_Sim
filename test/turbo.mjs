/**
 * turbo.mjs — what the turbo sounds like, measured.
 *
 *   node test/turbo.mjs [engines...]      (turbo engines by default)
 *
 * For each turbo engine: the whine's pitch and level against the full mix at
 * the end of each pull, and for each of three lifts (full at mid revs,
 * partial 1→0.3, full off the limiter) the peak surge state, how deeply the
 * turbo pulses at the flutter rate (6-35 Hz envelope modulation, 0..~1) and
 * how loud the turbo is on the lift against the mix just before it and
 * against the whole mix during the lift (0 dB = the turbo IS the sound).
 * Same Playwright setup as render.mjs.
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
if (!pw) { console.error('turbo.mjs: Playwright not found (set PLAYWRIGHT_PATH)'); process.exit(2); }
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = createServer(async (req, res) => {
  try {
    const p = normalize(join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    if (!p.startsWith(ROOT)) throw new Error('outside');
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage();
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto(`http://localhost:${server.address().port}/test/render.html`);
await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
const TURBO = ['i3', 'boxer4', 'i5', 'i6', 'i6diesel', 'v6tt', 'v8tt'];
const list = process.argv.slice(2).length ? process.argv.slice(2) : TURBO;
console.log('engine    whine Hz / dB vs mix (3 pulls)         | lift: rpm spool surge depth dB-vs-mix(before/during)');
for (const e of list) {
  const r = await page.evaluate(([e, tweak]) => window.runTurbo(e, { tweak }), [e, process.env.EXTRA || '']);
  const w = r.whine.map(x => `${x.hz.toFixed(0).padStart(5)}/${x.rel.toFixed(0).padStart(3)}`).join(' ');
  const l = r.lifts.map(x => `${String(x.rpm).padStart(5)} ${x.spool.toFixed(2)} ${x.surge.toFixed(2)} ${x.depth.toFixed(2)} ${x.rel.toFixed(0).padStart(3)}/${x.relLift.toFixed(0).padStart(3)}`).join(' |');
  console.log(`${e.padEnd(9)} ${w}  |${l}`);
}
await browser.close();
server.close();
