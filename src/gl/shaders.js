/**
 * shaders.js — GLSL for the night-drive renderer.
 *
 * Forward lit, HDR, with a small clustered-ish light list uploaded per frame.
 * Everything is tuned for night: the ambient term is almost nothing, and nearly
 * all the light in frame comes from headlights, tail lights and sodium lamps.
 */

const COMMON = `
const float PI = 3.14159265359;

// GGX / Trowbridge-Reitz. Worth the cost here because almost every surface is
// lit at a grazing angle by a moving light, which is exactly where cheaper
// models fall apart.
float distGGX(float NdotH, float rough) {
  float a = rough * rough;
  float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / max(1e-6, PI * d * d);
}
float geomSmith(float NdotV, float NdotL, float rough) {
  float k = (rough + 1.0) * (rough + 1.0) / 8.0;
  float gv = NdotV / (NdotV * (1.0 - k) + k);
  float gl = NdotL / (NdotL * (1.0 - k) + k);
  return gv * gl;
}
vec3 fresnel(float cosT, vec3 F0) {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosT, 0.0, 1.0), 5.0);
}
`;

export const SCENE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
layout(location=3) in vec3 aColor;
layout(location=4) in mat4 aModel;      // 4,5,6,7
layout(location=8) in vec4 aTint;       // rgb tint, a = emissive strength

uniform mat4 uViewProj;

out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
out vec3 vColor;
out float vEmissive;

void main(){
  vec4 wp = aModel * vec4(aPos, 1.0);
  vWorld = wp.xyz;
  // Uniform-ish scale is assumed for instances; cheap and correct enough here.
  vNormal = normalize(mat3(aModel) * aNormal);
  vUV = aUV;
  vColor = aColor * aTint.rgb;
  vEmissive = aTint.a;
  gl_Position = uViewProj * wp;
}`;

export const SCENE_FS = `#version 300 es
precision highp float;
${COMMON}

#define MAX_LIGHTS 32

in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
in vec3 vColor;
in float vEmissive;

uniform vec3  uCamPos;
uniform float uTime;
uniform float uWet;            // 0 dry .. 1 soaked
uniform vec3  uFogColor;
uniform float uFogDensity;

// Player headlights: two spotlights.
uniform vec3  uHeadPos[2];
uniform vec3  uHeadDir[2];
uniform vec3  uHeadColor;
uniform float uHeadInner;      // cos of inner cone
uniform float uHeadOuter;      // cos of outer cone
uniform float uHeadRange;

// Everything else: point lights (tail lights, oncoming heads, street lamps).
uniform int   uNumLights;
uniform vec3  uLightPos[MAX_LIGHTS];
uniform vec3  uLightColor[MAX_LIGHTS];
uniform float uLightRange[MAX_LIGHTS];

// Surface controls, per draw call.
uniform float uRoughness;
uniform float uMetallic;
uniform float uRoadMask;       // 1 = this is tarmac, enables wet sheen + markings

out vec4 fragColor;

// Cheap value noise for road grain and puddles.
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
             mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}

vec3 shade(vec3 N, vec3 V, vec3 L, vec3 radiance, vec3 albedo, float rough, float metal){
  vec3 H = normalize(V + L);
  float NdotL = max(dot(N, L), 0.0);
  if (NdotL <= 0.0) return vec3(0.0);
  float NdotV = max(dot(N, V), 1e-4);
  float NdotH = max(dot(N, H), 0.0);
  vec3 F0 = mix(vec3(0.04), albedo, metal);
  float D = distGGX(NdotH, rough);
  float G = geomSmith(NdotV, NdotL, rough);
  vec3  F = fresnel(max(dot(H, V), 0.0), F0);
  vec3 spec = (D * G * F) / max(1e-4, 4.0 * NdotV * NdotL);
  vec3 kd = (1.0 - F) * (1.0 - metal);
  return (kd * albedo / PI + spec) * radiance * NdotL;
}

