/**
 * engine-sim.js — Procedural engine sound + vehicle drivetrain simulator.
 *
 * Zero dependencies. Pure Web Audio API + ES6.
 *
 * Audio graph (per instance):
 *
 *   [order oscillators] --gain--\
 *                                +--> oscBus --> formant(peaking) --> body(lowpass)
 *   [pulse osc] --depth--\       /                                          |
 *                         \     /                                           v
 *   [white noise] --> intakeBP --> intakeGain ------------------------> voiceGain
 *   [brown noise] --> rumbleLP --> rumbleGain -----------------------> voiceGain
 *                 \-> popBP    --> popGain (scheduled envelopes) ----> voiceGain
 *                                                                          |
 *                                                       voiceGain --> comp --> master --> destination
 *
 * Every oscillator is tuned to an *engine order*: a multiple of crank rotation
 * frequency f0 = rpm / 60. A 4-stroke fires cylinders/2 times per revolution,
 * so an I4's dominant order is 2, a V6's is 3, a V8's is 4. A cross-plane V8
 * additionally carries strong *half* orders (0.5 / 1.5 / 2.5) because its two
 * banks fire unevenly — that is exactly the American V8 burble.
 */

// ---------------------------------------------------------------------------
// Engine voice profiles
// ---------------------------------------------------------------------------

const PROFILES = {
  i4: {
    label: 'Inline-4',
    cylinders: 4,
    fireOrder: 2,          // combustion events per crank revolution
    pulseOrder: 2,
    // order: multiple of crank frequency. gain: relative level.
    // rpmTilt: >0 means the layer gets louder with rpm, <0 quieter.
    partials: [
      { order: 1,  type: 'triangle',  gain: 0.22, detune: -6, rpmTilt: -0.3 },
      { order: 2,  type: 'sawtooth',  gain: 1.00, detune: 0,  rpmTilt: 0.0 },
      { order: 2,  type: 'square',    gain: 0.30, detune: 9,  rpmTilt: 0.35 },
      { order: 4,  type: 'sawtooth',  gain: 0.45, detune: -5, rpmTilt: 0.30 },
      { order: 6,  type: 'square',    gain: 0.14, detune: 7,  rpmTilt: 0.45 },
    ],
    formant: { freq: 520, q: 0.9, gain: 6 },
    bodyBase: 300, bodyPerF0: 11, bodyLoad: 3000, bodyRpm: 1800,
    resonance: [0.8, 4.5],  // Q at zero load .. full load
    intake: { base: 0.05, load: 0.30, freq: 850, freqPerF0: 4.2, q: 1.1, pulse: 0.22 },
    rumble: { base: 0.10, load: 0.16, freq: 190 },
    burble: 0.0,
    pop: { level: 0.35, rate: 14, lo: 220, hi: 620 },
    gain: 0.85,
  },

  v6: {
    label: 'V6 / Inline-6',
    cylinders: 6,
    fireOrder: 3,
    pulseOrder: 3,
    partials: [
      { order: 1.5, type: 'triangle', gain: 0.16, detune: -4, rpmTilt: -0.25 },
      { order: 3,   type: 'sawtooth', gain: 1.00, detune: 0,  rpmTilt: 0.0 },
      { order: 3,   type: 'triangle', gain: 0.42, detune: 7,  rpmTilt: -0.1 },
      { order: 6,   type: 'sawtooth', gain: 0.38, detune: -6, rpmTilt: 0.30 },
      { order: 9,   type: 'triangle', gain: 0.18, detune: 5,  rpmTilt: 0.40 },
    ],
    formant: { freq: 360, q: 0.8, gain: 5 },
    bodyBase: 260, bodyPerF0: 9, bodyLoad: 2600, bodyRpm: 1500,
    resonance: [0.7, 3.4],
    intake: { base: 0.06, load: 0.32, freq: 700, freqPerF0: 3.6, q: 0.9, pulse: 0.16 },
    rumble: { base: 0.13, load: 0.18, freq: 165 },
    burble: 0.0,
    pop: { level: 0.30, rate: 12, lo: 180, hi: 520 },
    gain: 0.9,
  },

  v8: {
    label: 'Cross-plane V8',
    cylinders: 8,
    fireOrder: 4,
    pulseOrder: 2,          // per-bank cadence, gives the lopey chop
    partials: [
      { order: 0.5, type: 'triangle', gain: 0.30, detune: 0,  rpmTilt: -0.55, burble: 1 },
      { order: 1.5, type: 'sawtooth', gain: 0.26, detune: -8, rpmTilt: -0.45, burble: 1 },
      { order: 2.5, type: 'square',   gain: 0.14, detune: 6,  rpmTilt: -0.35, burble: 1 },
      { order: 2,   type: 'sawtooth', gain: 0.70, detune: 0,  rpmTilt: -0.1 },
      { order: 4,   type: 'sawtooth', gain: 1.00, detune: 5,  rpmTilt: 0.05 },
      { order: 8,   type: 'square',   gain: 0.20, detune: -7, rpmTilt: 0.45 },
    ],
    formant: { freq: 155, q: 0.7, gain: 8 },
    bodyBase: 190, bodyPerF0: 7, bodyLoad: 2200, bodyRpm: 1200,
    resonance: [1.0, 5.0],
    intake: { base: 0.05, load: 0.26, freq: 520, freqPerF0: 3.0, q: 0.8, pulse: 0.30 },
    rumble: { base: 0.22, load: 0.22, freq: 130 },
    burble: 1.0,
    pop: { level: 0.55, rate: 17, lo: 130, hi: 420 },
    gain: 1.0,
  },
};

