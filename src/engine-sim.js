/**
 * engine-sim.js — public API and orchestration.
 *
 * Signal flow:
 *
 *   bank wavetable oscillators (soft/hard crossfade, one pair per exhaust bank)
 *        └→ ExhaustSystem  (per-bank waveguide → collector → muffler → rasp)
 *   intake wavetable oscillator
 *        └→ IntakeResonator (Helmholtz + induction turbulence)
 *   TransmissionLayer (mesh whine from the ENGAGED gear's tooth count)
 *   TurboLayer        (lagged spool whine, BOV, flutter)
 *   TransientBank     (bangs, driveline clunk, clutch thump, synchro)
 *        └→ mix bus → CabinFilter → compressor → master → destination
 *
 * Physics lives in physics.js (compliant driveline with backlash) and shift.js
 * (a real gear-shift state machine). This file owns neither; it steps them and
 * maps their output onto audio parameters.
 */

import { ENGINE_PROFILES, VEHICLE_PRESETS, bankAngles } from './profiles.js';
import {
  PRESET_SCHEMA, PRESET_GROUPS, PRESET_VERSION, DEFAULT_SOUND,
  builtinPreset, builtinPresets, normalisePreset, presetToJSON, presetFromJSON,
  getPath, setPath, schemaFor,
} from './presets.js';
import { buildEngineWaves } from './pulse.js';
import { ExhaustSystem, IntakeResonator, CabinFilter } from './resonators.js';
import { TransmissionLayer, TurboLayer, TransientBank } from './layers.js';
import { ExhaustNoise, SubLayer, CharacterModulator } from './character.js';
import { Drivetrain } from './physics.js';
import { EQ, Reverb, Stereoizer, Dynamics } from './fx.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Default balance between the voices. All user-adjustable at runtime.
 *
 * This is a re-export of the preset format's `mix` section — presets.js owns
 * the defaults now, so an engine can carry its own balance rather than
 * inheriting whatever the host left the faders on.
 */
export const DEFAULT_MIX = { ...DEFAULT_SOUND.mix };

export class EngineSim {
  /**
   * @param {AudioContext|null} audioContext share a context, or null to make one
   * @param {object} opts { engine, vehicle, volume, perspective, mix, ...overrides }
   */
  constructor(audioContext = null, opts = {}) {
    this.ctx = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    this.ownsContext = !audioContext;

    this.engineId = opts.engine in ENGINE_PROFILES ? opts.engine : 'v8cross';
    this.vehicleId = opts.vehicle in VEHICLE_PRESETS ? opts.vehicle : 'sports';
    // A private, normalised, MUTABLE copy — never the shared literal. The
    // console edits engine parameters in place, and mutating ENGINE_PROFILES
    // would poison every other EngineSim in the page and every preset built
    // afterwards.
    this.profile = builtinPreset(this.engineId).engine;
    this.vehicle = VEHICLE_PRESETS[this.vehicleId];

    this.mix = { ...DEFAULT_MIX, ...(opts.mix || {}) };
    this._volume = opts.volume ?? DEFAULT_SOUND.volume;
    this.running = false;
    this._destOpt = opts.destination || null;

    // Preset identity. `presetId` is a built-in engine key for a stock sound
    // and whatever the file said for a loaded one, so a custom preset does not
    // masquerade as the engine it was derived from.
    this.presetId = this.engineId;
    this.presetLabel = this.profile.label;
    this._rumble = DEFAULT_SOUND.tone.rumble;
    this._brightness = DEFAULT_SOUND.tone.brightness;
    this._popDepth = DEFAULT_SOUND.fx.popDepth;
    this._dynamics = DEFAULT_SOUND.fx.dynamics;
    this._width = DEFAULT_SOUND.fx.width;
    this._position = DEFAULT_SOUND.position;

    // Drivetrain owns its ShiftController — the shift state machine has to run
    // inside the sub-stepped integration, not alongside it.
    //
    // This used to force launchFlareRpm to 850, which put the WOT launch hold
    // at 1585 rpm on a V8 and pinned the engine there for most of a second on
    // every standing start. It was an over-correction for the launch bounce.
    // physics.js now controls the launch by SLIP rather than by holding an rpm
    // setpoint at all, so there is nothing here to override — see
    // Drivetrain._launchClutch().
    this.physics = new Drivetrain(this.profile, this.vehicle, { ...opts });

    this._buildGraph();
    this._buildVoices();
    this.setPerspective(opts.perspective || 'exterior');
    this.setVolume(this._volume);
    // A whole sound up front, so a host never has to construct and then
    // reconfigure. `opts.mix`/`opts.volume` still work and are applied first,
    // so an explicit override loses to an explicit preset — which is the right
    // way round: the preset is the more specific statement of intent.
    if (opts.preset) this.loadPreset(opts.preset);
  }

