# Engine Sound & Vehicle Physics Simulator

Procedural engine audio synthesised from **firing geometry**, driven by a
**compliant driveline**. Pure Web Audio API, no samples, no dependencies.

## Running it

```sh
npm start                      # → http://localhost:8000
```

No install step and nothing to download — `npm start` just runs
`node tools/serve.mjs`, a ~90-line static server using only Node's stdlib. Run
that directly if you would rather not go through npm:

```sh
node tools/serve.mjs           # or: node tools/serve.mjs 3000
```

Then open **http://localhost:8000** and press **Ignition**. Browsers will not
start audio without a user gesture, so the first click is doing real work.

> **It has to be served over http://.** The app is built from ES modules, and
> browsers refuse to load those from a `file://` origin — opening `index.html`
> by double-clicking it gives you a page that renders but is completely dead.
> The app detects this case and tells you, rather than failing silently. Any
> static server works; `python3 -m http.server 8000` is equivalent.

Controls: **W** throttle · **S** brake · **Q**/**E** shift down/up ·
**A** auto/manual · **C** exterior/cabin · **Space** ignition.

```sh
npm test                       # 277 checks + the driving-behaviour suite
npm run spectrum               # harshness table for every engine
```

## Layout

```
index.html          the console — the whole UI
tools/serve.mjs     zero-dependency dev server
src/profiles.js     engine + vehicle data (firing order, bank layout, pipe geometry)
src/pulse.js        firing geometry → band-limited PeriodicWave tables
src/resonators.js   exhaust waveguides, muffler, Helmholtz intake, shock rasp, cabin
src/layers.js       valvetrain, gear whine, turbo, transient bank
src/physics.js      drivetrain with torsional compliance and backlash
src/shift.js        gear-shift state machine
src/character.js    exhaust flow noise, sub layer, imperfection modulator
src/fx.js           EQ, reverb, stereo widener, three-band compressor
src/engine-sim.js   public API
test/run.mjs        unit + sweep suite      (277 checks)
test/drive.mjs      driving-behaviour suite
test/spectrum.mjs   analytic spectrum of the exhaust chain
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
                    → mix bus → CabinFilter → EQ → Reverb → Stereoizer
                    → Dynamics (3-band) → limiter → master
```

- **Waveguide** — delay line + in-loop lowpass + reflection, i.e. the
  Karplus-Strong structure the PTR engine-sound model uses. Web Audio forces a
  128-sample minimum delay inside a feedback loop; bank pipes (164–389 samples)
  clear it, with a resonant-bandpass fallback for shorter pipes. The in-loop
  lowpass has phase, which drops the resonance below `c/4L`, so the delay is
  phase-compensated rather than taken raw. **Where that lowpass sits decides how
  many modes the pipe supports, and getting it wrong caused the worst tonal bug
  in the project — see §3f.**
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
| `setEngineType(id)` | 16 profiles (below) — hot-swappable while driving |
| `setVehicle(id)` | `hatch sports supercar muscle truck` — road speed preserved across the swap |
| `setThrottle/setBrake/setClutch(0..1)` | |
| `shiftUp() / shiftDown() / setGear(n)` | returns `false` if refused (would over-rev) |
| `setMix({exhaust, intake, mechanical, transmission, turbo, transients})` | per-voice balance |
| `setTone({rumble, brightness})` | 0–2 each, 1 = default. Low-end lift and high-shelf cut |
| `setDynamics(0..1)` | three-band compressor amount; 0 ≈ bypass, 1 = default |
| `getReduction()` | live `{low, mid, high}` gain reduction, dB |
| `setPerspective('exterior'\|'interior')` | |
| `update(dt)` · `start()` · `stop()` · `dispose()` · `getState()` | |

### The engines

| id | |
| --- | --- |
| `vtwin` | 90° V-twin. Fires at 0/270° — a 270/450 split, so it is the lumpiest engine here (50.8 % half-order energy) and revs like a light switch |
| `i3` | 1.0 turbo triple. Cheap recirculating valve, so it flutters hard |
| `rotary2` | Two-rotor Wankel. Overlapping pulses, no valvetrain, 9000 rpm |
| `i4` | 2.0 naturally aspirated four |
| `boxer4` | Flat-four with unequal headers — the rumble is the header mismatch, not the firing order. Big atmospheric BOV: this is the "chiu" engine |
| `i5` | 2.5 five-cylinder turbo, 2.5-order warble |
| `i6` | 3.0 straight six, inherently balanced |
| `i6diesel` | 6.7 turbo-diesel. Near-step pressure rise, loud injectors, 4600 rpm redline |
| `v6` | 60° V6 |
| `v6tt` | 3.8 twin-turbo V6, fast-spooling |
| `flat6` | 3.8 flat-six, 8500 rpm, that induction howl |
| `v8cross` | Cross-plane 5.0 — the burble |
| `v8tt` | 4.0 twin-turbo V8. Same firing order as `v8cross`, muffled by the turbines into a thud |
| `v8flat` | Flat-plane 4.5, 9000 rpm, zero half-orders, pure scream |
| `v10` | 5.2 V10, 2.5 order per bank |
| `v12` | 6.5 V12 |

Turbocharged: `i3 boxer4 i5 i6 i6diesel v6tt v8tt`.

## 5. Verification, and its limits

`node test/run.mjs` (277 checks) and `node test/drive.mjs`. A strict Web Audio
mock throws on non-finite AudioParam writes, out-of-range frequencies, and
per-frame node allocation. Coverage: all 16 engines × 5 vehicles assembled and
driven, 3600-frame input fuzz per vehicle, engine/vehicle hot-swap, stop/restart.

`node test/spectrum.mjs` is a third tool and a different kind of check: it
reconstructs the magnitude response of the entire exhaust chain **analytically**
— Web Audio's own biquad formulas, delay lines as closed-form combs — and
multiplies it by the wavetable's harmonics at a given rpm. It answers "is this
harsh?" numerically, which no param-level test can. It found the worst tonal bug
in the project (§8).

Steady state: **291 nodes**, ~29 AudioParam writes per frame, zero per-frame
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

- **Coast-down at 1.9x inertia**, not 4.0x — and 0.75x under fuel cut, because
  with no exhaust enthalpy at all the turbine coasts on bearing drag alone. At
  4.0x the shaft barely moved during a 95 ms shift, so the whistle sat flat
  across gear changes. Measured on the inline-6: the whistle now sags
  **2192 → 1654 Hz** (4.9 semitones) through the 2→3 upshift and swells back as
  boost rebuilds. The three-way time constant is what gives each gear its own
  swoop instead of one tone across the whole gearbox.
- **Level weighted to tip speed, not throttle.** The whistle is aeroacoustic
  radiation from the compressor wheel, so it persists while the wheel spins.
  Weighting it `0.35 + 0.65 × flow` collapsed it to a third the instant the
  throttle shut for a shift — it disappeared exactly when it should have been
  sagging and swelling. Now `0.62 + 0.38 × flow`.

A blow-off valve vents pressure in milliseconds but cannot stop a spinning
turbine, so the whistle dips and recovers rather than cutting out and restarting.

### The whine is a wavetable, not a stack of sines

It used to be three sine oscillators at f, 2f and 3f. Three sines at exact
integer ratios with fixed relative levels are, to the ear, **one tone with a
fixed timbre** — which is precisely what "sounds like a single uniform
soundwave" means. And with the fundamental at 3.4–4.2 kHz, a near-pure tone sat
exactly where human hearing is most sensitive.

Now it is one oscillator carrying a band-limited `PeriodicWave` built from a
blade-tone series (harmonics falling as `1/k^1.4`, odd ones stronger, because a
compressor wheel is not symmetric front-to-back). Three things follow: the
browser band-limits per playback frequency so the tone never aliases across the
enormous sweep a spooling turbo covers; the harmonic tilt is set once and
physically rather than by three hand-picked gains; and the fundamental is capped
at **3 kHz**, with the wavetable's harmonics carrying the brightness above that.

On top of it, a formant bandpass that tracks the blade tone (a real compressor
housing is a cavity — the whistle has a vowel to it), shaft-rate sidebands at
BPF/11, and **bearing wander**: two mutually irrational LFOs on detune, deepest
off-boost where the rotor is least loaded and the oil film is thickest.

### The "stu-stu-stu"

Close the throttle while the compressor is still pumping and the air has nowhere
to go. It stalls, flow briefly **reverses** through the wheel, pressure drops,
flow re-establishes, and it repeats — compressor surge, at the Helmholtz
frequency of the compressor-to-throttle volume, 8–30 Hz.

The old version modulated a wide noise band with a **sine**, which gives smooth
tremolo: "shoo-shoo-shoo". Real surge is a relaxation oscillation — abrupt stall,
decaying recovery — so each cycle is a sharp burst with a tail. That shape is the
entire difference between "shu" and "stu".

So the envelope is a sawtooth through a `WaveShaper` carrying an attack/decay
pulse curve. A sawtooth sweeps the whole curve exactly once per cycle, so the
curve *is* the envelope and the oscillator frequency *is* the rate — no
scheduling, no per-event allocation. It drives two bands: a body band (Q 3.5,
700–1900 Hz) for the "tu", and a quiet edge band (Q 2.2, 2.2–3.4 kHz) for the
"st", gated on `surge²` so only a hard stall gets the click.

It is armed by **any** throttle closure against standing boost — which includes
the ignition cut of a gear change. That is why a boosted car flutters on every
upshift, and it is the most recognisable thing a turbocharged engine does.

Whether a car goes "chiu" or "stu-stu-stu" is **one number**: `turbo.bov`, the
valve's capacity. A big atmospheric valve empties the plenum, so nothing is left
to reverse through the wheel and you get the chirp and nothing else. A small or
recirculating valve leaves pressure standing and the compressor stalls anyway.
Measured, `i6` (bov 0.25) flutters **8.6 dB louder** than `boxer4` (bov 0.80),
and both still fire their valve. It is not a mode switch — it falls out of the
physics.

### Whistle sweep, measured

Inline-6 at full throttle through the gearbox, whistle frequency range within
each gear plus one blow-off chirp per upshift:

| gear | whistle range | swing |
| --- | --- | --- |
| 1 | 120 – 1653 Hz | 45.4 semitones (spool-up from rest) |
| 2 | 1320 – 2200 Hz | 8.9 semitones |
| 3 | 1637 – 2386 Hz | 6.5 semitones |
| 4 | 1684 – 2479 Hz | 6.7 semitones |
| 5 | 1912 – 2277 Hz | 3.0 semitones |

Four upshifts, four events. Mapped linearly against shaft speed the swing was
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
- **`Dynamics`** — a three-band compressor, and the one stage whose whole job is
  to make the result pleasant rather than accurate. See below.

### Why one compressor could never work

A single full-range compressor on an engine mix has an unavoidable failure: the
loudest thing in the signal is almost always low-frequency — a 150 Hz exhaust
bang, which then collects the +9 dB rumble shelf on its way past. So the low end
decides the gain reduction and **everything else gets ducked with it**. That is
the "pops interrupt the other sounds" bug (§8), and backing the threshold off to
−5 dB / 2.2:1 only made the hole small enough to live with. It did not fix the
mechanism.

Splitting the signal first fixes the mechanism. A bang now ducks the band it is
actually in, and the engine note carries on in the other two.

```
in ─┬─[LP 240]² ─────────────► low   −20 dB, 3.0:1, 14 ms ─┐
    ├─[HP 240]²─[LP 2000]² ──► mid   −22 dB, 2.4:1, 20 ms ─┼─► out
    └─[HP 2000]² ────────────► high  −30 dB, 5.0:1,  2 ms ─┘
```

The crossover is **Linkwitz-Riley 4th order** — two cascaded Butterworth
sections per edge. Only LR gives both properties that matter: the bands sum back
to flat magnitude (a plain Butterworth split has a +3 dB bump at the crossover)
and the branches stay in phase through it so the sum does not notch.

One trap, and it is an easy one: **Web Audio's `Q` is in decibels for `lowpass`
and `highpass`** and linear for every other filter type. Butterworth is
`Q = −3.01`, not `0.7071`. Measured, the correct value sums to within
**−0.17 dB** of flat across 25 Hz–18 kHz; the naive `0.7` puts **+7.4 dB** at
240 Hz. The test suite asserts both, so the check can be seen to fail.

Each band is set differently for a reason:

- **low** (< 240 Hz) is the chest and the body. Slow attack so a pulse keeps its
  leading edge, long release — this is glue, and the one band where pumping
  would be heard as pumping.
- **mid** (240 Hz – 2 kHz) is where the engine note actually lives, so it gets
  the gentlest treatment. Squeezing this is what makes a compressed engine sound
  small.
- **high** (> 2 kHz) is the harshness band and the reason the stage exists.
  Everything that stings lives here: residual comb peaks, valvetrain clatter,
  injector ticks, the turbo's edge band, the waveshaper's high-order products.
  Low threshold, high ratio, 2 ms attack — anything that spikes up there is
  caught before it can sting, rather than being EQ'd away permanently. **Loud
  stays bright; harsh gets held down.**

`setDynamics(0..1)` scales every threshold (and its makeup) together, so the
stage dials back to nearly transparent without rebuilding anything.

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

### Repeated throttle taps machine-gunned the driveline clunk

Tapping the throttle produced a full-force clunk on **every** torque reversal:
measured at ~25 impacts/second with 79 of them at or near maximum, which reads
as a stream of clicks rather than a car. Gear-tooth contact is **inelastic** —
restitution is well under 1, so a driveline being hammered back and forth loses
energy on each strike and the strikes get progressively weaker. `lashHeat` now
accumulates per impact and decays over 0.55 s, attenuating repeats, and impacts
below 0.05 magnitude are dropped entirely rather than spending a voice.

Measured after: 198 clunks → **41**, loud ones 79 → **1**. The first tap still
lands a proper 0.72 clunk; rapid repeats fade to 0.10.

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

## 3f. The screaming resonance

The worst tonal bug in the project, and the one that needed a new kind of test
to find at all. Symptom: certain engines, at certain rpms, produced a piercing
high-pitched tone that appeared and vanished as the revs swept past.

The cause is a coincidence between two independent series. A feedback waveguide
is a comb — its peaks sit at multiples of `1/T`, where `T` is the pipe's
round-trip delay. An engine's harmonics sit at multiples of `f0 = rpm/120`. At
most rpms the two interleave harmlessly. At the rpm where they **coincide**, one
harmonic lands exactly on a comb peak while its neighbours fall in the troughs.

Measured on the V12 at 8000 rpm — the chain's magnitude response at the
harmonics either side of the spike:

| harmonic | frequency | chain response |
| --- | --- | --- |
| order 14 | 1867 Hz | −23.6 dB |
| **order 15** | **2000 Hz** | **−5.9 dB** |
| order 16 | 2133 Hz | −26.9 dB |

A 21 dB spike, sitting 20 semitones above the engine note, present at one rpm
and gone at the next. **71 % of all radiated power** was landing in the 2–6 kHz
band where human hearing peaks.

Why the peak was that sharp is the actual bug. The loop lowpass that models wall
losses was placed at `f_pipe × (6/damping)` — about **20 surviving modes**. Real
exhausts do not behave that way: thermoviscous wall losses rise with `√f`, and
above the first cross-mode cutoff the plane-wave model stops holding at all, so
a real pipe resolves a handful of modes and then smears into a smooth rolloff.
Letting it ring in its 20th mode is what gave the comb enough Q to spike.

`MODE_SURVIVAL` is now **2.2** — 5 to 8 modes. Measured across 11 engines × 9
rpm × 3 loads, share of radiated power in 2–6 kHz:

| constant | worst case | mean | spectral centroid |
| --- | --- | --- | --- |
| 6.0 (was) | **71.04 %** | 1.42 % | 278 Hz |
| 3.0 | 35.44 % | 0.31 % | 213 Hz |
| **2.2 (now)** | **1.38 %** | 0.04 % | 199 Hz |

17 dB off the worst case for 79 Hz of centroid — the engines stay bright enough
to keep their character and stop screaming. `test/run.mjs` now asserts every
engine stays under 4 %, so this cannot silently come back.

Two things are worth taking from this beyond the fix. First, it was invisible to
every existing test: the graph was correct, every source was started, no
parameter was out of range, nothing allocated. Second, it did not look like a
resonance — it looked like brightness, and the instinct to reach for an EQ cut
would have dulled every engine at every rpm without touching the actual spike.
`test/spectrum.mjs` exists because measuring was the only way to tell.

## 7. Interface

Blueprint / technical-grid aesthetic — the visual language of engineering
drawings and instrument panels rather than a consumer dashboard.

- **Engineering-paper ground**: a 10 px fine grid over an 80 px major grid,
  fixed-attachment so panels sit *on* the drawing rather than float above it.
- **Crop marks**: every panel carries corner registration ticks, the way a
  technical drawing is cropped.
- **Monospace throughout** for data, labels and controls, with tabular numerals
  so digits do not jitter as values change. Uppercase micro-labels on wide
  tracking.
- **Near-monochrome** graphite palette with exactly one signal colour (safety
  orange) reserved for live/hot state — throttle, redline, half-orders, clutch
  slip above 50 rpm — plus a technical blue for the secondary FX controls.
- **Square geometry**: 1 px hairlines, no rounded corners, no soft shadows.
  Sliders run on ticked tracks with rectangular thumbs; segmented controls
  invert to solid ink when active.
- **Motion is mechanical**: 140 ms cubic transitions, no springs or bounce. The
  only ambient animation is a scan line across the logo block and a pulse on the
  ignition indicator.
- **Spec table** with dotted leaders reports the actual profile data — firing
  order, bank layout, exhaust bank length, Helmholtz frequency.

The instrument is a **semicircular sweep**. A first radial attempt crowded its
numerals against the sweep band — they sat only 8 px apart — which a screenshot
made obvious; the fix was not to abandon the dial but to put the tick ring
(r=130), the numeral ring (r=104) and the sweep band (r=78) on clearly separated
radii. Graduations are fine at 250 rpm and major at 1000.

Controls are grouped into four tabs — Machine, Voice mix, Tone, EQ & FX — with
the instrument and telemetry always visible above them.
Layout verified by screenshot at 1280 px.
