/**
 * run.mjs — headless integration harness.
 *
 * Nobody can hear the output here, so this checks everything that is checkable
 * without ears: physical plausibility of the derived numbers, absence of the
 * failure modes that silently kill a Web Audio graph (NaN into an AudioParam,
 * frequencies past Nyquist, feedback gain >= 1), and that the graph is built
 * once rather than per frame.
 *
 *   node test/run.mjs            all suites
 *   node test/run.mjs orders     one suite
 */

import { createMockContext, installGlobals } from './mock-audio.mjs';
import { ENGINE_PROFILES, VEHICLE_PRESETS, bankAngles, firingAngles, pipeDelay, pipeFrequency }
  from '../src/profiles.js';
import { orderSpectrum, buildCycle, toPressureGradient, cycleToCoefficients, reconstruct }
  from '../src/pulse.js';

let failures = 0, checks = 0;
const only = process.argv[2];

async function suite(name, fn) {
  if (only && !name.includes(only)) return;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
  try { await fn(); } catch (e) { failures++; console.log(`  \x1b[31mTHREW\x1b[0m ${e.message}`); }
}
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? '  ' + detail : ''}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
}
function info(label, detail) { console.log(`    \x1b[2m${label}\x1b[0m ${detail}`); }

// ---------------------------------------------------------------------------

await suite('firing geometry', () => {
  for (const [id, p] of Object.entries(ENGINE_PROFILES)) {
    const angles = firingAngles(p);
    ok(angles.size === p.cylinders, `${id}: every cylinder has a firing angle`);
    const bankTotal = p.banks.flat().length;
    ok(bankTotal === p.cylinders, `${id}: banks cover all cylinders`,
       `${bankTotal} vs ${p.cylinders}`);
    const uniq = new Set(p.banks.flat());
    ok(uniq.size === p.cylinders, `${id}: no cylinder in two banks`);
    ok(new Set(p.firingOrder).size === p.cylinders, `${id}: firing order is a permutation`);
  }
});

await suite('orders — burble comes from geometry, not tuning', () => {
  const halfEnergy = (id) => {
    const p = ENGINE_PROFILES[id];
    const spec = orderSpectrum(p, bankAngles(p, 0), 0.5, 24);
    let half = 0, tot = 0;
    for (const s of spec) {
      const isHalf = Math.abs(s.order % 1) > 0.01;
      tot += s.mag ** 2; if (isHalf) half += s.mag ** 2;
    }
    return 100 * half / tot;
  };
  const cross = halfEnergy('v8cross'), flat = halfEnergy('v8flat');
  ok(cross > 20, 'cross-plane V8 has strong half-orders (burble)', cross.toFixed(1) + '%');
  ok(flat < 1, 'flat-plane V8 has none (flat scream)', flat.toFixed(1) + '%');
  ok(halfEnergy('i4') < 1, 'I4 has none', halfEnergy('i4').toFixed(1) + '%');
  ok(halfEnergy('i6') < 1, 'I6 has none', halfEnergy('i6').toFixed(1) + '%');
  // Odd cylinders per bank must fire at a non-integer order.
  ok(halfEnergy('flat6') > 20, 'flat-6 (3 per bank → 1.5 order)', halfEnergy('flat6').toFixed(1) + '%');
  ok(halfEnergy('v10') > 20, 'V10 (5 per bank → 2.5 order)', halfEnergy('v10').toFixed(1) + '%');
});

await suite('wavetable analysis/synthesis round-trip', () => {
  const p = { cylinders: 1, pulse: { attack: 40, decay: 6, hardness: 0.6, jitter: 0 } };
  const cyc = buildCycle(p, [0], 0.5);
  const c = cycleToCoefficients(cyc, 2048);
  const rec = reconstruct(c.real, c.imag, 1024);
  const target = Array.from({ length: 1024 }, (_, i) => cyc[i * 8]);
  const mean = target.reduce((a, b) => a + b, 0) / target.length;
  const t2 = target.map(v => v - mean);
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < 1024; i++) { d += rec[i] * t2[i]; x += rec[i] ** 2; y += t2[i] ** 2; }
  const r = d / Math.sqrt(x * y);
  ok(r > 0.999, 'coefficients reconstruct the cycle exactly', 'r=' + r.toFixed(6));

  // Control: the test must be able to fail.
  const flip = reconstruct(c.real, c.imag.map(v => -v), 1024);
  let d2 = 0, x2 = 0;
  for (let i = 0; i < 1024; i++) { d2 += flip[i] * t2[i]; x2 += flip[i] ** 2; }
  ok(d2 / Math.sqrt(x2 * y) < 0.5, 'flipped sign convention would be caught',
     'r=' + (d2 / Math.sqrt(x2 * y)).toFixed(3));

  for (const [id, prof] of Object.entries(ENGINE_PROFILES)) {
    const co = cycleToCoefficients(toPressureGradient(buildCycle(prof, bankAngles(prof, 0), 1)));
    let bad = 0;
    for (let i = 0; i < co.real.length; i++) {
      if (!isFinite(co.real[i]) || !isFinite(co.imag[i])) bad++;
    }
    ok(bad === 0, `${id}: all coefficients finite`);
  }
});