// ---------------------------------------------------------------------------
// Vehicle defaults
// ---------------------------------------------------------------------------

const VEHICLE_DEFAULTS = {
  idleRpm: 800,
  redlineRpm: 7000,
  peakTorqueRpm: 3800,
  peakTorque: 340,          // N·m at 100% throttle, overridden per engine type
  engineInertia: 0.30,      // kg·m² (crank + flywheel), governs free-rev rate
  clutchFlareRpm: 2400,     // extra rpm the engine carries while the clutch slips
  mass: 1450,               // kg
  wheelRadius: 0.32,        // m
  finalDrive: 3.9,
  gearRatios: [3.545, 2.045, 1.386, 1.000, 0.816, 0.673],
  driveEfficiency: 0.9,
  dragArea: 0.72,           // Cd * A  (m²)
  rollingResistance: 0.014,
  brakeForce: 9000,         // N at full brake
  shiftTimeMs: 95,          // clutch-out window, 50–150 ms is realistic
  autoShiftUpRpm: 6550,
  autoShiftDownRpm: 2100,
  revMatch: true,
};

const TORQUE_PER_TYPE = { i4: 240, v6: 330, v8: 490 };

const RHO_AIR = 1.225;
const G = 9.81;
const RPM_PER_RADS = 60 / (2 * Math.PI);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// EngineSim
// ---------------------------------------------------------------------------

export class EngineSim {
  /**
   * @param {AudioContext} [audioContext] Optional shared context. One is created
   *        lazily if omitted. Must be resumed from a user gesture (see start()).
   * @param {object} [options] Vehicle overrides, plus { engineType, volume }.
   */
  constructor(audioContext = null, options = {}) {
    this.ctx = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    this.owned = !audioContext;

    const { engineType = 'v8', volume = 0.7, ...vehicle } = options;
    this.cfg = { ...VEHICLE_DEFAULTS, ...vehicle };

    // --- physics state -----------------------------------------------------
    this.rpm = this.cfg.idleRpm;
    this.speed = 0;            // m/s
    this.gear = 1;             // 0 = neutral
    this.throttle = 0;         // raw input 0..1
    this.brake = 0;            // 0..1
    this.load = 0;             // smoothed audible load 0..1
    this.running = false;
    this.autoShift = true;

    this._shifting = false;
    this._shiftTimer = 0;
    this._shiftFrom = 1;
    this._shiftTo = 1;
    this._revMatchTarget = 0;
    this._blip = 0;            // 0..1 rev-match blip envelope
    this._limiterCut = 0;      // seconds of fuel cut remaining
    this._prevThrottle = 0;
    this._nextPopTime = 0;
    this._popping = false;
    this._shiftBumpQueued = false;
    this._duck = 0;            // transient level duck, e.g. across a voice swap
    this._clutchLocked = false;

    // --- audio graph -------------------------------------------------------
    this.type = engineType in PROFILES ? engineType : 'v8';
    this.profile = PROFILES[this.type];
    if (!('peakTorque' in vehicle)) this.cfg.peakTorque = TORQUE_PER_TYPE[this.type];

    this._buildGraph();
    this.setVolume(volume);
    this._buildOscBank();
    this._writeAudioParams(0, true);
  }