  // =========================================================================
  // Graph
  // =========================================================================

  _buildGraph() {
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;

    // Three-band compressor. A single full-range compressor cannot win here:
    // the loudest thing in an engine mix is nearly always low-frequency, so the
    // low end decides the gain reduction and ducks everything else with it
    // (ledger #17 — every pop punched a hole in the mix). Splitting first means
    // a bang ducks the band it is in and the engine note carries on. The high
    // band doubles as the harshness tamer: fast and firm above 2 kHz, so
    // anything that spikes up there is held down without EQ'ing the brightness
    // away permanently. See fx.js for the band rationale.
    this.dynamics = new Dynamics(ctx, { amount: 1 });

    this.cabin = new CabinFilter(ctx, this.profile);
    this.mixBus = ctx.createGain();
    // Headroom. With every layer now running, peaks were sitting close enough
    // to full scale that the compressor was working continuously and any
    // transient pushed it hard. Backing the bus off leaves room for a bang to
    // be loud without the gain stage reacting to it.
    this.mixBus.gain.value = 0.42;

    // --- tone stage --------------------------------------------------------
    // The wavetable's radiation shelf is expressed in engine ORDERS, so it
    // cannot capture the parts of the response that live at fixed frequencies:
    // the low-frequency lift a tailpipe and body panels radiate efficiently,
    // and the hard rolloff a muffler applies above a couple of kHz. Those go
    // here, and double as the user-facing tone control.
    this.rumbleShelf = ctx.createBiquadFilter();
    this.rumbleShelf.type = 'lowshelf';
    this.rumbleShelf.frequency.value = 145;
    this.rumbleShelf.gain.value = 9;

    this.bodyBump = ctx.createBiquadFilter();
    this.bodyBump.type = 'peaking';
    this.bodyBump.frequency.value = 78;      // tailpipe/cabin boom region
    this.bodyBump.Q.value = 1.0;
    this.bodyBump.gain.value = 5.5;

    // Presence dip. A systemic guard rather than a chase: human hearing peaks
    // around 3-4 kHz, and ANY resonance that lands there reads as harsh no
    // matter which module produced it. Real cabins and real exhaust systems are
    // quiet in this band. A broad, gentle scoop keeps the whole simulator out
    // of the danger zone; the EQ's 2.5 kHz band can put it back if wanted.
    this.presence = ctx.createBiquadFilter();
    this.presence.type = 'peaking';
    this.presence.frequency.value = 3000;
    this.presence.Q.value = 0.85;
    this.presence.gain.value = -4.5;

    this.airCut = ctx.createBiquadFilter();
    this.airCut.type = 'highshelf';
    this.airCut.frequency.value = 2900;
    this.airCut.gain.value = -6;

    this.mixBus.connect(this.rumbleShelf);
    this.rumbleShelf.connect(this.bodyBump);
    this.bodyBump.connect(this.presence);
    this.presence.connect(this.airCut);
    this.airCut.connect(this.cabin.input);
    // Brickwall after the slow compressor. The main compressor is deliberately
    // slow so transients keep their attack, which means peaks now get through
    // it — and a 150 Hz bang also collects the +9 dB rumble shelf on the way,
    // enough to pass 1.0 and clip at the device. This catches only those peaks:
    // fast, high ratio, threshold just under unity, so it is inaudible until
    // something would otherwise distort.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.05;

    // --- output FX ---------------------------------------------------------
    this.eq = new EQ(ctx);
    this.reverb = new Reverb(ctx, { size: 0.32, mix: 0.14 });
    this.stereo = new Stereoizer(ctx, { width: 0.35 });

    this.cabin.output.connect(this.eq.input);
    this.eq.output.connect(this.reverb.input);
    this.reverb.output.connect(this.stereo.input);
    this.stereo.output.connect(this.dynamics.input);
    this.dynamics.output.connect(this.limiter);
    this.limiter.connect(this.master);
    // Routable output. A game usually has its own mixer — a music bus, a master
    // fader, an analyser for a visualiser — and hard-wiring to ctx.destination
    // forces the engine to be the last thing in the chain. Pass
    // `opts.destination`, or call connect() later.
    this._destination = null;
    this.connect(this._destOpt || ctx.destination);

    // One gain per voice so the balance is user-controllable.
    this.busses = {};
    for (const name of Object.keys(DEFAULT_MIX)) {
      const g = ctx.createGain();
      g.gain.value = this.mix[name];
      g.connect(this.mixBus);
      this.busses[name] = g;
    }
  }

