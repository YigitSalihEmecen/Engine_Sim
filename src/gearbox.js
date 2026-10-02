/**
 * gearbox.js — gear ratios designed for the engine AND the car it sits in.
 *
 * A vehicle preset used to carry a fixed ratio table. That only works for the
 * engine the table was drawn up for: drop a peaky 9500 rpm twin, or a diesel
 * that is done by 4000, into somebody else's gearbox and the car runs out of
 * puff in 4th, sitting below its upshift point with gears to spare. Real
 * manufacturers do not do that; they pick the ratios for the engine. So does
 * this, from the same torque model the physics integrates:
 *
 *   top gear   the drag-limited top speed lands just past peak POWER rpm,
 *              where the car is genuinely fastest
 *   first gear what the tyres can use at launch, bounded by a sensible overall
 *              spread for the number of gears
 *   between    a progressive series: big steps low down where the car is
 *              accelerating hard, close steps at the top where it is not
 *
 * The final drive stays the vehicle's own (it is part of the axle, not the
 * box); only the gearbox ratios change. Everything here is pure maths: no
 * audio, no state.
 */

const RHO_AIR = 1.225;
const G = 9.81;
const RPM_PER_RADS = 60 / (2 * Math.PI);

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/**
 * Net wide-open-throttle torque at `rpm`, N.m: the physics' torque curve, the
 * turbo at `boost` (0..1 of its maximum), minus friction with the throttle
 * open. The exact law `Drivetrain` integrates, so a design here holds there.
 */
export function wotTorque(engine, rpm, boost = 1) {
  const k = (rpm - engine.peakTorqueRpm) / (engine.redlineRpm * 0.75);
  const shape = clamp(1 - 0.85 * k * k, 0.3, 1);
  const t = engine.turbo;
  const bm = t ? 1 + 0.55 * boost * t.maxBoost : 1;
  const friction = (18 + 0.012 * rpm + 2.2e-6 * rpm * rpm) * (1 - 0.62);
  return engine.peakTorque * shape * bm - friction;
}

/** { rpm, power (W), torque (N.m, the curve's maximum) } on full boost. */
export function powerPeak(engine) {
  let best = { rpm: engine.redlineRpm, power: 0, torque: 0 };
  for (let rpm = engine.idleRpm; rpm <= engine.redlineRpm; rpm += 25) {
    const T = wotTorque(engine, rpm);
    const P = T * rpm / RPM_PER_RADS;
    if (P > best.power) { best.power = P; best.rpm = rpm; }
    if (T > best.torque) best.torque = T;
  }
  return best;
}

/** Overall spread (first / top) a box of `n` gears is drawn with. */
function spreadRange(n) {
  return [2.6 + 0.4 * (n - 4), 3.8 + 0.8 * (n - 4)];
}

/**
 * @param {object} engine  an engine profile (ENGINE_PROFILES entry)
 * @param {object} vehicle a vehicle preset: mass, wheelRadius, finalDrive,
 *                         dragArea (Cd·A, m²), rollingResistance, and
 *                         optionally gravity (m/s², a game may run its own)
 * @param {object} [opts]  gears (overrides engine.gears), efficiency
 * @returns {{ gearRatios: number[], gearTeeth: number[], topSpeed: number }}
 *          topSpeed is the design's drag-limited top speed, m/s
 */
export function designGearbox(engine, vehicle, opts = {}) {
  const n = Math.round(clamp(
    opts.gears || engine.gears || (vehicle.gearRatios && vehicle.gearRatios.length) || 6, 3, 10));
  const g = vehicle.gravity || G;
  const eff = opts.efficiency || 0.92;
  const r = vehicle.wheelRadius, fd = vehicle.finalDrive, m = vehicle.mass;
  const resist = (v) => 0.5 * RHO_AIR * vehicle.dragArea * v * v + vehicle.rollingResistance * m * g;

  // --- top gear ------------------------------------------------------------
  // Aim the top-speed balance just past the power peak, never at the limiter.
  const pk = powerPeak(engine);
  const rpmTop = Math.min(pk.rpm * 1.04, engine.redlineRpm * 0.9);
  const Pwheel = eff * wotTorque(engine, rpmTop) * rpmTop / RPM_PER_RADS;
  let lo = 0, hi = 200;
  for (let i = 0; i < 60; i++) {
    const v = 0.5 * (lo + hi);
    if (resist(v) * v < Pwheel) lo = v; else hi = v;
  }
  const vTop = lo;
  const Rtop = (rpmTop / RPM_PER_RADS) * r / Math.max(vTop, 1);   // overall ratio

  // --- first gear ----------------------------------------------------------
  // About 0.6 g of thrust at the torque peak: as much as street tyres put down.
  const Rgrip = 0.6 * m * g * r / (Math.max(1, pk.torque) * eff);
  const [sMin, sMax] = spreadRange(n);
  const S = clamp(Rgrip / Rtop, sMin, sMax);

  // --- the steps between -----------------------------------------------------
  // ln R_k = ln R_top + x_k ln S, x running 1 -> 0. The exponent > 1 bends the
  // series progressive: steps shrink toward the top gear.
  const gearRatios = [];
  for (let k = 1; k <= n; k++) {
    const x = Math.pow((n - k) / (n - 1), 1.15);
    gearRatios.push(+(Rtop * Math.pow(S, x) / fd).toFixed(3));
  }
  // Whine ordering: fewer teeth on the driven gear as the ratio shortens.
  const gearTeeth = gearRatios.map((ratio) => Math.round(clamp(16 + 6.5 * ratio, 17, 46)));
  return { gearRatios, gearTeeth, topSpeed: vTop };
}

/** `vehicle` with its gearbox redesigned for `engine`; the preset is untouched. */
export function gearVehicle(engine, vehicle, opts) {
  const d = designGearbox(engine, vehicle, opts);
  return { ...vehicle, gearRatios: d.gearRatios, gearTeeth: d.gearTeeth };
}
