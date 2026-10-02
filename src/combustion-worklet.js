/**
 * combustion-worklet.js — the engine's source, one combustion event at a time.
 *
 * Runs on the audio thread (AudioWorkletProcessor 'engine-combustion').
 *
 * The wavetable source (pulse.js) builds ONE 720° cycle per bank and repeats
 * it forever: every cycle identical to the sample. A real engine never does
 * that. Peak cylinder pressure varies cycle to cycle (COV of IMEP ≈ 1-3 % at
 * full load, 5-15 % at idle and on a lumpy cam), ignition timing wanders by a
 * degree or so, and a cylinder occasionally burns badly or not at all. That
 * variation is not noise laid on top of the engine — it is energy spread into
 * sidebands AROUND the engine's own harmonics, tied to its firing, and it is
 * most of what makes a recording sound like a machine instead of an organ.
 * The old graph faked it with slow LFO vibrato on the whole engine and with
 * noise beds; this generates it where it happens.
 *
 * Per sample: the crank phase advances by f0 / sampleRate (f0 = one 720°
 * cycle per second). When it passes a cylinder's firing angle (+ that
 * cylinder's fixed trim + this event's jitter), a pressure pulse starts on that
 * cylinder's bank output:
 *
 *     p(t) = A · g(t) · (1 − e^(−a·t)) · e^(−b·t)      t in cycles since firing
 *
 * with the same attack/decay law as pulse.js (load hardens it continuously
 * instead of crossfading two tables), A carrying the cylinder's trim and this
 * cycle's variation, and g(t) a ~60 µs Gaussian onset so the gradient has no
 * step to alias. The output is the pressure GRADIENT (what an open pipe
 * radiates), per unit of crank phase so it is rpm-independent, through a
 * one-pole lowpass at RADIATION_KNEE half-orders — the time-domain version of
 * pulse.js's radiation shelf — and scaled by a calibration gain computed on the
 * main thread from the same shape (`combustionGains` in pulse.js).
 *
 * Outputs: one per exhaust bank, then the intake (all cylinders, 360° earlier).
 *
 * AudioParams (k-rate): f0, load, amp, rough (0..1 misfires + extra variation).
 */

const KNEE_HALF_ORDERS = 48;          // = RADIATION_KNEE_ORDER (24) × 2
const ONSET_S = 60e-6;                // Gaussian onset time constant

class CombustionProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'f0', defaultValue: 10, minValue: 0, maxValue: 4000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'amp', defaultValue: 0, minValue: 0, maxValue: 8, automationRate: 'k-rate' },
      { name: 'rough', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const o = options.processorOptions;
    // events: [{ out, angle (cycles 0..1), ampTrim, decayTrim }] sorted by angle
    this.events = o.events;
    this.nOut = o.outputs;
    this.attack = o.attack;
    this.decay = o.decay;
    this.hardness = o.hardness;          // normalised (1 = the 0.65 reference)
    this.ccv = o.ccv;                    // cycle-to-cycle amplitude COV at full load
    this.jitterCycles = o.jitterDeg / 720;
    this.gains = o.gains;                // [out][5] calibration over load 0..1
    this.abs = 0;                        // crank position, in cycles, absolute
    this.pulses = [];                    // active pulses
    this.pool = [];
    this.prevP = new Float64Array(this.nOut);
    this.lp = new Float64Array(this.nOut);
    // Each event's next firing, in absolute cycles: its cycle index + angle +
    // this cycle's jitter. Advancing the index by exactly one per firing means
    // jitter can never fire an event twice, or skip one.
    this.cycleOf = new Float64Array(this.events.length);
    this.nextAt = Float64Array.from(this.events, (e) => e.angle);
    this.seed = (o.seed >>> 0) || 1;
    this.alive = true;
    this.port.onmessage = (m) => { if (m.data === 'stop') this.alive = false; };
  }

  rand() {
    let s = this.seed;
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    this.seed = s;
    return s / 4294967296;
  }

  gauss() {
    // Irwin-Hall approximation: cheap, bounded (±3σ), good enough for COV.
    return (this.rand() + this.rand() + this.rand() + this.rand() - 2) * 1.732;
  }

  /** Schedule event k's next firing: one cycle on, with fresh jitter. */
  _schedule(k, load, rough) {
    const e = this.events[k];
    const spread = this.jitterCycles * (0.6 + 1.4 * (1 - load)) * (1 + 2 * rough);
    this.cycleOf[k] += 1;
    this.nextAt[k] = this.cycleOf[k] + e.angle + Math.max(-0.02, Math.min(0.02, this.gauss() * spread));
  }

  _fire(e, load, rough) {
    // Cycle-to-cycle variation: larger at light load (poorer, slower burns)
    // and with `rough`; occasional misfire — the cylinder still pumps air, so
    // a faint pulse, not silence.
    const cov = this.ccv * (0.7 + 2.3 * (1 - load) * (1 - load)) * (1 + 2.5 * rough);
    let A = e.ampTrim * Math.max(0.15, 1 + this.gauss() * cov);
    if (rough > 0 && this.rand() < 0.06 * rough * rough) A *= 0.12;
    const h = this.hardness * load;
    const a = this.attack * (0.55 + 0.85 * h);
    const b = this.decay * (1.25 - 0.35 * h) * e.decayTrim * (1 + 0.5 * cov * this.gauss());
    const p = this.pool.pop() || {};
    p.out = e.out; p.A = A; p.a = a; p.b = b; p.t = 0; p.ts = 0;
    this.pulses.push(p);
  }

  process(inputs, outputs, params) {
    const out = outputs;
    const n = out[0][0].length;
    const f0 = params.f0[0];
    const load = Math.min(1, Math.max(0, params.load[0]));
    const amp = params.amp[0];
    const rough = params.rough[0];
    const sr = sampleRate;
    const dph = f0 / sr;                       // crank cycles per sample
    const dts = 1 / sr;
    const ev = this.events, nEv = ev.length;
    // Calibration gain per output at this load (linear between 5 points).
    const gi = load * 4, g0 = Math.min(3, Math.floor(gi)), gf = gi - g0;
    // One-pole lowpass at KNEE half-orders of f0 (the radiation knee).
    const fc = Math.min(KNEE_HALF_ORDERS * f0, 0.45 * sr);
    const lpk = 1 - Math.exp(-2 * Math.PI * fc / sr);
    const inv = dph > 1e-9 ? 1 / dph : 0;

    for (let o = 0; o < this.nOut; o++) out[o][0].fill(0);
    const acc = this._acc || (this._acc = new Float64Array(this.nOut));

    for (let i = 0; i < n; i++) {
      // Advance the crank; fire every event whose (jittered) time has come.
      this.abs += dph;
      const abs = this.abs;
      for (let k = 0; k < nEv; k++) {
        if (abs >= this.nextAt[k]) {
          this._fire(ev[k], load, rough);
          // Sub-sample start: how far past its firing this sample already is.
          const past = Math.min(1, abs - this.nextAt[k]);
          const last = this.pulses[this.pulses.length - 1];
          last.t = past; last.ts = f0 > 0 ? past / f0 : 0;
          this._schedule(k, load, rough);
          // Far behind (e.g. f0 jumped from 0): catch the schedule up silently.
          while (this.nextAt[k] < abs) this._schedule(k, load, rough);
        }
      }
      // Sum the live pulses' pressure per output.
      acc.fill(0);
      for (let j = this.pulses.length - 1; j >= 0; j--) {
        const p = this.pulses[j];
        if (p.t > 1 || p.b * p.t > 9) {           // spent (or past one cycle)
          this.pulses[j] = this.pulses[this.pulses.length - 1];
          this.pulses.pop();
          this.pool.push(p);
          continue;
        }
        const on = 1 - Math.exp(-(p.ts * p.ts) / (ONSET_S * ONSET_S));
        acc[p.out] += p.A * on * (1 - Math.exp(-p.a * p.t)) * Math.exp(-p.b * p.t);
        p.t += dph; p.ts += dts;
      }
      for (let o = 0; o < this.nOut; o++) {
        const grad = (acc[o] - this.prevP[o]) * inv;      // dp / d(phase)
        this.prevP[o] = acc[o];
        this.lp[o] += lpk * (grad - this.lp[o]);
        const G = this.gains[o];
        const gain = G[g0] + (G[g0 + 1] - G[g0]) * gf;
        out[o][0][i] = this.lp[o] * gain * amp;
      }
    }
    return this.alive;
  }
}

registerProcessor('engine-combustion', CombustionProcessor);
