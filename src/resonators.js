/**
 * resonators.js — the acoustic path from combustion pulse to radiated sound.
 *
 * pulse.js gives us the pressure gradient leaving the exhaust *port*. Nothing
 * about that signal knows it is going to travel down 1.6 m of steel tube, bounce
 * off an open end, pass through three expansion chambers and then be heard from
 * outside a car. This file is that journey.
 *
 * ---------------------------------------------------------------------------
 * THE PHYSICS, AND WHY EACH STRUCTURE IS THE ONE IT IS
 * ---------------------------------------------------------------------------
 *
 * A header pipe is closed at the engine end (the exhaust valve is shut for most
 * of the cycle) and open at the other. That is a quarter-wave resonator: modes
 * at c/4L, 3c/4L, 5c/4L ... — odd multiples only. In a digital waveguide the
 * round trip is `pipeDelay()` = 2L/c seconds, and you get odd-only modes when
 * the loop gain is NEGATIVE. That sign is not a trick: the pressure reflection
 * coefficient at an open pipe end really is negative (a compression wave
 * reflects as a rarefaction). So `feedback.gain = -reflection`, and the poles
 * land at 1/(2T) = c/(4L) = exactly `pipeFrequency()`. The two helpers in
 * profiles.js are consistent with each other and with this loop by construction.
 *
 * The lowpass inside the loop is viscothermal boundary-layer loss at the pipe
 * wall, which grows with frequency (α ∝ √f). One pole is the standard waveguide
 * approximation. Its cutoff is set from the profile's `damping` as
 * `pipeFrequency * 6 / damping`, i.e. "how many modes survive before the wall
 * eats them" — a long, heavily damped turbo-triple pipe reaches ~1.1 kHz, a
 * short thin-wall flat-plane V8 pipe reaches ~4.2 kHz.
 *
 * ---------------------------------------------------------------------------
 * THE WEB AUDIO RENDER-QUANTUM FLOOR  (read this before changing any length)
 * ---------------------------------------------------------------------------
 *
 * Any cycle in the Web Audio graph must contain a DelayNode, and inside a cycle
 * that DelayNode's effective delay is silently raised to one render quantum:
 * 128 samples = 2.667 ms @ 48 kHz, 2.902 ms @ 44.1 kHz. So a feedback waveguide
 * cannot resonate above 1/(2 · 128/sr) = 187.5 Hz @ 48 kHz... no: above
 * 1/(2T_min) where T_min = 128/sr, i.e. 187.5 Hz @48k / 172 Hz @44.1k for the
 * quarter-wave mode. Longer pipes are fine; short ones are not.
 *
 * Measured against profiles.js (delay = 2L/(343·gasTempFactor), and allowing for
 * the thermal modulation below, which SHORTENS the delay by up to 3.15 %):
 *
 *   ALL bank/header pipes (0.78 m … 1.75 m → 3.31 ms … 8.10 ms) clear the floor
 *   at both 44.1 and 48 kHz. Every engine gets a true delay-line header.
 *
 *   Collectors mostly clear it, with two exceptions:
 *     v8flat collector 0.62 m → 2.718 ms, ×0.9685 = 2.632 ms  → BELOW at 48 kHz
 *                                                             → BELOW at 44.1 kHz
 *     v10    collector 0.66 m → 2.915 ms, ×0.9685 = 2.823 ms  → ok at 48 kHz
 *                                                             → BELOW at 44.1 kHz
 *   Those fall back to the parallel-bandpass mode described below.
 *
 *   EVERY muffler chamber (0.08 m … 0.40 m → 0.35 ms … 1.85 ms) is far below the
 *   floor — by a factor of 1.4 to 7.6. Not one of them can be a feedback loop.
 *   That is why Muffler is built from FEEDFORWARD combs: a delay that is not
 *   inside a cycle has no minimum, so the true chamber delays are usable, and a
 *   feedforward comb is anyway the better model of an expansion chamber (it is
 *   a notch-maker, and destructive interference is the entire point of a
 *   muffler — see Muffler for the notch/peak placement).
 *
 * CROSSOVER RULE (Waveguide): if the SHORTEST delay the thermal modulation can
 * ask for is below 128/sampleRate × 1.02 (2 % headroom), the pipe is built as
 * `mode: 'bandpass'` — a parallel bank of resonant bandpasses at the same
 * quarter-wave frequency and its odd harmonics, with Q derived from the same
 * loop gain, so the two modes sound like the same pipe. Otherwise `mode:'delay'`.
 * `wg.mode` is public so callers and tests can see which they got.
 *
 * ---------------------------------------------------------------------------
 * Exports: Waveguide, Muffler, IntakeResonator, Nonlinearity, CabinFilter,
 *          ExhaustSystem
 * All follow the CONTRACT.md module shape. Every node is built in the
 * constructor; update() only writes AudioParams.
 */

import { pipeDelay, pipeFrequency } from './profiles.js';

// ---------------------------------------------------------------------------
// Constants and guards
// ---------------------------------------------------------------------------

/** Web Audio render quantum, samples. Fixed by the spec. */
const RENDER_QUANTUM = 128;
/** Safety factor on the loop-delay floor — 2 % so rounding never trips it. */
const QUANTUM_HEADROOM = 1.02;

const F_MIN = 10;
const F_MAX = 20000;

/** Hard ceiling on any feedback gain magnitude. > 1 would blow the loop up. */
const MAX_FEEDBACK = 0.92;

/** Default AudioParam smoothing time constant (CONTRACT.md says ~0.02). */
const TC = 0.02;
/** Slower constant for delay-line length: a jumpy delay line artifacts badly. */
const TC_DELAY = 0.09;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Finite-or-fallback. Everything that reaches an AudioParam goes through this. */
function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Guarded setTargetAtTime. Never writes a non-finite value or a bad time. */
function setT(param, value, now, tc = TC) {
  const v = num(value, 0);
  const t = num(now, 0);
  param.setTargetAtTime(v, t < 0 ? 0 : t, tc > 0 ? tc : TC);
}

/**
 * Phase response (radians) of a Web Audio `lowpass` BiquadFilterNode at f.
 * Uses the exact RBJ cookbook coefficients the spec mandates, so this agrees
 * with what the browser actually renders.
 *
 * Needed because the lowpass sitting inside the waveguide feedback loop is not
 * phase-free: it delays the returning wave, which makes the loop's effective
 * round trip LONGER than the DelayNode alone and drops the resonance below
 * c/4L. Measured, uncompensated, that error is 2.7 %–6.1 % across the profiles
 * in profiles.js — up to a semitone flat, and (worse) it differs between the
 * delay-line and bandpass paths, so the same engine would change pitch when it
 * crossed the render-quantum floor on a 44.1 kHz device. See `_tunedDelay`.
 */
function lowpassPhase(f, fc, Q, sr) {
  const w = 2 * Math.PI * clamp(fc, 1, 0.49 * sr) / sr;
  const cw = Math.cos(w), sw = Math.sin(w);
  const al = sw / (2 * Math.max(1e-4, Q));
  const a0 = 1 + al;
  const b0 = ((1 - cw) / 2) / a0, b1 = (1 - cw) / a0, b2 = b0;
  const a1 = (-2 * cw) / a0, a2 = (1 - al) / a0;
  const t = 2 * Math.PI * clamp(f, 0.01, 0.49 * sr) / sr;
  const c1 = Math.cos(t), s1 = Math.sin(t);
  const c2 = Math.cos(2 * t), s2 = Math.sin(2 * t);
  // H(e^jt) = (b0 + b1 e^-jt + b2 e^-2jt) / (1 + a1 e^-jt + a2 e^-2jt)
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  const ph = Math.atan2(ni, nr) - Math.atan2(di, dr);
  return Number.isFinite(ph) ? ph : 0;
}

