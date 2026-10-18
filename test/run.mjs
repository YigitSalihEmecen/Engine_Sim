/**
 * run.mjs — headless integration harness.
 *
 * Nobody can hear the output here, so this checks everything that is checkable
 * without ears: physical plausibility of the derived numbers, absence of the
 * failure modes that silently kill a Web Audio graph (NaN into an AudioParam,
 * frequencies past Nyquist, feedback gain >= 1), and that the graph is built
 * once rather than per frame.
 *
 *   node test/run.mjs            all suites
 *   node test/run.mjs orders     one suite
 */

import { createMockContext, installGlobals } from './mock-audio.mjs';
import { ENGINE_PROFILES, VEHICLE_PRESETS, bankAngles, firingAngles, pipeDelay, pipeFrequency }
  from '../src/profiles.js';
import { orderSpectrum, buildCycle, toPressureGradient, cycleToCoefficients, reconstruct }
  from '../src/pulse.js';
import { DEFAULT_SOUND } from '../src/presets.js';

const DEFAULT_TURBO = DEFAULT_SOUND.turbo;

let failures = 0, checks = 0;
const only = process.argv[2];

async function suite(name, fn) {
  if (only && !name.includes(only)) return;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
  try { await fn(); } catch (e) { failures++; console.log(`  \x1b[31mTHREW\x1b[0m ${e.message}`); }
}
function ok(cond, label, detail = '') {
  checks++;
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? '  ' + detail : ''}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
}
function info(label, detail) { console.log(`    \x1b[2m${label}\x1b[0m ${detail}`); }

// ---------------------------------------------------------------------------

await suite('firing geometry', () => {
  for (const [id, p] of Object.entries(ENGINE_PROFILES)) {
    const angles = firingAngles(p);
    ok(angles.size === p.cylinders, `${id}: every cylinder has a firing angle`);
    const bankTotal = p.banks.flat().length;
    ok(bankTotal === p.cylinders, `${id}: banks cover all cylinders`,
       `${bankTotal} vs ${p.cylinders}`);
    const uniq = new Set(p.banks.flat());
    ok(uniq.size === p.cylinders, `${id}: no cylinder in two banks`);
    ok(new Set(p.firingOrder).size === p.cylinders, `${id}: firing order is a permutation`);
  }
});

await suite('orders — burble comes from geometry, not tuning', () => {
  const halfEnergy = (id) => {
    const p = ENGINE_PROFILES[id];
    const spec = orderSpectrum(p, bankAngles(p, 0), 0.5, 24);
    let half = 0, tot = 0;
    for (const s of spec) {
      const isHalf = Math.abs(s.order % 1) > 0.01;
      tot += s.mag ** 2; if (isHalf) half += s.mag ** 2;
    }
    return 100 * half / tot;
  };
  const cross = halfEnergy('v8cross'), flat = halfEnergy('v8flat');
  ok(cross > 20, 'cross-plane V8 has strong half-orders (burble)', cross.toFixed(1) + '%');
  ok(flat < 1, 'flat-plane V8 has none (flat scream)', flat.toFixed(1) + '%');
  ok(halfEnergy('i4') < 1, 'I4 has none', halfEnergy('i4').toFixed(1) + '%');
  ok(halfEnergy('i6') < 1, 'I6 has none', halfEnergy('i6').toFixed(1) + '%');
  // Odd cylinders per bank must fire at a non-integer order.
  ok(halfEnergy('flat6') > 20, 'flat-6 (3 per bank → 1.5 order)', halfEnergy('flat6').toFixed(1) + '%');
  ok(halfEnergy('v10') > 20, 'V10 (5 per bank → 2.5 order)', halfEnergy('v10').toFixed(1) + '%');
});

await suite('wavetable analysis/synthesis round-trip', () => {
  const p = { cylinders: 1, pulse: { attack: 40, decay: 6, hardness: 0.6, jitter: 0 } };
  const cyc = buildCycle(p, [0], 0.5);
  const c = cycleToCoefficients(cyc, 2048);
  const rec = reconstruct(c.real, c.imag, 1024);
  const target = Array.from({ length: 1024 }, (_, i) => cyc[i * 8]);
  const mean = target.reduce((a, b) => a + b, 0) / target.length;
  const t2 = target.map(v => v - mean);
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < 1024; i++) { d += rec[i] * t2[i]; x += rec[i] ** 2; y += t2[i] ** 2; }
  const r = d / Math.sqrt(x * y);
  ok(r > 0.999, 'coefficients reconstruct the cycle exactly', 'r=' + r.toFixed(6));

  // Control: the test must be able to fail.
  const flip = reconstruct(c.real, c.imag.map(v => -v), 1024);
  let d2 = 0, x2 = 0;
  for (let i = 0; i < 1024; i++) { d2 += flip[i] * t2[i]; x2 += flip[i] ** 2; }
  ok(d2 / Math.sqrt(x2 * y) < 0.5, 'flipped sign convention would be caught',
     'r=' + (d2 / Math.sqrt(x2 * y)).toFixed(3));

  for (const [id, prof] of Object.entries(ENGINE_PROFILES)) {
    const co = cycleToCoefficients(toPressureGradient(buildCycle(prof, bankAngles(prof, 0), 1)));
    let bad = 0;
    for (let i = 0; i < co.real.length; i++) {
      if (!isFinite(co.real[i]) || !isFinite(co.imag[i])) bad++;
    }
    ok(bad === 0, `${id}: all coefficients finite`);
  }
});

await suite('exhaust geometry vs the orders the engine actually produces', () => {
  // A pipe that resonates far from any order the engine emits is a data bug.
  for (const [id, p] of Object.entries(ENGINE_PROFILES)) {
    const fBank = pipeFrequency(p.exhaust.bank, p.gasTempFactor);
    const dBank = pipeDelay(p.exhaust.bank, p.gasTempFactor);
    // engine order N sits at rpm/120 * N Hz; sweep the usable rev range
    const loF = p.idleRpm / 120, hiF = p.redlineRpm / 120;
    const domOrder = p.cylinders / p.banks.length;      // firings per bank per cycle... in orders
    const loDom = loF * domOrder, hiDom = hiF * domOrder;
    const inRange = fBank > loDom * 0.4 && fBank < hiDom * 4;
    info(id.padEnd(9),
      `pipe ${p.exhaust.bank}m → ${fBank.toFixed(0)}Hz (delay ${(dBank * 1000).toFixed(2)}ms), ` +
      `dominant order sweeps ${loDom.toFixed(0)}–${hiDom.toFixed(0)}Hz`);
    ok(inRange, `${id}: bank pipe resonance is musically related to the firing range`);
    ok(dBank * 48000 >= 128 || p.exhaust.bank < 0.5,
       `${id}: pipe delay vs the 128-sample feedback floor`,
       `${(dBank * 48000).toFixed(0)} samples`);
  }
});

// ---------------------------------------------------------------------------
// These require the agent-authored modules; skip cleanly until they land.
// ---------------------------------------------------------------------------

const have = async (path) => { try { return await import(path); } catch { return null; } };

const resonators = await have('../src/resonators.js');
const layers = await have('../src/layers.js');
const physics = await have('../src/physics.js');
const shift = await have('../src/shift.js');

function sweepParams() {
  const out = [];
  for (const rpm of [700, 900, 1500, 3000, 5000, 7000, 9000]) {
    for (const load of [0, 0.35, 1]) {
      for (const phase of ['', 'cut', 'open', 'sync', 'engage', 'lash', 'shuffle']) {
        out.push({
          now: 0, dt: 1 / 60,
          rpm, f0: rpm / 120, rpmNorm: (rpm - 800) / 6200, dRpm: (load - 0.5) * 12000,
          throttle: load, load, overrun: load < 0.1 ? 1 : 0, torqueSign: load > 0.1 ? 1 : -1,
          gear: 3, gearRatio: 5.2, speed: 30, wheelRpm: rpm / 5.2, clutchSlip: phase === 'engage' ? 400 : 0,
          clutchEngaged: phase ? 0.4 : 1, boost: load,
          shifting: !!phase, shiftPhase: phase,
          evCut: phase === 'cut' ? 1 : 0, evLash: phase === 'lash' ? 0.8 : 0,
          evEngage: phase === 'engage' ? 0.6 : 0, evBov: 0, evShiftDone: 0,
        });
      }
    }
  }
  return out;
}

