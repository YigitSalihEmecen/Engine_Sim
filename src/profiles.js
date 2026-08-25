/**
 * profiles.js — physical descriptions of engines. No audio here.
 *
 * Everything downstream is DERIVED from this data, not hand-tuned per engine.
 * A four-stroke fires each cylinder once every two crank revolutions, so the
 * fundamental period is 720° and f0 = rpm / 120. Engine "orders" are therefore
 * multiples of 0.5 — the half-orders that give a cross-plane V8 its burble are
 * a consequence of where the cylinders sit in that 720° cycle, not an effect
 * bolted on afterwards.
 *
 * Field reference
 *   cylinders     count
 *   firingOrder   cylinder numbers in the order they fire
 *   banks         array of arrays of cylinder numbers, one per exhaust bank
 *   pinOffsets    optional per-cylinder crank-angle trim (deg), e.g. split-pin
 *                 V6s or the unequal-length headers of a Subaru boxer
 *   exhaust       waveguide geometry, metres. bank = header/downpipe length,
 *                 collector = shared pipe after the banks merge
 *   intake        Helmholtz resonance of the airbox/plenum, Hz
 *   turbo         null, or { inertia, maxBoost, whineOrder, bov, surge }.
 *                 `bov` is the blow-off valve's CAPACITY, 0..1, and it is the
 *                 one number that decides whether a car goes "chiu" or
 *                 "stu-stu-stu" on a lift: a big atmospheric valve empties the
 *                 plenum so nothing is left to reverse through the compressor,
 *                 a small or recirculating one leaves pressure standing and the
 *                 compressor stalls instead. `surge` is a taste trim on top.
 */

const C = 343;   // speed of sound, m/s (hot exhaust gas is faster; see gasTempFactor)

