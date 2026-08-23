/**
 * shift.js — gear-shift state machine.
 *
 * A gear change is not a timer that swaps a ratio. It is a sequence of
 * mechanically distinct events, and each one has its own sound:
 *
 *   cut     fuel/ignition is pulled so the driveline torque collapses. The
 *           unburnt charge lights in the exhaust — that is the shift bang.
 *   open    the clutch is released. The engine is now a free inertia: on an
 *           upshift it decays under its own friction, on a downshift the ECU
 *           (or the driver's right foot) blips it UP to the speed the new gear
 *           needs. This is the only phase whose length really varies by type.
 *   sync    the synchroniser cone rubs the input shaft onto the new gear's
 *           speed. Short, high torque, mechanical.
 *   engage  the clutch closes over a real ramp. Because engine and gearbox are
 *           separate inertias with a finite friction capacity, engine rpm
 *           CONVERGES on the new geared rpm over tens of milliseconds. It never
 *           steps. This is the single biggest reason v1 sounded like a pitch
 *           jump and this does not.
 *   lash    torque is reapplied, the driveline crosses its backlash dead-band
 *           with nothing transmitted, and the teeth meet. Clunk.
 *   shuffle the torsional mode excited by that impact rings down at a few Hz.
 *
 * The controller only issues *commands* (gear, gearbox-in-neutral, clutch
 * engagement, torque cut, throttle override, synchroniser target). All the
 * inertias, the spring, the backlash and the impact detection live in
 * physics.js. In particular `evLash` is fired by the physics when contact is
 * actually detected — this file never fakes it.
 *
 * The three gearbox types differ in mechanism, not just in timing:
 *
 *   manual  full torque cut, clutch to zero, the longest interruption, and the
 *           driver's blip is a coarse open-loop stab.
 *   dct     the outgoing clutch is bled off while the incoming one is already
 *           partly loaded (`openClutch` > 0, `engageStart` high), so torque
 *           never fully vanishes and the engage ramp starts from a live clutch.
 *           Rev-match is closed-loop and tight.
 *   auto    there is no hard cut at all: `cutDepth` < 1 is a spark-retard
 *           torque reduction, and the torque converter (physics.js) keeps
 *           transmitting throughout, so every edge is smeared.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const RPM_PER_RADS = 60 / (2 * Math.PI);

/**
 * Per-gearbox-type character.
 *
 * The `*F` fields are fractions of the preset's `shiftTimeMs`, so a 45 ms DCT
 * and a 190 ms torque-converter auto keep their relative proportions. The
 * `*Min` fields are absolute floors in seconds: a synchroniser cannot act in
 * less than ~8 ms however fast the box is, and a clutch cannot close usefully
 * in less than ~30 ms without simply slamming.
 */
export const GEARBOX_TYPES = {
  manual: {
    cutF: 0.30, openF: 0.30, syncF: 0.15, engageF: 0.35,
    cutMin: 0.030, openMin: 0.035, syncMin: 0.018, engageMin: 0.050,
    openClutch: 0.00,     // clutch pedal fully down
    engageStart: 0.00,    // ramp starts from a dead clutch
    cutDepth: 1.00,       // complete torque cut
    cutBang: 0.85,        // exhaust bang magnitude for evCut
    blip: 0.85,           // downshift throttle stab (open loop, driver's foot)
    blipTolRpm: 130,      // how close the blip has to get before we move on
    lashMax: 0.170,       // give up waiting for the clunk after this
    shuffle: 0.360,       // label window for the ring-down
    openStretch: 2.6,     // downshift may stretch `open` this much to rev-match
  },
  dct: {
    cutF: 0.30, openF: 0.25, syncF: 0.15, engageF: 0.60,
    cutMin: 0.012, openMin: 0.010, syncMin: 0.008, engageMin: 0.028,
    openClutch: 0.10,     // outgoing clutch bled, never fully released
    engageStart: 0.40,    // incoming clutch pre-loaded — the "overlap"
    cutDepth: 1.00,
    cutBang: 1.00,        // the loudest bang of the three
    blip: 1.00,
    blipTolRpm: 60,       // closed loop, aggressive
    lashMax: 0.090,
    shuffle: 0.260,
    openStretch: 2.0,
  },
  auto: {
    cutF: 0.20, openF: 0.25, syncF: 0.18, engageF: 0.90,
    cutMin: 0.020, openMin: 0.025, syncMin: 0.018, engageMin: 0.090,
    openClutch: 0.00,     // only the LOCKUP clutch opens; the converter stays
    engageStart: 0.12,
    cutDepth: 0.55,       // spark retard, not a cut
    cutBang: 0.15,        // barely audible
    blip: 0.35,           // the converter does most of the matching
    blipTolRpm: 220,
    lashMax: 0.200,
    shuffle: 0.420,
    openStretch: 1.6,
  },
};

