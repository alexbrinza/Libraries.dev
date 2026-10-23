// Shaders for the text printer.
//
// Field pass: landed drops add a gaussian into a float target
//   r = coverage, g = coverage × dryness, b = coverage × wetness, a = drops in flight.
// Composite: the r channel is thresholded so neighbouring drops fuse into
// strokes; drying drops fade out, because by then the real word shows on top.

const ATTRS = `
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 a0;   // x, y, radius (css px), fire time
layout(location=2) in vec4 a1;   // from dx, from dy, flight time, fade duration
layout(location=3) in vec4 a2;   // dry time, fade time, start scale, kind
uniform float uTime, uScale;
uniform vec2 uOff, uRes;
vec4 place(vec2 p) { return vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0); }
const vec4 HIDE = vec4(2.0, 2.0, 2.0, 1.0);
`;

export const FIELD_VS = `#version 300 es
precision highp float;
${ATTRS}
uniform float uSpread, uSpreadTau, uBleed, uSettle, uDryDur, uWetTau;
out vec2 vK;
out vec3 vW;
void main() {
  float age = uTime - a0.w - a1.z;
  float fade = 1.0 - smoothstep(a2.y, a2.y + a1.w, uTime);
  if (age < 0.0 || fade <= 0.0 || a0.z <= 0.0) { gl_Position = HIDE; return; }
  // the splat: arrives small, swells past its size, settles back
  float impact = 1.0 - 0.45 * exp(-age * 24.0) * cos(age * 40.0);
  // the soak: spreads into the paper
  float soak = 1.0 + uSpread * (1.0 - exp(-age / uSpreadTau)) + uBleed;
  float r = a0.z * impact * soak * mix(0.25, 1.0, fade) * uScale;
  float amp = fade;
  if (r < 0.6) { amp *= r * r / 0.36; r = 0.6; }
  float dry = smoothstep(a2.x, a2.x + uDryDur, uTime) * uSettle * fade * fade;
  float wet = exp(-age / max(uWetTau, 0.05));
  vK = aCorner * 2.2;
  vW = vec3(amp, dry, wet);
  gl_Position = place((a0.xy - uOff) * uScale + vK * r);
}`;

export const FIELD_FS = `#version 300 es
precision highp float;
in vec2 vK;
in vec3 vW;
out vec4 o;
void main() {
  float k = exp(-dot(vK, vK)) * vW.x;
  o = vec4(k, k * vW.y, k * vW.z, 0.0);
}`;

export const FLIGHT_VS = `#version 300 es
precision highp float;
${ATTRS}
uniform float uShutter, uRing, uRingGrow, uRingDur;
uniform vec4 uPersp; // vanishing point (css px), eye distance (0 keeps the flat paths), and how far
                     // each drop's own vanishing point is pulled from its landing spot to the eye
out vec2 vL;
out vec4 vP;
// 3D fall: starts above the page (from dx, dy) and near the eye (start scale),
// speeds up on the way down and lands on its dot
vec3 fall3(float u) {
  float s = u * (0.3 + 0.7 * u);
  float z0 = uPersp.z * (1.0 - 1.0 / max(a2.z, 1.0));
  return vec3(a0.xy + a1.xy * (1.0 - s), z0 * (1.0 - s));
}
vec2 project(vec3 w) {
  vec2 v = vec2(mix(a0.x, uPersp.x, uPersp.w), uPersp.y);
  return v + (w.xy - v) * uPersp.z / (uPersp.z - w.z);
}
void main() {
  float age = uTime - a0.w;
  float fl = max(a1.z, 1e-4);
  float fade = 1.0 - smoothstep(a2.y, a2.y + a1.w, uTime);
  if (age < 0.0 || age > fl + uRingDur || fade <= 0.0 || a0.z <= 0.0) { gl_Position = HIDE; return; }
  vec2 c, hs, ax = vec2(1.0, 0.0);
  if (age < fl) {
    float u = age / fl;
    vec2 pos, vel;
    float sc, alpha;
    if (uPersp.z > 0.0) {
      vec3 w = fall3(u);
      pos = project(w);
      vel = (pos - project(fall3(max(u - 0.02, 0.0)))) / (0.02 * fl);
      sc = uPersp.z / (uPersp.z - w.z);
      sc = 1.0 + (sc - 1.0) * 1.6; // drops near the eye read a little bigger than strict scale
      alpha = mix(0.1, 1.0, u * u);
    } else {
      // flat: falls (dy) or comes down towards the paper (start scale > 1)
      pos = a0.xy + vec2(a1.x * (1.0 - u), a1.y * (1.0 - u * u));
      vel = vec2(-a1.x, -2.0 * a1.y * u) / fl;
      sc = mix(a2.z, 1.0, u);
      alpha = a2.z > 1.01 ? mix(0.08, 1.0, u * u) : 1.0;
    }
    float rd = a0.z * 0.62 * sc * uScale;
    if (rd < 0.6) { alpha *= rd / 0.6; rd = 0.6; }
    // out of focus while it is still near the eye
    float soft = 0.5 + (sc - 1.0) * rd * 0.35 * step(0.0, uPersp.z - 1.0);
    vec2 s = vel * uScale * uShutter;
    float L = length(s);
    if (L > 0.01) ax = s / L;
    alpha *= mix(1.0, 2.0 * rd / (2.0 * rd + L), 0.6);
    c = (pos - uOff) * uScale - s * 0.5;
    hs = vec2(L * 0.5 + rd + soft + 1.0, rd + soft + 1.0);
    vP = vec4(L * 0.5, rd, alpha * fade, -soft);
  } else {
    // just landed: a faint crown ring runs out and fades
    float ra = (age - fl) / uRingDur;
    float rr = a0.z * uScale * (1.1 + uRingGrow * ra);
    float th = max(0.5, a0.z * uScale * 0.16);
    c = (a0.xy - uOff) * uScale;
    hs = vec2(rr + th + 1.0);
    vP = vec4(rr, th, (1.0 - ra) * (1.0 - ra) * uRing * fade * step(a2.w, 0.5), 1.0);
  }
  vL = aCorner * hs;
  gl_Position = place(c + ax * vL.x + vec2(-ax.y, ax.x) * vL.y);
}`;

