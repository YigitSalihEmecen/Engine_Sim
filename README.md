# Engine Sound & Vehicle Physics Simulator

Procedural engine audio synthesised from **firing geometry**, driven by a
**compliant driveline**. Pure Web Audio API, no samples, no dependencies.

```sh
python3 -m http.server 8000    # ES modules need a server; file:// won't work
```

```
src/profiles.js     engine + vehicle data (firing order, bank layout, pipe geometry)
src/pulse.js        firing geometry → band-limited PeriodicWave tables
src/resonators.js   exhaust waveguides, muffler, Helmholtz intake, shock rasp, cabin
src/layers.js       valvetrain, gear whine, turbo, transient bank
src/physics.js      drivetrain with torsional compliance and backlash
src/shift.js        gear-shift state machine
src/engine-sim.js   public API
test/run.mjs        unit + sweep suite      (122 checks)
test/drive.mjs      driving-behaviour suite
```

---

## 1. The core idea: orders, not oscillators

A four-stroke fires each cylinder once every **two** crank revolutions, so the
fundamental period is 720° and `f₀ = RPM/120`. Engine "orders" are multiples of
**0.5**, and the half-orders are where an engine's character lives.

So instead of stacking hand-tuned partials, we build each exhaust bank's real
720° pressure cycle — a train of combustion pulses `(1−e^−ᵃᵈ)·e^−ᵇᵈ` at the crank
angles where that bank's cylinders actually fire — differentiate it (radiation
from an open pipe end is proportional to dQ/dt, so this is physics, not tone
shaping), and hand the Fourier coefficients to `createPeriodicWave`.

Two things fall out for free:

**Correct harmonics for any layout.** Measured half-order energy per bank, with
nothing tuned per engine:

| | bank 1 fires at | half-order energy |
| --- | --- | --- |
| V8 cross-plane | 0 / 270 / 540 / 630° | **31.4 %** ← the burble |
| V8 flat-plane | 0 / 180 / 360 / 540° | **0.0 %** ← the scream |
| I4, I6 | even intervals | 0.0 % |
| Flat-6, V10 | 3 and 5 cylinders per bank | 56 %, 62 % (1.5- and 2.5-order) |

A cross-plane V8 burbles because its banks fire unevenly *through separate
pipes*. Route both banks into one collector and the half-orders cancel — which
is exactly what happens on a real car with a cross-over exhaust.

**Perfect anti-aliasing at zero runtime cost.** `PeriodicWave` is band-limited
per playback frequency by the browser, so one oscillator per bank replaces a
whole partial stack and never aliases across a rev sweep.

## 2. Acoustic path

```
bank wavetable osc ×2 (soft/hard crossfade) ─→ Waveguide(bank) ─┐
                                                                 ├→ collector → Muffler → rasp ─┐
bank wavetable osc ×2 ───────────────────────→ Waveguide(bank) ─┘                               │
intake wavetable osc ────→ Helmholtz + induction turbulence ────────────────────────────────────┤
MechanicalLayer   valvetrain @ 0.5 order, injectors, chain, block modes ────────────────────────┤
TransmissionLayer mesh whine = driveshaft rpm × engaged gear's tooth count ─────────────────────┤
TurboLayer        lagged spool whine, BOV, flutter ─────────────────────────────────────────────┤
TransientBank     bangs, driveline clunk, clutch thump, synchro ────────────────────────────────┘
                                              → mix bus → CabinFilter → compressor → master
```

- **Waveguide** — delay line + in-loop lowpass + reflection, i.e. the
  Karplus-Strong structure the PTR engine-sound model uses. Web Audio forces a
  128-sample minimum delay inside a feedback loop; every profile's pipe delay
  (164–389 samples) clears it, with a resonant-bandpass fallback for shorter
  pipes. The in-loop lowpass has phase, which drops the resonance 2.7–6.1 %
  below `c/4L`, so the delay is phase-compensated rather than taken raw.
