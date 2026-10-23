// Shaders for the image printer: one instanced dot pass (drops, the generating
// grid, process screens) and a fullscreen pass for the printhead.

export const DOT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 a0; // x, y, radius (css px), fire time
layout(location=2) in vec4 a1; // from dx, from dy, flight time, start scale
layout(location=3) in vec4 a2; // colour, kind (0 drop, 1 skeleton)
layout(location=4) in vec4 a3; // fade time, fade duration, morph time, rank
uniform float uTime, uScale, uSpread, uShutter, uLit, uSweep, uSkelR, uSkelA;
uniform vec2 uRes, uRect;
uniform vec3 uSkel;
uniform vec4 uPersp; // eye x, y (css), distance (0 = flat), pull towards the eye
out vec2 vL;
out vec4 vP;
out vec4 vC;
const vec4 HIDE = vec4(2.0, 2.0, 2.0, 1.0);
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + 1.0), f.x), f.y), f.z);
}
vec3 fall3(float u) {
  float s = u * (0.3 + 0.7 * u);
  float z0 = uPersp.z * (1.0 - 1.0 / max(a1.w, 1.0));
  return vec3(a0.xy + a1.xy * (1.0 - s), z0 * (1.0 - s));
}
vec2 project(vec3 w) {
  vec2 v = mix(a0.xy, uPersp.xy, uPersp.w);
  return v + (w.xy - v) * uPersp.z / (uPersp.z - w.z);
}
void main() {
  float fade = 1.0 - smoothstep(a3.x, a3.x + a3.y, uTime);
  if (fade <= 0.0) { gl_Position = HIDE; return; }
  vec3 col = a2.rgb;
  float alpha = 1.0;
  float r;
  float soft = 0.5;
  vec2 pos = a0.xy;
  vec2 vel = vec2(0.0);
  if (a2.w > 0.5) {
    // the skeleton: a fine, even dot grid that fills in rank by rank; it lives
    // by brightness only (a little noise, a soft sweep passing over it), and
    // when the picture arrives each dot can grow into the picture's own dot
    float ap = clamp(uLit - a3.w, 0.0, 1.0);
    float n = noise3(vec3(pos / 70.0, uTime * 0.12)) * 0.65 + noise3(vec3(pos / 26.0 + 7.0, uTime * 0.2)) * 0.35;
    n = smoothstep(0.22, 0.85, n);
    float d = (pos.x / uRect.x) * 0.6 + (pos.y / uRect.y) * 0.4;
    float band = exp(-(d - uSweep) * (d - uSweep) / 0.004);
    float m = smoothstep(a3.z, a3.z + 0.45, uTime);
    r = mix(uSkelR * ap * (1.0 + 0.25 * band), a0.z, m);
    col = mix(uSkel, a2.rgb, m);
    alpha = mix(uSkelA * (0.55 + 0.45 * n) * (1.0 + 1.3 * band), 1.0, m);
  } else {
    float age = uTime - a0.w;
    float fl = max(a1.z, 1e-4);
    if (age < 0.0) { gl_Position = HIDE; return; }
    if (age < fl) {
      float u = age / fl;
      float sc;
      if (uPersp.z > 0.0) {
        vec3 w = fall3(u);
        pos = project(w);
        vel = (pos - project(fall3(max(u - 0.02, 0.0)))) / (0.02 * fl);
        sc = 1.0 + (uPersp.z / (uPersp.z - w.z) - 1.0) * 1.6;
        alpha = mix(0.12, 1.0, u * u);
        soft = 0.5 + (sc - 1.0) * a0.z * uScale * 0.2;
      } else {
        pos = a0.xy + vec2(a1.x * (1.0 - u), a1.y * (1.0 - u * u));
        vel = vec2(-a1.x, -2.0 * a1.y * u) / fl;
        sc = mix(a1.w, 1.0, u);
        alpha = a1.w > 1.01 ? mix(0.1, 1.0, u * u) : 1.0;
      }
      r = a0.z * 0.7 * sc;
    } else {
      // the splat, then a little soaking in
      float la = age - fl;
      r = a0.z * (1.0 - 0.4 * exp(-la * 24.0) * cos(la * 40.0)) * (1.0 + uSpread * (1.0 - exp(-la / 0.45)));
    }
  }
  r *= mix(0.4, 1.0, fade) * uScale;
  alpha *= fade;
  if (r <= 0.05) { gl_Position = HIDE; return; }
  if (r < 0.6) { alpha *= r / 0.6; r = 0.6; }
  vec2 s = vel * uScale * uShutter;
  float L = length(s);
  vec2 ax = L > 0.01 ? s / L : vec2(1.0, 0.0);
  alpha *= mix(1.0, 2.0 * r / (2.0 * r + L), 0.6);
  vec2 c = pos * uScale - s * 0.5;
  vec2 hs = vec2(L * 0.5 + r + soft + 1.0, r + soft + 1.0);
  vL = aCorner * hs;
  vP = vec4(L * 0.5, r, soft, 0.0);
  vC = vec4(col, alpha);
  vec2 p = c + ax * vL.x + vec2(-ax.y, ax.x) * vL.y;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}`;

export const DOT_FS = `#version 300 es
precision highp float;
in vec2 vL;
in vec4 vP;
in vec4 vC;
uniform int uMode; // 0 over, 1 multiply (inks on a light ground), 2 add (light on a dark one)
out vec4 o;
void main() {
  float d = length(vec2(max(abs(vL.x) - vP.x, 0.0), vL.y)) - vP.y;
  float cov = (1.0 - smoothstep(-vP.z, vP.z, d)) * vC.a;
  if (uMode == 1) o = vec4(mix(vec3(1.0), vC.rgb, cov), 1.0);
  else o = vec4(vC.rgb * cov, cov);
}`;

export const HEAD_VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const HEAD_FS = `#version 300 es
precision highp float;
uniform vec4 uHead; // x, y0, y1 (css), alpha
uniform vec3 uInk;
uniform vec2 uDev;
uniform float uDpr;
out vec4 o;
void main() {
  vec2 css = vec2(gl_FragCoord.x, uDev.y - gl_FragCoord.y) / uDpr;
  float dx = abs(css.x - uHead.x);
  float yin = smoothstep(uHead.y - 3.0, uHead.y + 3.0, css.y) * (1.0 - smoothstep(uHead.z - 3.0, uHead.z + 3.0, css.y));
  float a = (clamp(1.0 - dx * uDpr * 0.8, 0.0, 1.0) * 0.6 + exp(-dx * dx / 70.0) * 0.12) * yin * uHead.w;
  o = vec4(uInk * a, a);
}`;
