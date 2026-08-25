/**
 * pulse.js — turns firing geometry into band-limited wavetables.
 *
 * Rather than stacking hand-tuned harmonic oscillators, we build the actual
 * 720° pressure cycle of each exhaust bank (a train of combustion pulses at the
 * crank angles where that bank's cylinders fire), differentiate it to get the
 * radiated pressure gradient, and hand the Fourier coefficients to
 * createPeriodicWave.
 *
 * Two things fall out of this for free:
 *
 *  1. Correct harmonic structure for ANY engine layout. A cross-plane V8 bank
 *     fires at 0/270/540/630° — uneven — so its spectrum contains half-orders
 *     and it burbles. A flat-plane bank fires every 180°, so it does not.
 *     Nobody tuned that; it is just where the cylinders are.
 *
 *  2. Perfect anti-aliasing at zero runtime cost. PeriodicWave is band-limited
 *     per playback frequency by the browser, so one OscillatorNode replaces a
 *     whole bank of partials and never aliases as rpm sweeps.
 */

const TABLE_SIZE = 8192;       // samples per 720° cycle used for analysis
const MAX_HARMONICS = 1024;    // = engine order 512, far beyond audibility

// ---------------------------------------------------------------------------
// Minimal iterative radix-2 FFT (in-place, complex)
// ---------------------------------------------------------------------------

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k],        ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;  im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;  im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Deterministic per-engine jitter so a given profile always sounds the same. */
function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Pulse shape
// ---------------------------------------------------------------------------

/**
 * Combustion pressure pulse: sharp rise as the exhaust valve cracks open and
 * the cylinder blows down, then a long decay over the exhaust stroke.
 *
 *   p(d) = (1 − e^(−a·d)) · e^(−b·d)
 *
 * @param d normalised phase since firing, in cycles (0..1 spans 720°)
 */
function pulseAt(d, a, b) {
  if (d < 0 || d > 1) return 0;
  return (1 - Math.exp(-a * d)) * Math.exp(-b * d);
}

/**
 * Build one bank's 720° pressure cycle.
 * @param {object} profile
 * @param {number[]} angles firing angles (deg) of the cylinders in this bank
 * @param {number} hard 0 = light load (soft, rounded), 1 = full load (sharp)
 * @param {number} phaseShift extra crank-angle offset in degrees (intake path)
 */
export function buildCycle(profile, angles, hard, phaseShift = 0) {
  const P = profile.pulse;
  // Under load the charge is denser and the blowdown more violent: faster
  // rise, and the pulse carries further before it decays.
  //
  // HOW MUCH it sharpens is `pulse.hardness`, normalised so that the middle of
  // the range profiles actually use (0.65) reproduces the fixed coefficients
  // this had before. A diesel at 0.88 gets a pulse that steepens half again as
  // much between idle and full load as a smooth six at 0.58, which is most of
  // what "it hardens up under load" means. Like `voice`, this field was in
  // every profile and read by nothing until the preset schema found it.
  const h = Math.max(0, Math.min(1.5, (typeof P.hardness === 'number' && isFinite(P.hardness))
    ? P.hardness : 0.65)) / 0.65;
  const a = P.attack * (0.55 + 0.85 * h * hard);
  const b = P.decay * (1.25 - 0.35 * h * hard);

  const cycle = new Float64Array(TABLE_SIZE);
  const rnd = seeded(profile.cylinders * 2654435761 + Math.round(P.attack * 97));
  const jitter = (P.jitter || 0) / 100;

  for (const angle of angles) {
    // Per-cylinder variation: no two cylinders are identical, and that
    // irregularity is a big part of why real engines sound alive.
    const ampTrim = 1 + (rnd() * 2 - 1) * jitter * 2.5;
    const angTrim = (rnd() * 2 - 1) * jitter * 6;         // degrees
    const decayTrim = 1 + (rnd() * 2 - 1) * jitter * 1.5;
    const u0 = (((angle + phaseShift + angTrim) % 720) + 720) % 720 / 720;

    for (let i = 0; i < TABLE_SIZE; i++) {
      let d = i / TABLE_SIZE - u0;
      if (d < 0) d += 1;                                   // wrap the cycle
      cycle[i] += ampTrim * pulseAt(d, a, b * decayTrim);
    }
  }
  return cycle;
}

/**
 * Differentiate and remove DC. Radiation from an open pipe end is proportional
 * to the time derivative of volume velocity, so the derivative is not a tone
 * shaping choice — it is what actually leaves the tailpipe.
 */
export function toPressureGradient(cycle) {
  const n = cycle.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = cycle[(i + 1) % n] - cycle[i];
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n;
  for (let i = 0; i < n; i++) out[i] -= mean;
  return out;
}

/**
 * Fourier coefficients in Web Audio's PeriodicWave convention:
 *   x(t) = Σ real[k]·cos(2πkt) + imag[k]·sin(2πkt)
 * Harmonic index k corresponds to engine order k/2.
 *
 * @returns {{real: Float32Array, imag: Float32Array}}
 */
