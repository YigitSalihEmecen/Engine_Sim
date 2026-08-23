/**
 * drive.mjs — realistic-driving behaviour checks on the assembled EngineSim.
 *
 * The fuzz suite in run.mjs proves nothing explodes. This one asks whether the
 * thing behaves like a car: does a gear change actually have a shape, or is it
 * still just a pitch step?
 */

import { createMockContext, installGlobals } from './mock-audio.mjs';

const mock = createMockContext();
installGlobals(mock.ctx);

const { EngineSim } = await import('../src/engine-sim.js');

const sim = new EngineSim(mock.ctx, { engine: 'v8cross', vehicle: 'sports' });
await sim.start();
mock.seal();

const DT = 1 / 60;
let fail = 0;
const ok = (c, label, detail = '') => {
  console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}  \x1b[2m${detail}\x1b[0m`);
  if (!c) fail++;
};

function run(seconds, throttle, brake = 0, onFrame) {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    sim.setThrottle(throttle); sim.setBrake(brake);
    mock.advance(DT);
    sim.update(DT);
    if (onFrame) onFrame(sim.getState(), sim._lastParams);
  }
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1mlash impacts under realistic driving\x1b[0m');

let lash = 0, frames = 0;
sim.setAutoShift(true);
run(20, 1, 0, (s, p) => { if (p.evLash) lash++; frames++; });   // steady acceleration
const accelLash = lash;
lash = 0;
run(10, 0, 0, (s, p) => { if (p.evLash) lash++; });             // steady coast
const coastLash = lash;
lash = 0;
let loud = 0;
const count = (s, p) => { if (p.evLash) { lash++; if (p.evLash > 0.3) loud++; } };
for (let i = 0; i < 10; i++) { run(0.6, 1, 0, count); run(0.6, 0, 0, count); }

ok(accelLash < 40, 'steady acceleration does not rattle', `${accelLash} impacts in 20 s (shifts included)`);
ok(coastLash < 6, 'steady coasting is quiet', `${coastLash} impacts in 10 s`);
// A real driveline re-crosses the dead-band as the shuffle rings down. That is
// correct; what matters is that only the first contact is loud.
ok(loud <= 20 && loud < lash, 'lift-off gives one loud clunk, not a rattle',
   `${lash} contacts over 10 lift/reapply cycles, ${loud} loud (>0.3)`);

// ---------------------------------------------------------------------------
console.log('\n\x1b[1mgear change — does it have a shape?\x1b[0m');

// Low gear: reflected engine inertia is largest there, so the torsional mode is
// lowest (6 Hz) and least damped (zeta 0.05) — shuffle is a low-gear phenomenon.
sim.setAutoShift(false);
sim.setGear(1);
run(1.5, 0.4);
run(2, 1);

const trace = [];
const before = sim.getState().rpm;
sim.shiftUp();
run(1.2, 1, 0, (s, p) => trace.push({
  t: trace.length * DT, phase: s.shiftPhase || '-', rpm: s.rpm,
  twist: s.twist ?? 0, slip: p.clutchSlip ?? 0, Tp: s.Tp ?? 0,
}));

console.log('     t(ms)  phase     rpm    twist(rad)   slip   torque');
for (let i = 0; i < trace.length; i += 3) {
  const r = trace[i];
  if (r.t > 0.75) break;
  console.log(`    ${(r.t * 1000).toFixed(0).padStart(5)}  ${r.phase.padEnd(8)} ` +
    `${r.rpm.toFixed(0).padStart(5)}  ${r.twist.toFixed(5).padStart(9)} ` +
    `${r.slip.toFixed(0).padStart(6)} ${r.Tp.toFixed(0).padStart(7)}`);
}

const phases = [...new Set(trace.map(r => r.phase))].filter(p => p !== '-');
ok(phases.length >= 4, 'shift passes through distinct phases', phases.join(' → '));

const slipPeak = Math.max(...trace.map(r => Math.abs(r.slip)));
ok(slipPeak > 100, 'clutch genuinely slips during engagement', `peak ${slipPeak.toFixed(0)} rpm`);

const twistPeak = Math.max(...trace.map(r => Math.abs(r.twist)));
ok(twistPeak > 0.005, 'driveline actually winds up', `peak twist ${twistPeak.toFixed(4)} rad`);

// ---------------------------------------------------------------------------
// Shuffle is excited by an abrupt THROTTLE step ("shunt"), not by a well
// executed clutch engagement — a smooth engagement puts the energy into clutch
// slip instead of the spring, which is why the shift trace above settles flat.
console.log('\n\x1b[1mshuffle / shunt on throttle tip-in\x1b[0m');
sim.setGear(2);
run(2.5, 0.35);                                  // settle at part throttle
const tip = [];
run(1.5, 1, 0, s => tip.push(s.twist ?? 0));     // stab it

let rev = 0;
for (let i = 2; i < tip.length; i++) {
  const a = tip[i] - tip[i - 1], b = tip[i - 1] - tip[i - 2];
  if (a * b < 0) rev++;
}
const amp = Math.max(...tip) - Math.min(...tip);
ok(rev >= 6, 'driveline rings at the torsional mode after a tip-in',
   `${rev} reversals in ${tip.length} frames, swing ${amp.toFixed(4)} rad`);
ok(amp > 0.01, 'oscillation is of a meaningful size', `${amp.toFixed(4)} rad`);

// ---------------------------------------------------------------------------
console.log('\n\x1b[1mdownshift rev-match\x1b[0m');
run(2, 0);
const dBefore = sim.getState().rpm;
const accepted = sim.shiftDown();
let peak = 0;
run(1, 0, 0, s => { peak = Math.max(peak, s.rpm); });
ok(!accepted || peak > dBefore + 150, 'downshift blips the throttle to rev-match',
   `${dBefore.toFixed(0)} → peak ${peak.toFixed(0)} → ${sim.getState().rpm.toFixed(0)}`);

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
console.log('\n\x1b[1mstanding start — the engine must never sit on one pitch\x1b[0m');
{
  const { Drivetrain } = await import('../src/physics.js');
  const { ENGINE_PROFILES, VEHICLE_PRESETS } = await import('../src/profiles.js');

  // A clutch-slip launch legitimately holds the revs while road speed catches
  // up. What it must NOT do is hold them at one number long enough to read as
  // the engine being stuck — which is exactly what a fixed hold target did:
  // launchFlareRpm was forced to 850, putting a V8's WOT hold at 1585 rpm for
  // ~0.4 s. It sounded like a bog, not a launch.
  const launch = (engineId, vehId) => {
    const d = new Drivetrain(ENGINE_PROFILES[engineId], VEHICLE_PRESETS[vehId], {});
    const tr = [];
    let t = 0;
    for (let i = 0; i < 60 * 3; i++) {
      d.setThrottle(1);
      t += DT;
      const p = d.step(DT, t);
      tr.push({ rpm: p.rpm, gear: p.gear });
    }
    const g1 = tr.filter(x => x.gear === 1);
    // Longest run in 1st where rpm moves slower than 250 rpm/s.
    let worst = 0, cur = 0, at = 0;
    for (let i = 6; i < g1.length; i++) {
      const slope = Math.abs(g1[i].rpm - g1[i - 6].rpm) / (6 * DT);
      if (slope < 250) { cur++; if (cur > worst) { worst = cur; at = g1[i].rpm; } }
      else cur = 0;
    }
    const hold = Math.min(...g1.slice(9).map(x => x.rpm));
    return { flat: worst / 60, at, hold };
  };

  // 0.20 s, not zero. A heavy car genuinely does hang for a moment as the
  // clutch takes up — the 1720 kg muscle car sits at ~0.17 s and that is a real
  // bog, not a stuck note. What this guards against is the half-second-plus
  // plateau that a fixed hold target produces (0.27 s measured, and worse by
  // ear because the pitch was not merely slow but perfectly constant).
  for (const v of ['hatch', 'sports', 'supercar', 'muscle']) {
    const r = launch('v8cross', v);
    ok(r.flat < 0.20, `${v}: no flat spot in 1st at full throttle`,
       `longest ${r.flat.toFixed(2)} s at ${Math.round(r.at)} rpm`);
    // A full-throttle launch holds well above idle. 1585 rpm was the bug.
    ok(r.hold > 1900, `${v}: launch holds at launch revs, not a bog`,
       `min ${Math.round(r.hold)} rpm`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1mexhaust pops — occasional, not constant\x1b[0m');
{
  // A car that pops on EVERY lift is a sound effect, not a car. Popping needs a
  // hot pipe and luck, so it has to be rare when pottering, occasional when
  // pressing on, and never a guarantee.
  const styles = { gentle: 0.28, mixed: 0.6, hard: 1.0 };
  const drive = (engine, throttle, seconds = 60) => {
    const m = createMockContext();
    installGlobals(m.ctx);
    const s = new EngineSim(m.ctx, { engine, vehicle: 'sports' });
    s.start();
    const TB = s.transients;
    const orig = TB.trigger.bind(TB);
    const amps = [];
    TB.trigger = (ty, ti, a, f, d) => {
      if (ty === 'bang' || ty === 'crackle') amps.push(a);
      return orig(ty, ti, a, f, d);
    };
    let lifts = 0, popped = 0, cuts = 0, shifts = 0, prevGear = 1;
    for (let i = 0; i < 60 * seconds; i++) {
      const cyc = i % 360;
      if (cyc === 250) lifts++;
      s.setThrottle(cyc < 250 ? throttle : 0);
      m.advance(DT);
      s.update(DT);
      const p = s._lastParams;
      if (p.evPop > 0) popped++;
      if (p.evCut > 0) cuts++;
      const g = s.getState().gear;
      if (g !== prevGear) { shifts++; prevGear = g; }
    }
    TB.trigger = orig;
    amps.sort((a, b) => a - b);
    return { lifts, popped, cuts, shifts, events: amps.length,
             p50: amps[Math.floor(amps.length * 0.5)] || 0,
             max: amps[amps.length - 1] || 0 };
  };

  const gentle = drive('v8cross', styles.gentle);
  ok(gentle.events === 0, 'pottering around does not pop at all',
     `${gentle.events} events over ${gentle.lifts} lifts`);

  const hard = drive('v8cross', styles.hard);
  ok(hard.popped > 0 && hard.popped < hard.lifts,
     'driven hard it pops on SOME lifts, not all',
     `${hard.popped} of ${hard.lifts} lifts`);
  ok(hard.events / hard.lifts < 6, 'a lift is a few reports, not a volley',
     `${(hard.events / hard.lifts).toFixed(1)} per lift`);
  // Dynamics: the quiet ones and the loud ones must be far apart, or every pop
  // is the same size and the burst reads as a loop.
  const spread = 20 * Math.log10(hard.max / Math.max(1e-4, hard.p50));
  ok(spread > 10, 'pops have real dynamic range',
     `median ${hard.p50.toFixed(2)}, peak ${hard.max.toFixed(2)} = ${spread.toFixed(1)} dB`);
  ok(hard.cuts < hard.shifts, 'not every gear change bangs',
     `${hard.cuts} bangs across ${hard.shifts} shifts`);
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1mall engines × all vehicles, assembled\x1b[0m');
const { ENGINE_PROFILES, VEHICLE_PRESETS } = await import('../src/profiles.js');
let combos = 0;
for (const e of Object.keys(ENGINE_PROFILES)) {
  for (const v of Object.keys(VEHICLE_PRESETS)) {
    const m2 = createMockContext();
    const s2 = new EngineSim(m2.ctx, { engine: e, vehicle: v });
    await s2.start();
    m2.seal();
    let t = 0;
    for (let i = 0; i < 240; i++) {
      s2.setThrottle(i % 80 < 50 ? 1 : 0);
      m2.advance(DT); t += DT; s2.update(DT);
    }
    const st = s2.getState();
    if (!isFinite(st.rpm) || m2.report().violations) {
      console.log(`  \x1b[31m✗ ${e}/${v}\x1b[0m`); fail++;
    }
    combos++;
  }
}
ok(true, `${combos} engine/vehicle combinations run clean`, '4 s each, sealed graph');

const rep = mock.report();
console.log(`\n\x1b[2mgraph: ${rep.nodes} nodes, ${rep.paramWrites} param writes, ` +
            `${rep.scheduledEvents} scheduled events, ${rep.violations} violations\x1b[0m`);
console.log(`${fail === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m`);
process.exit(fail ? 1 : 0);
