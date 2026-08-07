/**
 * renderer.js — pass chain for the night drive.
 *
 *   sky (fullscreen)                     ┐
 *   scene, instanced, forward-lit HDR    ├→ HDR target
 *   light shafts (raymarched, half res)  ┘
 *          ↓ bright pass → blur H → blur V (quarter res)
 *   composite: radial blur, chromatic aberration, ACES, vignette, grain
 */

import { m4, createProgram, createMesh, addInstancing, createTarget, resizeTarget,
         createFullscreenTri } from './gfx.js';
import * as S from './shaders.js';

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is required for the night drive scene.');
    this.gl = gl;
    this.canvas = canvas;

    // Half-float render targets are what let headlights be genuinely brighter
    // than 1.0 so the tonemap and bloom have something to work with.
    if (!gl.getExtension('EXT_color_buffer_half_float') &&
        !gl.getExtension('EXT_color_buffer_float')) {
      this.hdr = false;
    } else this.hdr = true;

    this.progScene = createProgram(gl, S.SCENE_VS, S.SCENE_FS, 'scene');
    this.progSky = createProgram(gl, S.SKY_VS, S.SKY_FS, 'sky');
    this.progGod = createProgram(gl, S.GOD_VS, S.GOD_FS, 'shafts');
    this.progBright = createProgram(gl, S.POST_VS, S.BRIGHT_FS, 'bright');
    this.progBlur = createProgram(gl, S.POST_VS, S.BLUR_FS, 'blur');
    this.progComp = createProgram(gl, S.POST_VS, S.COMPOSITE_FS, 'composite');

    this.tri = createFullscreenTri(gl);
    this.meshes = {};
    this.viewProj = m4.create();
    this.invViewProj = m4.create();
    this.view = m4.create();
    this.proj = m4.create();

    this.scene = createTarget(gl, 2, 2, { float: this.hdr, depth: true });
    this.shafts = createTarget(gl, 2, 2, { float: this.hdr, depth: false });
    this.bloomA = createTarget(gl, 2, 2, { float: this.hdr, depth: false });
    this.bloomB = createTarget(gl, 2, 2, { float: this.hdr, depth: false });

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  addMesh(name, geo, maxInstances) {
    const m = createMesh(this.gl, geo.data, geo.indices);
    if (maxInstances) addInstancing(this.gl, m, maxInstances);
    this.meshes[name] = m;
    return m;
  }

  resize(w, h, dpr) {
    const W = Math.max(2, Math.floor(w * dpr)), H = Math.max(2, Math.floor(h * dpr));
    // Always record the size, even when nothing changed. Returning early before
    // this ran left W/H undefined whenever the canvas already had the right
    // backing-store size, which made the projection aspect NaN and rendered a
    // black screen with no GL error to show for it.
    this.W = W; this.H = H;
    if (this.canvas.width === W && this.canvas.height === H) return;
    this.canvas.width = W; this.canvas.height = H;
    const gl = this.gl;
    resizeTarget(gl, this.scene, W, H, this.hdr);
    resizeTarget(gl, this.shafts, W >> 1, H >> 1, this.hdr);
    resizeTarget(gl, this.bloomA, W >> 2, H >> 2, this.hdr);
    resizeTarget(gl, this.bloomB, W >> 2, H >> 2, this.hdr);
  }

  /** Upload one draw batch's instance data. Each instance is mat4 + rgba tint. */
  setInstances(name, list) {
    const gl = this.gl, m = this.meshes[name];
    if (!m || !m.instanceBuf) return;
    const d = m.instanceData;
    const max = d.length / 20;
    const n = Math.min(list.length, max);
    for (let i = 0; i < n; i++) {
      d.set(list[i].m, i * 20);
      const t = list[i].tint;
      d[i * 20 + 16] = t[0]; d[i * 20 + 17] = t[1];
      d[i * 20 + 18] = t[2]; d[i * 20 + 19] = t[3];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, m.instanceBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, n * 20);
    m.instances = n;
  }

  _drawMesh(name, u, { roughness = 0.75, metallic = 0.0, roadMask = 0 } = {}) {
    const gl = this.gl, m = this.meshes[name];
    if (!m || !m.instances) return;
    gl.uniform1f(u.uRoughness, roughness);
    gl.uniform1f(u.uMetallic, metallic);
    gl.uniform1f(u.uRoadMask, roadMask);
    gl.bindVertexArray(m.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0, m.instances);
  }

  /**
   * @param {object} cam   { pos, target, up, fov, near, far }
   * @param {object} env   lights, fog, wetness, exposure, speed, shake
   * @param {Array}  batches [{ name, roughness, metallic, roadMask }]
   * @param {Function} [overlay] drawn into the HDR target after the world
   */
  render(cam, env, batches, overlay) {
    const gl = this.gl;
    const aspect = this.W / this.H;

    m4.perspective(this.proj, cam.fov, aspect, cam.near, cam.far);
    m4.lookAt(this.view, cam.pos, cam.target, cam.up);
    m4.multiply(this.viewProj, this.proj, this.view);
    invert4(this.invViewProj, this.viewProj);

    // ---- sky + scene into HDR ------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, this.W, this.H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.depthMask(false); gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.progSky.program);
    let u = this.progSky.u;
    gl.uniformMatrix4fv(u.uInvViewProj, false, this.invViewProj);
    gl.uniform3fv(u.uCamPos, cam.pos);
    gl.uniform1f(u.uTime, env.time);
    gl.uniform1f(u.uWet, env.wet);
    gl.bindVertexArray(this.tri);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true); gl.enable(gl.DEPTH_TEST);

    gl.useProgram(this.progScene.program);
    u = this.progScene.u;
    gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
    gl.uniform3fv(u.uCamPos, cam.pos);
    gl.uniform1f(u.uTime, env.time);
    gl.uniform1f(u.uWet, env.wet);
    gl.uniform3fv(u.uFogColor, env.fogColor);
    gl.uniform1f(u.uFogDensity, env.fogDensity);
    gl.uniform3fv(u.uHeadPos, env.headPos);
    gl.uniform3fv(u.uHeadDir, env.headDir);
    gl.uniform3fv(u.uHeadColor, env.headColor);
    gl.uniform1f(u.uHeadInner, env.headInner);
    gl.uniform1f(u.uHeadOuter, env.headOuter);
    gl.uniform1f(u.uHeadRange, env.headRange);
    gl.uniform1i(u.uNumLights, env.numLights);
    if (env.numLights > 0) {
      gl.uniform3fv(u.uLightPos, env.lightPos);
      gl.uniform3fv(u.uLightColor, env.lightColor);
      gl.uniform1fv(u.uLightRange, env.lightRange);
    }
    for (const b of batches) this._drawMesh(b.name, u, b);

    // Cockpit and anything else welded to the camera is drawn HERE, still
    // inside the HDR target, so it goes through the tonemap and its emissive
    // gauges feed the bloom pass like every other light in the scene. Drawing
    // it after the composite would put linear HDR values straight on an LDR
    // screen and look nothing like the rest of the frame.
    if (overlay) overlay(this, u);

    // ---- volumetric shafts, half res ------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shafts.fbo);
    gl.viewport(0, 0, this.shafts.w, this.shafts.h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.progGod.program);
    u = this.progGod.u;
    gl.uniformMatrix4fv(u.uInvViewProj, false, this.invViewProj);
    gl.uniform3fv(u.uCamPos, cam.pos);
    gl.uniform3fv(u.uHeadPos, env.headPos);
    gl.uniform3fv(u.uHeadDir, env.headDir);
    gl.uniform3fv(u.uHeadColor, env.headColor);
    gl.uniform1f(u.uHeadInner, env.headInner);
    gl.uniform1f(u.uHeadOuter, env.headOuter);
    gl.uniform1f(u.uDensity, env.shaftDensity);
    gl.uniform1f(u.uTime, env.time);
    gl.bindVertexArray(this.tri);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- bloom ----------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fbo);
    gl.viewport(0, 0, this.bloomA.w, this.bloomA.h);
    gl.useProgram(this.progBright.program);
    u = this.progBright.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.uniform1i(u.uTex, 0);
    gl.uniform1f(u.uThreshold, env.bloomThreshold);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(this.progBlur.program);
    u = this.progBlur.u;
    for (let pass = 0; pass < 2; pass++) {
      // horizontal
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.fbo);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex);
      gl.uniform1i(u.uTex, 0);
      gl.uniform2f(u.uDir, 1 / this.bloomA.w, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // vertical
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fbo);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomB.tex);
      gl.uniform2f(u.uDir, 0, 1 / this.bloomA.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ---- composite to screen --------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.progComp.program);
    u = this.progComp.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.uniform1i(u.uScene, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex);
    gl.uniform1i(u.uBloom, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.shafts.tex);
    gl.uniform1i(u.uShafts, 2);
    gl.uniform1f(u.uExposure, env.exposure);
    gl.uniform1f(u.uBloomAmt, env.bloom);
    gl.uniform1f(u.uSpeed, env.speedNorm);
    gl.uniform1f(u.uTime, env.time);
    gl.uniform1f(u.uShake, env.shake);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }
}

