/**
 * layers.js — everything an engine emits that is NOT the combustion pulse.
 *
 * The combustion voice (pulse.js + resonators.js) is only part of what you hear
 * standing next to a running car. The rest is machinery: a gearbox whining at
 * its own pitch in every gear, a turbo spinning up on its own inertia, and a
 * stream of impacts — bangs, clunks, clicks — that no steady-state synthesis
 * can produce.
 *
 * Three modules, all following the CONTRACT.md module shape. Every one of them
 * generates its own signal, so `input` is always `null`.
 *
 *   TransmissionLayer  gear mesh whine (per-gear pitch) and lash rattle
 *   TurboLayer         spool whine with real inertia, BOV, wastegate flutter
 *   TransientBank      shared zero-allocation one-shot player for all impacts
 *
 * A `MechanicalLayer` (valvetrain clatter at engine order 0.5, injector ticks,
 * timing-chain whirr, piston slap into fixed block modes) used to live here and
 * was removed at the user's request. Do not resurrect it from an older context
 * dump; it is in git history if the reasoning is ever wanted.
 *
 * Design rules obeyed throughout (see CONTRACT.md):
 *   - every node is built in the constructor; update() only writes AudioParams
 *     and schedules envelopes ahead of p.now on the audio clock
 *   - continuous values use setTargetAtTime(v, p.now, ~0.02)
 *   - every write is guarded finite; every frequency is clamped to [10, 20000]
 *   - no per-frame allocation anywhere (no object literals, no arrays, no
 *     closures created inside update())
 *
 * A note on the 10 Hz frequency floor. Several things here are genuinely
 * sub-audio rates: f0 = rpm/120 is 6.7 Hz at idle and the driveshaft can turn
 * at 1 Hz. Since the contract forbids writing a frequency below 10 Hz, no
 * oscillator is ever asked to run at the raw shaft rate; where a low-order
 * signature is needed it is produced as an intermodulation product of two legal
 * rates instead.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Turbo tone stage. The turbo is the brightest voice here and it lives in the
 * 2-5 kHz band where hearing peaks, so it carries its own air cut instead of
 * leaving the master EQ to clean up after it.
 *
 * 4.6 kHz keeps the blade tone's first few harmonics and the stall click's
 * attack while removing the hiss above them; the shelf then tilts what is left
 * so the whistle reads as bright without being sharp.
 */
const TURBO_AIR_HZ = 3800;
const TURBO_AIR_DB = -5.5;

/**
 * Ceiling on the blade-tone FUNDAMENTAL, Hz.
 *
 * 12 kHz let profiles put a near-pure tone at 4.2 kHz — the most piercing thing
 * this synth could produce. 3 kHz fixed that but five of the seven turbo
 * profiles then sat pinned AT the cap, so they all whistled at the same pitch
 * and it was still the sharpest thing in the mix. 2200 keeps the fundamental
 * under the ear's peak and lets the wavetable's harmonics (rolled off by the
 * tone stage) carry the brightness.
 */
const TURBO_WHINE_MAX_HZ = 1150;

