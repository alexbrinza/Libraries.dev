// InkImageEngine: a loading state for generated images, then the image itself.
//
//   const pic = new InkImageEngine(el, { look: 'printhead', screen: 'color' });
//   pic.think();            // a fine dot grid, shimmering, while it generates
//   pic.progress(0.4);      // optional: the grid fills in as it goes
//   await pic.show(url);    // printed in drops a row at a time, left to right,
//                           // top to bottom, with the real <img> following the
//                           // ink down; or, with look 'passes', grown out of
//                           // the grid, then finer
//
// Every dot is a drop on a 45° halftone screen. In colour, each dot takes the
// size and colour that average to the picture over whatever ground the element
// sits on. In process, the picture is split into screens at their own angles:
// cyan, magenta, yellow and black multiplied on a light ground, red, green and
// blue added on a dark one. The host element sets the size and the corners.

import { BAYER, NEVER, type Program, clamp, compile, createLoop, devicePixelRatioCapped, ensureStyle, parseRgba, reducedMotion, rng } from './gl';
import { DOT_FS, DOT_VS, HEAD_FS, HEAD_VS } from './image-shaders';

/** How the picture is printed. */
export type InkImageLook = 'printhead' | 'rain' | 'fall' | 'passes';
/** Colour dots averaged over the ground, or separate process inks. */
export type InkImageScreen = 'color' | 'process';

export interface InkImageOptions {
  /** How the picture is printed. @default 'printhead' */
  look?: InkImageLook;
  /** `color`: one screen of coloured dots. `process`: CMYK on light grounds, RGB on dark ones. @default 'color' */
  screen?: InkImageScreen;
  /** Pitch of the generating grid in CSS px; 0 picks one from the size. The picture prints at half of it. @default 0 */
  pitch?: number;
  /** Alt text for the image. @default '' */
  alt?: string;
  /** Passed to the <img>; set it for cross-origin images served with CORS headers. */
  crossOrigin?: '' | 'anonymous' | 'use-credentials';
  /** Seed for the drops' randomness, so a print can be replayed exactly. */
  seed?: number;
}

export const IMAGE_LOOKS: InkImageLook[] = ['printhead', 'rain', 'fall', 'passes'];
export const IMAGE_SCREENS: InkImageScreen[] = ['color', 'process'];

const F = 16; // floats per dot

const CSS_IMAGE = `
.ink-image { position: relative; overflow: hidden; isolation: isolate; }
.ink-image > canvas, .ink-image > img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.ink-image > img { object-fit: cover; opacity: 0; transition: opacity 0.6s ease; }
.ink-image > img.ink-image-on { opacity: 1; }
.ink-image > img.ink-image-masked { opacity: 1; transition: none; }
`;

const loop = createLoop<InkImageEngine>();

type RGB = [number, number, number];
interface LatticeDot {
  x: number;
  y: number;
  rank: number;
}
interface Drop {
  t: number;
  fl: number;
  z: number;
  fx: number;
  fy: number;
}

// dots on a halftone screen turned by deg, covering a w × h box
function lattice(w: number, h: number, pitch: number, deg: number): LatticeDot[] {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const us: number[] = [];
  const vs: number[] = [];
  for (const [x, y] of [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h]
  ]) {
    us.push((x * c + y * s) / pitch);
    vs.push((-x * s + y * c) / pitch);
  }
  const out: LatticeDot[] = [];
  for (let i = Math.floor(Math.min(...us)) - 1; i <= Math.ceil(Math.max(...us)) + 1; i++) {
    for (let j = Math.floor(Math.min(...vs)) - 1; j <= Math.ceil(Math.max(...vs)) + 1; j++) {
      const x = (i * c - j * s) * pitch;
      const y = (i * s + j * c) * pitch;
      if (x < -pitch / 2 || y < -pitch / 2 || x > w + pitch / 2 || y > h + pitch / 2) continue;
      out.push({ x, y, rank: BAYER[(j & 3) * 4 + (i & 3)] });
    }
  }
  return out;
}

// a dot list with its own buffer and vertex array
class Dots {
  a = new Float32Array(1024 * F);
  n = 0;
  dirty = true;
  private buf: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;

  constructor(
    private gl: WebGL2RenderingContext | null,
    quad: WebGLBuffer | null
  ) {
    if (!gl) return;
    this.buf = gl.createBuffer();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, F * 4, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    gl.bindVertexArray(null);
  }

