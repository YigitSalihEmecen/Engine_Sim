# ENGINE SIM — complete project context

Handoff document for an AI agent picking this project up cold. It covers what
the project is, how every part works, why each non-obvious decision was made,
every bug found and its measured evidence, and what is **not** verified.

Read §0 and §11 first. §11 is the list of traps that have already cost real time.

---

## 0. What this is, in one paragraph

A browser-based **procedural engine sound simulator**: no samples, no external
libraries, pure Web Audio API + ES modules. Engine audio is synthesised from
**firing geometry** (which cylinder fires at which crank angle), driven by a
**physically compliant drivetrain** (two inertias joined by a torsional spring
with a backlash dead-band). There is **one page**, `index.html` — a technical
console for driving and tuning the engine. Everything is verified by a headless
test harness that mocks Web Audio, because **nothing in the development
environment can hear audio or see the screen** except via headless-Chrome
screenshots.

This is intended to be **the sound engine for a browser driving game**, not the
game. The public surface is `src/engine-sim.js`; the console exists to audition
and tune it.

Run it: `npm start` (or `node tools/serve.mjs`), then open
`http://localhost:8000`. ES modules require a server; `file://` will not work —
`index.html` detects that case and says so rather than failing silently.

**A WebGL2 night-drive game used to live here and has been removed** at the
user's request: `drive.html`, `src/gl/` (gfx, shaders, world, renderer) and
`src/squeal.js`. Nothing in `src/` depended on any of it. Do not resurrect it
from an older context dump. It is still in git history at commit `461ad03`.

---

## 1. File structure

```
engine_sim/
├── index.html                     the console — the entire UI
├── package.json                   scripts only; there are no dependencies
├── README.md                      human-facing documentation
├── AGENT_CONTEXT.md               this file
├── tools/
│   └── serve.mjs                  zero-dependency static dev server
├── src/
│   ├── profiles.js                engine + vehicle DATA, firing-geometry helpers
│   ├── pulse.js                   firing geometry → band-limited PeriodicWave
│   ├── resonators.js              exhaust waveguides, muffler, intake, rasp, cabin
│   ├── layers.js                  mechanical, gearbox, turbo, transient bank
│   ├── character.js               exhaust noise, sub layer, imperfection modulator
│   ├── fx.js                      EQ, reverb, stereo widener, 3-band compressor
│   ├── physics.js                 drivetrain: inertias, clutch, torsional spring
│   ├── shift.js                   gear-shift state machine
│   ├── engine-sim.js              PUBLIC API + orchestration
│   └── CONTRACT.md                module interface contract
└── test/
    ├── mock-audio.mjs             strict Web Audio mock + graph audit
    ├── run.mjs                    unit + sweep suite (277 checks)
    ├── drive.mjs                  driving-behaviour suite
    └── spectrum.mjs               ANALYTIC spectrum of the exhaust chain
```

**Files that used to be here and are deliberately gone.** Do not resurrect any
of them from an older context dump:

| removed | why |
| --- | --- |
| `drive.html`, `src/gl/*`, `src/squeal.js` | the WebGL2 night-drive game — removed at the user's request; nothing in `src/` depended on it |
| `src/_v1_reference.js` | 809 lines of v1 that nothing imported |
| `src/ambience.js` | environment bed, removed with its test suite |
| `_rtest.html` | scratch file |

Commands:
```
npm start                   # dev server on :8000  (= node tools/serve.mjs)
npm test                    # run.mjs + drive.mjs
node test/run.mjs           # 277 checks, exits non-zero on failure
node test/drive.mjs         # driving behaviour, 80 engine×vehicle combos
node test/run.mjs orders    # run one suite by substring
node test/spectrum.mjs      # harshness table, all engines
node test/spectrum.mjs v12  # per-rpm spectral detail for one engine
```

---

## 2. The core idea — orders, not oscillators

**This is the single most important concept in the project.**

A four-stroke engine fires each cylinder once every **two** crank revolutions.
The fundamental period is therefore 720°, and:

```
f0 = RPM / 120          (Hz of one complete 720° engine cycle)
engine order N  ↔  harmonic index k = 2N
```

Engine orders are multiples of **0.5**. The half-orders are where an engine's
character lives.

v1 stacked hand-tuned harmonic oscillators per engine. v2 instead builds each
exhaust bank's **actual 720° pressure cycle**:

1. Place a combustion pulse at each crank angle where that bank's cylinders fire.
   Pulse shape is a pressure-release envelope: `p(d) = (1 − e^(−a·d))·e^(−b·d)`
   — fast rise as the exhaust valve cracks and the cylinder blows down, long
   decay over the exhaust stroke. `a` (attack) and `b` (decay) come from the
   profile and shift with load.
2. Add deterministic per-cylinder jitter (amplitude, timing, decay) seeded from
   the profile so a given engine always sounds the same.