const TC = 0.02;              // default smoothing time constant, seconds
const FMIN = 10;              // contract frequency clamp
const FMAX = 20000;
const LOOKAHEAD = 0.004;      // schedule transients this far ahead of p.now

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** Finite guard: anything NaN/Infinity/undefined becomes the fallback. */
function fin(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

/** Frequency guard: finite AND inside the contract's [10, 20000]. */
function hzOf(v, d) { return clamp(fin(v, d), FMIN, FMAX); }

/** Guarded smooth write of a plain param. */
function setT(param, value, now, tc) {
  param.setTargetAtTime(fin(value, 0), fin(now, 0), tc > 0 ? tc : TC);
}

/** Guarded smooth write of a frequency param. */
function setF(param, value, now, tc, d) {
  param.setTargetAtTime(hzOf(value, d === undefined ? FMIN : d), fin(now, 0), tc > 0 ? tc : TC);
}

/** xorshift32 — deterministic so a given engine always rattles the same way. */
function seeded(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Looping noise beds. One white and one pink buffer per AudioContext, shared by
 * every layer — a 2 s stereo-free buffer is ~380 kB and there is no reason for
 * four modules to each hold their own copy.
 *
 * White is right for impacts and hiss (a real impact excites everything at
 * once). Pink is right for the broadband beds — noise radiated through a
 * block/casing rolls off roughly 3 dB/octave, so a pink source needs far less
 * filtering to sit correctly.
 */
const NOISE_CACHE = new WeakMap();

function sharedNoise(ctx, kind) {
  let per = NOISE_CACHE.get(ctx);
  if (!per) { per = {}; NOISE_CACHE.set(ctx, per); }
  if (per[kind]) return per[kind];

  const seconds = 2.0;
  const sr = fin(ctx.sampleRate, 48000);
  const len = Math.max(1024, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const rnd = seeded(kind === 'pink' ? 0x9e3779b9 : 0x85ebca6b);

  if (kind === 'pink') {
    // Paul Kellett's economical pink filter: within 0.05 dB of true -3 dB/oct
    // from 10 Hz to 20 kHz for a fraction of the cost of a proper Voss chain.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = rnd() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
  }

  // Cross-fade the seam so the loop point is inaudible.
  const fade = Math.min(2048, len >> 2);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    d[i] = d[i] * t + d[len - fade + i] * (1 - t);
  }
  per[kind] = buf;
  return buf;
}

/** A looping source on a shared buffer, started immediately (gated by gains). */
function noiseSource(ctx, kind, offset) {
  const src = ctx.createBufferSource();
  src.buffer = sharedNoise(ctx, kind);
  src.loop = true;
  try { src.start(0, fin(offset, 0)); src.__started = true; } catch (e) { /* already started */ }
  return src;
}

/** Ring-modulator style AM: osc -> depth gain -> target.gain (adds to the DC). */
function amDrive(ctx, osc, depth, targetParam) {
  const g = ctx.createGain();
  g.gain.value = depth;
  osc.connect(g);
  g.connect(targetParam);
  return g;
}

/**
 * Start every source that is not already running.
 *
 * The looping noise sources start themselves at construction (they are gated by
 * gains, so running them permanently costs nothing and avoids a start race).
 * Oscillators do NOT — they were being built, connected and never started,
 * which is silent and completely invisible to a param-level test. __started
 * tracks it because Web Audio gives no way to ask a source whether it is running.
 */
function startAll(list, t) {
  const at = fin(t, 0);
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (!n || n.__started) continue;
    try { n.start(at); n.__started = true; } catch (e) { /* already started */ }
  }
}

function stopAll(list, now) {
  for (let i = 0; i < list.length; i++) {
    try { list[i].stop(fin(now, 0)); } catch (e) { /* not startable/already stopped */ }
    try { list[i].disconnect(); } catch (e) { /* noop */ }
  }
}

function disconnectAll(list) {
  for (let i = 0; i < list.length; i++) {
    try { list[i].disconnect(); } catch (e) { /* noop */ }
  }
}

// ===========================================================================
// 1. TransmissionLayer
// ===========================================================================

/**
 * Gear mesh whine and lash rattle.
 *
 * Mesh frequency for a gear pair is shaftRevs/s × (teeth on the gear ON that
 * shaft) — the same number whichever side you count from. `gearTeeth[gear-1]`
 * in VEHICLE_PRESETS is the output-side gear, so the mesh tone is driven by the
 * gearbox output (drive) shaft, i.e. p.wheelRpm, NOT engine rpm. Two audible
 * consequences fall straight out of that, and neither is a pitch shift:
 *
 *   - every gear has its own whine pitch, because the ratio and the tooth count
 *     change together (in 1st the shaft is slow but the gear is big; in 6th the
 *     shaft is fast and the gear is small — so the whine generally rises with
 *     gear, but not proportionally, and each gear has its own signature)
 *   - clutch open, neutral, or mid-shift: no torque across the teeth, no whine
 *
 * Whine is generated by transmission error — the tiny deviation from perfect
 * conjugate action as each tooth pair engages — so it needs tooth LOAD to
 * exist. Straight-cut gears engage the whole face width at once (very strong,
 * very tonal); helical gears roll into contact gradually (much quieter, and
 * what tonal content survives is spread into more of a whirr). That is the
 * `gearCut` option.
 *
 * On top of the tone, a shaft-runout sideband: gears are never perfectly
 * concentric, so the whine is amplitude-modulated at shaft rate (the second
 * order of it here, to stay above the 10 Hz floor at low speeds).
 *
 * Rattle is the opposite phenomenon: an UNLOADED gear pair, free inside its
 * backlash, hammered back and forth by torsional fluctuation. So it is driven
 * by |p.dRpm| and p.clutchSlip, suppressed by load (loaded teeth cannot
 * rattle), and it is loudest of all in neutral at idle with the clutch
 * engaged — the classic idle gear rattle that vanishes the instant you press
 * the clutch pedal.
 */
export class TransmissionLayer {
  /**
   * @param {BaseAudioContext} ctx
   * @param {object} profile ENGINE_PROFILES entry (used for the firing rate)
   * @param {object} [opts]
   *   vehicle          VEHICLE_PRESETS entry — supplies gearTeeth + finalDrive
   *   gearTeeth        explicit tooth counts, overrides vehicle
   *   finalDrive       explicit final drive, overrides vehicle
   *   gearCut          'helical' (default) | 'straight'
   *   level            overall trim, default 1
   *   driveshaftScale  'auto' (default) | number, see _shaftRpm()
   */
  constructor(ctx, profile, opts) {
    this.ctx = ctx;
    this.profile = profile;
    const o = opts || {};
    this.level = fin(o.level, 1);
    this.gearCut = o.gearCut === 'straight' ? 'straight' : 'helical';
    this.driveshaftScale = (typeof o.driveshaftScale === 'number' && isFinite(o.driveshaftScale))
      ? o.driveshaftScale : 'auto';
    this._scale = 0;                       // 0 = not yet decided (see _shaftRpm)

    this._srcs = [];
    this._nodes = [];
    const keep = (n) => { this._nodes.push(n); return n; };

    this.out = keep(ctx.createGain());
    this.out.gain.value = this.level;

    const white = noiseSource(ctx, 'white', 0.71);
    const pink = noiseSource(ctx, 'pink', 1.31);
    this._srcs.push(white, pink);

    // --- mesh whine ---------------------------------------------------------
    // Fundamental + 2nd harmonic. A gear mesh is a periodic impulse-ish
    // excitation, so real spectra always show the 2nd (and 3rd) mesh harmonic;
    // straight-cut boxes show far more of them.
    this.meshOsc1 = ctx.createOscillator();
    // Sines, not triangles. A triangle's 3rd and 5th harmonics put a 2 kHz
    // mesh tone at 6 and 10 kHz with nothing else up there to mask them; the
    // second harmonic is already its own oscillator and the noise band
    // carries the rest.
    this.meshOsc1.type = 'sine';
    this.meshOsc1.frequency.value = 500;
    this.meshOsc2 = ctx.createOscillator();
    this.meshOsc2.type = 'sine';
    this.meshOsc2.frequency.value = 1000;
    this.runoutOsc = ctx.createOscillator();  // shaft-runout AM
    this.runoutOsc.type = 'sine';
    this.runoutOsc.frequency.value = 20;
    this._srcs.push(this.meshOsc1, this.meshOsc2, this.runoutOsc);

    this.meshH2 = keep(ctx.createGain());
    this.meshH2.gain.value = this.gearCut === 'straight' ? 0.55 : 0.20;

    // Narrow-band noise at the mesh frequency: the non-deterministic part of
    // transmission error (surface finish, load sharing). Helical boxes are
    // mostly this; straight-cut boxes are mostly tone.
    this.meshBP = keep(ctx.createBiquadFilter());
    this.meshBP.type = 'bandpass';
    this.meshBP.frequency.value = 500;
    this.meshBP.Q.value = this.gearCut === 'straight' ? 9 : 3.5;
    this.meshNoiseG = keep(ctx.createGain());
    this.meshNoiseG.gain.value = this.gearCut === 'straight' ? 0.22 : 0.60;

    this.meshAM = keep(ctx.createGain());
    this.meshAM.gain.value = 0.85;
    keep(amDrive(ctx, this.runoutOsc, 0.15, this.meshAM.gain));

    this.meshGain = keep(ctx.createGain());
    this.meshGain.gain.value = 0;

    this.meshOsc1.connect(this.meshAM);
    this.meshOsc2.connect(this.meshH2);
    this.meshH2.connect(this.meshAM);
    white.connect(this.meshBP);
    this.meshBP.connect(this.meshNoiseG);
    this.meshNoiseG.connect(this.meshAM);
    this.meshAM.connect(this.meshGain);
    this.meshGain.connect(this.out);

    // --- lash rattle --------------------------------------------------------
    // Metallic, two bands: the tooth impact itself (~1.8 kHz) and the casing
    // ring it excites (~3.6 kHz).
    this.ratBP1 = keep(ctx.createBiquadFilter());
    this.ratBP1.type = 'bandpass';
    this.ratBP1.frequency.value = 1800;
    this.ratBP1.Q.value = 2.0;
    this.ratBP2 = keep(ctx.createBiquadFilter());
    this.ratBP2.type = 'bandpass';
    this.ratBP2.frequency.value = 3600;
    this.ratBP2.Q.value = 2.5;
    this.ratH2 = keep(ctx.createGain());
    this.ratH2.gain.value = 0.5;

    // Torsional excitation comes from the firing pulses, so the rattle is
    // coherent with the firing rate — that is why idle rattle sounds like part
    // of the engine and not like a separate noise.
    this.ratAM = keep(ctx.createGain());
    this.ratAM.gain.value = 0.4;
    this.torsOsc = ctx.createOscillator();
    this.torsOsc.type = 'sawtooth';
    this.torsOsc.frequency.value = 60;
    this._srcs.push(this.torsOsc);
    keep(amDrive(ctx, this.torsOsc, 0.6, this.ratAM.gain));

    this.ratGain = keep(ctx.createGain());
    this.ratGain.gain.value = 0;

    pink.connect(this.ratBP1);
    pink.connect(this.ratBP2);
    this.ratBP1.connect(this.ratAM);
    this.ratBP2.connect(this.ratH2);
    this.ratH2.connect(this.ratAM);
    this.ratAM.connect(this.ratGain);
    this.ratGain.connect(this.out);

    this.setVehicle(o.vehicle, o.gearTeeth, o.finalDrive);
    this.setProfile(profile);
  }

  get input() { return null; }
  get output() { return this.out; }

  /** Allocation-free vehicle swap. */
  setVehicle(vehicle, gearTeeth, finalDrive) {
    const v = vehicle || null;
    const teeth = gearTeeth || (v && v.gearTeeth) || null;
    // Fallback: a generic 6-speed layshaft set, only used if nobody tells us.
    this.teeth = (teeth && teeth.length) ? teeth : [37, 31, 27, 24, 22, 20];
    this.finalDrive = clamp(fin(finalDrive, fin(v && v.finalDrive, 3.9)), 1, 12);
    this._scale = 0;                       // re-detect for the new driveline
  }

  setProfile(profile) {
    this.profile = profile;
    this.cyl = clamp(fin(profile && profile.cylinders, 4), 1, 16);
    this.idleRpm = fin(profile && profile.idleRpm, 800);
  }

  /**
   * Gearbox output (drive) shaft rpm.
   *
   * The params object gives `wheelRpm`, documented as "driveshaft rpm". If the
   * physics module actually reports ROAD-WHEEL rpm (i.e. rpm / gearRatio, where
   * gearRatio includes the final drive), the propshaft turns `finalDrive` times
   * faster and the mesh tone would come out a factor of ~3.9 too low. Rather
   * than guess, we measure it once, on the first frame where the driveline is
   * locked up and turning, and then stick with that scale so the whine never
   * jumps pitch mid-drive. `opts.driveshaftScale` overrides the detection.
   */
  _shaftRpm(p) {
    const w = Math.abs(fin(p.wheelRpm, 0));
    if (this.driveshaftScale !== 'auto') return w * this.driveshaftScale;

    if (this._scale === 0) {
      const g = fin(p.gearRatio, 0);
      const rpm = fin(p.rpm, 0);
      if (g > 0.05 && w > 50 && rpm > 200 && fin(p.clutchEngaged, 0) > 0.9) {
        const implied = rpm / w;             // engine rpm per unit of wheelRpm
        const asWheel = Math.abs(implied - g);
        const asShaft = Math.abs(implied - g / this.finalDrive);
        this._scale = asWheel < asShaft ? this.finalDrive : 1;
      }
    }
    return w * (this._scale || 1);
  }

  /** Mesh frequency for a gear at a given driveshaft rpm, Hz. Also used by tests. */
  meshFrequency(gear, shaftRpm) {
    const i = Math.round(fin(gear, 0)) - 1;
    if (i < 0 || i >= this.teeth.length) return 0;
    return (Math.abs(fin(shaftRpm, 0)) / 60) * fin(this.teeth[i], 0);
  }

  update(p) {
    const now = fin(p.now, 0);
    const gear = Math.round(fin(p.gear, 0));
    const load = clamp(fin(p.load, 0), 0, 1);
    const rpm = Math.max(0, fin(p.rpm, 0));
    const f0 = fin(p.f0, rpm / 120);
    const engaged = clamp(fin(p.clutchEngaged, 0), 0, 1);
    const phase = p.shiftPhase || '';
    const shaftRpm = this._shaftRpm(p);
    const mesh = this.meshFrequency(gear, shaftRpm);

    // --- whine --------------------------------------------------------------
    // Fade rather than clamp at the edges: pinning a tone at 20 kHz or 10 Hz
    // would leave a stuck artefact. Below 40 Hz the car is nearly stopped and
    // the "whine" would be an infrasonic thump; above 16 kHz it is inaudible
    // anyway and only risks aliasing artefacts in the harmonic.
    let band = 0;
    if (mesh > 0) {
      // Radiated gear whine has to get out through the gearbox case and the
      // body, both of which are strongly low-pass. The previous rolloff only
      // started at 13 kHz, so a full-level triangle tone was reaching the
      // output at 10 kHz and the 2nd harmonic was pinned at the 20 kHz clamp —
      // physically wrong and, since the ear peaks around 3-4 kHz, genuinely
      // painful as the mesh swept up through it.
      const hfRoll = 1 / (1 + Math.pow(mesh / 1800, 2.4));
      band = clamp((mesh - 30) / 40, 0, 1) * hfRoll;
    }

    // Torque across the teeth. Transmission-error excitation scales with tooth
    // load, so coasting whine is real but weaker (and comes off the other tooth
    // flank, which is why it sounds different — modelled as a level change).
    const driving = fin(p.torqueSign, 1) >= 0;
    const toothLoad = driving ? (0.22 + 0.85 * load) : 0.34;

    // Neutral / clutch open / mid-shift: no torque path, no whine. During
    // 'open' and 'sync' the box is unloaded, which conveniently also hides the
    // pitch jump when the tooth count changes.
    const inGear = (gear > 0 && Math.abs(fin(p.gearRatio, 0)) > 1e-3) ? 1 : 0;
    const phaseMute = (phase === 'open' || phase === 'sync' || phase === 'cut') ? 0.05 : 1;

    // Dynamic transmission error grows with speed until the mesh stiffness
    // resonance; a mild rise to ~2500 shaft rpm covers the useful range.
    const speedRise = 0.45 + 0.55 * clamp(shaftRpm / 2500, 0, 1);

    const cutLevel = this.gearCut === 'straight' ? 1.0 : 0.42;
    // 0.16 → 0.065. The offline render measured the whine as the single most
    // prominent tone in the whole output — 40-43 dB above its neighbourhood in
    // 1.3-2.3 kHz on every engine. A helical box is a faint whirr under load.
    const whine = 0.065 * cutLevel * inGear * engaged * phaseMute * toothLoad * band * speedRise;

    setF(this.meshOsc1.frequency, mesh, now, TC, 500);
    setF(this.meshOsc2.frequency, mesh * 2, now, TC, 1000);
    // The 2nd harmonic sits an octave up and so needs its own, steeper rolloff.
    const h2Base = this.gearCut === 'straight' ? 0.55 : 0.20;
    setT(this.meshH2.gain, h2Base / (1 + Math.pow((mesh * 2) / 2600, 2.4)), now, TC);
    setF(this.meshBP.frequency, mesh, now, TC, 500);
    // 2nd-order shaft runout, clamped at the 10 Hz floor (which only bites
    // below ~300 shaft rpm, where the whine is already faded out).
    setF(this.runoutOsc.frequency, (shaftRpm / 60) * 2, now, TC, FMIN);
    setT(this.meshGain.gain, whine, now, TC);

    // --- rattle -------------------------------------------------------------
    // Torsional acceleration of the crank, normalised: 4000 rpm/s is a hard
    // shift transient; idle irregularity is a fraction of that.
    const dRpmTerm = clamp(Math.abs(fin(p.dRpm, 0)) / 4000, 0, 1);
    const slipTerm = clamp(Math.abs(fin(p.clutchSlip, 0)) / 800, 0, 1);

    // Idle rattle: unloaded gears + engaged clutch + low rpm. In neutral every
    // gear on the layshaft is unloaded, so it is loudest there.
    const nearIdle = clamp(1 - (rpm - this.idleRpm) / Math.max(200, this.idleRpm * 1.6), 0, 1);
    const idleRattle = engaged * nearIdle * (1 - 0.7 * load) * (inGear ? 0.4 : 1);

    // Loaded teeth are pressed against one flank and cannot rattle at all.
    const lashOpen = 1 - 0.65 * load * inGear;
    const drive = clamp(0.5 * idleRattle + 0.75 * dRpmTerm + 0.7 * slipTerm, 0, 1) * lashOpen;

    setF(this.torsOsc.frequency, this.cyl * f0, now, TC, FMIN);
    setT(this.ratGain.gain, 0.09 * drive * clamp(rpm / Math.max(1, this.idleRpm * 0.6), 0, 1), now, TC);
  }

  /** Start this layer's oscillators. Noise sources are already running. */
  start(t) { startAll(this._srcs, t); }

  dispose() {
    const now = fin(this.ctx.currentTime, 0);
    stopAll(this._srcs, now);
    disconnectAll(this._nodes);
    this._srcs.length = 0;
  }
}

// ===========================================================================
// 2. TurboLayer
// ===========================================================================

/**
 * Turbocharger: spool whine, blow-off valve, and compressor surge — the
 * "stu-stu-stu" flutter.
 *
 * The whole character of a turbo is that it does NOT follow the engine. The
 * shaft is a flywheel driven by exhaust enthalpy and braked by compressor work
 * and windage, so it lags going up and coasts down slowly. That is modelled
 * here as a first-order lag on a normalised shaft speed with asymmetric time
 * constants, both derived from `profile.turbo.inertia`:
 *
 *     dx/dt = (drive − x)/τ,   τ = inertia · 1.1  spooling up
 *                              τ = inertia · 1.9  coasting on a trailing throttle
 *                              τ = inertia · 0.75 coasting under fuel cut
 *
 * The three-way τ matters more than it looks: it is what makes each gear change
 * have its own whistle swoop instead of one flat tone across the whole gearbox.
 *
 * Boost follows from Euler's turbomachinery relation: the pressure rise across
 * a compressor goes with the square of the tip speed, so boost ∝ x². The shaft
 * also never truly stops while the engine runs — it windmills — hence the floor.
 *
 * ---------------------------------------------------------------------------
 * WHINE — why this is a wavetable and not a stack of sines
 *
 * The previous version summed three sine oscillators at f, 2f and 3f. Three
 * sines at exact integer ratios with fixed relative levels is, to the ear, one
 * tone with a fixed timbre — "a single uniform soundwave" — and at 3.4-4.2 kHz
 * a near-pure tone sits exactly where human hearing is most sensitive, which is
 * the other half of the harshness problem.
 *
 * Instead there is ONE oscillator carrying a band-limited PeriodicWave built
 * from a blade-tone series. Three things follow:
 *   - the browser band-limits per playback frequency, so the tone never aliases
 *     across the enormous pitch sweep a spooling turbo covers;
 *   - the harmonic tilt is set once, physically (radiated blade tones fall off
 *     with harmonic index), instead of three hand-set gains;
 *   - one oscillator replaces three, and the phase relationship between the
 *     harmonics is fixed rather than drifting.
 *
 * On top of that the tone is shaped by a resonant formant bandpass that tracks
 * the blade frequency. A real compressor housing is a cavity; the whistle you
 * hear is the blade tone THROUGH that cavity, which is why it has a vowel to
 * it rather than being a bare tone.
 *
 * Two modulations stop it reading as a test tone:
 *   - shaft-rate AM. Flow into the wheel is never uniform (the volute, the bend
 *     upstream of it), so every blade sees a different load once per SHAFT
 *     revolution. That puts sidebands either side of the blade tone at BPF/11 —
 *     tens of Hz, the range that reads as texture rather than a second pitch.
 *   - bearing wander. A turbo runs on floating journal bearings and the rotor
 *     is never perfectly centred, so the tone is never perfectly steady. Two
 *     mutually irrational LFOs on detune, deepest off-boost where the shaft is
 *     least loaded.
 *
 * ---------------------------------------------------------------------------
 * SURGE — the "stu-stu-stu"
 *
 * Close the throttle while the compressor is still pumping and the air has
 * nowhere to go. The compressor cannot sustain pressure at near-zero flow, so
 * it stalls, the flow briefly REVERSES through the wheel, pressure drops, flow
 * re-establishes, and the whole thing repeats. That is compressor surge, and
 * the repetition rate is the Helmholtz frequency of the compressor-to-throttle
 * volume — 8-30 Hz, which is why it chatters rather than whistles.
 *
 * The old implementation modulated a wide noise band with a SINE. A sine gives
 * smooth tremolo — "shoo-shoo-shoo". Real surge is a relaxation oscillation:
 * the stall is abrupt and the recovery is a decay, so each cycle is a sharp
 * burst with a tail, not a swell. Getting that shape right is the entire
 * difference between "shu-shu-shu" and "stu-stu-stu".
 *
 * So the envelope is a sawtooth through a WaveShaper carrying an attack/decay
 * pulse curve — a per-cycle burst with a 6 % rise and an exponential tail — and
 * it drives two noise bands:
 *   - a body band (Q 3.5, 700-1900 Hz) — the "tu", the pitched chuff of gas
 *     reversing through the wheel;
 *   - an edge band (Q 2.2, 2.2-3.4 kHz) at much lower level and gated harder —
 *     the "st", the broadband click of the stall itself.
 *
 * Surge is armed by ANY throttle closure while there is pressure to reverse,
 * which explicitly includes the ignition cut of a gear change. That is why a
 * boosted car flutters on every upshift, and it is the single most recognisable
 * thing a turbocharged engine does.
 *
 * `_surge` is a decaying state rather than a boolean window, so the burst train
 * fades the way the plenum actually empties instead of stopping dead.
 *
 * A blow-off valve is the opposite: it vents the plenum deliberately, so there
 * is less left to surge. That trade is NOT a mode switch — it falls out of one
 * number, `turbo.bov`, the valve's capacity. A big atmospheric valve empties
 * the plenum and you get the "chiu" and nothing else; a small or recirculating
 * valve leaves pressure standing and the compressor stalls anyway. Cars that do
 * both, a soft chiu with a chatter behind it, are the ones in between.
 */
const closedNow = (throttle) => throttle < 0.10;

export class TurboLayer {
  /** True if this profile has a turbo at all. */
  static supports(profile) { return !!(profile && profile.turbo); }

  /**
   * @param {object} [opts]
   *   level        overall trim, default 1
   *   maxTurboRpm  for display only, default 150000 (typical small-frame turbo)
   *   flutter      true (default) | false — set false to silence surge entirely.
   *                How much a given profile flutters is `turbo.bov`; this is an
   *                override for callers who want none of it at all.
   *   surgeLevel   trim on the flutter, default 1. TASTE-ADJUSTABLE.
   */
  constructor(ctx, profile, opts) {
    this.ctx = ctx;
    const o = opts || {};
    this.level = fin(o.level, 1);
    this.maxTurboRpm = fin(o.maxTurboRpm, 150000);
    this.flutterMode = o.flutter === false ? false : true;
    this.surgeLevel = clamp(fin(o.surgeLevel, 1), 0, 3);

    // Physical state, exported for the orchestrator's boost gauge.
    this.spool = 0;          // 0..1 normalised shaft speed
    this.boost = 0;          // 0..1 normalised boost pressure
    this.boostBar = 0;       // bar
    this.turboRpm = 0;
    this._vent = 0;          // 0..1 plenum-dumped fraction, decays back
    this._surge = 0;         // 0..1 how hard the compressor is stalling
    this._lastBov = -1e9;
    this._prevThrottle = 0;
    this._prevShifting = false;
    this._rnd = seeded(0x51ed270b);

    this._srcs = [];
    this._nodes = [];
    const keep = (n) => { this._nodes.push(n); return n; };

    this.out = keep(ctx.createGain());
    this.out.gain.value = this.level;

    // The node graph is only built for turbocharged profiles. A naturally
    // aspirated profile still constructs (so the orchestrator can wire it
    // unconditionally) but is a silent, inert pass-through.
    this._graphBuilt = false;
    this.setProfile(profile);
    if (!TurboLayer.supports(profile)) return;

    // Everything internal sums into `bus`, and `bus` reaches `out` through a
    // TONE STAGE. A turbo is the brightest thing in this synth and it is the
    // one voice that sits in the band the ear is most sensitive to, so it gets
    // its own air cut rather than relying on the master EQ to clean up after
    // it: a fixed lowpass to take the very top off the blade harmonics and the
    // stall click, and a high shelf to tilt what is left.
    this.bus = keep(ctx.createGain());
    this.airLP = keep(ctx.createBiquadFilter());
    this.airLP.type = 'lowpass';
    this.airLP.frequency.value = TURBO_AIR_HZ;
    this.airLP.Q.value = -3.01;              // Butterworth: Web Audio Q is dB here
    this.airShelf = keep(ctx.createBiquadFilter());
    this.airShelf.type = 'highshelf';
    this.airShelf.frequency.value = 2600;
    this.airShelf.gain.value = TURBO_AIR_DB;
    this.bus.connect(this.airLP);
    this.airLP.connect(this.airShelf);
    this.airShelf.connect(this.out);

    const white = noiseSource(ctx, 'white', 1.07);
    this._srcs.push(white);

    // --- blade tone ---------------------------------------------------------
    this.whineOsc = ctx.createOscillator();
    this.whineOsc.setPeriodicWave(bladeWave(ctx));
    this.whineOsc.frequency.value = 1200;
    this._srcs.push(this.whineOsc);

    // Compressor-housing formant. Tracks the blade tone rather than sitting at
    // a fixed frequency: the cavity is small enough that its own resonance is
    // above the band we care about, so what shapes the tone audibly is the
    // near-field radiation pattern, which does move with the source.
    this.whineBP = keep(ctx.createBiquadFilter());
    this.whineBP.type = 'bandpass';
    this.whineBP.frequency.value = 1500;
    this.whineBP.Q.value = 1.5;

    this.whineGain = keep(ctx.createGain());
    this.whineGain.gain.value = 0;

    // GRAIN. A blade tone straight out of a PeriodicWave is periodic to the
    // sample, and the ear reads anything that clean as a synthesiser rather
    // than as a machine. A real compressor is running in turbulent flow: the
    // wheel sees a different pressure every revolution, the tone breaks up, and
    // that roughness is most of what makes it sound like moving air rather than
    // an oscillator.
    //
    // Two mechanisms, because they do different jobs:
    //
    //   * a soft ASYMMETRIC saturator. Symmetric clipping only adds odd
    //     harmonics, which is the same brittle character an octave up;
    //     asymmetry adds the even ones, and evens are what read as body. It
    //     goes BEFORE the formant so the filter shapes the harmonics it makes
    //     rather than the other way round.
    //   * noise AM. Band-limited noise on the gain, so the level is never
    //     steady. This is the part that turns a tone into a rush.
    this.whineDrive = keep(ctx.createGain());
    this.whineDrive.gain.value = 1;
    this.whineShaper = keep(ctx.createWaveShaper());
    this.whineShaper.curve = grainCurve(1024, 0.55);
    this.whineShaper.oversample = '4x';      // it is a 1-3 kHz tone; do it properly

    this.whineOsc.connect(this.whineDrive);
    this.whineDrive.connect(this.whineShaper);
    this.whineShaper.connect(this.whineBP);
    this.whineBP.connect(this.whineGain);
    this.whineGain.connect(this.bus);

    // Flow roughness. Pink through a wide bandpass in the tens-of-Hz range is
    // the rate that reads as texture; faster becomes a buzz, slower a wobble.
    const grainNoise = noiseSource(ctx, 'pink', 0.29);
    this._srcs.push(grainNoise);
    this.grainBP = keep(ctx.createBiquadFilter());
    this.grainBP.type = 'bandpass';
    this.grainBP.frequency.value = 55;
    this.grainBP.Q.value = 0.6;
    this.grainDepth = keep(ctx.createGain());
    this.grainDepth.gain.value = 0;
    grainNoise.connect(this.grainBP);
    this.grainBP.connect(this.grainDepth);
    this.grainDepth.connect(this.whineGain.gain);

    // Bearing wander: two mutually irrational rates so the pattern never
    // repeats audibly. Depth is written per frame.
    this.wander1 = ctx.createOscillator();
    this.wander1.type = 'sine';
    this.wander1.frequency.value = 0.31;
    this.wander2 = ctx.createOscillator();
    this.wander2.type = 'sine';
    this.wander2.frequency.value = 2.17;
    this._srcs.push(this.wander1, this.wander2);
    this.wanderDepth1 = keep(amDrive(ctx, this.wander1, 0, this.whineOsc.detune));
    this.wanderDepth2 = keep(amDrive(ctx, this.wander2, 0, this.whineOsc.detune));

    // Shaft-rate sidebands.
    this.shaftOsc = ctx.createOscillator();
    this.shaftOsc.type = 'sine';
    this.shaftOsc.frequency.value = 180;
    this._srcs.push(this.shaftOsc);
    this.shaftDepth = keep(ctx.createGain());
    this.shaftDepth.gain.value = 0;
    this.shaftOsc.connect(this.shaftDepth);
    this.shaftDepth.connect(this.whineGain.gain);

    // Compressor flow hiss: broadband, centred just above the blade tone.
    this.hissBP = keep(ctx.createBiquadFilter());
    this.hissBP.type = 'bandpass';
    this.hissBP.frequency.value = 2000;
    this.hissBP.Q.value = 1.6;
    this.hissGain = keep(ctx.createGain());
    this.hissGain.gain.value = 0;
    white.connect(this.hissBP);
    this.hissBP.connect(this.hissGain);
    this.hissGain.connect(this.bus);

    // Whine AIR: a narrow noise band riding on the blade tone. Half of what
    // the ear hears of a real turbo whistle is turbulent flow through the
    // wheel at the blade-passing rate, not the tone itself — a pure partial
    // is what made it sound like a sine wave.
    this.whineNoiseBP = keep(ctx.createBiquadFilter());
    this.whineNoiseBP.type = 'bandpass';
    this.whineNoiseBP.frequency.value = 800;
    this.whineNoiseBP.Q.value = 6;
    this.whineNoiseGain = keep(ctx.createGain());
    this.whineNoiseGain.gain.value = 0;
    white.connect(this.whineNoiseBP);
    this.whineNoiseBP.connect(this.whineNoiseGain);
    this.whineNoiseGain.connect(this.bus);

    // AIRFLOW: the intake rush. A big low-mid band of pink noise — air being
    // pulled through the filter and pushed through the intercooler — that
    // swells with boost and flow. This, not the whistle, is the body of a
    // turbo you hear from outside the car.
    const airNoise = noiseSource(ctx, 'pink', 1.31);
    this._srcs.push(airNoise);
    this.airflowHP = keep(ctx.createBiquadFilter());
    this.airflowHP.type = 'highpass';
    this.airflowHP.frequency.value = 280;
    this.airflowHP.Q.value = 0.5;
    this.airflowLP = keep(ctx.createBiquadFilter());
    this.airflowLP.type = 'lowpass';
    this.airflowLP.frequency.value = 1400;
    this.airflowLP.Q.value = 0.5;
    this.airflowGain = keep(ctx.createGain());
    this.airflowGain.gain.value = 0;
    airNoise.connect(this.airflowHP);
    this.airflowHP.connect(this.airflowLP);
    this.airflowLP.connect(this.airflowGain);
    this.airflowGain.connect(this.bus);

    // --- blow-off valve -----------------------------------------------------
    // One shared filter+gain pair, retriggered by scheduling — no allocation.
    this.bovBP = keep(ctx.createBiquadFilter());
    this.bovBP.type = 'bandpass';
    this.bovBP.frequency.value = 2400;
    // High Q so the dump reads as a pitched "chiu" chirp rather than a
    // broadband "pshhh". At Q 1.1 the 2.2 kHz -> 600 Hz sweep was too wide a
    // band to hear as a pitch at all; the sweep was there and inaudible.
    this.bovBP.Q.value = 7;
    this.bovGain = keep(ctx.createGain());
    this.bovGain.gain.value = 0;
    white.connect(this.bovBP);
    this.bovBP.connect(this.bovGain);
    this.bovGain.connect(this.bus);

    // --- wastegate chatter --------------------------------------------------
    // Once boost reaches the wastegate spring pressure the valve hunts, opening
    // and closing many times a second. Owners describe it as "FftFftFft, not
    // ShuShuShu" — a fast dry chatter, quite distinct from the BOV's single
    // whoosh, and it happens WHILE you are on boost rather than when you lift.
    this.wgOsc = ctx.createOscillator();
    this.wgOsc.type = 'square';
    this.wgOsc.frequency.value = 34;
    this._srcs.push(this.wgOsc);
    this.wgBP = keep(ctx.createBiquadFilter());
    this.wgBP.type = 'bandpass';
    this.wgBP.frequency.value = 1500;
    this.wgBP.Q.value = 2.2;
    this.wgAM = keep(ctx.createGain());
    this.wgAM.gain.value = 0;
    this.wgLevel = keep(ctx.createGain());
    this.wgLevel.gain.value = 0;
    white.connect(this.wgBP);
    this.wgBP.connect(this.wgAM);
    this.wgAM.connect(this.wgLevel);
    this.wgLevel.connect(this.bus);
    keep(amDrive(ctx, this.wgOsc, 0.85, this.wgAM.gain));

    // --- compressor surge: the "stu-stu-stu" --------------------------------
    // One sawtooth through a pulse curve gives the burst train; both bands
    // share it so the "st" and the "tu" of each cycle land together.
    this.surgeOsc = ctx.createOscillator();
    this.surgeOsc.type = 'sawtooth';
    this.surgeOsc.frequency.value = 16;
    this._srcs.push(this.surgeOsc);

    this.surgeShaper = keep(ctx.createWaveShaper());
    this.surgeShaper.curve = surgePulseCurve(1024);
    // The curve turns a band-limited ramp into a burst; 2x is enough to keep
    // the corner clean without paying for 4x on a 16 Hz signal.
    this.surgeShaper.oversample = '2x';
    this.surgeOsc.connect(this.surgeShaper);

    // Body band — the "tu".
    this.surgeBody = keep(ctx.createBiquadFilter());
    this.surgeBody.type = 'bandpass';
    this.surgeBody.frequency.value = 1200;
    this.surgeBody.Q.value = 2.4;
    this.surgeBodyAM = keep(ctx.createGain());
    this.surgeBodyAM.gain.value = 0;
    this.surgeBodyLvl = keep(ctx.createGain());
    this.surgeBodyLvl.gain.value = 0;
    white.connect(this.surgeBody);
    this.surgeBody.connect(this.surgeBodyAM);
    this.surgeBodyAM.connect(this.surgeBodyLvl);
    this.surgeBodyLvl.connect(this.bus);
    this.surgeBodyDepth = keep(ctx.createGain());
    this.surgeBodyDepth.gain.value = 1;
    this.surgeShaper.connect(this.surgeBodyDepth);
    this.surgeBodyDepth.connect(this.surgeBodyAM.gain);

    // Edge band — the "st". Deliberately quiet: this is the band that would
    // make the flutter harsh if it were level-matched to the body.
    this.surgeEdge = keep(ctx.createBiquadFilter());
    this.surgeEdge.type = 'bandpass';
    this.surgeEdge.frequency.value = 2600;
    this.surgeEdge.Q.value = 2.2;
    this.surgeEdgeAM = keep(ctx.createGain());
    this.surgeEdgeAM.gain.value = 0;
    this.surgeEdgeLvl = keep(ctx.createGain());
    this.surgeEdgeLvl.gain.value = 0;
    white.connect(this.surgeEdge);
    this.surgeEdge.connect(this.surgeEdgeAM);
    this.surgeEdgeAM.connect(this.surgeEdgeLvl);
    this.surgeEdgeLvl.connect(this.bus);
    this.surgeEdgeDepth = keep(ctx.createGain());
    this.surgeEdgeDepth.gain.value = 1;
    this.surgeShaper.connect(this.surgeEdgeDepth);
    this.surgeEdgeDepth.connect(this.surgeEdgeAM.gain);

    this._graphBuilt = true;
    this.enabled = true;
  }

  get input() { return null; }
  get output() { return this.out; }

  /** Boost and shaft state for the orchestrator's gauge. */
  get state() {
    return {
      spool: this.spool, boost: this.boost,
      boostBar: this.boostBar, turboRpm: this.turboRpm, surge: this._surge,
    };
  }

  setProfile(profile) {
    this.profile = profile;
    const t = (profile && profile.turbo) || null;
    this.turbo = t;
    // Audible only if this profile has a turbo AND we were constructed with one
    // (the graph cannot be built later without allocating).
    this.enabled = !!t && this._graphBuilt === true;

    this.inertia = clamp(fin(t && t.inertia, 0.4), 0.05, 3);
    this.maxBoost = clamp(fin(t && t.maxBoost, 1), 0, 5);
    this.bovLevel = clamp(fin(t && t.bov, 0.5), 0, 2);
    this.surgeTrim = clamp(fin(t && t.surge, 1), 0, 3);
    const redline = fin(profile && profile.redlineRpm, 7000);
    // ×0.5: the profiles' blade orders put a spooled whistle at 1.6-2.2 kHz,
    // right in the ear's most sensitive band, where a near-pure tone reads as
    // a sine generator rather than a turbo. An octave down it sits under the
    // engine as a hum-whistle instead of on top of it.
    const order = 0.5 * fin(t && t.whineOrder, 70);
    // Whine of a fully spooled turbo at redline, Hz. See TURBO_WHINE_MAX_HZ.
    this.whineRef = clamp((redline / 120) * order, 200, TURBO_WHINE_MAX_HZ);
  }

  update(p) {
    if (!this.enabled) return;
    const now = fin(p.now, 0);
    const dt = clamp(fin(p.dt, 1 / 60), 0, 0.25);
    const load = clamp(fin(p.load, 0), 0, 1);
    const throttle = clamp(fin(p.throttle, 0), 0, 1);
    const rpmNorm = clamp(fin(p.rpmNorm, 0), 0, 1);
    const shifting = !!p.shifting;

    // --- shaft dynamics -----------------------------------------------------
    // Exhaust enthalpy flow ≈ mass flow (rpm) × energy per unit mass (load).
    // Exhaust mass flow is close to linear in rpm, and at low rpm there really
    // is almost nothing driving the turbine.
    const drive = clamp(load * (0.10 + 0.90 * rpmNorm), 0, 1);
    // With the fuel cut there is no exhaust enthalpy at all, so the turbine
    // coasts on bearing drag and slows markedly faster than it does on a
    // trailing throttle. That difference is what gives each upshift its own
    // whistle swoop instead of one flat tone across the whole gearbox.
    const coasting = throttle < 0.12;
    const tau = drive > this.spool
      ? this.inertia * 1.1
      : this.inertia * (coasting ? 0.45 : 1.3);   // was 0.75 / 1.9: the whine and rush hung on after a lift
    const alpha = dt > 0 ? (1 - Math.exp(-dt / Math.max(1e-3, tau))) : 0;
    this.spool += (drive - this.spool) * alpha;
    // Windmilling floor: the shaft never stops while gas flows through it.
    const floor = 0.04 + 0.07 * rpmNorm;
    if (this.spool < floor) this.spool = floor;
    this.spool = clamp(fin(this.spool, floor), 0, 1);

    // Plenum vent recovery after a BOV event (~180 ms refill).
    if (this._vent > 0) {
      this._vent *= Math.exp(-dt / 0.18);
      if (this._vent < 1e-3) this._vent = 0;
    }

    // Pressure ratio ∝ tip speed² (Euler). Wastegate caps it at maxBoost.
    const raw = this.spool * this.spool;
    this.boost = clamp(raw * (1 - 0.92 * this._vent), 0, 1);
    this.boostBar = this.boost * this.maxBoost;
    this.turboRpm = this.spool * this.maxTurboRpm;

    // --- whine --------------------------------------------------------------
    // Blade-passing frequency is proportional to shaft speed, but shaft speed
    // saturates near the top of its range under full load — mapped linearly the
    // whistle only moved 2-5 semitones within a gear, which is what "very flat"
    // means. An exponent expands that: the same 1.45x spool sweep across a gear
    // pull becomes ~1.8x, around ten semitones, so each gear gets an audible
    // rising swoop that the shift then cuts. Character, not physics.
    const whineHz = Math.max(120, this.whineRef * Math.pow(Math.max(0.05, this.spool), 1.55));
    setF(this.whineOsc.frequency, whineHz, now, TC, 1000);
    // The formant sits a little above the blade tone so the 2nd harmonic is
    // what the cavity emphasises — that is the "eeee" in a turbo whistle.
    setF(this.whineBP.frequency, whineHz * 1.25, now, TC, 1600);
    setF(this.whineNoiseBP.frequency, whineHz, now, TC, 800);

    // Radiation rises steeply with tip speed. Exponent 2.0 rather than 2.5 so
    // the whistle stays present across the range instead of only at full boost.
    const aero = Math.pow(this.spool, 2.0);
    const flow = clamp(Math.max(load, throttle * 0.7), 0, 1);
    // Weighted toward tip speed, NOT throttle: closing the throttle for a shift
    // must not collapse the whistle. The turbine is still spinning; it is still
    // whistling. What changes is that it is no longer being driven, so it sags.
    // 0.40 → 0.27 → 0.085: test/turbo.mjs had the spooled tone 15-20 dB
    // under the whole engine, which for a near-pure partial is loud. Now it is
    // a texture under the engine, with the noise band carrying the rest.
    const whineLvl = 0.085 * aero * (0.62 + 0.38 * flow);
    setT(this.whineGain.gain, whineLvl, now, TC);
    setT(this.whineNoiseGain.gain, 0.30 * aero * (0.5 + 0.5 * flow), now, TC);
    // Airflow: tracks how much air is moving (boost × flow), and opens up in
    // pitch as it does.
    setT(this.airflowGain.gain, 0.20 * (0.15 + 0.85 * this.spool) * this.spool * (0.25 + 0.75 * flow), now, 0.05);
    setF(this.airflowLP.frequency, 900 + 1300 * this.spool, now, TC, 1400);

    // Bearing wander, in cents. Deepest off-boost where the rotor is least
    // loaded and the oil film is thickest; a fully spooled turbo runs true.
    const wander = 26 * (1 - 0.75 * this.spool);
    setT(this.wanderDepth1.gain, wander, now, 0.08);
    setT(this.wanderDepth2.gain, wander * 0.4, now, 0.08);

    // Grain. Flow roughness is worst where the compressor is furthest from its
    // efficiency island — off-boost and at low flow — and cleans up as the
    // wheel comes on song, so the noise AM is deepest early in the spool and
    // the saturator is driven hardest there too. Both are expressed relative to
    // the whine's own level so the texture rides with it instead of appearing
    // as a separate hiss when the whistle is quiet.
    const rough = 0.55 - 0.30 * this.spool;
    setT(this.grainDepth.gain, whineLvl * rough, now, 0.05);
    // Drive into the saturator. Above 1 it clips harder and lower harmonics
    // grow; the tone stage catches the top of what that makes.
    setT(this.whineDrive.gain, 0.8 + 0.9 * this.spool, now, TC);
    // The roughness also lives in the noise band's rate: a slow shaft breaks
    // up in long lumps, a fast one in a fine rush.
    setF(this.grainBP.frequency, 28 + 120 * this.spool, now, TC, 55);

    // Shaft-rate sidebands. A turbo wheel has roughly a dozen blades, so the
    // shaft turns at about BPF/11 — tens of Hz, well below the tone, which is
    // exactly the range that reads as texture rather than as a second pitch.
    // Modulation is deepest off-boost where flow into the wheel is most
    // distorted, and cleans up as it comes on song.
    const BLADES = 11;
    setF(this.shaftOsc.frequency, clamp(whineHz / BLADES, 4, 400), now, TC, 180);
    setT(this.shaftDepth.gain, whineLvl * (0.52 - 0.28 * this.spool), now, TC);

    // Wastegate chatter: only near the boost ceiling, only on throttle.
    const nearCeiling = clamp((this.boost - 0.62) / 0.30, 0, 1);
    const chatter = nearCeiling * clamp(throttle, 0, 1) * (0.35 + 0.65 * rpmNorm);
    setF(this.wgOsc.frequency, 26 + 30 * nearCeiling + 8 * Math.sin(now * 3.1), now, 0.05, 34);
    setF(this.wgBP.frequency, 1200 + 1100 * this.spool, now, TC, 1500);
    setT(this.wgLevel.gain, 0.34 * chatter, now, TC);
    setT(this.hissGain.gain, 0.10 * aero * (0.45 + 0.55 * flow), now, TC);

    // --- blow-off valve -----------------------------------------------------
    const bov = clamp(fin(p.evBov, 0), 0, 1);
    if (bov > 0) this._fireBov(now, bov);

    // --- compressor surge ---------------------------------------------------
    this._stepSurge(now, dt, throttle, rpmNorm, shifting, p);
    this._prevLimiter = !!p.limiter;

    this._prevThrottle = throttle;
    this._prevShifting = shifting;
  }

  /**
   * Arm, sustain and decay the surge state, then write the burst train.
   *
   * Surge needs two things at once: pressure in the plenum, and nowhere for it
   * to go. Both a driver lift and a gear-change ignition cut close the throttle
   * against a still-spinning compressor, so both arm it — which is why a
   * boosted car flutters on upshifts as well as on lift-off.
   */
  _stepSurge(now, dt, throttle, rpmNorm, shifting, p) {
    // The plenum drains as the surge cycles vent it, so the stall weakens even
    // if the throttle stays shut. ~0.55 s to fall to a third.
    // 0.42 → 0.65 → 0.26: long enough for a few clear "stu"s, short enough
    // that the flutter is a response to the lift, not a tail that hangs on.
    this._surge *= Math.exp(-dt / 0.26);
    this._closedT = closedNow(throttle) ? (this._closedT || 0) + dt : 0;
    if (this._surge < 1e-3) this._surge = 0;

    const closed = throttle < 0.10;
    const justClosed = closed && this._prevThrottle >= 0.25;
    // A PARTIAL lift stalls a compressor too. Requiring the pedal to reach
    // 10 % before anything can arm meant the flutter only ever existed at the
    // two extremes of the pedal, and it is the reason it was so hard to
    // provoke: measured over eight lifts per engine, a 0.6-throttle drive
    // produced it on 0 of 8 for every one of the seven turbo profiles. What
    // stalls the wheel is the flow COLLAPSING, not the pedal reaching a
    // particular number, so a fast large closure arms it wherever it lands.
    const dropped = (this._prevThrottle - throttle) > 0.2 && throttle < 0.5;
    // The rev limiter's fuel cut closes the flow against a spooled wheel too,
    // so a boosted engine bouncing off the limiter flutters.
    const limiter = !!p.limiter;
    const shiftCut = shifting && !this._prevShifting;
    const allow = this.flutterMode === false ? 0 : 1;

    // Pressure available to reverse through the wheel, taken from SHAFT SPEED
    // rather than from boost.
    //
    // Boost goes with the square of tip speed, so gating on it squared the
    // threshold as well: `boost > 0.12` needs spool 0.35 and full authority at
    // `boost 0.57` needs spool 0.76 — which in practice means a near-flat-out
    // pull. Surge is a compressor-map phenomenon; what decides it is where the
    // wheel is running when the flow stops, and that is tip speed. Below 0.22
    // the wheel is windmilling and an off-boost lift is correctly silent.
    //
    // Note this reads the state BEFORE the valve has vented on the trigger
    // frame, which is right: what stalls the compressor is what was standing in
    // the plenum at the instant the throttle shut.
    //
    // 0.22/0.38 → 0.12/0.28: measured with test/turbo.mjs, a lift at the end
    // of a pull reached surge 0.05-0.3 on most engines and next to nothing on
    // some, because the shaft sags at the limiter and on partial load. The
    // flutter is THE turbo sound; it should come easily.
    const head = clamp((this.spool - 0.12) / 0.28, 0, 1);

    // What the valve relieves cannot reverse through the wheel. This is the
    // one place the valve's capacity decides the sound, and it has to be
    // applied to the ARMING rather than to the decaying state: the plenum is
    // vented on the same frame the throttle shuts, so subtracting it afterwards
    // just gets overwritten by the next arm.
    //
    // The coefficient is 0.55 and there is a floor, not the original 0.85 with
    // none. A big atmospheric valve should mean LESS flutter than a small one —
    // that trade is the whole point of `turbo.bov` — but at 0.85 the boxer4's
    // 0.8 valve left 0.32 of authority and it barely chattered at all even
    // flat out. The trade survives (0.32 of relief still separates the biggest
    // valve from the smallest); it just no longer silences anything.
    // 0.55/0.30 → 0.5/0.55: the trade survives (> 3 dB between the biggest
    // valve and the smallest, test/run.mjs), but no valve silences the flutter.
    const relief = clamp(1 - 0.5 * this.bovLevel, 0.55, 1);
    const stall = head * relief * allow;

    if (stall > 0 && (justClosed || dropped || shiftCut)) {
      // A snap-shut from full boost stalls harder than an easing-off.
      this._surge = Math.max(this._surge, stall);
    }
    // While the throttle stays shut and boost is still up, surge sustains
    // rather than decaying away — a long lift keeps chattering.
    // Sustain only for the first moments of a lift: the plenum empties in
    // well under a second, and holding it longer read as lingering.
    if (closed && stall > 0.06 && this._closedT < 0.35) {
      this._surge = Math.max(this._surge, stall * 0.8);
    }
    if (limiter && stall > 0.06) {
      this._surge = Math.max(this._surge, stall * 0.7);
    }
    // Reopening kills it at once — but only an actual reopening (the pedal
    // coming back UP, or past half). A partial lift held at 0.3 is still a
    // lift, and lets the flutter play out over its own short decay.
    const reopening = throttle > 0.5 || throttle > this._prevThrottle + 0.05;
    if (!closed && !shifting && !limiter && reopening) {
      this._surge *= 0.25;
    }

    const s = clamp(this._surge, 0, 1);

    // Helmholtz rate of the compressor-to-throttle volume. Higher pressure and
    // higher mass flow both stiffen the system, so the chatter speeds up: about
    // 9 Hz just above the stall threshold to 30 Hz coming off full boost at
    // high rpm. This spread is most of why the flutter sounds different in 2nd
    // and in 5th.
    const rate = 9 + 15 * s + 6 * rpmNorm;
    setF(this.surgeOsc.frequency, rate, now, 0.03, 16);

    // Each reversal drags gas back across the wheel; the harder the stall, the
    // higher the jet velocity and the brighter the chuff.
    // Lower than it was (700-1900 Hz): the "tu" of a flutter is a chuff, not
    // a hiss. The edge stays up where the "st" is.
    setF(this.surgeBody.frequency, 520 + 650 * s, now, 0.04, 800);
    setF(this.surgeEdge.frequency, 2000 + 900 * s, now, 0.04, 2400);

    const amp = this.surgeLevel * this.surgeTrim;
    // The bandpasses cost most of the noise that goes through them, so these
    // levels are well above what they look like relative to the whine.
    // The flutter is the turbo's main event: test/turbo.mjs puts it 9-20 dB
    // under the WHOLE mix during a lift (it was 22-33 dB under, i.e. inaudible
    // behind the engine). With the whistle down it has the space.
    setT(this.surgeBodyLvl.gain, 6.6 * amp * s, now, 0.03);
    // The edge band is gated on s^2 so a gentle stall is all body and only a
    // hard one gets the click. Level-matched by ear-safety, not by energy.
    setT(this.surgeEdgeLvl.gain, 1.6 * amp * s, now, 0.03);
  }

  /**
   * Schedule the BOV whoosh. Level comes from the boost that was STORED in the
   * plenum, so a lift at full boost is loud and a lift off-boost is nearly
   * silent. The falling pitch is the plenum emptying: the escaping jet slows,
   * so its broadband peak drops roughly an octave and a half over the event.
   */
  _fireBov(now, strength) {
    const stored = clamp(this.boost, 0, 1);
    // Narrowing the band to Q 7 costs about 8 dB of the noise that gets through
    // it, so the level is compensated to keep the chirp as loud as the old
    // broadband dump.
    const amp = clamp(this.bovLevel * 1.35 * strength * (0.15 + 0.85 * stored), 0.0005, 2.5);
    const dur = clamp(0.11 + 0.26 * stored, 0.05, 0.5);
    const t = fin(now, 0) + LOOKAHEAD;

    // The pitch gesture IS the character: a fast fall through better than two
    // octaves. Q rides up as it falls so the tail is more tonal than the onset,
    // which is what makes it read as "chiu" rather than a filter sweep.
    const f = this.bovBP.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(hzOf(2600 + 1800 * stored, 2800), t);
    f.exponentialRampToValueAtTime(hzOf(520 + 180 * stored, 620), t + dur * 0.8);

    const q = this.bovBP.Q;
    q.cancelScheduledValues(t);
    q.setValueAtTime(4.5, t);
    q.linearRampToValueAtTime(11, t + dur * 0.6);

    const g = this.bovGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0004, t);
    g.linearRampToValueAtTime(amp, t + 0.012);
    g.exponentialRampToValueAtTime(0.0004, t + dur);
    g.setValueAtTime(0, t + dur + 0.005);

    // The valve dumps the plenum but not the shaft: boost collapses, whine does
    // not. A little shaft speed is lost because the compressor briefly free-
    // wheels into an empty duct.
    //
    // How MUCH it dumps is the valve's capacity, and that one number decides
    // which sound a car makes. A big atmospheric valve empties the plenum, so
    // there is nothing left to reverse through the wheel and you get the "chiu"
    // and nothing else. A small or recirculating valve leaves pressure
    // standing, the compressor stalls anyway, and you get the flutter. Cars
    // that do both — a soft chiu with a chatter behind it — are the ones in
    // between, and that falls out of this rather than needing a mode switch.
    this._vent = clamp(this.bovLevel, 0.15, 1);
    this.spool *= 0.97;
    this._lastBov = fin(now, 0);
  }

  /** Start this layer's oscillators. Noise sources are already running. */
  start(t) { startAll(this._srcs, t); }

  dispose() {
    const now = fin(this.ctx.currentTime, 0);
    stopAll(this._srcs, now);
    disconnectAll(this._nodes);
    this._srcs.length = 0;
    this.enabled = false;
  }
}

