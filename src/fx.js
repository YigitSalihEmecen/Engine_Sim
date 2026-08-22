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
    const now = this.ctx.currentTime;
    // Equal-power so total loudness stays put as it is swept.
    this.dry.gain.setTargetAtTime(Math.cos(this._mix * Math.PI / 2), now, 0.03);
    this.wet.gain.setTargetAtTime(Math.sin(this._mix * Math.PI / 2) * 1.4, now, 0.03);
    return this._mix;
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
  static BANDS = [
    // f = upper edge of the band, Hz (the last band is open-ended).
    { name: 'low', f: 240, threshold: -20, ratio: 3.0, attack: 0.014, release: 0.24, knee: 12, makeup: 1.30 },
    { name: 'mid', f: 2000, threshold: -22, ratio: 2.4, attack: 0.020, release: 0.18, knee: 16, makeup: 1.24 },
    { name: 'high', f: 0, threshold: -30, ratio: 5.0, attack: 0.002, release: 0.09, knee: 6, makeup: 1.55 },
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

      // Build the filter chain that isolates this band.
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
   * 0 = effectively bypassed (thresholds parked above the signal), 1 = the
   * tuned defaults. Scales each band's threshold rather than its ratio, so the
   * character of each band is preserved as it is dialled back.
   */
  setAmount(a) {
    this._amount = clamp(fin(a, 1), 0, 1);
    const now = fin(this.ctx.currentTime, 0);
    for (const b of this.bands) {
      const th = clamp(b.spec.threshold * this._amount, -100, 0);
      b.comp.threshold.setTargetAtTime(th, now, 0.05);
      // Makeup has to come back with the threshold or dialling the stage down
      // would read as a volume change instead of a dynamics change.
      const mk = 1 + (b.spec.makeup - 1) * this._amount;
      b.makeup.gain.setTargetAtTime(mk, now, 0.05);
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