  /** Build everything that depends on the engine profile. */
  _buildVoices() {
    const ctx = this.ctx;
    const p = this.profile;

    this.waves = buildEngineWaves(ctx, p, bankAngles);

    this.exhaust = new ExhaustSystem(ctx, p);
    this.exhaust.output.connect(this.busses.exhaust);

    this.intake = new IntakeResonator(ctx, p);
    this.intake.output.connect(this.busses.intake);

    this.transmission = new TransmissionLayer(ctx, p, this.vehicle);
    this.transmission.output.connect(this.busses.transmission);

    this.turbo = p.turbo ? new TurboLayer(ctx, p) : null;
    if (this.turbo) this.turbo.output.connect(this.busses.turbo);

    this.transients = new TransientBank(ctx, p);
    // Mechanical transients — driveline clunk, clutch thump, synchro click.
    // These radiate from the casing straight into the air; they have no
    // business going anywhere near the exhaust.
    this.transients.output.connect(this.busses.transients);

    // A real exhaust bang happens IN THE PIPE and comes out of the tailpipe, so
    // it carries the same resonance, reflections and muffler colour as the
    // engine note. Sending them straight to the mix bus is why they sounded dry
    // and detached — like flicking a plastic bottle next to a car rather than
    // something the car did.
    //
    // The combustion voices now go almost entirely through the pipe. What used
    // to be a partial send off a shared output left a large dry component in
    // the mix, and that dry component is what the ear locates OUTSIDE the car.
    this.popSend = ctx.createGain();
    this.popSend.gain.value = 1.05;
    this.transients.combustionOutput.connect(this.popSend);
    for (const inp of this.exhaust.inputs) this.popSend.connect(inp);

    // The direct path is NOT a garnish — it is where a pop's definition lives.
    //
    // The pipe is a lowpass: for a V8 the muffler packing sits at 1.9 kHz and
    // the waveguide loop filter at ~400 Hz, so anything routed through it comes
    // out with the pipe's colour and almost none of its own top. At 0.22 that
    // left the reports with 8 % of their energy in the direct path against 86 %
    // before, and the result was correct in placement but faint and dull — the
    // body of a pop with none of the crack.
    //
    // 0.75 is the measured midpoint: the crackle's share of energy above 700 Hz
    // comes back from 3 % to 38 % (it was 71 %), while its share in the harsh
    // 2-6 kHz band stays at 2.3 % (it was 4.0 %). Body from the pipe, edge from
    // the direct path.
    this.popDirect = ctx.createGain();
    this.popDirect.gain.value = 0.75;
    this.transients.combustionOutput.connect(this.popDirect);
    this.popDirect.connect(this.busses.transients);

    // Broadband flow noise, fed INTO the exhaust waveguides so it resonates in
    // the same pipe as the combustion pulses. This is what turns a clean
    // harmonic stack into something that sounds like moving gas.
    this.exhaustNoise = new ExhaustNoise(ctx, p);
    for (const inp of this.exhaust.inputs) this.exhaustNoise.output.connect(inp);

    this.sub = new SubLayer(ctx, p);
    this.sub.output.connect(this.busses.sub);

    // Slow, non-repeating wander in pitch and level.
    this.character = new CharacterModulator(ctx, p);
    this.character.tremolo.connect(this.busses.exhaust.gain);

    // --- wavetable oscillators --------------------------------------------
    // Every one of these MUST start at the same instant and always carry the
    // same frequency. The banks' relative phase is what encodes the firing
    // pattern; if they drift apart, a cross-plane V8 stops burbling.
    this.oscs = [];

    this.waves.banks.forEach((bank, i) => {
      const target = this.exhaust.inputs[i];
      this.oscs.push(this._makeWavePair(bank.soft, bank.hard, target, 'bank' + i));
    });
    this.oscs.push(this._makeWavePair(
      this.waves.intake.soft, this.waves.intake.hard, this.intake.input, 'intake'));
  }

