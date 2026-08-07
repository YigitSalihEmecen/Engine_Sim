/**
 * physics.js — vehicle drivetrain with a COMPLIANT driveline.
 *
 * v1 computed engine speed kinematically: rpm = speed/r * ratio. That makes the
 * drivetrain infinitely rigid, so a gear change is a step change in rpm and it
 * sounds exactly like what it is — a pitch jump. This module replaces that with
 * the model the driveline "clunk & shuffle" literature uses: lumped inertias
 * joined by a torsional spring-damper with a backlash dead-band.
 *
 *   Je   engine + flywheel            (profile.engineInertia)
 *          | clutch: Coulomb friction, capacity * engagement, stick/slip
 *   Jin  clutch disc + input shaft
 *          | gearbox: rigid ratio when in gear, disconnected in neutral
 *   Jout output shaft + propshaft
 *          | TORSIONAL SPRING with BACKLASH  (DRIVELINE_DEFAULTS)
 *   Jv   wheels + vehicle, reflected through the final drive
 *
 * Everything the brief asks for falls out of that structure rather than being
 * bolted on:
 *
 *   lash   torque reversal (every lift, every shift) drags the relative angle
 *          across +/-backlash with NOTHING transmitted, then the teeth meet.
 *          The impact velocity at that moment is `evLash`. It is detected, not
 *          scripted, so it also fires on lift-off, on tip-in and on a brake
 *          release — and, because contact is latched with hysteresis, not
 *          continuously.
 *   shuffle after contact the spring rings at the first torsional mode. See
 *          `modeHz(gear)`: ~8.4 Hz in 1st for a hot hatch, ~4.9 Hz for the
 *          truck, rising into the high twenties in top gear because the engine
 *          inertia referred to the output shrinks with ratio^2. That is why
 *          shunt is a first/second gear problem in real cars.
 *   slip   engine and gearbox are separate inertias with a finite friction
 *          capacity between them, so during engagement rpm CONVERGES. It never
 *          jumps, in any gearbox type.
 *
 * Integration: semi-implicit (symplectic) Euler on a fixed 0.5 ms sub-step.
 * See `stabilityReport()` for why 0.5 ms and not v1's 5 ms.
 *
 * Carried over from v1 unchanged in behaviour: the torque-curve shape, the
 * quadratic engine-friction term (deliberate and tuned — it is what makes a
 * high-revving engine fall back to idle in about a second), the bouncing rev
 * limiter, the aero/rolling/brake road load, the automatic shift strategy and
 * its over-rev guard (now in shift.js), and sub-stepping.
 */

import { DRIVELINE_DEFAULTS } from './profiles.js';
import { ShiftController } from './shift.js';

const RPM_PER_RADS = 60 / (2 * Math.PI);
const RADS_PER_RPM = (2 * Math.PI) / 60;
const RHO_AIR = 1.225;
const G = 9.81;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Fixed physics sub-step, seconds.
 *
 * The binding constraint is NOT the in-gear torsional mode (that peaks around
 * 200 rad/s = 32 Hz in top gear, needing dt < 10 ms) but the damper acting on
 * the output shaft alone while the gearbox is in neutral mid-shift:
 *   c / Jout = 34 / 0.02 = 1700 s^-1  ->  explicit stability needs dt < 1.18 ms
 * and the corresponding undamped mode is sqrt(k/Jout) = 510 rad/s = 81 Hz,
 * needing dt < 3.9 ms. 0.5 ms clears both with >2x margin and puts <= 0.26 rad
 * of phase per step on the fastest mode, so the frequencies come out right and
 * not just stable. At 60 fps that is 34 sub-steps of pure arithmetic per frame.
 */
const SUBSTEP = 1 / 2000;
const MAX_SUBSTEPS = 240;          // dt is clamped to 0.1 s, so this is slack

/** Inertias not present in profiles.js, kg.m^2. Physically motivated: */
const J_INPUT_DEFAULT = 0.030;     // clutch disc + gearbox input shaft
const J_OUTPUT_DEFAULT = 0.020;    // gearbox output shaft + propshaft
const WHEEL_J_PER_R2 = 4 * 13;     // 4 wheels, J ~ 0.65 * 20 kg * r^2 each

/** Lash-impact gating. */
const LASH_MIN_VEL = 0.20;         // rad/s below which contact is silent
// rad/s that maps to evLash = 1. Anchored to measurement, not guessed: routine
// lift-off/reapply contacts land at a median of 5.5 rad/s and hard gear-drops at
// 7-13, so 15 is a genuine worst case. At the old value of 3.0 almost every
// contact saturated the scale and every one of them was a maximum-force clunk.
const LASH_REF_VEL = 15.0;
// Radiated energy of an impact goes with velocity, so amplitude follows roughly
// v^1.5 (Hertzian contact), not v. This matters: once the driveline is lightly
// damped the shuffle legitimately re-crosses the backlash several times, and a
// linear law with a floor made every one of those a full clunk. With the
// exponent the first contact is the bang and the rest are inaudible taps —
// which is what a real driveline does.
const LASH_VEL_EXP = 1.5;
const LASH_REARM = 0.030;          // s of enforced silence after an impact
const LASH_RELEASE = 0.85;         // must fall to 85% of backlash to re-arm