/**
 * Blade-tone wavetable, built once per AudioContext.
 *
 * A compressor wheel radiates at the blade-passing frequency and its harmonics.
 * Measured compressor spectra show the fundamental dominant with the harmonics
 * falling roughly 1/k^1.4, and the ODD ones a little stronger — the wheel is
 * not symmetric front-to-back, so it radiates like a half-open source. That
 * tilt is what gives a turbo its edge without needing a bright filter.
 *
 * Cached per context: the wave is identical for every profile (only the
 * playback frequency differs) and PeriodicWave objects are immutable.
 */
const BLADE_CACHE = new WeakMap();

function bladeWave(ctx) {
  const hit = BLADE_CACHE.get(ctx);
  if (hit) return hit;
  const N = 10;
  const real = new Float32Array(N + 1);
  const imag = new Float32Array(N + 1);
  for (let k = 1; k <= N; k++) {
    const odd = (k % 2) ? 1.25 : 0.8;
    imag[k] = (1 / Math.pow(k, 1.4)) * odd;
  }
  const w = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  BLADE_CACHE.set(ctx, w);
  return w;
}

/**
 * Surge envelope: one burst per cycle of the driving sawtooth.
 *
 * A WaveShaper is a memoryless map, and a sawtooth sweeps its input across the
 * whole curve exactly once per cycle. So a curve that rises fast and then
 * decays IS an attack/decay envelope generator, at zero per-event cost and with
 * a rate set by one oscillator frequency.
 *
 * 6 % rise, exponential tail. The sharp leading edge is the "st" and the tail
 * is the "tu"; a symmetric or sinusoidal shape here gives tremolo instead, and
 * that was the old "shoo-shoo-shoo" problem.
 *
 * Output is 0..1, never negative — this drives a gain, and a negative envelope
 * would invert the noise band mid-burst.
 */
