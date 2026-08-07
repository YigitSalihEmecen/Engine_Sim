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
