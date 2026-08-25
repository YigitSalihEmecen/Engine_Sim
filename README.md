# Engine Sim

Procedural car engine audio for the browser. **No samples, no dependencies** —
every sound is synthesised in real time from the engine's firing geometry and a
physically simulated drivetrain, using nothing but the Web Audio API.

Drop it into a driving game and it will bark, burble, whine, flutter and clunk
its way through a gear change on its own.

```js
import { EngineSim } from './src/engine-sim.js';

const sim = new EngineSim(null, { engine: 'v8cross', vehicle: 'sports' });
await sim.start();                    // must be called from a user gesture

function frame(dt) {
  sim.setThrottle(gas);               // 0..1
  sim.setBrake(brake);
  sim.update(dt);                     // seconds
}
```

That is the whole integration. 16 engines, 5 chassis, ~290 audio nodes, zero
allocation per frame.

---

## Try it

```sh
npm start          # → http://localhost:8000
```

No install step — `npm start` runs a small zero-dependency static server from
`tools/serve.mjs`. Open the page and press **Ignition** (browsers will not start
audio without a gesture), then drive it with **W** / **S** and shift with
**Q** / **E**.

> It has to be served over `http://`. ES modules cannot load from a `file://`
> origin, so double-clicking `index.html` gives you a page that renders and does
> nothing. Any static server works; `python3 -m http.server 8000` is equivalent.

The bundled console is a tuning rig, not the product — an instrument cluster,
live telemetry, a per-bank order spectrum, and controls for the voice mix, tone,
EQ, reverb and compressor.

### On a phone

Press **Drive** (or open `index.html?drive`) for the touch cockpit: a real
H-pattern shift lever you drag between gears under one thumb, throttle and brake
under the other, telemetry between them. Turn the phone landscape and both
thumbs reach without moving your hands.

The lever is properly gated — slide along the neutral channel, pull into a
column, and you are locked to that column until you come back, so you can find a
gear without looking at it. The gate springs back if the gearbox refuses one.
**Swap sides** mirrors the layout for left-handers, and there are up/down
paddles as well, which is usually what you want in auto mode.

---

## How it works

**The engine note is built from firing geometry, not from stacked oscillators.**

A four-stroke fires each cylinder once every two crank revolutions, so the
fundamental period is 720° and `f₀ = rpm/120`. Engine *orders* are therefore
multiples of 0.5 — and the half-orders are where an engine's character lives.

So instead of hand-tuning partials per engine, each exhaust bank's real 720°
pressure cycle is built: a combustion pulse at every crank angle where that
bank's cylinders actually fire, differentiated (radiation from an open pipe end
is proportional to dQ/dt), FFT'd, and handed to `createPeriodicWave`.

The interesting part is what falls out for free. Measured half-order energy per
bank, with nothing tuned per engine:

| engine | bank 1 fires at | half-order energy |
| --- | --- | --- |
| V8 cross-plane | 0 / 270 / 540 / 630° | **31 %** ← the burble |
| V8 flat-plane | 0 / 180 / 360 / 540° | **0 %** ← the scream |
| Inline-4, Inline-6 | even intervals | 0 % |
| V10 | 5 cylinders per bank | 62 % (2.5-order) |

A cross-plane V8 burbles because its banks fire unevenly *through separate
pipes*. Nobody told it to. Change the firing order and the character changes
with it.

**Everything downstream is a physical model too.** The exhaust is a pair of
digital waveguides feeding a collector and a reactive muffler. The drivetrain is
four inertias joined by a clutch and a torsional spring with a backlash
dead-band, integrated on a 0.5 ms sub-step — so gear-lash clunk, driveline
shuffle and clutch slip are *emergent* rather than scripted. Turbo flutter
happens because closing the throttle against a still-spinning compressor stalls
it.

**It is verified numerically**, because nothing in a CI box can hear. A strict
Web Audio mock throws on non-finite parameter writes, out-of-range frequencies
and per-frame allocation; an audibility audit proves every source is started and
reaches the output; and `test/spectrum.mjs` reconstructs the entire chain's
frequency response analytically, so a question like "is this harsh?" gets a
number instead of an opinion.