await suite('audio modules — construction and parameter sweep', () => {
  if (!resonators || !layers) {
    console.log('  \x1b[2m(skipped — resonators.js / layers.js not present yet)\x1b[0m');
    return;
  }
  for (const [id, profile] of Object.entries(ENGINE_PROFILES)) {
    const mock = createMockContext();
    installGlobals(mock.ctx);
    const built = [];
    const add = (Cls, ...args) => { if (Cls) built.push(new Cls(mock.ctx, profile, ...args)); };

    add(resonators.ExhaustSystem);
    add(resonators.IntakeResonator);
    add(resonators.CabinFilter);
    add(layers.TransmissionLayer, VEHICLE_PRESETS.sports);
    // The turbo bolts onto any engine, so every engine gets swept with one.
    built.push(new layers.TurboLayer(mock.ctx, { ...profile, turbo: { ...DEFAULT_TURBO, enabled: 1 } }));
    add(layers.TransientBank);

    const afterBuild = mock.report().nodes;
    mock.seal();

    let t = 0;
    for (const p of sweepParams()) {
      t += 1 / 60; mock.advance(1 / 60); p.now = mock.ctx.currentTime;
      for (const m of built) m.update(p);
    }
    const rep = mock.report();
    ok(rep.violations === 0, `${id}: no violations across ${sweepParams().length} frames`,
       `${afterBuild} nodes, ${rep.paramWrites} param writes`);
    ok(rep.nodes === afterBuild, `${id}: no per-frame node allocation`,
       `${rep.nodes} vs ${afterBuild}`);
  }
});

await suite('audibility — every source started and connected to the output', async () => {
  // The check that was missing. A source node that is built, connected and
  // never started is completely silent, and NOTHING else in this harness
  // notices: its params still get written, the graph still looks right, the
  // node count is still stable. It cost eight oscillators across two layers.
  const { EngineSim } = await import('../src/engine-sim.js');
  for (const e of Object.keys(ENGINE_PROFILES)) {
    for (const v of ['sports', 'truck']) {
      const mk = createMockContext();
      installGlobals(mk.ctx);
      // Turbo on for one of the two, so its layer is audited on every engine.
      const sim = new EngineSim(mk.ctx, { engine: e, vehicle: v, turbo: v === 'truck' });
      await sim.start();
      for (let i = 0; i < 90; i++) {
        sim.setThrottle(i < 60 ? 1 : 0);
        mk.advance(1 / 60);
        sim.update(1 / 60);
      }
      const a = mk.audit(mk.ctx.destination);
      ok(a.unstarted.length === 0, `${e}/${v}: every source is started`,
         a.unstarted.length ? a.unstarted.join(',') : `${a.sources} sources`);
      ok(a.orphaned.length === 0, `${e}/${v}: every source reaches the output`,
         a.orphaned.length ? a.orphaned.join(',') : '');
    }
  }
});

await suite('physics — driveline', () => {
  if (!physics || !shift) {
    console.log('  \x1b[2m(skipped — physics.js / shift.js not present yet)\x1b[0m');
    return;
  }
  for (const [vid, vehicle] of Object.entries(VEHICLE_PRESETS)) {
    const profile = ENGINE_PROFILES.v8cross;
    const d = new physics.Drivetrain(profile, vehicle, {});
    let maxTwist = 0, lashEvents = 0, bad = 0, t = 0;
    for (let i = 0; i < 60 * 60; i++) {
      d.setThrottle(Math.random());
      d.setBrake(Math.random() < 0.1 ? 1 : 0);
      if (Math.random() < 0.01) d.shiftUp();
      if (Math.random() < 0.01) d.shiftDown();
      t += 1 / 60;
      const p = d.step(1 / 60, t);
      if (!isFinite(p.rpm) || !isFinite(p.speed) || p.rpm < 0) bad++;
      maxTwist = Math.max(maxTwist, Math.abs(d.twist ?? 0));
      if (p.evLash) lashEvents++;
    }
    ok(bad === 0, `${vid}: 3600 fuzz frames stay finite`);
    ok(maxTwist < 1, `${vid}: driveline twist bounded`, maxTwist.toFixed(4) + ' rad');
    ok(lashEvents > 0 && lashEvents < 1200, `${vid}: lash fires on events, not continuously`,
       lashEvents + ' impacts');
  }
});

await suite('gear gate — the H-pattern constraint', async () => {
  const G = await import('../src/gate.js');
  const { buildGate, moveGate, gateSelection, gatePosition,
          GATE_TOP, GATE_BOT, GATE_MID } = G;

  /** Drag the lever through a list of points and return where it ends up. */
  const drag = (geom, from, path) => {
    let k = gatePosition(from, geom);
    for (const [x, y] of path) k = moveGate(k, { x, y }, geom);
    return { knob: k, gear: gateSelection(k, geom) };
  };

  for (const n of [5, 6, 7]) {
    const geom = buildGate(n);
    ok(geom.slots.length === n, `${n}-speed: every gear gets a slot`);
    ok(geom.cols.length === Math.ceil(n / 2), `${n}-speed: gears pair into columns`,
       `${geom.cols.length} columns`);
    // Every gear must be reachable: into the channel, across, then pull.
    let reachable = 0;
    for (const s of geom.slots) {
      const r = drag(geom, 0, [[s.x, GATE_MID], [s.x, s.y]]);
      if (r.gear === s.gear) reachable++;
    }
    ok(reachable === n, `${n}-speed: every gear is reachable through the gate`,
       `${reachable}/${n}`);
  }

  const geom = buildGate(6);

  // The constraint itself: you cannot cut the corner.
  const diag = drag(geom, 1, [[80, 80]]);
  ok(diag.gear !== 6, 'a diagonal cannot jump straight from 1st to 6th',
     `ended in ${diag.gear || 'N'}`);

  // 1 -> N -> 3, the path a hand actually takes, including a release the
  // instant the lever reaches the slot. This is the case that was broken:
  // the column was captured but the lever kept the channel's height, so
  // letting go immediately selected neutral instead of the gear.
  const flick = drag(geom, 1, [[20, GATE_MID], [50, GATE_MID], [50, GATE_TOP]]);
  ok(flick.gear === 3, 'a flick into a gear engages it without a second move',
     `ended in ${flick.gear || 'N'}`);

  // Releasing anywhere along the channel is neutral.
  const neutral = drag(geom, 3, [[50, GATE_MID], [35, GATE_MID]]);
  ok(neutral.gear === 0, 'releasing in the channel selects neutral');

  // Half out of the channel is not a gear yet.
  const half = drag(geom, 0, [[50, GATE_MID - 7]]);
  ok(half.gear === 0, 'a half-pull does not engage anything');

  // A 5-speed's last column has only a top slot; the lever must not be able to
  // drop into a 6th that does not exist.
  const g5 = buildGate(5);
  const lastCol = g5.cols[g5.cols.length - 1];
  const ghost = drag(g5, 0, [[lastCol, GATE_MID], [lastCol, GATE_BOT]]);
  ok(ghost.gear === 0 && ghost.knob.y <= GATE_MID + 1,
     '5-speed: the lever cannot enter the empty half of the last column',
     `y=${ghost.knob.y.toFixed(1)}, gear ${ghost.gear || 'N'}`);

  // Coming back to the channel releases the column, so you can cross to another.
  const cross = drag(geom, 1, [[20, GATE_MID], [80, GATE_MID], [80, GATE_BOT]]);
  ok(cross.gear === 6, 'returning to the channel frees the lever to cross',
     `ended in ${cross.gear || 'N'}`);
});

