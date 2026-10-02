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
│   ├── presets.js                 THE SOUND FILE FORMAT — schema, defaults, validation
│   ├── pulse.js                   firing geometry → band-limited PeriodicWave
│   ├── resonators.js              exhaust waveguides, muffler, intake, rasp, cabin
│   ├── layers.js                  gearbox, turbo, transient bank
│   ├── character.js               exhaust noise, sub layer, imperfection modulator
│   ├── fx.js                      EQ, reverb, stereo widener, 3-band compressor
│   ├── physics.js                 drivetrain: inertias, clutch, torsional spring
│   ├── shift.js                   gear-shift state machine
│   ├── gate.js                    H-pattern gear-gate maths (UI, no audio)
│   ├── engine-sim.js              PUBLIC API + orchestration
│   └── CONTRACT.md                module interface contract
└── test/
    ├── mock-audio.mjs             strict Web Audio mock + graph audit
    ├── run.mjs                    unit + sweep suite (359 checks)
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
| `MechanicalLayer` (in `layers.js`) | valvetrain clatter at engine order 0.5, injector ticks, timing-chain whirr and piston slap into fixed block modes. Removed at the user's request, along with its mix bus, the `mechanical` block in every profile, and its UI. Note that `TransientBank` still has a voice-pool *partition* called `mechanical` — that is the casing-radiated clunk/thump/click, and it stays. |

Commands:
```
npm start                   # dev server on :8000  (= node tools/serve.mjs)
npm test                    # run.mjs + drive.mjs
node test/run.mjs           # 359 checks, exits non-zero on failure
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
TransientBank combustion bus ──(popSend 1.05)────────→ ExhaustSystem inputs[i]
              combustion bus ──(popDirect 0.22)───────→ bus: transients
   ExhaustSystem = per-bank Waveguide → collector Waveguide → Muffler → Nonlinearity
                                                              ↓ bus: exhaust
intake wavetable osc ×2 → IntakeResonator (Helmholtz + turbulence)  ↓ bus: intake
TransmissionLayer mesh whine = driveshaft rpm × engaged gear teeth     ↓ transmission
TurboLayer  grain-saturated spool whine, sidebands, chatter, BOV, surge
            → airLP(4.6 k) → airShelf(−5.5 dB @2.6 k)                  ↓ turbo
TransientBank     mechanical bus only (clunks, thumps, clicks)         ↓ transients
SubLayer          octave-shifted chest-band sine + saturation          ↓ sub
CharacterModulator → osc.detune (cents) and busses.exhaust.gain (tremolo)
                            ↓
       mixBus (0.42) → rumbleShelf(+9 dB @145) → bodyBump(+5.5 dB @78)
                     → presence(−4.5 dB @3 k) → airCut(−6 dB @2.9 k)
                     → CabinFilter → EQ → Reverb → Stereoizer
                     → Dynamics (3-band, LR4 @240 Hz / 2 kHz)
                     → limiter(−1.5, 20:1, 1 ms) → master → destination
```

Default mix: `exhaust 1.0, intake 0.75, transmission 0.45, turbo 0.49,
transients 0.42, sub 0.9` — and it lives in `presets.js`, not here, so an engine
can carry its own balance. Steady state ≈ **264 nodes** naturally aspirated,
**303** turbocharged; ~29 AudioParam writes/frame, **zero per-frame
allocation**.

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
- `TransmissionLayer` — mesh frequency = shaft rpm × `gearTeeth[gear-1]`, using
  `p.wheelRpm` not engine rpm, so each gear has a different whine pitch. Plus
  rattle driven by `p.dRpm` and `p.clutchSlip`.
