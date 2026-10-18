<div align="center">

# Engine Sim

**Procedural car engine audio for the browser.**
No samples, no dependencies. Every sound is synthesised live from firing geometry
and a simulated drivetrain, using nothing but the Web Audio API.

### [▶ Try it in your browser](https://yigitsalihemecen.github.io/Engine_Sim/) · [🔊 Listen to samples](https://yigitsalihemecen.github.io/Engine_Sim/samples.html)

</div>

---

## Listen

Ten seconds each, **naturally aspirated then turbo**: full throttle from a
standstill, autoshifting, with three lifts — synthesised by the simulator
itself, no recordings. Press play right here, or open the
**[listening page](https://yigitsalihemecen.github.io/Engine_Sim/samples.html)** for a live spectrum and synced rpm / gear / boost.

#### Inline-4

https://github.com/user-attachments/assets/0d1fe665-7548-4761-b44b-d90d225e4a68

#### Inline-6

https://github.com/user-attachments/assets/7ac09f49-6c75-4a09-acd7-f36286bc73eb

#### V8 cross-plane

https://github.com/user-attachments/assets/13df5f02-452d-4d34-bebd-370c6f50f77c

#### V10

https://github.com/user-attachments/assets/617dc6f7-cb27-4c4e-80ed-f1d87b60835d

#### V12

https://github.com/user-attachments/assets/704bd0c3-52c5-4b44-aa54-836ae09bc69b

<sub>Regenerate with <code>node tools/samples.mjs</code> (audio + spectrograms) and <code>node tools/samples.mjs --video</code>.</sub>

---

## Quick start

```js
import { EngineSim } from './src/engine-sim.js';

const sim = new EngineSim(null, { engine: 'v8cross', vehicle: 'sports' });
await sim.start();               // call from a user gesture

function frame(dt) {
  sim.setThrottle(gas);          // 0..1
  sim.setBrake(brake);
  sim.update(dt);                // seconds
}
```

That's the whole integration: 16 engines, 5 chassis, any of them with a turbo,
and zero allocation per frame.

**Run it locally:** `npm start`, then open `http://localhost:8000`. Press
**Start engine**, drive with **W / S**, shift with **Q / E**, toggle the turbo
with **T**. You need a server because ES modules won't load from `file://`.

On a phone, press **Drive** (or open `?drive`) for the touch cockpit: a gated
H-pattern lever under one thumb, pedals under the other.

---

## What makes it sound like a car

- **Every firing is its own event.** An AudioWorklet fires each cylinder at its
  real crank angle, with cycle-to-cycle variation, timing jitter and the odd
  misfire. A cross-plane V8 burbles because its banks fire unevenly, and nobody
  had to tune that in.
- **Physical exhaust.** Digital waveguide pipes feed a collector and a reactive
  muffler, with shock-front rasp under load.
- **Compliant drivetrain.** Engine, clutch, gearbox and wheels are joined by a
  torsional spring with backlash, so gear-lash clunk, shuffle and clutch slip
  emerge from the physics. The gearbox is designed for each engine × car pair.
- **Dynamics.** A bark when you stab the throttle, and exhaust pops that depend
  on heat, revs and how hard you lifted.
- **Bolt-on turbo.** Spool whine, flow rush, blow-off valve and the
  compressor-surge *stu-stu-stu*. It works on any engine and fades out cleanly
  through gear changes.

---

## API

| | |
| --- | --- |
| `await sim.start()` · `sim.stop()` · `sim.dispose()` | Lifecycle. `start()` needs a user gesture. |
| `sim.update(dt)` | Advance by `dt` seconds, once per frame. |
| `setThrottle` · `setBrake` · `setClutch` | `0..1` |
| `shiftUp()` · `shiftDown()` · `setGear(n)` · `setAutoShift(bool)` | Shifts return `false` if they would over-rev. |
| `setEngineType(id)` · `setVehicle(id)` · `setVehicleProfile(obj)` | Hot-swappable while driving. |
| `setTurbo(bool)` | Bolt a turbo onto any engine. Also `new EngineSim(ctx, { turbo: true })`. |
| `setInputs({ strain, aggression, roughness, distance, environment })` | Live 0..1 inputs: labouring, active exhaust valve, engine health, camera distance, tunnel. |
| `getState()` | rpm, speed, gear, boost, load, shift phase, … everything a HUD needs. |
| `getEvents()` | One-frame impulses (`lash`, `pop`, `cut`, `engage`, `bov`, `misfire`, `shiftDone`) for camera shake and haptics. |
| `takePops()` | Every exhaust bang since the last call, on the audio clock, for flames in sync with the sound. |
| `setMix` · `setTone` · `setEQ` · `setReverb` · `setWidth` · `setPosition` | Sound shaping. `setPosition(0..1)` blends exterior → cabin. |
| `loadPreset` · `exportPreset` · `setParam(path, v)` | A preset is one whole sound as JSON. |
| `EngineSim.engines()` · `vehicles()` · `schema()` · `inputs()` | Static listings for building a UI. |
| `sim.connect(node)` · `opts.destination` | Route the output into your own mixer. |

---

## Engines

`vtwin` · `i3` · `rotary2` · `i4` · `boxer4` · `i5` · `i6` · `i6diesel` · `v6` ·
`v6tt` · `flat6` · `v8cross` · `v8tt` · `v8flat` · `v10` · `v12`

**Chassis:** `hatch` · `sports` · `supercar` · `muscle` · `truck`. The chassis
decides how the revs move, the gearbox whine and whether a shift is a manual
cut, a dual-clutch overlap or a converter slip.

---

## Under the hood

[`AGENT_CONTEXT.md`](AGENT_CONTEXT.md) has it all: the signal graph, the physics,
why every constant is what it is, the bug ledger and the test suite.

MIT licence.