await suite('public API — what a host project actually needs', async () => {
  const { EngineSim } = await import('../src/engine-sim.js');

  // Static listings: a host must be able to build a picker without importing
  // internals or knowing the profile schema.
  const engines = EngineSim.engines();
  const vehicles = EngineSim.vehicles();
  ok(engines.length === Object.keys(ENGINE_PROFILES).length,
     'engines() lists every profile', `${engines.length}`);
  ok(engines.every(e => e.id && e.label && e.redlineRpm > 0),
     'engines() entries are UI-ready');
  ok(vehicles.length === Object.keys(VEHICLE_PRESETS).length,
     'vehicles() lists every preset', `${vehicles.length}`);
  ok(vehicles.every(v => v.id && v.label && v.gears > 0 && v.gearbox),
     'vehicles() entries are UI-ready');

  const reaches = (from, target) => {
    const seen = new Set(), stack = [from];
    while (stack.length) {
      const n = stack.pop();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      if (n === target) return true;
      for (const d of (n._connections || [])) stack.push(d);
    }
    return false;
  };

  // Routing into a host graph. Hard-wiring to ctx.destination forces the engine
  // to be the last thing in the chain, which no game with its own mixer wants.
  const mk = createMockContext();
  installGlobals(mk.ctx);
  const bus = mk.ctx.createGain();
  const sim = new EngineSim(mk.ctx, { engine: 'i6', vehicle: 'sports', destination: bus });
  await sim.start();
  ok(reaches(sim.output, bus), 'opts.destination routes the output into a host node');
  ok(!reaches(sim.output, mk.ctx.destination),
     'and does NOT also wire itself to ctx.destination');
  sim.connect(mk.ctx.destination);
  ok(reaches(sim.output, mk.ctx.destination) && !reaches(sim.output, bus),
     'connect() moves the output rather than fanning out');

  for (let i = 0; i < 40; i++) { sim.setThrottle(1); mk.advance(1 / 60); sim.update(1 / 60); }

  // Telemetry: everything the console needs must be on getState(), not on the
  // private _lastParams it used to reach into.
  const st = sim.getState();
  for (const k of ['rpm', 'speedKmh', 'gear', 'gearRatio', 'load', 'rpmNorm',
                   'clutchSlip', 'boost', 'shiftPhase', 'redline', 'volume']) {
    ok(st[k] !== undefined, `getState() exposes ${k}`);
  }
  ok(st.gearRatio > 0, 'gearRatio is the real total ratio', st.gearRatio.toFixed(2));

  const ev = sim.getEvents();
  ok(['lash', 'pop', 'cut', 'engage', 'bov', 'shiftDone'].every(k => k in ev),
     'getEvents() exposes every one-frame impulse', Object.keys(ev).join(','));

  sim.transients.trigger('bang', mk.ctx.currentTime, 0.8);
  sim.transients.trigger('clunk', mk.ctx.currentTime, 0.8);
  const pops = sim.takePops();
  ok(pops.length === 1 && pops[0].amp === 0.8 && pops[0].time >= mk.ctx.currentTime && sim.takePops().length === 0,
     'takePops() hands over each exhaust report once, clunks excluded', JSON.stringify(pops));

  ok(sim.setPosition(0.5) === 0.5 && sim.getState().perspective === 'interior',
     'setPosition() gives a continuous exterior↔cabin blend');
  ok(sim.update(1 / 60) === sim, 'update() is chainable');
  sim.dispose();
});

await suite('transients — pops go through the pipe, clunks do not', async () => {
  // Where a transient is HEARD FROM is physics, not mix. Fuel lighting off
  // inside the exhaust leaves through the tailpipe and must carry the pipe's
  // resonance and muffler colour; gear lash happens in a steel box bolted to
  // the chassis and never goes near the exhaust. Sharing one output and
  // sending part of it to the pipe got both of those wrong at once.
  const { EngineSim } = await import('../src/engine-sim.js');
  const mk = createMockContext();
  installGlobals(mk.ctx);
  const sim = new EngineSim(mk.ctx, { engine: 'v8cross', vehicle: 'sports' });
  await sim.start();
  const TB = sim.transients;

  const reaches = (from, target) => {
    const seen = new Set(), stack = [from];
    while (stack.length) {
      const n = stack.pop();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      if (n === target) return true;
      for (const d of (n._connections || [])) stack.push(d);
    }
    return false;
  };

  const pipe = sim.exhaust.inputs[0];
  const dest = mk.ctx.destination;
  const comb = TB.pools.combustion[0].gain;
  const mech = TB.pools.mechanical[0].gain;

  ok(TB.pools.combustion.length > 0 && TB.pools.mechanical.length > 0,
     'the voice pool is split by bus',
     `${TB.pools.combustion.length} combustion / ${TB.pools.mechanical.length} mechanical`);
  ok(reaches(comb, pipe), 'a combustion voice reaches the exhaust waveguides');
  ok(reaches(comb, dest), 'a combustion voice reaches the output');
  ok(!reaches(mech, pipe), 'a MECHANICAL voice never enters the exhaust');
  ok(reaches(mech, dest), 'a mechanical voice reaches the output');

  // The presets that fire into the pipe must actually be tagged for it.
  const { TRANSIENT_PRESETS } = await import('../src/layers.js');
  ok(TRANSIENT_PRESETS.bang.bus === 'combustion'
     && TRANSIENT_PRESETS.crackle.bus === 'combustion',
     'bang and crackle are combustion');
  ok(TRANSIENT_PRESETS.clunk.bus === 'mechanical'
     && TRANSIENT_PRESETS.thump.bus === 'mechanical'
     && TRANSIENT_PRESETS.click.bus === 'mechanical',
     'clunk, thump and click are mechanical');

  // Tonal placement: a report an octave above the engine reads as a separate
  // object next to the car. The exhaust centroid is ~200 Hz (see spectrum.mjs),
  // so the combustion pair has to live in that register.
  // A pop needs the pipe for BODY and its own top end for DEFINITION. Dropping
  // both presets an octave to fix detachment threw the definition away with it
  // — the crackle's energy above 700 Hz fell from 71 % to 3 % and the reports
  // went faint. Both ends of that are failures, so both are asserted, on the
  // radiated spectrum rather than on the raw filter frequencies.
  {
    const { chainMag, toneStage, biquad } = await import('./spectrum.mjs');
    const P = ENGINE_PROFILES.v8cross;
    const H = chainMag(P, 0, 1.0, 0.6), T = toneStage();
    const radiated = (pre, send, direct) => {
      const a = biquad('bandpass', pre.fA, pre.qA), b = biquad('bandpass', pre.fB, pre.qB);
      let tot = 0, hi = 0, harsh = 0;
      for (let f = 25; f < 12000; f *= Math.pow(2, 1 / 48)) {
        const src = (a(f) + pre.mixB * b(f)) * pre.lvl * 9;
        const pipe = src * send * H(f), dry = src * direct * 0.42 * T(f);
        const p = pipe * pipe + dry * dry;
        tot += p;
        if (f >= 700) hi += p;
        if (f >= 2000 && f <= 6000) harsh += p;
      }
      return { hi: 100 * hi / tot, harsh: 100 * harsh / tot };
    };
    const c = radiated(TRANSIENT_PRESETS.crackle, 1.05, 0.75);
    ok(c.hi > 20, 'the crackle keeps enough top end to define a pop',
       `${c.hi.toFixed(0)}% above 700 Hz`);
    ok(c.harsh < 3.5, 'the crackle stays mostly out of the ear-sensitive band',
       `${c.harsh.toFixed(1)}% in 2-6 kHz`);
  }

  // NOTHING may click. A sub-millisecond attack on a high-Q band above 1 kHz is
  // a switch closing, not a car — `clunk` was 0.8 ms at 1150/3100 Hz with Q 22
  // and it was the most out-of-place sound in the mix. Two large steel parts
  // colliding take milliseconds for the contact patch to develop, and they are
  // damped by oil and by being bolted to a body shell.
  for (const [name, pre] of Object.entries(TRANSIENT_PRESETS)) {
    ok(pre.atk >= 0.0015, `${name}: attack is an impact, not a click`,
       `${(pre.atk * 1000).toFixed(1)} ms`);
    ok(pre.qA <= 12 && pre.qB <= 12, `${name}: resonances are damped, not ringing`,
       `Q ${pre.qA} / ${pre.qB}`);
  }

  // Weighted band centre of each preset, against an exhaust centroid of ~199 Hz.
  // Anything mechanical that sits a long way above the engine reads as a
  // separate object rather than as part of the car.
  const centre = (p) => (p.fA + p.fB * p.mixB) / (1 + p.mixB);
  ok(centre(TRANSIENT_PRESETS.clunk) < 900,
     'the driveline clunk shares a register with the engine',
     `${Math.round(centre(TRANSIENT_PRESETS.clunk))} Hz`);
  // The synchro click is the one bright thing left, so it has to be quiet.
  ok(TRANSIENT_PRESETS.click.lvl <= 0.2, 'the synchro click is a hint, not an event',
     `lvl ${TRANSIENT_PRESETS.click.lvl}`);
});