  /** A soft/hard wavetable pair sharing one frequency, crossfaded by load. */
  _makeWavePair(softWave, hardWave, dest, label) {
    const ctx = this.ctx;
    const mk = (wave, detuneTrim) => {
      const o = ctx.createOscillator();
      o.setPeriodicWave(wave);
      // A fixed few cents between the soft and hard tables keeps them from
      // phase-locking into a single sterile tone when crossfaded.
      o.detune.value = detuneTrim;
      // Slow wander, summed into detune. Without this the harmonics are exactly
      // periodic forever, which is most of why a synthesised engine reads as a
      // buzzer rather than a machine.
      if (this.character) this.character.detune.connect(o.detune);
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g);
      g.connect(dest);
      return { osc: o, gain: g };
    };
    return { label, soft: mk(softWave, -3), hard: mk(hardWave, 3) };
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async start() {
    if (this.running) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    // An OscillatorNode is single-use: once stopped it can never restart, so a
    // previous stop() means the whole voice set has to be rebuilt.
    if (this._needsRebuild) {
      for (const m of this._modules()) if (m !== this.cabin && m.dispose) m.dispose();
      this._buildVoices();
      this._needsRebuild = false;
    }
    this.running = true;

    const t = this.ctx.currentTime + 0.02;   // one common start instant
    for (const pair of this.oscs) {
      pair.soft.osc.start(t);
      pair.hard.osc.start(t);
    }
    for (const m of this._modules()) if (m.start) m.start(t);

    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(0.0001, now);
    this.master.gain.linearRampToValueAtTime(this._volume, now + 0.3);
    this._writeParams(this.physics.step(0, this.ctx.currentTime), true);
  }

  stop() {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(Math.max(this.master.gain.value, 0.0001), now);
    this.master.gain.linearRampToValueAtTime(0.0001, now + 0.25);

    const at = now + 0.3;
    for (const pair of this.oscs) {
      try { pair.soft.osc.stop(at); } catch (e) { /* already stopped */ }
      try { pair.hard.osc.stop(at); } catch (e) { /* already stopped */ }
    }
    for (const m of this._modules()) if (m.stop) m.stop(at);
    this.running = false;
    this._needsRebuild = true;
  }

  dispose() {
    this.stop();
    for (const m of this._modules()) if (m.dispose) m.dispose();
    // The output-stage FX are not in _modules() — they have no per-frame work,
    // so they must not be walked every frame — but they still hold nodes.
    for (const m of [this.eq, this.reverb, this.stereo, this.dynamics]) {
      if (m && m.dispose) m.dispose();
    }
    if (this.ownsContext) setTimeout(() => this.ctx.close(), 500);
  }

