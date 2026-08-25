/**
 * presets.js — the sound file format.
 *
 * A PRESET is everything needed to reproduce one sound, in one plain object:
 * the machine (geometry, physics, pipe lengths, turbo) AND the mix, tone, EQ
 * and effects sitting on top of it. It is JSON-round-trippable, so "make a
 * sound, save it, load it somewhere else" is one object and two methods.
 *
 * Why this exists as its own module. The data used to be in three places —
 * `ENGINE_PROFILES` for the machine, `DEFAULT_MIX` in the orchestrator for the
 * balance, and constructor arguments scattered through fx.js for everything
 * else. Nothing tied them together, so an engine could not carry its own EQ,
 * there was no way to save what you had built, and two parameters (`voice` and
 * `pulse.hardness`) sat in every profile being read by nothing at all.
 *
 *   ENGINE_PROFILES stays the machine description and stays in profiles.js.
 *   A preset EMBEDS one of those under `engine` and adds the sound on top.
 *
 * ---------------------------------------------------------------------------
 * THE SCHEMA IS THE SOURCE OF TRUTH
 *
 * `PRESET_SCHEMA` below describes every adjustable parameter once: its path,
 * range, step, unit, and which group it belongs to. Three things consume it and
 * none of them may hard-code a parameter list:
 *
 *   - `normalisePreset()` clamps and fills, so hand-edited JSON cannot produce
 *     a NaN frequency or a negative gain and take the graph down;
 *   - the console builds its controls by walking it, so a parameter added here
 *     appears in the UI without touching the page;
 *   - `run.mjs` walks it in both directions and fails on an orphan — a schema
 *     entry the sim ignores, or a profile field the schema does not expose.
 *
 * That last one is the point. Both orphans above existed for months because
 * nothing could see them.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT IN HERE
 *
 * The vehicle. A preset is a sound, and the same engine goes in different cars;
 * mass, ratios and tyre radius belong to `VEHICLE_PRESETS`. Driving state
 * (gear, speed, throttle) is obviously not in here either.
 */

import { ENGINE_PROFILES } from './profiles.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const fin = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

/** Bumped when the shape changes incompatibly. `normalisePreset` fills gaps. */
export const PRESET_VERSION = 2;

/**
 * The sound half of a preset — everything that is not the machine.
 *
 * These are the values the simulator was already built with; collecting them
 * here is what makes a preset self-contained rather than "an engine plus
 * whatever the host happened to leave the knobs on".
 */