await suite('exhaust geometry vs the orders the engine actually produces', () => {
  // A pipe that resonates far from any order the engine emits is a data bug.
  for (const [id, p] of Object.entries(ENGINE_PROFILES)) {
    const fBank = pipeFrequency(p.exhaust.bank, p.gasTempFactor);
    const dBank = pipeDelay(p.exhaust.bank, p.gasTempFactor);
    // engine order N sits at rpm/120 * N Hz; sweep the usable rev range
    const loF = p.idleRpm / 120, hiF = p.redlineRpm / 120;
    const domOrder = p.cylinders / p.banks.length;      // firings per bank per cycle... in orders
    const loDom = loF * domOrder, hiDom = hiF * domOrder;
    const inRange = fBank > loDom * 0.4 && fBank < hiDom * 4;
    info(id.padEnd(9),
      `pipe ${p.exhaust.bank}m → ${fBank.toFixed(0)}Hz (delay ${(dBank * 1000).toFixed(2)}ms), ` +
      `dominant order sweeps ${loDom.toFixed(0)}–${hiDom.toFixed(0)}Hz`);
    ok(inRange, `${id}: bank pipe resonance is musically related to the firing range`);
    ok(dBank * 48000 >= 128 || p.exhaust.bank < 0.5,
       `${id}: pipe delay vs the 128-sample feedback floor`,
       `${(dBank * 48000).toFixed(0)} samples`);
  }
});

// ---------------------------------------------------------------------------
// These require the agent-authored modules; skip cleanly until they land.
// ---------------------------------------------------------------------------

const have = async (path) => { try { return await import(path); } catch { return null; } };

const resonators = await have('../src/resonators.js');
const layers = await have('../src/layers.js');
const physics = await have('../src/physics.js');
const shift = await have('../src/shift.js');

function sweepParams() {
  const out = [];
  for (const rpm of [700, 900, 1500, 3000, 5000, 7000, 9000]) {
    for (const load of [0, 0.35, 1]) {
      for (const phase of ['', 'cut', 'open', 'sync', 'engage', 'lash', 'shuffle']) {
        out.push({
          now: 0, dt: 1 / 60,
          rpm, f0: rpm / 120, rpmNorm: (rpm - 800) / 6200, dRpm: (load - 0.5) * 12000,
          throttle: load, load, overrun: load < 0.1 ? 1 : 0, torqueSign: load > 0.1 ? 1 : -1,
          gear: 3, gearRatio: 5.2, speed: 30, wheelRpm: rpm / 5.2, clutchSlip: phase === 'engage' ? 400 : 0,
          clutchEngaged: phase ? 0.4 : 1, boost: load,
          shifting: !!phase, shiftPhase: phase,
          evCut: phase === 'cut' ? 1 : 0, evLash: phase === 'lash' ? 0.8 : 0,
          evEngage: phase === 'engage' ? 0.6 : 0, evBov: 0, evShiftDone: 0,
        });
      }
    }
  }
  return out;
}

