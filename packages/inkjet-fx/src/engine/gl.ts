// Shared WebGL2 plumbing for the text and image printers.

/** 4×4 Bayer ranks: the order nozzles fire in, so a print front reads as stipple. */
export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Effectively "never" on an instance's clock, in seconds. */
export const NEVER = 1e6;

export type Uniforms = Record<string, WebGLUniformLocation | null>;
export interface Program {
  p: WebGLProgram;
  u: Uniforms;
}

export function compile(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const p = gl.createProgram();
  if (!p) throw new Error('inkjet-fx: could not create a WebGL program');
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs]
  ] as const) {
    const s = gl.createShader(type);
    if (!s) throw new Error('inkjet-fx: could not create a shader');
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${gl.getShaderInfoLog(s)}\n${src}`);
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link failed');
  const u: Uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    if (info) u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

/** Small seeded PRNG (mulberry32), so a seed replays the same print. */
export function rng(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

/** A CSS rgb()/rgba() string as 0–1 channels plus alpha. */
export function parseRgba(c: string): [number, number, number, number] {
  const m = c.match(/[\d.]+/g);
  if (!m || m.length < 3) return [0, 0, 0, 0];
  return [+m[0] / 255, +m[1] / 255, +m[2] / 255, m[3] === undefined ? 1 : +m[3]];
}

export const reducedMotion = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const devicePixelRatioCapped = (): number => Math.min(window.devicePixelRatio || 1, 2);

/** One stylesheet per id, added to <head> the first time it is needed. */
const styled = new Set<string>();
export function ensureStyle(id: string, css: string): void {
  if (styled.has(id) || typeof document === 'undefined') return;
  styled.add(id);
  const s = document.createElement('style');
  s.dataset.inkjetFx = id;
  s.textContent = css;
  document.head.append(s);
}

/**
 * One requestAnimationFrame loop per kind of instance; it stops when the last
 * instance goes, and dt is capped so a tab coming back doesn't jump.
 */
export function createLoop<T extends { tick(dt: number): void }>() {
  const instances = new Set<T>();
  let last = 0;
  let running = false;
  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    for (const it of instances) it.tick(dt);
    if (instances.size) requestAnimationFrame(frame);
    else running = false;
  };
  return {
    add(it: T) {
      instances.add(it);
      if (!running) {
        running = true;
        last = performance.now();
        requestAnimationFrame(frame);
      }
    },
    delete(it: T) {
      instances.delete(it);
    }
  };
}
