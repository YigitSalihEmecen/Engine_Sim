/**
 * fx.js — output-stage processing: equaliser, reverb, stereo widener.
 *
 * These sit after the voice mix and before the compressor. Unlike the rest of
 * the simulator they make no claim to be physical — they are the tone controls
 * you would have on a mixing desk, exposed so the sound can be shaped to taste
 * without touching the model.
 *
 * All parameters are safe to change at any time; nothing here allocates per
 * frame. The one exception is reverb SIZE, which has to regenerate an impulse
 * response, so it is debounced and never called from the render loop.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const fin = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

// ---------------------------------------------------------------------------

/**
 * Five-band equaliser: low shelf, three peaking bands, high shelf.
 *
 * Frequencies are fixed at musically useful points for an engine — 60 Hz is the
 * sub/chest region, 200 Hz the body and boom, 800 Hz the honk that makes a synth
 * engine sound like a kazoo, 2.5 kHz the rasp and mechanical detail, 8 kHz air.
 */
export class EQ {
  static BANDS = [
    { f: 60, type: 'lowshelf', label: 'sub' },
    { f: 200, type: 'peaking', q: 0.9, label: 'body' },
    { f: 800, type: 'peaking', q: 1.0, label: 'honk' },
    { f: 2500, type: 'peaking', q: 0.9, label: 'rasp' },
    { f: 8000, type: 'highshelf', label: 'air' },
  ];

  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.inGain = ctx.createGain();
    this.out = ctx.createGain();

    this.bands = EQ.BANDS.map(b => {
      const f = ctx.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.f;
      if (b.q) f.Q.value = b.q;
      f.gain.value = 0;
      return f;
    });

    // Chain them in series.
    let node = this.inGain;
    for (const f of this.bands) { node.connect(f); node = f; }
    node.connect(this.out);

    if (opts.gains) this.setGains(opts.gains);
  }

  get input() { return this.inGain; }
  get output() { return this.out; }

  /** @param {number[]} gains dB per band, -18..+18 */
  setGains(gains) {
    const now = this.ctx.currentTime;
    for (let i = 0; i < this.bands.length && i < gains.length; i++) {
      this.bands[i].gain.setTargetAtTime(clamp(fin(gains[i], 0), -18, 18), now, 0.03);
    }
  }

  setBand(i, dB) {
    if (i < 0 || i >= this.bands.length) return;
    this.bands[i].gain.setTargetAtTime(
      clamp(fin(dB, 0), -18, 18), this.ctx.currentTime, 0.03);
  }

  getGains() { return this.bands.map(b => b.gain.value); }

  reset() { this.setGains(this.bands.map(() => 0)); }

  update() { /* nothing per-frame */ }

  dispose() {
    for (const n of [this.inGain, this.out, ...this.bands]) n.disconnect();
  }
}

// ---------------------------------------------------------------------------

/**
 * Convolution reverb with a procedurally generated impulse response.
 *
 * There is no impulse response file to load, so one is synthesised: a short
 * cluster of early reflections followed by an exponentially decaying noise
 * tail, decorrelated between channels so it opens up in stereo.
 *
 * This matters more than it looks for engine audio. Exhaust bangs rendered as
 * bare filtered noise bursts sound like someone flicking a plastic bottle —
 * they have no space around them and no tail, so they refuse to sit with the
 * sustained engine. A short reverb is what glues transients to a bed.
 */
export class Reverb {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.inGain = ctx.createGain();
    this.out = ctx.createGain();

    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.conv = ctx.createConvolver();
    this.conv.normalize = true;

    // Damping: a real space absorbs high frequencies faster than lows.
    this.damp = ctx.createBiquadFilter();
    this.damp.type = 'lowpass';
    this.damp.frequency.value = 4200;
    this.damp.Q.value = 0.7;

    // Keep sub energy out of the tail or it turns to mud.
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 110;

    this.inGain.connect(this.dry);
    this.dry.connect(this.out);
    this.inGain.connect(this.hp);
    this.hp.connect(this.conv);
    this.conv.connect(this.damp);
    this.damp.connect(this.wet);
    this.wet.connect(this.out);