  // =========================================================================
  // Audio graph construction
  // =========================================================================

  _buildGraph() {
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;               // faded in by start()

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 5;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.18;

    this.voice = ctx.createGain();            // per-frame loudness envelope
    this.voice.gain.value = 0.2;

    this.comp.connect(this.master);
    this.master.connect(ctx.destination);
    this.voice.connect(this.comp);

    // --- tonal path: oscillators -> formant -> body lowpass -> voice -------
    this.body = ctx.createBiquadFilter();
    this.body.type = 'lowpass';
    this.body.frequency.value = 400;
    this.body.Q.value = 1;

    this.formant = ctx.createBiquadFilter();
    this.formant.type = 'peaking';
    this.formant.frequency.value = this.profile.formant.freq;
    this.formant.Q.value = this.profile.formant.q;
    this.formant.gain.value = this.profile.formant.gain;

    this.oscBus = ctx.createGain();
    this.oscBus.gain.value = 0.5;

    this.oscBus.connect(this.formant);
    this.formant.connect(this.body);
    this.body.connect(this.voice);

    // --- noise sources -----------------------------------------------------
    this.whiteBuf = this._makeNoiseBuffer(2, false);
    this.brownBuf = this._makeNoiseBuffer(2, true);

    // Intake / induction roar: band-passed white noise, amplitude-chopped by
    // a pulse oscillator locked to the firing rate.
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.frequency.value = 800;
    this.intakeFilter.Q.value = 1;

    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0.05;

    this.intakeFilter.connect(this.intakeGain);
    this.intakeGain.connect(this.voice);

    // Exhaust rumble: heavily low-passed brown noise.
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 160;
    this.rumbleFilter.Q.value = 1.2;

    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0.1;

    this.rumbleFilter.connect(this.rumbleGain);
    this.rumbleGain.connect(this.voice);

    // Overrun pops / shift bumps: resonant band-pass, driven by scheduled
    // gain envelopes so no node allocation happens per event.
    this.popFilter = ctx.createBiquadFilter();
    this.popFilter.type = 'bandpass';
    this.popFilter.frequency.value = 250;
    this.popFilter.Q.value = 4;

    this.popGain = ctx.createGain();
    this.popGain.gain.value = 0;

    this.popFilter.connect(this.popGain);
    this.popGain.connect(this.comp);         // bypass voice envelope

    this.whiteSrc = null;
    this.brownSrc = null;
    this.pulseOsc = null;
    this.pulseDepth = null;
    this.oscNodes = [];
  }