- **Nonlinearity** — asymmetric saturation. A real exhaust pulse at high SPL
  steepens into a shock front, which is why an engine gets *raspy* under load
  rather than just louder. Asymmetric (not `tanh`) because shock steepening
  generates even harmonics too.
- **Load** crossfades two wavetables (timbre) and separately scales amplitude by
  `load^0.7` (the PTR throttle factor). On overrun the pulse train nearly
  vanishes and the airflow and mechanical layers carry the sound.

## 3. Why gear changes have shape now

v1 computed `rpm = speed/r × ratio`. An infinitely rigid drivetrain makes a gear
change a step change in rpm — it sounds like a pitch jump because that is
literally all it is.

Real drivetrains are compliant. Following the driveline-clunk literature, engine
and wheels are two inertias joined by a **torsional spring-damper with a backlash
dead-band**. A measured upshift:

```
 t(ms)  phase     rpm    twist(rad)   slip   torque
     0  cut      4759   -0.03254        0       0     ignition cut, torque collapses
   100  sync     4543   -0.03536      538      -2     synchro matching shafts
   150  engage   4809    0.11704      834     453     clutch slipping, rpm converging
   200  lash     4401    0.14657      430     582     teeth take up backlash → CLUNK
   300  lash     3982    0.09183        0     289
   350  shuffle  3992    0.09784        0     329     torsional mode rings down
```

The rpm dip, the 845 rpm of genuine clutch slip, the wind-up to 0.149 rad and the
ring-down are all consequences of the model, not scripted.

Measured torsional mode, sports preset: **6.05 Hz in 1st → 25.6 Hz in 6th**.
Shuffle is a low-gear phenomenon, which matches reality. A throttle tip-in in 2nd
rings ~14 reversals over 1.5 s with a 0.027 rad swing.

Damping is specified as a **ratio**, not a coefficient. Reflected engine inertia
falls with the gear ratio, so `zeta ∝ 1/sqrt(J_eff)` and no fixed damper rate
works across a gearbox: 34 N·m·s left 6th at ζ=0.53 (dead), 13 left 1st at
ζ=0.048 — a 322 rpm, 8 Hz pitch warble. Deriving `c = 2·ζ·sqrt(k·J_red)` per gear
holds ζ=0.22 everywhere and drops the 1st/2nd gear wobble to 26 and 9 rpm.

## 3b. Exhaust pops

Researching this changed the model. Popping is unburnt fuel detonating in a hot
pipe, so two conditions gate it, and neither is "throttle closed":

- **Heat.** An exhaust gas temperature state with a long time constant (4.5 s
  rising, 2.2 s falling). Below ~0.45 normalised nothing lights off, so a gently
  driven car does not crackle and one that has just been worked does.
- **Fuel.** During *steady* deceleration fuel cut-off there is no fuel at all.
  What pops is the **transition** — a slug of raw fuel as the injectors close,
  and fuel sprayed onto a glowing pipe when they reopen.

Measured: gentle cruise then lift gives EGT 0.24 → pop intensity **0.000**; hard
driving then lift gives **0.418**.

Two discrete pop events are fired by the drivetrain, at the moments raw fuel
actually meets a hot pipe:

- **entering fuel cut** on a lift — the lift-off bang
- **the trailing edge of a rev-match blip** on a downshift, which sprays fuel and
  then shuts again. This is the classic downshift crackle.

Burst *shape* carries the engine's character: count and spacing scale inversely
with cylinder count, so a V12 throws two or three heavy lazy reports while an
inline-3 spits a fast irregular string. Decay within a burst is deliberately not
monotonic — real ones stutter, and an occasional late pop is louder than the one
before it. Roughly one lift in four resolves as a single hard crack instead of a
string, boosted so it reads as punchier rather than weaker.

**Lift-off scales steeply with the revs you cut at.** Charge in flight goes with
airflow, so the event magnitude carries `rpmN^1.7` — revs are the dominant term,
not a trim — multiplied by a peak-hold of recent throttle, so snapping shut from
wide open bangs and easing off does not. Measured, v8cross, five repeats each:

| rpm at cut | pops | loudest | total energy |
| --- | --- | --- | --- |
| 1612 | 3–4 | 0.03–0.06 | 0.07 |
| 3030 | 8–11 | 0.09–0.16 | 0.33 |
| 4516 | 13–17 | 0.23–0.56 | 1.43 |
| 6201 | 23–26 | 0.59–0.84 | 3.72 |

A ~50x energy range across the rev band. The spread *within* each row is real
randomisation, not variation between settings: how much fuel happens to be
mid-injection when the ECU pulls the injectors is luck, so no two lift-offs from
the same revs sound alike. The rpm at cut is also remembered, so a high-rpm lift
keeps muttering afterwards while a low-rpm one just stops.

The thermal constants matter more than they look. A first attempt used a 2.2 s
fall constant, which dumped EGT from 0.77 to 0.27 in four seconds and left a pop
window under a second — technically firing, practically inaudible. Cast iron
holds heat: at 26 s the exhaust is still at 0.63 twenty seconds after lifting, so
a warmed-up car crackles on every downshift for a while.

## 3c. Character layers (`character.js`)

The wavetable path is spectrally correct and on its own sounds like a buzzer.
Three things it does not contain, layered on top and modulated by the same state:

- **`ExhaustNoise`** — broadband flow noise injected *into* the exhaust
  waveguides, so it resonates in the same pipe as the combustion pulses, and
  chopped by a firing-rate pulse train because the flow arrives in slugs rather
  than steadily. A real exhaust is roughly half noise; a pure harmonic stack has
  none, which is exactly what "sounds like a fly" means. This is the single
  biggest change to how real it reads. It does **not** collapse on overrun — a
  closed throttle still pumps air, which is where the hollow coasting rush comes
  from.
- **`SubLayer`** — the bottom octave, which a small tailpipe model radiates
  weakly but a real car gets from body panels and ground coupling. Octave-shifted
  in half-orders per engine so it lands in the 41–83 Hz chest band at mid revs
  instead of 25 Hz on an I4 and 117 Hz on a V12, and mildly saturated so it
  survives on speakers that cannot reproduce the fundamental.
- **`CharacterModulator`** — time-varying imperfection. The wavetable's
  per-cylinder jitter is baked in and therefore *frozen*, so the ear reads it as
  just another periodic component. Three mutually irrational LFO rates plus
  filtered noise wander the oscillator detune and level, strongest at idle where
  a real engine is lumpiest and fading under load where combustion is repeatable.

This part is deliberately sound design rather than simulation.

Three gearbox types differ in mechanism, not just timing: `manual` (full torque
cut), `dct` (overlapping clutches, minimal interruption), `auto` (converter slip,
no hard cut).

## 4. API

```js
import { EngineSim } from './src/engine-sim.js';

const sim = new EngineSim(null, { engine: 'v8cross', vehicle: 'sports' });
await sim.start();                       // from a user gesture

sim.setThrottle(1); sim.update(dt);      // per frame
```

| Method | |
| --- | --- |
| `setEngineType(id)` | `i3 i4 i5 i6 v6 boxer4 flat6 v8cross v8flat v10 v12` — hot-swappable while driving |
| `setVehicle(id)` | `hatch sports supercar muscle truck` — road speed preserved across the swap |
| `setThrottle/setBrake/setClutch(0..1)` | |
| `shiftUp() / shiftDown() / setGear(n)` | returns `false` if refused (would over-rev) |
| `setMix({exhaust, intake, mechanical, transmission, turbo, transients})` | per-voice balance |
| `setTone({rumble, brightness})` | 0–2 each, 1 = default. Low-end lift and high-shelf cut |
| `setPerspective('exterior'\|'interior')` | |
| `update(dt)` · `start()` · `stop()` · `dispose()` · `getState()` | |