export class Drivetrain {
  /**
   * @param {object} engine  an ENGINE_PROFILES entry
   * @param {object} vehicle a VEHICLE_PRESETS entry
   * @param {object} [opts]
   *   driveline        overrides for DRIVELINE_DEFAULTS
   *   driveEfficiency  default 0.92
   *   inputInertia / outputInertia
   *   subStep          seconds, default 1/2000
   *   autoShift        default true
   *   launchFlareRpm   rpm above idle the driver holds while slipping, default 2400
   */
  constructor(engine, vehicle, opts = {}) {
    this.engine = engine;
    this.vehicle = vehicle;
    this.dl = Object.assign({}, DRIVELINE_DEFAULTS, opts.driveline);

    this.eff = opts.driveEfficiency != null ? opts.driveEfficiency : 0.92;
    this.Je = Math.max(0.02, engine.engineInertia);
    this.Jin = opts.inputInertia != null ? opts.inputInertia : J_INPUT_DEFAULT;
    this.Jout = opts.outputInertia != null ? opts.outputInertia : J_OUTPUT_DEFAULT;
    this.r = vehicle.wheelRadius;
    this.fd = vehicle.finalDrive;
    this.ratios = vehicle.gearRatios;
    this.gearCount = this.ratios.length;
    this.Jv = vehicle.mass * this.r * this.r + WHEEL_J_PER_R2 * this.r * this.r;

    this.subStep = opts.subStep || SUBSTEP;
    this.launchFlareRpm = opts.launchFlareRpm != null ? opts.launchFlareRpm : 2400;

    this.shift = opts.shiftController || new ShiftController({
      type: vehicle.gearbox,
      shiftTimeMs: vehicle.shiftTimeMs,
      gearCount: this.gearCount,
      idleRpm: engine.idleRpm,
      redlineRpm: engine.redlineRpm,
      autoShift: opts.autoShift !== false,
      revMatch: opts.revMatch !== false,
    });
    this.isAuto = vehicle.gearbox === 'auto';

    // --- inputs ------------------------------------------------------------
    this.throttle = 0;
    this.brake = 0;

    // --- state -------------------------------------------------------------
    this.we = engine.idleRpm * RADS_PER_RPM;   // engine / flywheel, rad/s
    this.wg = this.we;                         // gearbox INPUT shaft, rad/s
    this.wo = 0;                               // gearbox OUTPUT shaft, rad/s
    this.ww = 0;                               // wheel, rad/s
    this.twist = 0;                            // driveline relative angle, rad
    this.dtwist = 0;                           // its rate, rad/s
    this.lash = 0;                             // position inside the dead-band
    this.contact = 0;                          // -1 / 0 / +1 which flank is loaded
    this.clutch = 0;                           // actual engagement 0..1
    this.boost = 0;                            // 0..1 of turbo.maxBoost
    this.gear = 1;

    // --- derived / bookkeeping --------------------------------------------
    this.Tp = 0;                 // transmitted driveline torque at gbox output
    this.Te = 0;                 // net engine torque
    this.Tc = 0;                 // clutch torque
    this.load = 0;
    this.overrun = 0;
    this.limiterCut = 0;         // s of fuel cut remaining
    this.limiterActive = false;
    this.lashTimer = 0;
    this.lashContactedSince = false;
    this.launchArmed = true;
    this.launchI = 0;
    this.lockup = 0;             // auto: torque-converter lockup command
    this.bovArm = 0;
    this.boostDump = 0;
    this.turboSpeed = 0;    // turbine rpm, 0..1 — distinct from boost PRESSURE

    // --- exhaust thermal state, drives realistic popping -------------------
    // Pops are unburnt fuel igniting in a HOT exhaust. Below roughly 650 C
    // nothing lights off, which is why a car that has been cruising gently does
    // not crackle and one that has just been driven hard does. egt is 0..1 over
    // an ambient-to-glowing range and has a long time constant, so it carries
    // thermal history rather than tracking instantaneous throttle.
    this.egt = 0;
    this.dfco = 0;          // 1 while injectors are actually cut
    this.dfcoEdge = 0;      // decays after a fuel-cut transition
    this.prevDfco = 0;
    this.popCharge = 0;     // unburnt fuel currently sitting in the pipe
    this.prevOverride = 0;  // last frame's rev-match blip level
    this.thrPeak = 0;       // peak-hold of recent throttle, for snap-shut detection
    this.cutRpmN = 0;       // normalised rpm at the instant fuel was cut
    this.popRefractory = 0; // s of enforced quiet after a pop event
    this.prevLimiter = false;
    this.limiterBark = 0;   // s until another limiter bark is allowed
    this.prevRpm = this.we * RPM_PER_RADS;

    // --- shift-controller command block (written every sub-step) ----------
    this.gearboxNeutral = false;
    this.syncing = false;
    this.syncTargetW = 0;
    this.clutchCmd = null;
    this.clutchRate = 0;
    this.fuelCut = 0;
    this.throttleOverride = null;
    this.shiftPhase = '';
    this.shifting = false;

    // --- one-frame event accumulators -------------------------------------
    this.ev = { cut: 0, lash: 0, engage: 0, bov: 0, shiftDone: 0, pop: 0 };

    // --- the params object. Allocated ONCE; step() mutates it in place. ----
    this.params = {
      now: 0, dt: 0,
      rpm: 0, f0: 0, rpmNorm: 0, dRpm: 0,
      throttle: 0, load: 0, overrun: 0, torqueSign: 1,
      gear: 1, gearRatio: 0, speed: 0, wheelRpm: 0,
      clutchSlip: 0, clutchEngaged: 0,
      boost: 0, shifting: false, shiftPhase: '',
      evCut: 0, evLash: 0, evEngage: 0, evBov: 0, evShiftDone: 0, evPop: 0,
    };

    // Settle the clutch so a Drivetrain constructed in gear at rest behaves
    // like a car with the clutch in, not one about to stall.
    this.clutch = 0;
    this._writeParams(0, 0);
  }

  // =========================================================================
  // Inputs
  // =========================================================================

  setThrottle(v) { this.throttle = clamp(Number(v) || 0, 0, 1); }
  setBrake(v) { this.brake = clamp(Number(v) || 0, 0, 1); }

  /**
   * Swap the engine while driving. Only the engine-derived constants change;
   * road speed, gear and driveline wind-up are all preserved, so the car keeps
   * moving through the change. Engine speed is re-clamped into the new rev
   * range because the incoming engine may idle or redline somewhere else.
   */
  setEngine(engine) {
    this.engine = engine;
    this.Je = Math.max(0.02, engine.engineInertia);
    this.shift.idleRpm = engine.idleRpm;
    this.shift.redlineRpm = engine.redlineRpm;
    const rpm = clamp(this.we * RPM_PER_RADS, engine.idleRpm, engine.redlineRpm);
    this.we = rpm * RADS_PER_RPM;
    this.prevRpm = rpm;
    this.boost = 0;                 // the new engine may not even have a turbo
    this.limiterCut = 0;
    this.limiterActive = false;
  }