  push(v: ArrayLike<number>) {
    if ((this.n + 1) * F > this.a.length) {
      const a = new Float32Array(this.a.length * 2);
      a.set(this.a);
      this.a = a;
    }
    this.a.set(v, this.n * F);
    this.n++;
    this.dirty = true;
  }

  clear() {
    this.n = 0;
    this.dirty = true;
  }

  draw() {
    const gl = this.gl;
    if (!this.n || !gl) return;
    if (this.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, this.a.subarray(0, this.n * F), gl.DYNAMIC_DRAW);
      this.dirty = false;
    }
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
  }
}

type Amount = (a: number, b: number, c: number, d: number) => number;
// screens for process printing: angle, ink, and how much of it a pixel wants
const CMYK: { deg: number; ink: RGB; amt: Amount }[] = [
  { deg: 15, ink: [0.0, 0.66, 0.92], amt: (c) => c },
  { deg: 75, ink: [0.92, 0.12, 0.55], amt: (_c, m) => m },
  { deg: 0, ink: [1.0, 0.92, 0.1], amt: (_c, _m, y) => y },
  { deg: 45, ink: [0.12, 0.12, 0.14], amt: (_c, _m, _y, k) => k }
];
const RGB_SCREENS: { deg: number; ink: RGB; amt: Amount }[] = [
  { deg: 15, ink: [1, 0.1, 0.08], amt: (r) => r },
  { deg: 75, ink: [0.1, 1, 0.2], amt: (_r, g) => g },
  { deg: 45, ink: [0.12, 0.25, 1], amt: (_r, _g, b) => b }
];

interface GLState {
  gl: WebGL2RenderingContext;
  prog: Program;
  head: Program;
  emptyVao: WebGLVertexArrayObject | null;
  quad: WebGLBuffer | null;
}

function setupGL(canvas: HTMLCanvasElement): GLState | null {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  try {
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    return { gl, prog: compile(gl, DOT_VS, DOT_FS), head: compile(gl, HEAD_VS, HEAD_FS), emptyVao: gl.createVertexArray(), quad };
  } catch {
    return null;
  }
}

export class InkImageEngine {
  readonly host: HTMLElement;
  /** The real image; it stays in the host once printing is done. */
  readonly img: HTMLImageElement;
  /** True once the picture is fully shown and the canvas is gone. */
  done = false;

  private o: Required<Omit<InkImageOptions, 'seed' | 'crossOrigin'>>;
  private reduced: boolean;
  private canvas: HTMLCanvasElement;
  private g: GLState | null;
  private color: Dots; // the generating grid and colour dots, drawn over
  private inks: Dots; // process screens, multiplied or added
  private rand: () => number;
  private clock = 0;
  private lit = 0;
  private p = -1;
  private thinkAt = -1;
  private arrived = -1;
  private colorAge = 99;
  private ink: RGB = [1, 1, 1];
  private bg: RGB | null = null;
  private dark = false;
  private inkMode = 0;
  private w = 0;
  private h = 0;
  private grid = 7;
  private visible = true;
  private resized = false;
  private rows: { from: number; n: number; bh: number; bd: number; step: number } | null = null;
  private plan: { start: number; n: number; bh: number; bd: number; step: number } | null = null;
  private bands: { n: number; bh: number; bd: number; step: number; t0: number } | null = null;
  private revealAt = 0;
  private endAt = 0;
  private shown: Promise<void> | null = null;
  private shownResolve: (() => void) | null = null;
  private ro: ResizeObserver;
  private io: IntersectionObserver;