---

## API

Everything lives on one class.

### Lifecycle

| | |
| --- | --- |
| `new EngineSim(ctx, opts)` | `ctx` may be `null` to create one. Options below. |
| `await sim.start()` | Call from a user gesture. Resumes the context and fades in. |
| `sim.stop()` | Fades out and stops. `start()` rebuilds and works again. |
| `sim.dispose()` | Releases every node. |
| `sim.update(dt)` | Advance by `dt` **seconds**. Once per frame. Chainable. |

Constructor options: `{ engine, vehicle, volume, perspective, mix, destination }`
plus any drivetrain override (`autoShift`, `launchFlareRpm`, `driveline`, …).

### Driving

| | |
| --- | --- |
| `setThrottle(0..1)` · `setBrake(0..1)` · `setClutch(0..1)` | |
| `shiftUp()` · `shiftDown()` · `setGear(n)` | Return `false` if refused (would over-rev). |
| `setAutoShift(bool)` | Automatic mode. On by default. |

### Machine

| | |
| --- | --- |
| `setEngineType(id)` | Hot-swappable while driving. |
| `setVehicle(id)` | Road speed is preserved across the swap. |
| `EngineSim.engines()` | `[{id, label, cylinders, turbo, idleRpm, redlineRpm, peakTorque, banks}]` |
| `EngineSim.vehicles()` | `[{id, label, mass, gears, gearbox, finalDrive}]` |

Both listings are **static** — call them before you have an AudioContext to
build a picker.

### Reading it back

| | |
| --- | --- |
| `getState()` | `rpm`, `speed`, `speedKmh`, `gear`, `gearRatio`, `clutchSlip`, `load`, `rpmNorm`, `dRpm`, `boost`, `shiftPhase`, `redline`, `idle`, `gearCount`, `throttle`, `brake`, `auto`, `perspective`, `volume`, `mix`, engine/vehicle ids and labels. |
| `getEvents()` | One-frame impulses, 0..1: `lash`, `pop`, `cut`, `engage`, `bov`, `shiftDone`. |
| `getReduction()` | Live compressor gain reduction per band, in dB. |

`getEvents()` is what you hang camera shake, particles and haptics off — `lash`
is the driveline clunk, `pop` an exhaust bang, `engage` the clutch biting.

### Sound

| | |
| --- | --- |
| `setVolume(0..1)` | |
| `setMix({exhaust, intake, transmission, turbo, transients, sub})` | Per-voice balance, 0..2. |
| `setTone({rumble, brightness})` | 0..2 each, 1 = default. |
| `setDynamics(0..1)` | Three-band compressor amount. 0 ≈ bypass. |
| `setEQ([5 gains])` · `setEQBand(i, dB)` · `resetEQ()` | ±18 dB at 60 / 200 / 800 / 2.5k / 8k. |
| `setReverb({mix, size, damping})` | **`size` rebuilds an impulse response (~6 ms) — debounce it.** |
| `setWidth(0..1)` | Mono-sum safe. |
| `setPopDepth(0..2)` | How much transient energy goes back through the exhaust. |
| `setPerspective('exterior'\|'interior')` · `setPosition(0..1)` | Listener position; `setPosition` is continuous. |

### Presets

A preset is one whole sound in one JSON-safe object — the machine (geometry,
pipe lengths, pulse shape, turbo) *and* the mix, tone, EQ and effects on top of
it. Save it, mail it, load it somewhere else and you get the same sound.

```js
sim.loadPreset('v8cross');          // a built-in, by id
sim.loadPreset(jsonStringOrObject); // one you saved earlier
const json = sim.exportPreset();    // pretty JSON, ready to write to a file
sim.setParam('engine.exhaust.bank', 1.4);   // one parameter, by path
```