  /**
   * Swap the vehicle while driving. Gear ratios and mass change, so the gear is
   * re-clamped and the driveline is released rather than left wound up against
   * a ratio that no longer exists.
   */
  setVehicle(vehicle) {
    // `speed` is a getter over wheel omega, so capture the road speed BEFORE the
    // wheel radius changes or the car would teleport in velocity.
    const roadSpeed = this.speed;
    this.vehicle = vehicle;
    this.r = vehicle.wheelRadius;
    this.fd = vehicle.finalDrive;
    this.ratios = vehicle.gearRatios;
    this.gearCount = this.ratios.length;
    this.Jv = vehicle.mass * this.r * this.r + WHEEL_J_PER_R2 * this.r * this.r;
    this.isAuto = vehicle.gearbox === 'auto';

    this.shift.type = vehicle.gearbox;
    this.shift.gearCount = this.gearCount;
    if (this.shift.setTiming) this.shift.setTiming(vehicle.shiftTimeMs);
    this.shift.reset();

    this.gear = clamp(Math.round(this.gear), 0, this.gearCount);
    this.ww = roadSpeed / this.r;
    this.wo = this.ww * this.fd;
    this.twist = 0; this.dtwist = 0; this.contact = 0;
  }
  setAutoShift(on) { this.shift.autoShift = !!on; }

  shiftUp() {
    if (this.gear >= this.gearCount) return false;
    return this.shift.request(this, this.gear + 1, true);
  }

  shiftDown() {
    if (this.gear <= 1) return false;
    return this.shift.request(this, this.gear - 1, true);
  }

  /** @param {number} n 0 = neutral, 1..N */
  setGear(n) { return this.shift.request(this, n, true); }

  // =========================================================================
  // Helpers the shift controller uses (duck-typed interface)
  // =========================================================================

  get rpm() { return this.we * RPM_PER_RADS; }
  get speed() { return this.ww * this.r; }
  get gearRatio() { return this.gear > 0 ? this.ratios[this.gear - 1] : 0; }
  get totalRatio() { return this.gear > 0 ? this.ratios[this.gear - 1] * this.fd : 0; }

  /** Engine rpm the wheels would impose in gear `g` right now. */
  gearedRpm(g) {
    if (g <= 0 || g > this.gearCount) return 0;
    return Math.abs(this.ww) * this.fd * this.ratios[g - 1] * RPM_PER_RADS;
  }

  /** Input-shaft speed the synchroniser must reach for gear `g`, rad/s. */
  inputShaftTargetW(g) {
    if (g <= 0 || g > this.gearCount) return 0;
    return this.ww * this.fd * this.ratios[g - 1];
  }

  selectGear(g) { this.gear = clamp(Math.round(g), 0, this.gearCount); }

  fireEvent(name, mag) {
    if (!(mag > this.ev[name])) return;
    this.ev[name] = mag > 1 ? 1 : mag;
  }

  // =========================================================================
  // Reporting helpers — used by the tests and by anyone tuning the driveline
  // =========================================================================

  /** Effective inertia of the gearbox side referred to the OUTPUT shaft. */
  _JoutSide(gear, clutchLocked = true) {
    if (gear <= 0) return this.Jout;
    const rg = this.ratios[gear - 1];
    const upstream = clutchLocked ? this.Je + this.Jin : this.Jin;
    return upstream * rg * rg + this.Jout;
  }

  /** Vehicle inertia referred to the gearbox output shaft. */
  _JvehOut() { return this.Jv / (this.fd * this.fd); }

  /** First torsional mode, rad/s, for a gear (clutch locked). */
  modeW(gear, clutchLocked = true) {
    const J1 = this._JoutSide(gear, clutchLocked);
    const J2 = this._JvehOut();
    return Math.sqrt(this.dl.stiffness * (1 / J1 + 1 / J2));
  }

  modeHz(gear, clutchLocked = true) { return this.modeW(gear, clutchLocked) / (2 * Math.PI); }

  /** Damping ratio of that mode. < 1 rings, > 1 just relaxes. */
  modeZeta(gear, clutchLocked = true) {
    if (this.dl.dampingRatio != null) return this.dl.dampingRatio;
    const Jred = this._Jred(gear, clutchLocked);
    return this.dl.damping / (2 * Math.sqrt(this.dl.stiffness * Jred));
  }

  /** Reduced inertia of the two-mass torsional system, at the gearbox output. */
  _Jred(gear, clutchLocked = true) {
    const J1 = this._JoutSide(gear, clutchLocked);
    const J2 = this._JvehOut();
    return 1 / (1 / J1 + 1 / J2);
  }

  /**
   * Damper coefficient for the CURRENT gear. Derived from the target damping
   * ratio so every gear rings the same amount: c = 2·zeta·sqrt(k·J_reduced).
   * A fixed coefficient cannot do this — J_reduced varies by ~20x across the
   * gearbox, so any single value is either dead at one end or wobbly at the other.
   */
  _dampCoeff() {
    if (this.dl.dampingRatio == null) return this.dl.damping;
    const locked = this.clutch > 0.5 && !this.gearboxNeutral;
    const Jred = this._Jred(this.gear > 0 ? this.gear : 1, locked);
    const c = 2 * this.dl.dampingRatio * Math.sqrt(this.dl.stiffness * Math.max(1e-4, Jred));
    return clamp(c, 1, 400);
  }

