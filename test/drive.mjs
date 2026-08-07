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