void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  vec3 albedo = vColor;
  float rough = uRoughness;
  float metal = uMetallic;

  if (uRoadMask > 0.5) {
    // Tarmac: aggregate grain, plus broad damp patches that pool water.
    float grain = noise(vWorld.xz * 3.2) * 0.5 + noise(vWorld.xz * 14.0) * 0.5;
    albedo *= 0.72 + 0.42 * grain;
    float puddle = smoothstep(0.55, 0.95, noise(vWorld.xz * 0.35 + vec2(0.0, uTime * 0.01)));
    // Water fills the aggregate: darker, far smoother, and slightly metallic so
    // the specular lobe actually mirrors the lights instead of washing out.
    float wetness = clamp(uWet * (0.55 + 0.75 * puddle), 0.0, 1.0);
    albedo *= mix(1.0, 0.42, wetness);
    rough = mix(rough, 0.055, wetness);
    metal = mix(metal, 0.55, wetness * 0.8);
  }

  // Night ambient: a little skylight from above, a lot less from below.
  vec3 ambient = mix(vec3(0.012, 0.016, 0.030), vec3(0.030, 0.038, 0.072), N.y * 0.5 + 0.5);
  vec3 color = ambient * albedo;

  // --- headlights -----------------------------------------------------------
  for (int i = 0; i < 2; i++) {
    vec3 d = uHeadPos[i] - vWorld;
    float dist = length(d);
    if (dist > uHeadRange) continue;
    vec3 L = d / max(dist, 1e-4);
    float theta = dot(-L, normalize(uHeadDir[i]));
    float cone = clamp((theta - uHeadOuter) / max(1e-4, uHeadInner - uHeadOuter), 0.0, 1.0);
    if (cone <= 0.0) continue;
    // Inverse square, softened near the lamp so it does not blow out.
    float atten = 1.0 / (1.0 + 0.06 * dist + 0.008 * dist * dist);
    atten *= 1.0 - smoothstep(uHeadRange * 0.6, uHeadRange, dist);
    color += shade(N, V, L, uHeadColor * cone * cone * atten, albedo, rough, metal);
  }

  // --- point lights ---------------------------------------------------------
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uNumLights) break;
    vec3 d = uLightPos[i] - vWorld;
    float dist = length(d);
    float r = uLightRange[i];
    if (dist > r) continue;
    vec3 L = d / max(dist, 1e-4);
    float atten = 1.0 / (1.0 + 0.14 * dist + 0.03 * dist * dist);
    atten *= pow(clamp(1.0 - dist / r, 0.0, 1.0), 2.0);
    color += shade(N, V, L, uLightColor[i] * atten, albedo, rough, metal);
  }

  // Emissive surfaces (lamps, tail lights, gauge glass) drive the bloom pass.
  color += albedo * vEmissive;

  // Exponential-squared fog. Night air over a warm road hazes quickly.
  float dist = length(uCamPos - vWorld);
  float fog = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
  color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));

  fragColor = vec4(color, 1.0);
}`;

// ---------------------------------------------------------------------------

export const SKY_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vNdc;
void main(){ vNdc = aPos; gl_Position = vec4(aPos, 1.0, 1.0); }`;

export const SKY_FS = `#version 300 es
precision highp float;
in vec2 vNdc;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uWet;
out vec4 fragColor;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }

void main(){
  vec4 far = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - uCamPos);

  // Night gradient: deep indigo overhead falling to a warm sodium haze where a
  // city sits below the horizon.
  float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 top = vec3(0.008, 0.012, 0.032);
  vec3 mid = vec3(0.020, 0.030, 0.070);
  vec3 horizon = vec3(0.10, 0.075, 0.105);
  vec3 col = mix(mix(horizon, mid, smoothstep(0.48, 0.62, h)), top, smoothstep(0.6, 1.0, h));

  // Sodium glow of a town ahead.
  float glow = pow(clamp(1.0 - abs(dir.y) * 3.2, 0.0, 1.0), 3.0)
             * pow(clamp(dir.z * -1.0, 0.0, 1.0), 2.0);
  col += vec3(0.24, 0.13, 0.05) * glow * (1.0 - 0.6 * uWet);

  // Stars, thinned out by cloud when it is raining.
  if (dir.y > 0.02) {
    vec2 sp = dir.xz / max(0.15, dir.y) * 9.0;
    vec2 cell = floor(sp);
    float r = hash(cell);
    if (r > 0.982) {
      vec2 c = fract(sp) - 0.5;
      float d = 1.0 - smoothstep(0.0, 0.20, length(c));
      float tw = 0.55 + 0.45 * sin(uTime * 1.7 + r * 40.0);
      col += vec3(0.75, 0.82, 1.0) * d * tw * 0.85 * (1.0 - uWet * 0.85)
             * smoothstep(0.02, 0.3, dir.y);
    }
  }
  fragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// Volumetric headlight shafts — a screen-space cone of scattered light.
// ---------------------------------------------------------------------------

export const GOD_VS = SKY_VS;

export const GOD_FS = `#version 300 es
precision highp float;
in vec2 vNdc;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uHeadPos[2];
uniform vec3 uHeadDir[2];
uniform vec3 uHeadColor;
uniform float uHeadOuter;
uniform float uHeadInner;
uniform float uDensity;
uniform float uTime;
out vec4 fragColor;