export const DEFAULT_SOUND = Object.freeze({
  mix: Object.freeze({
    exhaust: 1.0,
    intake: 0.75,
    transmission: 0.45,
    // Down 30 % from 0.7: the turbo is the one voice that always sits in the
    // band the ear is most sensitive to, so it wins the mix long before it is
    // loud. See TurboLayer's tone stage.
    turbo: 0.49,
    transients: 0.42,
    sub: 0.9,
  }),
  tone: Object.freeze({ rumble: 1, brightness: 1 }),
  /** dB per band: [sub 60, body 200, honk 800, rasp 2.5 k, air 8 k]. */
  eq: Object.freeze([0, 0, 0, 0, 0]),
  fx: Object.freeze({
    reverbMix: 0.14,
    reverbSize: 0.32,
    reverbDamping: 4200,
    width: 0.35,
    popDepth: 1.05,
    dynamics: 1,
  }),
  /** 0 = standing outside the car, 1 = sitting in it. Continuous. */
  position: 0,
  volume: 0.7,
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * One row per adjustable scalar.
 *
 *   path   dotted path into the preset object
 *   label  UI label
 *   min/max/step  range; `step` also decides how a value is displayed
 *   unit   how to read the number out. A real unit ('m', 'Hz', 'rpm', 'dB') is
 *          a suffix; '%' means the value is a 0..1-ish proportion and should be
 *          shown x100; '' means a plain number formatted by `step`.
 *   group  which panel it belongs to
 *   rebuild  true if changing it needs the voice graph rebuilt (wavetables,
 *            pipe lengths). Continuous params write to AudioParams instead.
 *
 * Non-scalar engine fields — `firingOrder`, `banks`, `pinOffsets` — are the
 * engine's ARCHITECTURE, not knobs. They are carried by a preset and validated,
 * but they are not in this table because a slider cannot express them.
 */
export const PRESET_SCHEMA = Object.freeze([
  // --- engine: the machine ------------------------------------------------
  { path: 'engine.idleRpm', label: 'Idle', min: 400, max: 2500, step: 10, unit: 'rpm', group: 'engine', rebuild: false },
  { path: 'engine.redlineRpm', label: 'Redline', min: 3000, max: 12000, step: 100, unit: 'rpm', group: 'engine', rebuild: false },
  { path: 'engine.peakTorque', label: 'Peak torque', min: 40, max: 1400, step: 5, unit: 'N·m', group: 'engine', rebuild: false },
  { path: 'engine.peakTorqueRpm', label: 'Torque peak at', min: 1200, max: 9000, step: 100, unit: 'rpm', group: 'engine', rebuild: false },
  { path: 'engine.engineInertia', label: 'Rotating inertia', min: 0.02, max: 1.2, step: 0.005, unit: 'kg·m²', group: 'engine', rebuild: false },
  { path: 'engine.gasTempFactor', label: 'Gas temperature', min: 0.8, max: 1.8, step: 0.01, unit: '×c', group: 'engine', rebuild: true },
  { path: 'engine.voice', label: 'Voice level', min: 0.2, max: 2, step: 0.01, unit: '%', group: 'engine', rebuild: false },

  // --- pulse: the shape of one combustion event ---------------------------
  { path: 'engine.pulse.attack', label: 'Blowdown attack', min: 5, max: 90, step: 1, unit: '', group: 'pulse', rebuild: true },
  { path: 'engine.pulse.decay', label: 'Blowdown decay', min: 1, max: 14, step: 0.1, unit: '', group: 'pulse', rebuild: true },
  { path: 'engine.pulse.hardness', label: 'Load hardening', min: 0, max: 1.5, step: 0.01, unit: '', group: 'pulse', rebuild: true },
  { path: 'engine.pulse.jitter', label: 'Cylinder jitter', min: 0, max: 6, step: 0.1, unit: '', group: 'pulse', rebuild: true },

  // --- exhaust ------------------------------------------------------------
  { path: 'engine.exhaust.bank', label: 'Header length', min: 0.2, max: 2.5, step: 0.01, unit: 'm', group: 'exhaust', rebuild: true },
  { path: 'engine.exhaust.collector', label: 'Collector length', min: 0.2, max: 3, step: 0.01, unit: 'm', group: 'exhaust', rebuild: true },
  { path: 'engine.exhaust.reflection', label: 'End reflection', min: 0.05, max: 0.9, step: 0.01, unit: '', group: 'exhaust', rebuild: true },
  { path: 'engine.exhaust.damping', label: 'Pipe damping', min: 0.1, max: 1.5, step: 0.01, unit: '', group: 'exhaust', rebuild: true },
  { path: 'engine.exhaust.muffler.0', label: 'Muffler stage 1', min: 0, max: 0.8, step: 0.01, unit: 'm', group: 'exhaust', rebuild: true },
  { path: 'engine.exhaust.muffler.1', label: 'Muffler stage 2', min: 0, max: 0.8, step: 0.01, unit: 'm', group: 'exhaust', rebuild: true },
  { path: 'engine.exhaust.muffler.2', label: 'Muffler stage 3', min: 0, max: 0.8, step: 0.01, unit: 'm', group: 'exhaust', rebuild: true },

  // --- intake -------------------------------------------------------------
  { path: 'engine.intake.helmholtz', label: 'Plenum resonance', min: 40, max: 400, step: 1, unit: 'Hz', group: 'intake', rebuild: true },
  { path: 'engine.intake.q', label: 'Plenum Q', min: 0.5, max: 14, step: 0.1, unit: '', group: 'intake', rebuild: true },
  { path: 'engine.intake.level', label: 'Induction level', min: 0, max: 1.5, step: 0.01, unit: '%', group: 'intake', rebuild: true },

  // --- turbo (only meaningful when engine.turbo is present) ---------------
  { path: 'engine.turbo.inertia', label: 'Turbo inertia', min: 0.05, max: 2, step: 0.01, unit: 's', group: 'turbo', rebuild: false, needs: 'turbo' },
  { path: 'engine.turbo.maxBoost', label: 'Max boost', min: 0.2, max: 3, step: 0.05, unit: 'bar', group: 'turbo', rebuild: false, needs: 'turbo' },
  { path: 'engine.turbo.whineOrder', label: 'Blade order', min: 10, max: 120, step: 1, unit: '', group: 'turbo', rebuild: false, needs: 'turbo' },
  { path: 'engine.turbo.bov', label: 'Blow-off capacity', min: 0, max: 1, step: 0.01, unit: '%', group: 'turbo', rebuild: false, needs: 'turbo' },
  { path: 'engine.turbo.surge', label: 'Flutter trim', min: 0, max: 2, step: 0.01, unit: '%', group: 'turbo', rebuild: false, needs: 'turbo' },

  // --- mix ----------------------------------------------------------------
  { path: 'mix.exhaust', label: 'Exhaust', min: 0, max: 1.6, step: 0.01, unit: '%', group: 'mix', rebuild: false },
  { path: 'mix.intake', label: 'Intake', min: 0, max: 1.6, step: 0.01, unit: '%', group: 'mix', rebuild: false },
  { path: 'mix.transmission', label: 'Gearbox', min: 0, max: 1.6, step: 0.01, unit: '%', group: 'mix', rebuild: false },
  { path: 'mix.turbo', label: 'Turbo', min: 0, max: 1.6, step: 0.01, unit: '%', group: 'mix', rebuild: false },
  { path: 'mix.transients', label: 'Pops', min: 0, max: 1.6, step: 0.01, unit: '%', group: 'mix', rebuild: false },
  { path: 'mix.sub', label: 'Sub', min: 0, max: 1.6, step: 0.01, unit: '%', group: 'mix', rebuild: false },

  // --- tone + fx ----------------------------------------------------------
  { path: 'tone.rumble', label: 'Rumble', min: 0, max: 2, step: 0.01, unit: '%', group: 'tone', rebuild: false },
  { path: 'tone.brightness', label: 'Brightness', min: 0, max: 2, step: 0.01, unit: '%', group: 'tone', rebuild: false },
  { path: 'fx.popDepth', label: 'Pop depth', min: 0, max: 2, step: 0.01, unit: '%', group: 'tone', rebuild: false },
  { path: 'fx.dynamics', label: 'Compression', min: 0, max: 1, step: 0.01, unit: '%', group: 'tone', rebuild: false },
  { path: 'fx.reverbMix', label: 'Reverb mix', min: 0, max: 1, step: 0.01, unit: '%', group: 'fx', rebuild: false },
  { path: 'fx.reverbSize', label: 'Reverb size', min: 0.05, max: 1, step: 0.01, unit: '%', group: 'fx', rebuild: false },
  { path: 'fx.reverbDamping', label: 'Reverb damping', min: 800, max: 12000, step: 100, unit: 'Hz', group: 'fx', rebuild: false },
  { path: 'fx.width', label: 'Stereo width', min: 0, max: 1, step: 0.01, unit: '%', group: 'fx', rebuild: false },
  { path: 'position', label: 'Listener position', min: 0, max: 1, step: 0.01, unit: '%', group: 'fx', rebuild: false },
  { path: 'volume', label: 'Volume', min: 0, max: 1, step: 0.01, unit: '%', group: 'fx', rebuild: false },

  // --- EQ -----------------------------------------------------------------
  { path: 'eq.0', label: 'Sub 60', min: -18, max: 18, step: 0.5, unit: 'dB', group: 'eq', rebuild: false },
  { path: 'eq.1', label: 'Body 200', min: -18, max: 18, step: 0.5, unit: 'dB', group: 'eq', rebuild: false },
  { path: 'eq.2', label: 'Honk 800', min: -18, max: 18, step: 0.5, unit: 'dB', group: 'eq', rebuild: false },
  { path: 'eq.3', label: 'Rasp 2.5k', min: -18, max: 18, step: 0.5, unit: 'dB', group: 'eq', rebuild: false },
  { path: 'eq.4', label: 'Air 8k', min: -18, max: 18, step: 0.5, unit: 'dB', group: 'eq', rebuild: false },
]);

/** Group id → human label + one-line explanation, for the UI. */
export const PRESET_GROUPS = Object.freeze([
  { id: 'engine', label: 'Engine', note: 'The machine itself. Torque and inertia drive the physics; gas temperature sets the speed of sound in the pipes.' },
  { id: 'pulse', label: 'Combustion pulse', note: 'The shape of one cylinder blowing down. Attack is the crack, decay is the tail, hardening is how much both sharpen under load.' },
  { id: 'exhaust', label: 'Exhaust', note: 'Waveguide geometry in metres. Header and collector lengths set the resonances; reflection and damping set how many survive.' },
  { id: 'intake', label: 'Intake', note: 'Airbox Helmholtz resonance. It does not track rpm — what tracks rpm is how hard it is excited.' },
  { id: 'turbo', label: 'Turbo', note: 'Inertia is lag. Blow-off capacity trades the "chiu" against the "stu-stu-stu": a big valve empties the plenum so less can reverse through the wheel.' },
  { id: 'mix', label: 'Voice mix', note: 'Balance between the voices.' },
  { id: 'tone', label: 'Tone', note: 'The fixed-frequency part of the response, plus how hard the compressor works.' },
  { id: 'fx', label: 'Space', note: 'Reverb, width, where the listener is, and output level.' },
  { id: 'eq', label: 'EQ', note: 'Five bands, ±18 dB.' },
]);

// ---------------------------------------------------------------------------
// Path helpers — the schema addresses everything by dotted path
// ---------------------------------------------------------------------------

/** Read `obj` at a dotted path. Array indices are plain numbers in the path. */
export function getPath(obj, path) {
  let node = obj;
  for (const key of path.split('.')) {
    if (node == null) return undefined;
    node = node[key];
  }
  return node;
}

/** Write `obj` at a dotted path, creating plain objects on the way. */
export function setPath(obj, path, value) {
  const keys = path.split('.');
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node[keys[i]] == null || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
  return obj;
}

/** Schema row for a path, or undefined. */
export function schemaFor(path) {
  return PRESET_SCHEMA.find(s => s.path === path);
}

// ---------------------------------------------------------------------------
// Building and validating
// ---------------------------------------------------------------------------

/** Structured clone that survives the frozen literals in profiles.js. */
function deepCopy(v) {
  if (Array.isArray(v)) return v.map(deepCopy);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = deepCopy(v[k]);
    return o;
  }
  return v;
}

/**
 * The stock preset for a built-in engine: its profile plus the default sound.
 * Always a fresh deep copy — a preset is meant to be edited.
 */
export function builtinPreset(id) {
  const profile = ENGINE_PROFILES[id];
  if (!profile) return null;
  return normalisePreset({
    version: PRESET_VERSION,
    id,
    label: profile.label,
    engine: deepCopy(profile),
    ...deepCopy(DEFAULT_SOUND),
  });
}

/** Every built-in engine as a full preset, keyed by id. */
export function builtinPresets() {
  const out = {};
  for (const id of Object.keys(ENGINE_PROFILES)) out[id] = builtinPreset(id);
  return out;
}

/**
 * Fill, clamp and sanity-check an arbitrary object into a valid preset.
 *
 * Everything a user can hand-edit goes through here. The rule is that this
 * NEVER throws and never returns a value the graph cannot take: a JSON file
 * with a missing section, a string where a number should be, or a muffler array
 * of the wrong length all come back usable. Anything unrecognised is dropped
 * rather than passed through, so a stale file cannot smuggle a dead field back
 * into the sim.
 */
export function normalisePreset(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const base = ENGINE_PROFILES[src.id] || ENGINE_PROFILES.v8cross;
  const out = {
    version: PRESET_VERSION,
    id: typeof src.id === 'string' && src.id ? src.id : 'custom',
    label: typeof src.label === 'string' && src.label ? src.label : base.label,
    engine: {},
    mix: {},
    tone: {},
    eq: [],
    fx: {},
    position: 0,
    volume: 0.7,
  };

  // --- architecture: carried, not adjustable ------------------------------
  const e = (src.engine && typeof src.engine === 'object') ? src.engine : base;
  const nCyl = clamp(Math.round(fin(e.cylinders, base.cylinders)), 1, 16);
  out.engine.cylinders = nCyl;
  const order = Array.isArray(e.firingOrder) ? e.firingOrder.slice(0, nCyl) : null;
  // A firing order has to be a permutation of 1..n or firingAngles() silently
  // produces undefined angles and every wavetable comes out empty.
  const validOrder = order && order.length === nCyl
    && order.every(c => Number.isInteger(c) && c >= 1 && c <= nCyl)
    && new Set(order).size === nCyl;
  out.engine.firingOrder = validOrder ? order
    : (base.cylinders === nCyl ? deepCopy(base.firingOrder)
                               : Array.from({ length: nCyl }, (_, i) => i + 1));
  const banks = Array.isArray(e.banks) ? e.banks.filter(Array.isArray) : null;
  const flat = banks ? banks.flat() : [];
  const validBanks = banks && banks.length > 0
    && flat.length === nCyl && flat.every(c => out.engine.firingOrder.includes(c));
  out.engine.banks = validBanks ? deepCopy(banks)
    : (base.cylinders === nCyl ? deepCopy(base.banks) : [out.engine.firingOrder.slice()]);
  if (e.pinOffsets && typeof e.pinOffsets === 'object') {
    const po = {};
    for (const [k, v] of Object.entries(e.pinOffsets)) {
      const cyl = Number(k);
      if (Number.isInteger(cyl) && cyl >= 1 && cyl <= nCyl) po[cyl] = clamp(fin(v, 0), -360, 360);
    }
    if (Object.keys(po).length) out.engine.pinOffsets = po;
  }
  // Unequal headers: optional, and only meaningful with a second bank.
  const bankB = fin(e.exhaust && e.exhaust.bankB, NaN);
  out.engine.exhaust = {};
  if (isFinite(bankB) && out.engine.banks.length > 1) {
    out.engine.exhaust.bankB = clamp(bankB, 0.2, 2.5);
  }

  // Turbo is present-or-absent before it is adjustable: a schema row cannot
  // create the section, because "naturally aspirated" is not a slider value.
  const hasTurbo = e.turbo === null ? false
    : (e.turbo && typeof e.turbo === 'object') ? true
    : !!base.turbo;
  out.engine.turbo = hasTurbo ? {} : null;

  // --- every scalar the schema knows about --------------------------------
  const defaults = { engine: base, ...DEFAULT_SOUND };
  for (const row of PRESET_SCHEMA) {
    if (row.needs === 'turbo' && !hasTurbo) continue;
    let v = getPath(src, row.path);
    if (!isFinite(Number(v))) v = getPath(defaults, row.path);
    if (!isFinite(Number(v))) v = row.min;
    setPath(out, row.path, clamp(Number(v), row.min, row.max));
  }

  // The muffler is an array in the profile but addressed as `muffler.0..2`, so
  // setPath built a plain object for it. Convert back or resonators.js, which
  // iterates it, gets nothing.
  const m = out.engine.exhaust.muffler;
  out.engine.exhaust.muffler = [0, 1, 2].map(i => clamp(fin(m && m[i], 0.2), 0, 0.8));
  out.eq = [0, 1, 2, 3, 4].map(i => clamp(fin(out.eq[i], 0), -18, 18));

  return out;
}

/**
 * Preset → pretty JSON, for a download, a clipboard or an editable text box.
 *
 * Arrays of numbers are put back on one line. `JSON.stringify(x, null, 2)` gives
 * a twelve-cylinder firing order twelve lines of its own, which pushes
 * everything that matters off the bottom of the editor. Still strictly valid
 * JSON — this only removes whitespace the parser ignores.
 */
export function presetToJSON(preset) {
  const text = JSON.stringify(normalisePreset(preset), null, 2);
  return text.replace(/\[\s+((?:-?[\d.]+,?\s+)+)\]/g,
    (m, body) => '[' + body.trim().replace(/,\s+/g, ', ') + ']');
}

/**
 * JSON → preset. Returns `{ preset, error }`; never throws, because the input
 * is a file the user picked.
 */
export function presetFromJSON(text) {
  let raw;
  try {
    raw = JSON.parse(String(text));
  } catch (err) {
    return { preset: null, error: 'not valid JSON: ' + err.message };
  }
  if (!raw || typeof raw !== 'object') return { preset: null, error: 'not an object' };
  return { preset: normalisePreset(raw), error: null };
}