    this._size = clamp(fin(opts.size, 0.35), 0.05, 1);
    this._mix = clamp(fin(opts.mix, 0.16), 0, 1);
    this.setSize(this._size);
    this.setMix(this._mix);
  }

  get input() { return this.inGain; }
  get output() { return this.out; }

  /**
   * Build the impulse response. `size` 0..1 maps to roughly 0.15–2.2 s.
   * Not cheap — never call this per frame.
   */
  _buildIR(size) {
    const ctx = this.ctx;
    const seconds = 0.15 + 2.05 * clamp(size, 0, 1);
    const len = Math.max(64, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    // Longer spaces decay more gently; short ones are tight and dense.
    const decay = 2.6 + 3.4 * (1 - size);

    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
      // Early reflections: a handful of discrete taps in the first ~60 ms give
      // the tail a sense of a real enclosure instead of a wash of noise.
      const taps = 7;
      for (let k = 0; k < taps; k++) {
        const at = Math.floor((0.004 + 0.055 * Math.random()) * ctx.sampleRate);
        if (at < len) d[at] += (Math.random() * 2 - 1) * 0.55 * (1 - k / taps);
      }
    }
    return buf;
  }

  /** @param {number} v 0..1 */
  setSize(v) {
    this._size = clamp(fin(v, 0.35), 0.05, 1);
    this.conv.buffer = this._buildIR(this._size);
    return this._size;
  }

  /** @param {number} v 0 = dry, 1 = fully wet */
  setMix(v) {
    this._mix = clamp(fin(v, 0), 0, 1);
    this._writeMix(0.03);
    return this._mix;
  }

  /**
   * Extra wetness on top of the preset's mix, from the live inputs (distance,
   * environment). Kept separate so a game moving the listener never edits the
   * saved sound.
   */
  setExtra(v) {
    const e = clamp(fin(v, 0), 0, 1);
    if (Math.abs(e - (this._extra || 0)) < 1e-3) return;
    this._extra = e;
    this._writeMix(0.08);
  }

  _writeMix(tc) {
    const m = clamp(this._mix + (this._extra || 0) * (1 - this._mix), 0, 1);
    const now = this.ctx.currentTime;
    // Equal-power so total loudness stays put as it is swept.
    this.dry.gain.setTargetAtTime(Math.cos(m * Math.PI / 2), now, tc);
    this.wet.gain.setTargetAtTime(Math.sin(m * Math.PI / 2) * 1.4, now, tc);
  }

  /** @param {number} hz high-frequency absorption of the tail */
  setDamping(hz) {
    this.damp.frequency.setTargetAtTime(
      clamp(fin(hz, 4200), 400, 18000), this.ctx.currentTime, 0.05);
  }

  getState() { return { size: this._size, mix: this._mix, damping: this.damp.frequency.value }; }

  update() { /* nothing per-frame */ }

  dispose() {
    for (const n of [this.inGain, this.out, this.dry, this.wet, this.conv, this.damp, this.hp]) {
      n.disconnect();
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Mono-to-stereo widener.
 *
 * The whole engine graph is mono, so mid/side width does nothing — there is no
 * side signal to raise. Width has to be *created*, by decorrelating a delayed
 * copy: L = direct + w·delayed, R = direct − w·delayed.
 *
 * The opposite polarity is the important part. Summed to mono the delayed
 * copies cancel exactly and you are left with the original signal, so this
 * cannot comb-filter a mono playback — which a plain Haas delay on one channel
 * very much can.
 */
export class Stereoizer {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.inGain = ctx.createGain();
    this.merger = ctx.createChannelMerger(2);
    this.out = ctx.createGain();

    this.delay = ctx.createDelay(0.08);
    this.delay.delayTime.value = 0.016;

    // Slight tilt on the delayed copy: real spatial difference is not just
    // time, and a little spectral difference decorrelates it further.
    this.tilt = ctx.createBiquadFilter();
    this.tilt.type = 'highshelf';
    this.tilt.frequency.value = 1800;
    this.tilt.gain.value = -3;

    this.plus = ctx.createGain();
    this.minus = ctx.createGain();
    this.plus.gain.value = 0;
    this.minus.gain.value = 0;

    // Direct signal to both channels.
    this.inGain.connect(this.merger, 0, 0);
    this.inGain.connect(this.merger, 0, 1);
    // Decorrelated copy, opposite polarity per channel.
    this.inGain.connect(this.delay);
    this.delay.connect(this.tilt);
    this.tilt.connect(this.plus);
    this.tilt.connect(this.minus);
    this.plus.connect(this.merger, 0, 0);
    this.minus.connect(this.merger, 0, 1);

    this.merger.connect(this.out);
    this.setWidth(fin(opts.width, 0.35));
  }

  get input() { return this.inGain; }
  get output() { return this.out; }

  /** @param {number} w 0 = mono, 1 = very wide */
  setWidth(w) {
    this._width = clamp(fin(w, 0), 0, 1);
    const now = this.ctx.currentTime;
    const g = this._width * 0.85;
    this.plus.gain.setTargetAtTime(g, now, 0.03);
    this.minus.gain.setTargetAtTime(-g, now, 0.03);
    // Wider settings want a longer delay to stay diffuse rather than phasey.
    this.delay.delayTime.setTargetAtTime(0.008 + 0.018 * this._width, now, 0.05);
    return this._width;
  }

  getWidth() { return this._width; }

  update() { /* nothing per-frame */ }

  dispose() {
    for (const n of [this.inGain, this.merger, this.out, this.delay,
                     this.tilt, this.plus, this.minus]) n.disconnect();
  }
}

// ---------------------------------------------------------------------------

/**
 * Three-band compressor — the "make it pleasant" stage.
 *
 * A single full-range compressor on an engine mix has one unavoidable failure:
 * the loudest thing in the signal is almost always low-frequency (a 150 Hz
 * exhaust bang carrying the +9 dB rumble shelf), so the low end decides the
 * gain reduction and everything else gets ducked with it. That is bug #17 in
 * the ledger — every pop punched a 15 dB hole in the mix — and backing the
 * threshold off to -5 dB / 2.2:1 only made it small enough to live with. It did
 * not fix the mechanism.
 *
 * Splitting first fixes the mechanism. A bang now ducks the band it is actually
 * in, and the engine note carries on in the other two.
 *
 * The split is Linkwitz-Riley 4th order: two cascaded Butterworth sections per
 * edge. Two properties matter and only LR gives both — the bands sum back to
 * FLAT magnitude (a Butterworth split has a +3 dB bump at the crossover), and
 * the branches stay in phase through the crossover so the sum does not notch.
 * Web Audio's lowpass/highpass Q is in DECIBELS, so Butterworth (linear Q
 * 0.7071) is Q = -3.01 dB, not 0.7 — getting this wrong puts a resonant bump at
 * every crossover.
 *
 *   in ─┬─[LP 240]²──────────────► low  comp ─┐
 *       ├─[HP 240]²─[LP 2000]²──► mid  comp ─┼─► out
 *       └─[HP 2000]²─────────────► high comp ─┘
 *
 * Why these three bands, and why they are set differently:
 *
 *   LOW  (< 240 Hz) is the chest and the body. Slow attack so a pulse keeps its
 *        leading edge, moderate ratio, long release — this is glue, and the one
 *        band where pumping would be heard as pumping.
 *   MID  (240 Hz - 2 kHz) is where the engine note actually lives, so it gets
 *        the gentlest treatment of the three. Touching this hard is what makes
 *        a compressed engine sound small.
 *   HIGH (> 2 kHz) is the harshness band, and it is the reason this class
 *        exists. Everything that stings lives here: residual comb peaks,
 *        valvetrain clatter, injector ticks, the turbo's edge band, the
 *        waveshaper's high-order products. It gets a low threshold, a high
 *        ratio and a 2 ms attack, so anything that spikes up there is caught
 *        before it can sting rather than being EQ'd away permanently. Loud
 *        stays bright; harsh gets held down.
 *
 * `amount` 0..1 scales how far each threshold drops below its resting point, so
 * the whole stage can be dialled back to nearly transparent without rebuilding.
 */
export class Dynamics {
  // Re-tuned after the offline render (test/render.mjs) showed the previous
  // high band — threshold -30 dB, 5:1, plus the browser's automatic makeup —
  // acting as a +13 dB treble boost on everything below threshold. It
  // roughly TRIPLED the A-weighted share of 1-5 kHz (boxer4 at high revs:
  // 16.5 % with the stage bypassed, 54.4 % with it on). That was the "high
  // pitched resonating" sound: every quiet comb peak, whine and hash in the
  // top band brought up to meet the engine note.
  //
  // Now every band is unity below its threshold (the implementation makeup is
  // divided back out, see compressorMakeupDb), and the bands only ever pull
  // DOWN. The high band is the gentlest of the three thresholds' ratios and
  // carries a slight cut, because nothing up there should be raised.
  static BANDS = [
    // f = upper edge of the band, Hz (the last band is open-ended).
    { name: 'low', f: 220, threshold: -16, ratio: 2.6, attack: 0.018, release: 0.26, knee: 10, makeup: 1.10 },
    // Mid makeup 1.06 → 2.12 (+6 dB). 220 Hz-2 kHz is where an engine's revs
    // are HEARD: with the old implicit makeup gone the engine measured 3-10 dB
    // quieter A-weighted than the original and read as muffled. Lifting this
    // band alone restores that loudness and puts the mids 1-8 dB further
    // forward than the original, while the treble band — where the whistling
    // resonances lived — stays as it is. (An exciter tried first added the
    // edge back as distortion, and was heard as crackle.)
    { name: 'mid', f: 2000, threshold: -18, ratio: 2.0, attack: 0.022, release: 0.20, knee: 14, makeup: 2.12 },
    { name: 'high', f: 0, threshold: -24, ratio: 3.0, attack: 0.003, release: 0.12, knee: 8, makeup: 0.90 },
  ];

  /** @param {object} [opts] { amount 0..1, makeup } */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this._amount = clamp(fin(opts.amount, 1), 0, 1);

    this.inGain = ctx.createGain();
    this.out = ctx.createGain();
    this.out.gain.value = clamp(fin(opts.makeup, 1), 0, 4);

    // Butterworth in Web Audio's dB convention. Two in series = Linkwitz-Riley.
    const BW_Q = -3.0103;
    const pole = (type, f) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = clamp(f, 20, 20000);
      b.Q.value = BW_Q;
      return b;
    };

    this.bands = [];
    const [LOW, MID] = Dynamics.BANDS;

    for (const spec of Dynamics.BANDS) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = spec.threshold;
      comp.ratio.value = spec.ratio;
      comp.attack.value = spec.attack;
      comp.release.value = spec.release;
      comp.knee.value = spec.knee;

      const makeup = ctx.createGain();
      makeup.gain.value = spec.makeup;

      const chain = [];
      if (spec.name === 'low') {
        chain.push(pole('lowpass', LOW.f), pole('lowpass', LOW.f));
      } else if (spec.name === 'mid') {
        chain.push(pole('highpass', LOW.f), pole('highpass', LOW.f),
                   pole('lowpass', MID.f), pole('lowpass', MID.f));
      } else {
        chain.push(pole('highpass', MID.f), pole('highpass', MID.f));
      }

      let node = this.inGain;
      for (const f of chain) { node.connect(f); node = f; }
      node.connect(comp);
      comp.connect(makeup);
      makeup.connect(this.out);

      this.bands.push({ spec, comp, makeup, chain });
    }

    this.setAmount(this._amount);
  }

  get input() { return this.inGain; }
  get output() { return this.out; }

  /**
   * 0 = effectively bypassed (thresholds parked at 0 dBFS), 1 = the tuned
   * defaults. Scales each band's threshold rather than its ratio, so the
   * character of each band is preserved as it is dialled back. The makeup
   * written is the intended makeup DIVIDED by what the implementation adds on
   * its own at that threshold, so a band below threshold is always unity.
   */
  setAmount(a) {
    this._amount = clamp(fin(a, 1), 0, 1);
    const now = fin(this.ctx.currentTime, 0);
    for (const b of this.bands) {
      const th = clamp(b.spec.threshold * this._amount, -100, 0);
      b.comp.threshold.setTargetAtTime(th, now, 0.05);
      const mk = 1 + (b.spec.makeup - 1) * this._amount;
      const auto = compressorMakeupDb(th, b.spec.ratio, b.spec.knee);
      b.makeup.gain.setTargetAtTime(mk * Math.pow(10, -auto / 20), now, 0.05);
    }
    return this._amount;
  }

  getAmount() { return this._amount; }

  /** Live gain reduction per band, dB. Diagnostics only. */
  getReduction() {
    const r = {};
    for (const b of this.bands) r[b.spec.name] = fin(b.comp.reduction, 0);
    return r;
  }

  update() { /* nothing per-frame */ }

  dispose() {
    for (const b of this.bands) {
      for (const f of b.chain) f.disconnect();
      b.comp.disconnect();
      b.makeup.disconnect();
    }
    this.inGain.disconnect();
    this.out.disconnect();
  }
}

