/**
 * spectrum.mjs — analytic spectrum of the exhaust chain.
 *
 * Nothing in this environment can hear the audio, so "is it harsh?" has to be
 * answered numerically. This tool reconstructs the magnitude response of the
 * whole deterministic signal path ANALYTICALLY — every biquad with the exact
 * formulas the Web Audio spec mandates, every delay line as a closed-form
 * comb — and multiplies it by the wavetable's harmonic amplitudes at a given
 * rpm. The result is the spectrum that actually leaves the tailpipe.
 *
 *   bank wavetable  →  bank Waveguide  →  transit  →  collector Waveguide
 *                   →  Muffler  →  tone stage  →  CabinFilter(exterior)
 *
 * The Nonlinearity waveshaper is deliberately NOT modelled: it is nonlinear,
 * so it has no transfer function. It only ADDS high-order content, so every
 * harshness number here is a lower bound.
 *
 * Usage:
 *   node test/spectrum.mjs            # harshness table, all engines
 *   node test/spectrum.mjs v8flat     # per-rpm detail for one engine
 */

import { ENGINE_PROFILES, bankAngles, pipeDelay, pipeFrequency } from '../src/profiles.js';
import { buildCycle, toPressureGradient, cycleToCoefficients } from '../src/pulse.js';

const SR = 48000;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Biquad magnitude — exactly the formulas in the Web Audio spec
// ---------------------------------------------------------------------------

/**
 * @param {string} type lowpass|highpass|bandpass|peaking|lowshelf|highshelf
 * @returns {(f: number) => number} magnitude response
 */
function biquad(type, f0, Q, dbGain = 0, sr = SR) {
  const w0 = 2 * Math.PI * clamp(f0, 1, 0.499 * sr) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const A = Math.pow(10, dbGain / 40);
  // The spec uses Q in DECIBELS for lowpass/highpass and linear Q elsewhere.
  const aQdb = sw / (2 * Math.pow(10, Q / 20));
  const aQ = sw / (2 * Math.max(1e-4, Q));
  const aS = (sw / 2) * Math.SQRT2;            // shelves, S = 1

  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + aQdb; a1 = -2 * cw; a2 = 1 - aQdb; break;
    case 'highpass':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + aQdb; a1 = -2 * cw; a2 = 1 - aQdb; break;
    case 'bandpass':
      b0 = aQ; b1 = 0; b2 = -aQ;
      a0 = 1 + aQ; a1 = -2 * cw; a2 = 1 - aQ; break;
    case 'peaking':
      b0 = 1 + aQ * A; b1 = -2 * cw; b2 = 1 - aQ * A;
      a0 = 1 + aQ / A; a1 = -2 * cw; a2 = 1 - aQ / A; break;
    case 'lowshelf':
      b0 = A * ((A + 1) - (A - 1) * cw + 2 * aS * Math.sqrt(A));
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - 2 * aS * Math.sqrt(A));
      a0 = (A + 1) + (A - 1) * cw + 2 * aS * Math.sqrt(A);
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - 2 * aS * Math.sqrt(A); break;
    case 'highshelf':
      b0 = A * ((A + 1) + (A - 1) * cw + 2 * aS * Math.sqrt(A));
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - 2 * aS * Math.sqrt(A));
      a0 = (A + 1) - (A - 1) * cw + 2 * aS * Math.sqrt(A);
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - 2 * aS * Math.sqrt(A); break;
    default:
      return () => 1;
  }
  return (f) => {
    const w = 2 * Math.PI * f / sr;
    const c1 = Math.cos(w), s1 = Math.sin(w);
    const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
    const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    return Math.hypot(nr, ni) / Math.max(1e-12, Math.hypot(dr, di));
  };
}

// ---------------------------------------------------------------------------
// Waveguide — closed form of the feedback comb
// ---------------------------------------------------------------------------

/**
 * H(f) = dry + wet · Hlp·e^(-jωT) / (1 + r·Hlp·e^(-jωT))
 *
 * Complex, because the loop lowpass contributes phase as well as magnitude and
 * that phase is what sets where the comb peaks actually land.
 */