  /** Everything needed to justify the sub-step choice. */
  stabilityReport() {
    let worstW = 0, worstWhere = '';
    for (let g = 1; g <= this.gearCount; g++) {
      for (const locked of [true, false]) {
        const w = this.modeW(g, locked);
        if (w > worstW) { worstW = w; worstWhere = `gear ${g} clutch ${locked ? 'locked' : 'open'}`; }
      }
    }
    const neutralW = Math.sqrt(this.dl.stiffness / this.Jout);
    if (neutralW > worstW) { worstW = neutralW; worstWhere = 'gearbox neutral (output shaft alone)'; }
    const dampRate = this.dl.damping / this.Jout;      // fastest 1st-order pole
    return {
      subStep: this.subStep,
      worstModeRadS: worstW,
      worstModeHz: worstW / (2 * Math.PI),
      worstModeWhere: worstWhere,
      stableBelowSpring: 2 / worstW,
      stableBelowDamper: 2 / dampRate,
      phasePerStepRad: worstW * this.subStep,
      marginSpring: (2 / worstW) / this.subStep,
      marginDamper: (2 / dampRate) / this.subStep,
    };
  }

  getState() {
    return {
      rpm: this.rpm, speed: this.speed, speedKmh: this.speed * 3.6,
      gear: this.gear, throttle: this.throttle, brake: this.brake,
      twist: this.twist, contact: this.contact, clutch: this.clutch,
      Tp: this.Tp, boost: this.boost, phase: this.shiftPhase,
      shifting: this.shifting, limiter: this.limiterActive,
      gearCount: this.gearCount, redline: this.engine.redlineRpm,
      idle: this.engine.idleRpm,
    };
  }

  // =========================================================================
  // Engine
  // =========================================================================

  /** Normalised torque shape, peaking at peakTorqueRpm. v1's curve. */
  torqueFactor(rpm) {
    const k = (rpm - this.engine.peakTorqueRpm) / (this.engine.redlineRpm * 0.75);
    return clamp(1 - 0.85 * k * k, 0.3, 1);
  }

  /**
   * Internal friction + pumping losses, N.m. v1's formula, unchanged: the
   * quadratic term is what dominates up top and makes a free-revving engine
   * drop back to idle in about a second. Scaling by (1 - 0.62*throttle) is the
   * pumping loss disappearing as the throttle plate opens.
   */
  frictionTorque(rpm, throttle) {
    return (18 + 0.012 * rpm + 2.2e-6 * rpm * rpm) * (1 - 0.62 * throttle);
  }

  // =========================================================================
  // Stepping
  // =========================================================================

  /**
   * Advance the whole drivetrain and refill the params object.
   * @param {number} deltaTime seconds
   * @param {number} [now] ctx.currentTime, copied into params.now
   * @returns {object} the (reused) params object
   */
  step(deltaTime, now = 0) {
    let dt = Number(deltaTime) || 0;
    if (dt <= 0) {
      // No time passed: no physics, and no events either. Zeroing keeps the
      // "non-zero for exactly one frame" guarantee across zero-length frames.
      this.params.now = now;
      this.params.dt = 0;
      this.params.evCut = this.params.evLash = this.params.evEngage = 0;
      this.params.evBov = this.params.evShiftDone = 0;
      return this.params;
    }
    dt = Math.min(dt, 0.1);                       // survive tab-switch spikes

    const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / this.subStep)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this._substep(h);

