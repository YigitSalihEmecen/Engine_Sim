# Module contract — read this before editing anything in `src/`

Pure Web Audio API + ES6 modules. **No external libraries. No samples.** Target
< 5% CPU: no per-frame node allocation, no per-frame `new`, no AudioWorklet
(we stay on the main-thread node graph so this runs everywhere).

## Files and ownership

| File | Owner | Purpose |
| --- | --- | --- |
| `profiles.js` | orchestrator | engine + vehicle data, firing geometry helpers. **Do not edit.** |
| `presets.js` | orchestrator | the sound file format: schema, defaults, validation. **Add a schema row for every profile field**, or `run.mjs` fails on the orphan check. |
| `pulse.js` | orchestrator | firing geometry → `PeriodicWave` tables. **Do not edit.** |
| `resonators.js` | agent A | exhaust waveguides, muffler, intake Helmholtz, nonlinearity, cabin |
| `layers.js` | agent B | transmission, turbo, noise beds, transients |
| `physics.js` | agent C | drivetrain, driveline compliance, clutch |
| `shift.js` | agent C | gear-shift state machine |
| `character.js` | agent A | exhaust flow noise, sub layer, imperfection modulator |
| `fx.js` | orchestrator | EQ, reverb, stereo widener, three-band compressor |
| `engine-sim.js` | orchestrator | public API, wires everything together |

Only edit the file you own. If you need a change in someone else's file, say so
in your report instead of making it.

## Audio module shape

Every audio module (`resonators.js`, `layers.js`) exports a class:

```js
export class Thing {
  constructor(ctx, profile, opts) { ... }
  get input()  { return <AudioNode|null> }   // null if it generates its own signal
  get output() { return <AudioNode> }
  update(p) { ... }        // called once per frame with the params object below
  dispose() { ... }        // stop sources, disconnect
}
```

Rules:
- Build every node **once**, in the constructor. `update()` may only write
  `AudioParam`s and schedule envelopes.
- Write params with `setTargetAtTime(value, p.now, tc)` (tc ≈ 0.02) so the sound
  stays smooth if the frame rate stutters. Never assign `.value` per frame.
- Schedule transients **ahead of `p.now`** on the audio clock, never on the frame
  clock, and reuse a shared gain/filter pair rather than allocating per event.
- Guard every value: `AudioParam` writes must be finite, and
  `exponentialRampToValueAtTime` targets must be strictly > 0.
- Clamp all frequencies to `[10, 20000]`.
- **`Q` is in DECIBELS for `lowpass` and `highpass`** and linear for every other
  biquad type. Butterworth is `Q = -3.01`, not `0.7071`.
- Nothing may put sustained narrowband energy in **2-6 kHz**. That is where the
  ear peaks and where every harshness complaint has come from. Check with
  `node test/spectrum.mjs`; `run.mjs` fails the build above 4 % of radiated
  power in that band.

## The params object

The orchestrator fills one object per frame and passes the same object to every
module. Treat it as read-only.

```js
{
  now,            // ctx.currentTime, seconds
  dt,             // frame delta, seconds

  rpm,            // current engine rpm
  f0,             // rpm / 120  — Hz of one 720° engine cycle. Wavetable oscillators run at f0.
  rpmNorm,        // 0..1 across idle..redline
  dRpm,           // d(rpm)/dt, rpm per second. Signed. Drives shift transients.

  throttle,       // 0..1 raw pedal
  load,           // 0..1 smoothed combustion load
  overrun,        // 0..1 how far into deceleration fuel cut-off we are (DFCO)
  torqueSign,     // +1 driving, -1 engine braking

  gear,           // 0 = neutral, 1..N
  gearRatio,      // total ratio incl. final drive, 0 in neutral
  speed,          // m/s
  wheelRpm,       // driveshaft rpm — gearbox whine tracks this, not engine rpm
  clutchSlip,     // engine rpm minus geared rpm; non-zero while slipping
  clutchEngaged,  // 0..1

  boost,          // 0..1 turbo boost (always 0 on naturally aspirated profiles)
  shifting,       // bool
  shiftPhase,     // '' | 'cut' | 'open' | 'sync' | 'engage' | 'lash' | 'shuffle'

  // one-frame impulse flags — non-zero for exactly one frame, magnitude 0..1
  evCut,          // ignition cut → exhaust bang
  evLash,         // driveline backlash impact → clunk
  evEngage,       // clutch bite
  evBov,          // blow-off valve released
  evShiftDone,
}
```

## Testing

`node ../test/run.mjs` runs the headless harness. It mocks Web Audio, drives the
sim through scripted manoeuvres, and **throws on any non-finite AudioParam write,
out-of-range frequency, or per-frame allocation**. Your module must pass it.
Add cases for your own module there — that file is shared, append only.

Nobody can listen to the output in this environment. So: justify parameter
choices physically (pipe length, resonance, inertia) in a comment rather than
picking numbers by feel, and make anything genuinely taste-based an option with
a documented default.
