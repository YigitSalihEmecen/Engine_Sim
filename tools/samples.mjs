#!/usr/bin/env node
/**
 * samples.mjs — render the listening samples in samples/ (used by samples.html
 * and the README).
 *
 *   node tools/samples.mjs                 every engine below, NA and turbo
 *   node tools/samples.mjs v8cross v12     just these
 *   node tools/samples.mjs --video         build samples/<engine>.mp4 from the
 *                                          rendered files: Natural then Turbo,
 *                                          spectrograms with a moving playhead.
 *                                          (GitHub only plays video inline in a
 *                                          README, and only when uploaded through
 *                                          its web editor — see the README.)
 *
 * Renders offline in headless Chrome (the real graph, worklet included) via
 * the DevTools protocol — no dependencies — then encodes MP3 with ffmpeg.
 * Set CHROME to point at a Chrome binary if it is not in the default place.
 */
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'samples');
const VIDEO = process.argv.includes('--video');
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ENGINES = ARGS.length ? ARGS : ['i4', 'i6', 'v8cross', 'v10', 'v12'];
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8190 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs'), String(PORT)], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'samples-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT + 1}`,
  `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

try {
  let tabs;
  for (let i = 0; i < 60 && !tabs; i++) {
    try { tabs = await (await fetch(`http://127.0.0.1:${PORT + 1}/json`)).json(); } catch { await sleep(200); }
  }
  const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const call = (method, params = {}) => new Promise((r) => {
    const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 600000 });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'page error');
    return r.result?.result?.value;
  };

  await call('Page.navigate', { url: `http://localhost:${PORT}/tools/samples.html` });
  for (let i = 0; i < 100 && !(await evaluate('window.ready === true')); i++) await sleep(200);

  if (VIDEO) {
    const labels = Object.fromEntries(JSON.parse(readFileSync(join(OUT, 'samples.json'), 'utf8'))
      .map((s) => [s.engine, s.label]));
    for (const engine of ENGINES) {
      process.stdout.write(`  ${(engine + '.mp4').padEnd(14)}`);
      const frame = await evaluate(`window.videoFrame(${JSON.stringify(engine)}, ${JSON.stringify(labels[engine] || engine)})`);
      const bg = join(OUT, engine + '-frame.png');
      writeFileSync(bg, Buffer.from(frame.split(',')[1], 'base64'));
      // Playhead: over the Natural spectrogram for the first 10 s, then the
      // Turbo one (geometry matches videoFrame in tools/samples.html).
      const graph = [
        '[1:a][2:a]concat=n=2:v=0:a=1[a]',
        'color=c=white:s=4x228:r=30,split[ph1][ph2]',
        "[0:v][ph1]overlay=x='48+1184*t/10':y=176:enable='lt(t,10)'[v1]",
        "[v1][ph2]overlay=x='48+1184*(t-10)/10':y=478:enable='gte(t,10)',format=yuv420p[v]",
      ].join(';');
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', '30', '-i', bg,
        '-i', join(OUT, engine + '.mp3'), '-i', join(OUT, engine + '-turbo.mp3'),
        '-filter_complex', graph,
        '-map', '[v]', '-map', '[a]', '-t', '20', '-c:v', 'libx264', '-tune', 'stillimage', '-crf', '24',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', join(OUT, engine + '.mp4')]);
      rmSync(bg);
      console.log('ok');
    }
    ws.close();
    process.exitCode = 0;
  }

  mkdirSync(OUT, { recursive: true });
  // Re-rendering a few keeps the others in the index.
  const indexPath = join(OUT, 'samples.json');
  const index = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, 'utf8')).filter((s) => !ENGINES.includes(s.engine)) : [];
  for (const engine of VIDEO ? [] : ENGINES) {
    for (const turbo of [false, true]) {
      const name = engine + (turbo ? '-turbo' : '');
      process.stdout.write(`  ${name.padEnd(14)}`);
      const r = await evaluate(`window.renderSample(${JSON.stringify(engine)}, ${turbo})`);
      const wav = join(OUT, name + '.wav');
      writeFileSync(wav, Buffer.from(r.wav, 'base64'));
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', '3', join(OUT, name + '.mp3')]);
      rmSync(wav);
      writeFileSync(join(OUT, name + '.jpg'), Buffer.from(r.img.split(',')[1], 'base64'));
      index.push({ id: name, engine, turbo, label: r.label, redline: r.redline, trace: r.trace });
      console.log(`peak ${r.peak.toFixed(2)} before normalising`);
    }
  }
  if (!VIDEO) writeFileSync(indexPath, JSON.stringify(index));
  ws.close();
} finally {
  server.kill();
  await new Promise((r) => { chrome.once('exit', r); chrome.kill(); });
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