/**
 * Delay-line length, seconds, that puts a quarter-wave waveguide resonance
 * exactly at `f` given the in-loop lowpass.
 *
 * Loop gain is L(z) = −r · LP(z) · z^(−D). A pole needs ∠L = 0 (mod 2π):
 *     π + φ_LP(ω) − ωD = 0   →   D = (π + φ_LP(ω)) / ω
 * With φ_LP = 0 this reduces to D = 1/(2f), the textbook quarter-wave, so the
 * correction is a strict refinement of `pipeDelay()` rather than a fudge.
 */
function tunedLoopDelay(f, fc, Q, sr) {
  const w = 2 * Math.PI * f;
  if (!(w > 0)) return 0;
  const phi = lowpassPhase(f, fc, Q, sr);
  const d = (Math.PI + phi) / w;
  return d > 0 && Number.isFinite(d) ? d : 1 / (2 * f);
}

// ---------------------------------------------------------------------------
// Shared, built-once waveshaper curves
// ---------------------------------------------------------------------------

const CURVE_CACHE = new Map();

/**
 * Asymmetric saturation curve. A real exhaust pulse at high SPL steepens into a
 * shock front: the compression half travels faster than the rarefaction half
 * (c depends on local temperature and particle velocity), so the wave becomes
 * sawtooth-like and gains a lot of high harmonics. A memoryless shaper cannot
 * reproduce propagation, but ASYMMETRIC saturation is the right first-order
 * stand-in: it produces even harmonics (2nd order = the "growl") as well as odd
 * (rasp), which symmetric tanh does not.
 *
 * kp > kn means the compression (positive) half saturates harder than the
 * rarefaction half, matching the direction the real steepening goes.
 */
function shockCurve(kp, kn, n = 4096, head = shockHead()) {
  const key = kp + ':' + kn + ':' + n + ':' + head;
  const hit = CURVE_CACHE.get(key);
  if (hit) return hit;

  // The curve now spans ±head of INPUT, not ±1. A WaveShaper clamps anything
  // outside [-1, 1] to the curve's end value, and the offline render measured
  // the shaper being fed 1.2-3x full scale on an ordinary full-load pull and
  // up to 16x when a pop went through the pipe: every one of those was a
  // FLAT-TOPPED waveform, i.e. hard digital clipping in the middle of the
  // exhaust. That is the "oversaturated / overblown" sound, and it got worse
  // with revs because the drive rises with rpm.
  //
  // The shape is a SOFT knee with an asymptote rather than a normalised tanh:
  // unity slope at the origin (so the shaper never adds level at idle), and
  // each half compresses smoothly toward its own ceiling. kp/kn still set the
  // asymmetry: the compression half reaches its ceiling sooner than the
  // rarefaction half, which is where the even harmonics come from.
  const cp = 1 / Math.max(0.2, kp / 3.2) * 1.05;   // positive ceiling
  const cn = 1 / Math.max(0.2, kn / 3.2) * 0.85;   // negative ceiling
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = head * ((i / (n - 1)) * 2 - 1);
    c[i] = x >= 0 ? cp * Math.tanh(x / cp) : cn * Math.tanh(x / cn);
  }
  CURVE_CACHE.set(key, c);
  return c;
}

/** Input range the shock curve covers before the shaper's own hard clamp. */
const shockHead = () => 6;

// ---------------------------------------------------------------------------
// Waveguide — one pipe
// ---------------------------------------------------------------------------

/**
 * A digital waveguide model of one exhaust pipe (header, downpipe, collector).
 *
 * mode 'delay':                    mode 'bandpass' (short pipes):
 *   in ─┬─────────────► dry ─┐       in ─┬──────────────► dry ─┐
 *       └─►(+)─►[T]─►[LP]─┬──┴► out      ├─►[BP f ]─►g0 ─┤     ├► out
 *            ▲            │              ├─►[BP 3f]─►g1 ─┤     │
 *            └──[× −r]────┘              └─►[BP 5f]─►g2 ─┴─────┘
 *
 * opts:
 *   length         m, pipe length                 (default profile.exhaust.bank)
 *   gasTempFactor  overrides profile.gasTempFactor
 *   reflection     0..1 open-end reflection magnitude (default exhaust.reflection)
 *   damping        wall-loss factor                (default exhaust.damping)
 *   thermalSpan    0..0.25 total fractional swing of the gas sound speed with
 *                  load+rpm. Default 0.05 (±~2.5 %): gentle on purpose, because
 *                  a delay line whose length is being swept is a pitch-shifter
 *                  and a fast sweep chirps audibly. TASTE-ADJUSTABLE.
 *   wet, dry       output mix (default 0.90 / 0.30)
 *   maxModes       bandpass fallback mode count (default 3)
 */