3. **Differentiate** the cycle. Radiation from an open pipe end is proportional
   to dQ/dt — this is physics, not tone shaping.
4. FFT → Fourier coefficients → `ctx.createPeriodicWave(real, imag)`.

Two consequences fall out for free:

**Correct harmonics for any layout.** Measured half-order energy per bank, with
nothing tuned per engine:

| engine | bank 1 fires at | half-order energy |
| --- | --- | --- |
| v8cross | 0 / 270 / 540 / 630° | **31.4 %** ← the burble |
| v8flat | 0 / 180 / 360 / 540° | **0.0 %** ← the flat scream |
| i4, i6 | even intervals | 0.0 % |
| flat6 | 3 cyl/bank → 1.5 order | 56 % |
| v10 | 5 cyl/bank → 2.5 order | 62 % |

A cross-plane V8 burbles because its banks fire unevenly *through separate
pipes*. Route both banks into one collector and the half-orders cancel — which
is what a cross-over exhaust physically does.

**Perfect anti-aliasing at zero runtime cost.** `PeriodicWave` is band-limited
per playback frequency by the browser, so one oscillator per bank replaces a
whole partial stack and never aliases across a rev sweep.

### Sign convention (verified, do not "fix")

Web Audio's convention is `x(t) = Σ real[k]·cos(2πkt) + imag[k]·sin(2πkt)`, so
from a forward DFT `X[k]`: `real[k] = 2·Re(X[k])/n`, `imag[k] = −2·Im(X[k])/n`.
Verified by round-trip at **r = 1.000000** against a DC-removed target, with a
flipped-sign control scoring **−0.499** to prove the test can fail. Getting this
wrong time-reverses every pulse — the "crack" becomes a "swell".

### Radiation knee (`RADIATION_KNEE_ORDER = 24`)

A pure derivative is +6 dB/octave with nothing stopping it, which put a V8's
spectral centroid at order 15.4 = **385 Hz at 3000 rpm**, where a real V8 keeps
most of its power under 300 Hz. That is the "too high pitched" failure.

Physically, radiation from an open pipe end only behaves as a differentiator
while ka ≪ 1; above ka ≈ 1 it flattens (~1.8 kHz for a 60 mm tailpipe). A fixed
Hz knee cannot be baked into an rpm-independent wavetable, so the knee is
expressed in **orders**, chosen by measurement:

| knee | centroid | Hz @3000 rpm | energy < order 8 |
| --- | --- | --- | --- |
| off | 15.4 | 385 | 63 % |
| **24** | **5.3** | **133** | **80 %** |
| 8 | 3.8 | 94 | 89 % |

24 keeps a 13 dB spread between order 4 and order 16 so it gains weight without
going muddy. The fixed-frequency part of the rolloff lives in the tone stage.

Constants: `TABLE_SIZE = 8192` (analysis resolution), `MAX_HARMONICS = 1024`
(= engine order 512).

---

## 3. Audio signal graph

```
bank wavetable osc ×2 (soft/hard crossfade, per bank) ─→ ExhaustSystem inputs[i]
ExhaustNoise (broadband flow noise) ──────────────────→ ExhaustSystem inputs[i]
TransientBank ──(popSend 1.05)───────────────────────→ ExhaustSystem inputs[i]
   ExhaustSystem = per-bank Waveguide → collector Waveguide → Muffler → Nonlinearity
                                                              ↓ bus: exhaust
intake wavetable osc ×2 → IntakeResonator (Helmholtz + turbulence)  ↓ bus: intake
MechanicalLayer   valvetrain @0.5 order, injectors, chain, block modes ↓ mechanical
TransmissionLayer mesh whine = driveshaft rpm × engaged gear teeth     ↓ transmission
TurboLayer        lagged spool whine, shaft sidebands, chatter, BOV    ↓ turbo
TransientBank     direct path (bangs, clunks, thumps)                  ↓ transients
SubLayer          octave-shifted chest-band sine + saturation          ↓ sub
CharacterModulator → osc.detune (cents) and busses.exhaust.gain (tremolo)
                            ↓
       mixBus (0.42) → rumbleShelf(+9 dB @145) → bodyBump(+5.5 dB @78)
                     → presence(−4.5 dB @3 k) → airCut(−6 dB @2.9 k)
                     → CabinFilter → EQ → Reverb → Stereoizer
                     → Dynamics (3-band, LR4 @240 Hz / 2 kHz)
                     → limiter(−1.5, 20:1, 1 ms) → master → destination
```

Default mix: `exhaust 1.0, intake 0.75, mechanical 0.55, transmission 0.45,
turbo 0.7, transients 0.42, sub 0.9`. Steady state ≈ **291 nodes**, ~29 AudioParam
writes/frame, **zero per-frame allocation**.