export const ENGINE_PROFILES = {
  vtwin: {
    label: 'V-twin 90\u00b0 1.2',
    // Two cylinders on a shared crankpin at 90\u00b0. firingAngles() spaces them
    // evenly at 360\u00b0, and the pin offset pulls the rear one back to 270\u00b0 \u2014 so
    // the intervals are 270\u00b0 and 450\u00b0. That asymmetry is the whole engine:
    // with only two cylinders in two separate pipes, the half-orders dominate
    // instead of merely colouring the note.
    cylinders: 2, firingOrder: [1, 2], banks: [[1], [2]],
    pinOffsets: { 2: -90 },
    idleRpm: 1150, redlineRpm: 9500, peakTorque: 125, peakTorqueRpm: 8000,
    // A tiny rotating assembly is why a big twin snaps to the limiter.
    engineInertia: 0.055, gasTempFactor: 1.34,
    pulse: { attack: 40, decay: 6.5, hardness: 0.72, jitter: 2.0 },
    // Genuinely unequal pipes: on a V-twin the front and rear cylinders cannot
    // have the same run to the collector.
    exhaust: { bank: 0.95, bankB: 1.10, collector: 0.55, reflection: 0.50, damping: 0.34, muffler: [0.16, 0.11, 0.075] },
    intake: { helmholtz: 165, q: 6.0, level: 0.40 },
    turbo: null,
    voice: 0.92,
  },

  i3: {
    label: 'Inline-3 1.0 turbo',
    cylinders: 3, firingOrder: [1, 2, 3], banks: [[1, 2, 3]],
    idleRpm: 850, redlineRpm: 6500, peakTorque: 200, peakTorqueRpm: 2200,
    engineInertia: 0.16, gasTempFactor: 1.30,
    pulse: { attack: 34, decay: 5.5, hardness: 0.62, jitter: 1.6 },
    exhaust: { bank: 1.45, collector: 1.10, reflection: 0.55, damping: 0.42, muffler: [0.32, 0.21, 0.14] },
    intake: { helmholtz: 105, q: 5.5, level: 0.34 },
    turbo: { inertia: 0.34, maxBoost: 1.2, whineOrder: 62, bov: 0.30, surge: 1.0 },
    voice: 1.00,
  },

  rotary2: {
    label: 'Rotary 1.3 twin-rotor',
    // A Wankel has no cylinders. Each rotor fires once per eccentric-shaft
    // revolution, so a two-rotor produces FOUR evenly spaced power pulses per
    // 720\u00b0 of shaft \u2014 the same firing geometry as an inline-four. `cylinders`
    // is that pulse count, not a piston count.
    //
    // What makes it sound nothing like an I4 is the port. A peripheral exhaust
    // port opens gradually and stays open for most of the rotor face's travel,
    // so the pulse has a slow rise and a very long tail and consecutive pulses
    // OVERLAP. That overlap is the "braap" \u2014 it is why a rotary sounds
    // continuous where a piston engine sounds like separate events.
    cylinders: 4, firingOrder: [1, 2, 3, 4], banks: [[1, 2, 3, 4]],
    idleRpm: 900, redlineRpm: 9000, peakTorque: 220, peakTorqueRpm: 5500,
    engineInertia: 0.14, gasTempFactor: 1.40,   // famously hot exhaust
    pulse: { attack: 18, decay: 3.0, hardness: 0.70, jitter: 1.2 },
    exhaust: { bank: 1.05, collector: 0.80, reflection: 0.52, damping: 0.30, muffler: [0.20, 0.13, 0.09] },
    intake: { helmholtz: 145, q: 6.6, level: 0.46 },
    turbo: null,
    voice: 0.94,
  },

  i4: {
    label: 'Inline-4 2.0',
    cylinders: 4, firingOrder: [1, 3, 4, 2], banks: [[1, 2, 3, 4]],
    idleRpm: 800, redlineRpm: 7200, peakTorque: 240, peakTorqueRpm: 3900,
    engineInertia: 0.19, gasTempFactor: 1.28,
    pulse: { attack: 38, decay: 6.2, hardness: 0.66, jitter: 1.1 },
    exhaust: { bank: 1.30, collector: 1.05, reflection: 0.52, damping: 0.44, muffler: [0.30, 0.19, 0.12] },
    intake: { helmholtz: 118, q: 6.0, level: 0.32 },
    turbo: null,
    voice: 0.96,
  },

  boxer4: {
    label: 'Flat-4 boxer (unequal headers)',
    cylinders: 4, firingOrder: [1, 3, 2, 4], banks: [[1, 3], [2, 4]],
    // The famous rumble is a header-length mismatch, not the firing order.
    pinOffsets: { 3: 6, 4: -6 },
    idleRpm: 800, redlineRpm: 6800, peakTorque: 300, peakTorqueRpm: 3200,
    engineInertia: 0.20, gasTempFactor: 1.27,
    pulse: { attack: 32, decay: 5.4, hardness: 0.60, jitter: 2.2 },
    exhaust: { bank: 1.62, bankB: 0.98, collector: 1.15, reflection: 0.58, damping: 0.40, muffler: [0.34, 0.22, 0.15] },
    intake: { helmholtz: 100, q: 5.2, level: 0.36 },
    turbo: { inertia: 0.40, maxBoost: 1.0, whineOrder: 58, bov: 0.80, surge: 1.0 },
    voice: 1.00,
  },

  i5: {
    label: 'Inline-5 2.5',
    cylinders: 5, firingOrder: [1, 2, 4, 5, 3], banks: [[1, 2, 3, 4, 5]],
    idleRpm: 820, redlineRpm: 7000, peakTorque: 360, peakTorqueRpm: 3200,
    engineInertia: 0.24, gasTempFactor: 1.29,
    pulse: { attack: 33, decay: 5.6, hardness: 0.64, jitter: 1.5 },
    exhaust: { bank: 1.38, collector: 1.08, reflection: 0.56, damping: 0.41, muffler: [0.31, 0.20, 0.13] },
    intake: { helmholtz: 108, q: 5.6, level: 0.34 },
    turbo: { inertia: 0.46, maxBoost: 1.1, whineOrder: 54, bov: 0.35, surge: 1.0 },
    voice: 1.00,
  },

  i6: {
    label: 'Inline-6 3.0',
    cylinders: 6, firingOrder: [1, 5, 3, 6, 2, 4], banks: [[1, 2, 3, 4, 5, 6]],
    idleRpm: 750, redlineRpm: 7000, peakTorque: 420, peakTorqueRpm: 3000,
    engineInertia: 0.27, gasTempFactor: 1.28,
    pulse: { attack: 30, decay: 5.0, hardness: 0.58, jitter: 0.7 },   // inherently balanced
    exhaust: { bank: 1.55, collector: 1.20, reflection: 0.54, damping: 0.38, muffler: [0.33, 0.21, 0.14] },
    intake: { helmholtz: 95, q: 6.4, level: 0.33 },
    turbo: { inertia: 0.52, maxBoost: 1.0, whineOrder: 48, bov: 0.25, surge: 1.1 },
    voice: 0.98,
  },

  i6diesel: {
    label: 'Inline-6 turbo-diesel 6.7',
    cylinders: 6, firingOrder: [1, 5, 3, 6, 2, 4], banks: [[1, 2, 3, 4, 5, 6]],
    idleRpm: 640, redlineRpm: 4600, peakTorque: 950, peakTorqueRpm: 1900,
    engineInertia: 0.62,          // heavy iron, and it is why it lugs
    gasTempFactor: 1.16,          // diesel exhaust is much cooler than petrol
    // Compression ignition is not a flame front travelling across a chamber, it
    // is the whole charge going off at once. The pressure rise is nearly a
    // step, which is what "diesel knock" is, so the attack is the sharpest of
    // any profile here by a wide margin.
    pulse: { attack: 68, decay: 9.5, hardness: 0.88, jitter: 1.4 },
    exhaust: { bank: 1.35, collector: 1.65, reflection: 0.52, damping: 0.60, muffler: [0.46, 0.30, 0.20] },
    // No throttle plate, so there is very little induction noise to hear.
    intake: { helmholtz: 88, q: 4.6, level: 0.24 },
    // A big variable-geometry turbo: very laggy, high boost, and no atmospheric
    // blow-off valve at all, so what you hear on a lift is the chatter.
    turbo: { inertia: 0.95, maxBoost: 1.5, whineOrder: 38, bov: 0.15, surge: 0.55 },
    voice: 1.02,
  },

  v6: {
    label: 'V6 60°',
    cylinders: 6, firingOrder: [1, 4, 2, 5, 3, 6], banks: [[1, 2, 3], [4, 5, 6]],
    idleRpm: 780, redlineRpm: 6800, peakTorque: 380, peakTorqueRpm: 3600,
    engineInertia: 0.26, gasTempFactor: 1.28,
    pulse: { attack: 31, decay: 5.2, hardness: 0.61, jitter: 1.3 },
    exhaust: { bank: 1.20, collector: 1.05, reflection: 0.56, damping: 0.40, muffler: [0.30, 0.20, 0.13] },
    intake: { helmholtz: 102, q: 5.8, level: 0.33 },
    turbo: null,
    voice: 0.98,
  },

  v6tt: {
    label: 'V6 twin-turbo 3.8',
    cylinders: 6, firingOrder: [1, 4, 2, 5, 3, 6], banks: [[1, 2, 3], [4, 5, 6]],
    idleRpm: 750, redlineRpm: 7100, peakTorque: 640, peakTorqueRpm: 3600,
    engineInertia: 0.29,
    // A turbine sits in the exhaust stream and takes energy out of it, so the
    // gas leaving the turbo is markedly cooler than a naturally aspirated
    // engine's \u2014 and the turbine itself is a very effective muffler. Lower
    // gasTempFactor and much higher damping are why a turbo car sounds deeper
    // and more muffled than the same engine without one.
    gasTempFactor: 1.22,
    pulse: { attack: 29, decay: 5.0, hardness: 0.60, jitter: 1.2 },
    exhaust: { bank: 0.95, collector: 1.30, reflection: 0.50, damping: 0.52, muffler: [0.34, 0.23, 0.15] },
    intake: { helmholtz: 112, q: 5.4, level: 0.30 },
    // Two small turbos, one per bank: low inertia, so they spool fast and the
    // whistle tracks the engine closely.
    turbo: { inertia: 0.30, maxBoost: 1.15, whineOrder: 56, bov: 0.55, surge: 1.0 },
    voice: 0.98,
  },

  flat6: {
    label: 'Flat-6 3.8',
    cylinders: 6, firingOrder: [1, 6, 2, 4, 3, 5], banks: [[1, 2, 3], [4, 5, 6]],
    idleRpm: 800, redlineRpm: 8500, peakTorque: 420, peakTorqueRpm: 5000,
    engineInertia: 0.22, gasTempFactor: 1.31,
    pulse: { attack: 44, decay: 7.0, hardness: 0.74, jitter: 0.9 },
    exhaust: { bank: 0.85, collector: 0.72, reflection: 0.48, damping: 0.30, muffler: [0.22, 0.15, 0.10] },
    intake: { helmholtz: 138, q: 7.2, level: 0.42 },   // that induction howl
    turbo: null,
    voice: 1.00,
  },

  v8cross: {
    label: 'V8 cross-plane 5.0',
    cylinders: 8, firingOrder: [1, 8, 7, 3, 6, 5, 4, 2],
    banks: [[1, 2, 3, 4], [5, 6, 7, 8]],
    // Bank A fires at 0/270/540/630 → intervals 270,270,90,90. Uneven within a
    // bank while the engine as a whole fires every 90°. That asymmetry, heard
    // through two separate pipes, IS the burble.
    idleRpm: 700, redlineRpm: 7000, peakTorque: 540, peakTorqueRpm: 4200,
    engineInertia: 0.38, gasTempFactor: 1.26,
    pulse: { attack: 26, decay: 4.4, hardness: 0.55, jitter: 2.6 },
    exhaust: { bank: 1.75, collector: 1.35, reflection: 0.63, damping: 0.34, muffler: [0.40, 0.26, 0.17] },
    intake: { helmholtz: 78, q: 5.0, level: 0.30 },
    turbo: null,
    voice: 1.06,
  },

  v8tt: {
    label: 'V8 twin-turbo 4.0',
    cylinders: 8, firingOrder: [1, 8, 7, 3, 6, 5, 4, 2],
    banks: [[1, 2, 3, 4], [5, 6, 7, 8]],
    // Same cross-plane geometry as v8cross, so it keeps the burble \u2014 but the
    // turbines damp the pipes hard and cool the gas, so it arrives as a deep
    // muffled thud rather than a bark. Same firing order, completely different
    // voice, and none of that is hand-tuned: it falls out of the pipe data.
    idleRpm: 660, redlineRpm: 6800, peakTorque: 800, peakTorqueRpm: 3000,
    engineInertia: 0.42, gasTempFactor: 1.21,
    pulse: { attack: 24, decay: 4.2, hardness: 0.54, jitter: 2.4 },
    exhaust: { bank: 1.10, collector: 1.55, reflection: 0.58, damping: 0.55, muffler: [0.42, 0.28, 0.18] },
    intake: { helmholtz: 74, q: 4.8, level: 0.28 },
    turbo: { inertia: 0.44, maxBoost: 1.10, whineOrder: 44, bov: 0.45, surge: 1.0 },
    voice: 1.05,
  },

  v8flat: {
    label: 'V8 flat-plane 4.5',
    cylinders: 8, firingOrder: [1, 5, 3, 7, 4, 8, 2, 6],
    banks: [[1, 2, 3, 4], [5, 6, 7, 8]],
    // Banks alternate perfectly → each bank fires every 180° → no half-orders,
    // no burble, just a flat high-order scream.
    idleRpm: 900, redlineRpm: 9000, peakTorque: 460, peakTorqueRpm: 6000,
    engineInertia: 0.25, gasTempFactor: 1.33,
    pulse: { attack: 52, decay: 8.4, hardness: 0.82, jitter: 0.6 },
    exhaust: { bank: 0.78, collector: 0.62, reflection: 0.44, damping: 0.26, muffler: [0.18, 0.12, 0.08] },
    intake: { helmholtz: 155, q: 7.8, level: 0.44 },
    turbo: null,
    voice: 1.00,
  },

  v10: {
    label: 'V10 5.2',
    cylinders: 10, firingOrder: [1, 6, 5, 10, 2, 7, 3, 8, 4, 9],
    banks: [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]],
    idleRpm: 900, redlineRpm: 8700, peakTorque: 560, peakTorqueRpm: 6500,
    engineInertia: 0.30, gasTempFactor: 1.32,
    pulse: { attack: 48, decay: 7.8, hardness: 0.80, jitter: 0.8 },
    exhaust: { bank: 0.82, collector: 0.66, reflection: 0.46, damping: 0.27, muffler: [0.19, 0.13, 0.09] },
    intake: { helmholtz: 148, q: 7.4, level: 0.45 },
    turbo: null,
    voice: 1.02,
  },

  v12: {
    label: 'V12 6.5',
    cylinders: 12, firingOrder: [1, 7, 5, 11, 3, 9, 6, 12, 2, 8, 4, 10],
    banks: [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]],
    idleRpm: 850, redlineRpm: 8500, peakTorque: 690, peakTorqueRpm: 5800,
    engineInertia: 0.36, gasTempFactor: 1.31,
    pulse: { attack: 46, decay: 7.4, hardness: 0.78, jitter: 0.5 },
    exhaust: { bank: 0.90, collector: 0.70, reflection: 0.47, damping: 0.28, muffler: [0.20, 0.14, 0.09] },
    intake: { helmholtz: 142, q: 7.0, level: 0.44 },
    turbo: null,
    voice: 1.04,
  },
};