/**
 * The gain, in dB, that a browser DynamicsCompressorNode adds ON ITS OWN.
 *
 * The Web Audio compressor (Chromium, Firefox and WebKit all share the same
 * kernel) applies automatic makeup: (1 / gain-at-0-dBFS)^0.6. It is not
 * exposed and cannot be turned off, so a compressor with a low threshold is
 * also a big fixed boost to anything quiet. Measured in Chromium against this
 * approximation:
 *
 *   threshold  ratio  knee   measured   this
 *      -30       5      6     +13.22   +12.96
 *      -20       3     12      +5.60    +5.60
 *      -24       4      0     +10.80   +10.80
 *     -1.5      20      0      +0.85    +0.86
 */
export function compressorMakeupDb(threshold, ratio, knee = 0) {
  const t = Math.min(0, fin(threshold, 0)) + Math.max(0, fin(knee, 0)) / 2;
  const r = Math.max(1, fin(ratio, 1));
  return Math.max(0, -0.6 * Math.min(0, t) * (1 - 1 / r));
}

/**
 * Final safety stage: a soft clipper that is perfectly linear up to 0.6 and
 * approaches ±0.99 asymptotically. A DynamicsCompressor is NOT a brickwall —
 * it has a fixed 6 ms look-ahead and a finite attack, and a bang landing on a
 * full-scale note overshoots it. Whatever gets past it lands here and rounds
 * off instead of flat-topping at the DAC, which is the click/crackle heard as
 * "peaking". Inaudible on anything that was not going to clip anyway.
 */