## 5. Verification, and its limits

`node test/run.mjs` (122 checks) and `node test/drive.mjs`. A strict Web Audio
mock throws on non-finite AudioParam writes, out-of-range frequencies, and
per-frame node allocation. Coverage: all 11 engines × 5 vehicles assembled and
driven, 3600-frame input fuzz per vehicle, engine/vehicle hot-swap, stop/restart.

Steady state: **253 nodes**, ~29 AudioParam writes per frame, zero per-frame
allocation.

### Making transients audible

Getting the pops to actually read took four separate fixes, and only one was a
level. Worth recording because each was invisible to the others:

1. Eight oscillators were **never started** (see below) — the mechanical and
   gearbox layers were silent, so the whole mix was wrong.
2. The exhaust collapsed **94 %** on a trailing throttle. Fuel cut stops
   combustion, but the cylinders keep pumping air past open exhaust valves, so
   the note should go soft and dull, not away. Now 2.94 → 0.48.
3. The compressor's **3 ms attack** caught a 1.5 ms pop and squashed it at
   4.5:1, limiting transients to roughly the sustained engine level — precisely
   what "I can hear them but they're faint" sounds like. At 22 ms the leading
   edge passes and only the tail is clamped, with a fast brickwall limiter added
   afterwards so the extra punch cannot clip.
4. The ongoing crackle stream was built mostly from the `crackle` preset at half
   the level of `bang`, at amplitude 0.30. Now 0.90 and an even mix of the two,
   with the per-frame budget and voice pool raised so long bursts are not
   truncated.

5. And the real ceiling: **bandpass insertion loss**. Each transient voice is
   white noise through two narrow bandpasses, and a 2nd-order bandpass passes
   only ~(pi/2)(f/Q) of the spectrum — analytically **-20.5 dB** for `bang`
   against a 24 kHz Nyquist, while the wavetable oscillators carrying the engine
   note are full-scale at 0 dB. A transient scheduled at "gain 1.0" was arriving
   about ten times quieter than the number implied, and no amount of tuning the
   amplitude could close a structural 10x gap. `TransientBank.makeup` now
   restores it so the scheduled amplitude means what it says.

Measured lift-off at 6200 rpm, effective audio level (amp x makeup x bandpass
loss) against an overrun engine at 0.48:

| rpm at cut | pops | loudest report |
| --- | --- | --- |
| 1612 | 1-2 | 0.07 |
| 3030 | 1-2 | 0.20-0.50 |
| 4516 | 2-4 | 0.43-0.77 |
| 6201 | 3-6 | **1.2-3.0** (2.5-6x the engine) |

Deliberately **few and far apart**. The ongoing crackle stream went from 42 to 4
events/sec at a third of its amplitude, and its intensity is now gated almost
entirely on the fuel-cut edge (`0.12 + 0.88 x edge`) rather than on a large
steady term. A dense stream buries the reports and reads as a fault in the audio
engine rather than as a car. Sustained braking now produces **zero** crackle;
the events land on the lift and on the downshift. Roughly two lifts in five
resolve as a single hard crack.

### The audibility gate

One check earns its own mention because its absence cost an entire layer. A
source node that is built, connected and **never started** is completely silent,
and nothing else here notices: its params still get written, the graph still
looks correct, the node count is still stable, every other assertion passes.
`layers.js` turned out to contain exactly one `.start()` call in the whole file
— the looping-noise helper — so the valvetrain, cam, injector, firing-excitation,
gear-mesh, runout, torsional and turbo-whine oscillators had never made a sound.

`mock.audit()` now walks every source node and asserts it is started *and* has a
path to `ctx.destination`, following modulation connections through AudioParams
to their owning node (an LFO driving a gain that reaches the output is audible,
not orphaned). Run across every engine × vehicle.

**What is not verified:** nobody in this environment can hear the output. Every
claim above is numerical or physical — spectra, mode frequencies, damping ratios,
impact velocities. None of it is a claim about how it *sounds*. The CPU target is
also unmeasured: node count and per-frame writes are known, real CPU is not.