/** General 4x4 inverse — only called once per frame, so clarity over speed. */
function invert4(o, m) {
  const a00=m[0],a01=m[1],a02=m[2],a03=m[3], a10=m[4],a11=m[5],a12=m[6],a13=m[7];
  const a20=m[8],a21=m[9],a22=m[10],a23=m[11], a30=m[12],a31=m[13],a32=m[14],a33=m[15];
  const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10;
  const b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12;
  const b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30;
  const b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;
  let det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06;
  if (!det) return o;
  det = 1/det;
  o[0]=(a11*b11-a12*b10+a13*b09)*det; o[1]=(a02*b10-a01*b11-a03*b09)*det;
  o[2]=(a31*b05-a32*b04+a33*b03)*det; o[3]=(a22*b04-a21*b05-a23*b03)*det;
  o[4]=(a12*b08-a10*b11-a13*b07)*det; o[5]=(a00*b11-a02*b08+a03*b07)*det;
  o[6]=(a32*b02-a30*b05-a33*b01)*det; o[7]=(a20*b05-a22*b02+a23*b01)*det;
  o[8]=(a10*b10-a11*b08+a13*b06)*det; o[9]=(a01*b08-a00*b10-a03*b06)*det;
  o[10]=(a30*b04-a31*b02+a33*b00)*det; o[11]=(a21*b02-a20*b04-a23*b00)*det;
  o[12]=(a11*b07-a10*b09-a12*b06)*det; o[13]=(a00*b09-a01*b07+a02*b06)*det;
  o[14]=(a31*b01-a30*b03-a32*b00)*det; o[15]=(a20*b03-a21*b01+a22*b00)*det;
  return o;
}