export class Waveguide {
  constructor(ctx, profile, opts = {}) {
    this.ctx = ctx;
    this.profile = profile;
    this.disposed = false;

    const ex = (profile && profile.exhaust) || {};
    this.length = clamp(num(opts.length, num(ex.bank, 1.0)), 0.05, 12);
    this.gasTemp = clamp(num(opts.gasTempFactor, num(profile && profile.gasTempFactor, 1)), 0.5, 2.5);
    this.reflection = clamp(num(opts.reflection, num(ex.reflection, 0.5)), 0, MAX_FEEDBACK);
    this.damping = clamp(num(opts.damping, num(ex.damping, 0.4)), 0.05, 2);
    this.thermalSpan = clamp(num(opts.thermalSpan, 0.05), 0, 0.25);
    // Bias: at what "heat" (0..1) the profile's own gasTempFactor is exact.
    // 0.35 ≈ light cruise, which is what a published pipe-tuning figure means.
    this.thermalBias = 0.35;

    this.sampleRate = num(ctx && ctx.sampleRate, 48000);
    this.minLoopDelay = RENDER_QUANTUM / this.sampleRate;

    /** Raw physical round-trip delay at nominal gas temperature, seconds. */
    this.nominalDelay = pipeDelay(this.length, this.gasTemp);
    /** Quarter-wave resonance at nominal gas temperature, Hz. */
    this.frequency = pipeFrequency(this.length, this.gasTemp);

    // Loop lowpass cutoff: "how many modes the wall lets survive".
    //
    // MODE_SURVIVAL was 6, which let a pipe ring in its 20th mode and above.
    // That is not what a real exhaust does, and it caused the worst tonal bug
    // in the project: the comb peaks of a feedback waveguide sit at multiples
    // of 1/T, and an engine's harmonics sit at multiples of f0, so whenever an
    // rpm makes those two series COINCIDE, one harmonic lands exactly on a
    // high-order comb peak while its neighbours fall in the troughs. Measured
    // on the V12 at 8000 rpm: the chain's response at 2000 Hz was -5.9 dB while
    // 1867 Hz and 2133 Hz either side were -23.6 and -26.9 dB. A 21 dB spike,
    // 20 semitones above the engine note, appearing only at one rpm — the
    // "screaming resonance". 71 % of all radiated power was landing in 2-6 kHz.
    //
    // The fix is physical, not cosmetic. Thermoviscous wall losses in a duct
    // rise with sqrt(f) and the plane-wave model stops holding at all above the
    // first cross-mode cutoff, so a real exhaust resolves a handful of modes
    // and then smears into a smooth rolloff. 2.2 gives 5-8 modes across these
    // profiles, which is the right order of magnitude.
    //
    // Measured over all 11 engines × 9 rpm × 3 loads (test/spectrum.mjs):
    //   6.0 → worst 71.04 % of power in 2-6 kHz, mean 1.42 %, centroid 278 Hz
    //   3.0 → worst 35.44 %,                     mean 0.31 %, centroid 213 Hz
    //   2.2 → worst  1.38 %,                     mean 0.04 %, centroid 199 Hz
    // i.e. a 17 dB cut in the worst case for 79 Hz of centroid — the engines
    // stay bright enough to keep their character and stop screaming.
    //
    // 2.2 → 1.8 (with the collector change in ExhaustSystem). A 25-rpm sweep
    // (spectrum.mjs `spikes`) found what the 1000-rpm grid never could: the
    // header and collector combs in SERIES make narrow coincident peaks, and an
    // engine harmonic crossing one jumped 20-26 dB above its own level a few
    // hundred rpm either side — up to -9 dB of the loudest harmonic in the
    // whole spectrum, at 750-1800 Hz. Mean spike 20.2 → 9.4 dB, and the worst
    // remaining ones sit 25-30 dB under the engine note.
    const MODE_SURVIVAL = 1.8;
    this.lpBase = clamp(this.frequency * (MODE_SURVIVAL / this.damping), 150, 12000);
    this.loopQ = 0.5;   // no resonance of its own; pure loss curve

    const nyq = 0.49 * this.sampleRate;
    this.fMax = Math.min(F_MAX, nyq);

    // Delay-line length actually written, with the loop lowpass's phase lag
    // taken out so the resonance lands ON pipeFrequency() rather than 3–6 % flat.
    this.tunedDelay = this._tunedDelay(this.frequency, this.lpBase);
    /** How much shorter the tuned line is than the raw round trip. */
    this.phaseCompensation = this.tunedDelay / this.nominalDelay;

    // Thermal modulation shortens the delay by at most this factor.
    this.maxHeatScale = 1 + this.thermalSpan * (1 - this.thermalBias);
    /** Shortest delay this pipe will ever ask for — what the floor test uses. */
    this.shortestDelay = this._tunedDelay(
      this.frequency * this.maxHeatScale, this.lpBase * this.maxHeatScale * 1.35);

    /** 'delay' = true feedback waveguide, 'bandpass' = short-pipe fallback. */
    this.mode = this.shortestDelay >= this.minLoopDelay * QUANTUM_HEADROOM
      ? 'delay' : 'bandpass';

    // ---- nodes (all built here, never in update) ----
    this.inGain = ctx.createGain();
    this.inGain.gain.value = 1;

    this.out = ctx.createGain();
    this.out.gain.value = 1;

    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = clamp(num(opts.dry, 0.30), 0, 4);
    this.inGain.connect(this.dryGain);
    this.dryGain.connect(this.out);

    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = clamp(num(opts.wet, 0.90), 0, 4);
    this.wetGain.connect(this.out);

    if (this.mode === 'delay') {
      // Max delay must cover the coldest (longest) delay the modulation asks for.
      const maxT = Math.max(0.01, this.nominalDelay / (1 - this.thermalSpan) * 1.25);
      this.maxDelayTime = maxT;

      this.sum = ctx.createGain();
      this.sum.gain.value = 1;

      this.delay = ctx.createDelay(maxT);
      this.delay.delayTime.value = clamp(this.tunedDelay, this.minLoopDelay, maxT);

      this.loopLP = ctx.createBiquadFilter();
      this.loopLP.type = 'lowpass';
      this.loopLP.frequency.value = this._f(this.lpBase);
      this.loopLP.Q.value = this.loopQ;

      this.fb = ctx.createGain();
      // NEGATIVE: open-end pressure reflection inverts. This is what makes the
      // pipe a quarter-wave (odd-mode) resonator instead of a half-wave one.
      this.fb.gain.value = -this._fbMag(0);

      this.inGain.connect(this.sum);
      this.sum.connect(this.delay);
      this.delay.connect(this.loopLP);
      this.loopLP.connect(this.fb);
      this.fb.connect(this.sum);          // the cycle — contains a DelayNode ✓
      this.loopLP.connect(this.wetGain);  // tap the resonant return, not the sum
    } else {
      // ---- short-pipe fallback ----
      // Q of one comb resonance with round-trip gain a is π / (2(1−a)); using
      // the same a keeps the ring time of the fallback equal to the ring time
      // the delay loop would have had.
      const a = this._fbMag(0);
      this.fallbackQ = clamp(Math.PI / (2 * Math.max(0.02, 1 - a)), 0.7, 24);

      const nModes = clamp(Math.round(num(opts.maxModes, 3)), 1, 6);
      this.modes = [];
      let wSum = 0;
      const w = [];
      for (let k = 0; k < nModes; k++) {
        const f = this.frequency * (2 * k + 1);
        if (f > this.fMax * 0.95) break;
        // Quarter-wave standing-wave modal amplitude ~1/(2k+1), softened to
        // ^0.7 because the pressure-gradient source is HF-tilted, times the
        // one-pole wall loss the delay loop's lowpass would have applied.
        const wall = 1 / Math.sqrt(1 + (f / this.lpBase) * (f / this.lpBase));
        const wk = Math.pow(1 / (2 * k + 1), 0.7) * wall;
        w.push(wk); wSum += wk;
      }
      if (!w.length) { w.push(1); wSum = 1; }
      // Level-match to the delay loop's resonant peak gain 1/(1−a). The 0.6 is
      // an empirical level match between a summed biquad bank and a comb peak,
      // not a physical claim.
      const peak = 0.6 / Math.max(0.08, 1 - a);
      for (let k = 0; k < w.length; k++) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = this._f(this.frequency * (2 * k + 1));
        bp.Q.value = this.fallbackQ;
        const g = ctx.createGain();
        g.gain.value = (w[k] / wSum) * peak;
        this.inGain.connect(bp);
        bp.connect(g);
        g.connect(this.wetGain);
        this.modes.push({ bp, g, order: 2 * k + 1 });
      }
    }

    this._nodeCount = this._countNodes();
  }

  get input() { return this.inGain; }
  get output() { return this.out; }

  _f(f) { return clamp(num(f, F_MIN), F_MIN, this.fMax); }

  /**
   * Delay-line length that puts this pipe's resonance exactly at `f`, given the
   * phase lag of the lowpass sitting in the feedback loop. Thin wrapper so the
   * loop Q and sample rate come from the instance.
   */
  _tunedDelay(f, fc) {
    return tunedLoopDelay(
      clamp(num(f, F_MIN), F_MIN, this.fMax),
      clamp(num(fc, 150), 20, 0.49 * this.sampleRate),
      this.loopQ, this.sampleRate);
  }

  /**
   * Loop gain magnitude. Rises a little with load: at high gas velocity the
   * open end radiates a slightly smaller fraction of the incident energy
   * (radiation impedance falls relative to the pipe impedance), so more comes
   * back. Small effect, kept small. Always < MAX_FEEDBACK.
   */
  _fbMag(load) {
    return clamp(this.reflection * (0.92 + 0.08 * clamp(load, 0, 1)), 0, MAX_FEEDBACK);
  }

  /**
   * Thermal scale factor on the speed of sound. c ∝ √T, and exhaust gas goes
   * from a few hundred °C on the overrun to ~900 °C at full load, so the true
   * swing is larger than this — but a wide, fast delay-line sweep chirps. See
   * `thermalSpan`.
   */
  _heatScale(p) {
    const load = clamp(num(p && p.load, 0), 0, 1);
    const rpmNorm = clamp(num(p && p.rpmNorm, 0), 0, 1);
    const heat = clamp(0.6 * load + 0.4 * rpmNorm, 0, 1);
    return 1 + this.thermalSpan * (heat - this.thermalBias);
  }

  update(p) {
    if (this.disposed) return;
    const now = num(p && p.now, num(this.ctx.currentTime, 0));
    const load = clamp(num(p && p.load, 0), 0, 1);
    const scale = this._heatScale(p);

    if (this.mode === 'delay') {
      const t = clamp(this.nominalDelay / scale, this.minLoopDelay, this.maxDelayTime);
      setT(this.delay.delayTime, t, now, TC_DELAY);
      // Hotter gas is less viscous relative to the wave, and the pulses are
      // sharper under load, so more HF survives the round trip.
      setT(this.loopLP.frequency,
        this._f(this.lpBase * scale * (1 + 0.35 * load)), now, TC);
      setT(this.fb.gain, -this._fbMag(load), now, TC);
    } else {
      for (let i = 0; i < this.modes.length; i++) {
        const m = this.modes[i];
        setT(m.bp.frequency, this._f(this.frequency * m.order * scale), now, TC_DELAY);
      }
    }
  }

  _countNodes() {
    let n = 4; // inGain, out, dryGain, wetGain
    if (this.mode === 'delay') n += 4;
    else n += this.modes.length * 2;
    return n;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const nodes = [this.inGain, this.out, this.dryGain, this.wetGain,
      this.sum, this.delay, this.loopLP, this.fb];
    if (this.modes) for (const m of this.modes) nodes.push(m.bp, m.g);
    for (const n of nodes) { if (n && n.disconnect) n.disconnect(); }
  }
}