/**
 * Crank angle (0–720°) at which each cylinder fires.
 * @returns {Map<number, number>} cylinder number -> firing angle in degrees
 */
export function firingAngles(profile) {
  const n = profile.cylinders;
  const interval = 720 / n;
  const map = new Map();
  profile.firingOrder.forEach((cyl, i) => {
    const trim = (profile.pinOffsets && profile.pinOffsets[cyl]) || 0;
    map.set(cyl, (i * interval + trim + 720) % 720);
  });
  return map;
}

/** Firing angles for one exhaust bank, sorted. Used to build that bank's wavetable. */
export function bankAngles(profile, bankIndex) {
  const all = firingAngles(profile);
  return profile.banks[bankIndex].map(c => all.get(c)).sort((a, b) => a - b);
}

/**
 * Acoustic length of a pipe as a quarter-wave resonator, in Hz.
 * Exhaust gas is hot, so the speed of sound in it is well above 343 m/s;
 * gasTempFactor scales for that and is why an exhaust note is higher-pitched
 * than pipe length alone would suggest.
 */
export function pipeFrequency(lengthMetres, gasTempFactor = 1) {
  return (C * gasTempFactor) / (4 * Math.max(0.05, lengthMetres));
}

/** Round-trip delay of a pipe in seconds — the waveguide's delay-line length. */
export function pipeDelay(lengthMetres, gasTempFactor = 1) {
  return (2 * Math.max(0.05, lengthMetres)) / (C * gasTempFactor);
}