float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }

void main(){
  vec4 far = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - uCamPos);

  // March a short way down the view ray accumulating in-scatter from the two
  // spotlights. Cheap, but it is what makes headlights read as beams of light
  // in air rather than as painted patches on the tarmac.
  vec3 acc = vec3(0.0);
  const int STEPS = 24;
  float jitter = hash(vec3(gl_FragCoord.xy, uTime));
  for (int s = 0; s < STEPS; s++) {
    float t = (float(s) + jitter) / float(STEPS);
    float dist = t * t * 46.0;                 // bias samples toward the camera
    vec3 p = uCamPos + dir * dist;
    if (p.y > 4.0) continue;                   // no fog well above the road
    float heightFade = exp(-max(0.0, p.y) * 0.55);
    for (int i = 0; i < 2; i++) {
      vec3 d = uHeadPos[i] - p;
      float dl = length(d);
      vec3 L = d / max(dl, 1e-4);
      float theta = dot(-L, normalize(uHeadDir[i]));
      float cone = clamp((theta - uHeadOuter) / max(1e-4, uHeadInner - uHeadOuter), 0.0, 1.0);
      float atten = 1.0 / (1.0 + 0.10 * dl + 0.02 * dl * dl);
      acc += uHeadColor * cone * cone * atten * heightFade;
    }
  }
  acc *= uDensity / float(STEPS);
  fragColor = vec4(acc, 1.0);
}`;

// ---------------------------------------------------------------------------
// Post: bright pass, separable blur, composite
// ---------------------------------------------------------------------------

export const POST_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main(){ vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uThreshold;
out vec4 fragColor;
void main(){
  vec3 c = texture(uTex, vUV).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = max(0.0, l - uThreshold) / max(1e-4, l);
  fragColor = vec4(c * k, 1.0);
}`;

export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uDir;              // texel-sized step, one axis at a time
out vec4 fragColor;
void main(){
  // 9-tap gaussian, linear-sampled so it covers 17 texels for 5 fetches.
  float w[3] = float[](0.2270270270, 0.3162162162, 0.0702702703);
  float o[3] = float[](0.0, 1.3846153846, 3.2307692308);
  vec3 c = texture(uTex, vUV).rgb * w[0];
  for (int i = 1; i < 3; i++) {
    c += texture(uTex, vUV + uDir * o[i]).rgb * w[i];
    c += texture(uTex, vUV - uDir * o[i]).rgb * w[i];
  }
  fragColor = vec4(c, 1.0);
}`;

export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uShafts;
uniform float uExposure;
uniform float uBloomAmt;
uniform float uSpeed;        // 0..1, drives radial blur and aberration
uniform float uTime;
uniform float uShake;
out vec4 fragColor;

// ACES filmic approximation. The tonemap matters more than anything else here:
// headlights are genuinely thousands of times brighter than the tarmac and a
// linear clamp turns every one of them into a flat white disc.
vec3 aces(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main(){
  vec2 uv = vUV;
  vec2 toCentre = uv - 0.5;

  // Radial blur from the centre of the screen, scaled by speed. Cheaper than a
  // velocity buffer and, for forward motion, very close to the same thing.
  vec3 scene = vec3(0.0);
  float amt = uSpeed * 0.022;
  const int TAPS = 6;
  for (int i = 0; i < TAPS; i++) {
    float t = float(i) / float(TAPS - 1);
    vec2 s = uv - toCentre * amt * t;
    // Chromatic aberration grows toward the edges, as a real lens does.
    float ca = (0.0016 + 0.004 * uSpeed) * dot(toCentre, toCentre);
    scene.r += texture(uScene, s + toCentre * ca).r;
    scene.g += texture(uScene, s).g;
    scene.b += texture(uScene, s - toCentre * ca).b;
  }
  scene /= float(TAPS);

  vec3 bloom = texture(uBloom, uv).rgb;
  vec3 shafts = texture(uShafts, uv).rgb;

  vec3 col = scene + bloom * uBloomAmt + shafts;
  col *= uExposure;
  col = aces(col);

  // Vignette, and a little extra darkening under hard shake so impacts read.
  float vig = smoothstep(0.95, 0.25, length(toCentre) * (1.25 + 0.3 * uShake));
  col *= mix(0.55, 1.0, vig);

  // Film grain — also hides banding in the very dark night gradients.
  float g = fract(sin(dot(uv * vec2(1.0 + uTime), vec2(12.9898, 78.233))) * 43758.5453);
  col += (g - 0.5) * 0.022;

  fragColor = vec4(col, 1.0);
}`;