// ---------------------------------------------------------------------------
// Muffler
// ---------------------------------------------------------------------------

/**
 * A reactive muffler: a series of expansion chambers / quarter-wave side
 * branches, plus the absorptive packing.
 *
 * Every chamber in profiles.js (0.08 m … 0.40 m) has a round-trip delay well
 * below the 128-sample feedback floor, so these CANNOT be feedback waveguides.
 * They are feedforward combs, which has no minimum delay and is also the more
 * honest model: a side branch of length L reflects a wave that returns 2L/c
 * later and cancels the through path where the two are out of phase.
 *
 *   stage:  in ─┬───────────────────► (+) ─► next
 *               └─►[T_i]─►[× g_i]────┘
 *
 * H_i(f) = 1 + g_i·e^(−j2πfT_i)  →  NOTCHES at (2k+1)/(2T_i), which is exactly
 * `pipeFrequency(chamberLength)`, and PEAKS at k/T_i (twice that).
 *
 * The whole point of a muffler is broadband destructive interference, which
 * fails if the stages' peaks line up — a peak of stage B sitting on a notch of
 * stage A fills the notch back in. The profile lengths are already fairly
 * incommensurate, but `decorrelate` (default on) runs a small deterministic
 * search at construction time that nudges each stage after the first by up to
 * ±6 % to minimise peak coincidence. `this.coincidence` reports the cost before
 * and after so the effect is measurable rather than asserted.
 *
 * opts:
 *   chambers      m[], overrides profile.exhaust.muffler
 *   branchGain    0..0.9 base branch reflection strength (default from
 *                 exhaust.reflection; deeper notch = quieter, more restrictive)
 *   decorrelate   bool, default true
 *   spread        max fractional nudge, default 0.06
 *   packingOctaves absorptive lowpass position, default 7 (× first-chamber f)
 */
export class Muffler {
  constructor(ctx, profile, opts = {}) {
    this.ctx = ctx;
    this.profile = profile;
    this.disposed = false;

    const ex = (profile && profile.exhaust) || {};
    const src = Array.isArray(opts.chambers) ? opts.chambers
      : Array.isArray(ex.muffler) ? ex.muffler : [0.30, 0.20, 0.13];
    this.chambers = src.map(L => clamp(num(L, 0.2), 0.02, 3));
    this.gasTemp = clamp(num(opts.gasTempFactor, num(profile && profile.gasTempFactor, 1)), 0.5, 2.5);

    this.sampleRate = num(ctx && ctx.sampleRate, 48000);
    this.fMax = Math.min(F_MAX, 0.49 * this.sampleRate);

    this.thermalSpan = clamp(num(opts.thermalSpan, 0.025), 0, 0.2); // half the
    // header swing: gas has already cooled a lot by the time it reaches the box.
    this.thermalBias = 0.35;

    const baseDelays = this.chambers.map(L => pipeDelay(L, this.gasTemp));
    this.spread = clamp(num(opts.spread, 0.06), 0, 0.25);
    const doDecorr = opts.decorrelate !== false;

    const before = Muffler.peakCoincidence(baseDelays);
    this.delays = doDecorr ? Muffler._decorrelate(baseDelays, this.spread) : baseDelays.slice();
    const after = Muffler.peakCoincidence(this.delays);
    /** {before, after} peak-coincidence cost. Lower is better (0 = disjoint). */
    this.coincidence = { before, after };

    /** Notch frequencies (first notch of each stage), Hz. */
    this.notches = this.delays.map(T => 1 / (2 * T));

    const refl = clamp(num(ex.reflection, 0.5), 0, 1);
    // A bigger expansion ratio reflects more and notches deeper. 0.72 gives a
    // −11 dB notch, about right for a stock reactive box; a straight-through
    // sports muffler would be nearer 0.45 (−5 dB).
    this.branchGain = clamp(num(opts.branchGain, 0.55 + 0.30 * refl), 0.05, 0.9);

    // Absorptive packing: broadband loss rising with frequency. Anchored to the
    // largest chamber so a big muscle-car box is darker than a small one.
    const octaves = clamp(num(opts.packingOctaves, 7), 1, 40);
    this.packingBase = clamp(
      pipeFrequency(Math.max(...this.chambers), this.gasTemp) * octaves, 500, 11000);

    // ---- nodes ----
    this.inGain = ctx.createGain();
    this.inGain.gain.value = 1;
    this.out = ctx.createGain();
    this.out.gain.value = 1;

    this.stages = [];
    let node = this.inGain;
    for (let i = 0; i < this.delays.length; i++) {
      const T = this.delays[i];
      const sum = ctx.createGain();
      sum.gain.value = 1;

      const thru = ctx.createGain();
      thru.gain.value = 1;

      const maxT = Math.max(0.005, T / (1 - this.thermalSpan) * 1.5);
      const d = ctx.createDelay(maxT);   // NOT in a cycle → no quantum floor
      d.delayTime.value = clamp(T, 0, maxT);

      const bg = ctx.createGain();
      // Later chambers are smaller and shallower.
      bg.gain.value = this.branchGain * Math.pow(0.92, i);

      node.connect(thru); thru.connect(sum);
      node.connect(d); d.connect(bg); bg.connect(sum);

      this.stages.push({ sum, thru, delay: d, branch: bg, T, maxT, taper: Math.pow(0.92, i) });
      node = sum;
    }

    this.packing = ctx.createBiquadFilter();
    this.packing.type = 'lowpass';
    this.packing.frequency.value = clamp(this.packingBase, F_MIN, this.fMax);
    this.packing.Q.value = 0.6;

    // Each stage can add up to (1+g) of gain at its peaks; normalise so the
    // muffler does not raise level. Worst case product of (1+g_i).
    let peakProd = 1;
    for (const s of this.stages) peakProd *= (1 + s.branch.gain.value);
    this.trim = ctx.createGain();
    this.trim.gain.value = 1 / Math.max(1, peakProd * 0.72);

    node.connect(this.packing);
    this.packing.connect(this.trim);
    this.trim.connect(this.out);

    this._nodeCount = 4 + this.stages.length * 4;
  }

  get input() { return this.inGain; }
  get output() { return this.out; }

  /**
   * Cost of two stages' transmission peaks landing on top of each other.
   * Peaks of stage i are at k/T_i. Gaussian overlap, summed over pairs.
   * Pure function, no audio — used by the decorrelation search and by tests.
   */
  static peakCoincidence(delays, kMax = 6, tolHz = 45) {
    let cost = 0;
    for (let i = 0; i < delays.length; i++) {
      for (let j = i + 1; j < delays.length; j++) {
        for (let a = 1; a <= kMax; a++) {
          for (let b = 1; b <= kMax; b++) {
            const fa = a / delays[i], fb = b / delays[j];
            if (fa > 8000 || fb > 8000) continue;
            const d = (fa - fb) / tolHz;
            cost += Math.exp(-d * d) / (a * b);   // low-order clashes matter most
          }
        }
      }
    }
    return cost;
  }

