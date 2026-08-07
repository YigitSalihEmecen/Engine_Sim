/**
 * squeal.js — procedural tire squeal / screech audio node.
 *
 * Synthesizes tire friction noise on hard cornering or braking using bandpass-filtered
 * white noise with dynamic frequency scaling. Conforms to src/CONTRACT.md.
 */

export class TireSqueal {
  constructor(ctx) {
    this.ctx = ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 0;

    // Create 2-second looped white noise buffer
    const bufLen = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    this.noise = ctx.createBufferSource();
    this.noise.buffer = buf;
    this.noise.loop = true;

    // Dual bandpass filters tuned to characteristic tire friction resonance frequencies
    this.bp1 = ctx.createBiquadFilter();
    this.bp1.type = 'bandpass';
    this.bp1.frequency.value = 1450;
    this.bp1.Q.value = 3.8;

    this.bp2 = ctx.createBiquadFilter();
    this.bp2.type = 'bandpass';
    this.bp2.frequency.value = 2850;
    this.bp2.Q.value = 4.5;

    this.gain1 = ctx.createGain();
    this.gain1.gain.value = 0.5;

    this.gain2 = ctx.createGain();
    this.gain2.gain.value = 0.5;

    // Wire graph: noise -> bp1 -> gain1 -> output
    //                   -> bp2 -> gain2 -> output
    this.noise.connect(this.bp1);
    this.bp1.connect(this.gain1);
    this.gain1.connect(this.output);

    this.noise.connect(this.bp2);
    this.bp2.connect(this.gain2);
    this.gain2.connect(this.output);

    this.started = false;
  }

  start(t = 0) {
    if (this.started) return;
    this.noise.start(t);
    this.started = true;
  }

  /**
   * @param {number} now ctx.currentTime
   * @param {number} slip intensity 0..1 (from lateral G / tire slip)
   * @param {number} speedNorm normalized speed 0..1
   */
  update(now, slip, speedNorm = 0.5) {
    const tc = 0.03;
    const targetGain = Math.pow(Math.max(0, Math.min(1, slip)), 1.5) * 0.45;
    this.output.gain.setTargetAtTime(targetGain, now, tc);

    const f1 = 1200 + slip * 800 + speedNorm * 600;
    const f2 = 2400 + slip * 1100 + speedNorm * 800;

    this.bp1.frequency.setTargetAtTime(Math.min(18000, f1), now, tc);
    this.bp2.frequency.setTargetAtTime(Math.min(18000, f2), now, tc);
  }

  dispose() {
    try {
      this.noise.stop();
      this.noise.disconnect();
    } catch (_) {}
  }
}