  _modules() {
    return [this.exhaust, this.intake, this.transmission,
            this.turbo, this.transients, this.exhaustNoise, this.sub,
            this.character, this.cabin].filter(Boolean);
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Swap the engine, keeping the current mix/tone/EQ. Use `loadPreset()` to
   * bring a whole sound across instead.
   * @param {string} id key of ENGINE_PROFILES
   */
  setEngineType(id) {
    if (!(id in ENGINE_PROFILES) || id === this.engineId) return false;
    this.engineId = id;
    this._applyEngine(builtinPreset(id).engine);
    return true;
  }

  /**
   * Rebuild every voice around a new engine description.
   *
   * This is the expensive path — wavetables, waveguide delay lines and the
   * turbo graph are all derived from these numbers at construction, so there is
   * no way to change a pipe length without allocating. Anything a game touches
   * per frame goes through an AudioParam instead; this is for the tuning
   * console and for loading a preset.
   *
   * @param {object} engine an `engine` section, already normalised
   */
  _applyEngine(engine) {
    const wasRunning = this.running;
    if (wasRunning) this._hardStopVoices();

    this.profile = engine;
    this.physics.setEngine(this.profile);

    for (const m of this._modules()) {
      if (m !== this.cabin && m.dispose) m.dispose();
    }
    this._buildVoices();
    // The voice set is brand new, so a pending stop() no longer needs start()
    // to rebuild it. Without this, loading a preset while stopped built every
    // oscillator twice — once here and once on the next start().
    this._needsRebuild = false;
    if (wasRunning) {
      const t = this.ctx.currentTime + 0.02;
      for (const pair of this.oscs) { pair.soft.osc.start(t); pair.hard.osc.start(t); }
      for (const m of this._modules()) if (m.start) m.start(t);
    }
  }

  // -------------------------------------------------------------------------
  // Presets — the save/load surface
  // -------------------------------------------------------------------------

  /**
   * Everything about the current sound, as a plain JSON-safe object. This is
   * the file format; see presets.js.
   */
  getPreset() {
    const rv = this.reverb.getState();
    return normalisePreset({
      version: PRESET_VERSION,
      id: this.presetId,
      label: this.presetLabel,
      engine: this.profile,
      mix: { ...this.mix },
      tone: { rumble: this._rumble ?? 1, brightness: this._brightness ?? 1 },
      eq: this.eq.getGains(),
      fx: {
        reverbMix: rv.mix,
        reverbSize: rv.size,
        reverbDamping: rv.damping,
        width: this.stereo.getWidth ? this.stereo.getWidth() : this._width,
        popDepth: this._popDepth,
        dynamics: this._dynamics,
      },
      position: this._position,
      volume: this._volume,
    });
  }

  /**
   * Apply a whole preset: engine, mix, tone, EQ, effects, listener position and
   * volume. Accepts a built-in id, a preset object, or a JSON string.
   *
   * The engine section is only rebuilt when it actually differs, because a
   * rebuild stops and re-creates every oscillator — dragging a mix fader on a
   * UI that round-trips through here must not tear the sound down 60 times a
   * second.
   *
   * @returns {boolean} false if the argument could not be read as a preset
   */
  loadPreset(source) {
    let preset = source;
    if (typeof source === 'string') {
      preset = ENGINE_PROFILES[source] ? builtinPreset(source)
                                       : presetFromJSON(source).preset;
    }
    if (!preset || typeof preset !== 'object') return false;
    preset = normalisePreset(preset);

    this.presetId = preset.id;
    this.presetLabel = preset.label;
    if (ENGINE_PROFILES[preset.id]) this.engineId = preset.id;
    if (JSON.stringify(preset.engine) !== JSON.stringify(this.profile)) {
      this._applyEngine(preset.engine);
    }

    this.setMix(preset.mix);
    this.setTone(preset.tone);
    this.setEQ(preset.eq);
    this.setReverb({
      mix: preset.fx.reverbMix,
      size: preset.fx.reverbSize,
      damping: preset.fx.reverbDamping,
    });
    this.setWidth(preset.fx.width);
    this.setPopDepth(preset.fx.popDepth);
    this.setDynamics(preset.fx.dynamics);
    this.setPosition(preset.position);
    this.setVolume(preset.volume);
    return true;
  }

  /** The current preset as pretty JSON — what a "save" button writes out. */
  exportPreset() { return presetToJSON(this.getPreset()); }

  /**
   * Set one schema parameter by its dotted path, e.g.
   * `setParam('engine.exhaust.bank', 1.4)`.
   *
   * This is how a tuning UI drives the sim: one entry point, so a control can
   * be generated from `PRESET_SCHEMA` without the page knowing which setter a
   * given parameter happens to live behind. Rows marked `rebuild` go through
   * the voice rebuild; everything else takes the cheap path.
   *
   * @returns {number|null} the clamped value actually applied, or null if the
   *          path is not in the schema
   */
  setParam(path, value) {
    const row = schemaFor(path);
    if (!row) return null;
    if (row.needs === 'turbo' && !this.profile.turbo) return null;
    const v = clamp(Number(value), row.min, row.max);
    if (!isFinite(v)) return null;

    // Rebuild rows go the long way round: wavetables and waveguide delay lines
    // are derived at construction and there is no way to change a pipe length
    // without allocating. A UI dragging one of these must debounce.
    if (row.rebuild) {
      const preset = this.getPreset();
      setPath(preset, path, v);
      this._applyEngine(normalisePreset(preset).engine);
      return v;
    }

    // Everything else is a live parameter, and this is the path a control drag
    // takes at 60 Hz. Going through loadPreset() here would serialise and
    // re-apply the entire sound on every input event.
    const seg = path.split('.');
    if (seg[0] === 'mix') this.setMix({ [seg[1]]: v });
    else if (seg[0] === 'tone') this.setTone({ [seg[1]]: v });
    else if (seg[0] === 'eq') this.setEQBand(Number(seg[1]), v);
    else if (path === 'position') this.setPosition(v);
    else if (path === 'volume') this.setVolume(v);
    else if (seg[0] === 'fx') {
      if (seg[1] === 'reverbMix') this.setReverb({ mix: v });
      else if (seg[1] === 'reverbSize') this.setReverb({ size: v });
      else if (seg[1] === 'reverbDamping') this.setReverb({ damping: v });
      else if (seg[1] === 'width') this.setWidth(v);
      else if (seg[1] === 'popDepth') this.setPopDepth(v);
      else if (seg[1] === 'dynamics') this.setDynamics(v);
    } else if (seg[0] === 'engine') {
      // Live engine constants: torque, inertia, rev range, per-engine trim and
      // the whole turbo section. Mutating the private profile and re-pushing it
      // is enough — every consumer re-derives from it.
      setPath(this.profile, seg.slice(1).join('.'), v);
      this.physics.setEngine(this.profile);
      for (const m of this._modules()) if (m.setProfile) m.setProfile(this.profile);
    } else {
      return null;
    }
    return v;
  }

  /** Current value of a schema parameter, or null if it does not apply. */
  getParam(path) {
    const v = getPath(this.getPreset(), path);
    return typeof v === 'number' ? v : null;
  }

  /** The tuning schema, for a UI that builds itself. */
  static schema() { return PRESET_SCHEMA; }
  static groups() { return PRESET_GROUPS; }
  /** Every built-in engine as a complete preset. */
  static presets() { return builtinPresets(); }

  _hardStopVoices() {
    const at = this.ctx.currentTime + 0.05;
    for (const pair of this.oscs) {
      try { pair.soft.osc.stop(at); } catch (e) { /* noop */ }
      try { pair.hard.osc.stop(at); } catch (e) { /* noop */ }
    }
  }

  /** @param {string} id key of VEHICLE_PRESETS */
  setVehicle(id) {
    if (!(id in VEHICLE_PRESETS) || id === this.vehicleId) return false;
    this.vehicleId = id;
    this.vehicle = VEHICLE_PRESETS[id];
    if (this.physics.setVehicle) this.physics.setVehicle(this.vehicle);
    if (this.transmission.setVehicle) this.transmission.setVehicle(this.vehicle);
    return true;
  }

  setThrottle(v) { this.physics.throttle = clamp(Number(v) || 0, 0, 1); }
  setBrake(v) { this.physics.brake = clamp(Number(v) || 0, 0, 1); }
  setClutch(v) { this.physics.clutchPedal = clamp(Number(v) || 0, 0, 1); }
  setAutoShift(on) { this.physics.setAutoShift(on); }

  shiftUp() { return this.physics.shiftUp(); }
  shiftDown() { return this.physics.shiftDown(); }
  setGear(n) { return this.physics.setGear(n); }

  setVolume(v) {
    this._volume = clamp(Number(v) || 0, 0, 1);
    if (this.running) this.master.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.05);
  }