/**
 * Soft ASYMMETRIC saturation, for the turbo whine.
 *
 * `tanh` is symmetric, so it generates only odd harmonics — 3f, 5f, 7f — which
 * on an already-thin tone reads as the same thinness an octave up. Pushing the
 * positive and negative halves through different amounts of curvature adds the
 * EVEN harmonics too, and it is the evens (2f in particular) that the ear reads
 * as body rather than as edge.
 *
 * @param {number} n     table size
 * @param {number} bias  0 = symmetric, 1 = one half hard and the other nearly
 *                       linear. 0.55 is enough to hear without buzzing.
 */
function grainCurve(n = 1024, bias = 0.55) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const k = x >= 0 ? 2.4 * (1 + bias) : 2.4 * (1 - bias);
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
}

function surgePulseCurve(n = 1024) {
  const c = new Float32Array(n);
  const RISE = 0.07;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);                 // maps input -1..+1 onto 0..1
    // Raised-cosine rise: still a fast onset (the "st"), but with no corner
    // for the sawtooth's band-limit ripple to fold into clicks.
    const a = t < RISE ? 0.5 - 0.5 * Math.cos(Math.PI * t / RISE) : 1;
    // Steeper tail and a true gap before the next burst: separate "stu"s,
    // not a continuous rattle.
    c[i] = a * Math.exp(-7.5 * Math.max(0, t - RISE));
  }
  return c;
}