  /** Greedy deterministic nudge of each stage after the first. */
  static _decorrelate(delays, spread) {
    const out = delays.slice();
    const STEPS = 41;
    for (let i = 1; i < out.length; i++) {
      let best = out[i], bestCost = Infinity;
      for (let s = 0; s < STEPS; s++) {
        const k = 1 + spread * ((2 * s) / (STEPS - 1) - 1);
        const trial = out.slice(0, i + 1);
        trial[i] = delays[i] * k;
        const c = Muffler.peakCoincidence(trial);
        if (c < bestCost - 1e-12) { bestCost = c; best = delays[i] * k; }
      }
      out[i] = best;
    }
    return out;
  }

  update(p) {
    if (this.disposed) return;
    const now = num(p && p.now, num(this.ctx.currentTime, 0));
    const load = clamp(num(p && p.load, 0), 0, 1);
    const rpmNorm = clamp(num(p && p.rpmNorm, 0), 0, 1);
    const heat = clamp(0.6 * load + 0.4 * rpmNorm, 0, 1);
    const scale = 1 + this.thermalSpan * (heat - this.thermalBias);

    for (let i = 0; i < this.stages.length; i++) {
      const s = this.stages[i];
      setT(s.delay.delayTime, clamp(s.T / scale, 0, s.maxT), now, TC_DELAY);
      // At high mass flow the chamber mouths behave slightly less like ideal
      // reflectors (mean flow carries energy through), so the notches shallow
      // out under load — which is a real part of why a car gets louder when you
      // open the throttle rather than just brighter.
      // `valve` is the live exhaust-bypass input: an open valve routes gas
      // around the chambers, so the notches go shallow.
      const valve = clamp(num(p && p.valve, 0), 0, 1);
      setT(s.branch.gain,
        clamp(this.branchGain * s.taper * (1 - 0.12 * load) * (1 - 0.65 * valve), 0, 0.95), now, TC);
    }
    const valve = clamp(num(p && p.valve, 0), 0, 1);
    setT(this.packing.frequency,
      clamp(this.packingBase * (1 + 0.30 * load) * (1 + 1.1 * valve) * scale, F_MIN, this.fMax), now, TC);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const nodes = [this.inGain, this.out, this.packing, this.trim];
    for (const s of this.stages) nodes.push(s.sum, s.thru, s.delay, s.branch);
    for (const n of nodes) { if (n && n.disconnect) n.disconnect(); }
  }
}

// ---------------------------------------------------------------------------
// IntakeResonator
// ---------------------------------------------------------------------------

/**
 * Airbox / plenum Helmholtz resonance plus the induction-noise path.
 *
 * A Helmholtz resonator is f = (c/2π)·√(A/(V·L)): a property of the CAVITY, not
 * of the engine. It does NOT move with rpm. What moves with rpm is how hard it
 * is being hit — which is why an induction howl swells at a particular rpm and
 * then fades: the firing rate sweeps THROUGH the fixed cavity peak.
 * profile.intake.helmholtz/q are that fixed peak.
 *
 * Two excitation paths, following the PTR engine-sound model:
 *   1. Combustion-correlated: the intake pulse wavetable from pulse.js, gated by
 *      max(torque, ε)^0.7. The 0.7 exponent (rather than linear) is why an
 *      engine at 30 % throttle already sounds most of the way to loud.
 *   2. Turbulent flow noise through the throttle body and filter — broadband,
 *      gated by mass flow. Its band DOES move, because flow noise is Strouhal-
 *      scaled (f ≈ St·U/d) and U rises with rpm×throttle. This is a different
 *      mechanism from the Helmholtz mode and is why it is a separate filter.
 *   3. Coast-down: on the overrun the throttle is shut, mass flow is small but
 *      the pressure drop across the plate is huge, so there is a distinct
 *      higher, hissier, quieter noise. Separate term, per the PTR model.
 *
 * input: the intake PeriodicWave oscillator. Also generates its own noise.
 */
export class IntakeResonator {
  constructor(ctx, profile, opts = {}) {
    this.ctx = ctx;
    this.profile = profile;
    this.disposed = false;

    const it = (profile && profile.intake) || {};
    this.f0 = clamp(num(opts.helmholtz, num(it.helmholtz, 110)), F_MIN, 2000);
    this.q0 = clamp(num(opts.q, num(it.q, 6)), 0.3, 30);
    this.level = clamp(num(opts.level, num(it.level, 0.33)), 0, 4);

    this.sampleRate = num(ctx && ctx.sampleRate, 48000);
    this.fMax = Math.min(F_MAX, 0.49 * this.sampleRate);

    this.out = ctx.createGain();
    this.out.gain.value = this.level;

    // ---- combustion-correlated path ----
    this.inGain = ctx.createGain();
    this.inGain.gain.value = 1;

    this.helm = ctx.createBiquadFilter();
    this.helm.type = 'bandpass';
    this.helm.frequency.value = this._f(this.f0);   // FIXED. Never tracks rpm.
    this.helm.Q.value = this.q0;

    this.helmGain = ctx.createGain();
    this.helmGain.gain.value = 0;

    this.inGain.connect(this.helm);
    this.helm.connect(this.helmGain);
    this.helmGain.connect(this.out);

    // Direct (non-resonant) part of the intake pulse: the runners and the port
    // radiate too, just without the cavity gain. Lowpassed — the plenum volume
    // is an acoustic low-pass to anything above a few hundred Hz.
    this.directLP = ctx.createBiquadFilter();
    this.directLP.type = 'lowpass';
    this.directLP.frequency.value = this._f(this.f0 * 4);
    this.directLP.Q.value = 0.7;
    this.directGain = ctx.createGain();
    this.directGain.gain.value = 0;
    this.inGain.connect(this.directLP);
    this.directLP.connect(this.directGain);
    this.directGain.connect(this.out);

    // ---- turbulence / induction noise ----
    this.noiseBuf = this._makeNoise(ctx, 2.0);
    this.noiseSrc = ctx.createBufferSource();
    this.noiseSrc.buffer = this.noiseBuf;
    this.noiseSrc.loop = true;

    this.noiseHP = ctx.createBiquadFilter();
    this.noiseHP.type = 'highpass';
    this.noiseHP.frequency.value = this._f(this.f0 * 0.8);
    this.noiseHP.Q.value = 0.7;

    this.noiseBP = ctx.createBiquadFilter();
    this.noiseBP.type = 'bandpass';
    this.noiseBP.frequency.value = this._f(this.f0 * 3);
    this.noiseBP.Q.value = 0.9;

    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;

    this.noiseSrc.connect(this.noiseHP);
    this.noiseHP.connect(this.noiseBP);
    this.noiseBP.connect(this.noiseGain);
    this.noiseGain.connect(this.out);

    // Turbulence also EXCITES the cavity mode — that broadband hiss is what
    // rings the airbox between combustion events, and it is why the howl has a
    // rough edge rather than being a pure tone.
    this.noiseToHelm = ctx.createGain();
    this.noiseToHelm.gain.value = 0;
    this.noiseHP.connect(this.noiseToHelm);
    this.noiseToHelm.connect(this.helm);

    this.started = false;
    this._nodeCount = 10;
  }

  get input() { return this.inGain; }
  get output() { return this.out; }

  _f(f) { return clamp(num(f, F_MIN), F_MIN, this.fMax); }