await suite('audio modules — construction and parameter sweep', () => {
  if (!resonators || !layers) {
    console.log('  \x1b[2m(skipped — resonators.js / layers.js not present yet)\x1b[0m');
    return;
  }
  for (const [id, profile] of Object.entries(ENGINE_PROFILES)) {
    const mock = createMockContext();
    installGlobals(mock.ctx);
    const built = [];
    const add = (Cls, ...args) => { if (Cls) built.push(new Cls(mock.ctx, profile, ...args)); };

    add(resonators.ExhaustSystem);
    add(resonators.IntakeResonator);
    add(resonators.CabinFilter);
    add(layers.MechanicalLayer);
    add(layers.TransmissionLayer, VEHICLE_PRESETS.sports);
    if (profile.turbo) add(layers.TurboLayer);
    add(layers.TransientBank);

    const afterBuild = mock.report().nodes;
    mock.seal();

    let t = 0;
    for (const p of sweepParams()) {
      t += 1 / 60; mock.advance(1 / 60); p.now = mock.ctx.currentTime;
      for (const m of built) m.update(p);
    }
    const rep = mock.report();
    ok(rep.violations === 0, `${id}: no violations across ${sweepParams().length} frames`,
       `${afterBuild} nodes, ${rep.paramWrites} param writes`);
    ok(rep.nodes === afterBuild, `${id}: no per-frame node allocation`,
       `${rep.nodes} vs ${afterBuild}`);
  }
});

await suite('audibility — every source started and connected to the output', async () => {
  // The check that was missing. A source node that is built, connected and
  // never started is completely silent, and NOTHING else in this harness
  // notices: its params still get written, the graph still looks right, the
  // node count is still stable. It cost an entire mechanical + gearbox layer.
  const { EngineSim } = await import('../src/engine-sim.js');
  for (const e of Object.keys(ENGINE_PROFILES)) {
    for (const v of ['sports', 'truck']) {
      const mk = createMockContext();
      installGlobals(mk.ctx);
      const sim = new EngineSim(mk.ctx, { engine: e, vehicle: v });
      await sim.start();
      for (let i = 0; i < 90; i++) {
        sim.setThrottle(i < 60 ? 1 : 0);
        mk.advance(1 / 60);
        sim.update(1 / 60);
      }
      const a = mk.audit(mk.ctx.destination);
      ok(a.unstarted.length === 0, `${e}/${v}: every source is started`,
         a.unstarted.length ? a.unstarted.join(',') : `${a.sources} sources`);
      ok(a.orphaned.length === 0, `${e}/${v}: every source reaches the output`,
         a.orphaned.length ? a.orphaned.join(',') : '');
    }
  }
});

await suite('physics — driveline', () => {
  if (!physics || !shift) {
    console.log('  \x1b[2m(skipped — physics.js / shift.js not present yet)\x1b[0m');
    return;
  }
  for (const [vid, vehicle] of Object.entries(VEHICLE_PRESETS)) {
    const profile = ENGINE_PROFILES.v8cross;
    const d = new physics.Drivetrain(profile, vehicle, {});
    let maxTwist = 0, lashEvents = 0, bad = 0, t = 0;
    for (let i = 0; i < 60 * 60; i++) {
      d.setThrottle(Math.random());
      d.setBrake(Math.random() < 0.1 ? 1 : 0);
      if (Math.random() < 0.01) d.shiftUp();
      if (Math.random() < 0.01) d.shiftDown();
      t += 1 / 60;
      const p = d.step(1 / 60, t);
      if (!isFinite(p.rpm) || !isFinite(p.speed) || p.rpm < 0) bad++;
      maxTwist = Math.max(maxTwist, Math.abs(d.twist ?? 0));
      if (p.evLash) lashEvents++;
    }
    ok(bad === 0, `${vid}: 3600 fuzz frames stay finite`);
    ok(maxTwist < 1, `${vid}: driveline twist bounded`, maxTwist.toFixed(4) + ' rad');
    ok(lashEvents > 0 && lashEvents < 1200, `${vid}: lash fires on events, not continuously`,
       lashEvents + ' impacts');
  }
});