await suite('dynamics — the three-band crossover sums flat', async () => {
  // A band-split compressor is only transparent if the bands add back up to the
  // signal that went in. Web Audio's lowpass/highpass Q is in DECIBELS, so
  // Butterworth is Q = -3.01 dB and not 0.7071 — a very easy thing to get wrong
  // and the failure mode is a fat resonant bump at every crossover rather than
  // anything that looks broken.
  const { Dynamics } = await import('../src/fx.js');
  const SR = 48000;

  /** Complex response of one Web Audio lowpass/highpass section. */
  const section = (type, f0, qDb) => {
    const w0 = 2 * Math.PI * f0 / SR, cw = Math.cos(w0), sw = Math.sin(w0);
    const al = sw / (2 * Math.pow(10, qDb / 20));
    const b0 = type === 'lowpass' ? (1 - cw) / 2 : (1 + cw) / 2;
    const b1 = type === 'lowpass' ? 1 - cw : -(1 + cw);
    const b2 = b0;
    const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
    return (f) => {
      const w = 2 * Math.PI * f / SR;
      const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
      const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
      const dd = dr * dr + di * di;
      return [(nr * dr + ni * di) / dd, (ni * dr - nr * di) / dd];
    };
  };
  const mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];

  const worstDeviation = (qDb) => {
    const [LOW, MID] = Dynamics.BANDS;
    const lp1 = section('lowpass', LOW.f, qDb), hp1 = section('highpass', LOW.f, qDb);
    const lp2 = section('lowpass', MID.f, qDb), hp2 = section('highpass', MID.f, qDb);
    let worst = 0, at = 0;
    for (let f = 25; f < 18000; f *= Math.pow(2, 1 / 48)) {
      const L = mul(lp1(f), lp1(f));
      const M = mul(mul(hp1(f), hp1(f)), mul(lp2(f), lp2(f)));
      const H = mul(hp2(f), hp2(f));
      const re = L[0] + M[0] + H[0], im = L[1] + M[1] + H[1];
      const dB = 20 * Math.log10(Math.hypot(re, im));
      if (Math.abs(dB) > Math.abs(worst)) { worst = dB; at = f; }
    }
    return { worst, at };
  };

  const good = worstDeviation(-3.0103);
  ok(Math.abs(good.worst) < 0.5, 'Linkwitz-Riley bands recombine flat',
     `${good.worst.toFixed(3)} dB at ${good.at.toFixed(0)} Hz`);
  // Control: the value someone would reach for if they read Q as linear.
  const bad = worstDeviation(0.7);
  ok(Math.abs(bad.worst) > 3, 'the test can fail — a linear Q of 0.7 bumps the crossover',
     `${bad.worst.toFixed(2)} dB at ${bad.at.toFixed(0)} Hz`);

  // And the stage is actually in the signal path with all three bands built.
  const mk = createMockContext();
  installGlobals(mk.ctx);
  const d = new Dynamics(mk.ctx, { amount: 1 });
  ok(d.bands.length === 3, 'three bands built', d.bands.map(b => b.spec.name).join('/'));
  ok(d.bands[2].spec.attack <= 0.005 && d.bands[2].spec.ratio >= 3,
     'the high band is a fast harshness tamer',
     `${d.bands[2].spec.attack * 1000} ms, ${d.bands[2].spec.ratio}:1`);
  d.setAmount(0);
  ok(d.bands.every(b => b.comp.threshold.value === 0), 'amount 0 parks every threshold');
  d.setAmount(1);
  // The browser compressor adds its own makeup; the stage must divide it back
  // out, or every band becomes a fixed boost below threshold (the old high
  // band was +13 dB on anything quiet — the "high pitched resonance").
  const { compressorMakeupDb } = await import('../src/fx.js');
  ok(Math.abs(compressorMakeupDb(-30, 5, 6) - 13.0) < 0.5 && Math.abs(compressorMakeupDb(-20, 3, 12) - 5.6) < 0.2,
     'compressor auto-makeup model matches Chromium measurements',
     `${compressorMakeupDb(-30, 5, 6).toFixed(2)} / ${compressorMakeupDb(-20, 3, 12).toFixed(2)} dB`);
  const unity = d.bands.map(b => {
    const auto = compressorMakeupDb(b.spec.threshold, b.spec.ratio, b.spec.knee);
    return 20 * Math.log10(b.makeup.gain.value) + auto;
  });
  // The low and HIGH bands must not boost (the treble band is where the
  // whistles lived). The mid band carries a deliberate lift — 220 Hz-2 kHz is
  // where the revs are heard (ledger #56) — bounded so it cannot creep.
  ok(unity[0] < 1.0 && unity[2] < 1.0 && unity[1] < 7.0,
     'no band boosts below its threshold beyond the intended mid lift', unity.map(u => u.toFixed(2) + ' dB').join(' / '));
});