// ===========================================================================
// 3. TransientBank
// ===========================================================================

/**
 * Voice presets. Each impact is modelled as a broadband excitation (a noise
 * source) through two resonators — the thing that was struck plus the thing it
 * rang. `mixB` sets how much of the upper resonance is heard, which is most of
 * the difference between "metallic" and "dull".
 *
 *  fA/qA  primary resonance (the impact itself)
 *  fB/qB  secondary resonance (structure ring)
 *  atk    rise time, s — an impact is essentially instantaneous
 *  dec    decay to −80 dB, s
 *  lvl    nominal level
 */
/**
 * `bus` decides where a voice is heard from, and it is not a mix choice — it is
 * a statement about where the sound is physically made.
 *
 *   combustion — fuel lighting off INSIDE the exhaust. It leaves through the
 *                tailpipe, so it must carry the same pipe resonance, the same
 *                reflections and the same muffler colour as the engine note.
 *                Routed into the exhaust waveguides.
 *   mechanical — metal hitting metal in the driveline or the gearbox. This
 *                radiates from the casing directly into the air and never goes
 *                near the exhaust at all.
 *
 * Everything used to share one output which was then partly sent to the pipe.
 * That sent gear-lash clunks down the exhaust (they do not go there) while
 * leaving pops with a large dry component (they do not arrive dry), which is
 * most of why the pops sat outside the engine rather than in it.
 */