  /** Deterministic pink-ish noise so a profile always sounds the same. */
  _makeNoise(ctx, seconds) {
    const n = Math.max(1, Math.floor(num(ctx && ctx.sampleRate, 48000) * seconds));
    const buf = ctx.createBuffer(1, n, num(ctx && ctx.sampleRate, 48000));
    const d = buf.getChannelData(0);
    let s = 0x9e3779b9 >>> 0;
    let b0 = 0, b1 = 0;
    for (let i = 0; i < n; i++) {
      s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
      const w = (s / 4294967296) * 2 - 1;
      // Two-pole pinking: turbulent jet noise is not flat, it falls with f.
      b0 = 0.997 * b0 + w * 0.0555179;
      b1 = 0.985 * b1 + w * 0.3104856;
      d[i] = clamp((b0 + b1 + w * 0.1848) * 0.32, -1, 1);
    }
    return buf;
  }

  /** Start the internal noise source. Safe to call more than once. */
  start(when) {
    if (this.started || this.disposed) return;
    this.started = true;
    try { this.noiseSrc.start(num(when, 0)); } catch (e) { /* already started */ }
  }

  update(p) {
    if (this.disposed) return;
    if (!this.started) this.start(num(p && p.now, 0));

    const now = num(p && p.now, num(this.ctx.currentTime, 0));
    const load = clamp(num(p && p.load, 0), 0, 1);
    const throttle = clamp(num(p && p.throttle, 0), 0, 1);
    const rpmNorm = clamp(num(p && p.rpmNorm, 0), 0, 1);
    const overrun = clamp(num(p && p.overrun, 0), 0, 1);

    // PTR combustion-noise gate: max(torque, ε)^0.7.
    const excite = Math.pow(Math.max(load, 1e-3), 0.7);

    // Mass flow ≈ throttle opening × pumping rate.
    const flow = clamp(throttle * (0.25 + 0.75 * rpmNorm), 0, 1);
    // Coast-down: plate shut, big Δp, small flow. Hissier and much quieter.
    const coast = clamp(overrun * (0.15 + 0.85 * rpmNorm), 0, 1);

    // The cavity Q drops when the butterfly is closed: a nearly shut plate is a
    // large acoustic resistance in the neck and damps the resonator. Real, and
    // it is why induction howl only appears at open throttle.
    setT(this.helm.Q, clamp(this.q0 * (0.55 + 0.45 * throttle), 0.3, 30), now, 0.05);
    // Frequency is a cavity property — written once per frame at a constant so
    // nothing else can drift it, but never as a function of rpm.
    setT(this.helm.frequency, this._f(this.f0), now, 0.1);

    setT(this.helmGain.gain,
      clamp((0.12 + 0.88 * excite) * (0.35 + 0.65 * rpmNorm), 0, 4), now, TC);
    setT(this.directGain.gain, clamp(0.30 * (0.2 + 0.8 * excite), 0, 4), now, TC);

    // Strouhal scaling of the throttle-body jet: f ≈ St·U/d, U ∝ flow.
    setT(this.noiseBP.frequency,
      this._f(this.f0 * (3 + 9 * flow) * (1 + 0.6 * coast)), now, TC);
    setT(this.noiseBP.Q, clamp(0.9 + 0.7 * flow, 0.3, 6), now, 0.05);
    setT(this.noiseGain.gain,
      clamp(0.42 * Math.pow(flow, 1.2) + 0.16 * coast, 0, 4), now, TC);
    setT(this.noiseToHelm.gain, clamp(0.20 * flow + 0.05 * coast, 0, 2), now, TC);

    setT(this.out.gain, clamp(this.level, 0, 4), now, 0.1);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { if (this.started) this.noiseSrc.stop(); } catch (e) { /* not started */ }
    const nodes = [this.inGain, this.out, this.helm, this.helmGain, this.directLP,
      this.directGain, this.noiseSrc, this.noiseHP, this.noiseBP,
      this.noiseGain, this.noiseToHelm];
    for (const n of nodes) { if (n && n.disconnect) n.disconnect(); }
  }
}

// ---------------------------------------------------------------------------
// Nonlinearity
// ---------------------------------------------------------------------------

/**
 * Amplitude-dependent waveform steepening — the rasp.
 *
 * At 150+ dB inside a header, propagation stops being linear: the crest of a
 * pressure wave travels faster than the trough (c depends on local T and on
 * particle velocity), so over a metre of pipe the wave steepens toward a shock
 * front and gains a great deal of high-order content. This is why an engine
 * does not merely get LOUDER under load, it gets HARSHER — a linear gain stage
 * cannot produce that and it is the single biggest tell of a fake engine sound.
 *
 * Implementation: fixed asymmetric saturation curve, built once and cached
 * module-wide (see shockCurve), with a drive gain in front that scales with
 * load, and a compensating gain after so the effect is mostly timbral rather
 * than a volume ride. oversample '4x' because a shaper generating 10+ harmonics
 * of a 200 Hz signal will alias badly at 1x.
 *
 * opts:
 *   maxDrive   pre-gain at full load/rpm, default 4.5. TASTE-ADJUSTABLE:
 *              this is the "how raspy is this car" knob.
 *   kp, kn     curve asymmetry, default 3.2 / 2.0
 *   idleDrive  pre-gain at zero load, default 1.0 (linear region → clean idle)
 */
export class Nonlinearity {
  constructor(ctx, profile, opts = {}) {
    this.ctx = ctx;
    this.profile = profile;
    this.disposed = false;

    // 4.5 → 2.6. With the old curve the drive was mostly moving the signal
    // into the clamp; with a curve that has real headroom, 2.6 at full load
    // gives the same audible rasp onset without squaring the waveform.
    // 2.6 → 4.5 (the original): with the soft ±6 curve the stage no longer
    // flat-tops, and at 2.6 it was nearly linear — the harmonic grit of the
    // pulses went with it and the engine sounded "underwater" (test/chain.mjs).
    this.maxDrive = clamp(num(opts.maxDrive, 4.5), 1, 40);
    this.idleDrive = clamp(num(opts.idleDrive, 1.0), 0.1, 10);
    const kp = clamp(num(opts.kp, 3.2), 0.5, 12);
    const kn = clamp(num(opts.kn, 2.0), 0.5, 12);

    this.sampleRate = num(ctx && ctx.sampleRate, 48000);
    this.fMax = Math.min(F_MAX, 0.49 * this.sampleRate);

    this.drive = ctx.createGain();
    this.drive.gain.value = this.idleDrive;

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = shockCurve(kp, kn, 4096);   // built once, shared
    this.shaper.oversample = '4x';
    // The curve spans ±SHOCK_HEADROOM; scale into its domain.
    this.span = ctx.createGain();
    this.span.gain.value = 1 / shockHead();

    // Asymmetric shaping of a symmetric signal produces a load-dependent DC
    // offset. Without this highpass, rolling on throttle would thump.
    this.dcBlock = ctx.createBiquadFilter();
    this.dcBlock.type = 'highpass';
    this.dcBlock.frequency.value = clamp(22, F_MIN, this.fMax);
    this.dcBlock.Q.value = 0.7;

    this.makeup = ctx.createGain();
    this.makeup.gain.value = this._makeupFor(this.idleDrive);

    this.out = ctx.createGain();
    this.out.gain.value = 1;

    this.drive.connect(this.span);
    this.span.connect(this.shaper);
    this.shaper.connect(this.dcBlock);
    this.dcBlock.connect(this.makeup);
    this.makeup.connect(this.out);

    this._nodeCount = 6;
  }

  get input() { return this.drive; }
  get output() { return this.out; }

  /**
   * Level compensation. The curve's small-signal slope is kp/tanh(kp) ≈ 3.2, so
   * a drive of D gives roughly D× more level before saturation limits it. Undo
   * ~70 % of that: some level rise with load is correct (the engine IS louder),
   * we only want to stop the shaper adding a second, wrong, loudness curve.
   */
  _makeupFor(d) {
    return clamp(1 / Math.pow(Math.max(0.05, d), 0.70), 0.05, 4);
  }

