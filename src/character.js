/**
 * character.js — the layers that stop it sounding like a synthesiser.
 *
 * The wavetable path is physically derived and spectrally correct, and on its
 * own it sounds like a buzzer. Three things are missing, and none of them are
 * failures of the physics — they are things the pulse model simply does not
 * contain:
 *
 *  1. NOISE. A real exhaust is roughly half broadband flow noise, resonating in
 *     the same pipe as the combustion pulses. A pure harmonic stack has none of
 *     it, which is exactly what "sounds like a fly" means: perfectly regular
 *     harmonics with no air moving.
 *
 *  2. WEIGHT. The lowest orders carry the body of the sound but radiate weakly
 *     from a small tailpipe model. Real cars get theirs from the whole body
 *     panel area and from ground coupling.
 *
 *  3. IMPERFECTION. Combustion varies cycle to cycle by a few percent, no two
 *     cylinders are identical, and nothing in a real engine is ever exactly
 *     periodic. Static jitter baked into the wavetable is frozen; it has to
 *     move over time to read as alive.
 *
 * This module is unapologetically sound design rather than simulation. It is
 * layered ON TOP of the physical model and modulated by the same state, which
 * is how game engine audio actually gets its character.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const fin = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const TC = 0.02;

function setT(param, v, now, tc = TC) {
  if (!param) return;
  const val = fin(v, 0);
  param.setTargetAtTime(val, Math.max(0, fin(now, 0)), tc > 0 ? tc : TC);
}

/** Looping noise buffer, cross-faded at the seam so the loop is inaudible. */
function noiseBuffer(ctx, seconds, brown) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    else d[i] = w;
  }
  const fade = Math.min(2048, len >> 2);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    d[i] = d[i] * t + d[len - fade + i] * (1 - t);
  }
  return buf;
}

// ---------------------------------------------------------------------------

/**
 * Broadband exhaust flow noise, injected INTO the exhaust waveguides so it
 * resonates in the same pipe as the combustion pulses.
 *
 * This is the single biggest change to how "real" it reads. Gas leaving a
 * cylinder is turbulent, and that turbulence excites every pipe mode rather
 * than only the harmonics of the firing frequency. Feeding shaped noise into
 * the waveguide input turns a clean harmonic stack into a roar.
 *
 * The noise is also chopped by a pulse oscillator locked to the firing rate,
 * because the flow is not steady — it arrives in slugs, one per exhaust valve
 * event. That gives the low-rpm "chuffing" a synthesised engine never has.
 */
export class ExhaustNoise {
  constructor(ctx, profile, opts = {}) {
    this.ctx = ctx;
    this.profile = profile;
    this.cyl = profile.cylinders;
    this.pulseOrder = Math.max(0.5, this.cyl / 2 / Math.max(1, profile.banks.length));

    this.src = ctx.createBufferSource();
    this.src.buffer = noiseBuffer(ctx, 2.7, false);
    this.src.loop = true;

    // Shaped to the pipe: most turbulent energy is low-mid, and the pipe walls
    // kill the top before it ever gets out.
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 55;

    this.body = ctx.createBiquadFilter();
    this.body.type = 'lowpass';
    this.body.frequency.value = 900;
    this.body.Q.value = 0.9;

    // A resonant peak that tracks the firing rate: flow noise is not spectrally
    // flat, it is loudest around the pulse repetition rate.
    this.peak = ctx.createBiquadFilter();
    this.peak.type = 'peaking';
    this.peak.frequency.value = 140;
    this.peak.Q.value = 1.4;
    this.peak.gain.value = 7;

    this.level = ctx.createGain();
    this.level.gain.value = 0;

    // Firing-rate chopper summed into the level gain.
    this.pulse = ctx.createOscillator();
    this.pulse.type = 'sawtooth';
    this.pulse.frequency.value = 40;
    this.pulseDepth = ctx.createGain();
    this.pulseDepth.gain.value = 0;

    this.out = ctx.createGain();
    this.out.gain.value = 1;

    this.src.connect(this.hp);
    this.hp.connect(this.peak);
    this.peak.connect(this.body);
    this.body.connect(this.level);
    this.level.connect(this.out);
    this.pulse.connect(this.pulseDepth);
    this.pulseDepth.connect(this.level.gain);

    this.gain = clamp(fin(opts.gain, 1), 0, 4);
    this.started = false;
  }

  get input() { return null; }
  get output() { return this.out; }

  start(t) {
    if (this.started) return;
    this.started = true;
    try { this.src.start(t); } catch (e) { /* already started */ }
    try { this.pulse.start(t); } catch (e) { /* already started */ }
  }