  constructor(host: HTMLElement, opts: InkImageOptions = {}) {
    ensureStyle('ink-image', CSS_IMAGE);
    this.o = { look: 'printhead', screen: 'color', pitch: 0, alt: '' };
    this.set(opts);
    this.host = host;
    host.textContent = '';
    host.classList.add('ink-image');
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.img = document.createElement('img');
    this.img.alt = this.o.alt;
    this.img.decoding = 'async';
    if (opts.crossOrigin !== undefined) this.img.crossOrigin = opts.crossOrigin;
    host.append(this.canvas, this.img);
    this.g = setupGL(this.canvas);
    // without WebGL2 (or with reduced motion) the picture simply fades in
    this.reduced = reducedMotion() || !this.g;
    this.color = new Dots(this.g?.gl ?? null, this.g?.quad ?? null);
    this.inks = new Dots(this.g?.gl ?? null, this.g?.quad ?? null);
    this.rand = rng(opts.seed ?? (Math.random() * 1e9) | 0);
    this.measure();
    this.ro = new ResizeObserver(() => {
      this.resized = true;
    });
    this.ro.observe(host);
    this.io = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
    });
    this.io.observe(host);
    loop.add(this);
  }

  // ---------- public ----------

  /** Show the generating dot grid. */
  think(): void {
    if (this.thinkAt >= 0 || this.arrived >= 0 || !this.g) return;
    this.thinkAt = this.clock;
    this.skeleton();
  }

  /** Optional 0–1 progress: the grid fills in as it rises. */
  progress(p: number): void {
    this.p = clamp(p, 0, 1);
  }

  /** Print the picture. Resolves once the real image is fully showing. */
  async show(src: string | Blob | HTMLImageElement): Promise<void> {
    if (this.arrived >= 0) return this.shown ?? undefined;
    const img = this.img;
    img.src = src instanceof Blob ? URL.createObjectURL(src) : typeof src === 'string' ? src : src.src;
    try {
      await img.decode();
    } catch {
      // a broken or undecodable image: fall through and show whatever the browser has
    }
    if (this.done) return;
    this.arrived = this.clock;
    this.shown = new Promise((r) => {
      this.shownResolve = r;
    });
    if (this.reduced || !img.naturalWidth) {
      this.fadeIn();
      return this.shown;
    }
    if (this.thinkAt < 0) {
      this.thinkAt = this.clock;
      this.skeleton();
      this.lit = 16;
    }
    try {
      this.print();
    } catch {
      // a cross-origin image without CORS can't be read back: just fade it in
      this.color.clear();
      this.inks.clear();
      this.fadeIn();
    }
    return this.shown;
  }

  /** Change options live; look and screen apply to the next `show()`. */
  set(opts: InkImageOptions): void {
    for (const k of ['look', 'screen', 'pitch', 'alt'] as const) {
      const v = opts[k];
      if (v !== undefined) (this.o as Record<string, unknown>)[k] = v;
    }
  }

  /** Stop animating and drop the canvas; the image (if any) stays. */
  destroy(): void {
    if (this.done) return;
    loop.delete(this);
    this.ro.disconnect();
    this.io.disconnect();
    this.g?.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
    this.done = true;
    this.shownResolve?.();
  }

  // ---------- geometry ----------

  private get dpr() {
    return devicePixelRatioCapped();
  }

  private fadeIn() {
    this.img.classList.add('ink-image-on');
    window.setTimeout(() => this.destroy(), 650);
  }

  private measure() {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const changed = w !== this.w || h !== this.h;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    // the generating grid; the picture prints on a screen half as fine
    this.grid = this.o.pitch || clamp(Math.min(w, h) / 56, 5.5, 9);
    if (changed && this.thinkAt >= 0 && this.arrived < 0) this.skeleton();
  }

  // the ground the dots sit on: the first background behind the host
  private ground(): RGB {
    for (let el: HTMLElement | null = this.host; el; el = el.parentElement) {
      const c = parseRgba(getComputedStyle(el).backgroundColor);
      if (c[3] > 0.5) return [c[0], c[1], c[2]];
    }
    return [1, 1, 1];
  }

  private skeleton() {
    this.color.clear();
    for (const c of lattice(this.w, this.h, this.grid, 0)) {
      // x, y, radius, fire | from | colour, kind | fade, fade dur, morph, rank
      this.color.push([c.x, c.y, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, NEVER, 0.3, NEVER, c.rank]);
    }
  }

  // the picture averaged over cells of a pitch, as a small canvas to read from
  private sampler(pitch: number): (x: number, y: number) => RGB {
    const W = Math.max(2, Math.round(this.w / pitch));
    const H = Math.max(2, Math.round(this.h / pitch));
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('inkjet-fx: no 2D canvas');
    ctx.imageSmoothingQuality = 'high';
    // object-fit: cover
    const img = this.img;
    const s = Math.max(this.w / img.naturalWidth, this.h / img.naturalHeight);
    const sw = this.w / s;
    const sh = this.h / s;
    ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    return (x, y) => {
      const i = (clamp(Math.floor((y / this.h) * H), 0, H - 1) * W + clamp(Math.floor((x / this.w) * W), 0, W - 1)) * 4;
      return [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
    };
  }

  // the dot that averages to colour p over ground b: how much of the cell it
  // covers, and its colour
  private dotFor(p: RGB, b: RGB): { A: number; c: RGB } | null {
    let A = 0;
    for (let k = 0; k < 3; k++) {
      const need = p[k] > b[k] ? (p[k] - b[k]) / Math.max(1e-3, 1 - b[k]) : (b[k] - p[k]) / Math.max(1e-3, b[k]);
      A = Math.max(A, need);
    }
    A = clamp(A, 0, 1);
    if (A < 0.015) return null;
    return { A, c: [0, 1, 2].map((k) => clamp(b[k] + (p[k] - b[k]) / A, 0, 1)) as RGB };
  }

  // ---------- printing ----------

  private print() {
    const t0 = this.clock;
    const b = this.ground();
    this.bg = b;
    this.dark = b[0] * 0.3 + b[1] * 0.59 + b[2] * 0.11 < 0.5;
    this.inkMode = this.o.screen === 'process' ? (this.dark ? 2 : 1) : 0;
    if (this.o.look === 'passes') this.printPasses(t0);
    else this.printRows(t0);
    this.color.dirty = true;
    this.inks.dirty = true;
  }

  // the dots of one screen pitch (colour, or the process screens), each timed by
  // when(x, y, rank) and given a fade by fadeAt(x, y)
  private screenDots(pitch: number, when: (x: number, y: number, rank: number) => Drop, fadeAt: (x: number, y: number) => [number, number]) {
    const W = this.w;
    const H = this.h;
    const b = this.bg ?? this.ground();
    const process = this.inkMode > 0;
    const sample = this.sampler(pitch);
    const list = process ? this.inks : this.color;
    let lastLand = 0;
    const screens = process ? (this.dark ? RGB_SCREENS : CMYK) : [{ deg: 45, ink: [0, 0, 0] as RGB, amt: () => 0 }];
    for (const scr of screens) {
      for (const c of lattice(W, H, pitch, scr.deg)) {
        if (c.x < 0 || c.y < 0 || c.x > W || c.y > H) continue;
        const p = sample(c.x, c.y);
        let A: number;
        let col: RGB;
        if (process) {
          if (this.dark) A = scr.amt(p[0], p[1], p[2], 0);
          else {
            const cy = 1 - p[0];
            const mg = 1 - p[1];
            const yl = 1 - p[2];
            const kk = Math.min(cy, mg, yl) * 0.85;
            A = scr.amt(cy - kk, mg - kk, yl - kk, kk);
          }
          col = scr.ink;
          if (A < 0.02) continue;
        } else {
          const dot = this.dotFor(p, b);
          if (!dot) continue;
          A = dot.A;
          col = dot.c;
        }
        const w = when(c.x, c.y, c.rank);
        const [ft, fd] = fadeAt(c.x, c.y);
        lastLand = Math.max(lastLand, w.t + w.fl);
        list.push([c.x, c.y, pitch * Math.sqrt(clamp(A, 0, 1) / Math.PI) * (process ? 1.15 : 1), w.t, w.fx, w.fy, w.fl, w.z, col[0], col[1], col[2], 0, ft, fd, 0, 0]);
      }
    }
    return { list, lastLand };
  }

  // like a page of text: the head prints a row at a time, left to right, top to
  // bottom; the grid under it is wiped as it goes, and the real picture
  // follows the ink down, row by row, once it has soaked in
  private printRows(t0: number) {
    const W = this.w;
    const H = this.h;
    const rand = this.rand;
    const look = this.o.look;
    const n = Math.max(4, Math.round(H / 36));
    const bh = H / n;
    const bd = 0.26;
    const step = bd + 0.04;
    const start = t0 + 0.08;
    const row = (y: number) => clamp(Math.floor(y / bh), 0, n - 1);
    const at = (x: number, y: number) => start + row(y) * step + clamp(x / W, 0, 1) * bd;
    const lag = look === 'printhead' ? 0.4 : look === 'rain' ? 0.6 : 0.75;
    const shownAt = (x: number, y: number) => start + lag + row(y) * step + clamp((x + 24) / W, 0, 1) * bd;

    const a = this.color.a;
    const wipe = look === 'printhead' ? 0.03 : 0.2;
    for (let k = 0; k < this.color.n; k++) {
      const o = k * F;
      a[o + 12] = at(a[o], a[o + 1]) + wipe;
      a[o + 13] = 0.15;
    }
    const when = (x: number, y: number, rank: number): Drop => {
      const t = at(x, y);
      if (look === 'rain') {
        const seen = rand() < 0.35;
        const h = seen ? 16 + rand() * rand() * 60 : 0;
        const fl = seen ? 0.1 + h / 420 : 0.07;
        return { t: t + rand() * 0.1 - fl * 0.5, fl, z: seen ? 1 : 2.4, fx: 0, fy: -h };
      }
      if (look === 'fall') {
        const fl = 0.28 + rand() * 0.14;
        return { t: t - fl * 0.6 + rand() * 0.06, fl, z: 1.8 + rand() * 1.4, fx: (rand() - 0.5) * 24, fy: -(24 + rand() * 48) };
      }
      // nozzles fire just behind the head in dither order, so the front is stipple
      return { t: t + ((rank / 16) * 0.75 + rand() * 0.25) * 0.07, fl: 0.08, z: 3, fx: -6, fy: 0 };
    };
    this.screenDots(this.grid / 2, when, (x, y) => [shownAt(x, y) + 0.05, 0.3]);
    this.rows = { from: start + lag, n, bh, bd, step };
    this.plan = { start, n, bh, bd, step };
    this.bands = look === 'printhead' ? { n, bh, bd, step, t0: start } : null;
    this.endAt = start + lag + n * step + 0.5;
    this.img.classList.add('ink-image-masked');
    this.setMask(0, 0);
  }

  // the grid's dots grow into the picture, a finer screen prints over it, and
  // the real picture fades in over the whole of it
  private printPasses(t0: number) {
    const W = this.w;
    const H = this.h;
    const rand = this.rand;
    const b = this.bg ?? this.ground();
    const sweep = (x: number, y: number) => (x / W) * 0.6 + (y / H) * 0.4;
    const s0 = this.sampler(this.grid);
    const a = this.color.a;
    const start = t0 + 0.7;
    for (let k = 0; k < this.color.n; k++) {
      const o = k * F;
      const dot = this.dotFor(s0(a[o], a[o + 1]), b);
      const d = sweep(a[o], a[o + 1]);
      a[o + 2] = dot ? this.grid * Math.sqrt(dot.A / Math.PI) : 0;
      if (dot) a.set(dot.c, o + 8);
      a[o + 14] = t0 + 0.05 + d * 0.55 + rand() * 0.03;
      // each screen goes as the finer one over it lands
      a[o + 12] = start + 0.15 + d * 0.55;
      a[o + 13] = 0.35;
    }
    const when = (x: number, y: number, rank: number): Drop => ({ t: start + sweep(x, y) * 0.55 + (rank / 16) * 0.12 + rand() * 0.02, fl: 0.1, z: 2.6, fx: -4, fy: 0 });
    const r = this.screenDots(this.grid / 2, when, () => [NEVER, 0.3]);
    this.revealAt = r.lastLand + 0.35;
    for (const list of [this.color, this.inks]) {
      for (let k = 0; k < list.n; k++) {
        const o = k * F;
        if (list.a[o + 12] === NEVER) {
          list.a[o + 12] = this.revealAt + 0.6;
          list.a[o + 13] = 0.3;
        }
      }
    }
    this.endAt = this.revealAt + 1.0;
  }

  // the part of the real picture that shows: every row above, and the current
  // row up to x, with a soft leading edge
  private setMask(top: number, x: number) {
    const s = this.img.style;
    const bh = this.rows ? this.rows.bh : 0;
    const image = `linear-gradient(#000, #000), linear-gradient(to right, #000 ${x - 24}px, transparent ${x}px)`;
    // the rows overlap by a pixel so no hairline shows where they meet
    const size = `100% ${top + 1}px, 100% ${bh + 1.5}px`;
    const pos = `0 0, 0 ${Math.max(0, top - 0.5)}px`;
    for (const p of ['', '-webkit-']) {
      s.setProperty(`${p}mask-image`, image);
      s.setProperty(`${p}mask-size`, size);
      s.setProperty(`${p}mask-position`, pos);
      s.setProperty(`${p}mask-repeat`, 'no-repeat');
    }
  }

  private headAt(t: number): [number, number, number, number] | null {
    const B = this.bands;
    if (!B) return null;
    const k = (t - B.t0) / B.step;
    if (k < 0 || k >= B.n) return null;
    const i = Math.floor(k);
    const u = (t - B.t0 - i * B.step) / B.bd;
    if (u > 1) return null;
    return [u * this.w, i * B.bh, (i + 1) * B.bh, 1];
  }

  // ---------- frame ----------

  /** Advance by dt seconds and draw. Called by the shared animation loop. */
  tick(dt: number): void {
    this.clock += dt;
    if (this.resized) {
      this.resized = false;
      if (this.arrived < 0) this.measure();
    }
    if (++this.colorAge > 20) {
      this.colorAge = 0;
      const c = parseRgba(getComputedStyle(this.host).color);
      this.ink = [c[0], c[1], c[2]];
    }
    // the screen fills in rank by rank: with time, or with the progress given
    if (this.thinkAt >= 0) {
      const age = this.clock - this.thinkAt;
      const target = this.arrived >= 0 ? (this.o.look === 'passes' ? 16 : this.lit) : this.p >= 0 ? 4 + this.p * 10 : Math.min(10, 2 + age * 2.2);
      this.lit += (target - this.lit) * Math.min(1, dt * 3);
    }
    if (this.arrived >= 0) {
      const R = this.rows;
      if (R && this.clock >= R.from) {
        const tau = this.clock - R.from;
        const r = Math.floor(tau / R.step);
        if (r >= R.n) {
          for (const p of ['', '-webkit-']) for (const k of ['mask-image', 'mask-size', 'mask-position', 'mask-repeat']) this.img.style.removeProperty(p + k);
          this.rows = null;
          this.shownResolve?.();
        } else this.setMask(r * R.bh, clamp((tau - r * R.step) / R.bd, 0, 1) * (this.w + 24));
      }
      if (this.revealAt && this.clock >= this.revealAt && !this.img.classList.contains('ink-image-on')) {
        this.img.classList.add('ink-image-on');
        window.setTimeout(() => this.shownResolve?.(), 600);
      }
      if (this.endAt && this.clock >= this.endAt) {
        this.destroy();
        return;
      }
    }
    if (this.thinkAt >= 0 && this.visible) this.draw();
  }

  private draw() {
    const g = this.g;
    if (!g) return;
    const gl = g.gl;
    const dpr = this.dpr;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const b = this.bg || this.ground();
    // inks multiply onto paper: the canvas is the paper there
    if (this.inkMode === 1 && this.inks.n) gl.clearColor(b[0], b[1], b[2], 1);
    else gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    const { p, u } = g.prog;
    gl.useProgram(p);
    gl.uniform1f(u.uTime, this.clock);
    gl.uniform1f(u.uScale, dpr);
    gl.uniform1f(u.uSpread, 0.08);
    gl.uniform1f(u.uShutter, this.o.look === 'fall' ? 1 / 200 : 1 / 120);
    gl.uniform1f(u.uLit, this.lit);
    gl.uniform1f(u.uSweep, this.arrived >= 0 ? -1 : (((this.clock - this.thinkAt) / 2.4) % 1) * 1.6 - 0.3);
    gl.uniform1f(u.uSkelR, Math.max(0.75, this.grid * 0.12));
    gl.uniform1f(u.uSkelA, 0.42);
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uRect, this.w, this.h);
    gl.uniform3fv(u.uSkel, this.ink);
    let pv = [0, 0, 0, 0];
    const P = this.plan;
    if (this.o.look === 'fall' && P) {
      // the eye hangs over the row being printed, a little ahead of the head
      const t = this.clock + 0.1 - P.start;
      const i = clamp(Math.floor(t / P.step), 0, P.n - 1);
      pv = [clamp((t - i * P.step) / P.bd, 0, 1) * this.w, (i + 0.5) * P.bh, Math.max(this.w, this.h) * 1.1, 0.4];
    }
    gl.uniform4f(u.uPersp, pv[0], pv[1], pv[2], pv[3]);
    gl.uniform1i(u.uMode, 0);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.color.draw();
    if (this.inks.n) {
      gl.uniform1i(u.uMode, this.inkMode);
      if (this.inkMode === 1) gl.blendFunc(gl.DST_COLOR, gl.ZERO);
      else gl.blendFunc(gl.ONE, gl.ONE);
      this.inks.draw();
    }
    const h = this.headAt(this.clock);
    if (h) {
      const hp = g.head;
      gl.useProgram(hp.p);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform4f(hp.u.uHead, h[0], h[1], h[2], h[3]);
      gl.uniform3fv(hp.u.uInk, this.ink);
      gl.uniform2f(hp.u.uDev, this.canvas.width, this.canvas.height);
      gl.uniform1f(hp.u.uDpr, dpr);
      gl.bindVertexArray(g.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
  }
}