| | |
| --- | --- |
| `loadPreset(id \| object \| json)` | Applies the whole sound. Returns `false` if it could not be read. |
| `getPreset()` · `exportPreset()` | The current sound as an object / as pretty JSON. |
| `setParam(path, v)` · `getParam(path)` | One parameter by dotted path. Returns the clamped value, or `null` if the path does not apply. |
| `EngineSim.schema()` · `EngineSim.groups()` | Every adjustable parameter, with range, step, unit and group — enough to build a UI from. |
| `EngineSim.presets()` | All sixteen built-ins as complete presets. |
| `new EngineSim(ctx, { preset })` | Start from a preset instead of configuring afterwards. |

`normalisePreset()` clamps and repairs anything hand-edited, so a corrupt file
loads as a usable sound rather than taking the graph down. The console builds
all of its controls by walking `EngineSim.schema()`, which is also what the test
suite uses to prove no parameter exists that nothing reads.

### Routing into your own graph

By default the output goes to `ctx.destination`. To put it through your own
mixer instead:

```js
const musicBus = ctx.createGain();
const sim = new EngineSim(ctx, { destination: musicBus });

sim.connect(analyserNode);   // move it later
sim.output;                  // the master GainNode
```

---

## The engines

| id | |
| --- | --- |
| `vtwin` | 90° V-twin, fires at 0/270°. The lumpiest thing here — 51 % half-order energy. |
| `i3` | 1.0 turbo triple. Small recirculating valve, so it flutters hard. |
| `rotary2` | Two-rotor Wankel. Overlapping pulses, 9000 rpm. |
| `i4` | 2.0 naturally aspirated four. |
| `boxer4` | Flat-four with unequal headers — the rumble is the header mismatch, not the firing order. Big atmospheric valve: the "chiu" engine. |
| `i5` | 2.5 five-cylinder turbo, 2.5-order warble. |
| `i6` | 3.0 straight six, inherently balanced. |
| `i6diesel` | 6.7 turbo-diesel. Near-step pressure rise, 4600 rpm redline. |
| `v6` | 60° V6. |
| `v6tt` | 3.8 twin-turbo V6, fast-spooling. |
| `flat6` | 3.8 flat-six, 8500 rpm, induction howl. |
| `v8cross` | Cross-plane 5.0 — the burble. |
| `v8tt` | 4.0 twin-turbo V8. Same firing order as `v8cross`, muffled by the turbines into a thud. |
| `v8flat` | Flat-plane 4.5, 9000 rpm, zero half-orders, pure scream. |
| `v10` | 5.2 V10. |
| `v12` | 6.5 V12. |

Turbocharged: `i3` `boxer4` `i5` `i6` `i6diesel` `v6tt` `v8tt`.

Chassis: `hatch` `sports` `supercar` `muscle` `truck`. The chassis changes more
than you would expect. It sets how rpm evolves over time — so it writes the
melody — plus the gearbox whine pitch in every gear, the driveline shuffle
frequency, and whether a shift is a hard torque cut, a dual-clutch overlap or a
converter slip.

---

## Development

```sh
npm test           # 335 checks + a driving-behaviour suite
npm run spectrum   # analytic harshness table for every engine
```

```
index.html          the tuning console
tools/serve.mjs     zero-dependency dev server
src/profiles.js     engine + vehicle data — firing order, bank layout, pipe geometry
src/pulse.js        firing geometry → band-limited PeriodicWave tables
src/resonators.js   exhaust waveguides, muffler, Helmholtz intake, shock rasp, cabin
src/layers.js       gear whine, turbo, transient bank
src/character.js    exhaust flow noise, sub layer, imperfection modulator
src/fx.js           EQ, reverb, stereo widener, three-band compressor
src/physics.js      drivetrain with torsional compliance and backlash
src/shift.js        gear-shift state machine
src/gate.js         H-pattern gear-gate geometry (UI-side, no audio)
src/engine-sim.js   public API
```

`AGENT_CONTEXT.md` is the deep dive: the full signal graph, why each constant is
the value it is, and a bug ledger with the measurement behind every fix.

## Licence

MIT