  _makeNoiseBuffer(seconds, brown) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else {
        d[i] = w;
      }
    }
    // Cross-fade the seam so the loop point is inaudible.
    const fade = Math.min(1024, len >> 2);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[i] = d[i] * t + d[len - fade + i] * (1 - t);
    }
    return buf;
  }

  _startNoise() {
    const ctx = this.ctx;
    this.whiteSrc = ctx.createBufferSource();
    this.whiteSrc.buffer = this.whiteBuf;
    this.whiteSrc.loop = true;
    this.whiteSrc.connect(this.intakeFilter);
    this.whiteSrc.start();

    this.brownSrc = ctx.createBufferSource();
    this.brownSrc.buffer = this.brownBuf;
    this.brownSrc.loop = true;
    this.brownSrc.connect(this.rumbleFilter);
    this.brownSrc.connect(this.popFilter);
    this.brownSrc.start();
  }

  /** (Re)create the oscillator bank for the current profile. */
  _buildOscBank() {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    for (const n of this.oscNodes) {
      try { n.osc.stop(now + 0.02); } catch (e) { /* already stopped */ }
      n.gain.gain.cancelScheduledValues(now);
      n.gain.gain.setTargetAtTime(0, now, 0.008);
    }
    this.oscNodes = [];

    if (this.pulseOsc) {
      try { this.pulseOsc.stop(now + 0.02); } catch (e) { /* noop */ }
      this.pulseOsc = null;
    }

    for (const p of this.profile.partials) {
      const osc = ctx.createOscillator();
      osc.type = p.type;
      osc.detune.value = p.detune || 0;
      osc.frequency.value = clamp((this.rpm / 60) * p.order, 0.01, 20000);

      const gain = ctx.createGain();
      gain.gain.value = 0;

      osc.connect(gain);
      gain.connect(this.oscBus);
      if (this.running) osc.start();

      this.oscNodes.push({ osc, gain, spec: p });
    }

    // Firing-rate pulse train modulating the intake noise amplitude.
    this.pulseOsc = ctx.createOscillator();
    this.pulseOsc.type = 'sawtooth';
    this.pulseOsc.frequency.value = clamp((this.rpm / 60) * this.profile.pulseOrder, 0.01, 20000);

    if (!this.pulseDepth) {
      this.pulseDepth = ctx.createGain();
      this.pulseDepth.gain.value = 0;
      this.pulseDepth.connect(this.intakeGain.gain);
    }
    this.pulseOsc.connect(this.pulseDepth);
    if (this.running) this.pulseOsc.start();

    // Body/formant retune for the new profile.
    const f = this.profile.formant;
    this.formant.frequency.setTargetAtTime(f.freq, now, 0.05);
    this.formant.Q.setTargetAtTime(f.q, now, 0.05);
    this.formant.gain.setTargetAtTime(f.gain, now, 0.05);
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** Resume the AudioContext and fade the engine in. Call from a user gesture. */
  async start() {
    if (this.running) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.running = true;
    this._startNoise();
    for (const n of this.oscNodes) { try { n.osc.start(); } catch (e) { /* noop */ } }
    try { this.pulseOsc.start(); } catch (e) { /* noop */ }

    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(0.0001, now);
    this.master.gain.linearRampToValueAtTime(this._volume, now + 0.25);
    this._nextPopTime = now;
  }

  /** Fade out and tear down the sound sources. Physics state is preserved. */
  stop() {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0.0001, now + 0.2);

    const at = now + 0.25;
    for (const n of this.oscNodes) { try { n.osc.stop(at); } catch (e) { /* noop */ } }
    try { this.pulseOsc.stop(at); } catch (e) { /* noop */ }
    try { this.whiteSrc.stop(at); } catch (e) { /* noop */ }
    try { this.brownSrc.stop(at); } catch (e) { /* noop */ }

    // Hand the retiring nodes off before rebuilding, otherwise _buildOscBank
    // would re-issue stop() on them and cut the fade-out short.
    this.oscNodes = [];
    this.pulseOsc = null;
    this.running = false;
    this._buildOscBank();   // fresh, unstarted nodes ready for the next start()
  }

  /** @param {'i4'|'v6'|'v8'} type */
  setEngineType(type) {
    if (!(type in PROFILES) || type === this.type) return;
    this.type = type;
    this.profile = PROFILES[type];
    this.cfg.peakTorque = TORQUE_PER_TYPE[type];

    this._duck = 1;              // duck across the swap, recovers over ~150 ms
    this._buildOscBank();
    this._writeAudioParams(0, true);
  }

  /** @param {number} value 0.0 – 1.0 */
  setThrottle(value) {
    this.throttle = clamp(Number(value) || 0, 0, 1);
  }

  /** @param {number} value 0.0 – 1.0 */
  setBrake(value) {
    this.brake = clamp(Number(value) || 0, 0, 1);
  }

  setVolume(v) {
    this._volume = clamp(Number(v) || 0, 0, 1);
    if (this.running) {
      this.master.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.05);
    }
  }

  setAutoShift(on) { this.autoShift = !!on; }

  shiftUp() {
    if (this._shifting || this.gear >= this.cfg.gearRatios.length) return false;
    return this._beginShift(this.gear + 1);
  }

  /** Refused (returns false) if the lower gear would bounce the engine off the limiter. */
  shiftDown() {
    if (this._shifting || this.gear <= 1) return false;
    if (this._wouldOverRev(this.gear - 1)) return false;
    return this._beginShift(this.gear - 1);
  }

  /** @param {number} n 0 = neutral, 1..N = gear */
  setGear(n) {
    n = Math.round(n);
    if (n < 0 || n > this.cfg.gearRatios.length || n === this.gear || this._shifting) return false;
    if (this._wouldOverRev(n)) return false;
    return this._beginShift(n);
  }

  /**
   * Advance physics and push new audio parameters.
   * @param {number} deltaTime seconds since the previous update.
   */
  update(deltaTime) {
    let dt = Number(deltaTime) || 0;
    if (dt <= 0) return;
    dt = Math.min(dt, 0.1);            // survive tab-switch spikes

    // Fixed sub-stepping keeps the stiff drivetrain terms stable.
    const steps = Math.max(1, Math.ceil(dt / 0.005));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this._stepPhysics(h);

    this._writeAudioParams(dt, false);
  }

  getState() {
    return {
      rpm: this.rpm,
      speed: this.speed,
      speedKmh: this.speed * 3.6,
      gear: this.gear,
      throttle: this.throttle,
      brake: this.brake,
      load: this.load,
      shifting: this._shifting,
      limiter: this._limiterCut > 0,
      engineType: this.type,
      engineLabel: this.profile.label,
      gearCount: this.cfg.gearRatios.length,
      redline: this.cfg.redlineRpm,
      idle: this.cfg.idleRpm,
    };
  }

  /** Release the audio graph. Only closes the context if this instance made it. */
  dispose() {
    this.stop();
    if (this.owned) setTimeout(() => this.ctx.close(), 400);
  }

  // =========================================================================
  // Physics
  // =========================================================================

  _totalRatio(gear) {
    if (gear <= 0) return 0;
    return this.cfg.gearRatios[gear - 1] * this.cfg.finalDrive;
  }

  /** Road speed (m/s) -> engine rpm for a given gear. */
  _speedToRpm(speed, gear) {
    if (gear <= 0) return 0;
    return (speed / this.cfg.wheelRadius) * this._totalRatio(gear) * RPM_PER_RADS;
  }

  /** Normalised torque shape, peaking at cfg.peakTorqueRpm. */
  _torqueFactor(rpm) {
    const k = (rpm - this.cfg.peakTorqueRpm) / (this.cfg.redlineRpm * 0.75);
    return clamp(1 - 0.85 * k * k, 0.3, 1);
  }

  /**
   * Internal friction + pumping losses, i.e. engine braking. N·m.
   * The quadratic term dominates up top — that is what makes a high-revving
   * engine drop back to idle in about a second when you lift in neutral.
   */
  _frictionTorque(rpm, throttle) {
    return (18 + 0.012 * rpm + 2.2e-6 * rpm * rpm) * (1 - 0.62 * throttle);
  }

  /** Would engaging this gear at the current road speed over-rev the engine? */
  _wouldOverRev(gear) {
    if (gear <= 0) return false;
    return this._speedToRpm(this.speed, gear) > this.cfg.redlineRpm;
  }

  _beginShift(target) {
    this._shifting = true;
    this._shiftTimer = this.cfg.shiftTimeMs / 1000;
    this._shiftFrom = this.gear;
    this._shiftTo = target;
    this._shiftBumpQueued = true;

    const downshift = target !== 0 && target < this.gear;
    if (downshift && this.cfg.revMatch) {
      this._revMatchTarget = clamp(
        this._speedToRpm(this.speed, target), this.cfg.idleRpm, this.cfg.redlineRpm);
      this._blip = 1;
    } else {
      this._revMatchTarget = 0;
    }
    return true;
  }

  _stepPhysics(dt) {
    const cfg = this.cfg;

    // --- rev limiter: cut fuel in short bursts so it bounces off redline ----
    if (this._limiterCut > 0) {
      this._limiterCut -= dt;
    } else if (this.rpm >= cfg.redlineRpm) {
      this._limiterCut = 0.05;
    }
    const fuelCut = this._limiterCut > 0;

    // Effective throttle seen by the engine.
    let thr = this.throttle;
    if (fuelCut) thr = 0;
    if (this._shifting) {
      thr = this._revMatchTarget > 0 && this.rpm < this._revMatchTarget ? 0.85 : 0;
    }

    // --- automatic gearbox -------------------------------------------------
    if (this.autoShift && !this._shifting && this.gear > 0) {
      if (this.rpm >= cfg.autoShiftUpRpm && this.gear < cfg.gearRatios.length && this.throttle > 0.05) {
        this._beginShift(this.gear + 1);
      } else if (this.gear > 1 && this.rpm <= cfg.autoShiftDownRpm) {
        // Only drop a gear if the lower one will not immediately over-rev.
        if (this._speedToRpm(this.speed, this.gear - 1) < cfg.autoShiftUpRpm) {
          this._beginShift(this.gear - 1);
        }
      }
    }

    // --- longitudinal forces ----------------------------------------------
    const v = this.speed;
    const drag = 0.5 * RHO_AIR * cfg.dragArea * v * v * Math.sign(v || 1);
    const roll = v > 0.05 ? cfg.rollingResistance * cfg.mass * G : 0;
    const braking = this.brake * cfg.brakeForce * (v > 0.05 ? 1 : 0);

    const engaged = !this._shifting && this.gear > 0;
    if (!engaged) this._clutchLocked = false;
    const ratio = engaged ? this._totalRatio(this.gear) : 0;
    // While the clutch slips it only partially drives the wheels; how much
    // depends on how hard the driver is pushing it.
    const slipping = engaged && !this._clutchLocked;

    const engineTorque = thr * cfg.peakTorque * this._torqueFactor(this.rpm)
                       - this._frictionTorque(this.rpm, thr);

    let driveForce = 0;
    let effMass = cfg.mass;

    if (engaged) {
      const slipScale = slipping ? clamp(0.35 + 0.65 * this.throttle, 0, 1) : 1;
      driveForce = (engineTorque * ratio * cfg.driveEfficiency / cfg.wheelRadius) * slipScale;
      if (slipping && engineTorque < 0) driveForce = 0;   // no engine braking while slipping
      // Reflected rotational inertia — this is why 1st gear feels heavy.
      effMass = cfg.mass + (cfg.engineInertia * ratio * ratio) / (cfg.wheelRadius * cfg.wheelRadius);
    }

    let accel = (driveForce - drag - roll - braking) / effMass;
    this.speed += accel * dt;
    if (this.speed < 0) this.speed = 0;                    // no reverse modelled

    // --- engine speed ------------------------------------------------------
    if (engaged) {
      const g2 = this._speedToRpm(this.speed, this.gear);
      if (this._clutchLocked && g2 < cfg.idleRpm) this._clutchLocked = false;

      if (this._clutchLocked) {
        this.rpm = clamp(g2, cfg.idleRpm, cfg.redlineRpm);
      } else {
        // Launch: the engine holds the rpm the driver is asking for while the
        // clutch slips, and locks up once road speed catches the crank.
        const hold = clamp(cfg.idleRpm + this.throttle * cfg.clutchFlareRpm,
                           cfg.idleRpm, cfg.redlineRpm);
        const target = Math.max(g2, hold);
        this.rpm += (target - this.rpm) * Math.min(1, dt * 10);
        if (g2 >= this.rpm - 30) {
          this._clutchLocked = true;
          this.rpm = clamp(g2, cfg.idleRpm, cfg.redlineRpm);
        }
      }
    } else {
      // Free-revving (neutral, or clutch out mid-shift): integrate crank inertia.
      let torque;
      if (this._revMatchTarget > 0) {
        // Rev-match servo: converge on the target instead of free-revving.
        torque = clamp((this._revMatchTarget - this.rpm) * 0.09, -90, 200);
      } else if (this.rpm < cfg.idleRpm + 200 && thr < 0.05) {
        torque = (cfg.idleRpm - this.rpm) * 0.3;             // idle governor (~0.1 s)
      } else {
        torque = engineTorque;
      }
      const omega = this.rpm / RPM_PER_RADS + (torque / cfg.engineInertia) * dt;
      this.rpm = clamp(omega * RPM_PER_RADS, cfg.idleRpm * 0.6, cfg.redlineRpm);
    }

    // --- shift timing ------------------------------------------------------
    if (this._shifting) {
      this._shiftTimer -= dt;
      if (this._shiftTimer <= 0) {
        this.gear = this._shiftTo;
        this._shifting = false;
        this._revMatchTarget = 0;
        if (this.gear > 0) {
          const target = this._speedToRpm(this.speed, this.gear);
          if (target > cfg.idleRpm) {
            // Clutch drop: snap most of the way, leaving a touch of slip.
            this.rpm = lerp(this.rpm, clamp(target, cfg.idleRpm, cfg.redlineRpm), 0.85);
            this._clutchLocked = true;
          }
        }
      }
    }

    this._blip = Math.max(0, this._blip - dt * 4);
  }

  // =========================================================================
  // Audio parameter mapping
  // =========================================================================

  _writeAudioParams(dt, immediate) {
    if (!this.running && !immediate) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const cfg = this.cfg;
    const p = this.profile;

    const tc = immediate ? 0.001 : 0.02;          // param smoothing constant
    const f0 = this.rpm / 60;                     // crank rotation frequency
    const rpmNorm = clamp((this.rpm - cfg.idleRpm) / (cfg.redlineRpm - cfg.idleRpm), 0, 1);

    // Perceived load: throttle, plus a floor so the engine is audible when
    // coasting, plus the rev-match blip.
    const rawLoad = clamp(Math.max(this.throttle, this._blip * 0.8), 0, 1);
    const smooth = immediate ? 1 : clamp(dt * 12, 0, 1);
    this.load += (rawLoad - this.load) * smooth;
    const load = this.load;

    // Cross-plane burble is strongest at low rpm and light-to-mid load.
    const burble = p.burble * (1 - rpmNorm) * (1 - rpmNorm) * (0.45 + 0.55 * (1 - load));

    // --- oscillator frequencies + per-partial gains ------------------------
    for (const n of this.oscNodes) {
      const s = n.spec;
      const f = clamp(f0 * s.order, 0.02, 18000);
      n.osc.frequency.setTargetAtTime(f, now, tc);

      let g = s.gain * (1 + (s.rpmTilt || 0) * (rpmNorm * 2 - 1));
      if (s.burble) g *= burble;
      // Load shapes the harmonic balance: off-throttle is soft and dull.
      g *= 0.30 + 0.70 * load;
      n.gain.gain.setTargetAtTime(clamp(g, 0, 2) * 0.22, now, tc);
    }

    this.pulseOsc.frequency.setTargetAtTime(
      clamp(f0 * p.pulseOrder, 0.02, 18000), now, tc);

    // --- filter modulation -------------------------------------------------
    const bodyFreq = clamp(
      p.bodyBase + f0 * p.bodyPerF0 + load * p.bodyLoad + rpmNorm * p.bodyRpm,
      120, 14000);
    this.body.frequency.setTargetAtTime(bodyFreq, now, tc);
    this.body.Q.setTargetAtTime(
      lerp(p.resonance[0], p.resonance[1], load * 0.75 + rpmNorm * 0.25), now, 0.05);

    this.formant.gain.setTargetAtTime(
      p.formant.gain * (0.6 + 0.4 * load) + burble * 3, now, 0.05);

    // --- noise beds --------------------------------------------------------
    const intake = p.intake;
    this.intakeFilter.frequency.setTargetAtTime(
      clamp(intake.freq + f0 * intake.freqPerF0, 120, 12000), now, tc);
    this.intakeFilter.Q.setTargetAtTime(intake.q + load, now, 0.05);

    const intakeLevel = (intake.base + intake.load * load) * (0.35 + 0.65 * rpmNorm);
    this.intakeGain.gain.setTargetAtTime(intakeLevel, now, tc);
    // The pulse train is summed into intakeGain.gain, so cap its depth below
    // the DC level — otherwise the gain swings negative and the chuff doubles up.
    this.pulseDepth.gain.setTargetAtTime(
      Math.min(intake.pulse * (0.4 + 0.6 * load) * (1 - 0.5 * rpmNorm), intakeLevel * 0.92),
      now, tc);

    const rum = p.rumble;
    this.rumbleFilter.frequency.setTargetAtTime(
      clamp(rum.freq + f0 * 1.4, 60, 900), now, tc);
    this.rumbleGain.gain.setTargetAtTime(
      (rum.base + rum.load * load) * (0.5 + 0.5 * rpmNorm) + burble * 0.12, now, tc);

    // --- overall voice level ----------------------------------------------
    let vol = p.gain * (0.30 + 0.55 * load) * (0.55 + 0.45 * rpmNorm);
    if (this._shifting) vol *= 0.35;                       // torque-cut dip
    if (this._limiterCut > 0) vol *= 0.5;                  // limiter stutter
    vol *= 1 - 0.9 * this._duck;
    this._duck = Math.max(0, this._duck - dt * 7);
    this.voice.gain.setTargetAtTime(vol, now, immediate ? 0.005 : 0.012);

    // --- transients --------------------------------------------------------
    if (this._shiftBumpQueued) {
      this._shiftBumpQueued = false;
      this._scheduleTransient(now + 0.004, 0.5, 90, 0.09);
    }
    this._updateOverrun(now);
    this._prevThrottle = this.throttle;
  }

  /**
   * Off-throttle exhaust pops. Scheduled ahead of the audio clock so timing is
   * sample-accurate rather than frame-quantised.
   */
  _updateOverrun(now) {
    const cfg = this.cfg;
    const decel = this.throttle < 0.08 && this.rpm > cfg.idleRpm * 2.6 && !this._shifting;
    const justLifted = this._prevThrottle > 0.45 && this.throttle < 0.08;

    if (justLifted && this.rpm > 3000) this._nextPopTime = now + 0.02 + Math.random() * 0.04;

    if (!decel) { this._popping = false; return; }
    if (!this._popping) { this._popping = true; if (this._nextPopTime < now) this._nextPopTime = now + 0.05; }

    const p = this.profile.pop;
    const rpmNorm = clamp((this.rpm - cfg.idleRpm) / (cfg.redlineRpm - cfg.idleRpm), 0, 1);
    const horizon = now + 0.12;                 // schedule a little ahead

    while (this._nextPopTime < horizon) {
      const t = Math.max(this._nextPopTime, now + 0.001);
      const intensity = p.level * (0.35 + 0.65 * rpmNorm) * (0.5 + Math.random() * 0.5);
      const freq = p.lo + Math.random() * (p.hi - p.lo);
      this._scheduleTransient(t, intensity, freq, 0.045 + Math.random() * 0.05);
      // Poisson-ish spacing, faster at high rpm.
      const rate = p.rate * (0.3 + 0.7 * rpmNorm);
      this._nextPopTime = t + (0.35 + Math.random() * 0.9) / rate;
    }
  }

  /** One short filtered noise burst on the shared pop path. */
  _scheduleTransient(time, amp, freq, decay) {
    const g = this.popGain.gain;
    // The exponential tail needs a strictly positive start value, so floor amp.
    const peak = clamp(amp, 0.001, 1);
    this.popFilter.frequency.setValueAtTime(clamp(freq, 30, 18000), time);
    g.setValueAtTime(0.0005, time);
    g.linearRampToValueAtTime(peak, time + 0.0015);
    g.exponentialRampToValueAtTime(0.0005, time + decay);
    g.setValueAtTime(0, time + decay + 0.001);
  }
}

export { PROFILES, VEHICLE_DEFAULTS };
export default EngineSim;