- `TurboLayer` — its own `spool` inertia state, separate from boost
  (`boost = spool²` with a vent term). The whine is **one PeriodicWave blade
  tone** (not a stack of sines — that read as a single flat timbre and put a
  near-pure 4 kHz tone where the ear peaks), through a formant bandpass that
  tracks it, with **shaft-rate sidebands** (BPF/11) and **bearing wander** on
  detune.
  The fundamental is capped at **`TURBO_WHINE_MAX_HZ = 2200`**; the wavetable's
  harmonics carry the brightness above that. It was 3 kHz, and five of the seven
  turbo profiles sat pinned exactly AT the cap — same pitch on every car, and
  still the sharpest thing in the mix. At 2200 they spread over 1.2-1.9 kHz.
  **Grain** stops it reading as an oscillator: a soft **asymmetric** saturator
  (`grainCurve`, even harmonics = body; `tanh` would give only odd ones, which
  is the same thinness an octave up) before the formant, plus band-limited noise
  AM on the gain. Both are deepest early in the spool, where a real compressor is
  furthest from its efficiency island.
  The whole layer then goes through its **own tone stage** — `airLP` at 4.6 kHz
  and a −5.5 dB shelf at 2.6 kHz — because the turbo is the one voice that lives
  in the 2-6 kHz band everything else is measured for staying out of. Measured:
  −0.6 dB at 1.5 kHz, −4.2 at 3 k, −16.6 at 8 k.
  **Compressor surge** ("stu-stu-stu") is a sawtooth through a WaveShaper
  carrying an attack/decay pulse curve — a burst train, not a tremolo, and that
  shape is the entire difference between "stu" and "shoo". It drives a body band
  (the "tu") and a quiet edge band (the "st"). Armed by ANY throttle closure
  against standing boost, **including a gear-change ignition cut**, which is why
  a boosted car flutters on every upshift — and by any fast large closure that
  does not reach idle, because what stalls a compressor is the flow collapsing,
  not the pedal reaching a particular number.
  It is gated on **shaft speed, not boost** (ledger #44). Boost goes with the
  square of tip speed, so a boost threshold is a squared threshold; on the old
  gate the flutter needed ~0.85 of throttle and, measured over eight lifts per
  engine at 0.6 throttle, fired on **0 of 8 for all seven turbo profiles**.
  Whether a profile goes "chiu" or "stu-stu-stu" is still **one number**,
  `turbo.bov` — the valve's capacity. A big atmospheric valve empties the plenum
  so less is left to reverse through the wheel; a small or recirculating one
  leaves pressure standing and the compressor stalls. Not a mode switch, and no
  longer a mute switch either: the relief coefficient is 0.55 with a 0.30 floor,
  not 0.85 with none, so the biggest valve trades the flutter down rather than
  away.
- `TransientBank` — 16 pre-built voices (noise → 2 bandpasses → gain),
  retriggered by scheduling envelopes. **Zero allocation per event.** The pool
  is **partitioned by bus**: 10 combustion voices hard-wired to `combustionOutput`
  (fed into the exhaust waveguides — a bang happens IN the pipe and leaves
  through the tailpipe) and 6 mechanical voices on `output` (gear lash and
  clutch thump radiate from the casing and never go near the exhaust). Routing
  by partition rather than per-event gain costs no nodes and no param writes,
  and a burst of pops can never starve the clunk landing in the middle of it.

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

### Launch behaviour — read this before touching `_launchClutch`

Got wrong **five** times, and each attempt failed in a way the previous test
could not see. The complaint has always been the same sentence: *"it jumps to N
rpm and gets stuck there."*

| attempt | what it did | why it failed |
| --- | --- | --- |
| fixed hold at `idle·1.05 + 850` | regulated rpm onto a setpoint | held 1585 rpm for 0.27 s |
| same, flare 2400 + a "creep" term | setpoint that rose with road speed | moved the plateau to 3200 rpm |
| slip decaying on a clock + ratchet | no setpoint, but a timed decay | demand *fell* on slow cars; revs went negative for 0.8 s |
| absolute ramp `min(rampCap, slip)` | capped the demand's rate | correct **only** from a cold, stationary, 1st-gear start — the one case it was measured in. See below. |
| **current** | see below | — |

**The fault was never a plateau — it was a DISCONTINUITY IN THE RATE.** With the
clutch open a V8 flywheel accelerates at ~11 400 rpm/s; hang a 1450 kg car off
it and that becomes ~2 900. Cross between the two and the revs rocket up and
then appear to hit a wall, *while still technically rising* — so every
flat-spot test sailed straight past it. That is why the old tests passed while
the bug was live.

#### Why the fourth attempt was not enough

`rampCap = idle·1.05 + launchRate·launchT`, taken as `min(rampCap, geared+slip)`,
is **two independent curves that cross**, and it only behaves where the crossing
happens to be smooth. Three entry conditions break it, and all three sound
exactly like the bug it was written to fix:

| entry | measured on the old controller |
| --- | --- |
| **rolling re-launch** — brake to walking pace without stopping, then floor it | 832 → 2307 rpm in 0.15 s (**11 547 rpm/s**, 94 % of a free rev), then a crawl at ~1 900. `launchT` had already run on, so the cap started *above* the engine and the revs were thrown at it. A full stop resets `launchT`, which is why no from-a-standstill trace could see it. |
| **pulling away in 2nd** | climbed to 2826 then sat at ~2 960 for a second. `launchRate` was derived from 1st and the sustainable rate goes with the ratio **squared**, so the ramp asked for 3× what the car could do and the wall moved one gear up. |
| **held on the brake** | rose to 2690 then fell. |

Over 64 manual engine×vehicle combinations × 4 entries, the old controller had
**42 launches where the revs went backwards** and a median rate-collapse of 0.19
in 2nd. The current one has **zero** and 0.92.

#### What it does now

**1. The wind-up rate is derived from the car AND from the gear.**
`launchRateFor(gear)` — the rate this combination sustains once the clutch is
home, which is what removes the step between "engine spinning up" and "engine
dragging a car":

```
F = T·ratio·η/r     a = F/m     rate = (a/r)·ratio·(60/2π) · 0.55
```

3696 rpm/s for the hatch in 1st, 2897 for the sports car, 1377 for the muscle
car — and **966 for that same sports car in 2nd**, because it is quadratic in
the ratio. `launchRate` (1st gear) is still exposed as a field; the controller
calls `launchRateFor` every step.

**2. Slip decays with the car's PROGRESS, not with a clock.**

```
slipDemand = geared + slip0·(1 − geared/(flare·S)),   slip0 = flare − idle
```

`d/d(geared) > 0`, so **the demand rises whenever the car is speeding up at all,
however slowly**. Monotonic by construction. A time-based decay assumes the car
is getting on with it; when it is not, the demand falls and the controller drags
the engine down with it. `S = 1.8`.

*(Deriving `slip0` from the wind-up rate as well was tried — the argument being
that a launch closes its own slip at ~0.8× that rate, so a bigger flare never
converges. It measures worse: on weak combinations the flare collapses to its
floor, the demand sits on idle, and 16 of 64 second-gear launches went
backwards. A launch that holds its revs while the car crawls is a slow car; a
launch whose revs sag is a broken one.)*

**3. ONE curve, slew-limited, seeded on the engine.** `launchRef` is the demand
itself, carried frame to frame. It is seeded at the engine's **current speed**,
rises no faster than `launchRateFor(gear)`, and eases onto `slipDemand`
exponentially over `LAUNCH_BLEND = 0.45 s` rather than cornering onto it. No
cap, no clock, no crossing — so there is no entry condition that can start the
demand above the engine, and no hand-over to hear.

It also **absorbs the flare**: the clutch has a 26 ms lag and starts open, so the
crank always wins the first frame or two. If the demand then insists on the rpm
it wanted, the only way to get it is to shut the clutch and haul the engine back
down — measured on the i6 diesel in 2nd, clutch to 1.000 and revs *down* at
240 rpm/s for a quarter of a second. So the flare becomes the demand's new
floor. Bounded above by `slipDemand`, so it cannot ratchet.

**4. The clutch command is a FEED-FORWARD, not an error signal.**

```
alpha = (Te − Tc)/Je   ⇒   Tc = Te − Je·alpha_ref   ⇒   cmd = Tc/(capacity·stallGuard)
```

An error controller cannot start the clutch moving until the engine has already
left the demand, so the crank free-revs and then has to be caught. With the
feed-forward the clutch is at roughly the right engagement on the **first**
sub-step; the PI only trims what `Te` mispredicts, and its integral **leaks**
over 0.6 s. Without the leak, coasting down winds it negative, the flare absorb
then pins the error at zero so nothing pulls it back, and it under-commands the
clutch forever — an i4 outran its own 612 rpm/s ramp at 3561 rpm/s. That is
ledger #40 at the other end of the range.

The same feed-forward is the **cap on the forced close** (`launchT > 0.9`, 1.2 s
ramp). Yielding on a threshold failed both ways: yielding on `e < −0.03` (engine
below the ramp) deadlocked any car that could not hold its own ramp — the v-twin
held 2-4 % of clutch for two seconds with the car at walking pace — and yielding
only below the gearing let the close haul the revs down at 927 rpm/s. Capping at
plain `Te` (α = 0) is worse still: it is a stable equilibrium at **zero**
acceleration, and pinned the engine at 1392 rpm in 3rd while the car went from
17 to 33 km/h underneath it.

Also: sitting still with the throttle shut is **not** a launch. The controller
resets while stationary and off-throttle, so flooring it starts from a genuinely
open clutch — otherwise the integrator winds up during the idle beforehand and
the clutch is already half engaged when the throttle arrives.

#### What `drive.mjs` asserts, and why each one exists

Per chassis, from a cold standstill: revs never go backwards, `min/median > 0.35`
of the rate profile, and the launch completes. Then, across 16 engine×vehicle
combinations for **each of three other entry conditions** (`second`, `rolling`,
`braked`):

- **the revs never go backwards** — old code: −220 (2nd), −881 (braked).
- **the revs are never thrown at the demand** — peak rate as a fraction of
  `peakTorque/inertia`, the engine's own unloaded rate. A flare the clutch is
  shaping is ~0.3; a jump is the unloaded rate because the clutch is simply
  open. Old code on a rolling re-launch: **0.94**. Now: 0.32. This is scale-free
  and stays meaningful when the launch legitimately converges to a constant,
  which a ratio against the launch's own median does not.
- **the revs never stick on one number** — longest window inside a 100 rpm band,
  and only on launches that *complete*. A v-twin asked to drag 1720 kg away in
  2nd cannot accelerate the car, so its revs levelling off under a slipping
  clutch is the honest answer, not a wall.

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

### Popping is a PROBABILITY, not a consequence

The single biggest thing separating a car from a sound effect. Firing on every
lift and throwing a volley on every gear change is physically defensible per
event and completely wrong in aggregate — the ear learns the pattern in about
four repetitions.

```
pFire = clamp((egt − 0.42)/0.34, 0, 1) · (0.18 + 0.82·rpmN^1.7) · (0.45 + 0.55·snap)
```

Measured over 60 s with ten lifts: **pottering produces zero pops**, pressing on
1–3 of 10, flat out 4–7 of 10. The shift bang is gated the same way and scaled
by `cutBang`, which is why a dual-clutch car still cracks on most shifts and a
manual mostly does not — 1 bang across 4 upshifts, against 4 of 4 before.

Burst shape draws one of three gestures per event (`crack` / `double` /
`stutter`), weighted by event size, plus a squared per-event size draw. Result:
**27 dB between the median pop and the peak** instead of everything the same
size. A 0.45 s refractory prevents machine-gunning.

### Where a pop is heard from

Two properties, and they pull in opposite directions:

- **Body** comes from the pipe. A bang happens inside the exhaust and leaves
  through the tailpipe, so it must carry the pipe's resonance and muffler
  colour. `combustionOutput → popSend (1.05) → exhaust waveguides`.
- **Definition** comes from the direct path. The pipe is a lowpass — for a V8
  the packing sits at 1.9 kHz and the waveguide loop filter at ~400 Hz — so
  anything routed through it arrives with almost none of its own top.
  `combustionOutput → popDirect (0.75) → transients bus`.

Getting this wrong in either direction is a bug, and both have happened:
routing everything dry left the pops detached (#37), and over-darkening them
left the reports faint and dull (#42). The current values are the measured
midpoint — the crackle keeps **38 %** of its energy above 700 Hz (it was 71 %
detached, then 3 % dull) with **2.3 %** in the harsh 2–6 kHz band.

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
| `loadPreset(id \| object \| json)` | **the whole sound** — engine, mix, tone, EQ, space. See §6. |
| `getPreset()` · `exportPreset()` | current sound as an object / as pretty JSON |
| `setParam(path, v)` · `getParam(path)` | one parameter by dotted path; returns the clamped value or `null` |
| `setEngineType(id)` | 16 profiles, hot-swappable while driving. Keeps the current mix/EQ — use `loadPreset` to bring those too. |
| `setVehicle(id)` | 5 presets; **road speed is preserved** across the swap |
| `setThrottle/setBrake/setClutch(0..1)` | |
| `shiftUp() / shiftDown() / setGear(n)` | returns `false` if refused (would over-rev) |
| `setMix({...})` | 6 buses |
| `setTone({rumble, brightness})` | 0–2 each |
| `setEQ(gains[5]) / setEQBand(i,dB) / resetEQ()` | ±18 dB |
| `setReverb({mix,size,damping})` | **size rebuilds an IR (~6 ms) — debounce** |
| `setWidth(0..1)` · `setPopDepth(0..2)` | |
| `setDynamics(0..1)` | 3-band compressor amount; 0 ≈ bypass, 1 = default |
| `getReduction()` | live `{low, mid, high}` gain reduction in dB |
| `setPerspective('exterior'\|'interior')` · `setPosition(0..1)` | position is continuous |
| `update(dt)` · `start()` · `stop()` · `dispose()` | `update` is chainable |
| `getState()` | full telemetry — see below |
| `getEvents()` | `{lash, pop, cut, engage, bov, shiftDone}` one-frame impulses |
| `EngineSim.engines()` / `EngineSim.vehicles()` | **static** UI-ready listings |
| `EngineSim.schema()` / `EngineSim.groups()` / `EngineSim.presets()` | **static** — every adjustable parameter with range/step/unit/group, and all 16 built-ins as full presets |
| `sim.output` · `sim.connect(node)` · `opts.destination` | route into a host graph |

**`_lastParams` is private and callers must not read it.** Everything a host
needs is on `getState()` (which includes `gearRatio`, `wheelRpm`, `load`,
`overrun`, `rpmNorm`, `dRpm`, `volume`, `preset`, and `turbo` — whether the
LOADED sound has one, which is not the same question as whether the stock
profile for `engine` does) and `getEvents()`. `index.html` was
reaching into it for the gear ratio and no longer does — it is now a consumer of
the public API only, which is deliberate: it is the proof the API is sufficient.

By default the output goes to `ctx.destination`. `opts.destination` or
`connect(node)` puts it inside a host mixer instead; `connect()` **moves** the
output rather than fanning it out.

Profiles (16): `vtwin i3 rotary2 i4 boxer4 i5 i6 i6diesel v6 v6tt flat6 v8cross
v8tt v8flat v10 v12`.
Vehicles: `hatch sports supercar muscle truck`.
Turbocharged: **i3, boxer4, i5, i6, i6diesel, v6tt, v8tt**.

The five newest, and what each is for:

| id | what makes it different |
| --- | --- |
| `vtwin` | 90° V-twin, pin offset −90° → fires at 0/270°. Two cylinders in two pipes with a 270/450 split, so **50.8 % half-order energy** — the lumpiest thing here. Tiny inertia (0.055), snaps to the limiter. |
| `rotary2` | Two-rotor Wankel. `cylinders: 4` is the *pulse count* per 720° of eccentric shaft, not pistons. Geometry matches an I4 (0 % half-orders); the sound comes from the pulse shape — slow rise, very long tail, so consecutive pulses **overlap**. That overlap is the "braap". |
| `v6tt` | Twin-turbo V6. Low turbo inertia (0.30) so it spools fast. |
| `v8tt` | Same cross-plane geometry as `v8cross`, so it keeps the burble — but the turbines cool the gas and damp the pipes hard, so it lands as a muffled thud instead of a bark. Same firing order, different voice, none of it hand-tuned. |
| `i6diesel` | Compression ignition: `attack: 68`, by far the sharpest pulse here, and `hardness: 0.88`, the most load-hardening in the set. Cool exhaust (1.16), heavy damping, 4600 rpm redline. Big laggy VGT (inertia 0.95) with almost no blow-off valve. |

---

## 6. Presets — the sound file format (`presets.js`)

A **preset** is one whole sound in one JSON-safe object: the machine (geometry,
pipe lengths, pulse shape, turbo) *and* the mix, tone, EQ and effects on top of
it. `loadPreset()` applies all of it; `exportPreset()` writes it out.

```
{ version, id, label,
  engine: { cylinders, firingOrder, banks, pinOffsets?, idleRpm, redlineRpm,
            peakTorque, peakTorqueRpm, engineInertia, gasTempFactor, voice,
            pulse:{attack,decay,hardness,jitter},
            exhaust:{bank,bankB?,collector,reflection,damping,muffler[3]},
            intake:{helmholtz,q,level},
            turbo: null | {inertia,maxBoost,whineOrder,bov,surge} },
  mix:{...6}, tone:{rumble,brightness}, eq:[5 dB],
  fx:{reverbMix,reverbSize,reverbDamping,width,popDepth,dynamics},
  position, volume }
```

`ENGINE_PROFILES` in `profiles.js` is still the machine description and is
unchanged in shape; a preset **embeds** one under `engine` and adds the sound.
The vehicle is deliberately NOT in a preset — a preset is a sound, and the same
engine goes in different cars.

### The schema is the source of truth

`PRESET_SCHEMA` describes every adjustable scalar once — path, range, step,
unit, group, and whether changing it needs a voice rebuild. **Three consumers,
and none of them may hard-code a parameter list:**

1. `normalisePreset()` clamps and fills, so hand-edited JSON cannot put a NaN
   into an AudioParam. It never throws; a corrupt file comes back usable.
2. `index.html` builds every control by walking it. A parameter added in
   `presets.js` appears in the console without the page being touched.
3. `run.mjs` walks it **in both directions** and fails on an orphan.

### Why the orphan check exists

`voice` and `pulse.hardness` were in all sixteen profiles, read by **nothing**,
for as long as the profiles existed. Nothing could see it: an unused number
breaks no test, allocates no node, writes no param. Both are now wired up —
`voice` is the per-engine level trim on the combustion voice, `hardness` scales
how much the pulse sharpens under load (normalised so 0.65 reproduces the fixed
coefficients it had before, so no existing engine changed character).

The check runs both ways because both directions are real faults:

- **A: a profile field the schema does not expose** — walks `ENGINE_PROFILES`
  and requires a schema row for every scalar. The exception list is the
  *architecture* (`firingOrder`, `banks`, `pinOffsets`, `cylinders`, `label`,
  `exhaust.bankB`): carried and validated, but a slider cannot express them.
- **B: a schema row nothing reads** — greps `src/` (excluding the two files that
  *define* the data) for each leaf name. A control that moves and changes
  nothing is the same bug from the other end.

Both were verified to bite by injecting one of each.

### `unit` is a display contract, not decoration

A real unit (`m`, `Hz`, `rpm`, `dB`) is a suffix and the number is formatted by
the row's own `step`; `'%'` means the value is a 0..1-ish proportion and reads
×100; `''` is a bare number. Getting this from the schema rather than
per-control is what stops a pipe length reading "175" and a fader reading
"0.75" — which is exactly what the first version did.

### `rebuild: true` is expensive and the UI must respect it

Wavetables, waveguide delay lines and the turbo graph are all derived at
construction, so there is no way to change a pipe length without allocating.
`setParam()` takes the cheap path for everything else — a mix fader dragged at
60 Hz must not serialise and re-apply the entire sound on every input event, and
must certainly not tear down and rebuild every oscillator. The console debounces
rebuild rows by 130 ms; the readout still tracks the finger.

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

Current: **335 checks** in `run.mjs` + a driving-behaviour suite in `drive.mjs`
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

### Drive mode — the touch cockpit

`?drive`, or the Drive button. A full-viewport overlay: H-pattern shift lever
on one side, throttle and brake on the other, telemetry between. Laid out for
a phone in landscape, because that is the only way two thumbs reach both sides
at once; portrait stacks the same controls with the thumbs at the bottom.

Three things are worth knowing before editing it:

- **The gate maths lives in `src/gate.js`, not in the page.** It was written
  inline first and a real bug hid in it — capturing a column did not apply the
  finger's height until the NEXT move event, so flicking into a gear and
  letting go selected neutral. That is invisible when you drag slowly, and it
  cost a round of browser-poking to find. As a module it is 15 assertions in
  `run.mjs` that run in milliseconds.
- **Pointer events, not touch events, and `pointerId` is tracked per control.**
  A touch implementation that assumes one contact drops the throttle the moment
  the other thumb moves the lever.
- **`setPointerCapture` is wrapped in try/catch.** It throws `NotFoundError` if
  the pointer is already gone — which happens for real when a touch ends between
  dispatch and handling — and an unguarded throw aborts the rest of the handler,
  leaving a pedal stuck down or a lever grabbed but unmoved.

Sizing is entirely `vmin`/`clamp()`/`dvh` with `env(safe-area-inset-*)` padding.
There is no per-device breakpoint: the same layout has to hold from a 320 px
phone to a tablet, and `dvh` is what stops it jumping when mobile browser chrome
hides.

Blueprint / technical-grid aesthetic — engineering drawings and instrument
panels, not a consumer dashboard.

- Engineering-paper ground: 10 px fine grid over 80 px major, fixed attachment.
- Corner crop marks on every panel (`.panel::before/::after`).
- Monospace throughout for data, tabular numerals, tracked uppercase labels.
- Near-monochrome graphite + **one signal colour** (`--acc: #e8481f`) reserved
  for live/hot state: throttle, redline, half-orders, clutch slip > 50 rpm.
- Square geometry, 1 px hairlines, no rounded corners or soft shadows.
- Motion is mechanical: 140 ms cubic, no springs.
- Six tabs: Machine, Tune, Voice mix, Tone, EQ & space, Preset. Instrument +
  telemetry always visible above them.
- Instrument is a **semicircular sweep** with tick ring r=130, numeral ring
  r=104, sweep band r=78 — the three must stay on clearly separated radii or the
  numerals collide with the band (this happened, twice).

### The console builds itself

**Every control on every tab is generated by walking `EngineSim.schema()`**, and
the page holds no parameter list of its own. That is not a style choice: the
page used to hand-write one `<input>` and one binding per parameter, which is
how two profile fields ended up with no control at all and no way to notice.

- `controls` is a `Map` from schema path to `{input, out, row, el}`.
  `syncControls()` pulls every one of them back from the sim, and is what runs
  after anything that changes more than one parameter at once.
- `setParam(path, v)` is the only way a control talks to the sim. The page never
  calls `setMix`/`setTone`/`setReverb` directly, so a control does not need to
  know which setter its parameter lives behind.
- `rebuild: true` rows are **debounced by 130 ms**; the readout still tracks the
  finger. Everything else writes on every input event.
- `needs: 'turbo'` rows, and the group heading around them, are hidden on a
  naturally aspirated engine rather than left doing nothing.
- The spec sheet and the order spectrum read `sim.getPreset().engine`, the LIVE
  engine section — not `ENGINE_PROFILES`. The Tune tab edits those numbers, and
  a spec sheet still showing the factory figures would be lying about the sound
  you are listening to. Same reason the drive HUD asks `getState().turbo`
  instead of looking the engine up.

The Preset tab is save / delete / revert / download / copy / import, plus a live
JSON view with **Apply edits**. Saved presets go to `localStorage` under
`engine-sim/presets/v2` and appear in the picker under "Saved here"; both
storage calls are wrapped, because a browser in private mode throws on write.

---

## 8b. v3 audio pass — what changed and why (read with §9 #48-52)

Driven by a user report: "oversaturated / overblown at high rpm, peaks, very
high-pitched resonance; needs more low end." Measured with a NEW tool,
`test/render.mjs` + `test/render.html`: a real Chromium OfflineAudioContext
render of the whole graph (2nd-gear pull to the limiter, lift, blip), 4 output
channels = L/R + the waveshaper's input + the raw mix bus. Output is float and
unclipped, so it measures true overs. `SOLO=<bus>`, `DYN=0`, `WAV=dir/` env vars.

- **Compressor auto-makeup** (#48). Every browser DynamicsCompressor adds
  `(1/gain@0dBFS)^0.6` of makeup it does not expose. The old high band
  (-30 dB, 5:1) was therefore +13 dB on everything quiet above 2 kHz and
  tripled the A-weighted 1-5 kHz share. `fx.js:compressorMakeupDb` models it
  (matches Chromium to 0.3 dB); `Dynamics` divides it out so every band is
  unity below threshold. **Any new DynamicsCompressor must do the same.**
- **Waveshaper flat-topping** (#49). The shock curve covered ±1 of input and was
  fed 1.2-3× on an ordinary pull and 16× under pops. Curve now spans ±6
  (`SHOCK_HEADROOM`) with soft asymptotes, max drive 2.6.
- **Series-comb resonance spikes** (#50). Header + collector waveguides in series
  produce narrow coincident peaks; a harmonic crossing one rose 20-26 dB above
  its own level a few hundred rpm either side (V12 order 12 at 5696 rpm, -12 dB
  of the whole frame). The 1000-rpm grid in spectrum.mjs could not see it;
  `spikes()` sweeps 25 rpm. Collector reflection ×0.5, damping ×2.0,
  `MODE_SURVIVAL` 1.8. run.mjs asserts no audible spike.
- **Pure-tone whines** (#51): gear whine 0.16→0.065 and sine oscillators, turbo
  whine 0.40→0.27. They were 35-43 dB tones.
- **Low end** (#52). 50-86 % of power sat in 40-80 Hz, mostly the sub sine —
  inaudible on small speakers, but driving the compressor and limiter. Now: LR4
  28 Hz infrasonic HPF, `mix.sub` 0.9→0.55, new `RumbleLayer` (brown noise,
  firing-rate pulse AM via a WaveShaper-on-sawtooth envelope, lope for uneven
  engines, LP 90-360 Hz tracking firing rate), and `BassEnhancer` (missing-
  fundamental harmonics, `tone.punch`).
- Output: limiter makeup trimmed, then `SafetyClipper` (linear to 0.6, tanh to
  0.99). `sim.output` is now the clipper's output node.
- Exhaust tremolo now modulates its own gain stage (`exhaustTrem`), not the bus
  fader — at fader 0 it leaked the exhaust.
- **Live inputs** (`src/inputs.js`): strain, aggression (exhaust valve),
  roughness (misfires through per-bank `gates`), distance (air LPF + level +
  reverb extra), environment (`Space` flutter delays + reverb extra). Folded
  into a reused params object in `_applyInputs` — zero per-frame allocation.
  Never part of the preset; `Reverb.setExtra` keeps them out of `getPreset()`.

Not verified: still nobody has *heard* it. Render numbers after the pass: no
clips, peaks ≤ -2.6 dBFS, A-weighted 1-5 kHz share at high rpm 2-21 % (was up
to 54 %), infrasonic share ~2 % (was up to 34 %).

### UI v3

The console was redesigned from the blueprint look to dark glass over an
audio-reactive canvas background (`#bg`, drawn at 0.35× resolution from an
AnalyserNode on `sim.output`; revs shift hue cold→hot, low band swells the
light, highs drive sparks). Sidebar sections replace tabs: Live inputs, Sound
& mix, Engine tuning, EQ & space, Analysis, Presets. Hold-to-rev buttons
(start the engine on first press). Everything is still generated from
`EngineSim.schema()` / `EngineSim.inputs()` and uses only the public API; the
drive cockpit keeps its ids and pointer handling. The boot guard ignores
resource (font/stylesheet) load errors — the web fonts are optional.

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
| 35 | **Launch bogged at 1585 rpm** | `engine-sim.js` forced `launchFlareRpm: 850`, so a WOT hold sat on ONE pitch for 0.27 s every standing start | dropped the override — but the fix at the time (a "creep" term on the hold target) only moved the plateau to 3200 rpm. Properly fixed by #39. |
| 36 | Popped on **every** lift and every shift | 100 % of lifts fired; every gear change threw a 6-report volley (24 transients across 4 shifts) | stochastic ignition gate on EGT × revs × snap; `burstCount` 6 → 3; shift bang gated on heat and `cutBang` |
| 37 | Pops sat outside the engine | shared output partly sent to the pipe, so pops kept a big dry component AND clunks were sent down the exhaust | split the voice pool into combustion / mechanical buses |
| 38 | Crackle was an octave above the engine | `crackle` at 850/1900 Hz against a ~199 Hz centroid after #31 — half of it inside the 2-6 kHz sensitive band | 430/1150 Hz; `bang` 118/780 → 105/520 |
| 39 | **Launch "jumps to 3200 and sticks"** | not a plateau — a RATE discontinuity: 11 400 rpm/s free-revving vs 2 900 rpm/s dragging the car. Flat-spot tests could not see it, and passed while it was live | wind-up rate derived per car; slip decays with road-speed PROGRESS not a clock; yielding forced close. **0 of 80** combos now reverse |
| 40 | Launch integrator could never unwind | one-sided anti-bog wound to its -0.5 floor during the initial flare and stayed pinned, capping the clutch at 0.50 forever | let it recover when there is no sag |
| 41 | **A hard click on tip-in, lift and every shift** | `clunk` was 1150/3100 Hz, Q 22/16, **0.8 ms** attack — a switch closing, not two castings colliding. Stranded alone in the mix after #31 | 330/1250 Hz, Q 7/6, 3.5 ms; `click` 3200/6400 → 1500/2800 and lvl 0.35 → 0.16, one per shift not two |
| 42 | Pops went faint fixing #38 | dropping both presets an octave took the crackle's energy above 700 Hz from 71 % → **3 %**; `popDirect` 0.22 left only 8 % of the report in the dry path | midpoint by measurement: 112/680 and 700/1850, `popDirect` 0.75 → 38 % above 700 Hz, 2.3 % in 2-6 kHz |
| 43 | **"Full throttle from stationary jumps to 3000 and sticks for a second"** — #39 again, from every entry it was not measured on | rolling re-launch on the old controller: 832 → 2307 rpm in 0.15 s = **11 547 rpm/s**, 94 % of an unloaded rev, then a crawl at 1900. Pulling away in 2nd: 2826 → pinned at ~2960 for a second. Over 64 manual combos × 4 entries: **42 launches with the revs going backwards**, median rate-collapse 0.19 in 2nd | the absolute ramp + slip curve (two curves that cross) replaced by ONE slew-limited demand seeded on the engine, `launchRateFor(gear)` instead of always 1st, a torque feed-forward clutch command with a leaking integral, and the flare absorbed rather than caught. **0** reversals, median collapse 0.85 / 0.92 / 1.00 across cold / 2nd / rolling |
| 44 | **The turbo flutter was effectively unreachable** | gated on `boost`, which goes with the SQUARE of tip speed, so the threshold was squared too — it needed ~0.85 of throttle. Measured over eight lifts per engine at 0.6 throttle (ordinary driving): **0 of 8 on all seven turbo profiles**. The flat-out test passed the whole time | gate on shaft speed instead (`(spool−0.22)/0.38`); arm on any fast large closure, not only on a pedal reaching 10 %; BOV relief 0.85 with no floor → 0.55 with a 0.30 floor. Now 4-7 of 8 at 0.6 throttle and 8 of 8 pressing on, and the biggest valve still trades the flutter down by 3+ dB |
| 45 | Turbo whine was pure and sharp | five of seven profiles sat pinned AT the 3 kHz fundamental cap — same pitch on every car, in the band where hearing peaks, and periodic to the sample | cap → **2200 Hz**; asymmetric saturation (evens = body) + band-limited noise AM for grain; the layer gets its own tone stage (−4.2 dB at 3 k, −16.6 at 8 k); bus level −30 % |
| 46 | **Two profile fields were read by nothing** | `voice` and `pulse.hardness`, in all 16 profiles, for as long as the profiles existed. Invisible: an unused number breaks no test, allocates no node, writes no param | wire both up (`voice` = per-engine level trim, `hardness` = how much the pulse sharpens under load, normalised so 0.65 is the old fixed behaviour) and add the two-directional orphan check in `run.mjs`, verified to bite by injecting one of each |
| 48 | **Quiet treble boosted +13 dB** | browser compressor auto-makeup; A-weighted 1-5 kHz share 16 % bypassed vs 54 % on | `compressorMakeupDb`, divided out per band |
| 49 | **Exhaust flat-topped** | shaper input 1.2-16× its ±1 curve | curve spans ±6, soft asymptotes, drive 2.6 |
| 50 | **rpm-local scream, again** | header×collector series combs; 20-26 dB spikes the 1000-rpm grid missed | collector 0.5/2.0, MODE_SURVIVAL 1.8, `spikes()` test |
| 51 | Whines were pure tones | 35-43 dB prominence | levels down, sines not triangles |
| 52 | Low end inaudible yet dominant | 40-80 Hz sub sine = most of the power | infrasonic HPF, RumbleLayer, BassEnhancer |
| 53 | Crackle under every engine, every sound | RumbleLayer applied its firing-pulse AM AFTER its low-pass filters: each 1 ms pulse attack was a broadband edge on the output, and the band-limited sawtooth's reset ripple, mapped through the steep pulse front, added spike chatter. `test/clicks.mjs` measured 50-78 clicks/s, 100 % from this layer | AM before the filters (noise → AM → HP → LP → body); raised-cosine attack, rise 0.16. 0-0.9 clicks/s, below the old main build (0.7-6.7). `WAV=dir STRICT=1 node test/render.mjs` now fails above 2 clicks/s |
| 54 | Engine muffled, "from another room" | removing the compressors' automatic makeup (#48) also took 3-10 dB of A-weighted loudness, most of it in the mids. First fix (an `Exciter` saturating the note for top end) was heard as CRACKLE and was removed (#56) | see #56 |
| 55 | Turbo a high-pitched sine; flutter rare or absent on some engines | whine 15-20 dB under the whole engine at up to 2.2 kHz, a near-pure partial; surge armed only above spool 0.22, scaled down hard by the BOV, and killed by any partial pedal — `test/turbo.mjs` measured surge 0.05-0.3 on most lifts | whine an octave down (orders ×0.5, cap 1150 Hz), level ×0.3, plus a narrow noise band at the blade rate and a pink AIRFLOW layer; surge arms from spool 0.12, on any 0.2 drop, on the rev limiter (`p.limiter`), sustains while shut, body band lower (520-1170 Hz), ×5 level. Every turbo engine now flutters on every lift (surge 0.40-0.93, 10-25 dB under the whole mix). BOV trade kept (> 3 dB) |
| 56 | Crackle again, and still not full | the Exciter's saturation read as fizz/crackle; what was missing was MIDS (`mid`, 300-2000 vs 40-300 Hz, and `aLvl`, A-weighted level), not treble. Then, with the mids up, the brickwall limiter (knee 0, 1 ms) snapped on every peak: V6 2.1 clicks/s, 0.4 with it bypassed | Exciter removed; mid band makeup 1.06 → 2.12 (+6 dB, 220 Hz-2 kHz only — the treble band stays at unity); limiter knee 4 / 4 ms / 160 ms. Mids at or above the original on every engine, loudness within ~2 dB of it, harshness well below, ≤ 0.6 clicks/s |
| 57 | Turbo flutter lingered | surge decay τ 0.65 s, sustained for as long as the pedal stayed shut; spool-down τ 0.75× inertia coasting | τ 0.26 s, sustain only for the first 0.35 s of a lift, killed only by a real re-open (so a partial lift still flutters); spool-down 0.45×/1.3×. Flutter now lasts 0.33-0.63 s after a lift (was > 0.8 s) |
| 47 | The generated console read pipe lengths as percentages | first pass formatted any unitless row as `v×100`, so a 1.75 m header showed "175" and a 4.4 decay showed "440" | `unit` became a display CONTRACT — real unit = suffix formatted by `step`, `%` = ×100, `''` = bare number |

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
- **CPU is unmeasured.** Node count (264 NA / 303 turbo) and per-frame writes
  (~29) are known; real CPU is not. The original brief asked for < 5 %.
- **Responsive breakpoints** (900/760/620 px) are written but only the 1400 px
  layout has been screenshotted.
- The console has been verified to **load, build and populate** in headless
  Chrome — 16 presets in the picker, 49 generated controls, live telemetry, the
  order spectrum drawn, the JSON view filled, turbo rows correctly hidden on a
  naturally aspirated engine, boot guard dormant, and correctly firing on a
  `file://` origin. **Nobody has clicked a control and listened**, and nobody
  has exercised save/import/download by hand.
- **The user's own report is the only evidence about how any of this sounds.**
  The turbo rework (#44, #45) and the mechanical-layer removal were done to a
  described complaint, and the numbers here confirm the mechanism changed in the
  intended direction — not that the result is right.

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
17. **Changing the exhaust's register changes what else fits in it.** Dropping
    the centroid to ~199 Hz (#31) is what stranded the pop presets an octave
    above the engine (#38). Anything tuned to sit "just above the engine note"
    needs re-checking after a change like that.
18. **An event that fires every time is a sound effect, not a car.** Both #36
    and the old lash machine-gun (#30) were physically justified per-event and
    wrong in aggregate. When adding an event, ask what fraction of opportunities
    should actually produce it — the answer is rarely 100 %.
19. `TransientBank`'s voice pool is **partitioned by bus**, and a stolen voice
    must never cross buses — it is hard-wired to one output, so it would come
    out of the wrong place. Add a preset without a `bus` field and it silently
    becomes mechanical.
20. **The launch has eaten five attempts. Read §4 before touching it.** Four
    of the five failed the same way and the tests could not see it, because the
    audible fault is a discontinuity in the RATE, not a plateau in the value.
    If you change anything there, measure the rate profile.
20a. **A launch has more than one entry condition, and a fix measured on one of
    them is not a fix.** Attempt four was correct from a cold, stationary,
    1st-gear, closed-throttle start and broken from every other entry — rolling
    re-launch, 2nd gear, brake held — because its rate cap was an absolute ramp
    on a clock that any of those had already started. `drive.mjs` now runs all
    four entries; if you add a behaviour to `_launchClutch`, add the entry that
    would break it.
21. **A sub-millisecond attack is a click, not an impact.** Anything above
    ~1 kHz with a fast attack and a high Q will read as a switch closing rather
    than as part of the car. `run.mjs` asserts every preset is ≥ 1.5 ms and
    Q ≤ 12.
22. **Darkening a sound is not the same as blending it.** Fixing #38 by dropping
    the pop presets an octave removed the detachment *and* the definition, and
    #42 was the result. A pop takes its BODY from the pipe and its DEFINITION
    from its own top end and the dry path; killing either one is a bug.
23. `index.html` uses **only** the public API. Keep it that way — it is the
    working proof that the API is enough to build against. It now also builds
    every control by walking `EngineSim.schema()` and never hard-codes a
    parameter list — keep THAT too, for the reason in #24.
24. **A parameter nothing reads is invisible to every other kind of test.**
    `voice` and `pulse.hardness` sat in all sixteen profiles doing nothing for
    the whole life of the project (#46). An unused number allocates no node,
    writes no param, breaks no assertion and looks entirely reasonable in the
    source. The two-directional orphan check in `run.mjs` is the only thing that
    can see it; if you add a field to a profile, add its schema row.
25. **Squaring a quantity squares the threshold you gate on.** The turbo flutter
    was gated on boost, and boost goes with the square of tip speed, so a
    "modest" threshold became a near-flat-out one and the feature was
    unreachable in ordinary driving for months (#44). Gate on the underlying
    quantity, and — the part that actually caught it — write the test at the
    input level a user would really use, not at the extreme where the feature
    obviously works.
26. **`TransientBank`'s `mechanical` voice pool is not the deleted
    `MechanicalLayer`.** It is the casing-radiated clunk/thump/click partition
    and it stays. A search-and-destroy on the word "mechanical" will break the
    driveline clunk.

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