  update(p) {
    if (this.disposed) return;
    const now = num(p && p.now, num(this.ctx.currentTime, 0));
    const load = clamp(num(p && p.load, 0), 0, 1);
    const rpmNorm = clamp(num(p && p.rpmNorm, 0), 0, 1);
    const boost = clamp(num(p && p.boost, 0), 0, 1);
    const overrun = clamp(num(p && p.overrun, 0), 0, 1);

    // Cylinder pressure — and therefore pulse amplitude in the pipe — scales
    // with load and with boost. rpm contributes because peak particle velocity
    // rises with flow rate. load^1.5 keeps idle firmly in the linear region.
    const amp = clamp(
      Math.pow(load, 1.5) * (0.35 + 0.65 * rpmNorm) + 0.55 * boost * load, 0, 1.4);
    // On the overrun there is no combustion but there IS unburnt fuel lighting
    // off in the pipe — sharp, low-amplitude, and it crackles. A little drive
    // even at zero load.
    const od = 0.25 * overrun * (0.3 + 0.7 * rpmNorm)
             + 0.22 * clamp(num(p && p.valve, 0), 0, 1) * (0.4 + 0.6 * load);

    const d = clamp(this.idleDrive + (this.maxDrive - this.idleDrive) * clamp(amp + od, 0, 1),
      0.1, this.maxDrive);
    setT(this.drive.gain, d, now, TC);
    setT(this.makeup.gain, this._makeupFor(d), now, TC);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const n of [this.drive, this.span, this.shaper, this.dcBlock, this.makeup, this.out]) {
      if (n && n.disconnect) n.disconnect();
    }
  }
}

// ---------------------------------------------------------------------------
// CabinFilter
// ---------------------------------------------------------------------------

/**
 * Exterior ↔ interior perspective, without a convolver (we have no impulse
 * response, and one would be a sample).
 *
 * Interior is three things, all filterable:
 *   1. Transmission loss through glass and body panels. Mass law: TL rises
 *      ~6 dB per octave above the panel's critical frequency, so a car body is
 *      a first/second-order lowpass with a corner around 1 kHz for glass. That
 *      is the dominant effect and it is why a V8 outside is a bark and inside
 *      is a boom.
 *   2. Cabin cavity modes. The longitudinal mode of a ~2.75 m passenger
 *      compartment is c/2L = 343/5.5 ≈ 62 Hz — the classic "boom" every car
 *      magazine complains about. A second, weaker panel/floorpan drumming mode
 *      sits around 155 Hz. Both are BOOSTS, and they are why the inside of a
 *      car has more bass than the outside despite the panels attenuating.
 *   3. Extra high-frequency loss from trim, carpet and seat foam: a shelf cut
 *      on top of the lowpass.
 *
 * Exterior is not flat either — air absorption and ground reflection roll off
 * the very top — but it is close, so the exterior end of the blend is a very
 * high lowpass corner and 0 dB peaks (a peaking biquad at 0 dB is transparent).
 *
 * setPosition(0..1) blends continuously; setPerspective() is the two-value
 * shorthand. Filter TYPES never change (that would click); only params move.
 */
export class CabinFilter {
  constructor(ctx, profile, opts = {}) {
    this.ctx = ctx;
    this.profile = profile;
    this.disposed = false;

    this.sampleRate = num(ctx && ctx.sampleRate, 48000);
    this.fMax = Math.min(F_MAX, 0.49 * this.sampleRate);

    // Cavity geometry. Defaults are a mid-size passenger compartment.
    this.boomHz = clamp(num(opts.boomHz, 62), 20, 300);      // 343/(2·2.75 m)
    this.panelHz = clamp(num(opts.panelHz, 155), 40, 800);   // floorpan drumming
    this.extLP = clamp(num(opts.exteriorLP, 17000), 1000, this.fMax);
    this.intLP = clamp(num(opts.interiorLP, 1050), 120, 8000);
    this.intBoomDb = clamp(num(opts.boomDb, 6.5), 0, 18);
    this.intPanelDb = clamp(num(opts.panelDb, 3.5), 0, 18);
    this.intShelfDb = clamp(num(opts.shelfDb, -11), -40, 0);
    this.shelfHz = clamp(num(opts.shelfHz, 3200), 500, this.fMax);

    this.position = clamp(num(opts.position, 0), 0, 1);
    this.target = this.position;

    this.inGain = ctx.createGain();
    this.inGain.gain.value = 1;

    this.boom = ctx.createBiquadFilter();
    this.boom.type = 'peaking';
    this.boom.frequency.value = clamp(this.boomHz, F_MIN, this.fMax);
    this.boom.Q.value = clamp(num(opts.boomQ, 3.2), 0.3, 20);
    this.boom.gain.value = 0;

    this.panel = ctx.createBiquadFilter();
    this.panel.type = 'peaking';
    this.panel.frequency.value = clamp(this.panelHz, F_MIN, this.fMax);
    this.panel.Q.value = clamp(num(opts.panelQ, 2.4), 0.3, 20);
    this.panel.gain.value = 0;

    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = clamp(this.extLP, F_MIN, this.fMax);
    this.lp.Q.value = 0.6;

    this.shelf = ctx.createBiquadFilter();
    this.shelf.type = 'highshelf';
    this.shelf.frequency.value = clamp(this.shelfHz, F_MIN, this.fMax);
    this.shelf.gain.value = 0;

    // Sealing the car also drops overall level; without this, "get in the car"
    // sounds like an EQ change rather than a door closing.
    this.trim = ctx.createGain();
    this.trim.gain.value = 1;

    this.out = ctx.createGain();
    this.out.gain.value = 1;

    this.inGain.connect(this.boom);
    this.boom.connect(this.panel);
    this.panel.connect(this.lp);
    this.lp.connect(this.shelf);
    this.shelf.connect(this.trim);
    this.trim.connect(this.out);

    this._nodeCount = 7;
    this._write(num(ctx.currentTime, 0), 0.001);
  }

  get input() { return this.inGain; }
  get output() { return this.out; }

  /** 'exterior' | 'interior'. Anything else is ignored. */
  setPerspective(which) {
    if (which === 'interior') this.setPosition(1);
    else if (which === 'exterior') this.setPosition(0);
    return this;
  }

  /** 0 = fully outside, 1 = fully inside. Continuous; blend is smoothed. */
  setPosition(x) {
    this.target = clamp(num(x, 0), 0, 1);
    if (!this.disposed) this._write(num(this.ctx.currentTime, 0), 0.05);
    return this;
  }

  get perspective() { return this.target >= 0.5 ? 'interior' : 'exterior'; }

  _write(now, tc) {
    const x = this.target;
    // Lowpass corner interpolates geometrically — an octave is a perceptual
    // unit, a hertz is not.
    const f = this.extLP * Math.pow(this.intLP / this.extLP, x);
    setT(this.lp.frequency, clamp(f, F_MIN, this.fMax), now, tc);
    setT(this.boom.gain, this.intBoomDb * x, now, tc);
    setT(this.panel.gain, this.intPanelDb * x, now, tc);
    setT(this.shelf.gain, this.intShelfDb * x, now, tc);
    // −4.5 dB of broadband insertion loss at full interior.
    setT(this.trim.gain, clamp(Math.pow(10, (-4.5 * x) / 20), 0.05, 1), now, tc);
  }

  update(p) {
    if (this.disposed) return;
    const now = num(p && p.now, num(this.ctx.currentTime, 0));
    this._write(now, 0.05);
    this.position = this.target;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const n of [this.inGain, this.boom, this.panel, this.lp, this.shelf,
      this.trim, this.out]) {
      if (n && n.disconnect) n.disconnect();
    }
  }
}

// ---------------------------------------------------------------------------
// ExhaustSystem
// ---------------------------------------------------------------------------