/** Phase order, matching CONTRACT.md's `shiftPhase`. */
export const PHASES = ['cut', 'open', 'sync', 'engage', 'lash', 'shuffle'];

export class ShiftController {
  /**
   * @param {object} cfg
   *   type          'manual' | 'dct' | 'auto'
   *   shiftTimeMs   nominal interruption length from VEHICLE_PRESETS
   *   gearCount     number of forward gears
   *   idleRpm, redlineRpm
   *   revMatch      blip on downshifts (default true)
   *   autoShift     start with the automatic strategy on (default true)
   */
  constructor(cfg = {}) {
    this.type = cfg.type in GEARBOX_TYPES ? cfg.type : 'manual';
    this.k = GEARBOX_TYPES[this.type];
    this.S = Math.max(0.02, (cfg.shiftTimeMs || 120) / 1000);
    this.gearCount = cfg.gearCount || 6;
    this.idleRpm = cfg.idleRpm || 800;
    this.redlineRpm = cfg.redlineRpm || 7000;
    this.revMatch = cfg.revMatch !== false;
    this.autoShift = cfg.autoShift !== false;

    // Automatic strategy. v1's numbers, expressed as fractions of redline so
    // they follow the engine rather than being magic constants:
    //   v1: up 6550/7000 = 0.936, down 2100/7000 = 0.300.
    this.upFracLow = 0.55;      // part throttle: short-shift
    this.upFracHigh = 0.936;    // wide open: hold to just under the limiter
    this.downFracLow = 0.28;
    this.downFracHigh = 0.44;   // more throttle -> hold the lower gear longer
    this.kickdownThrottle = 0.85;
    this.minShiftInterval = 0.35;   // anti-hunt lockout, seconds

    // Phase durations, recomputed at each shift (they are constant per type but
    // kept as fields so nothing is allocated mid-shift).
    this.tCut = 0; this.tOpen = 0; this.tSync = 0; this.tEngage = 0;

    this.reset();
  }

  reset() {
    this.phase = '';
    this.t = 0;                 // time in the current phase
    this.from = 0;
    this.to = 0;
    this.isDown = false;
    this.revTargetW = 0;        // rad/s the engine is being blipped to
    this.sinceShift = 999;      // s since the last shift finished
    this.contactSeen = false;   // driveline made contact since `engage` began
    this.blipHeld = false;
  }

  get shifting() {
    // `shifting` in the params object means "torque is interrupted". `lash` and
    // `shuffle` are the aftermath: the gear is in, the driver is back on the
    // throttle, the driveline is just still ringing.
    const p = this.phase;
    return p === 'cut' || p === 'open' || p === 'sync' || p === 'engage';
  }

  get busy() { return this.phase !== ''; }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  /**
   * @param {object} d  the Drivetrain (duck typed: gear, gearedRpm(g), speed)
   * @param {number} target 0 = neutral, 1..gearCount
   * @param {boolean} [force] skip the anti-hunt lockout (user requests do)
   * @returns {boolean} accepted
   */
  request(d, target, force = false) {
    target = Math.round(target);
    if (this.shifting) return false;
    if (target < 0 || target > this.gearCount) return false;
    if (target === d.gear) return false;
    if (!force && this.sinceShift < this.minShiftInterval) return false;
    // Over-rev guard (v1's, kept): refuse a gear that would bounce the engine
    // off the limiter the instant the clutch came back.
    if (this.wouldOverRev(d, target)) return false;

    this.from = d.gear;
    this.to = target;
    this.isDown = target !== 0 && (d.gear === 0 || target < d.gear);
    this.contactSeen = false;
    this.blipHeld = false;

    const k = this.k, S = this.S;
    this.tCut = Math.max(k.cutMin, k.cutF * S);
    this.tOpen = Math.max(k.openMin, k.openF * S);
    this.tSync = Math.max(k.syncMin, k.syncF * S);
    this.tEngage = Math.max(k.engageMin, k.engageF * S);

    this.revTargetW = (this.isDown && this.revMatch && target > 0)
      ? clamp(d.gearedRpm(target), this.idleRpm, this.redlineRpm * 0.97) / RPM_PER_RADS
      : 0;

    this.phase = 'cut';
    this.t = 0;

    // A shift cut is an INTERRUPTION, not an explosion.
    //
    // This used to fire at near-full magnitude on every single gear change, so
    // every upshift threw a volley of exhaust bangs. Real cars do not do that:
    // an ordinary upshift is a brief "pfft" of overrun, and only a hot, fuel-
    // rich pipe actually lights off. Banging on all of them is the thing that
    // reads as "it pops constantly".
    //
    // So it is gated on the same two physical conditions as a lift-off bang:
    // a hot enough pipe, and luck. `egt` is the drivetrain's exhaust-gas
    // temperature state; if it is not there (a bare ShiftController under test)
    // fall back to the old unconditional behaviour.
    const egt = typeof d.egt === 'number' ? d.egt : 1;
    const heat = clamp((egt - 0.45) / 0.35, 0, 1);
    // The bang scales with how much torque we are throwing away.
    const mag = k.cutBang * (0.25 + 0.75 * d.throttle) * k.cutDepth * heat;
    // A dual-clutch box overlaps its clutches and dumps a much bigger slug of
    // charge, which is why those cars crack on every shift and a manual does
    // not. That difference is `cutBang`, so the probability follows it.
    const pFire = clamp((0.12 + 0.55 * heat) * k.cutBang, 0, 0.9);
    if (mag > 0.04 && Math.random() < pFire) {
      d.fireEvent('cut', clamp(mag, 0, 1));
    }
    return true;
  }