  /** Adjust the balance between voices, e.g. setMix({ intake: 1.2, turbo: 0 }). */
  setMix(partial) {
    Object.assign(this.mix, partial);
    const now = this.ctx.currentTime;
    for (const [name, g] of Object.entries(this.busses)) {
      g.gain.setTargetAtTime(clamp(this.mix[name] ?? 1, 0, 2), now, 0.03);
    }
  }

  /**
   * Tone control. `rumble` 0..2 scales the low-end lift (1 = default +7 dB
   * shelf at 135 Hz plus a +4 dB bump at 72 Hz), `brightness` 0..2 scales the
   * high shelf (1 = default -5 dB above 3.2 kHz; >1 opens it back up).
   */
  setTone({ rumble, brightness } = {}) {
    const now = this.ctx.currentTime;
    if (rumble != null) {
      this._rumble = clamp(Number(rumble) || 0, 0, 2);
      this.rumbleShelf.gain.setTargetAtTime(9 * this._rumble, now, 0.05);
      this.bodyBump.gain.setTargetAtTime(5.5 * this._rumble, now, 0.05);
    }
    if (brightness != null) {
      this._brightness = clamp(Number(brightness) || 0, 0, 2);
      this.airCut.gain.setTargetAtTime(-6 * (2 - this._brightness), now, 0.05);
    }
    return { rumble: this._rumble ?? 1, brightness: this._brightness ?? 1 };
  }

  /** Five-band EQ, dB per band: [sub 60, body 200, honk 800, rasp 2.5k, air 8k]. */
  setEQ(gains) { this.eq.setGains(gains); return this.eq.getGains(); }
  setEQBand(i, dB) { this.eq.setBand(i, dB); return this.eq.getGains(); }
  resetEQ() { this.eq.reset(); return this.eq.getGains(); }