function waveguideMag(opts) {
  const { delayT, r, lpF, lpQ, dry, wet, loopPoles = 1 } = opts;
  // Complex response of the loop lowpass, from its difference equation.
  const w0 = 2 * Math.PI * clamp(lpF, 1, 0.499 * SR) / SR;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const al = sw / (2 * Math.pow(10, lpQ / 20));
  const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2;
  const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;

  return (f) => {
    const w = 2 * Math.PI * f / SR;
    const c1 = Math.cos(w), s1 = Math.sin(w);
    const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
    const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    const dd = dr * dr + di * di;
    // Hlp = (nr + j·ni) / (dr + j·di)
    let lr = (nr * dr + ni * di) / dd, li = (ni * dr - nr * di) / dd;
    // Cascaded identical lowpasses in the loop: Hlp^N.
    for (let n = 1; n < loopPoles; n++) {
      const tr = lr * ((nr * dr + ni * di) / dd) - li * ((ni * dr - nr * di) / dd);
      const ti = lr * ((ni * dr - nr * di) / dd) + li * ((nr * dr + ni * di) / dd);
      lr = tr; li = ti;
    }

    // e^(-jωT) at the analogue delay T
    const th = -2 * Math.PI * f * delayT;
    const er = Math.cos(th), ei = Math.sin(th);

    // z = Hlp · e^(-jωT)
    const zr = lr * er - li * ei, zi = lr * ei + li * er;

    // num = wet·z ; den = 1 + r·z   (r carries the sign of the reflection)
    const numR = wet * zr, numI = wet * zi;
    const denR = 1 + r * zr, denI = r * zi;
    const q = denR * denR + denI * denI;
    const outR = dry + (numR * denR + numI * denI) / q;
    const outI = (numI * denR - numR * denI) / q;
    return Math.hypot(outR, outI);
  };
}

/** Feedforward comb chain: prod|1 + g_i·e^(-jωT_i)| × packing × trim. */
function mufflerMag(stages, packF, trim) {
  const pack = biquad('lowpass', packF, 0.6);
  return (f) => {
    let m = 1;
    for (const s of stages) {
      const th = -2 * Math.PI * f * s.T;
      m *= Math.hypot(1 + s.g * Math.cos(th), s.g * Math.sin(th));
    }
    return m * pack(f) * trim;
  };
}

// ---------------------------------------------------------------------------
// Rebuild each stage's runtime parameters from the profile
// ---------------------------------------------------------------------------

const MAX_FEEDBACK = 0.92;

/** Mirror of Waveguide's constructor + update(), for one load value. */
function wgParams(profile, length, load, rpmNorm,
                  { reflMul = 1, dampMul = 1, modes = 2.2, loopPoles = 1 } = {}) {
  const ex = profile.exhaust;
  const g = profile.gasTempFactor;
  const reflection = clamp(ex.reflection * reflMul, 0, MAX_FEEDBACK);
  const damping = clamp(ex.damping * dampMul, 0.05, 2);
  const freq = pipeFrequency(length, g);
  const lpBase = clamp(freq * (modes / damping), 150, 12000);
  const heat = clamp(0.6 * load + 0.4 * rpmNorm, 0, 1);
  const scale = 1 + 0.05 * (heat - 0.35);
  return {
    delayT: pipeDelay(length, g) / scale,
    // NEGATIVE reflection: an open pipe end inverts pressure.
    r: -clamp(reflection * (0.92 + 0.08 * load), 0, MAX_FEEDBACK),
    lpF: lpBase * scale * (1 + 0.35 * load),
    lpQ: 0.5, dry: 0.30, wet: 0.90, loopPoles,
    freq, lpBase,
  };
}

/** Mirror of Muffler's constructor + update(). */
function mufParams(profile, load, rpmNorm) {
  const ex = profile.exhaust;
  const g = profile.gasTempFactor;
  const chambers = ex.muffler.map(L => clamp(L, 0.02, 3));
  // The decorrelation search is deterministic; replicate it rather than guess.
  const base = chambers.map(L => pipeDelay(L, g));
  const delays = decorrelate(base, 0.06);
  const branchGain = clamp(0.55 + 0.30 * clamp(ex.reflection, 0, 1), 0.05, 0.9);
  const heat = clamp(0.6 * load + 0.4 * rpmNorm, 0, 1);
  const scale = 1 + 0.025 * (heat - 0.35);
  const stages = delays.map((T, i) => ({
    T: T / scale,
    g: clamp(branchGain * Math.pow(0.92, i) * (1 - 0.12 * load), 0, 0.95),
  }));
  let peakProd = 1;
  for (let i = 0; i < stages.length; i++) peakProd *= (1 + branchGain * Math.pow(0.92, i));
  const packingBase = clamp(pipeFrequency(Math.max(...chambers), g) * 7, 500, 11000);
  return {
    stages,
    packF: clamp(packingBase * (1 + 0.30 * load) * scale, 10, 20000),
    trim: 1 / Math.max(1, peakProd * 0.72),
  };
}