export class SafetyClipper {
  constructor(ctx) {
    this.ctx = ctx;
    this.pre = ctx.createGain();
    // The curve covers ±HEAD of input so nothing realistic reaches the
    // implementation's own hard clamp at the curve ends.
    const HEAD = 4;
    this.pre.gain.value = 1 / HEAD;
    this.shaper = ctx.createWaveShaper();
    const n = 8193, c = new Float32Array(n);
    const lin = 0.6, room = 0.99 - lin;
    for (let i = 0; i < n; i++) {
      const x = HEAD * ((i / (n - 1)) * 2 - 1);
      const a = Math.abs(x);
      const y = a <= lin ? a : lin + room * Math.tanh((a - lin) / room);
      c[i] = Math.sign(x) * y;
    }
    this.shaper.curve = c;
    this.shaper.oversample = '2x';
    this.pre.connect(this.shaper);
  }
  get input() { return this.pre; }
  get output() { return this.shaper; }
  dispose() { this.pre.disconnect(); this.shaper.disconnect(); }
}

// ---------------------------------------------------------------------------

/**
 * Psychoacoustic bass — the "missing fundamental".
 *
 * Most of what people listen to an engine on (a laptop, a phone, earbuds)
 * cannot move air below ~100 Hz, and an engine's identity lives at 30-120 Hz.
 * The ear does not need the fundamental to hear the pitch: given its 2nd, 3rd
 * and 4th harmonics it reconstructs it. This is the principle behind every
 * commercial bass enhancer (MaxxBass, Waves RBass, the "virtual bass" in a
 * phone's DSP).
 *
 *   in ─► LP 140 (LR4) ─► drive ─► asymmetric shaper ─► HP 90 ─► LP 420 ─► amount ─► out
 *
 * The shaper is a soft asymmetric curve (even AND odd harmonics), the
 * band-pass keeps only the harmonics a small driver CAN play, and nothing of
 * it reaches the 1-5 kHz band. Fed from the mix bus after the infrasonic
 * guard, summed back in ahead of the tone stage, and scaled by `tone.punch`.
 */