await suite('turbo — spool, whine sweep and compressor surge', async () => {
  const { EngineSim } = await import('../src/engine-sim.js');
  // No engine owns a turbo any more; it bolts onto any of them. These span the
  // rev range and the cylinder count. Not the V-twin: in the sports chassis it
  // may not pull away at 0.6 throttle, so it never builds boost to test.
  const TURBOS = ['i3', 'boxer4', 'i6', 'i6diesel', 'v6', 'v8cross', 'v12'];

  /** Drive one engine through gear pulls with periodic lifts. */
  const run = (engine, { lift = true, shift = true, throttle = 1, bov, valve, antiLag } = {}) => {
    const mk = createMockContext();
    installGlobals(mk.ctx);
    const sim = new EngineSim(mk.ctx, { engine, vehicle: 'sports', turbo: true });
    if (bov != null) sim.setParam('turbo.bov', bov);
    if (valve != null) sim.setParam('turbo.valve', valve);
    if (antiLag != null) sim.setParam('turbo.antiLag', antiLag);
    sim.start();
    const T = sim.turbo;
    const r = { peakSurge: 0, peakBody: 0, surgeFrames: 0, bov: 0,
                whineMin: Infinity, whineMax: 0, spoolMin: Infinity, spoolMax: 0, pops: 0, shelf: 0, liftSpool: 1 };
    for (let i = 0; i < 60 * 10; i++) {
      const closed = lift && (i % 180 >= 150);
      sim.setThrottle(closed ? 0 : throttle);
      mk.advance(1 / 60);
      sim.update(1 / 60);
      if (sim._lastParams.evBov > 0) r.bov++;
      if (sim._lastParams.evPop > 0) r.pops++;
      r.shelf = Math.min(r.shelf, sim.turbineShelf.gain.value);
      if (closed && i > 180) r.liftSpool = Math.min(r.liftSpool, T.spool);
      r.peakSurge = Math.max(r.peakSurge, T._surge);
      const body = T.surgeBodyLvl.gain.value;
      r.peakBody = Math.max(r.peakBody, body);
      if (body > 0.02) r.surgeFrames++;
      const w = T.whineOsc.frequency.value;
      if (w > r.whineMax) r.whineMax = w;
      if (w < r.whineMin) r.whineMin = w;
      r.spoolMin = Math.min(r.spoolMin, T.spool);
      r.spoolMax = Math.max(r.spoolMax, T.spool);
    }
    return r;
  };

  for (const id of TURBOS) {
    const r = run(id);
    // The whistle has to MOVE. A flat tone across the whole rev range is what
    // "sounds fake" means; a real turbo sweeps as the shaft spools and sags.
    const semitones = 12 * Math.log2(r.whineMax / Math.max(1, r.whineMin));
    // > 15: with boost only above 3500 rpm, the diesel's 4600 rpm range leaves
    // a narrower sweep than a revvy petrol's.
    ok(semitones > 15, `${id}: whine sweeps a musically useful range`,
       `${r.whineMin.toFixed(0)}-${r.whineMax.toFixed(0)} Hz = ${semitones.toFixed(1)} semitones`);
    // The fundamental must stay clear of the band where the ear peaks. It used
    // to be capped at 3 kHz, but five of the seven profiles then sat pinned AT
    // the cap — same pitch on every car, and still the sharpest thing in the
    // mix. 2200 puts it under the ear's peak; the wavetable's harmonics, rolled
    // off by the layer's own tone stage, carry the brightness.
    ok(r.whineMax <= 2200, `${id}: whine fundamental stays out of the harsh band`,
       `max ${r.whineMax.toFixed(0)} Hz`);
    ok(r.peakSurge > 0.15 && r.surgeFrames > 20,
       `${id}: compressor surges on lift-off`,
       `peak ${r.peakSurge.toFixed(2)}, active ${r.surgeFrames} frames`);
  }

  // THE FLUTTER HAS TO BE REACHABLE WITHOUT DRIVING FLAT OUT.
  //
  // It was gated on `boost`, and boost goes with the square of tip speed, so
  // the threshold was squared too: nothing happened below ~0.85 of throttle.
  // Measured over eight lifts per engine at 0.6 throttle — ordinary driving —
  // every one of the seven turbo profiles surged on 0 of 8. Gating on shaft
  // speed instead puts it at 4-7 of 8. This is the assertion that would have
  // caught that, and the flat-out one above cannot: it passed the whole time.
  for (const id of TURBOS) {
    // 0.8, not 0.6: boost now only comes in above 3500 rpm, and at 0.6 the
    // automatic changes up before that — no boost, no flutter, correctly.
    const r = run(id, { throttle: 0.8 });
    ok(r.peakSurge > 0.15 && r.surgeFrames > 10,
       `${id}: surges in ordinary driving, not only flat out`,
       `peak ${r.peakSurge.toFixed(2)} at 0.8 throttle, active ${r.surgeFrames} frames`);
  }

  // A big atmospheric valve relieves the plenum, so there is less left to
  // reverse through the wheel. A 0.80 valve against a 0.25 one, same engine.
  //
  // The margin used to be > 5 dB, on a relief coefficient of 0.85 with no
  // floor. That silenced the big-valve cars rather than trading them down —
  // boxer4 kept 0.32 of its stall authority and barely chattered even flat out.
  // The valve still decides how much flutter there is, which is the whole point
  // of `turbo.bov`; it no longer decides whether there is any.
  const big = run('i6', { bov: 0.8 }), small = run('i6', { bov: 0.25 });
  const dB = 20 * Math.log10(small.peakBody / Math.max(1e-6, big.peakBody));
  ok(dB > 3, 'a large blow-off valve still trades flutter away',
     `bov 0.25 ${small.peakBody.toFixed(3)} vs bov 0.80 ${big.peakBody.toFixed(3)} = ${dB.toFixed(1)} dB`);
  // Valve TYPE: no valve flutters hardest and never dumps; recirculating
  // still dumps (quietly) — the event is there for the host either way.
  const none = run('i6', { valve: 0 }), recirc = run('i6', { valve: 2 });
  ok(none.peakSurge > 0.6 && none.bov === 0, 'no blow-off valve: full flutter, no dump',
     `peak ${none.peakSurge.toFixed(2)}, ${none.bov} BOV events`);
  ok(recirc.bov > 0 && none.peakSurge > big.peakSurge * 2, 'a big valve prevents most of the flutter',
     `none ${none.peakSurge.toFixed(2)} vs bov 0.80 ${big.peakSurge.toFixed(2)}`);
  // Anti-lag: lifts keep the shaft lit and bang; nothing stalls.
  const als = run('i6', { antiLag: 1 });
  ok(als.pops > 5 && als.peakSurge < 0.05 && als.liftSpool > 0.3 && als.liftSpool > small.liftSpool + 0.1,
     'anti-lag holds spool, bangs, no flutter',
     `${als.pops} pop frames, surge ${als.peakSurge.toFixed(2)}, spool on lifts ${als.liftSpool.toFixed(2)} vs ${small.liftSpool.toFixed(2)}`);
  // A turbo changes the engine's own voice: the turbine muffles the top.
  ok(small.shelf < -4, 'the turbine muffles the exhaust when the turbo is on',
     `shelf ${small.shelf.toFixed(1)} dB`);

  // The layer's own tone stage. The turbo is the only voice that lives in the
  // 2-6 kHz band the whole synth is otherwise measured for staying out of (see
  // the harshness suite), so it carries its own air cut. Transparent where the
  // fundamental now sits, progressively down above it.
  {
    const { biquad } = await import('./spectrum.mjs');
    const lp = biquad('lowpass', 4600, -3.01);
    const sh = biquad('highshelf', 2600, 0, -5.5);
    const at = (f) => 20 * Math.log10(lp(f) * sh(f));
    ok(at(1500) > -1.0, 'the turbo tone stage leaves the whistle body alone',
       `${at(1500).toFixed(1)} dB at 1.5 kHz`);
    ok(at(4000) < -5 && at(8000) < -12, 'the turbo tone stage takes the top off',
       `${at(4000).toFixed(1)} dB at 4 k, ${at(8000).toFixed(1)} dB at 8 k`);
  }
  ok(big.bov > 0 && small.bov > 0, 'the blow-off valve still fires on both',
     `${big.bov} / ${small.bov} events`);

  // Never on a closed throttle that was never boosted: an off-boost lift must
  // be silent, or every gentle coast would chatter.
  const mk = createMockContext();
  installGlobals(mk.ctx);
  const sim = new EngineSim(mk.ctx, { engine: 'i6', vehicle: 'sports', turbo: true });
  sim.start();
  let idleSurge = 0;
  for (let i = 0; i < 60 * 6; i++) {
    sim.setThrottle(i % 120 < 60 ? 0.12 : 0);   // never enough to build boost
    mk.advance(1 / 60);
    sim.update(1 / 60);
    idleSurge = Math.max(idleSurge, sim.turbo.surgeBodyLvl.gain.value);
  }
  ok(idleSurge < 0.02, 'an off-boost lift does not flutter',
     `peak ${idleSurge.toFixed(4)}`);

  // THE FLUTTER MUST END, NOT STOP. An automatic upshift with the pedal held
  // arms the surge on the ignition cut, then reopens the throttle when the
  // shift completes. Reopening used to multiply the surge by 0.25 per frame,
  // which cut the "stu-stu" dead mid-burst on every autoshift in the game.
  {
    const mk = createMockContext();
    installGlobals(mk.ctx);
    const T = new layers.TurboLayer(mk.ctx, { ...ENGINE_PROFILES.i6, turbo: { ...DEFAULT_TURBO, enabled: 1 } });
    const p = { now: 0, dt: 1 / 60, load: 1, throttle: 1, rpm: 5800, rpmNorm: 0.85, shifting: false, evBov: 0 };
    const step = () => { mk.advance(1 / 60); p.now = mk.ctx.currentTime; T.update(p); };
    for (let i = 0; i < 240; i++) step();                       // spool up
    p.shifting = true; p.load = 0;
    for (let i = 0; i < 9; i++) step();                         // 150 ms ignition cut
    const armed = T._surge;
    p.shifting = false; p.load = 1;
    let worst = 1, prev = T._surge, frames = 0;
    for (let i = 0; i < 60; i++) {
      step();
      if (prev > 0.01) { worst = Math.min(worst, T._surge / prev); frames++; }
      prev = T._surge;
    }
    ok(armed > 0.15, 'an upshift with the pedal held arms the flutter', `surge ${armed.toFixed(2)}`);
    // > 0.7: a fade (the old cut was 0.23 per frame), now with a quicker decay.
    ok(worst > 0.7 && frames >= 8, 'the flutter fades out after the shift instead of cutting',
       `worst frame-to-frame ${worst.toFixed(2)}, audible for ${frames} frames`);
  }

  // Pitch: the "stu" lives up where air does. At 700-1900 Hz it read as a
  // motorboat. The chirp rides on top, per burst.
  {
    const mk = createMockContext();
    installGlobals(mk.ctx);
    const T = new layers.TurboLayer(mk.ctx, { ...ENGINE_PROFILES.i6, turbo: { ...DEFAULT_TURBO, enabled: 1 } });
    ok(T.surgeBody.frequency.value >= 2400 && T.surgeEdge.frequency.value >= 4500,
       'the flutter sits high enough to read as air',
       `body ${T.surgeBody.frequency.value} Hz, edge ${T.surgeEdge.frequency.value} Hz`);
  }

  // No two lifts the same: the burst rate depends on revs and boost at the
  // lift, plus a scatter. And a high whistle climbs with the shaft.
  {
    const mk = createMockContext();
    installGlobals(mk.ctx);
    const T = new layers.TurboLayer(mk.ctx, { ...ENGINE_PROFILES.i6, turbo: { ...DEFAULT_TURBO, enabled: 1, valve: 0 } });
    const p = { now: 0, dt: 1 / 60, load: 1, throttle: 1, rpm: 6000, rpmNorm: 0.9, shifting: false, evBov: 0 };
    const step = (n) => { for (let i = 0; i < n; i++) { mk.advance(1 / 60); p.now = mk.ctx.currentTime; T.update(p); } };
    const lift = (rpmNorm) => {
      p.rpmNorm = rpmNorm; p.rpm = 800 + 6200 * rpmNorm; p.load = 1; p.throttle = 1; step(240);
      p.throttle = 0; p.load = 0; step(2);
      const rate = T._liftRate; step(60); return rate;
    };
    const hiFull = (p.rpmNorm = 0.9, step(240), T.hiOsc.frequency.value);
    const rates = [lift(0.9), lift(0.9), lift(0.6)];
    ok(Math.abs(rates[0] - rates[1]) > 0.1 && rates[2] < Math.min(rates[0], rates[1]),
       'each lift flutters differently, and slower from lower revs',
       rates.map(r => r.toFixed(1)).join(' / ') + ' Hz');
    ok(hiFull > 9000, 'a high whistle climbs with the shaft', `${hiFull.toFixed(0)} Hz spooled`);
    p.rpmNorm = 0.9; p.rpm = 6000; p.load = 1; p.throttle = 1; step(240);
    p.throttle = 0; p.load = 0;
    let gone = 0;
    for (let i = 0; i < 90 && !gone; i++) { step(1); if (i > 3 && T._surge < 0.1) gone = (i + 1) / 60; }
    ok(gone > 0 && gone < 0.65, 'the flutter is over quickly after a lift', `below 0.1 after ${gone.toFixed(2)} s`);
    p.rpmNorm = 0.9; p.rpm = 6000; p.load = 1; p.throttle = 1; step(240);
    p.throttle = 0; p.load = 0; step(6);
    ok(T.hiSurgeLvl.gain.value > 3 * T.hiGain.gain.value, 'the high whistle rides the flutter, prominently',
       `in flutter ${T.hiSurgeLvl.gain.value.toFixed(3)} vs steady ${T.hiGain.gain.value.toFixed(3)}`);
  }

  // The on-boost phase (wastegate rush, buzz-saw) is easy to reach: a pull
  // at high revs gets there, not only a flat-out one at the very top.
  {
    const mk = createMockContext();
    installGlobals(mk.ctx);
    const T = new layers.TurboLayer(mk.ctx, { ...ENGINE_PROFILES.i6, turbo: { ...DEFAULT_TURBO, enabled: 1 } });
    const p = { now: 0, dt: 1 / 60, load: 0.85, throttle: 0.85, rpm: 5200, rpmNorm: (5200 - 800) / 6200, shifting: false, evBov: 0 };
    for (let i = 0; i < 180; i++) { mk.advance(1 / 60); p.now = mk.ctx.currentTime; T.update(p); }
    ok(T.wgLevel.gain.value > 0.06 && T.buzzGain.gain.value > 0.02, 'the wastegate and buzz-saw come in on an ordinary hard pull',
       `wastegate ${T.wgLevel.gain.value.toFixed(3)}, buzz ${T.buzzGain.gain.value.toFixed(3)} at 5200 rpm, 0.85 throttle`);
  }

  // Boost comes in above 3500 rpm, not before.
  {
    const mk = createMockContext();
    installGlobals(mk.ctx);
    const T = new layers.TurboLayer(mk.ctx, { ...ENGINE_PROFILES.i6, turbo: { ...DEFAULT_TURBO, enabled: 1 } });
    const spoolAt = (rpm) => { const p = { now: 0, dt: 1 / 60, load: 1, throttle: 1, rpm, rpmNorm: (rpm - 800) / 6200, shifting: false, evBov: 0 };
      for (let i = 0; i < 300; i++) { mk.advance(1 / 60); p.now = mk.ctx.currentTime; T.update(p); } return T.boost; };
    const lo = spoolAt(3000), hi = spoolAt(5500);
    ok(lo < 0.05 && hi > 0.4, 'the turbo kicks in above 3500 rpm', `boost ${lo.toFixed(2)} at 3000, ${hi.toFixed(2)} at 5500`);
  }

  // THE LIMITER IS NOT A LIFT. Fuel cut with the plate open: no flutter, no
  // blow-off valve, however long the car sits on it.
  {
    const mk = createMockContext();
    installGlobals(mk.ctx);
    const sim = new EngineSim(mk.ctx, { engine: 'i6', vehicle: 'sports', turbo: true });
    await sim.start();
    sim.setGear(0);
    let surge = 0, bov = 0, onLimiter = 0;
    for (let i = 0; i < 60 * 5; i++) {
      sim.setThrottle(1); mk.advance(1 / 60); sim.update(1 / 60);
      if (i < 120) continue;
      if (sim.physics.limiterActive) onLimiter++;
      surge = Math.max(surge, sim.turbo._surge);
      if (sim._lastParams.evBov > 0) bov++;
    }
    ok(onLimiter > 30 && surge < 0.02 && bov === 0, 'sitting on the rev limiter neither flutters nor dumps',
       `limiter ${onLimiter} frames, surge ${surge.toFixed(3)}, ${bov} BOV events`);
  }

  // THE TOGGLE. Any engine, while running, without rebuilding the engine note,
  // and it survives an engine swap.
  {
    const mk = createMockContext();
    installGlobals(mk.ctx);
    const sim = new EngineSim(mk.ctx, { engine: 'v8cross', vehicle: 'sports' });
    await sim.start();
    const oscs = sim.oscs;
    const drive = (n) => { for (let i = 0; i < n; i++) { sim.setThrottle(1); mk.advance(1 / 60); sim.update(1 / 60); } };
    drive(60);
    ok(!sim.turbo && sim.getState().turbo === false, 'the turbo is off by default');
    sim.setTurbo(true);
    drive(180);
    ok(sim.turbo && sim.getState().turbo && sim.getState().boost > 0.05,
       'setTurbo(true) bolts one onto a running engine', `boost ${sim.getState().boost.toFixed(2)}`);
    ok(sim.oscs === oscs, '...without rebuilding the engine voices');
    sim.setEngineType('i4');
    ok(sim.turbo && sim.getState().turbo, 'the turbo survives an engine swap');
    const layer = sim.turbo;
    sim.setTurbo(false);
    drive(10);
    ok(!sim.turbo && layer.out.gain.value < 0.5 && sim.getState().boost === 0,
       'setTurbo(false) fades the layer out and drops the boost',
       `layer gain ${layer.out.gain.value.toFixed(2)}`);
    ok(sim.setParam('turbo.enabled', 1) === 1 && sim.turbo, 'the toggle is a preset parameter too');
    const a = mk.audit(mk.ctx.destination);
    ok(a.unstarted.length === 0, 'a turbo added while running is started',
       a.unstarted.join(',') || `${a.sources} sources`);
  }
});