function peakCoincidence(delays, kMax = 6, tolHz = 45) {
  let cost = 0;
  for (let i = 0; i < delays.length; i++) {
    for (let j = i + 1; j < delays.length; j++) {
      for (let a = 1; a <= kMax; a++) {
        for (let b = 1; b <= kMax; b++) {
          const fa = a / delays[i], fb = b / delays[j];
          if (fa > 8000 || fb > 8000) continue;
          const d = (fa - fb) / tolHz;
          cost += Math.exp(-d * d) / (a * b);
        }
      }
    }
  }
  return cost;
}

function decorrelate(delays, spread) {
  const out = delays.slice();
  const STEPS = 41;
  for (let i = 1; i < out.length; i++) {
    let best = out[i], bestCost = Infinity;
    for (let s = 0; s < STEPS; s++) {
      const k = 1 + spread * ((2 * s) / (STEPS - 1) - 1);
      const trial = out.slice(0, i + 1);
      trial[i] = delays[i] * k;
      const c = peakCoincidence(trial);
      if (c < bestCost - 1e-12) { bestCost = c; best = delays[i] * k; }
    }
    out[i] = best;
  }
  return out;
}

/** The fixed-frequency tone stage in engine-sim.js, plus exterior cabin. */
function toneStage() {
  const fs = [
    biquad('lowshelf', 145, 0.7, 9),
    biquad('peaking', 78, 1.0, 5.5),
    biquad('peaking', 3000, 0.85, -4.5),
    biquad('highshelf', 2900, 0.7, -6),
    biquad('lowpass', 17000, 0.6),        // CabinFilter, exterior
  ];
  return (f) => fs.reduce((m, h) => m * h(f), 1);
}

// ---------------------------------------------------------------------------
// Full chain
// ---------------------------------------------------------------------------

/**
 * Magnitude response from bank i's oscillator to the mix bus.
 * `tune` lets an experiment override the constants without editing src/.
 */
export function chainMag(profile, bankIndex, load, rpmNorm, tune = {}) {
  const ex = profile.exhaust;
  const nBanks = profile.banks.length;
  const len = (bankIndex === 1 && Number.isFinite(ex.bankB)) ? ex.bankB : ex.bank;
  const modes = tune.modes ?? 2.2;
  const loopPoles = tune.loopPoles ?? 1;

  const bank = waveguideMag(wgParams(profile, len, load, rpmNorm, { modes, loopPoles }));
  const coll = waveguideMag(wgParams(profile, ex.collector, load, rpmNorm,
    { reflMul: 0.88, dampMul: 1.12, modes, loopPoles }));
  const muf = mufflerMag(...(() => {
    const m = mufParams(profile, load, rpmNorm);
    return [m.stages, m.packF, m.trim];
  })());
  const tone = toneStage();
  const sum = 1 / Math.sqrt(nBanks);
  // Tailpipe radiation: an open pipe of radius a stops behaving as an ideal
  // radiator above ka ≈ 1, i.e. f = c/(2πa). Optional so experiments can
  // measure the difference it makes.
  const tail = tune.tailHz ? biquad('lowpass', tune.tailHz, tune.tailQ ?? 0.6) : null;
  // The transit delay is a pure phase term; it does not change |H| of one bank.
  return (f) => bank(f) * sum * coll(f) * muf(f) * tone(f) * (tail ? tail(f) : 1);
}

/** Harmonic amplitudes of one bank's wavetable, index k = engine order k/2. */
function bankHarmonics(profile, bankIndex, hard) {
  const angles = bankAngles(profile, bankIndex);
  const c = cycleToCoefficients(toPressureGradient(buildCycle(profile, angles, hard)));
  let power = 0;
  for (let k = 1; k < c.real.length; k++) power += 0.5 * (c.real[k] ** 2 + c.imag[k] ** 2);
  const g = 0.25 / (Math.sqrt(power) || 1);          // normalise(), targetRms 0.25
  const out = new Float64Array(c.real.length);
  for (let k = 1; k < c.real.length; k++) out[k] = Math.hypot(c.real[k], c.imag[k]) * g;
  return out;
}

/**
 * Radiated spectrum at one operating point.
 * @returns {{bins: Map<number,number>, total: number}} power per frequency
 */