await suite('dynamics — the three-band crossover sums flat', async () => {
  // A band-split compressor is only transparent if the bands add back up to the
  // signal that went in. Web Audio's lowpass/highpass Q is in DECIBELS, so
  // Butterworth is Q = -3.01 dB and not 0.7071 — a very easy thing to get wrong
  // and the failure mode is a fat resonant bump at every crossover rather than
  // anything that looks broken.
  const { Dynamics } = await import('../src/fx.js');
  const SR = 48000;

  /** Complex response of one Web Audio lowpass/highpass section. */
  const section = (type, f0, qDb) => {
    const w0 = 2 * Math.PI * f0 / SR, cw = Math.cos(w0), sw = Math.sin(w0);
    const al = sw / (2 * Math.pow(10, qDb / 20));
    const b0 = type === 'lowpass' ? (1 - cw) / 2 : (1 + cw) / 2;
    const b1 = type === 'lowpass' ? 1 - cw : -(1 + cw);
    const b2 = b0;
    const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
    return (f) => {
      const w = 2 * Math.PI * f / SR;
      const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
      const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
      const dd = dr * dr + di * di;
      return [(nr * dr + ni * di) / dd, (ni * dr - nr * di) / dd];
    };
  };
  const mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];

  const worstDeviation = (qDb) => {
    const [LOW, MID] = Dynamics.BANDS;
    const lp1 = section('lowpass', LOW.f, qDb), hp1 = section('highpass', LOW.f, qDb);
    const lp2 = section('lowpass', MID.f, qDb), hp2 = section('highpass', MID.f, qDb);
    let worst = 0, at = 0;
    for (let f = 25; f < 18000; f *= Math.pow(2, 1 / 48)) {
      const L = mul(lp1(f), lp1(f));
      const M = mul(mul(hp1(f), hp1(f)), mul(lp2(f), lp2(f)));
      const H = mul(hp2(f), hp2(f));
      const re = L[0] + M[0] + H[0], im = L[1] + M[1] + H[1];
      const dB = 20 * Math.log10(Math.hypot(re, im));
      if (Math.abs(dB) > Math.abs(worst)) { worst = dB; at = f; }
    }
    return { worst, at };
  };

  const good = worstDeviation(-3.0103);
  ok(Math.abs(good.worst) < 0.5, 'Linkwitz-Riley bands recombine flat',
     `${good.worst.toFixed(3)} dB at ${good.at.toFixed(0)} Hz`);
  // Control: the value someone would reach for if they read Q as linear.
  const bad = worstDeviation(0.7);
  ok(Math.abs(bad.worst) > 3, 'the test can fail — a linear Q of 0.7 bumps the crossover',
     `${bad.worst.toFixed(2)} dB at ${bad.at.toFixed(0)} Hz`);

  // And the stage is actually in the signal path with all three bands built.
  const mk = createMockContext();
  installGlobals(mk.ctx);
  const d = new Dynamics(mk.ctx, { amount: 1 });
  ok(d.bands.length === 3, 'three bands built', d.bands.map(b => b.spec.name).join('/'));
  ok(d.bands[2].spec.attack <= 0.005 && d.bands[2].spec.ratio >= 4,
     'the high band is a fast harshness tamer',
     `${d.bands[2].spec.attack * 1000} ms, ${d.bands[2].spec.ratio}:1`);
  d.setAmount(0);
  ok(d.bands.every(b => b.comp.threshold.value === 0), 'amount 0 parks every threshold');
  d.setAmount(1);
});