await suite('tip-in bark — throttle has an edge', async () => {
  const { EngineSim } = await import('../src/engine-sim.js');
  const mk = createMockContext();
  installGlobals(mk.ctx);
  // A throttle stab kicks the combustion voice, easing in does not, and it
  // settles once the load is held.
  const sim = new EngineSim(mk.ctx, { engine: 'v8cross', vehicle: 'sports' });
  await sim.start();
  const run = (thr, n) => { let peak = 0; for (let i = 0; i < n; i++) {
    sim.setThrottle(thr(i)); mk.advance(1 / 60); sim.update(1 / 60); peak = Math.max(peak, sim._bark);
  } return peak; };
  run(() => 0, 120);
  const stab = run(() => 1, 15);
  run(() => 1, 60);
  const held = sim._bark;
  run(() => 0, 120);
  const ease = run((i) => i / 120, 120);
  ok(stab > 0.5 && ease < 0.15 && held < 0.05, 'a throttle stab barks; easing in and holding do not',
     `stab ${stab.toFixed(2)}, ease ${ease.toFixed(2)}, held ${held.toFixed(3)}`);
});

await suite('growl — the crank speeds up and slows down with every firing', async () => {
  // Run the real combustion processor outside a browser: stub the worklet
  // globals, capture the class, and time its firings.
  let Proc;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = {}; } };
  globalThis.registerProcessor = (_, C) => { Proc = C; };
  globalThis.sampleRate = 48000;
  await import('../src/combustion-worklet.js?growl');
  const { combustionSpec, crankRipple } = await import('../src/pulse.js');

  /** Run the processor for 2 s; return the crank-speed swing (max − min). */
  const swing = (id, rpm, load) => {
    const prof = ENGINE_PROFILES[id];
    const proc = new Proc({ processorOptions: combustionSpec(prof, bankAngles) });
    const outs = Array.from({ length: proc.nOut }, () => [new Float32Array(128)]);
    const params = { f0: [rpm / 120], load: [load], amp: [1], rough: [0],
      ripple: [crankRipple(prof, rpm, load)],
      low: [1 - (rpm - prof.idleRpm) / (prof.redlineRpm - prof.idleRpm)] };
    let lo = 0, hi = 0;
    for (let b = 0; b < 48000 * 2 / 128; b++) {
      proc.process([], outs, params);
      if (b > 40) { lo = Math.min(lo, proc.v); hi = Math.max(hi, proc.v); }
    }
    return hi - lo;
  };
  const v8 = ENGINE_PROFILES.v8cross;
  ok(crankRipple(v8, 800, 0.2) > 20 * crankRipple(v8, 6000, 0.2),
     'crank ripple falls with rpm squared',
     `${(crankRipple(v8, 800, 0.2) * 100).toFixed(2)} % at 800, ${(crankRipple(v8, 6000, 0.2) * 100).toFixed(3)} % at 6000`);
  ok(crankRipple(ENGINE_PROFILES.vtwin, 1200, 0.2) > 2 * crankRipple(ENGINE_PROFILES.v12, 1200, 0.2),
     'a light twin swings far more than a V12', '');
  // The worklet itself: the crank's speed swings within every firing at idle
  // (frequency modulation of every pulse — the growl) and runs smooth up high.
  const idle = swing('v8cross', 800, 0.3), high = swing('v8cross', 6000, 0.3);
  ok(idle > 0.03 && high < idle / 20, 'the crank speed swings at idle and smooths out as it revs',
     `${(idle * 100).toFixed(1)} % at 800 rpm, ${(high * 100).toFixed(2)} % at 6000`);
});