export function spectrumAt(profile, rpm, load) {
  const f0 = rpm / 120;
  const rpmNorm = clamp((rpm - profile.idleRpm) / (profile.redlineRpm - profile.idleRpm), 0, 1);
  const bins = [];
  let total = 0;
  for (let b = 0; b < profile.banks.length; b++) {
    const h = bankHarmonics(profile, b, load);
    const H = chainMag(profile, b, load, rpmNorm);
    for (let k = 1; k < h.length; k++) {
      const f = k * f0;
      if (f > 20000) break;
      const a = h[k] * H(f);
      const p = a * a;
      if (p > 0) { bins.push({ f, p, order: k / 2 }); total += p; }
    }
  }
  return { bins, total };
}

/**
 * Harshness: the fraction of radiated power landing in 2–6 kHz, the band where
 * human hearing is most sensitive and where "piercing" lives. A real exhaust
 * measured at the tailpipe puts well under 2 % of its power up there.
 */
export function harshness(profile, rpm, load) {
  const { bins, total } = spectrumAt(profile, rpm, load);
  if (!total) return { share: 0, peakF: 0, peakDb: -120, centroid: 0 };
  let harsh = 0, peakP = 0, peakF = 0, cent = 0, maxP = 0;
  for (const b of bins) {
    if (b.f >= 2000 && b.f <= 6000) { harsh += b.p; if (b.p > peakP) { peakP = b.p; peakF = b.f; } }
    if (b.p > maxP) maxP = b.p;
    cent += b.f * b.p;
  }
  return {
    share: harsh / total,
    peakF,
    // Level of the worst 2–6 kHz harmonic relative to the loudest harmonic.
    peakDb: peakP > 0 ? 10 * Math.log10(peakP / maxP) : -120,
    centroid: cent / total,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const RPMS = [1200, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000];
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

// Importable as a library: only print when run directly.
const isMain = process.argv[1] && process.argv[1].endsWith('spectrum.mjs');
const only = isMain ? process.argv[2] : '__none__';

if (!isMain) {
  // no report
} else if (only && ENGINE_PROFILES[only]) {
  const p = ENGINE_PROFILES[only];
  console.log(`\n${p.label}  —  bank ${p.exhaust.bank} m, collector ${p.exhaust.collector} m`);
  console.log(`  bank pipe ${pipeFrequency(p.exhaust.bank, p.gasTempFactor).toFixed(0)} Hz,`
    + ` loop LP base ${(pipeFrequency(p.exhaust.bank, p.gasTempFactor) * (6 / p.exhaust.damping)).toFixed(0)} Hz`);
  console.log('\n  rpm    load   2-6kHz%   worst-f   rel-dB   centroid');
  for (const rpm of RPMS) {
    if (rpm > p.redlineRpm) break;
    for (const load of [0.35, 1.0]) {
      const h = harshness(p, rpm, load);
      console.log('  ' + padL(rpm, 5) + padL(load.toFixed(2), 7)
        + padL((h.share * 100).toFixed(2), 9) + padL(h.peakF.toFixed(0), 10)
        + padL(h.peakDb.toFixed(1), 9) + padL(h.centroid.toFixed(0), 11));
    }
  }
  console.log('');
} else {
  console.log('\nHarshness — share of radiated power in 2-6 kHz (lower is better)\n');
  console.log('  ' + pad('engine', 10) + padL('worst%', 8) + padL('@rpm', 7)
    + padL('load', 6) + padL('worst-f', 9) + padL('rel-dB', 8) + padL('mean%', 8));
  const rows = [];
  for (const [id, p] of Object.entries(ENGINE_PROFILES)) {
    let worst = { share: -1 }, wRpm = 0, wLoad = 0, sum = 0, n = 0;
    for (const rpm of RPMS) {
      if (rpm > p.redlineRpm) continue;
      for (const load of [0.35, 0.7, 1.0]) {
        const h = harshness(p, rpm, load);
        sum += h.share; n++;
        if (h.share > worst.share) { worst = h; wRpm = rpm; wLoad = load; }
      }
    }
    rows.push({ id, worst, wRpm, wLoad, mean: sum / n });
  }
  rows.sort((a, b) => b.worst.share - a.worst.share);
  for (const r of rows) {
    const flag = r.worst.share > 0.05 ? '  <-- harsh' : '';
    console.log('  ' + pad(r.id, 10) + padL((r.worst.share * 100).toFixed(2), 8)
      + padL(r.wRpm, 7) + padL(r.wLoad.toFixed(2), 6)
      + padL(r.worst.peakF.toFixed(0), 9) + padL(r.worst.peakDb.toFixed(1), 8)
      + padL((r.mean * 100).toFixed(2), 8) + flag);
  }
  console.log('');
}
