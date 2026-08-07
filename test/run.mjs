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
    add(layers.MechanicalLayer);
    add(layers.TransmissionLayer, VEHICLE_PRESETS.sports);
    if (profile.turbo) add(layers.TurboLayer);
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
  // node count is still stable. It cost an entire mechanical + gearbox layer.
  const { EngineSim } = await import('../src/engine-sim.js');
  for (const e of Object.keys(ENGINE_PROFILES)) {
    for (const v of ['sports', 'truck']) {
      const mk = createMockContext();
      installGlobals(mk.ctx);
      const sim = new EngineSim(mk.ctx, { engine: e, vehicle: v });
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

await suite('ambience — environment bed', async () => {
  const { Ambience } = await import('../src/ambience.js');
  const mk = createMockContext();
  installGlobals(mk.ctx);
  const a = new Ambience(mk.ctx, { rain: 0.9, wind: 0.7, road: 0.8 });
  a.start(0);
  a.output.connect(mk.ctx.destination);
  const built = mk.report().nodes;
  mk.seal();
  // Sweep standstill to well past any sane road speed, with rain on and off.
  for (let i = 0; i < 60 * 60; i++) {
    mk.advance(1 / 60);
    a.setRain(Math.abs(Math.sin(i / 700)));
    a.update({ now: mk.ctx.currentTime, speed: 90 * Math.abs(Math.sin(i / 500)) });
  }
  const rep = mk.report();
  ok(rep.violations === 0, 'no violations across 3600 frames',
     `${built} nodes, ${rep.paramWrites} writes`);
  ok(rep.nodes === built, 'no per-frame allocation', `${rep.nodes} vs ${built}`);
  const au = mk.audit(mk.ctx.destination);
  ok(au.unstarted.length === 0, 'every source started', `${au.sources} sources`);
  ok(au.orphaned.length === 0, 'every source reaches the output');
  ok(rep.scheduledEvents < 200, 'thunder does not run away', rep.scheduledEvents + ' events');
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

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m  ` +
            `${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