## 3d. Turbo whistle character

The shaft has its own inertia state (`spool`), separate from boost pressure —
`boost = spool²` with a blow-off vent term. That split is what produces the
turbo-car whistle across a gear change, and two details make or break it:

- **Coast-down at 1.9x inertia**, not 4.0x. At 4.0x the shaft barely moved during
  a 95 ms shift, so the whistle sat flat across gear changes. Measured on the
  inline-6: the whistle now sags **3105 → 2585 Hz** (about three semitones)
  through an upshift and swells back as boost rebuilds.
- **Level weighted to tip speed, not throttle.** The whistle is aeroacoustic
  radiation from the compressor wheel, so it persists while the wheel spins.
  Weighting it `0.35 + 0.65 × flow` collapsed it to a third the instant the
  throttle shut for a shift — it disappeared exactly when it should have been
  sagging and swelling. Now `0.62 + 0.38 × flow`.

A blow-off valve vents pressure in milliseconds but cannot stop a spinning
turbine, so the whistle dips and recovers rather than cutting out and restarting.
`p.turboSpeed` exposes normalised turbine speed for anything that wants it.

### Whistle sweep, measured

Inline-6 at full throttle through the gearbox, whistle frequency range within
each gear plus one blow-off chirp per upshift:

| gear | whistle range | swing |
| --- | --- | --- |
| 1 | 120 – 2011 Hz | 48.8 semitones (spool-up from rest) |
| 2 | 1637 – 2663 Hz | 8.4 semitones |
| 3 | 1979 – 2884 Hz | 6.5 semitones |
| 4 | 2050 – 2598 Hz | 4.1 semitones |

Three upshifts, three chirps. Mapped linearly against shaft speed the swing was
only 2–5 semitones — shaft speed saturates near the top of its range under full
load, so the whistle sat almost still and read as one flat tone across the whole
gearbox.

## 4b. Output FX (`fx.js`)

Post-mix processing, exposed so the sound can be shaped without touching the
model. These make no claim to be physical — they are desk tone controls.

- **`EQ`** — five bands at points that matter for an engine: 60 Hz sub, 200 Hz
  body, 800 Hz honk (the frequency that makes a synthesised engine sound like a
  kazoo), 2.5 kHz rasp, 8 kHz air. ±18 dB.
- **`Reverb`** — convolution with a procedurally generated impulse response:
  discrete early reflections over an exponentially decaying tail, decorrelated
  per channel, high-passed at 110 Hz so the tail does not turn to mud.
  `size` 0.05–1 maps to ~0.15–2.2 s. Rebuilding the IR costs ~6 ms, so it is
  debounced in the UI and must never be called from a render loop.
- **`Stereoizer`** — the graph is mono, so mid/side width does nothing; there is
  no side signal to raise. Width has to be *created* by decorrelation:
  `L = direct + w·delayed`, `R = direct − w·delayed`. The opposite polarity is
  the point — summed to mono the delayed copies cancel exactly, so this cannot
  comb-filter mono playback the way a plain Haas delay does.

### Why the pops sounded like a plastic bottle

They were routed straight to the mix bus. A real exhaust bang happens *in the
pipe* and leaves through the tailpipe, so it carries the same resonance,
reflections and muffler colour as the engine note — sending a bare filtered
noise burst directly to the output gives you the sound of something flicking a
bottle *next to* a car rather than something the car did.

`popSend` now routes most of the transient energy back through the exhaust
waveguides, so pops inherit the pipe and sit in the same space as everything
else. The split runs **2.5:1 in favour of the pipe** — a pop is heard mostly
*as the exhaust*, with a smaller direct component supplying the leading edge.
Adjustable via `setPopDepth()`.

### And why they interrupted everything

Three separate causes, none of them level:

1. **The pops were sidechain-ducking the mix.** At -16 dB / 4.5:1 a full-scale
   bang drove **15.3 dB** of gain reduction, so every pop punched a 160 ms hole
   in the engine. Backing off to -5 dB / 2.2:1 with bus headroom brings that to
   **2.0 dB** — cohesion instead of a hole — and leaves the brickwall limiter as
   the only thing catching real peaks (0.15 dB on the same bang).
2. **A 1.2 ms attack is a click, not a combustion event.** Real exhaust reports
   have a finite rise. At 5 ms with a longer 190 ms tail they read as pressure
   waves rather than as digital artefacts.
3. **The crackle preset sat at 1.4/3.2 kHz** — an octave and a half above where
   the engine actually lives (centroid ~133 Hz at 3000 rpm), so it registered as
   a separate bright event pasted on top. Moved to 850/1900 Hz.

### The rev limiter was machine-gunning

Holding full throttle against the limiter produced **58.7 pops/second**. Two
independent causes, both category errors rather than tuning:

- The limiter fired the same `evCut` **ignition-cut burst** as a gear shift. A
  shift cut is one ~100 ms interruption that throws a lot of charge into the
  pipe and earns a multi-pop burst; a limiter cut is a 50 ms micro-cut that
  re-arms every 12 ms. Measured: 91 cut events in 10 seconds, each scheduling a
  full burst. The limiter now has its own small rate-capped bark instead.
- DFCO detection read the **effective** throttle, which the limiter drives to
  zero every 50 ms — so each limiter cycle also looked like a fresh lift-off.
  It now reads the driver's pedal.

Measured pop rates after, per scenario:

| scenario | rate | loudest |
| --- | --- | --- |
| WOT held on the limiter | 3.6/s (was 58.7) | 1.16 |
| WOT run through the gears | 1.2/s | 0.59 |
| lift-off after a hard run | 0.8/s | 0.91 |
| steady part-throttle cruise | 0.6/s | 0.19 |

Plus a global 0.30 s refractory between major pop events, so nothing can
machine-gun regardless of what triggers it.

## 3e. Three bugs worth recording

**Launch bounce.** Flooring it in 1st sent the revs to ~3600, dragged them back
to ~2000, then climbed again. The launch clutch controller disarmed on a fixed
threshold — `geared > 1.15 × idle`, about 8 km/h — and then returned *full*
clutch immediately, while the engine was still flaring ~1500 rpm above the
gearing. It now hands over when road speed has caught up to the rpm the engine is
actually being held at (`geared > 0.90 × target`), so slip is already near zero
and there is nothing left to yank. Measured: the engine now holds flat at
~3140 rpm while slip falls 3238 → 2353 → 1117 → 0, then climbs smoothly.

**Ear-splitting whine at certain revs.** Gear mesh frequency is shaft rpm ×
tooth count, which legitimately reaches five figures — and the level rolloff
only began at 13 kHz, so a full-level triangle tone was arriving at 10 kHz with
the 2nd harmonic pinned at the 20 kHz clamp. Radiated whine has to escape
through the gearbox case and body panels, both strongly low-pass, so the rolloff
now starts an octave and a half lower (`1/(1+(f/2600)^2.2)`, with a steeper
curve again for the 2nd harmonic). Worst case across every chassis is now
3510 Hz at gain 0.024 — inaudible rather than painful.

**Turbo modulation.** Two characteristics were missing entirely:

- **Shaft-rate sidebands.** A blade-passing tone is not a clean sine — flow into
  the wheel is distorted by the volute, so each blade sees a different load once
  per *shaft* revolution. That amplitude-modulates the tone at BPF/11 (180–262 Hz
  measured) and puts sidebands around it. This is the texture that separates a
  spinning machine from a test-tone oscillator.
- **Wastegate chatter.** Once boost reaches the spring pressure the valve hunts
  open and closed many times a second — owners describe it as "FftFftFft, not
  ShuShuShu". It happens *while on boost*, not on lift, so it is a completely
  different gesture from the blow-off valve. Modelled as an 18–53 Hz gated noise
  chatter that appears only near the boost ceiling.