/**
 * Engine order above which the pressure-gradient tilt stops rising.
 *
 * A pure derivative is +6 dB/octave with nothing to stop it, which put the
 * spectral centroid of a V8 at order 15.4 — 385 Hz at 3000 rpm, where a real V8
 * keeps most of its power under 300 Hz. That is the "too high pitched" problem.
 *
 * The physics: radiation from an open pipe end only behaves as a differentiator
 * while ka << 1. Above ka ≈ 1 the radiation impedance turns resistive and the
 * response flattens. For a ~60 mm tailpipe that knee is around 1.8 kHz, and the
 * muffler and pipe walls roll off hard above it too.
 *
 * A fixed Hz knee cannot be baked into an rpm-independent wavetable, so this is
 * a compromise value chosen by measurement: at 24 the V8's centroid moves from
 * order 15.4 (385 Hz at 3000 rpm) to order 5.3 (133 Hz), putting 80 % of the
 * energy below order 8 while keeping a 13 dB spread between order 4 and order
 * 16 so it gains weight without going muddy. The fixed-frequency part of the
 * radiation rolloff is handled by the tone stage in engine-sim.js instead.
 */
const RADIATION_KNEE_ORDER = 24;

export function cycleToCoefficients(cycle, maxHarmonics = MAX_HARMONICS,
                                    kneeOrder = RADIATION_KNEE_ORDER) {
  const n = cycle.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(cycle);
  fft(re, im);

  const L = Math.min(maxHarmonics, n / 2);
  const real = new Float32Array(L);
  const imag = new Float32Array(L);
  // Harmonic k is engine order k/2, so the knee in harmonic index is 2*kneeOrder.
  const kKnee = kneeOrder > 0 ? 2 * kneeOrder : 0;
  for (let k = 1; k < L; k++) {
    const shelf = kKnee ? 1 / (1 + k / kKnee) : 1;
    real[k] = (2 * re[k]) / n * shelf;
    imag[k] = (-2 * im[k]) / n * shelf;
  }
  real[0] = 0; imag[0] = 0;          // no DC
  return { real, imag };
}

/** Reconstruct a waveform from coefficients — used by the tests to prove the
 *  analysis/synthesis round-trip and the sign convention are correct. */
export function reconstruct(real, imag, n = TABLE_SIZE) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    let s = 0;
    for (let k = 1; k < real.length; k++) {
      s += real[k] * Math.cos(2 * Math.PI * k * t) + imag[k] * Math.sin(2 * Math.PI * k * t);
    }
    out[i] = s;
  }
  return out;
}

/** Scale coefficients so every table radiates at a comparable level. */
function normalise(coeffs, targetRms = 0.25) {
  let power = 0;
  for (let k = 1; k < coeffs.real.length; k++) {
    power += 0.5 * (coeffs.real[k] ** 2 + coeffs.imag[k] ** 2);
  }
  const rms = Math.sqrt(power) || 1;
  const g = targetRms / rms;
  for (let k = 0; k < coeffs.real.length; k++) { coeffs.real[k] *= g; coeffs.imag[k] *= g; }
  return coeffs;
}

/**
 * Every wavetable an engine needs. Built once per engine type.
 *
 * Per exhaust bank we build a soft (light load) and a hard (full load) table
 * and crossfade between them with load — the harmonic balance of a real engine
 * changes with load in ways a lowpass alone cannot fake.
 *
 * @returns {{banks: Array<{soft: PeriodicWave, hard: PeriodicWave}>,
 *            intake: {soft: PeriodicWave, hard: PeriodicWave},
 *            orders: {bank: number[]}}}
 */
export function buildEngineWaves(ctx, profile, bankAnglesFn) {
  const opts = { disableNormalization: true };
  const make = (angles, hard, phase) => {
    const c = normalise(cycleToCoefficients(
      toPressureGradient(buildCycle(profile, angles, hard, phase))));
    return ctx.createPeriodicWave(c.real, c.imag, opts);
  };

  const banks = profile.banks.map((_, i) => {
    const angles = bankAnglesFn(profile, i);
    return { soft: make(angles, 0, 0), hard: make(angles, 1, 0) };
  });

  // The intake manifold is one shared plenum, so all cylinders draw through it.
  // Induction happens roughly 360° before the power stroke.
  const allAngles = profile.banks.flat().map((_, i) => i * 720 / profile.cylinders);
  const intake = { soft: make(allAngles, 0, 360), hard: make(allAngles, 1, 360) };

  return { banks, intake };
}

/**
 * Spectrum of a bank in engine-order terms, for analysis and for the demo's
 * order display. orders[i] is the magnitude at engine order (i+1)/2.
 */
export function orderSpectrum(profile, angles, hard = 0.5, maxOrder = 16) {
  const c = cycleToCoefficients(toPressureGradient(buildCycle(profile, angles, hard)));
  const out = [];
  for (let k = 1; k <= maxOrder * 2 && k < c.real.length; k++) {
    out.push({ order: k / 2, mag: Math.hypot(c.real[k], c.imag[k]) });
  }
  return out;
}

export { TABLE_SIZE, MAX_HARMONICS };