    this._writeParams(dt, now);
    return this.params;
  }

  _substep(h) {
    const eng = this.engine, veh = this.vehicle, dl = this.dl;

    // -------- shift controller: writes the command block ------------------
    this.lashContactedSince = false;
    this.shift.step(h, this);

    const inGear = this.gear > 0 && !this.gearboxNeutral;
    const rg = this.gear > 0 ? this.ratios[this.gear - 1] : 0;

    // -------- rev limiter (v1's, with hysteresis so it bounces) -----------
    if (this.limiterCut > 0) {
      this.limiterCut -= h;
      if (this.limiterCut <= 0 && this.rpm > eng.redlineRpm - 200) this.limiterCut = 0.012;
    } else if (this.rpm >= eng.redlineRpm) {
      this.limiterCut = 0.05;
      // NO 'cut' event here. A shift cut is a single ~100 ms interruption that
      // throws a lot of charge into the pipe and earns a full multi-pop burst.
      // A limiter cut is a 50 ms micro-cut that re-arms every 12 ms, so firing
      // the same event produced ~9 bursts a second — measured at 58 pops/s and
      // 91 cut events in 10 s while simply holding the throttle at redline.
      // The limiter's bark is handled in _stepExhaustThermal instead, as one
      // small rate-capped event.
    }
    this.limiterActive = this.limiterCut > 0;

    // -------- effective throttle ------------------------------------------
    let thr = this.throttleOverride != null ? this.throttleOverride : this.throttle;
    thr *= 1 - clamp(this.fuelCut, 0, 1);
    if (this.limiterActive) thr = 0;
    this.thrEff = thr;

    // -------- turbo: first-order lag on a spool target --------------------
    this._stepTurbo(h, thr);
    this._stepExhaustThermal(h, thr);

    // -------- engine torque ------------------------------------------------
    const rpm = this.we * RPM_PER_RADS;
    let Te = thr * eng.peakTorque * this.torqueFactor(rpm) * this._boostMult()
           - this.frictionTorque(rpm, thr);

    // Idle governor: feed-forward (exactly the friction at idle) plus a
    // proportional term, so it settles ON idleRpm instead of below it. Only
    // ever adds torque — it is an air/fuel trim, not a brake.
    if (this.throttle < 0.06 && rpm < eng.idleRpm * 1.25 && !this.limiterActive) {
      const ff = this.frictionTorque(eng.idleRpm, 0);
      const gov = ff + (eng.idleRpm - rpm) * 0.55;
      if (gov > Te) Te = gov;
    }
    this.Te = Te;

    // -------- driveline spring with backlash dead-band ---------------------
    // twist is the relative angle (gearbox output vs wheels, at the output
    // reference). Inside +/-backlash the teeth are not touching and NOTHING is
    // transmitted. Outside, the elastic deformation is (|twist| - backlash).
    const b = dl.backlash;
    const cDamp = this._dampCoeff();
    let Tp = 0;
    if (this.twist > b) {
      Tp = dl.stiffness * (this.twist - b) + cDamp * this.dtwist;
      if (Tp < 0) Tp = 0;                 // teeth push, they cannot pull
    } else if (this.twist < -b) {
      Tp = dl.stiffness * (this.twist + b) + cDamp * this.dtwist;
      if (Tp > 0) Tp = 0;
    }
    this.Tp = Tp;

    // -------- clutch command ----------------------------------------------
    this._stepClutch(h, inGear, rg);

    // -------- torque converter (auto only) --------------------------------
    let Tconv = 0, Tturb = 0;
    if (this.isAuto) {
      const c = this._converter(this.we, this.wg);
      Tconv = c.pump; Tturb = c.turbine;
    }

    // -------- gearbox-side inertia, referred to the INPUT shaft -----------
    // In gear the ratio is rigid, so the output shaft appears at the input
    // divided by rg^2 and the spring torque appears divided by rg.
    const Jgs = inGear ? this.Jin + this.Jout / (rg * rg) : this.Jin;
    let Tgs = -this._gearboxDrag(this.wg);
    if (inGear) Tgs -= Tp / rg;
    if (this.syncing) {
      // Synchroniser cone: a real one is torque limited (a driver can only push
      // so hard on the lever), which is why a fast shift into a badly matched
      // gear grinds instead of teleporting.
      const err = this.syncTargetW - this.wg;
      Tgs += clamp(err * this.Jin / 0.008, -400, 400);
    }
    Tgs += Tturb;

    // -------- clutch: stick/slip via the exact one-step constraint torque --
    // Solve for the Tc that would make we and wg equal after this step; if that
    // exceeds the friction capacity the clutch slips at capacity instead. This
    // is unconditionally stable and gives EXACT lockup with no residual buzz.
    const A = Te - Tconv;                 // engine side, excluding the clutch
    const B = Tgs;                        // gearbox side, excluding the clutch
    const Jred = (this.Je * Jgs) / (this.Je + Jgs);
    const Tcap = dl.clutchTorqueCapacity * this.clutch * this._stallGuard();
    let Tc = Jred * ((this.we - this.wg) / h + A / this.Je - B / Jgs);
    if (Tc > Tcap) Tc = Tcap; else if (Tc < -Tcap) Tc = -Tcap;
    this.Tc = Tc;

    // -------- integrate the rotating masses (semi-implicit Euler) ---------
    this.we += h * (A - Tc) / this.Je;
    this.wg += h * (B + Tc) / Jgs;

    // Engine cannot be dragged below a stall floor or pushed past the hard
    // limiter (valve float). Both are real mechanical limits, not clamps of
    // convenience — but the governor and the stall guard normally get there
    // first, so neither of these fires in normal driving.
    const wMin = eng.idleRpm * 0.42 * RADS_PER_RPM;
    const wMax = eng.redlineRpm * 1.015 * RADS_PER_RPM;
    if (this.we < wMin) this.we = wMin;
    if (this.we > wMax) this.we = wMax;

    // Output shaft: rigidly geared to the input when in gear, its own tiny
    // inertia on the end of the spring when the gearbox is in neutral.
    if (inGear) {
      this.wo = this.wg / rg;
    } else {
      this.wo += h * (-Tp - this._gearboxDrag(this.wo) * 0.5) / this.Jout;
    }

    // -------- vehicle -----------------------------------------------------
    this._stepVehicle(h, Tp);

    // -------- driveline twist ---------------------------------------------
    this.dtwist = this.wo - this.ww * this.fd;
    this.twist += h * this.dtwist;
    // Runaway guard: the wind-up needed to slip the clutch through the tallest
    // ratio is ~0.6 rad, so 3 rad can only mean an integration blow-up.
    if (!(Math.abs(this.twist) < 3)) this.twist = clamp(this.twist || 0, -3, 3);
    this.lash = clamp(this.twist, -b, b);

    // -------- lash impact detection ---------------------------------------
    this._detectLash(h, b);
  }

  // -------------------------------------------------------------------------

  _gearboxDrag(w) {
    // Churning + bearing drag. Small, but it is what spins the disconnected
    // input shaft down during the `open` phase.
    return 0.006 * w + (w > 0.5 ? 0.4 : w < -0.5 ? -0.4 : 0);
  }

  /**
   * As the engine is dragged towards stalling, a driver dips the clutch and an
   * automatic's converter simply slips more. Both reduce the torque the clutch
   * can hold. Without this the fuzz test stalls the engine in 6th at walking
   * pace, which is correct physics but not a car anyone drives.
   */
  /**
   * How much clutch torque the driver/ECU is willing to pass, as engine speed
   * approaches idle. This must start backing off ABOVE idle, not below it: at
   * 0.62/0.30 the clutch held full capacity all the way down to 0.92*idle and
   * only let go at 0.62*idle, so pulling away in too high a gear dragged the
   * engine hundreds of rpm under idle and the clutch then hunted in and out.
   * Backing off from 1.47*idle down to 0.92*idle protects the idle instead.
   */
  _stallGuard() {
    const idleW = this.engine.idleRpm * RADS_PER_RPM;
    return clamp((this.we - idleW * 0.92) / (idleW * 0.55), 0, 1);
  }

  _stepClutch(h, inGear, rg) {
    let cmd = this.clutchCmd;
    let rate = this.clutchRate;

    if (cmd == null) {
      if (this.isAuto) {
        // Lockup clutch. Off at low speed and under heavy throttle so the
        // converter can multiply torque; on at cruise so the auto does not
        // drone. The converter carries the torque either way.
        const lockOk = inGear && this.gear >= 2
          && this.gearedRpm(this.gear) > this.engine.idleRpm * 1.35
          && this.throttle < 0.85;
        cmd = lockOk ? 1 : 0;
        rate = 2.5;
      } else {
        cmd = this._launchClutch(h, inGear);
      }
    }
    if (!(rate > 0)) rate = this.dl.clutchStiffness * 12;
    // DRIVELINE_DEFAULTS.clutchStiffness (3.2) is the normalised engagement
    // rate. Taken literally it is a 310 ms actuator time constant, which is far
    // too slow for the 30-90 ms engage ramps a real box uses, so it is scaled
    // by 12 to a 26 ms hydraulic lag. That scale is the one taste-based number
    // in this file; override with opts.clutchRateScale if you disagree.
    this.clutch += (clamp(cmd, 0, 1) - this.clutch) * Math.min(1, h * rate);
    this.clutch = clamp(this.clutch, 0, 1);
  }

  /**
   * Launch / crawl clutch control.
   *
   * Below the speed at which idling in this gear would work, the clutch has to
   * slip — that is true of every manual car ever made. We model the driver as a
   * PI controller holding the engine at idle + throttle * launchFlareRpm: if the
   * engine flares above the target the clutch closes (taking more torque), if it
   * bogs the clutch opens. It converges to lockup on its own as road speed
   * catches the crank, which is exactly how a launch feels and sounds.
   */
  _launchClutch(h, inGear) {
    const idle = this.engine.idleRpm;
    const geared = this.gearedRpm(this.gear);
    if (!inGear || this.gear === 0) { this.launchI = 0; this.launchArmed = true; return 0; }

    const targetRpm = clamp(idle * 1.05 + this.throttle * this.launchFlareRpm,
                            idle, this.engine.redlineRpm * 0.9);

    // Hand over to a locked clutch only once ROAD SPEED has caught up to the rpm
    // the engine is being held at, so slip is already near zero and there is
    // nothing left to yank. Disarming on a fixed low threshold (geared > 1.15 x
    // idle, i.e. about 8 km/h) slammed the clutch shut while the engine was
    // still flaring ~1500 rpm above the gearing: the revs shot to ~3600, got
    // dragged down to ~2000, then climbed again. That is the launch "bounce".
    if (this.launchArmed && geared > targetRpm * 0.90) this.launchArmed = false;
    else if (!this.launchArmed && geared < idle * 0.95) this.launchArmed = true;

    if (!this.launchArmed) { this.launchI = 1; return 1; }

    // Stiffer than before so the engine settles ON the hold rpm instead of
    // sailing past it before the clutch catches up.
    const e = (this.rpm - targetRpm) / targetRpm;
    this.launchI = clamp(this.launchI + 45 * e * h, 0, 1);
    return clamp(this.launchI + 5.5 * e, 0, 1);
  }

  /**
   * Torque converter. Pump torque grows with the square of impeller speed and
   * collapses as the speed ratio approaches 1; the stall torque ratio of ~2 is
   * why an automatic launches so softly and why it never has a hard cut.
   * Capacity factor K chosen so stall torque at 2000 rpm is ~350 N.m.
   */
  _converter(we, wg) {
    const K = 0.008, Kr = 0.0048;
    if (we > wg + 0.5) {
      const sr = clamp(wg / Math.max(we, 1e-3), 0, 1);
      const pump = clamp(K * we * we * (1 - sr * sr), 0, 4 * this.engine.peakTorque);
      const TR = 1 + 1.0 * Math.pow(1 - sr, 1.2);
      return { pump, turbine: pump * TR };
    }
    if (wg > we + 0.5) {
      // Overrun: the turbine drives the pump. No torque multiplication, which
      // is why an automatic gives so much less engine braking than a manual.
      const sr = clamp(we / Math.max(wg, 1e-3), 0, 1);
      const t = clamp(Kr * wg * wg * (1 - sr * sr), 0, 4 * this.engine.peakTorque);
      return { pump: -t, turbine: -t };
    }
    return { pump: 0, turbine: 0 };
  }

  _stepVehicle(h, Tp) {
    const veh = this.vehicle;
    const v = this.ww * this.r;

    // Drive torque at the wheels. Efficiency only costs you on the driving
    // side; on the overrun the same losses help slow the car, so applying it
    // there too would double-count.
    const Tdrive = Tp > 0 ? Tp * this.fd * this.eff : Tp * this.fd;

    // Aero drag, always opposing motion.
    const Faero = 0.5 * RHO_AIR * veh.dragArea * v * v;
    const Taero = v > 0 ? Faero * this.r : 0;

    // Dissipative, cannot reverse the wheel or push a parked car.
    const Tres = (veh.rollingResistance * veh.mass * G + this.brake * veh.brakeForce) * this.r;

    const Tnet = Tdrive - Taero;
    if (this.ww > 1e-6) {
      const w2 = this.ww + h * (Tnet - Tres) / this.Jv;
      this.ww = w2 < 0 && Tnet < Tres ? 0 : Math.max(0, w2);
    } else {
      this.ww = Tnet > Tres ? h * (Tnet - Tres) / this.Jv : 0;
    }
  }

  _detectLash(h, b) {
    this.lashTimer += h;
    const side = this.twist > b ? 1 : this.twist < -b ? -1 : 0;

    if (side === 0) {
      // Re-arm only once we are properly clear of the flank, so numerical
      // chatter right on the boundary cannot machine-gun the clunk.
      if (Math.abs(this.twist) < b * LASH_RELEASE) this.contact = 0;
      return;
    }
    if (side === this.contact) return;             // still loaded, nothing new

    // Contact just made: this is the clunk. Its loudness is the relative
    // velocity across the joint at the instant the teeth meet.
    const vImpact = Math.abs(this.dtwist);
    this.contact = side;
    if (vImpact < LASH_MIN_VEL || this.lashTimer < LASH_REARM) return;
    this.lashTimer = 0;
    this.lashContactedSince = true;
    this.fireEvent('lash',
      clamp(Math.pow(vImpact / LASH_REF_VEL, LASH_VEL_EXP), 0.001, 1));
  }

  /**
   * Exhaust gas temperature and unburnt-fuel charge — the two things that decide
   * whether the exhaust pops, and when.
   *
   * Researching this changed the model. Popping is unburnt fuel detonating in a
   * hot pipe, and during STEADY deceleration fuel cut-off there is no fuel at
   * all, so a steady overrun should go quiet rather than crackle continuously.
   * What actually pops is the TRANSITION: a brief excess as the ECU closes the
   * injectors, and fuel reintroduced into a glowing exhaust when it opens them
   * again. It also needs heat, so a gently driven car does not crackle and one
   * that has just been worked does.
   */
  _stepExhaustThermal(h, thr) {
    const rpm = this.we * RPM_PER_RADS;
    const rpmN = clamp((rpm - this.engine.idleRpm) /
                       Math.max(1, this.engine.redlineRpm - this.engine.idleRpm), 0, 1);

    // Heat in with combustion power, out with airflow and radiation. Rising is
    // slower than falling on purpose: pipes soak heat gradually and shed it fast
    // once cold air is being pumped through on a closed throttle.
    // Cast iron holds heat. Measured against the first version: a 2.2 s fall
    // constant dumped EGT from 0.77 to 0.27 in four seconds, so the pop window
    // was under a second and you would never hear it. A real manifold glows for
    // tens of seconds after a hard run, which is why a warmed-up car crackles on
    // every lift for a while rather than once.
    const target = clamp(0.12 + 0.88 * Math.pow(thr, 0.6) * (0.35 + 0.65 * rpmN), 0, 1);
    const tau = target > this.egt ? 5.0 : 26.0;       // seconds
    this.egt += (target - this.egt) * Math.min(1, h / tau);

    // Injectors are cut on a closed throttle above a rev threshold.
    //
    // This MUST test the driver's pedal, not the effective throttle. The rev
    // limiter drops the effective throttle to zero in 50 ms bursts, so reading
    // that here made every limiter cycle look like a fresh lift-off: sitting on
    // the limiter at full throttle produced a machine-gun of full-size lift-off
    // bangs, which is neither realistic nor pleasant. A limiter bark is a real
    // sound, but it is its own much smaller event — see below.
    const pedal = this.throttle;
    const cutting = pedal < 0.06 && rpm > this.engine.idleRpm * 1.5 && !this.gearboxNeutral;
    this.dfco = cutting ? 1 : 0;

    // Both edges matter: closing the injectors dumps a last slug of raw fuel,
    // reopening them sprays fuel onto a red-hot pipe.
    // Peak-hold of recent throttle. Snapping shut from wide open shoves far more
    // charge into the pipe than easing off does, and the difference is audible.
    this.thrPeak = Math.max(pedal, this.thrPeak - h / 0.7);
    this.popRefractory = Math.max(0, this.popRefractory - h);
    this.limiterBark = Math.max(0, this.limiterBark - h);

    // Bouncing off the rev limiter DOES bark — unburnt charge lights off in the
    // pipe on every cut. But it is a small, dry report, not the full lift-off
    // event, and it has to be rate-capped or it becomes a buzz at the 10-20 Hz
    // the limiter cycles at.
    if (this.limiterActive && !this.prevLimiter && this.egt > 0.5 && this.limiterBark <= 0) {
      this.limiterBark = 0.34;
      this.fireEvent('pop', clamp(0.16 + 0.14 * Math.random(), 0, 1));
    }
    this.prevLimiter = this.limiterActive;

    if (this.dfco !== this.prevDfco) {
      this.dfcoEdge = 1;
      if (this.dfco) {
        // Entering fuel cut — the lift-off bang. The charge in flight scales
        // with airflow, so with rpm, and steeply: lifting at redline is a bang,
        // lifting at 1500 rpm is a burp. rpmN^1.7 makes revs the dominant term
        // rather than a trim, which is what makes high-rpm lifts satisfying.
        const snap = clamp(this.thrPeak, 0, 1);
        const rev = Math.pow(rpmN, 1.7);
        this.cutRpmN = rpmN;
        // Genuinely random, not pseudo-varied: how much fuel happens to be
        // mid-injection when the ECU pulls the injectors is luck, and it is why
        // no two lift-offs from the same revs ever sound alike.
        const luck = 0.55 + Math.random() * 0.95;
        this.popCharge = clamp(
          this.popCharge + (0.5 + 2.1 * rev) * (0.4 + 0.6 * snap) * luck, 0, 3.4);
        if (this.egt > 0.4 && this.popRefractory <= 0) {
          this.popRefractory = 0.30;
          this.fireEvent('pop', clamp(
            (this.egt - 0.35) * 1.25 * (0.10 + 1.30 * rev) * (0.35 + 0.65 * snap) * luck,
            0, 1));
        }
      } else {
        // Injectors reopening onto a hot pipe: a softer re-light.
        this.popCharge = clamp(this.popCharge + 0.35, 0, 3.4);
      }
    }
    this.prevDfco = this.dfco;
    this.dfcoEdge = Math.max(0, this.dfcoEdge - h / 0.85);

    // A rev-match blip sprays fuel into the pipe and then shuts again: the
    // classic downshift bang. Detect the trailing edge of the blip.
    const ov = this.throttleOverride;
    if (this.prevOverride > 0.3 && !(ov > 0.3)) {
      this.popCharge = clamp(this.popCharge + 1.1 + 0.5 * rpmN, 0, 2.6);
      if (this.egt > 0.3 && this.popRefractory <= 0) {
        this.popRefractory = 0.30;
        this.fireEvent('pop', clamp((this.egt - 0.25) * 1.45 * (0.5 + 0.5 * rpmN), 0, 1));
      }
    }
    this.prevOverride = ov == null ? 0 : ov;

    // Raw fuel burns off over a couple of seconds rather than instantly, so the
    // crackle tails away instead of stopping dead.
    this.popCharge = Math.max(0, this.popCharge - h * (0.22 + 0.55 * (1 - this.dfco)));
  }

  _stepTurbo(h, thr) {
    const t = this.engine.turbo;
    if (!t) { this.boost = 0; return; }
    const rpm = this.we * RPM_PER_RADS;
    // Exhaust energy: needs both revs and load. Below ~1200 rpm there is not
    // enough mass flow to spin anything.
    const spoolRpm = clamp((rpm - 1200) / (0.55 * this.engine.redlineRpm - 1200), 0, 1);
    const target = clamp(thr, 0, 1) * spoolRpm;
    // Time constant from turbo inertia: a small i3 turbo lags ~0.55 s, a big
    // straight-six one ~0.72 s. Spool-up is slower than blow-down.
    const tau = this.boostDump > 0 ? 0.05
      : (target > this.boost ? 0.25 + t.inertia * 0.9 : 0.18 + t.inertia * 0.4);
    this.boost += (target - this.boost) * Math.min(1, h / tau);
    this.boost = clamp(this.boost, 0, 1);
    if (this.boostDump > 0) this.boostDump -= h;

    // Turbine SPEED is a separate state from boost PRESSURE, and the whistle
    // tracks speed. A blow-off valve vents the pressure in milliseconds but the
    // turbine is a spinning mass — it cannot stop. That is precisely why a
    // turbo car's whistle SAGS through a gear change and swells back rather
    // than collapsing and restarting, and modelling boost alone loses it.
    // It also never reaches zero while the engine turns: exhaust flow keeps the
    // wheel windmilling, which is the whistle you hear at cruise off-throttle.
    const windmill = rpm > 900 ? 0.12 + 0.20 * spoolRpm : 0;
    const spinTarget = clamp(Math.max(windmill, target), 0, 1);
    const spinTau = spinTarget > this.turboSpeed
      ? 0.22 + t.inertia * 0.85       // spooling up: exhaust energy is plentiful
      : 0.42 + t.inertia * 0.55;      // coasting down: only bearing drag
    this.turboSpeed += (spinTarget - this.turboSpeed) * Math.min(1, h / spinTau);
    this.turboSpeed = clamp(this.turboSpeed, 0, 1);

    // Blow-off valve: throttle slams shut with the compressor still spinning.
    // Driven by the EFFECTIVE throttle, so a shift torque-cut triggers it too —
    // that is where the dump-valve chirp in a DCT upshift comes from.
    if (thr > 0.45) this.bovArm = 1;
    else if (this.bovArm > 0 && thr < 0.12 && this.boost > 0.18) {
      this.bovArm = 0;
      this.boostDump = 0.12;
      this.fireEvent('bov', clamp(this.boost * (0.4 + 0.6 * t.bov), 0.1, 1));
    }
  }

  _boostMult() {
    const t = this.engine.turbo;
    if (!t) return 1;
    // 1.2 bar of boost on a modern engine is worth roughly +65% torque.
    return 1 + 0.55 * this.boost * t.maxBoost;
  }

  // =========================================================================
  // Params
  // =========================================================================

  _writeParams(dt, now) {
    const p = this.params, eng = this.engine;
    const rpm = this.we * RPM_PER_RADS;

    p.now = now;
    p.dt = dt;
    p.rpm = rpm;
    p.f0 = rpm / 120;                                  // one 720 deg cycle, Hz
    p.rpmNorm = clamp((rpm - eng.idleRpm) / (eng.redlineRpm - eng.idleRpm), 0, 1);
    p.dRpm = dt > 0 ? (rpm - this.prevRpm) / dt : 0;
    this.prevRpm = rpm;

    p.throttle = this.throttle;

    // Combustion load: what the engine is actually burning, not the pedal.
    // Includes the rev-match blip, which is why a downshift sounds loaded even
    // with the driver's foot off the pedal.
    const raw = clamp(this.thrEff || 0, 0, 1);
    const sm = dt > 0 ? clamp(dt * 12, 0, 1) : 1;
    this.load += (raw - this.load) * sm;
    p.load = clamp(this.load, 0, 1);

    // DFCO: closed throttle, revs well above idle, wheels driving the engine.
    const overrunTarget = (this.thrEff < 0.05 && rpm > eng.idleRpm * 1.7
                           && this.gear > 0 && this.Tp < -2) ? 1 : 0;
    this.overrun += (overrunTarget - this.overrun) * (dt > 0 ? clamp(dt * 8, 0, 1) : 1);
    p.overrun = clamp(this.overrun, 0, 1);

    p.torqueSign = this.Tp > 1 ? 1 : this.Tp < -1 ? -1 : (this.Te >= 0 ? 1 : -1);

    p.gear = this.gear;
    p.gearRatio = this.totalRatio;
    p.speed = this.ww * this.r;
    // Driveshaft (propshaft) rpm — gearbox and diff whine track this, and it is
    // the one speed that keeps running smoothly straight through a shift.
    p.wheelRpm = this.ww * this.fd * RPM_PER_RADS;

    // True clutch slip: engine minus gearbox INPUT shaft. Large during a launch
    // and through the whole engage ramp, exactly zero once locked.
    p.clutchSlip = (this.we - this.wg) * RPM_PER_RADS;
    p.clutchEngaged = this.clutch;

    p.boost = this.boost;
    p.shifting = this.shifting;
    p.shiftPhase = this.shiftPhase;

    // One-frame impulses: publish then clear.
    const e = this.ev;
    p.evCut = e.cut; p.evLash = e.lash; p.evEngage = e.engage;
    p.evBov = e.bov; p.evShiftDone = e.shiftDone; p.evPop = e.pop;
    e.cut = e.lash = e.engage = e.bov = e.shiftDone = e.pop = 0;

    // Exhaust thermal / popping state.
    p.turboSpeed = this.turboSpeed;
    p.egt = this.egt;
    p.dfco = this.dfco;
    // How hard the exhaust should be popping right now: needs heat AND raw fuel.
    // Peaks just after a fuel-cut transition and tapers as the charge burns off.
    // The trailing crackle also remembers where the cut happened, so a lift at
    // 7000 rpm keeps muttering afterwards while one at 2000 rpm just stops.
    p.cutRpmN = this.cutRpmN;
    p.popIntensity = clamp(
      Math.max(0, this.egt - 0.45) / 0.55 *
      clamp(this.popCharge, 0, 1) *
      // Almost entirely gated on the fuel-cut edge. A large steady term meant
      // crackle carried on for as long as the pipe stayed hot, which reads as a
      // constant fizz rather than a reaction to something the driver did.
      (0.12 + 0.88 * this.dfcoEdge) *
      (0.45 + 0.55 * this.cutRpmN), 0, 1);

    return p;
  }
}

export { RPM_PER_RADS, RADS_PER_RPM, SUBSTEP };
export default Drivetrain;