  stop(t) {
    try { this.src.stop(t); } catch (e) { /* not started */ }
    try { this.pulse.stop(t); } catch (e) { /* not started */ }
    this.started = false;
  }

  update(p) {
    const now = fin(p.now, 0);
    const rpmNorm = clamp(fin(p.rpmNorm, 0), 0, 1);
    const load = clamp(fin(p.load, 0), 0, 1);
    const overrun = clamp(fin(p.overrun, 0), 0, 1);
    const f0 = clamp(fin(p.f0, 10), 0.05, 4000);
    const fire = clamp(f0 * this.pulseOrder * 2, 10, 6000);

    // Mass flow sets the level. Note it does NOT collapse on overrun: a closed
    // throttle still pumps air, which is why coasting has that hollow rush.
    const flow = 0.30 + 0.70 * load;
    const lvl = this.gain * 0.28 * flow * (0.25 + 0.75 * rpmNorm)
              * (1 + 0.35 * overrun);

    setT(this.level.gain, lvl, now);
    setT(this.pulse.frequency, fire, now);
    // Chopping is deepest at low rpm where individual slugs are distinguishable.
    setT(this.pulseDepth.gain, Math.min(lvl * 0.85, lvl * (1.1 - 0.7 * rpmNorm)), now);

    setT(this.peak.frequency, clamp(fire, 30, 2000), now);
    setT(this.body.frequency, clamp(450 + 2600 * load + 1800 * rpmNorm, 120, 9000), now);
    setT(this.hp.frequency, clamp(40 + 30 * rpmNorm, 20, 400), now);
  }