const TRANSIENT_PRESETS = Object.freeze({
  // Unburnt charge lighting off in the exhaust: a gas explosion in a pipe, so
  // low and broad, with the pipe's own ring on top.
  //
  // Twice corrected, and the second correction is the interesting one.
  //
  // 118/780 stood clear of everything after MODE_SURVIVAL dropped the exhaust's
  // centroid to ~199 Hz (#31), so both combustion presets came down an octave.
  // That fixed the detachment and went too far: measured, the crackle's share
  // of energy above 700 Hz fell from 71 % to 3 %, which is not "blended" but
  // "gone". A pop needs the pipe for its BODY and its own high end for its
  // DEFINITION, and the octave drop threw the second away along with the
  // problem. 112/680 and 700/1850 are the midpoint, chosen by measurement.
  bang:    Object.freeze({ bus: 'combustion', fA: 112,  qA: 1.6, fB: 680,  qB: 2.0, mixB: 0.58, atk: 0.0050, dec: 0.190, lvl: 1.0 }),
  // The little ones that follow it: brighter, shorter, quieter, and the part
  // that carries a pop's definition. 850/1900 put half of it inside the 2-6 kHz
  // band; 430/1150 removed it from the mix entirely. 700/1850 keeps the top of
  // the band under 2 kHz while restoring the crackle's edge.
  crackle: Object.freeze({ bus: 'combustion', fA: 700,  qA: 3.0, fB: 1850, qB: 3.6, mixB: 0.62, atk: 0.0030, dec: 0.055, lvl: 0.5 }),
  // Backlash take-up: two hardened steel faces colliding.
  //
  // This was 1150/3100 Hz at Q 22/16 with a 0.8 ms attack, which is not a
  // driveline clunk — it is a CLICK, and it was the most out-of-place sound in
  // the mix. Three things were wrong. A propshaft and diff are heavy castings
  // bolted into a body shell, so the impact radiates a dull low-mid thunk, not
  // a 1-3 kHz ping. They are also full of oil and clamped at both ends, so
  // their modes are damped — Q around 6-8, not 22, which is a ringing tone.
  // And an impact between two large masses is not instantaneous: the contact
  // patch takes milliseconds to develop, so a sub-millisecond attack reads as
  // a switch clicking rather than as metal landing.
  //
  // It matters more now than it used to: once the exhaust's centroid dropped to
  // ~199 Hz (ledger #31) anything left up at 1-3 kHz stands alone in the mix,
  // which is the same trap the crackle fell into (#38).
  clunk:   Object.freeze({ bus: 'mechanical', fA: 330,  qA: 7.0, fB: 1250, qB: 6.0, mixB: 0.45, atk: 0.0035, dec: 0.075, lvl: 0.62 }),
  // Clutch bite: a big soft mass being grabbed. Low, dull, comparatively long.
  thump:   Object.freeze({ bus: 'mechanical', fA: 95,   qA: 2.2, fB: 320,  qB: 3.0, mixB: 0.35, atk: 0.0040, dec: 0.130, lvl: 0.8 }),
  // Selector fork / synchro detent. A small steel detent inside a sealed
  // aluminium case, heard through that case and then through a bulkhead —
  // 3.2/6.4 kHz was the sound of the bare detent with none of that in the way,
  // and it sat right in the band the ear is most sensitive to. Darker, softer
  // and much quieter: it should be a hint that a lever moved, not an event.
  click:   Object.freeze({ bus: 'mechanical', fA: 1500, qA: 5.0, fB: 2800, qB: 6.0, mixB: 0.40, atk: 0.0018, dec: 0.020, lvl: 0.16 }),
});