  /** Would engaging `g` at the current road speed exceed the redline? */
  wouldOverRev(d, g) {
    if (g <= 0) return false;
    return d.gearedRpm(g) > this.redlineRpm;
  }

  // -------------------------------------------------------------------------
  // Automatic strategy (carried over from v1, plus throttle-dependent points)
  // -------------------------------------------------------------------------

  upshiftRpm(throttle) {
    const f = this.upFracLow + (this.upFracHigh - this.upFracLow) * clamp(throttle, 0, 1);
    return Math.max(this.idleRpm * 1.6, this.redlineRpm * f);
  }

  downshiftRpm(throttle) {
    const f = this.downFracLow + (this.downFracHigh - this.downFracLow) * clamp(throttle, 0, 1);
    return Math.max(this.idleRpm * 1.15, this.redlineRpm * f);
  }

  /** Decide whether to change gear. Called once per sub-step; cheap. */
  auto(d) {
    if (!this.autoShift || this.busy || d.gear === 0) return;
    if (this.sinceShift < this.minShiftInterval) return;

    const thr = d.throttle;
    const rpm = d.rpm;
    const up = this.upshiftRpm(thr);

    if (rpm >= up && d.gear < this.gearCount && thr > 0.05) {
      this.request(d, d.gear + 1);
      return;
    }
    if (d.gear > 1) {
      const lower = d.gear - 1;
      const lowerRpm = d.gearedRpm(lower);
      // v1's guard: only drop a gear if the lower one will not immediately
      // bounce us back off the upshift point (or the limiter).
      if (lowerRpm >= up) return;
      if (rpm <= this.downshiftRpm(thr)) { this.request(d, lower); return; }
      // Kickdown: floor it at low rpm in a tall gear and the box drops one.
      if (thr >= this.kickdownThrottle && rpm < this.redlineRpm * 0.55
          && lowerRpm < this.redlineRpm * 0.92) {
        this.request(d, lower);
      }
    }
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  /**
   * Advance one physics sub-step and write the command fields on the drivetrain.
   * Called at sub-step resolution so phase edges land on the right sample and
   * so the `lash` phase can see the contact event the physics just produced.
   *
   * Writes: d.gear, d.gearboxNeutral, d.syncing, d.syncTargetW, d.clutchCmd,
   *         d.clutchRate, d.fuelCut, d.throttleOverride, d.shiftPhase, d.shifting
   */
  step(h, d) {
    // Defaults for "not shifting": everything nominal, the drivetrain's own
    // launch/lockup logic owns the clutch.
    d.gearboxNeutral = false;
    d.syncing = false;
    d.fuelCut = 0;
    d.throttleOverride = null;
    d.clutchCmd = null;          // null = drivetrain decides
    d.clutchRate = 0;            // 0 = drivetrain default

    if (!this.busy) {
      this.sinceShift += h;
      this.auto(d);
      if (!this.busy) {
        d.shiftPhase = '';
        d.shifting = false;
        return;
      }
    }

    this.t += h;
    const k = this.k;

    switch (this.phase) {
      // --- torque collapses, clutch still in ------------------------------
      case 'cut':
        d.fuelCut = k.cutDepth;
        d.clutchCmd = 1;
        if (this.t >= this.tCut) this._enter('open', d);
        break;

      // --- clutch open, engine free ---------------------------------------
      case 'open': {
        d.gearboxNeutral = true;
        d.clutchCmd = k.openClutch;
        d.clutchRate = 60;                       // hydraulics dump fast
        if (this.isDown && this.revTargetW > 0) {
          // Blip UP to the rev-match target. Hysteresis on the hold so the
          // stab does not chatter around the target.
          const err = this.revTargetW - d.we;
          const tol = k.blipTolRpm / RPM_PER_RADS;
          if (err > tol) this.blipHeld = true;
          else if (err < 0) this.blipHeld = false;
          d.throttleOverride = this.blipHeld ? k.blip : 0;
          const done = Math.abs(err) <= tol;
          if ((this.t >= this.tOpen && done) || this.t >= this.tOpen * k.openStretch) {
            this._enter('sync', d);
          }
        } else {
          // Upshift: fuel off, the engine decays on its own friction. That
          // decay rate is the engine's inertia — it is why a flat-plane V8
          // drops so much faster than a truck six.
          d.fuelCut = k.cutDepth;
          if (k.cutDepth >= 1) d.throttleOverride = 0;
          if (this.t >= this.tOpen) this._enter('sync', d);
        }
        break;
      }

      // --- synchroniser rubs the input shaft onto the new gear speed -------
      case 'sync': {
        d.gearboxNeutral = true;                 // still no torque path
        d.clutchCmd = k.openClutch;
        d.fuelCut = k.cutDepth;
        if (k.cutDepth >= 1) d.throttleOverride = 0;
        if (this.to > 0) {
          d.syncing = true;
          d.syncTargetW = d.inputShaftTargetW(this.to);
        }
        const synced = this.to === 0 ||
          Math.abs(d.wg - d.syncTargetW) < 3.0;             // rad/s ~ 30 rpm
        if ((this.t >= this.tSync && synced) || this.t >= this.tSync * 3) {
          this._enter('engage', d);
        }
        break;
      }

      // --- clutch closes over a real ramp; genuine slip --------------------
      case 'engage': {
        const u = clamp(this.t / this.tEngage, 0, 1);
        // smoothstep: a clutch pedal/actuator does not move linearly, and a
        // linear ramp gives an audible corner at both ends.
        const s = u * u * (3 - 2 * u);
        d.clutchCmd = k.engageStart + (1 - k.engageStart) * s;
        d.clutchRate = 4 / this.tEngage;          // actuator keeps up with the ramp
        if (this.to === 0) d.clutchCmd = 0;
        if (d.lashContactedSince) this.contactSeen = true;
        if (this.t >= this.tEngage) this._enter('lash', d);
        break;
      }

      // --- torque reapplies, driveline crosses backlash, teeth hit --------
      case 'lash':
        d.clutchCmd = this.to === 0 ? 0 : 1;
        if (d.lashContactedSince) this.contactSeen = true;
        if (this.contactSeen || this.t >= k.lashMax || this.to === 0) {
          this._enter('shuffle', d);
        }
        break;

      // --- the torsional mode rings down. No events, just physics. ---------
      case 'shuffle':
        d.clutchCmd = this.to === 0 ? 0 : null;
        if (this.t >= k.shuffle) {
          this.phase = '';
          this.t = 0;
          this.sinceShift = 0;
          d.clutchCmd = null;
        }
        break;
    }

    d.shiftPhase = this.phase;
    d.shifting = this.shifting;
  }

  _enter(next, d) {
    const prev = this.phase;
    this.phase = next;
    this.t = 0;

    if (next === 'sync') {
      // The gear is selected here, but `gearboxNeutral` stays true until
      // `engage` — the dogs are meshing, no torque yet. Selecting the gear now
      // is what lets the synchroniser know what speed to aim for, and it means
      // the ratio is already correct when the torque path closes, so nothing
      // steps discontinuously.
      d.selectGear(this.to);
      if (this.to > 0) d.syncTargetW = d.inputShaftTargetW(this.to);
    }

    if (next === 'engage') {
      d.gearboxNeutral = false;
      // Clutch bite: how violent depends on how much slip is left to burn.
      const slipRpm = Math.abs(d.we - d.wg) * RPM_PER_RADS;
      d.fireEvent('engage', clamp(0.15 + slipRpm / 1800, 0, 1));
      d.lashContactedSince = false;
      this.contactSeen = false;
    }

    if (next === 'lash') {
      // The gear is in and the torque is back: from the driver's point of view
      // the shift is over, even though the driveline has not settled.
      d.fireEvent('shiftDone', 1);
    }

    void prev;
  }
}

export default ShiftController;
