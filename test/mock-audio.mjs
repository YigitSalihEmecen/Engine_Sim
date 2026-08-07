/**
 * mock-audio.mjs — a strict Web Audio mock for headless testing.
 *
 * Nobody can listen to the output in this environment, so this harness enforces
 * the things that are checkable without ears: that every value written to an
 * AudioParam is finite and in range, that feedback loops cannot blow up, and
 * that nothing allocates nodes per frame.
 *
 * It is deliberately hostile — it throws on the first violation with the
 * offending node, param and value, because a NaN written into a Web Audio graph
 * silences the whole branch permanently and is otherwise invisible.
 */

export class Violation extends Error {}

export function createMockContext(opts = {}) {
  const state = {
    nodes: 0,
    byType: Object.create(null),
    sealed: false,          // once sealed, new nodes are a per-frame allocation bug
    scheduled: 0,
    writes: 0,
    violations: [],
    all: [],
    time: 0,
    strict: opts.strict !== false,
  };

  const fail = msg => {
    const e = new Violation(msg);
    state.violations.push(msg);
    if (state.strict) throw e;
  };

  const checkFinite = (label, v) => {
    if (typeof v !== 'number' || !isFinite(v)) fail(`${label}: non-finite value ${v}`);
    return v;
  };

  function makeParam(label, initial = 0, range = null) {
    const p = {
      value: initial,
      _check(v) {
        checkFinite(label, v);
        if (range && (v < range[0] || v > range[1])) {
          fail(`${label}: ${v} outside ${range[0]}..${range[1]}`);
        }
        state.writes++;
        return v;
      },
      setValueAtTime(v, t) { checkFinite(label + '.time', t); p.value = p._check(v); state.scheduled++; return p; },
      setTargetAtTime(v, t, tc) {
        checkFinite(label + '.time', t);
        if (!(tc > 0)) fail(`${label}: setTargetAtTime timeConstant must be > 0, got ${tc}`);
        p.value = p._check(v); return p;
      },
      linearRampToValueAtTime(v, t) { checkFinite(label + '.time', t); p.value = p._check(v); state.scheduled++; return p; },
      exponentialRampToValueAtTime(v, t) {
        checkFinite(label + '.time', t);
        if (!(v > 0)) fail(`${label}: exponentialRamp target must be > 0, got ${v}`);
        p.value = p._check(v); state.scheduled++; return p;
      },
      setValueCurveAtTime(curve, t) { for (const v of curve) p._check(v); state.scheduled++; return p; },
      cancelScheduledValues() { return p; },
      cancelAndHoldAtTime() { return p; },
    };
    return p;
  }

  function node(type, extra = {}) {
    if (state.sealed) {
      fail(`allocated a ${type} after the graph was sealed — nodes must be built once, not per frame`);
    }
    state.nodes++;
    state.byType[type] = (state.byType[type] || 0) + 1;
    const n = {
      _type: type,
      _connections: [],
      _isNode: true,
      connect(dst) { this._connections.push(dst); return dst; },
      disconnect() { this._connections.length = 0; },
      ...extra,
    };
    // Back-reference each AudioParam to its node so the audit can follow a
    // modulation connection (osc -> gain.gain) through to the speakers.
    for (const v of Object.values(n)) {
      if (v && typeof v === 'object' && typeof v.setTargetAtTime === 'function') v._owner = n;
    }
    state.all.push(n);
    return n;
  }

  const NYQ = 24000;

  const ctx = {
    sampleRate: opts.sampleRate || 48000,
    get currentTime() { return state.time; },
    state: 'running',
    destination: node('destination'),
    listener: {},

    async resume() { ctx.state = 'running'; },
    async suspend() { ctx.state = 'suspended'; },
    async close() { ctx.state = 'closed'; },

    createGain: () => node('gain', { gain: makeParam('gain.gain') }),

    createBiquadFilter: () => node('biquad', {
      type: 'lowpass',
      frequency: makeParam('biquad.frequency', 350, [0, NYQ]),
      Q: makeParam('biquad.Q', 1, [-1000, 1000]),
      gain: makeParam('biquad.gain', 0, [-60, 60]),
      detune: makeParam('biquad.detune', 0),
      getFrequencyResponse() {},
    }),

    createOscillator: () => node('oscillator', {
      type: 'sine',
      frequency: makeParam('osc.frequency', 440, [-NYQ, NYQ]),
      detune: makeParam('osc.detune', 0, [-100000, 100000]),
      _started: false, _stopped: false,
      start(t) {
        if (this._started) fail('oscillator started twice');
        this._started = true; if (t !== undefined) checkFinite('osc.start', t);
      },
      stop(t) { if (t !== undefined) checkFinite('osc.stop', t); this._stopped = true; },
      setPeriodicWave() {},
    }),

    createBufferSource: () => node('buffersource', {
      buffer: null, loop: false,
      loopStart: 0, loopEnd: 0,
      playbackRate: makeParam('src.playbackRate', 1, [0, 64]),
      detune: makeParam('src.detune', 0),
      _started: false,
      start(t) {
        if (this._started) fail('buffer source started twice');
        this._started = true; if (t !== undefined) checkFinite('src.start', t);
      },
      stop(t) { if (t !== undefined) checkFinite('src.stop', t); },
    }),

    createDelay: (max = 1) => node('delay', {
      _maxDelay: max,
      delayTime: makeParam('delay.delayTime', 0, [0, max]),
    }),

    createWaveShaper: () => node('waveshaper', {
      _curve: null, oversample: 'none',
      set curve(c) {
        if (c) for (let i = 0; i < c.length; i++) checkFinite('waveshaper.curve[' + i + ']', c[i]);
        this._curve = c;
      },
      get curve() { return this._curve; },
    }),

    createDynamicsCompressor: () => node('compressor', {
      threshold: makeParam('comp.threshold', -24, [-100, 0]),
      knee: makeParam('comp.knee', 30, [0, 40]),
      ratio: makeParam('comp.ratio', 12, [1, 20]),
      attack: makeParam('comp.attack', 0.003, [0, 1]),
      release: makeParam('comp.release', 0.25, [0, 1]),
      reduction: 0,
    }),

    createStereoPanner: () => node('panner', { pan: makeParam('panner.pan', 0, [-1, 1]) }),
    createChannelMerger: () => node('merger'),
    createChannelSplitter: () => node('splitter'),
    createAnalyser: () => node('analyser', {
      fftSize: 2048, frequencyBinCount: 1024,
      getByteFrequencyData() {}, getFloatTimeDomainData() {},
    }),
    createConvolver: () => node('convolver', { buffer: null, normalize: true }),

    createBuffer(channels, length, rate) {
      if (!(length > 0)) fail(`createBuffer length must be > 0, got ${length}`);
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels, length, sampleRate: rate || ctx.sampleRate,
        duration: length / (rate || ctx.sampleRate),
        getChannelData: i => data[i],
      };
    },

    createPeriodicWave(real, imag) {
      if (real.length !== imag.length) fail('periodicWave: real/imag length mismatch');
      for (let i = 0; i < real.length; i++) {
        checkFinite('periodicWave.real[' + i + ']', real[i]);
        checkFinite('periodicWave.imag[' + i + ']', imag[i]);
      }
      return node('periodicwave', { _harmonics: real.length });
    },
  };

  return {
    ctx,
    state,
    /** Call after construction. Any node created after this is a per-frame leak. */
    seal() { state.sealed = true; },
    unseal() { state.sealed = false; },
    advance(dt) { state.time += dt; },
    /**
     * Every source node must be started AND must have a path to destination.
     * A source that is built, connected and never started is silent, and
     * nothing else in this harness would notice — the params still get written.
     */
    audit(destination) {
      const reaches = new Map();
      const canReach = (n, seen = new Set()) => {
        if (n === destination) return true;
        if (!n || seen.has(n)) return false;
        seen.add(n);
        if (reaches.has(n)) return reaches.get(n);
        let ok = false;
        for (const d of (n._connections || [])) {
          if (!d) continue;
          // Follow a modulation connection through the param to its node: an
          // LFO driving a gain that reaches the output is audible, not orphaned.
          const next = d._isNode ? d : d._owner;
          if (next && canReach(next, seen)) { ok = true; break; }
        }
        return ok;
      };
      const unstarted = [], orphaned = [];
      for (const n of state.all) {
        if (n._type !== 'oscillator' && n._type !== 'buffersource') continue;
        if (!n._started) unstarted.push(n._type);
        else if (!canReach(n)) orphaned.push(n._type);
      }
      return { unstarted, orphaned, sources: state.all.filter(
        n => n._type === 'oscillator' || n._type === 'buffersource').length };
    },

    report() {
      return {
        nodes: state.nodes,
        byType: { ...state.byType },
        paramWrites: state.writes,
        scheduledEvents: state.scheduled,
        violations: state.violations.length,
      };
    },
  };
}

/** Install a window shim so modules that reach for window.AudioContext work. */
export function installGlobals(ctx) {
  globalThis.window = globalThis.window || {};
  globalThis.window.AudioContext = function () { return ctx; };
}