/**
 * Shared, pre-built, zero-allocation one-shot event player.
 *
 * POOL LAYOUT
 *   `opts.voices` voices, default 8. Each voice is
 *
 *       looping noise source ──┬── bandpass A ─────────────┐
 *                              └── bandpass B ── mix B ────┴── voice gain ── out
 *
 *   All of it is built in the constructor. Triggering a sound writes six
 *   AudioParam values at a scheduled time and nothing else — no node creation,
 *   no connect, no allocation, not even a temporary object. Each voice's source
 *   starts at a different offset in the shared noise buffer so simultaneous
 *   voices are decorrelated.
 *
 * WHY 8
 *   The densest realistic moment is an overrun crackle burst: ~12 pops/s at a
 *   mean decay of 40 ms is ~0.5 voices busy on average, and an ignition-cut
 *   bang burst adds up to 7 events spread over 220 ms. Eight voices covers that
 *   with headroom while costing ~48 nodes total.
 *
 * OVERFLOW
 *   `trigger()` first looks for a voice that is free at the scheduled time. If
 *   every voice is busy it STEALS the one that will finish soonest (the oldest
 *   sound), cancelling its remaining schedule at the new event time and
 *   restarting it there. Stealing is audible only as a slightly shortened tail
 *   on the oldest, quietest event, which is the least bad option: the
 *   alternatives are dropping the new event (loses the transient you most want
 *   to hear) or allocating (forbidden by the contract). `stolen` is counted on
 *   the instance for diagnostics.
 */
export class TransientBank {
  /**
   * @param {object} [opts]
   *   voices          pool size, default 8
   *   level           overall trim, default 1
   *   overrunCrackle  enable DFCO crackle, default true
   *   lookahead       schedule offset from p.now, default 0.004 s
   *   maxPerFrame     hard cap on events scheduled in one update(), default 18
   */
  constructor(ctx, profile, opts) {
    this.ctx = ctx;
    const o = opts || {};
    this.level = fin(o.level, 1);
    this.lookahead = clamp(fin(o.lookahead, LOOKAHEAD), 0, 0.05);
    this.overrunCrackle = o.overrunCrackle !== false;
    this.maxPerFrame = clamp(Math.round(fin(o.maxPerFrame, 18)), 1, 48);

    this.stolen = 0;          // diagnostics: how many times the pool overflowed
    this.fired = 0;
    this._next = 0;           // round-robin cursor
    this._nextPop = 0;        // next scheduled overrun crackle, audio clock
    this._prevPhase = '';
    this._syncClicks = 0;
    this._rnd = seeded(0x2545f491);

    this._srcs = [];
    this._nodes = [];
    const keep = (n) => { this._nodes.push(n); return n; };

    // Two outputs, because a pop and a clunk are made in different places.
    // `out` is the direct/mechanical path; `combOut` carries the combustion
    // voices, which the orchestrator feeds into the exhaust waveguides so they
    // come out of the tailpipe with the pipe's colour on them.
    this.out = keep(ctx.createGain());
    this.combOut = keep(ctx.createGain());
    /**
     * Makeup for bandpass insertion loss.
     *
     * Each voice is white noise through two narrow bandpasses, and a 2nd-order
     * bandpass passes only ~(pi/2)(f/Q) of the spectrum. Measured analytically
     * against a 24 kHz Nyquist that is -20.5 dB for 'bang', -19.8 dB for
     * 'clunk', -14.5 dB for 'crackle' — while the wavetable oscillators driving
     * the engine note are full-scale, 0 dB. So a transient scheduled at "gain
     * 1.0" was really arriving about ten times quieter than the number implied,
     * and no amount of tuning the amplitude could close that gap. This restores
     * the loss so the scheduled amplitude means what it says.
     */
    this.makeup = clamp(fin(o.makeup, 9), 1, 40);
    this.out.gain.value = this.level * this.makeup;
    this.combOut.gain.value = this.level * this.makeup;

    // The pool is PARTITIONED by bus rather than routed per event. A voice is
    // wired to exactly one output for its whole life, so routing costs no nodes
    // and no per-event parameter writes — and a combustion burst can never
    // starve the clunk that has to land in the middle of it.
    const count = clamp(Math.round(fin(o.voices, 16)), 2, 40);
    const nComb = Math.max(1, Math.round(count * 0.62));
    this.voices = new Array(count);
    this.pools = { combustion: [], mechanical: [] };
    this._cursor = { combustion: 0, mechanical: 0 };

    for (let i = 0; i < count; i++) {
      const src = noiseSource(ctx, 'white', (i * 0.137) % 1.9);
      this._srcs.push(src);

      const bpA = keep(ctx.createBiquadFilter());
      bpA.type = 'bandpass'; bpA.frequency.value = 1000; bpA.Q.value = 6;
      const bpB = keep(ctx.createBiquadFilter());
      bpB.type = 'bandpass'; bpB.frequency.value = 3000; bpB.Q.value = 8;
      const mixB = keep(ctx.createGain());
      mixB.gain.value = 0.5;
      const gain = keep(ctx.createGain());
      gain.gain.value = 0;

      const bus = i < nComb ? 'combustion' : 'mechanical';
      src.connect(bpA); src.connect(bpB);
      bpA.connect(gain);
      bpB.connect(mixB); mixB.connect(gain);
      gain.connect(bus === 'combustion' ? this.combOut : this.out);

      const v = { bpA, bpB, mixB, gain, busyUntil: -1, bus };
      this.voices[i] = v;
      this.pools[bus].push(v);
    }

    this.setProfile(profile);
  }

  get input() { return null; }
  /** Mechanical transients — clunks, thumps, clicks. Heard directly. */
  get output() { return this.out; }
  /** Combustion transients — pops and bangs. Feed this INTO the exhaust. */
  get combustionOutput() { return this.combOut; }

  setProfile(profile) {
    this.profile = profile;
    const cyl = clamp(fin(profile && profile.cylinders, 6), 1, 16);
    this.cyl = cyl;
    this.idleRpm = fin(profile && profile.idleRpm, 800);
    // Bigger engine → bigger pipe volume and more unburnt charge per event:
    // lower in pitch, louder, and more pops per bang. A quarter-wave pipe scales
    // its resonance with 1/length, hence the fractional power on the ratio.
    this.sizeF = Math.pow(6 / cyl, 0.35);
    this.sizeA = Math.pow(cyl / 6, 0.30);
    // Reports in a shift-cut burst. Was 2 + cyl/2.2 (six on a V8), which turned
    // every gear change into a volley. A cut is one brief interruption, so what
    // comes out of the pipe is one report and at most a secondary or two.
    this.burstCount = clamp(1 + Math.round(cyl / 5), 1, 3);
  }

  /**
   * Fire one preset. Everything is scheduled on the audio clock at or after
   * `time`; nothing is allocated.
   *
   * @param {string} type   key of TRANSIENT_PRESETS
   * @param {number} time   audio-clock time (clamped to now + lookahead)
   * @param {number} amp    0..1
   * @param {number} [fScale]  multiply both resonances (engine size, variation)
   * @param {number} [decScale] multiply the decay
   */
  trigger(type, time, amp, fScale, decScale) {
    const pre = TRANSIENT_PRESETS[type] || TRANSIENT_PRESETS.click;
    const now = fin(this.ctx.currentTime, 0);
    const t = Math.max(fin(time, now), now + this.lookahead);
    // Ceiling of 4, not 1.5: a deliberate single-crack pop is meant to be
    // several times a routine transient, and the master limiter is what keeps
    // it safe rather than a clamp this far upstream.
    const peak = clamp(fin(amp, 0) * pre.lvl, 0.0008, 4);
    const fs = clamp(fin(fScale, 1), 0.2, 5);
    const dec = clamp(pre.dec * clamp(fin(decScale, 1), 0.2, 6), 0.004, 1.5);
    const end = t + pre.atk + dec + 0.002;

    // Pick a free voice from THIS preset's bus, else steal the one in that bus
    // that finishes soonest. Never cross buses: a stolen voice is wired to a
    // different output, so it would come out of the wrong place.
    const bus = pre.bus === 'combustion' ? 'combustion' : 'mechanical';
    const pool = this.pools[bus];
    const n = pool.length;
    let idx = -1;
    for (let k = 0; k < n; k++) {
      const i = (this._cursor[bus] + k) % n;
      if (pool[i].busyUntil <= t) { idx = i; break; }
    }
    if (idx < 0) {
      let best = 0;
      for (let i = 1; i < n; i++) {
        if (pool[i].busyUntil < pool[best].busyUntil) best = i;
      }
      idx = best;
      this.stolen++;
    }
    this._cursor[bus] = (idx + 1) % n;
    const v = pool[idx];

    v.bpA.frequency.cancelScheduledValues(t);
    v.bpA.frequency.setValueAtTime(hzOf(pre.fA * fs, 1000), t);
    v.bpA.Q.setValueAtTime(fin(pre.qA, 4), t);
    v.bpB.frequency.cancelScheduledValues(t);
    v.bpB.frequency.setValueAtTime(hzOf(pre.fB * fs, 3000), t);
    v.bpB.Q.setValueAtTime(fin(pre.qB, 6), t);
    v.mixB.gain.cancelScheduledValues(t);
    v.mixB.gain.setValueAtTime(fin(pre.mixB, 0.5), t);

    const g = v.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0004, t);
    g.linearRampToValueAtTime(peak, t + pre.atk);
    g.exponentialRampToValueAtTime(0.0004, t + pre.atk + dec);
    g.setValueAtTime(0, end);