  dispose() {
    for (const n of [this.src, this.hp, this.peak, this.body, this.level,
                     this.pulse, this.pulseDepth, this.out]) {
      if (n && n.disconnect) n.disconnect();
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Sub-bass weight, locked to the dominant firing order.
 *
 * A tailpipe waveguide radiates its lowest orders weakly, but a real car's
 * low end also comes from body panels, the floorpan and ground coupling — none
 * of which the pipe model contains. Rather than fake that with EQ alone, this
 * synthesises the bottom octave directly: a sine at half the dominant firing
 * order (the "chest" frequency), plus mild saturation so it survives on small
 * speakers, which cannot reproduce 30 Hz but can hear its harmonics.
 */
export class SubLayer {
  constructor(ctx, profile, opts = {}) {
    this.ctx = ctx;
    this.profile = profile;
    // Dominant order is cylinders/2 for the whole engine; half of that puts the
    // sub an octave below the main note. But a fixed order lands in wildly
    // different places across the range — order 1 on an I4 is 25 Hz at 3000 rpm
    // (inaudible on anything but a subwoofer) while order 3 on a V12 is 117 Hz
    // (not a sub at all). So octave-shift it, in halves so it stays on a real
    // engine order and does not beat against the harmonics, until it sits in
    // the 38–85 Hz chest band at mid revs.
    let order = Math.max(0.5, profile.cylinders / 4);
    const fMid = ((profile.idleRpm + profile.redlineRpm) / 2) / 120;
    while (order * fMid < 38 && order < 8) order *= 2;
    while (order * fMid > 85 && order > 0.5) order /= 2;
    this.order = order;
    this.subHz = order * fMid;

    this.osc = ctx.createOscillator();
    this.osc.type = 'sine';
    this.osc.frequency.value = 40;

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = this._curve();
    this.shaper.oversample = '2x';

    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 220;
    this.tone.Q.value = 0.7;

    this.level = ctx.createGain();
    this.level.gain.value = 0;

    this.out = ctx.createGain();
    this.out.gain.value = clamp(fin(opts.gain, 1), 0, 4);

    this.osc.connect(this.shaper);
    this.shaper.connect(this.tone);
    this.tone.connect(this.level);
    this.level.connect(this.out);
    this.started = false;
  }

  /** Gentle asymmetric drive: adds 2nd and 3rd harmonics so the sub is audible
   *  on speakers that cannot reproduce the fundamental at all. */
  _curve(n = 2048) {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(1.8 * x) * 0.92 + 0.08 * Math.tanh(2.6 * x * x * Math.sign(x));
    }
    return c;
  }

  get input() { return null; }
  get output() { return this.out; }

  start(t) {
    if (this.started) return;
    this.started = true;
    try { this.osc.start(t); } catch (e) { /* already started */ }
  }

  stop(t) { try { this.osc.stop(t); } catch (e) { /* not started */ } this.started = false; }

  update(p) {
    const now = fin(p.now, 0);
    const f0 = clamp(fin(p.f0, 10), 0.05, 4000);
    const load = clamp(fin(p.load, 0), 0, 1);
    const rpmNorm = clamp(fin(p.rpmNorm, 0), 0, 1);
    const overrun = clamp(fin(p.overrun, 0), 0, 1);

    setT(this.osc.frequency, clamp(f0 * this.order, 12, 400), now);
    // Weight tracks load hard, and backs off at high rpm where the sub would
    // otherwise turn into a drone competing with the real note.
    const lvl = 0.34 * (0.18 + 0.82 * Math.pow(load, 0.75))
              * (1 - 0.45 * rpmNorm) * (1 - 0.6 * overrun);
    setT(this.level.gain, lvl, now);
    setT(this.tone.frequency, clamp(150 + 260 * load, 80, 800), now);
  }

  dispose() {
    for (const n of [this.osc, this.shaper, this.tone, this.level, this.out]) {
      if (n && n.disconnect) n.disconnect();
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Time-varying imperfection.
 *
 * The wavetable already carries per-cylinder variation, but it is baked in and
 * therefore frozen — the same "imperfection" repeats identically every cycle,
 * which the ear reads as just another periodic component. Real engines wander:
 * combustion varies a few percent cycle to cycle, idle hunts slightly, and
 * nothing is ever exactly on pitch.
 *
 * Outputs are AudioParam modulation signals rather than audio:
 *   `detune`  → sum into oscillator detune (cents)
 *   `tremolo` → sum into a gain
 *
 * Three mutually irrational LFO rates plus a filtered-noise term, so the
 * pattern never audibly repeats.
 */
export class CharacterModulator {
  constructor(ctx, profile, opts = {}) {
    this.ctx = ctx;
    this.depthCents = clamp(fin(opts.detuneCents, 7), 0, 60);
    this.depthGain = clamp(fin(opts.tremolo, 0.10), 0, 0.6);

    // Deliberately incommensurate so the combination has a very long period.
    const rates = [0.237, 1.703, 5.317];
    this.lfos = rates.map(r => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = r;
      const g = ctx.createGain();
      g.gain.value = 1 / rates.length;
      o.connect(g);
      return { osc: o, gain: g };
    });

    // Combustion roughness: band-limited noise, faster and more chaotic than
    // the LFOs. This is the cycle-to-cycle variation.
    this.rough = ctx.createBufferSource();
    this.rough.buffer = noiseBuffer(ctx, 3.1, true);
    this.rough.loop = true;
    this.roughLP = ctx.createBiquadFilter();
    this.roughLP.type = 'lowpass';
    this.roughLP.frequency.value = 22;
    this.roughGain = ctx.createGain();
    this.roughGain.gain.value = 0.9;
    this.rough.connect(this.roughLP);
    this.roughLP.connect(this.roughGain);

    this.bus = ctx.createGain();
    this.bus.gain.value = 1;
    for (const l of this.lfos) l.gain.connect(this.bus);
    this.roughGain.connect(this.bus);

    this.detune = ctx.createGain();      // → osc.detune, cents
    this.detune.gain.value = 0;
    this.tremolo = ctx.createGain();     // → a gain AudioParam
    this.tremolo.gain.value = 0;

    this.bus.connect(this.detune);
    this.bus.connect(this.tremolo);
    this.started = false;
  }

  get input() { return null; }
  get output() { return this.bus; }

  start(t) {
    if (this.started) return;
    this.started = true;
    for (const l of this.lfos) { try { l.osc.start(t); } catch (e) { /* started */ } }
    try { this.rough.start(t); } catch (e) { /* started */ }
  }

  stop(t) {
    for (const l of this.lfos) { try { l.osc.stop(t); } catch (e) { /* not started */ } }
    try { this.rough.stop(t); } catch (e) { /* not started */ }
    this.started = false;
  }

  update(p) {
    const now = fin(p.now, 0);
    const rpmNorm = clamp(fin(p.rpmNorm, 0), 0, 1);
    const load = clamp(fin(p.load, 0), 0, 1);

    // Idle is where an engine sounds most alive — lumpy, hunting, uneven. Under
    // load and revs the combustion is far more repeatable, so the wander fades.
    const lumpy = (1 - rpmNorm) * (1 - 0.55 * load);
    setT(this.detune.gain, this.depthCents * (0.25 + 0.75 * lumpy), now, 0.08);
    setT(this.tremolo.gain, this.depthGain * (0.2 + 0.8 * lumpy), now, 0.08);
    setT(this.roughLP.frequency, clamp(8 + 40 * rpmNorm, 4, 200), now, 0.1);
  }

  dispose() {
    for (const l of this.lfos) { l.osc.disconnect(); l.gain.disconnect(); }
    for (const n of [this.rough, this.roughLP, this.roughGain, this.bus,
                     this.detune, this.tremolo]) {
      if (n && n.disconnect) n.disconnect();
    }
  }
}