### Module notes

**`resonators.js`**
- `Waveguide` — delay line + in-loop lowpass + reflection (Karplus-Strong /
  digital waveguide, the structure the PTR engine-sound model uses). Web Audio
  forces a **128-sample minimum delay inside a feedback loop**; bank pipes are
  164–389 samples so all clear it, with a resonant-bandpass fallback for shorter
  pipes (the v8flat and v10 *collectors* use it). The in-loop lowpass has phase,
  which drops the resonance below `c/4L`, so the delay is **phase-compensated**
  (`tunedLoopDelay`) rather than taken raw.
- **`MODE_SURVIVAL = 2.2`** sets the loop lowpass at `f_pipe × (2.2/damping)`,
  i.e. 5–8 surviving modes. It was 6 (≈20 modes) and that was the single worst
  tonal bug in the project — see ledger #31. Do not raise it without re-running
  `node test/spectrum.mjs`.
- `Muffler` — series of partially-reflecting comb stages whose delays are set so
  response peaks do not coincide (maximal destructive interference).
- `IntakeResonator` — Helmholtz bandpass at a **fixed** cavity frequency (it does
  not track rpm; what tracks rpm is how hard it is excited) plus turbulence.
- `Nonlinearity` — asymmetric `WaveShaper`, 4× oversampled. A real exhaust pulse
  at high SPL steepens into a shock front, which is why an engine gets *raspy*
  under load rather than just louder. Asymmetric (not `tanh`) because shock
  steepening generates even harmonics too.
- `CabinFilter` — exterior/interior perspective.

**`layers.js`**
- `MechanicalLayer` — valvetrain at engine order 0.5 (camshaft turns at half
  crank speed), injector ticks, chain whirr, and block resonances. Block modes
  are **pink noise through bandpasses at fixed structural frequencies**,
  AM'd at the firing rate.
- `TransmissionLayer` — mesh frequency = shaft rpm × `gearTeeth[gear-1]`, using
  `p.wheelRpm` not engine rpm, so each gear has a different whine pitch. Plus
  rattle driven by `p.dRpm` and `p.clutchSlip`.
- `TurboLayer` — its own `spool` inertia state, separate from boost
  (`boost = spool²` with a vent term). The whine is **one PeriodicWave blade
  tone** (not a stack of sines — that read as a single flat timbre and put a
  near-pure 4 kHz tone where the ear peaks), through a formant bandpass that
  tracks it, with **shaft-rate sidebands** (BPF/11) and **bearing wander** on
  detune. Fundamental is capped at 3 kHz; the wavetable's harmonics carry the
  brightness above that.
  **Compressor surge** ("stu-stu-stu") is a sawtooth through a WaveShaper
  carrying an attack/decay pulse curve — a burst train, not a tremolo, and that
  shape is the entire difference between "stu" and "shoo". It drives a body band
  (the "tu") and a quiet edge band (the "st"). Armed by ANY throttle closure
  against standing boost, **including a gear-change ignition cut**, which is why
  a boosted car flutters on every upshift.
  Whether a profile goes "chiu" or "stu-stu-stu" is **one number**, `turbo.bov`
  — the valve's capacity. A big atmospheric valve empties the plenum so nothing
  is left to reverse through the wheel; a small or recirculating one leaves
  pressure standing and the compressor stalls. Not a mode switch.
- `TransientBank` — 16 pre-built voices (noise → 2 bandpasses → gain),
  retriggered by scheduling envelopes. **Zero allocation per event.**

**`character.js`** — deliberately sound design, not simulation:
- `ExhaustNoise` — broadband flow noise injected **into the waveguides** so it
  resonates in the same pipe as the combustion pulses, chopped by a firing-rate
  pulse train. A real exhaust is roughly half noise; a pure harmonic stack has
  none, which is exactly what "sounds like a fly" means. Biggest single realism
  win. Does **not** collapse on overrun — a closed throttle still pumps air.
- `SubLayer` — bottom octave, octave-shifted in half-orders per engine so it
  lands in the **41–83 Hz** chest band at mid revs (a fixed order gave 25 Hz on
  an I4 and 117 Hz on a V12), mildly saturated to survive small speakers.
- `CharacterModulator` — the wavetable's per-cylinder jitter is *frozen*, so the
  ear reads it as another periodic component. Three mutually irrational LFO
  rates (0.237/1.703/5.317 Hz) plus filtered noise wander detune and level,
  strongest at idle where a real engine is lumpiest.

