/**
 * render.mjs — offline render of the real browser DSP, every engine.
 *
 *   node test/render.mjs                 all engines, summary table
 *   node test/render.mjs v12 i4          just those
 *   WAV=out/ node test/render.mjs v8cross   also write a .wav per engine
 *   STRICT=1 node test/render.mjs        exit non-zero if any bar is missed
 *                                        (with WAV= set, > 2 clicks/s fails too)
 *
 * Needs Playwright + Chromium (not a dependency of this project — it looks for
 * a global install, or PLAYWRIGHT_PATH). spectrum.mjs is the analytic check of
 * the linear path; this is the measured check of everything, including the
 * nonlinear and dynamic stages it cannot model.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readWav, findClicks } from './clicks.mjs';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const require = createRequire(import.meta.url);

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_PATH, 'playwright',
    '/opt/node-tools/node_modules/playwright'].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (e) { /* next */ } }
  console.error('render.mjs: Playwright not found (set PLAYWRIGHT_PATH)');
  process.exit(2);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const p = normalize(join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    if (!p.startsWith(ROOT)) throw new Error('outside');
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (e) { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const { chromium } = loadPlaywright();
const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('console', m => console.log('[page]', m.text()));
page.on('pageerror', e => console.error('page error:', e.message));
console.log('page');
await page.goto(`http://localhost:${port}/test/render.html`);
await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });

console.log('ready');
const want = process.argv.slice(2);
const all = await page.evaluate(() => window.engines());
const list = want.length ? all.filter(e => want.includes(e)) : all;
const wavDir = process.env.WAV;
if (wavDir) await mkdir(wavDir, { recursive: true });

const pct = v => (v * 100).toFixed(1).padStart(5);
const db = v => (20 * Math.log10(v + 1e-9)).toFixed(1).padStart(6);
console.log('\nOffline render — pull in 3rd to the limiter, lift, blip. Output is unclipped float.\n');
console.log('engine     peak dBFS clips  shaperPk  busPk   rms dB  cent  centHi  <40  40-80 80-160 160-320 1.3-2.6k 2.6-5k  tone dB@Hz(rpm)  toneHi  maxRpm  Aharsh% hi% max%');
let fail = 0;
for (const e of list) {
  const s = await page.evaluate(([e, w, secs, solo, dyn, tweak]) => window.runOne(e, { wav: w, seconds: secs, solo: solo, dyn, tweak }), [e, !!wavDir, +(process.env.SECS || 11), process.env.SOLO || '', process.env.DYN ?? '', process.env.EXTRA || '']);
  if (wavDir && s.wav) await writeFile(join(wavDir, e + (process.env.SOLO ? '.' + process.env.SOLO : '') + '.wav'), Buffer.from(s.wav, 'base64'));
  const line = [
    e.padEnd(10), db(s.peak), String(s.clips).padStart(6), s.shaperPeak.toFixed(2).padStart(8),
    s.busPeak.toFixed(2).padStart(7), s.rmsDb.toFixed(1).padStart(7),
    s.centroid.toFixed(0).padStart(6), s.centroidHi.toFixed(0).padStart(6),
    pct(s.bands[0]), pct(s.bands[1]), pct(s.bands[2]), pct(s.bands[3]), pct(s.bandsHi[6]), pct(s.bandsHi[7]),
    `${(s.tone||0).toFixed(1)}@${(s.toneF||0).toFixed(0)}(${(s.toneRpm||0).toFixed(0)})`.padStart(17),
    s.toneHiMean.toFixed(1).padStart(7), String(Math.round(s.maxRpm)).padStart(6), pct(s.harsh), pct(s.harshHi), pct(s.harshMax), '@' + s.harshMaxT.toFixed(1) + 's',
    'crisp', s.crisp.toFixed(1).padStart(6), s.crispHi.toFixed(1).padStart(6),
  ].join(' ');
  // Crackle: sample-scale discontinuities per second (clicks.mjs). Needs the
  // WAV; a clean engine is 0-1/s, the rumble-layer crackle was 50-78/s.
  let clickRate = 0;
  if (wavDir && s.wav) {
    clickRate = findClicks(readWav(join(wavDir, e + (process.env.SOLO ? '.' + process.env.SOLO : '') + '.wav'))).rate;
  }
  console.log(line + (wavDir ? `  clicks ${clickRate.toFixed(1)}/s` : ''));
  if (s.clips > 0 || s.peak > 0.98 || clickRate > 2) fail++;
}
await browser.close();
server.close();
if (process.env.STRICT && fail) { console.log(`\n${fail} engine(s) over the bar`); process.exit(1); }