await suite('harshness — no screaming resonance at any rpm', async () => {
  // The comb peaks of a feedback waveguide sit at multiples of 1/T and an
  // engine's harmonics at multiples of f0. Where those two series coincide, one
  // harmonic lands on a comb peak while its neighbours fall in the troughs —
  // and if the pipe is still ringing in its 20th mode, that is a 20 dB spike at
  // 2 kHz that appears at one rpm and vanishes at the next. The V12 at 8000 rpm
  // once put 71 % of all radiated power into 2-6 kHz this way.
  //
  // spectrum.mjs computes the chain's magnitude response analytically, so this
  // is a real measurement rather than a smoke test.
  const { harshness } = await import('./spectrum.mjs');
  const LIMIT = 0.04;          // 4 % of radiated power in 2-6 kHz
  for (const [id, p] of Object.entries(ENGINE_PROFILES)) {
    let worst = 0, wRpm = 0, wF = 0;
    for (let rpm = 1200; rpm <= p.redlineRpm; rpm += 400) {
      for (const load of [0.35, 0.7, 1.0]) {
        const h = harshness(p, rpm, load);
        if (h.share > worst) { worst = h.share; wRpm = rpm; wF = h.peakF; }
      }
    }
    ok(worst < LIMIT, `${id}: 2-6 kHz share stays under ${LIMIT * 100}%`,
       `${(worst * 100).toFixed(2)}% at ${wRpm} rpm (${wF.toFixed(0)} Hz)`);
  }
  // The rpm-LOCAL resonance (#31's second coming): swept in 50 rpm steps, no
  // harmonic above 700 Hz may jump far above its own neighbourhood unless it
  // is too quiet to matter. "far" = 15 dB; "quiet" = 22 dB under the loudest.
  const { spikes } = await import('./spectrum.mjs');
  for (const [id, p] of Object.entries(ENGINE_PROFILES)) {
    const s = spikes(p, 1, 50);
    ok(s.db < 15 || (s.rel ?? -99) < -22, `${id}: no audible rpm-local resonance spike`,
       `${s.db.toFixed(1)} dB at ${s.rpm} rpm, ${s.f.toFixed(0)} Hz, ${(s.rel ?? 0).toFixed(1)} dB vs loudest`);
  }
});

await suite('live inputs — strain, valve, roughness, distance, enclosure', async () => {
  const { EngineSim, INPUT_SCHEMA } = await import('../src/engine-sim.js');
  const mk = createMockContext();
  installGlobals(mk.ctx);
  const sim = new EngineSim(mk.ctx, { engine: 'v8cross', vehicle: 'sports' });
  await sim.start();
  ok(EngineSim.inputs() === INPUT_SCHEMA && INPUT_SCHEMA.length >= 5, 'input table is exposed statically',
     INPUT_SCHEMA.map(r => r.id).join(','));
  ok(sim.setInput('nonsense', 1) === null, 'an unknown input is refused');
  ok(sim.setInput('distance', 7) === 1 && sim.setInput('distance', -3) === 0, 'inputs clamp to 0..1');
  for (const r of INPUT_SCHEMA) sim.setInput(r.id, 1);
  sim.setThrottle(1);
  let misfires = 0;
  for (let i = 0; i < 600; i++) { sim.update(1 / 60); mk.advance && mk.advance(1 / 60); misfires += sim.getEvents().misfire ? 1 : 0; }
  ok(sim.getState().inputs.roughness === 1, 'state reports the live inputs');
  ok(misfires > 0, 'full roughness produces misfires', `${misfires} in 10 s`);
  ok(sim.air.frequency.value < 4000, 'full distance closes the air-absorption lowpass', `${sim.air.frequency.value.toFixed(0)} Hz`);
  const preset = sim.getPreset();
  ok(!('inputs' in preset) && preset.fx.reverbMix === sim.reverb.getState().mix,
     'live inputs never leak into the saved preset');
  sim.dispose();
});