export const FLIGHT_FS = `#version 300 es
precision highp float;
in vec2 vL;
in vec4 vP;
out vec4 o;
void main() {
  // drops carry their softness in w (negative), rings are w = 1
  float d = vP.w < 0.5
    ? length(vec2(max(abs(vL.x) - vP.x, 0.0), vL.y)) - vP.y
    : abs(length(vL) - vP.x) - vP.y;
  float soft = vP.w < 0.5 ? -vP.w : 0.5;
  o = vec4(0.0, 0.0, 0.0, (1.0 - smoothstep(-soft, soft, d)) * vP.z);
}`;

export const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Transparent composite of the drops still in play, premultiplied over the page.
export const COMP_FS = `#version 300 es
precision highp float;
uniform sampler2D uField;
uniform vec2 uCss, uDev;
uniform float uDpr, uGlow, uRough, uThresh, uBandTop, uBandH, uHasBand;
uniform vec3 uInk;
uniform vec4 uHead;
out vec4 o;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + 1.0), f.x), f.y);
}
void main() {
  vec2 css = vec2(gl_FragCoord.x, uDev.y - gl_FragCoord.y) / uDpr;
  vec2 buv = vec2(css.x / uCss.x, (css.y - uBandTop) / uBandH);
  float inBand = uHasBand * step(0.0, buv.y) * step(buv.y, 1.0);
  vec4 f = textureLod(uField, clamp(buv, 0.0, 1.0), 0.0) * inBand;
  // the edge of the ink wanders with the paper's fibres
  float n = vnoise(css * 1.7) * 0.65 + vnoise(css * 4.3) * 0.35;
  float T = uThresh * (1.0 + (n - 0.5) * uRough);
  // the field is bumpy, so its gradient overstates the edge: cap the soft band
  float aa = clamp(fwidth(f.r) * 0.6, 0.02, 0.18);
  float dots = smoothstep(T - aa, T + aa, f.r);
  float dry = clamp(f.g / max(f.r, 1e-4), 0.0, 1.0);
  float ink = dots * (1.0 - dry);
  ink = 1.0 - (1.0 - ink) * (1.0 - clamp(f.a, 0.0, 1.0));
  // fresh ink glows for a moment
  float glow = 0.0;
  if (uGlow > 0.0 && inBand > 0.0) {
    glow = (textureLod(uField, buv, 3.0).b * 0.55 + textureLod(uField, buv, 5.0).b * 0.45) * uGlow * 0.35;
  }
  // the printhead
  float head = 0.0;
  if (uHead.w > 0.0) {
    float dx = abs(css.x - uHead.x);
    float yin = smoothstep(uHead.y - 3.0, uHead.y + 3.0, css.y) * (1.0 - smoothstep(uHead.z - 3.0, uHead.z + 3.0, css.y));
    head = (clamp(1.0 - dx * uDpr * 0.8, 0.0, 1.0) * 0.6 + exp(-dx * dx / 70.0) * 0.1) * yin * uHead.w;
  }
  float a = 1.0 - (1.0 - ink) * (1.0 - clamp(glow + head, 0.0, 1.0));
  o = vec4(uInk * a, a);
}`;