  /** Reverb. `mix` 0..1, `size` 0..1 (~0.15-2.2 s), `damping` Hz. */
  setReverb({ mix, size, damping } = {}) {
    if (mix != null) this.reverb.setMix(mix);
    if (size != null) this.reverb.setSize(size);      // rebuilds the IR — not per frame
    if (damping != null) this.reverb.setDamping(damping);
    return this.reverb.getState();
  }

  /** Stereo width, 0 = mono, 1 = very wide. Mono-sum safe. */
  setWidth(w) { return (this._width = this.stereo.setWidth(w)); }

  /**
   * How hard the three-band compressor works. 0 = effectively bypassed,
   * 1 = the tuned default. Lower it if the mix should breathe more; raise
   * nothing above 1, the bands are already at their intended thresholds.
   */
  setDynamics(amount) { return (this._dynamics = this.dynamics.setAmount(amount)); }

  /** Per-band gain reduction in dB — diagnostics for the console UI. */
  getReduction() { return this.dynamics.getReduction(); }

  /** How much of the transient energy is routed through the exhaust pipe. */
  setPopDepth(v) {
    const g = clamp(Number(v) || 0, 0, 2);
    this._popDepth = g;
    this.popSend.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
    return g;
  }

  /** 'exterior' | 'interior'. For a continuous blend use setPosition(). */
  setPerspective(mode) {
    this.cabin.setPerspective(mode);
    this._perspective = mode;
    this._position = mode === 'interior' ? 1 : 0;
  }

  /**
   * Continuous listener position: 0 = outside the car, 1 = in the cabin.
   * Use this instead of setPerspective() when the camera moves smoothly —
   * a chase camera pulling into a cockpit, for instance.
   */
  setPosition(x) {
    const v = clamp(Number(x) || 0, 0, 1);
    this._position = v;
    this.cabin.setPosition(v);
    this._perspective = v >= 0.5 ? 'interior' : 'exterior';
    return v;
  }

  update(deltaTime) {
    let dt = Number(deltaTime) || 0;
    if (dt <= 0) return;
    dt = Math.min(dt, 0.1);

    // step() sub-steps internally and returns the fully populated params object.
    const p = this.physics.step(dt, this.ctx.currentTime);
    this._writeParams(p, false);
    this._lastParams = p;
    return this;
  }

  /**
   * Everything a game needs to draw a dashboard and drive its own effects.
   * Safe to call every frame; allocates one small object.
   */
  getState() {
    const s = this.physics.getState();
    const p = this._lastParams;
    return {
      ...s,
      shiftPhase: s.phase || '',
      clutchSlip: p ? p.clutchSlip : 0,
      boost: p ? p.boost : 0,
      // Derived quantities that callers were reaching into `_lastParams` for.
      // A private field is not an integration surface.
      gearRatio: p ? p.gearRatio : 0,
      wheelRpm: p ? p.wheelRpm : 0,
      load: p ? p.load : 0,
      overrun: p ? p.overrun : 0,
      rpmNorm: p ? p.rpmNorm : 0,
      dRpm: p ? p.dRpm : 0,
      engine: this.engineId,
      engineLabel: this.presetLabel || this.profile.label,
      // Whether the LOADED sound has a turbo, which is not the same question as
      // whether the stock profile for `engine` does: a preset can be edited or
      // hand-written. A dashboard drawing a boost gauge has to ask this, not
      // ENGINE_PROFILES.
      turbo: !!this.profile.turbo,
      preset: this.presetId,
      vehicle: this.vehicleId,
      vehicleLabel: this.vehicle.label,
      gearbox: this.vehicle.gearbox,
      auto: this.physics.shift ? this.physics.shift.autoShift : true,
      perspective: this._perspective,
      volume: this._volume,
      mix: { ...this.mix },
    };
  }

  /**
   * One-frame impulse flags from the last `update()`, magnitude 0..1, each
   * non-zero for exactly one frame. Hang camera shake, particles and haptics
   * off these.
   *
   *   lash       driveline backlash impact — the clunk
   *   pop        exhaust bang / crackle
   *   cut        ignition cut at the start of a gear change
   *   engage     clutch bite
   *   bov        blow-off valve released
   *   shiftDone  the gear change finished
   */
  getEvents() {
    const p = this._lastParams;
    if (!p) return { lash: 0, pop: 0, cut: 0, engage: 0, bov: 0, shiftDone: 0 };
    return {
      lash: p.evLash || 0,
      pop: p.evPop || 0,
      cut: p.evCut || 0,
      engage: p.evEngage || 0,
      bov: p.evBov || 0,
      shiftDone: p.evShiftDone || 0,
    };
  }