await suite('presets — the schema is the source of truth, and has no orphans', async () => {
  const { EngineSim, DEFAULT_MIX } = await import('../src/engine-sim.js');
  const { PRESET_SCHEMA, PRESET_GROUPS, builtinPresets, builtinPreset,
          normalisePreset, presetToJSON, presetFromJSON, getPath } =
    await import('../src/presets.js');
  const { readFileSync, readdirSync } = await import('node:fs');

  const presets = builtinPresets();
  ok(Object.keys(presets).length === Object.keys(ENGINE_PROFILES).length,
     'every engine has a preset', `${Object.keys(presets).length} presets`);

  // --- every schema row resolves, on every engine -------------------------
  let missing = [];
  for (const [id, pr] of Object.entries(presets)) {
    for (const row of PRESET_SCHEMA) {
      const v = getPath(pr, row.path);
      if (typeof v !== 'number' || !isFinite(v) || v < row.min || v > row.max) {
        missing.push(`${id}:${row.path}=${v}`);
      }
    }
  }
  ok(missing.length === 0, 'every schema parameter is present and in range',
     missing.slice(0, 4).join(' ') || `${PRESET_SCHEMA.length} rows x ${Object.keys(presets).length} engines`);

  const groups = new Set(PRESET_GROUPS.map(g => g.id));
  ok(PRESET_SCHEMA.every(r => groups.has(r.group)),
     'every schema row belongs to a declared group', [...groups].join(','));

  // --- ORPHAN CHECK A: a profile field the schema does not expose ---------
  //
  // The direction that actually bit. `voice` and `pulse.hardness` were in all
  // sixteen profiles, read by nothing, for as long as the profiles existed —
  // and nothing could see it, because an unused number is not a failure of any
  // other kind of test.
  const ARCHITECTURE = new Set([
    'label', 'cylinders', 'firingOrder', 'banks', 'pinOffsets',
    'exhaust.bankB',       // optional, and only on engines with unequal headers
  ]);
  const paths = new Set(PRESET_SCHEMA.map(r => r.path));
  const unexposed = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? prefix + '.' + k : k;
      if (ARCHITECTURE.has(path)) continue;
      if (Array.isArray(v)) {
        v.forEach((_, i) => { if (!paths.has(`engine.${path}.${i}`)) unexposed.push(path + '.' + i); });
      } else if (v && typeof v === 'object') {
        walk(v, path);
      } else if (typeof v === 'number' && !paths.has('engine.' + path)) {
        unexposed.push(path);
      }
    }
  };
  for (const p of Object.values(ENGINE_PROFILES)) walk(p, '');
  ok(unexposed.length === 0, 'no profile field is missing from the schema',
     [...new Set(unexposed)].join(', ') || 'all exposed');

  // --- ORPHAN CHECK B: a parameter nothing downstream reads ---------------
  //
  // The other direction: a slider that moves and changes nothing. A leaf name
  // has to appear somewhere in src/ other than the two files that DEFINE the
  // data, or it is decoration.
  const srcDir = new URL('../src/', import.meta.url);
  const sources = readdirSync(srcDir)
    .filter(f => f.endsWith('.js') && f !== 'presets.js' && f !== 'profiles.js')
    .map(f => readFileSync(new URL(f, srcDir), 'utf8'))
    .join('\n');
  const unread = PRESET_SCHEMA
    .map(r => r.path.split('.').pop())
    .filter(leaf => !/^\d+$/.test(leaf))
    .filter(leaf => !new RegExp('\\b' + leaf + '\\b').test(sources));
  ok(unread.length === 0, 'no schema parameter is read by nothing',
     [...new Set(unread)].join(', ') || 'all read');

  // --- round trip ---------------------------------------------------------
  const rt = presetFromJSON(presetToJSON(presets.v8cross));
  ok(!rt.error && JSON.stringify(rt.preset) === JSON.stringify(presets.v8cross),
     'a preset survives a JSON round trip', rt.error || 'identical');

  // Hostile input must come back usable, not throw and not poison the graph.
  const junk = normalisePreset({ id: 'v8cross', engine: { pulse: { attack: 'x' },
    exhaust: { muffler: 'nope', bank: -50 }, firingOrder: [1, 1, 1, 1] },
    eq: 'no', mix: { exhaust: NaN }, volume: 99 });
  ok(isFinite(junk.engine.pulse.attack) && Array.isArray(junk.engine.exhaust.muffler)
     && junk.engine.exhaust.muffler.length === 3 && junk.eq.length === 5
     && isFinite(junk.mix.exhaust) && junk.volume <= 1
     && new Set(junk.engine.firingOrder).size === junk.engine.cylinders,
     'a corrupt preset is repaired rather than trusted',
     `attack ${junk.engine.pulse.attack}, bank ${junk.engine.exhaust.bank}, vol ${junk.volume}`);

  // --- the sim actually applies them --------------------------------------
  const mk = createMockContext();
  installGlobals(mk.ctx);
  const sim = new EngineSim(mk.ctx, { engine: 'v8cross', vehicle: 'sports' });
  await sim.start();

  // Every schema row must round-trip through the live sim. A row that does not
  // is a control that moves and changes nothing.
  const dead = [];
  for (const row of PRESET_SCHEMA) {
    const cur = sim.getParam(row.path);
    // Somewhere else in range, quantised to the row's own step.
    let want = cur > (row.min + row.max) / 2 ? row.min + row.step : row.max - row.step;
    const got = sim.setParam(row.path, want);
    if (got === null || Math.abs(sim.getParam(row.path) - got) > 1e-6) dead.push(row.path);
    sim.setParam(row.path, cur);
  }
  ok(dead.length === 0, 'every schema parameter round-trips through the sim',
     dead.join(', ') || `${PRESET_SCHEMA.length} parameters`);

  // A version-2 file kept the turbo inside the engine. It must still load,
  // with its turbo switched on and its tuning kept.
  const legacy = normalisePreset({ id: 'v8cross', engine: { ...ENGINE_PROFILES.v8cross,
    turbo: { inertia: 0.3, maxBoost: 1.4, whineOrder: 60, bov: 0.2, surge: 1.2 } } });
  ok(legacy.turbo.enabled === 1 && legacy.turbo.bov === 0.2 && !('turbo' in legacy.engine),
     'a version-2 preset with a turbo loads with it switched on',
     `enabled ${legacy.turbo.enabled}, bov ${legacy.turbo.bov}`);
  ok(sim.setParam('engine.nonsense', 1) === null, 'an unknown path is refused');

  // Loading a preset brings the whole sound, not just the engine.
  sim.setMix({ intake: 0.1 });
  sim.setEQBand(0, 12);
  ok(sim.loadPreset('i6diesel'), 'loadPreset accepts a built-in id');
  const after = sim.getPreset();
  ok(after.id === 'i6diesel'
     && Math.abs(after.mix.intake - DEFAULT_MIX.intake) < 1e-6 && after.eq[0] === 0,
     'a preset carries mix and EQ, not only the engine',
     `intake ${after.mix.intake}, eq0 ${after.eq[0]}`);

  // A hand-edited file loads and is audible.
  const edited = builtinPreset('v8cross');
  edited.id = 'my-sound'; edited.label = 'Hand edited';
  edited.engine.exhaust.bank = 2.2;
  edited.mix.exhaust = 1.4;
  ok(sim.loadPreset(JSON.stringify(edited)), 'loadPreset accepts a JSON string');
  const back = sim.getPreset();
  ok(back.id === 'my-sound' && Math.abs(back.engine.exhaust.bank - 2.2) < 1e-6
     && Math.abs(back.mix.exhaust - 1.4) < 1e-6,
     'a custom preset keeps its own identity and values',
     `${back.id}: bank ${back.engine.exhaust.bank}, exhaust ${back.mix.exhaust}`);
});

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m  ` +
            `${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