/**
 * The whole exhaust, assembled from the parts above:
 *
 *   inputs[0] ─►[Waveguide bank A]─►[transit L_A/c]─┐
 *   inputs[1] ─►[Waveguide bank B]─►[transit L_B/c]─┼►[Waveguide collector]
 *        ...                                        ┘        │
 *                                                             ▼
 *                                     [Muffler]─►[Nonlinearity]─► output
 *
 * One input per exhaust bank; the caller connects bank i's PeriodicWave
 * oscillator to `inputs[i]`.
 *
 * UNEQUAL HEADERS. `exhaust.bankB`, present only on boxer4, gives bank 1 a
 * different header length. Two consequences, and BOTH are needed for the
 * Subaru rumble:
 *   (a) different resonance: 1.62 m → 67 Hz, 0.98 m → 111 Hz. Two pipes ringing
 *       a fifth-and-a-bit apart, beating against each other.
 *   (b) different TRANSIT TIME to the collector: L/(c·g) one-way is 3.72 ms vs
 *       2.25 ms, a 1.47 ms skew. At the firing frequency that is a phase error;
 *       by ~340 Hz it is a full cycle, so the two banks comb-filter each other
 *       across the whole midrange. This is modelled with an explicit one-way
 *       DelayNode per bank — NOT in a feedback loop, so the render-quantum
 *       floor does not apply and the true value is usable.
 * Engines without bankB get identical banks, which is correct: a symmetric V8
 * has equal-length headers and does not do this.
 *
 * opts: { bankOpts, collectorOpts, mufflerOpts, nonlinearityOpts,
 *         transit: bool (default true), nonlinearity: bool (default true) }
 */
export class ExhaustSystem {
  constructor(ctx, profile, opts = {}) {
    this.ctx = ctx;
    this.profile = profile;
    this.disposed = false;

    const ex = (profile && profile.exhaust) || {};
    const banks = (profile && Array.isArray(profile.banks) && profile.banks.length)
      ? profile.banks : [[1]];
    const g = clamp(num(profile && profile.gasTempFactor, 1), 0.5, 2.5);

    this.sampleRate = num(ctx && ctx.sampleRate, 48000);

    /** Per-bank header length, m. bankB applies to bank index 1 only. */
    this.bankLengths = banks.map((_, i) =>
      (i === 1 && Number.isFinite(ex.bankB)) ? ex.bankB : num(ex.bank, 1.2));

    this.collectorNode = ctx.createGain();
    this.collectorNode.gain.value = 1 / Math.sqrt(banks.length); // power-preserving sum

    const useTransit = opts.transit !== false;

    this.banks = [];
    this.transits = [];
    this.inputs = [];
    for (let i = 0; i < banks.length; i++) {
      const wg = new Waveguide(ctx, profile,
        Object.assign({ length: this.bankLengths[i] }, opts.bankOpts));
      this.banks.push(wg);
      this.inputs.push(wg.input);

      if (useTransit) {
        // One-way travel time down the header, L/(c·g) = half the round trip.
        const t = wg.nominalDelay / 2;
        const maxT = Math.max(0.005, t * 2);
        const d = ctx.createDelay(maxT);
        d.delayTime.value = clamp(t, 0, maxT);
        wg.output.connect(d);
        d.connect(this.collectorNode);
        this.transits.push({ d, t, maxT });
      } else {
        wg.output.connect(this.collectorNode);
        this.transits.push(null);
      }
    }

    this.collector = new Waveguide(ctx, profile, Object.assign({
      length: num(ex.collector, 1.0),
      // A collector is a bigger-diameter, better-supported pipe than a header
      // and it is further from the hot valve, so it reflects a little less and
      // loses a little more.
      //
      // 0.88/1.12 → 0.5/2.0. A collector is a JUNCTION — an abrupt area change
      // into a bigger pipe, with the other bank's header hanging off it — and
      // reflects far less cleanly than a header's open end. Modelled as a
      // second strong comb it lined its peaks up with the header's and made the
      // rpm-local spikes described at MODE_SURVIVAL.
      // ×0.5 / ×2.0 killed the rpm-local spikes and the pipe's mid-range
      // character with them; ×0.7 / ×1.5 keeps the spikes down (tone metric)
      // and gives the mids back.
      reflection: clamp(num(ex.reflection, 0.5) * 0.7, 0, MAX_FEEDBACK),
      damping: clamp(num(ex.damping, 0.4) * 1.5, 0.05, 2),
    }, opts.collectorOpts));
    this.collectorNode.connect(this.collector.input);

    this.muffler = new Muffler(ctx, profile, opts.mufflerOpts);
    this.collector.output.connect(this.muffler.input);

    this.useNonlinearity = opts.nonlinearity !== false;
    this.out = ctx.createGain();
    this.out.gain.value = 1;

    if (this.useNonlinearity) {
      this.nonlinearity = new Nonlinearity(ctx, profile, opts.nonlinearityOpts);
      this.muffler.output.connect(this.nonlinearity.input);
      this.nonlinearity.output.connect(this.out);
    } else {
      this.nonlinearity = null;
      this.muffler.output.connect(this.out);
    }

    // Thermal modulation of the transit delays uses the bank waveguides' own
    // scale so header resonance and header transit stay physically consistent.
    this._thermalSpan = this.banks.length ? this.banks[0].thermalSpan : 0.05;
    this._thermalBias = this.banks.length ? this.banks[0].thermalBias : 0.35;

    /** Diagnostics — useful for sanity-checking profile data. */
    this.report = {
      bankLengths: this.bankLengths.slice(),
      bankFrequencies: this.banks.map(b => b.frequency),
      bankModes: this.banks.map(b => b.mode),
      collectorFrequency: this.collector.frequency,
      collectorMode: this.collector.mode,
      mufflerNotches: this.muffler.notches.slice(),
      transitSkewMs: this.transits[0] && this.transits[1]
        ? Math.abs(this.transits[0].t - this.transits[1].t) * 1000 : 0,
    };

    this._nodeCount = this._countNodes();
  }

  /** Contract requires an `input`; for a multi-bank unit it is bank 0. */
  get input() { return this.inputs[0]; }
  get output() { return this.out; }

  update(p) {
    if (this.disposed) return;
    const now = num(p && p.now, num(this.ctx.currentTime, 0));
    const load = clamp(num(p && p.load, 0), 0, 1);
    const rpmNorm = clamp(num(p && p.rpmNorm, 0), 0, 1);
    const heat = clamp(0.6 * load + 0.4 * rpmNorm, 0, 1);
    const scale = 1 + this._thermalSpan * (heat - this._thermalBias);

    for (let i = 0; i < this.banks.length; i++) {
      this.banks[i].update(p);
      const tr = this.transits[i];
      if (tr) setT(tr.d.delayTime, clamp(tr.t / scale, 0, tr.maxT), now, TC_DELAY);
    }
    this.collector.update(p);
    this.muffler.update(p);
    if (this.nonlinearity) this.nonlinearity.update(p);
  }

  _countNodes() {
    let n = 1 + 1; // collectorNode, out
    for (const b of this.banks) n += b._nodeCount;
    for (const t of this.transits) if (t) n += 1;
    n += this.collector._nodeCount + this.muffler._nodeCount;
    if (this.nonlinearity) n += this.nonlinearity._nodeCount;
    return n;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of this.banks) b.dispose();
    for (const t of this.transits) if (t && t.d.disconnect) t.d.disconnect();
    this.collector.dispose();
    this.muffler.dispose();
    if (this.nonlinearity) this.nonlinearity.dispose();
    for (const n of [this.collectorNode, this.out]) {
      if (n && n.disconnect) n.disconnect();
    }
  }
}

export { RENDER_QUANTUM, MAX_FEEDBACK, shockCurve };