  /** The node the whole simulator comes out of. */
  get output() { return this.master; }

  /**
   * Route the output somewhere other than `ctx.destination`. Replaces any
   * previous destination, so calling it twice moves the engine rather than
   * fanning it out to both.
   * @param {AudioNode} node
   */
  connect(node) {
    if (!node) return this;
    if (this._destination) {
      try { this.master.disconnect(this._destination); } catch (e) { /* wasn't connected */ }
    }
    this.master.connect(node);
    this._destination = node;
    return this;
  }

  /** Engine profiles as UI-ready metadata. Static — no AudioContext needed. */
  static engines() {
    return Object.entries(ENGINE_PROFILES).map(([id, p]) => ({
      id,
      label: p.label,
      cylinders: p.cylinders,
      turbo: !!p.turbo,
      idleRpm: p.idleRpm,
      redlineRpm: p.redlineRpm,
      peakTorque: p.peakTorque,
      banks: p.banks.length,
    }));
  }

  /** Vehicle presets as UI-ready metadata. Static — no AudioContext needed. */
  static vehicles() {
    return Object.entries(VEHICLE_PRESETS).map(([id, v]) => ({
      id,
      label: v.label,
      mass: v.mass,
      gears: v.gearRatios.length,
      gearbox: v.gearbox,
      finalDrive: v.finalDrive,
    }));
  }

  // =========================================================================
  // Frame update
  // =========================================================================

  _writeParams(p, immediate) {
    if (!this.running && !immediate) return;
    const tc = immediate ? 0.002 : 0.02;
    const now = p.now;

    // f0 is the frequency of one complete 720° engine cycle. Every wavetable
    // oscillator runs at exactly this, which keeps the banks phase-locked.
    const f0 = clamp(p.f0, 0.02, 4000);

    // Equal-power crossfade between the light-load and full-load tables. This
    // changes timbre but not level, so radiated amplitude is applied on top:
    // combustion energy scales sub-linearly with load (the PTR model uses
    // torque^0.7) and radiation efficiency rises with firing rate. On overrun
    // there is no combustion at all, so the pulse train nearly vanishes and the
    // airflow layers carry the sound.
    const x = clamp(p.load, 0, 1);
    // The load floor and the overrun cut compound, and at 0.22/0.72 they took
    // the exhaust down 94% on a trailing throttle — the engine all but vanished
    // when coasting, which is precisely when you most want to hear it. Fuel cut
    // stops COMBUSTION, but every cylinder is still pumping air past an open
    // exhaust valve, so the pulses go soft and dull rather than away.
    //
    // `profile.voice` is the per-engine trim on all of that: how loudly this
    // particular engine speaks relative to the rest of the mix, before any
    // user-facing level control. It sat in all sixteen profiles being read by
    // NOTHING until the preset schema went looking for orphans.
    const ampl = (0.32 + 0.68 * Math.pow(x, 0.7))
               * (0.45 + 0.55 * clamp(p.rpmNorm, 0, 1))
               * (1 - 0.45 * clamp(p.overrun, 0, 1))
               * clamp(Number(this.profile.voice) || 1, 0.2, 2);
    const gSoft = Math.cos(x * Math.PI / 2) * ampl;
    const gHard = Math.sin(x * Math.PI / 2) * ampl;

    for (const pair of this.oscs) {
      pair.soft.osc.frequency.setTargetAtTime(f0, now, tc);
      pair.hard.osc.frequency.setTargetAtTime(f0, now, tc);
      pair.soft.gain.gain.setTargetAtTime(gSoft, now, tc);
      pair.hard.gain.gain.setTargetAtTime(gHard, now, tc);
    }

    for (const m of this._modules()) m.update(p);
  }
}

export { ENGINE_PROFILES, VEHICLE_PRESETS };
export {
  PRESET_SCHEMA, PRESET_GROUPS, PRESET_VERSION, DEFAULT_SOUND,
  builtinPreset, builtinPresets, normalisePreset, presetToJSON, presetFromJSON,
  getPath, setPath, schemaFor,
};
export default EngineSim;