**`fx.js`** — `Dynamics` is the three-band compressor and the "make it pleasant"
stage. A single full-range compressor cannot win on an engine mix: the loudest
thing is nearly always low-frequency, so the low end decides the gain reduction
and ducks everything with it (ledger #17). Splitting first fixes the mechanism.
The crossover is **Linkwitz-Riley 4th order** — two cascaded Butterworth
sections per edge — because only LR sums back to flat magnitude AND keeps the
branches in phase. Web Audio's lowpass/highpass Q is **in decibels**, so
Butterworth is `Q = −3.01`, not `0.7071`; measured, the correct value sums to
**−0.17 dB** of flat and the naive `0.7` gives **+7.4 dB** at the crossover.
The high band (> 2 kHz, −30 dB, 5:1, 2 ms) is the harshness tamer: loud stays
bright, harsh gets held down. `setDynamics(0..1)` scales it back to transparent.

Also `EQ` (5 bands: 60 sub, 200 body, **800 honk**, 2.5 k rasp, 8 k air),
`Reverb` (procedural IR: early reflections + exponential tail, ~6 ms to rebuild
so **debounce the size control**), `Stereoizer` (the graph is mono so mid/side
does nothing — width is *created* by decorrelation: `L = direct + w·delayed`,
`R = direct − w·delayed`; opposite polarity makes it mono-sum safe).

---

## 4. Physics — `physics.js` + `shift.js`

v1 computed rpm kinematically (`rpm = speed/r × ratio`). An infinitely rigid
drivetrain makes a gear change a step change in rpm, and it sounds exactly like
what it is — a pitch jump. v2 uses the model from the driveline clunk/shuffle
literature:

```
Je   engine + flywheel               (profile.engineInertia)
       │ clutch: Coulomb friction, capacity × engagement, stick/slip
Jin  clutch disc + input shaft       (0.030 kg·m²)
       │ gearbox: rigid ratio in gear, disconnected in neutral
Jout output shaft + propshaft        (0.020 kg·m²)
       │ TORSIONAL SPRING with BACKLASH
Jv   wheels + vehicle, reflected through the final drive
```

Integration: **semi-implicit (symplectic) Euler on a fixed 0.5 ms sub-step**
(`SUBSTEP = 1/2000`, ~34 sub-steps per frame at 60 fps). The binding constraint
is not the in-gear torsional mode but the damper on the output shaft alone while
the gearbox is in neutral mid-shift. `stabilityReport()` reports the margins.

Three behaviours fall out of the structure rather than being scripted:

- **lash** — torque reversal drags the relative angle across ±backlash with
  nothing transmitted, then the teeth meet. Impact velocity at that instant is
  `evLash`. Detected, not scripted, so it also fires on lift-off and tip-in.
- **shuffle** — after contact the spring rings at the first torsional mode.
  Measured (sports preset): **6.05 Hz in 1st → 25.6 Hz in 6th**. Shuffle is a
  low-gear phenomenon, which matches reality.
- **slip** — engine and gearbox are separate inertias with finite friction
  capacity, so rpm *converges* during engagement. It never jumps.

### Driveline damping is specified as a RATIO, not a coefficient

Reflected engine inertia falls with the gear ratio, so `ζ ∝ 1/√J_eff` and no
fixed damper rate works across a gearbox: 34 N·m·s left 6th at ζ=0.53 (dead),
13 left 1st at ζ=0.048 (a 322 rpm, 8 Hz pitch warble that sounded "goofy").
`dampingRatio: 0.22` with `c = 2ζ√(k·J_red)` derived per gear holds ζ everywhere
and dropped 1st/2nd-gear wobble to **26 and 9 rpm**.

Key constants (`DRIVELINE_DEFAULTS`): `stiffness 5200 N·m/rad`,
`dampingRatio 0.22`, `backlash 0.035 rad`, `clutchTorqueCapacity 900 N·m`.

### Lash impact scaling — measured, not guessed

Radiated impact energy goes with velocity, so amplitude follows `v^1.5`
(Hertzian), not `v`. `LASH_REF_VEL = 15.0` rad/s is **anchored to measurement**:
routine lift-off contacts have a median of 5.5 rad/s, hard gear-drops 7–13. At
the original 3.0 almost every contact saturated the scale.

**Inelastic fatigue** (`LASH_COOL 0.55 s`, `LASH_FATIGUE 2.4`): gear-tooth
contact has restitution well under 1, so a driveline hammered back and forth
loses energy per strike. Without this, tapping the throttle produced ~25
impacts/second with 79 at maximum — a machine-gun of clicks. After: **198 clunks
→ 41, loud ones 79 → 1**, with the first tap still landing a proper 0.72.

### Shift state machine (`shift.js`)

Phases: `cut → open → sync → engage → lash → shuffle → ''`. Gearbox types differ
in *mechanism*, not just timing: `manual` (full torque cut), `dct` (overlapping
clutches, minimal interruption), `auto` (converter slip, no hard cut). Auto-shift
carries an over-rev guard that refuses a downshift exceeding redline.

A measured upshift:

```
 t(ms)  phase     rpm    twist(rad)   slip   torque
     0  cut      4759   -0.03254        0       0
   100  sync     4543   -0.03536      538      -2
   150  engage   4809    0.11704      834     453
   200  lash     4401    0.14657      430     582   ← teeth take up backlash
   350  shuffle  3992    0.09784        0     329
```

### Launch behaviour

`launchFlareRpm: 850` (set from `engine-sim.js`). The launch clutch controller
hands over to a locked clutch only once **road speed has caught up to the rpm the
engine is being held at** (`geared > 0.90 × target`), so slip is already near
zero. Disarming on a fixed low threshold instead made revs shoot to ~3600, get
dragged to ~2000, then climb again — the "launch bounce".

### Exhaust thermal model (drives popping)

Popping is unburnt fuel detonating in a **hot** pipe, so two conditions gate it,
and neither is "throttle closed":

- **Heat** — `egt` state, 5 s rising / **26 s falling** (cast iron holds heat; a
  2.2 s fall constant left a pop window under one second).
- **Fuel** — during *steady* deceleration fuel cut-off there is no fuel at all.
  What pops is the **transition**.

Two discrete events fire: entering fuel cut (the lift-off bang) and the trailing
edge of a rev-match blip (the downshift crackle). Magnitude carries `rpmN^1.7`
so revs dominate, times a peak-hold of recent throttle (snapping shut from wide
open bangs; easing off does not), times a random "luck" factor.

**Critical**: DFCO detection must read `this.throttle` (the driver's pedal), NOT
the effective throttle. The rev limiter drives effective throttle to zero every
50 ms, so reading it made every limiter cycle look like a fresh lift-off.

Measured lift-off pops by rpm at cut: 1612 → 1–2 pops @0.07; 6201 → 3–6 pops
@1.2–3.0 (≈5× the engine). A global 0.30 s refractory prevents machine-gunning.

---

## 5. Public API (`engine-sim.js`)

```js
import { EngineSim } from './src/engine-sim.js';
const sim = new EngineSim(null, { engine:'v8cross', vehicle:'sports', volume:0.7 });
await sim.start();          // MUST be called from a user gesture
sim.setThrottle(1); sim.update(dt);   // per frame
```

| method | notes |
| --- | --- |
| `setEngineType(id)` | 16 profiles, hot-swappable while driving |
| `setVehicle(id)` | 5 presets; **road speed is preserved** across the swap |
| `setThrottle/setBrake/setClutch(0..1)` | |
| `shiftUp() / shiftDown() / setGear(n)` | returns `false` if refused (would over-rev) |
| `setMix({...})` | 7 buses |
| `setTone({rumble, brightness})` | 0–2 each |
| `setEQ(gains[5]) / setEQBand(i,dB) / resetEQ()` | ±18 dB |
| `setReverb({mix,size,damping})` | **size rebuilds an IR (~6 ms) — debounce** |
| `setWidth(0..1)` · `setPopDepth(0..2)` | |
| `setDynamics(0..1)` | 3-band compressor amount; 0 ≈ bypass, 1 = default |
| `getReduction()` | live `{low, mid, high}` gain reduction in dB |
| `setPerspective('exterior'\|'interior')` | |
| `update(dt)` · `start()` · `stop()` · `dispose()` · `getState()` | |

`sim._lastParams` holds the full per-frame params object (`evLash`, `evPop`,
`clutchSlip`, `egt`, `boost`, …) — the drive scene reads it for camera impacts.

Profiles (16): `vtwin i3 rotary2 i4 boxer4 i5 i6 i6diesel v6 v6tt flat6 v8cross
v8tt v8flat v10 v12`.
Vehicles: `hatch sports supercar muscle truck`.
Turbocharged: **i3, boxer4, i5, i6, i6diesel, v6tt, v8tt**.

The five newest, and what each is for:

| id | what makes it different |
| --- | --- |
| `vtwin` | 90° V-twin, pin offset −90° → fires at 0/270°. Two cylinders in two pipes with a 270/450 split, so **50.8 % half-order energy** — the lumpiest thing here. Tiny inertia (0.055), snaps to the limiter. |
| `rotary2` | Two-rotor Wankel. `cylinders: 4` is the *pulse count* per 720° of eccentric shaft, not pistons. Geometry matches an I4 (0 % half-orders); the sound comes from the pulse shape — slow rise, very long tail, so consecutive pulses **overlap**. That overlap is the "braap". No valvetrain, no timing chain. |
| `v6tt` | Twin-turbo V6. Low turbo inertia (0.30) so it spools fast. |
| `v8tt` | Same cross-plane geometry as `v8cross`, so it keeps the burble — but the turbines cool the gas and damp the pipes hard, so it lands as a muffled thud instead of a bark. Same firing order, different voice, none of it hand-tuned. |
| `i6diesel` | Compression ignition: `attack: 68`, by far the sharpest pulse here. Cool exhaust (1.16), heavy damping, 4600 rpm redline, and the loudest injector layer in the set — that tick is what makes a diesel a diesel. Big laggy VGT (inertia 0.95) with almost no blow-off valve. |

---

## 7. Testing — and why it is shaped this way

**Nothing here can hear audio.** The harness therefore enforces what is checkable
without ears, and is deliberately hostile.

`test/mock-audio.mjs` throws on: non-finite AudioParam writes, frequencies
outside range, `exponentialRamp` targets ≤ 0, `setTargetAtTime` timeConstant ≤ 0,
node allocation after `seal()` (per-frame allocation), and double-started sources.

### The audibility audit — the check that was missing

`mock.audit(destination)` walks every source node and asserts it is **started**
and has a path to `ctx.destination`, following modulation connections through
AudioParams to their owning node (an LFO driving a gain that reaches the output
is audible, not orphaned).

This exists because `layers.js` once contained **exactly one `.start()` call in
the whole file** — the noise helper. Eight oscillators (valvetrain, cam,
injector, firing excitation, gear mesh ×2, runout, torsional) were built,
connected, updated every frame, and **never started**. Completely silent, and
every other assertion passed: params were still written, node count was stable,
the graph looked correct. A source that is never started is invisible to a
param-level test.

Current: **277 checks** in `run.mjs` + a driving-behaviour suite in `drive.mjs`
(realistic manoeuvres, shift traces, shuffle, rev-match, 3600-frame input fuzz
per vehicle — that fuzz caught five real bugs).

### The analytic spectrum — `test/spectrum.mjs`

The audit above proves a source is *audible*. It says nothing about whether the
result is *pleasant*, and "there is a screaming resonance somewhere" is not a
question a param-level test can answer.

So `spectrum.mjs` reconstructs the magnitude response of the whole deterministic
path **analytically** — every biquad with the exact formulas the Web Audio spec
mandates (note the dB-vs-linear Q split), every delay line as a closed-form
comb, the feedback waveguide as `dry + wet·H_lp·e^(−jωT)/(1 + r·H_lp·e^(−jωT))`
— and multiplies it by the wavetable's harmonic amplitudes at a given rpm. No
audio is rendered and none is needed.

It found bug #31, and it is what the harshness regression suite runs on. The
`Nonlinearity` waveshaper is deliberately not modelled (it has no transfer
function), and it only *adds* high-order content, so every number it reports is
a **lower bound**.

### Verifying the browser side

`timeout` does not exist on macOS, and the page runs an unending
`requestAnimationFrame` loop, so Chrome can take a while to hit its virtual-time
budget — use `run_in_background` plus a wait, or it will look like a hang.

```
node tools/serve.mjs 8123 &

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless=old --no-sandbox --enable-unsafe-swiftshader \
  --user-data-dir=/tmp/p$RANDOM --virtual-time-budget=6000 \
  --window-size=1280,900 --screenshot=/tmp/shot.png \
  --dump-dom http://localhost:8123/index.html > /tmp/dom.html
```

For data, read it out of the dumped DOM (`console.log` is not captured).
**`grep` is line-based** — extract multi-line blocks with Python or you will
silently see only the first line. Use a fresh `--user-data-dir` each run, or
Chrome serves cached modules (`tools/serve.mjs` also sends `no-store`).

Useful assertions on the dumped DOM, all of which have caught something:

- `<select id="engine">` has 16 `<option>`s → the module evaluated at all.
- `id="dynMeter"` contains `LOW` → the frame loop is running.
- `id="boot" hidden` is present → the boot guard is correctly dormant.
- Loading the same file over `file://` should show the boot banner instead.

---

## 8. UI (`index.html`)

Blueprint / technical-grid aesthetic — engineering drawings and instrument
panels, not a consumer dashboard.

- Engineering-paper ground: 10 px fine grid over 80 px major, fixed attachment.
- Corner crop marks on every panel (`.panel::before/::after`).
- Monospace throughout for data, tabular numerals, tracked uppercase labels.
- Near-monochrome graphite + **one signal colour** (`--acc: #e8481f`) reserved
  for live/hot state: throttle, redline, half-orders, clutch slip > 50 rpm.
- Square geometry, 1 px hairlines, no rounded corners or soft shadows.
- Motion is mechanical: 140 ms cubic, no springs.
- Four tabs: Machine, Voice mix, Tone, EQ & FX. Instrument + telemetry always
  visible above them.
- Instrument is a **semicircular sweep** with tick ring r=130, numeral ring
  r=104, sweep band r=78 — the three must stay on clearly separated radii or the
  numerals collide with the band (this happened, twice).

---

## 9. Complete bug ledger

Every one of these was found by measurement, and several are counter-intuitive.

| # | Bug | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | Rev decay ~2× too slow | 7000→idle took 3.3 s | added quadratic friction term |
| 2 | Downshifts could over-rev | engine pinned at redline | `_wouldOverRev` guard |
| 3 | `stop()` truncated its own fade | rebuilt bank re-issued `stop()` at +0.02 s | clear node lists before rebuild |
| 4 | No launch flare | clutch locked instantly | explicit clutch lock state |
| 5 | Intake pulse drove gain negative | doubled the chuff | cap depth below DC level |
| 6 | `_tunedDelay` called, never defined | agent died mid-edit | bound module fn as method |
| 7 | `setEngine`/`setVehicle` missing | engine switch crashed | added both |
| 8 | `speed` is a getter → vehicle swap teleported car 23 % | truck→hatch | capture road speed first |
| 9 | Equal-power crossfade kept level flat | no loudness with load | separate amplitude term |
| 10 | Driveline ζ=0.53 in 6th (dead) / 0.048 in 1st (wobbly) | 322 rpm 8 Hz warble | specify damping **ratio** |
| 11 | `_stallGuard` held full clutch below idle | engine dragged to 466 rpm | back off above idle |
| 12 | Spectral centroid 385 Hz ("too high pitched") | measured | radiation knee = 24 orders |
| 13 | Pops inaudible: EGT fell 0.77→0.27 in 4 s | measured | 26 s fall constant |
| 14 | **8 oscillators never started** | audibility audit | `startAll` + `start()` methods |
| 15 | Exhaust collapsed 94 % on overrun | 2.936 → 0.167 | fuel cut stops combustion, not pumping |
| 16 | Transients −20.5 dB from bandpass insertion loss | analytic | `TransientBank.makeup = 9` |
| 17 | Compressor ducked mix 15.3 dB per pop | analytic | −5 dB / 2.2:1 + headroom → 2.0 dB |
| 18 | 1.2 ms pop attack = a click | — | 5 ms attack, 190 ms tail |
| 19 | Crackle at 1.4/3.2 kHz, engine at 133 Hz | — | moved to 850/1900 Hz |
| 20 | Limiter fired the **gear-shift** cut event | 91 events in 10 s → 58.7 pops/s | own rate-capped bark |
| 21 | DFCO read effective throttle | limiter looked like lift-off | read driver pedal |
| 22 | Gear mesh at full level to 13 kHz | 20 kHz 2nd harmonic | rolloff `1/(1+(f/2600)^2.2)` |
| 23 | Block modes Q=8 @1820 Hz ("ear-killing") | filter scan | Q→2.2/2.6 + 3 kHz presence dip |
| 24 | Launch bounce 3600→2000→climb | trace | hand over at 0.90 × target |
| 25 | Turbo whistle flat (2–5 semitones) | trace | rpm-weighted drive + pitch map |
| 26 | BOV was broadband at Q=1.1 | — | Q≈7 sweep = the "chiu" |
| 30 | Lash machine-gunned on throttle taps | 25/s, 79 loud | inelastic fatigue |
| 31 | **Screaming resonance at one rpm** | V12 @8000: chain response **−5.9 dB at 2000 Hz vs −23.6 / −26.9 dB either side**; 71 % of radiated power in 2–6 kHz | `MODE_SURVIVAL` 6 → 2.2 |
| 32 | Turbo whine was 3 fixed sines at 3.4–4.2 kHz | "a single uniform soundwave", and a near-pure tone where the ear peaks | one PeriodicWave blade tone + formant + wander, fundamental capped at 3 kHz |
| 33 | Surge was a SINE-modulated wide noise band | smooth tremolo = "shoo-shoo-shoo" | sawtooth → WaveShaper pulse curve = a burst train |
| 34 | Flutter could never fire | BOV vented the whole plenum on every lift and shift, and the vent was hard-coded to 1 | vent scales with `turbo.bov`; relief applied to the *arming*, not the decaying state |

### #31 in detail — it will come back if the constant moves

The comb peaks of a feedback waveguide sit at multiples of `1/T`; an engine's
harmonics sit at multiples of `f0`. At most rpms those two series interleave and
nothing happens. At the rpm where they **coincide**, one harmonic lands exactly
on a comb peak while its neighbours fall in the troughs — and if the pipe is
still ringing in its 20th mode, that is a 20 dB spike two octaves above the
engine note that appears at one rpm and vanishes at the next.

Measured over 11 engines × 9 rpm × 3 loads, share of radiated power in 2–6 kHz:

| `MODE_SURVIVAL` | worst | mean | centroid |
| --- | --- | --- | --- |
| 6.0 (was) | **71.04 %** | 1.42 % | 278 Hz |
| 3.0 | 35.44 % | 0.31 % | 213 Hz |
| **2.2 (now)** | **1.38 %** | 0.04 % | 199 Hz |

17 dB off the worst case for 79 Hz of centroid. The physics: thermoviscous wall
losses rise with √f and the plane-wave model fails above the first cross-mode
cutoff, so a real exhaust resolves a handful of modes and then smears. `run.mjs`
asserts every engine stays under 4 %.

---

## 10. What is NOT verified

Be honest about this with the user; it has been stated throughout.

- **Nobody has heard the audio.** Every claim is numerical or physical —
  spectra, mode frequencies, damping ratios, impact velocities, gain reduction.
  None is a claim about how it sounds.
- **CPU is unmeasured.** Node count (291) and per-frame writes (~29) are known;
  real CPU is not. The original brief asked for < 5 %.
- **Responsive breakpoints** (900/760/620 px) are written but only the 1280 px
  layout has been screenshotted.
- The console has been verified to **load and populate** in headless Chrome —
  16 engines in the dropdown, live telemetry, boot guard correctly dormant, and
  correctly firing on a `file://` origin. Nobody has clicked Ignition and
  listened.

---

## 11. Traps — read before editing

1. **Never assume a Web Audio bug is a level problem.** Four of the loudest-seeming
   bugs (#14, #16, #17, #27) were structural: unstarted sources, filter insertion
   loss, compressor ducking, NaN aspect. Measure the signal path first.
2. **A source that is never started is invisible** to param-level tests. Run
   `mock.audit()` after any change to node construction.
3. **A module page that renders is not a module page that ran.** The HTML and CSS
   load fine while every `import` fails, so the layout looks perfect and nothing
   works. Assert on something the module produced, not on the markup.
4. **`trigger()` ends with `setValueAtTime(0, end)`** — reading `.value` after it
   returns always gives 0. Do not instrument transients that way (this produced a
   phantom "no pops firing" diagnosis).
5. **`timeout` does not exist on macOS.** Background the command instead.
6. **`grep` is line-based** — use Python for multi-line HTML/DOM extraction.
7. **Chrome caches ES modules** — fresh `--user-data-dir` per run.
8. **`Drivetrain` owns its `ShiftController`**; the shift machine must run inside
   the sub-stepped integration, not alongside it.
9. **All wavetable oscillators must start at the same instant** and always carry
   the same frequency. Bank relative phase encodes the firing pattern; if they
   drift, a cross-plane V8 stops burbling.
10. **`setReverb({size})` rebuilds an impulse response** (~6 ms). Never call it
    from a render loop; debounce UI controls.
11. **The night-drive game is gone on purpose** (see §0). If a stale note tells
    you to preserve `drive.html`, `src/gl/` or `src/squeal.js`, that note is out
    of date — the user asked for all of it to be removed.
12. Prefer fixing the *generator* over the call sites.
13. **Web Audio's `Q` is in DECIBELS for `lowpass` and `highpass`** and linear
    for everything else. Butterworth is `Q = −3.01`, not `0.7071`. Getting this
    wrong builds a resonant bump instead of a flat crossover, and it looks
    completely reasonable in the source.
14. **A `WaveShaper` fed a sawtooth is an envelope generator.** The saw sweeps
    the whole curve once per cycle, so the curve *is* the envelope shape and the
    oscillator frequency *is* the rate — no scheduling, no allocation. That is
    how the turbo flutter works.
15. **Don't raise `MODE_SURVIVAL`** in `resonators.js` without re-running
    `node test/spectrum.mjs`. See ledger #31.
16. Anything that looks like a "level problem" in the 2–6 kHz band probably is
    not. Measure with `spectrum.mjs` before reaching for an EQ cut — #31 looked
    like brightness and was a comb-coincidence spike.

---

## 12. Research sources that shaped the design

- **PTR (Pulse-Train-Resonator) model** — per-cylinder pulse trains → per-bank
  Karplus-Strong waveguides → shared collector resonator; `f0 = RPM/120`;
  throttle gate `max(torque,ε)^0.7`; DFCO airflow term.
- **Engine-order analysis** — half-integer orders arise because a four-stroke
  fires each cylinder every two crank revolutions.
- **Driveline clunk/shuffle literature** — two inertias + torsional spring with a
  backlash dead-band; shuffle is the first torsional mode coupled to fore-aft
  vehicle motion.
- **Exhaust pop mechanism** — unburnt fuel igniting in a >650 °C pipe; steady
  DFCO has no fuel, so it is the *transitions* that pop.
- **Turbo acoustics** — blade-passing whistle, compressor surge/flutter on
  throttle close, and wastegate chatter ("FftFftFft, not ShuShuShu") near spring
  pressure while *on boost*.
- **Blueprint / technical-grid aesthetic** — monochrome, monospaced, grid
  grounds; precision and structure as a counterweight to soft consumer UI.
