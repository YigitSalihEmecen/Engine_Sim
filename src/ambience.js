/**
 * ambience.js — environment bed that sits under the engine.
 *
 * Rain, wind, tyre roar and distant thunder. Standalone: it takes a context and
 * exposes an output, so both the console page and the drive scene can use it
 * without going through EngineSim.
 *
 * Everything is noise shaped by filters — no samples, no allocation per frame.
 * Levels that should track the car (wind, tyres) take road speed; the rest are
 * set by the user.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const fin = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const TC = 0.05;

function setT(param, v, now, tc = TC) {
  if (!param) return;
  param.setTargetAtTime(fin(v, 0), Math.max(0, fin(now, 0)), tc > 0 ? tc : TC);
}

function noiseBuffer(ctx, seconds, kind) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    else if (kind === 'pink') {
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.28;
    } else d[i] = w;
  }
  const fade = Math.min(2048, len >> 2);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    d[i] = d[i] * t + d[len - fade + i] * (1 - t);
  }
  return buf;
}

export class Ambience {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = fin(opts.level, 1);
    this._srcs = [];
    this.started = false;

    const src = (kind, off) => {
      const s = ctx.createBufferSource();
      s.buffer = noiseBuffer(ctx, 3.3, kind);
      s.loop = true;
      s.loopStart = 0.05;
      this._srcs.push(s);
      return s;
    };

    // ---- rain --------------------------------------------------------------
    // Rain on a car is two things at once: a bright hiss of drops hitting glass
    // and metal, and a duller roar off the road surface. Splitting them means
    // "heavier rain" can shift the balance rather than just get louder.
    this.rainSrc = src('white');
    this.rainHiss = ctx.createBiquadFilter();
    this.rainHiss.type = 'highpass';
    this.rainHiss.frequency.value = 1900;
    this.rainBody = ctx.createBiquadFilter();
    this.rainBody.type = 'bandpass';
    this.rainBody.frequency.value = 620;
    this.rainBody.Q.value = 0.7;
    this.rainHissG = ctx.createGain(); this.rainHissG.gain.value = 0;
    this.rainBodyG = ctx.createGain(); this.rainBodyG.gain.value = 0;
    this.rainSrc.connect(this.rainHiss); this.rainHiss.connect(this.rainHissG);
    this.rainSrc.connect(this.rainBody); this.rainBody.connect(this.rainBodyG);
    this.rainHissG.connect(this.out); this.rainBodyG.connect(this.out);

    // Gusts: rain is never a steady level.
    this.rainLfo = ctx.createOscillator();
    this.rainLfo.type = 'sine';
    this.rainLfo.frequency.value = 0.11;
    this.rainLfoG = ctx.createGain(); this.rainLfoG.gain.value = 0;
    this.rainLfo.connect(this.rainLfoG);
    this.rainLfoG.connect(this.rainHissG.gain);
    this._srcs.push(this.rainLfo);

    // ---- wind --------------------------------------------------------------
    // Buffeting round the A-pillars and mirrors. Rises steeply with speed
    // because aerodynamic noise goes roughly with velocity^6 in power terms.
    this.windSrc = src('brown');
    this.windLP = ctx.createBiquadFilter();
    this.windLP.type = 'lowpass';
    this.windLP.frequency.value = 500;
    this.windLP.Q.value = 0.8;
    this.windPeak = ctx.createBiquadFilter();
    this.windPeak.type = 'peaking';
    this.windPeak.frequency.value = 320;
    this.windPeak.Q.value = 1.1;
    this.windPeak.gain.value = 5;
    this.windG = ctx.createGain(); this.windG.gain.value = 0;
    this.windSrc.connect(this.windLP);
    this.windLP.connect(this.windPeak);
    this.windPeak.connect(this.windG);
    this.windG.connect(this.out);

    this.windLfo = ctx.createOscillator();
    this.windLfo.type = 'sine';
    this.windLfo.frequency.value = 0.19;
    this.windLfoG = ctx.createGain(); this.windLfoG.gain.value = 0;
    this.windLfo.connect(this.windLfoG);
    this.windLfoG.connect(this.windG.gain);
    this._srcs.push(this.windLfo);

    // ---- tyre / road roar --------------------------------------------------
    // Tread blocks hitting the surface. Broadband, centred a few hundred Hz,
    // and it gets both louder and brighter with speed. Wet roads roar more.
    this.roadSrc = src('pink');
    this.roadBP = ctx.createBiquadFilter();
    this.roadBP.type = 'bandpass';
    this.roadBP.frequency.value = 420;
    this.roadBP.Q.value = 0.55;
    this.roadG = ctx.createGain(); this.roadG.gain.value = 0;
    this.roadSrc.connect(this.roadBP);
    this.roadBP.connect(this.roadG);
    this.roadG.connect(this.out);

    // ---- thunder -----------------------------------------------------------
    // One shared low resonant path, retriggered by scheduling. No allocation.
    this.thunderSrc = src('brown');
    this.thunderLP = ctx.createBiquadFilter();
    this.thunderLP.type = 'lowpass';
    this.thunderLP.frequency.value = 220;
    this.thunderLP.Q.value = 1.2;
    this.thunderG = ctx.createGain(); this.thunderG.gain.value = 0;
    this.thunderSrc.connect(this.thunderLP);
    this.thunderLP.connect(this.thunderG);
    this.thunderG.connect(this.out);
    this._nextThunder = 0;

    this.rain = fin(opts.rain, 0);
    this.wind = fin(opts.wind, 0.25);
    this.road = fin(opts.road, 0.5);
    this.thunderOn = opts.thunder !== false;
  }

  get input() { return null; }
  get output() { return this.out; }

  start(t) {
    if (this.started) return;
    this.started = true;
    const at = fin(t, this.ctx.currentTime);
    for (const s of this._srcs) { try { s.start(at); } catch (e) { /* started */ } }
    this._nextThunder = at + 12 + Math.random() * 25;
  }

  stop(t) {
    const at = fin(t, this.ctx.currentTime);
    for (const s of this._srcs) { try { s.stop(at); } catch (e) { /* not started */ } }
    this.started = false;
  }

  setRain(v) { this.rain = clamp(fin(v, 0), 0, 1); }
  setWind(v) { this.wind = clamp(fin(v, 0), 0, 1); }
  setRoad(v) { this.road = clamp(fin(v, 0), 0, 1); }
  setThunder(on) { this.thunderOn = !!on; }
  setLevel(v) { setT(this.out.gain, clamp(fin(v, 1), 0, 2), this.ctx.currentTime); }

  /** @param {{now:number, speed:number}} p speed in m/s */
  update(p = {}) {
    const now = fin(p.now, this.ctx.currentTime);
    const v = Math.abs(fin(p.speed, 0));
    const vn = clamp(v / 60, 0, 1);              // 0..1 over 0..216 km/h
    const rain = this.rain;

    // Rain. Heavier rain shifts toward the low roar as well as getting louder.
    setT(this.rainHissG.gain, 0.30 * Math.pow(rain, 0.8) * (1 + 0.4 * vn), now);
    setT(this.rainBodyG.gain, 0.34 * Math.pow(rain, 1.3), now);
    setT(this.rainLfoG.gain, 0.09 * rain, now);
    setT(this.rainHiss.frequency, 1500 + 900 * rain, now);

    // Wind. Aerodynamic noise climbs very steeply with speed, and the spectrum
    // opens up as it does — at a crawl it is a low hum, at speed it is a roar.
    const gust = 0.55 + 0.45 * this.wind;
    setT(this.windG.gain, 0.42 * this.wind * Math.pow(vn, 1.7), now);
    setT(this.windLfoG.gain, 0.10 * this.wind * vn, now);
    setT(this.windLP.frequency, clamp(260 + 1500 * vn * gust, 80, 6000), now);

    // Tyres. Wet roads roar noticeably more than dry ones.
    const wet = 1 + 0.75 * rain;
    setT(this.roadG.gain, 0.30 * this.road * wet * Math.pow(vn, 0.85), now);
    setT(this.roadBP.frequency, clamp(300 + 700 * vn, 80, 4000), now);

    // Thunder, only when it is actually raining.
    if (this.thunderOn && rain > 0.35 && now >= this._nextThunder) {
      this._fireThunder(now + 0.05, 0.4 + 0.6 * Math.random());
      this._nextThunder = now + 9 + Math.random() * 30;
    }
  }

  _fireThunder(t, strength) {
    const g = this.thunderG.gain;
    const dur = 1.6 + 2.4 * strength;
    const peak = clamp(0.5 * strength, 0.002, 1);
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0005, t);
    // Slow swell then a long decay — distance smears the attack completely.
    g.linearRampToValueAtTime(peak, t + 0.18 + 0.5 * (1 - strength));
    g.exponentialRampToValueAtTime(0.0005, t + dur);
    g.setValueAtTime(0, t + dur + 0.01);
    this.thunderLP.frequency.cancelScheduledValues(t);
    this.thunderLP.frequency.setValueAtTime(140 + 220 * strength, t);
    this.thunderLP.frequency.exponentialRampToValueAtTime(70, t + dur);
  }

  dispose() {
    this.stop(this.ctx.currentTime);
    for (const n of [this.out, this.rainHiss, this.rainBody, this.rainHissG,
      this.rainBodyG, this.rainLfo, this.rainLfoG, this.windSrc, this.windLP,
      this.windPeak, this.windG, this.windLfo, this.windLfoG, this.roadSrc,
      this.roadBP, this.roadG, this.thunderSrc, this.thunderLP, this.thunderG,
      this.rainSrc]) { if (n && n.disconnect) n.disconnect(); }
    this._srcs.length = 0;
  }
}