export class BassEnhancer {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    const BW_Q = -3.0103;
    const mk = (type, f, q) => {
      const b = ctx.createBiquadFilter();
      b.type = type; b.frequency.value = f; b.Q.value = q; return b;
    };
    this.inGain = ctx.createGain();
    this.lp1 = mk('lowpass', 140, BW_Q);
    this.lp2 = mk('lowpass', 140, BW_Q);
    this.drive = ctx.createGain();
    this.drive.gain.value = 2.2;
    this.span = ctx.createGain();
    this.span.gain.value = 1 / 4;
    this.shaper = ctx.createWaveShaper();
    const n = 4097, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = 4 * ((i / (n - 1)) * 2 - 1);
      const t = Math.tanh(x);
      c[i] = t + 0.45 * t * t;               // even + odd harmonics
    }
    this.shaper.curve = c;
    this.shaper.oversample = '2x';
    this.hp = mk('highpass', 90, 0.7);
    this.lp3 = mk('lowpass', 420, 0.6);
    this.amount = ctx.createGain();
    this.amount.gain.value = clamp(fin(opts.amount, 0.15), 0, 2);
    this.inGain.connect(this.lp1); this.lp1.connect(this.lp2);
    this.lp2.connect(this.drive); this.drive.connect(this.span);
    this.span.connect(this.shaper); this.shaper.connect(this.hp);
    this.hp.connect(this.lp3); this.lp3.connect(this.amount);
  }
  get input() { return this.inGain; }
  get output() { return this.amount; }
  setAmount(v) {
    this.amount.gain.setTargetAtTime(clamp(fin(v, 0), 0, 2), this.ctx.currentTime, 0.05);
  }
  dispose() {
    for (const n of [this.inGain, this.lp1, this.lp2, this.drive, this.span,
                     this.shaper, this.hp, this.lp3, this.amount]) n.disconnect();
  }
}

