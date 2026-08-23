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
console.log('\n\x1b[1mstanding start — the revs must rise at ONE continuous rate\x1b[0m');
{
  const { Drivetrain } = await import('../src/physics.js');
  const { ENGINE_PROFILES, VEHICLE_PRESETS } = await import('../src/profiles.js');

  // THIS TEST EXISTS BECAUSE THE PREVIOUS ONE PASSED WHILE THE BUG WAS PRESENT.
  //
  // The complaint was always "it jumps to N rpm and sticks there", and the
  // obvious thing to measure is a flat spot. That was the wrong quantity: the
  // fault is a DISCONTINUITY in the rate, not a plateau in the value. With the
  // clutch open a V8 flywheel accelerates at ~11 400 rpm/s; hanging a 1450 kg
  // car off it drops that to ~2 900. Cross between the two and the revs rocket
  // up and then appear to hit a wall — while still, technically, rising, so a
  // flat-spot test sails straight past it.
  //
  // So measure the rate profile and require it to hold together.
  const launch = (engineId, vehId) => {
    const d = new Drivetrain(ENGINE_PROFILES[engineId], VEHICLE_PRESETS[vehId], {});
    let t = 0;
    // Idle first: flooring it from a standstill is the reported case, and the
    // controller behaves differently if it has never been at rest.
    for (let i = 0; i < 60 * 2; i++) { d.setThrottle(0); t += DT; d.step(DT, t); }
    const tr = [];
    for (let i = 0; i < 60 * 3; i++) {
      d.setThrottle(1);
      t += DT;
      const p = d.step(DT, t);
      tr.push({ rpm: p.rpm, gear: p.gear, slip: p.clutchSlip });
    }
    // Only the launch itself: gear 1, up to the moment the clutch is home.
    const g1 = tr.filter(x => x.gear === 1);
    let lock = g1.findIndex(x => x.slip < 25);
    if (lock < 0) lock = g1.length;
    const win = g1.slice(0, lock);

    const rates = [];
    for (let i = 6; i < win.length; i += 3) {
      rates.push((win[i].rpm - win[i - 6].rpm) / (6 * DT));
    }
    // Ignore the first two samples: the engine is coming off the idle governor.
    const body = rates.slice(2);
    if (!body.length) return { ok: false };
    const sorted = [...body].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return {
      minRate: Math.min(...body),
      median,
      // How far the rate collapses relative to the rate it was running at.
      collapse: median > 0 ? Math.min(...body) / median : 0,
      rise: win[win.length - 1].rpm - win[0].rpm,
      lockS: lock / 60,
    };
  };

  for (const v of ['hatch', 'sports', 'supercar', 'muscle']) {
    const r = launch('v8cross', v);
    // The revs must never actually fall during the launch.
    ok(r.minRate > -200, `${v}: the revs never go backwards during the launch`,
       `min ${Math.round(r.minRate)} rpm/s`);
    // ...and the rate must not collapse relative to itself. 0.35 is generous —
    // the failing versions sat at 0.05-0.15 here.
    ok(r.collapse > 0.35, `${v}: the rate holds together — no wall`,
       `min/median ${r.collapse.toFixed(2)}, median ${Math.round(r.median)} rpm/s`);
    ok(r.rise > 1500 && r.lockS < 2.5, `${v}: the launch actually completes`,
       `+${Math.round(r.rise)} rpm, clutch home at ${r.lockS.toFixed(2)} s`);
  }

  // The wind-up rate is derived per car, so it has to differ across chassis by
  // roughly as much as their actual acceleration does.
  const rates = ['hatch', 'sports', 'muscle'].map(v =>
    new Drivetrain(ENGINE_PROFILES.v8cross, VEHICLE_PRESETS[v], {}).launchRate);
  ok(Math.max(...rates) / Math.min(...rates) > 1.3,
     'the launch wind-up rate is derived from the car, not fixed',
     rates.map(r => Math.round(r)).join(' / ') + ' rpm/s');
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