export const SPEED_OF_SOUND = C;

// ---------------------------------------------------------------------------
// Vehicle / drivetrain presets
// ---------------------------------------------------------------------------

export const VEHICLE_PRESETS = {
  hatch: {
    label: 'Hot hatch', mass: 1320, wheelRadius: 0.31, finalDrive: 4.05,
    gearRatios: [3.31, 2.13, 1.48, 1.14, 0.95, 0.82],
    dragArea: 0.68, rollingResistance: 0.014, brakeForce: 9500,
    gearbox: 'manual', shiftTimeMs: 130, gearTeeth: [37, 31, 27, 24, 22, 20],
  },
  sports: {
    label: 'Sports car', mass: 1450, wheelRadius: 0.33, finalDrive: 3.73,
    gearRatios: [3.55, 2.05, 1.39, 1.00, 0.82, 0.67],
    dragArea: 0.62, rollingResistance: 0.013, brakeForce: 12000,
    gearbox: 'manual', shiftTimeMs: 95, gearTeeth: [39, 33, 28, 25, 22, 19],
  },
  supercar: {
    label: 'Supercar (dual-clutch)', mass: 1560, wheelRadius: 0.34, finalDrive: 3.90,
    gearRatios: [3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.69],
    dragArea: 0.60, rollingResistance: 0.012, brakeForce: 15000,
    gearbox: 'dct', shiftTimeMs: 45, gearTeeth: [41, 35, 30, 26, 23, 20, 18],
  },
  muscle: {
    label: 'Muscle car', mass: 1720, wheelRadius: 0.35, finalDrive: 3.55,
    gearRatios: [2.97, 2.07, 1.43, 1.00, 0.71],
    dragArea: 0.78, rollingResistance: 0.016, brakeForce: 11000,
    gearbox: 'manual', shiftTimeMs: 150, gearTeeth: [35, 30, 26, 23, 20],
  },
  truck: {
    label: 'Pickup (automatic)', mass: 2400, wheelRadius: 0.38, finalDrive: 3.73,
    gearRatios: [4.17, 2.34, 1.52, 1.14, 0.87, 0.69],
    dragArea: 1.05, rollingResistance: 0.018, brakeForce: 13000,
    gearbox: 'auto', shiftTimeMs: 190, gearTeeth: [43, 36, 31, 27, 24, 21],
  },
};

/** Driveline compliance — the torsional spring, damper and backlash that make
 *  a real gear engagement clunk and then shuffle instead of snapping. */
export const DRIVELINE_DEFAULTS = {
  stiffness: 5200,      // N·m per radian of twist, referred to the gearbox output
  // Reflected engine inertia falls as the ratio drops, so a FIXED damper rate
  // gives zeta ∝ 1/sqrt(J_eff) and no single value works across the gearbox:
  // 34 left 6th critically damped (zeta 0.53, no shuffle at all) while 13 left
  // 1st at zeta 0.048 — a 322 rpm, 8 Hz pitch warble that sounds like a wobble.
  // So specify the RATIO and derive the coefficient per gear. Physically this
  // stands in for tyre slip and clutch-damper hysteresis, which scale with the
  // mode rather than being a fixed rate.
  dampingRatio: 0.22,
  damping: 13,          // fallback if dampingRatio is nulled out
  backlash: 0.035,      // rad of free play before the teeth make contact
  clutchTorqueCapacity: 900,   // N·m the clutch can hold before slipping
  clutchStiffness: 3.2,        // engagement rate
};