/**
 * Space — the environment the car is in, as a live input.
 *
 * The convolution reverb is a fixed room (resizing it rebuilds an impulse
 * response, never per frame). A tunnel, an underpass or a car park is a
 * different thing: strong, discrete, closely spaced reflections that FLUTTER,
 * because the walls are parallel and hard. That is two short feedback delays
 * with a darkening filter in the loop, mixed in by `environment`.
 *
 *   in ──────────────────────────────────────────► out
 *    └─►(+)─► delay A (37 ms) ─► LP ─┬─► wet ─────►
 *        ▲                           └─► fb ─┐
 *        └───────────────────────────────────┘     (and the same with B, 61 ms)
 *
 * Both loops clear the 128-sample in-cycle delay floor by a wide margin.
 */
export class Space {
  constructor(ctx) {
    this.ctx = ctx;
    this.inGain = ctx.createGain();
    this.out = ctx.createGain();
    this.inGain.connect(this.out);
    this.loops = [0.037, 0.061].map((t, i) => {
      const sum = ctx.createGain();
      const d = ctx.createDelay(0.2);
      d.delayTime.value = t;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = i ? 1900 : 2600; lp.Q.value = 0.5;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 70; hp.Q.value = 0.5;
      const fb = ctx.createGain(); fb.gain.value = 0;
      const wet = ctx.createGain(); wet.gain.value = 0;
      this.inGain.connect(sum); sum.connect(d); d.connect(lp); lp.connect(hp);
      hp.connect(fb); fb.connect(sum); hp.connect(wet); wet.connect(this.out);
      return { sum, d, lp, hp, fb, wet };
    });
    this._env = -1;
  }
  get input() { return this.inGain; }
  get output() { return this.out; }
  /** 0 = open road, 1 = tunnel. */
  setEnvironment(e) {
    e = clamp(fin(e, 0), 0, 1);
    if (Math.abs(e - this._env) < 1e-3) return;
    this._env = e;
    const now = this.ctx.currentTime;
    this.loops.forEach((l, i) => {
      l.fb.gain.setTargetAtTime(0.52 * e, now, 0.08);
      l.wet.gain.setTargetAtTime((i ? 0.30 : 0.38) * e, now, 0.08);
    });
  }
  dispose() {
    this.inGain.disconnect(); this.out.disconnect();
    for (const l of this.loops) for (const n of Object.values(l)) n.disconnect();
  }
}