// ---------------------------------------------------------------------------

/**
 * Chassis dynamics that sit on top of EngineSim's drivetrain.
 *
 * EngineSim gives longitudinal speed and rpm. What sells the FEEL is everything
 * around that: a body on springs that pitches under power and dives under
 * brakes, rolls into a steering input, and shivers over the road surface. All
 * of it is a damped spring driven by acceleration, which is both the cheapest
 * and the most convincing way to do it.
 */
export class Chassis {
  constructor() {
    this.pitch = 0; this.pitchV = 0;
    this.roll = 0;  this.rollV = 0;
    this.heave = 0; this.heaveV = 0;
    this.yaw = 0;
    this.lateral = 0;
    this.steer = 0;
    this.shake = 0;
    this.slipG = 0;
    this.prevSpeed = 0;
    this.t = 0;
  }

  /**
   * @param {number} dt
   * @param {object} st EngineSim state
   * @param {number} steerInput -1..1
   * @param {object} ev { lash, engage, impact }
   */
  update(dt, st, steerInput, ev = {}) {
    this.t += dt;
    const v = st.speed;
    const accel = (v - this.prevSpeed) / Math.max(1e-4, dt);
    this.prevSpeed = v;

    // Steering: smooth and dynamic response
    const authority = 1 / (1 + v * 0.035);
    this.steer += (steerInput - this.steer) * Math.min(1, dt * 10.0);
    const yawRate = this.steer * authority * Math.min(v, 70) * 0.024;
    this.yaw += yawRate * dt;
    this.yaw *= Math.pow(0.001, dt);          // self-centring

    // Calculate lateral G-force and tire slip
    const lateralAcc = Math.abs(yawRate * v);
    this.slipG = Math.min(1.0, lateralAcc / 16.0);

    // Lateral position on road
    const grip = 1 - Math.min(0.5, this.slipG * 0.5);
    this.lateral += yawRate * v * dt * 0.25 * grip;

    // --- body on springs (dynamic chassis roll & pitch physics when turning) ----
    const spring = (x, xv, target, k, c) => {
      const a = -k * (x - target) - c * xv;
      return [x + xv * dt, xv + a * dt];
    };
    // Dynamic roll & pitch under lateral G forces and steering
    [this.pitch, this.pitchV] = spring(this.pitch, this.pitchV, -accel * 0.004 + Math.abs(this.steer) * 0.005, 60, 10.0);
    [this.roll, this.rollV] = spring(this.roll, this.rollV, -this.steer * 0.015 - yawRate * v * 0.002, 50, 9.0);

    // --- road and engine vibration (micro-vibration) ---------------------
    const speedN = Math.min(1, v / 65);
    const rpmN = st.redline ? st.rpm / st.redline : 0;
    const engineBuzz = (0.0002 + 0.0004 * st.load) * (0.35 + 0.65 * rpmN);
    const roadBuzz = 0.0004 * speedN * speedN;
    const f1 = Math.sin(this.t * 63.0) * Math.sin(this.t * 27.3);
    const f2 = Math.sin(this.t * 111.0 + 1.7);
    this.vibY = (f1 * roadBuzz + f2 * engineBuzz);
    this.vibX = (Math.sin(this.t * 47.0 + 0.5) * roadBuzz * 0.7 +
                 Math.sin(this.t * 89.0) * engineBuzz * 0.6);

    // --- impacts (controlled micro-shake) --------------------------------
    if (ev.lash) this.shake = Math.min(0.4, this.shake + ev.lash * 0.15);
    if (ev.engage) this.shake = Math.min(0.4, this.shake + ev.engage * 0.10);
    if (ev.impact) this.shake = Math.min(0.8, this.shake + ev.impact * 0.30);
    
    this.shake *= Math.pow(0.005, dt);
    const s = this.shake;
    this.shakeX = Math.sin(this.t * 141.0) * s * 0.002;
    this.shakeY = Math.sin(this.t * 173.0 + 2.1) * s * 0.002;
    this.shakeR = Math.sin(this.t * 121.0 + 1.0) * s * 0.001;

    [this.heave, this.heaveV] = spring(this.heave, this.heaveV, -s * 0.005, 80, 12);
  }
}