    v.busyUntil = end;
    this.fired++;
    return idx;
  }

  update(p) {
    const now = fin(p.now, 0);
    const rpm = Math.max(0, fin(p.rpm, 0));
    const rpmNorm = clamp(fin(p.rpmNorm, 0), 0, 1);
    const rnd = this._rnd;
    let budget = this.maxPerFrame;

    // --- ignition cut → exhaust bang ---------------------------------------
    // A cut does not make one pop: raw charge keeps arriving in the pipe and
    // lights off irregularly for a couple of hundred milliseconds. Bigger
    // engines throw more of it, lower and louder.
    const cut = clamp(fin(p.evCut, 0), 0, 1);
    if (cut > 0 && budget > 0) {
      const count = Math.min(budget, this.burstCount);
      let t = now + this.lookahead + rnd() * 0.008;
      for (let i = 0; i < count; i++) {
        // First report is the big one; the rest are decaying secondaries.
        const fall = Math.pow(0.72, i) * (0.55 + 0.65 * rnd());
        const amp = clamp(0.55 * cut * this.sizeA * fall * (0.5 + 0.7 * rpmNorm), 0.001, 1);
        const type = i === 0 ? 'bang' : (rnd() < 0.45 ? 'bang' : 'crackle');
        this.trigger(type, t, amp, this.sizeF * (0.75 + 0.6 * rnd()), 0.7 + 0.8 * rnd());
        t += 0.012 + rnd() * 0.048;        // irregular, 12–60 ms apart
        budget--;
      }
    }

    // --- deliberate exhaust pop / bang --------------------------------------
    // Fired by the drivetrain at the two moments raw fuel meets a hot pipe:
    // entering fuel cut on a lift, and the trailing edge of a downshift
    // rev-match blip. The burst SHAPE is where the character lives — a big V8
    // throws one heavy report with a couple of lazy secondaries, a small
    // high-revving four spits a fast irregular string of them.
    const popEv = clamp(fin(p.evPop, 0), 0, 1);
    if (popEv > 0 && budget > 0) {
      // THE SHAPE OF THE BURST IS THE CHARACTER, and the shape has to vary
      // between events or the ear learns the pattern within about four lifts
      // and everything after that sounds like the same sample retriggering.
      //
      // Three genuinely different gestures, drawn per event rather than
      // interpolated, because they are different physical outcomes:
      //
      //   crack   one hard report. All the charge lights at once. Loudest.
      //   double  a report and one lazy secondary — the most common real one.
      //   stutter a short irregular string as pockets of charge light in turn.
      //
      // Weighting shifts with event size: a small event rarely has enough fuel
      // to stutter, a big one rarely gets through it all in a single crack.
      const roll = rnd();
      const bigness = 0.5 * popEv + 0.5 * rpmNorm;
      let shape;
      if (roll < 0.34 - 0.16 * bigness) shape = 'crack';
      else if (roll < 0.80 - 0.10 * bigness) shape = 'double';
      else shape = 'stutter';

      const maxRun = clamp(Math.round(
        (1.0 + 6 / Math.max(3, this.cyl)) * (0.6 + 0.7 * rnd())), 2, 3);
      const spread = shape === 'crack' ? 1 : shape === 'double' ? 2 : maxRun;
      const count = Math.min(budget, spread);

      // A single crack puts the whole event into one report, so it has to be
      // louder than the first of a string or it reads as weaker, not punchier.
      const punch = shape === 'crack' ? 2.6 : shape === 'double' ? 2.0 : 1.6;

      // Per-EVENT size draw, on top of the per-report jitter. Without this the
      // only thing separating one lift from another is rpm, so every pop at a
      // given speed came out the same size. Skewed low (squared) so most are
      // ordinary and the occasional one is a bang — which is how it actually
      // goes.
      const size = 0.42 + 1.05 * rnd() * rnd();

      let t = now + this.lookahead + rnd() * 0.006;
      for (let i = 0; i < count; i++) {
        // Not a clean decay: real bursts stutter, and an occasional late one is
        // louder than the one before it.
        const fall = Math.pow(0.86, i) * (0.6 + 0.8 * rnd());
        // Ceiling 3, not 1: the 2.6x single-crack punch was being clamped away
        // right here, so every "gunshot" arrived as an ordinary pop. Effective
        // audio level is amp x makeup(9) x bandpass loss(0.114). The master
        // limiter, not this clamp, is what keeps it safe.
        const amp = clamp(punch * size * popEv * this.sizeA * fall
          * (0.5 + 0.65 * rpmNorm), 0.001, 2);
        const type = i === 0 ? 'bang' : (rnd() < 0.5 ? 'bang' : 'crackle');
        // Bigger events sit lower — more gas, longer column, deeper report.
        const fScale = this.sizeF * (0.62 + 0.7 * rnd()) * (1 - 0.22 * popEv);
        this.trigger(type, t, amp, fScale, 0.7 + 0.9 * rnd());
        // Gaps scale with engine size: big engines pop slower. A stutter runs
        // tighter than a lazy double.
        const gapScale = shape === 'stutter' ? 0.55 : 1;
        t += (0.055 + rnd() * 0.16) * (0.6 + 4 / Math.max(3, this.cyl)) * gapScale;
        budget--;
      }
    }

    // --- driveline backlash → metallic clunk --------------------------------
    const lash = clamp(fin(p.evLash, 0), 0, 1);
    if (lash > 0 && budget > 0) {
      const t = now + this.lookahead;
      this.trigger('clunk', t, clamp(0.5 * lash, 0.001, 1), 0.9 + 0.25 * rnd(), 0.8 + 0.5 * lash);
      budget--;
      // The teeth bounce once as they settle onto the drive flank.
      if (lash > 0.35 && budget > 0) {
        this.trigger('clunk', t + 0.018 + rnd() * 0.012, clamp(0.16 * lash, 0.001, 1), 1.3, 0.5);
        budget--;
      }
    }

    // --- clutch engagement thump -------------------------------------------
    const eng = clamp(fin(p.evEngage, 0), 0, 1);
    if (eng > 0 && budget > 0) {
      this.trigger('thump', now + this.lookahead, clamp(0.45 * eng, 0.001, 1), 1, 0.8 + 0.6 * eng);
      budget--;
    }

    // --- gear lever / synchro click ----------------------------------------
    const phase = p.shiftPhase || '';
    if (phase === 'sync') {
      if (this._prevPhase !== 'sync') {
        this._syncClicks = 0;
        this._syncNext = now;
      }
      // ONE click, not two. Two detent clicks 35 ms apart on every single gear
      // change is a mechanism announcing itself; a driver hears the lever land
      // once, if at all, under everything else that is happening during a shift.
      if (this._syncClicks < 1 && now >= fin(this._syncNext, now) && budget > 0) {
        this.trigger('click', now + this.lookahead, 0.30 + 0.22 * rnd(), 0.85 + 0.4 * rnd(), 1);
        this._syncClicks++;
        this._syncNext = now + 0.035 + rnd() * 0.03;
        budget--;
      }
    } else if (this._prevPhase === 'sync') {
      this._syncClicks = 0;
    }
    this._prevPhase = phase;

    // --- overrun crackle ----------------------------------------------------
    // Poisson-ish stream while the fuel is cut and the pipe is hot. Scheduled
    // ahead on the audio clock, with a hard horizon and a per-frame budget so
    // the queue can never run away if the frame clock stalls.
    const overrun = clamp(fin(p.overrun, 0), 0, 1);
    // popIntensity already encodes the physics: exhaust gas temperature (a cold
    // pipe cannot ignite anything), how much raw fuel is actually in the pipe,
    // and how recently the injectors switched state — because a STEADY fuel cut
    // has no fuel to burn, and it is the transitions that pop. Fall back to the
    // old overrun-only behaviour if the drivetrain does not supply it.
    const pop = p.popIntensity != null
      ? clamp(fin(p.popIntensity, 0), 0, 1)
      : overrun * 0.55;
    // Threshold raised from 0.02: a near-zero intensity was still trickling out
    // events forever, which is the "constant crackle that sounds like a bug".
    // Raised again to 0.30 — at 0.18 the stream ran on almost every overrun, so
    // the deliberate lift-off bang always landed on a bed of crackle instead of
    // into silence, and the two together read as "it pops constantly".
    const hot = this.overrunCrackle && pop > 0.30 && rpm > this.idleRpm * 1.5 && !p.shifting;
    if (!hot) {
      this._nextPop = now;
      return;
    }
    if (this._nextPop < now) this._nextPop = now + 0.01 + rnd() * 0.04;

    const horizon = now + 0.12;
    // Events per second: more cylinders → more charge events, more rpm → faster.
    // Halved from 2.4: combined with the lower threshold above, the stream was
    // dense enough to be continuous rather than intermittent, and a continuous
    // crackle is a texture, not an event.
    const rate = 0.35 + 1.2 * pop * (0.35 + 0.65 * rpmNorm) * (this.cyl / 6);
    while (this._nextPop < horizon && budget > 0) {
      const t = Math.max(this._nextPop, now + this.lookahead);
      // Wide amplitude spread, skewed low. A stream of same-sized ticks reads
      // as a machine; real overrun crackle is mostly faint with the occasional
      // one that actually cracks.
      const amp = clamp(0.30 * pop * this.sizeA * (0.25 + 1.5 * rnd() * rnd())
        * (0.45 + 0.55 * rpmNorm), 0.001, 1);
      this.trigger(rnd() < 0.4 ? 'bang' : 'crackle', t, amp,
        this.sizeF * (0.7 + 0.9 * rnd()), 0.6 + 0.9 * rnd());
      // Gaps drawn from a wider range so the stream is genuinely irregular
      // rather than a jittered metronome.
      this._nextPop = t + (0.25 + 2.2 * rnd() * rnd()) / Math.max(0.4, rate);
      budget--;
    }
    // If the budget ran out, make sure we do not re-schedule the past next frame.
    if (this._nextPop < now) this._nextPop = now;
  }

  /** Start this layer's oscillators. Noise sources are already running. */
  start(t) { startAll(this._srcs, t); }

  dispose() {
    const now = fin(this.ctx.currentTime, 0);
    stopAll(this._srcs, now);
    disconnectAll(this._nodes);
    this._srcs.length = 0;
    this.voices.length = 0;
  }
}

export { TRANSIENT_PRESETS, sharedNoise };