Plus a third blade harmonic for edge.

## 5b. Ambience (`ambience.js`)

Standalone environment bed — takes a context and exposes an output, so both the
console and the drive scene use it without going through `EngineSim`.

- **Rain** is two layers, not one: a bright hiss of drops on glass and metal, and
  a duller roar off the road. Heavier rain shifts the balance as well as the
  level, and a slow LFO keeps it from sitting still.
- **Wind** rises with `speed^1.7` and opens its filter as it does — aerodynamic
  noise climbs very steeply with velocity, so at a crawl it is a hum and at speed
  a roar.
- **Tyre roar** tracks speed for both level and brightness, and gets noticeably
  louder on a wet road.
- **Thunder** only fires when it is actually raining hard, on one shared
  resonant path retriggered by scheduling. The attack is slow because distance
  smears it completely.

## 6. Night Drive (`drive.html`)

A real-time WebGL2 scene driven by the same `EngineSim` instance, reachable from
the button in the console header. Still no external libraries — the renderer,
the matrix maths and every shader are in `src/gl/`.

```
src/gl/gfx.js       WebGL2 layer: mat4, programs, VAOs, instancing, render targets
src/gl/shaders.js   GLSL: PBR scene, sky, volumetric shafts, bloom, composite
src/gl/world.js     procedural geometry: road, cars, lamps, barriers, cockpit
src/gl/renderer.js  pass chain + the chassis dynamics that give it feel
```

### Pass chain

```
sky (fullscreen)                    ┐
scene, instanced, forward-lit, HDR  ├→ RGBA16F target
cockpit (view space, same target)   ┘
light shafts (raymarched, half res)
       ↓ bright pass → blur H/V ×2 (quarter res)
composite: radial blur → chromatic aberration → ACES → vignette → grain
```

- **Lighting** is GGX with a per-frame light list: two headlight spotlights plus
  up to 32 point lights for oncoming headlamps, tail lights and sodium street
  lamps. Worth the cost at night, when nearly every surface is lit at a grazing
  angle by a moving light — exactly where cheaper models fall apart.
- **Wet road** is not a texture swap. Rain drives roughness down toward 0.055 and
  metallic up, so the specular lobe genuinely mirrors the lights instead of
  washing out, with broad noise-driven puddles that pool more than the rest.
- **Volumetric shafts** are raymarched at half resolution with a per-pixel
  jitter — what makes headlights read as beams in air rather than as painted
  patches on the tarmac.
- **ACES tonemapping** matters more here than anything else: a headlight is
  genuinely thousands of times brighter than tarmac, and a linear clamp turns
  every one into a flat white disc.
- The **cockpit is drawn into the HDR target**, not over the finished frame, so
  it tonemaps with the world and its gauges feed the bloom like any other light.
  Instruments are a 2D canvas uploaded as a texture and pushed past 1.0 by the
  emissive shader, so they glow like real VFD segments.

### Feel

`Chassis` sits on top of the drivetrain and supplies everything the audio model
does not: a body on damped springs that squats under power and dives under
brakes, rolls into steering, and shivers from two separate sources — tyre roar
scaled by speed² and engine buzz scaled by rpm and load. Gear engagement and
driveline lash impacts (`evLash`, `evEngage`) punch the camera directly, so a
clunk you *hear* is a jolt you *see*. Steering authority falls off as `1/(1+0.1v)`,
which is what actually makes steering feel heavy at speed. FOV opens 57° → 74°
with speed.

Controls: `W` throttle, `S` brake, arrows steer, `Q`/`E` shift, `A` auto,
`C` toggles cockpit/chase camera.

**Verified:** all six shader programs compile and link in Chrome, and half-float
render targets are available, so the HDR path is live. The scene has not been
looked at by a human — nothing here is a claim about how it looks.
# Engine_Sim
