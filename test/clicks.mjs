/**
 * clicks.mjs — find crackle in a rendered WAV.
 *
 *   node test/clicks.mjs out/v8cross.wav [...]
 *
 * A click is a sample-scale discontinuity: the second difference (an
 * aggressive high-pass that a smooth engine waveform barely excites) jumps far
 * above its own running level. Reports clicks per second over 100 ms frames
 * with the times of the worst, so a crackle that is "always there" shows as a
 * steady rate and a single pop as one entry.
 */
import { readFileSync } from 'node:fs';

export function readWav(file) {
  const b = readFileSync(file);
  const n = (b.length - 44) / 4, L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = b.readInt16LE(44 + i * 4) / 32768;
  return L;
}

/** Returns { rate, events: [t, ratio] } for a mono float signal. */
export function findClicks(x, sr = 48000, { k = 9, from = 0.3 } = {}) {
  const n = x.length, d = new Float32Array(n);
  for (let i = 2; i < n; i++) d[i] = x[i] - 2 * x[i - 1] + x[i - 2];
  // running RMS of d over 5 ms, excluding the centre sample
  const W = Math.round(sr * 0.005);
  let ss = 0;
  const events = [];
  let last = -1e9;
  for (let i = 0; i < n; i++) {
    ss += d[i] * d[i];
    if (i >= 2 * W) ss -= d[i - 2 * W] * d[i - 2 * W];
    if (i < 2 * W || i / sr < from) continue;
    const c = i - W;   // centre of the window
    const rms = Math.sqrt(Math.max(0, ss - d[c] * d[c]) / (2 * W - 1)) + 1e-6;
    const r = Math.abs(d[c]) / rms;
    if (r > k && c - last > sr * 0.002) { events.push([c / sr, r]); last = c; }
  }
  return { rate: events.length / (n / sr - from), events };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of process.argv.slice(2)) {
    const { rate, events } = findClicks(readWav(f));
    const worst = [...events].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([t, r]) => `${t.toFixed(3)}s×${r.toFixed(0)}`).join(' ');
    console.log(`${f.split('/').pop().padEnd(28)} ${String(events.length).padStart(5)} clicks  ${rate.toFixed(1).padStart(6)}/s   ${worst}`);
  }
}