await suite('turbo — spool, whine sweep and compressor surge', async () => {
  const { EngineSim } = await import('../src/engine-sim.js');
  const TURBOS = Object.entries(ENGINE_PROFILES).filter(([, p]) => p.turbo).map(([id]) => id);
  ok(TURBOS.length >= 4, 'there are turbocharged profiles to test', TURBOS.join(','));

  /** Drive one engine through gear pulls with periodic lifts. */
  const run = (engine, { lift = true, shift = true } = {}) => {
    const mk = createMockContext();
    installGlobals(mk.ctx);
    const sim = new EngineSim(mk.ctx, { engine, vehicle: 'sports' });
    sim.start();
    const T = sim.turbo;
    const r = { peakSurge: 0, peakBody: 0, surgeFrames: 0, bov: 0,
                whineMin: Infinity, whineMax: 0, spoolMin: Infinity, spoolMax: 0 };
    for (let i = 0; i < 60 * 10; i++) {
      const closed = lift && (i % 180 >= 150);
      sim.setThrottle(closed ? 0 : 1);
      mk.advance(1 / 60);
      sim.update(1 / 60);
      if (sim._lastParams.evBov > 0) r.bov++;
      r.peakSurge = Math.max(r.peakSurge, T._surge);
      const body = T.surgeBodyLvl.gain.value;
      r.peakBody = Math.max(r.peakBody, body);
      if (body > 0.02) r.surgeFrames++;
      const w = T.whineOsc.frequency.value;
      if (w > r.whineMax) r.whineMax = w;
      if (w < r.whineMin) r.whineMin = w;
      r.spoolMin = Math.min(r.spoolMin, T.spool);
      r.spoolMax = Math.max(r.spoolMax, T.spool);
    }
    return r;
  };

  for (const id of TURBOS) {
    const r = run(id);
    // The whistle has to MOVE. A flat tone across the whole rev range is what
    // "sounds fake" means; a real turbo sweeps as the shaft spools and sags.
    const semitones = 12 * Math.log2(r.whineMax / Math.max(1, r.whineMin));
    ok(semitones > 18, `${id}: whine sweeps a musically useful range`,
       `${r.whineMin.toFixed(0)}-${r.whineMax.toFixed(0)} Hz = ${semitones.toFixed(1)} semitones`);
    // The fundamental must stay clear of the band where the ear peaks.
    ok(r.whineMax <= 3000, `${id}: whine fundamental stays out of 3-6 kHz`,
       `max ${r.whineMax.toFixed(0)} Hz`);
    ok(r.peakSurge > 0.15 && r.surgeFrames > 20,
       `${id}: compressor surges on lift-off`,
       `peak ${r.peakSurge.toFixed(2)}, active ${r.surgeFrames} frames`);
  }

  // A big atmospheric valve relieves the plenum, so there is much less left to
  // reverse through the wheel. boxer4 (bov 0.80) against i6 (bov 0.25).
  const big = run('boxer4'), small = run('i6');
  const dB = 20 * Math.log10(small.peakBody / Math.max(1e-6, big.peakBody));
  ok(dB > 5, 'a large blow-off valve suppresses the flutter',
     `i6 ${small.peakBody.toFixed(3)} vs boxer4 ${big.peakBody.toFixed(3)} = ${dB.toFixed(1)} dB`);
  ok(big.bov > 0 && small.bov > 0, 'the blow-off valve still fires on both',
     `${big.bov} / ${small.bov} events`);

  // Never on a closed throttle that was never boosted: an off-boost lift must
  // be silent, or every gentle coast would chatter.
  const mk = createMockContext();
  installGlobals(mk.ctx);
  const sim = new EngineSim(mk.ctx, { engine: 'i6', vehicle: 'sports' });
  sim.start();
  let idleSurge = 0;
  for (let i = 0; i < 60 * 6; i++) {
    sim.setThrottle(i % 120 < 60 ? 0.12 : 0);   // never enough to build boost
    mk.advance(1 / 60);
    sim.update(1 / 60);
    idleSurge = Math.max(idleSurge, sim.turbo.surgeBodyLvl.gain.value);
  }
  ok(idleSurge < 0.02, 'an off-boost lift does not flutter',
     `peak ${idleSurge.toFixed(4)}`);
});

await suite('harshness — no screaming resonance at any rpm', async () => {
  // The comb peaks of a feedback waveguide sit at multiples of 1/T and an
  // engine's harmonics at multiples of f0. Where those two series coincide, one
  // harmonic lands on a comb peak while its neighbours fall in the troughs —
  // and if the pipe is still ringing in its 20th mode, that is a 20 dB spike at
  // 2 kHz that appears at one rpm and vanishes at the next. The V12 at 8000 rpm
  // once put 71 % of all radiated power into 2-6 kHz this way.
  //
  // spectrum.mjs computes the chain's magnitude response analytically, so this
  // is a real measurement rather than a smoke test.
  const { harshness } = await import('./spectrum.mjs');
  const LIMIT = 0.04;          // 4 % of radiated power in 2-6 kHz
  for (const [id, p] of Object.entries(ENGINE_PROFILES)) {
    let worst = 0, wRpm = 0, wF = 0;
    for (let rpm = 1200; rpm <= p.redlineRpm; rpm += 400) {
      for (const load of [0.35, 0.7, 1.0]) {
        const h = harshness(p, rpm, load);
        if (h.share > worst) { worst = h.share; wRpm = rpm; wF = h.peakF; }
      }
    }
    ok(worst < LIMIT, `${id}: 2-6 kHz share stays under ${LIMIT * 100}%`,
       `${(worst * 100).toFixed(2)}% at ${wRpm} rpm (${wF.toFixed(0)} Hz)`);
  }
});

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m  ` +
            `${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
