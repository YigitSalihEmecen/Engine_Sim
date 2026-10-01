/**
 * inputs.js — live performance inputs.
 *
 * A preset is a SOUND: the machine plus how it is mixed. These are the other
 * half — what is happening to that machine right now, which a host (a game, a
 * telemetry feed, a MIDI controller, the console's sliders) drives every frame.
 * They are deliberately not in the preset: a tunnel is not part of a V8.
 *
 * Every input is a normalised 0..1 scalar, so any source can be mapped onto
 * any of them without knowing their internals. The console builds its
 * "Live inputs" panel by walking this table, exactly as it does PRESET_SCHEMA.
 *
 *   sim.setInput('strain', 0.6)
 *   sim.setInputs({ distance: 0.3, environment: 1 })
 *   EngineSim.inputs()   // this table
 */
export const INPUT_SCHEMA = Object.freeze([
  { id: 'strain', label: 'Strain', default: 0,
    note: 'Engine working against something — a climb, a trailer, a heavy car. More rumble, harder combustion, more growl, at the same throttle.' },
  { id: 'aggression', label: 'Exhaust valve', default: 0,
    note: 'Active exhaust bypass. Opens the muffler: shallower chambers, brighter packing, more rasp and more level.' },
  { id: 'roughness', label: 'Roughness', default: 0,
    note: 'Engine health. Cycle-to-cycle variation and random misfires — a skipped combustion event in the pipe.' },
  { id: 'distance', label: 'Distance', default: 0,
    note: 'Listener distance. Air absorption takes the top off, level falls, and the room takes over.' },
  { id: 'environment', label: 'Enclosure', default: 0,
    note: 'Open road → tunnel. Hard parallel walls: dense fluttering reflections and a longer tail.' },
]);

export const DEFAULT_INPUTS = Object.freeze(
  Object.fromEntries(INPUT_SCHEMA.map(r => [r.id, r.default])));
