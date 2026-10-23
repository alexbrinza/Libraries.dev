// InkTextEngine: streaming text that prints itself in droplets, then is plain text.
//
//   const ink = new InkTextEngine(el, { look: 'printhead', thinking: 'caret' });
//   ink.think();
//   for await (const chunk of stream) ink.write(chunk);
//   await ink.end();
//
// The words are real DOM text in the host's own font and CSS (selectable,
// copyable, read by screen readers), kept transparent at first. A canvas
// behind them prints each word in drops as it arrives; as the ink dries the
// real word is revealed on top (a CSS custom highlight) and its drops fade out
// underneath. Only drops still in play are drawn, so a long answer costs no
// more per frame than a short one, and when the answer is done the canvas and
// its WebGL context go away, leaving ordinary text.

import { BAYER, NEVER, type Program, clamp, compile, createLoop, devicePixelRatioCapped, ensureStyle, parseRgba, reducedMotion, rng } from './gl';
import { COMP_FS, FIELD_FS, FIELD_VS, FLIGHT_FS, FLIGHT_VS, FULLSCREEN_VS } from './text-shaders';

/** How the drops reach the paper. */
export type InkTextLook = 'printhead' | 'rain' | 'develop' | 'fall';
/** What shows while waiting for the first words. */
export type InkTextThinking = 'caret' | 'skeleton' | 'word';

export interface InkTextOptions {
  /** How the drops reach the paper. @default 'printhead' */
  look?: InkTextLook;
  /** What shows before the first words arrive. @default 'caret' */
  thinking?: InkTextThinking;
  /** The word the `word` thinking state prints. @default 'Thinking' */
  thinkingWord?: string;
  /** Characters per second the head prints at; it speeds up when it falls behind the stream. @default 80 */
  speed?: number;
  /** Dot pitch in CSS px; 0 picks one from the font size. @default 0 */
  pitch?: number;
  /** Ink threshold; 0 matches the weight of the DOM text (measured per platform). @default 0 */
  thresh?: number;
  /** How much the ink's edge wanders with the paper's fibres, 0–1. @default 0.7 */
  rough?: number;
  /** Share of drops that throw a tiny satellite drop beside them, 0–1. @default 0.05 */
  satellites?: number;
  /** Seed for the drops' randomness, so a print can be replayed exactly. */
  seed?: number;
}

type ResolvedOptions = Required<Omit<InkTextOptions, 'seed'>>;

interface LookParams {
  spread: number;
  spreadTau: number;
  ring: number;
  ringGrow: number;
  ringDur: number;
  shutter: number;
  glow: number;
  /** How long drops are in the air, so the head is drawn where they land. */
  lead: number;
  persp?: number;
}

/** How drops travel, per look. */
export const TEXT_LOOKS: Record<InkTextLook, LookParams> = {
  printhead: { spread: 0.06, spreadTau: 0.45, ring: 0.5, ringGrow: 3, ringDur: 0.16, shutter: 1 / 90, glow: 0.22, lead: 0 },
  rain: { spread: 0.08, spreadTau: 0.45, ring: 0.9, ringGrow: 4, ringDur: 0.2, shutter: 1 / 140, glow: 0.2, lead: 0.1 },
  develop: { spread: 0.05, spreadTau: 0.5, ring: 0.3, ringGrow: 3, ringDur: 0.16, shutter: 1 / 90, glow: 0.18, lead: 0.05 },
  fall: { spread: 0.08, spreadTau: 0.45, ring: 0.8, ringGrow: 4, ringDur: 0.2, shutter: 1 / 240, glow: 0.22, persp: 520, lead: 0.26 }
};
export const TEXT_THINKING: InkTextThinking[] = ['caret', 'skeleton', 'word'];

const F = 12; // floats per drop
const PAD = 28; // room around the text for drops in flight
const KIND = { text: 0, satellite: 1, spit: 2, skeleton: 3, word: 4 };
const HIGHLIGHTS = typeof CSS !== 'undefined' && 'highlights' in CSS;

const CSS_TEXT = `
.ink-text { position: relative; isolation: isolate; }
.ink-text-src { color: transparent; white-space: pre-wrap; }
.ink-text-mark { user-select: none; }
.ink-text-layer { position: absolute; inset: -${PAD}px; overflow: hidden; pointer-events: none; z-index: -1; }
.ink-text-layer canvas { position: absolute; left: 0; top: 0; }
.ink-text.ink-text-done .ink-text-src { color: inherit; }
`;

let ids = 0;
const loop = createLoop<InkTextEngine>();

const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\t' || c === '\r';

interface Frag {
  a: number;
  b: number;
  x: number;
  top: number;
  bottom: number;
  w: number;
}
interface Word {
  a: number;
  b: number;
  frags: Frag[];
  tShow: number;
  range?: Range;
}
interface Seg {
  t0: number;
  t1: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}
interface Cell {
  x: number;
  y: number;
  cov: number;
  rank: number;
}
interface Skeleton {
  cells: Cell[];
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  r: number;
  sweeps: number[];
}
interface Band {
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
  w: number;
  h: number;
}
/** x, top, bottom (css px), alpha */
type Head = [number, number, number, number];

// growable instance buffer of drops, with when each one can be thrown away
class Drops {
  cap = 4096;
  a = new Float32Array(this.cap * F);
  expire = new Float32Array(this.cap);
  n = 0;
  full = true;
  from = Number.POSITIVE_INFINITY;
  yMin = Number.POSITIVE_INFINITY;
  yMax = Number.NEGATIVE_INFINITY;
  readonly buf: WebGLBuffer | null;

  constructor(readonly gl: WebGL2RenderingContext | null) {
    this.buf = gl ? gl.createBuffer() : null;
  }

  push(x: number, y: number, r: number, t: number, fx: number, fy: number, fl: number, fd: number, dry: number, fade: number, z: number, kind: number, expire: number) {
    if (this.n === this.cap) {
      this.cap *= 2;
      const a = new Float32Array(this.cap * F);
      a.set(this.a);
      this.a = a;
      const e = new Float32Array(this.cap);
      e.set(this.expire);
      this.expire = e;
      this.full = true;
    }
    const o = this.n * F;
    const a = this.a;
    a[o] = x;
    a[o + 1] = y;
    a[o + 2] = r;
    a[o + 3] = t;
    a[o + 4] = fx;
    a[o + 5] = fy;
    a[o + 6] = fl;
    a[o + 7] = fd;
    a[o + 8] = dry;
    a[o + 9] = fade;
    a[o + 10] = z;
    a[o + 11] = kind;
    this.expire[this.n] = expire;
    this.from = Math.min(this.from, this.n);
    this.n++;
    if (y < this.yMin) this.yMin = y;
    if (y > this.yMax) this.yMax = y;
  }

  compact(now: number) {
    let w = 0;
    this.yMin = Number.POSITIVE_INFINITY;
    this.yMax = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.n; i++) {
      if (this.expire[i] <= now) continue;
      if (w !== i) {
        this.a.copyWithin(w * F, i * F, i * F + F);
        this.expire[w] = this.expire[i];
      }
      const y = this.a[w * F + 1];
      if (y < this.yMin) this.yMin = y;
      if (y > this.yMax) this.yMax = y;
      w++;
    }
    if (w !== this.n) {
      this.n = w;
      this.full = true;
    }
  }

  upload() {
    const gl = this.gl;
    if (!gl) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    if (this.full) gl.bufferData(gl.ARRAY_BUFFER, this.a, gl.DYNAMIC_DRAW);
    else if (this.from < this.n) gl.bufferSubData(gl.ARRAY_BUFFER, this.from * F * 4, this.a, this.from * F, (this.n - this.from) * F);
    this.full = false;
    this.from = Number.POSITIVE_INFINITY;
  }
}

interface GLState {
  gl: WebGL2RenderingContext;
  field: Program;
  flight: Program;
  comp: Program;
  vao: WebGLVertexArrayObject | null;
  emptyVao: WebGLVertexArrayObject | null;
}

function setupGL(canvas: HTMLCanvasElement, drops: Drops): GLState | null {
  const gl = drops.gl;
  if (!gl) return null;
  try {
    gl.getExtension('EXT_color_buffer_float');
    const field = compile(gl, FIELD_VS, FIELD_FS);
    const flight = compile(gl, FLIGHT_VS, FLIGHT_FS);
    const comp = compile(gl, FULLSCREEN_VS, COMP_FS);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, drops.buf);
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, F * 4, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    gl.bindVertexArray(null);
    return { gl, field, flight, comp, vao, emptyVao: gl.createVertexArray() };
  } catch {
    canvas.remove();
    return null;
  }
}

export class InkTextEngine {
  readonly host: HTMLElement;
  /** True once the answer has finished drying and the host holds plain text. */
  done = false;

  private o: ResolvedOptions;
  private reduced: boolean;
  private src: HTMLSpanElement;
  private node: Text;
  private mark: HTMLSpanElement;
  private layer: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private name: string;
  private style: HTMLStyleElement;
  private shown: Highlight | null = null;
  private g: GLState | null;
  private drops: Drops;
  private scratch: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D | null = null;
  private rand: () => number;
  private clock = 0;
  private dt = 0;
  private text = '';
  private printed = 0;
  private lastWrite = 0;
  private words: Word[] = [];
  private pending: Word[] = [];
  private segs: Seg[] = [];
  private headFree = 0;
  private thinkAt = -1;
  private nextGen = 0;
  private gen = 0;
  private thinkGeom: { x: number; top: number; bottom: number; right: number } | null = null;
  private skel: Skeleton | null = null;
  private spitAcc = 0;
  private compactAt = 0;
  private ended = false;
  private instant = false;
  private dryUntil = 0;
  private visible = true;
  private full = true;
  private resized = false;
  private lastHead: Head | null = null;
  private lastBand: { top: number; h: number } | null = null;
  private lastFrag: Frag | null = null;
  private band: Band | null = null;
  private colorAge = 99;
  private colorStr = '';
  private ink: [number, number, number] = [1, 1, 1];
  private font = '';
  private fontReady = false;
  private size = 16;
  private thresh = 0.7;
  private letterSpacing = '0px';
  private lineHeight = 19.2;
  private ascent = 12;
  private cw = 0;
  private ch = 0;
  private endPromise: Promise<void> | null = null;
  private endResolve: (() => void) | null = null;
  private ro: ResizeObserver;
  private io: IntersectionObserver;

  constructor(host: HTMLElement, opts: InkTextOptions = {}) {
    ensureStyle('ink-text', CSS_TEXT);
    this.o = {
      look: 'printhead',
      thinking: 'caret',
      thinkingWord: 'Thinking',
      speed: 80,
      pitch: 0,
      thresh: 0,
      rough: 0.7,
      satellites: 0.05,
      ...stripUndefined(opts)
    };
    this.host = host;
    host.classList.remove('ink-text-done');
    host.classList.add('ink-text');
    host.textContent = '';
    this.src = document.createElement('span');
    this.src.className = 'ink-text-src';
    this.node = document.createTextNode('');
    this.src.append(this.node);
    // marks where the text goes next, so thinking has a place before any text
    this.mark = document.createElement('span');
    this.mark.className = 'ink-text-mark';
    this.mark.setAttribute('aria-hidden', 'true');
    this.mark.textContent = '​';
    this.layer = document.createElement('div');
    this.layer.className = 'ink-text-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    this.canvas = document.createElement('canvas');
    this.layer.append(this.canvas);
    host.append(this.src, this.mark, this.layer);
    this.name = `ink-text-${++ids}`;
    host.classList.add(this.name);

    // dry words are revealed through a highlight of their own colour
    this.style = document.createElement('style');
    document.head.append(this.style);
    if (HIGHLIGHTS) {
      this.shown = new Highlight();
      CSS.highlights.set(this.name, this.shown);
    } else this.src.style.color = 'inherit';

    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
    this.drops = new Drops(gl);
    this.g = setupGL(this.canvas, this.drops);
    // without WebGL2 (or with reduced motion) every word simply shows as it arrives
    this.reduced = reducedMotion() || !this.g;
    this.scratch = document.createElement('canvas');
    this.rand = rng(opts.seed ?? (Math.random() * 1e9) | 0);

    this.readFont();
    this.measure();
    this.ro = new ResizeObserver(() => {
      this.resized = true;
    });
    this.ro.observe(host);
    this.io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !this.visible) this.full = true;
      this.visible = e.isIntersecting;
    });
    this.io.observe(this.layer);
    loop.add(this);
  }

  // ---------- public ----------

  /** Show the thinking state until the first words arrive. */
  think(): void {
    if (this.text || this.thinkAt >= 0 || this.reduced) return;
    this.thinkAt = this.clock;
    this.nextGen = this.clock;
    this.gen = 0;
  }

  /** Append a chunk of the stream. Partial words wait for whitespace (or 0.3 s) before printing. */
  write(chunk: string): void {
    if (!chunk || this.done || this.ended) return;
    this.text += chunk;
    this.node.appendData(chunk);
    this.lastWrite = this.clock;
  }

  /** Everything at once, already dry (history, restored messages). */
  setText(text: string): Promise<void> {
    this.write(text);
    this.instant = true;
    return this.end();
  }

  /** Text that is already on the page: it shows dry, and later writes print after it. */
  restore(text: string): void {
    this.write(text);
    this.dryUntil = this.text.length;
  }

  /** The stream is over: resolves once the last word has dried and the host holds plain text. */
  end(): Promise<void> {
    this.ended = true;
    if (!this.endPromise) {
      this.endPromise = new Promise((r) => {
        this.endResolve = r;
      });
      if (this.done) this.endResolve?.();
    }
    return this.endPromise;
  }

  /** Change options live; a new look applies from the next word. */
  set(opts: InkTextOptions): void {
    Object.assign(this.o, stripUndefined(opts));
  }

  /** Everything written so far. */
  get value(): string {
    return this.text;
  }

  /** Stop animating; whatever text there is stays as plain text. */
  destroy(): void {
    if (this.done) return;
    loop.delete(this);
    this.ro.disconnect();
    this.io.disconnect();
    this.host.classList.add('ink-text-done');
    this.host.classList.remove(this.name);
    if (HIGHLIGHTS) CSS.highlights.delete(this.name);
    this.style.remove();
    if (this.g) {
      if (this.band) this.freeBand();
      this.g.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.layer.remove();
    this.done = true;
    this.endResolve?.();
  }

  // ---------- geometry ----------

  private readFont() {
    const cs = getComputedStyle(this.src);
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    this.size = Number.parseFloat(cs.fontSize);
    // measured: with -webkit-font-smoothing: antialiased on macOS the DOM draws
    // text ~23% lighter than canvas, so the drops are thinned to match it
    this.thresh = /Mac/.test(navigator.platform) && cs.getPropertyValue('-webkit-font-smoothing') === 'antialiased' ? 0.78 : 0.7;
    this.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
    this.lineHeight = cs.lineHeight === 'normal' ? this.size * 1.2 : Number.parseFloat(cs.lineHeight);
    if (font === this.font) return;
    this.font = font;
    this.fontReady = false;
    const ready = () => {
      if (this.font !== font) return;
      const c = this.ctx2d();
      c.font = font;
      this.ascent = c.measureText('Hg').fontBoundingBoxAscent || this.size * 0.8;
      this.fontReady = true;
    };
    document.fonts.load(font, 'Hg').then(ready, ready);
  }

  private ctx2d(): CanvasRenderingContext2D {
    if (!this.sctx) {
      const c = this.scratch.getContext('2d', { willReadFrequently: true });
      if (!c) throw new Error('inkjet-fx: no 2D canvas');
      this.sctx = c;
    }
    return this.sctx;
  }

  private get dpr() {
    return devicePixelRatioCapped();
  }

  private get pitch() {
    return Math.max(this.o.pitch || clamp(this.size / 24, 0.5, 2), 1.15 / this.dpr);
  }

  private measure() {
    const r = this.layer.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.ceil(r.height);
    const reflow = this.cw && w !== this.cw && this.words.length;
    if (w !== this.cw || h > this.ch) this.resizeCanvas(w, Math.max(256, Math.ceil(h / 256) * 256));
    if (reflow) this.reflow();
  }

  private resizeCanvas(w: number, h: number) {
    const dpr = this.dpr;
    this.cw = w;
    this.ch = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (this.band && this.band.w !== this.canvas.width) this.freeBand();
    this.full = true;
  }

  // the host changed width and the browser re-wrapped the text: drops in flight
  // no longer sit on their words, so show every word as it is
  private reflow() {
    for (let i = 0; i < this.drops.n; i++) if (this.drops.a[i * F + 11] <= KIND.satellite) this.drops.expire[i] = 0;
    this.drops.compact(this.clock);
    for (const w of this.pending) this.show(w);
    this.pending = [];
    this.segs = [];
    this.headFree = this.clock;
    const lr = this.layer.getBoundingClientRect();
    const last = this.words[this.words.length - 1];
    this.lastFrag = last ? (this.fragsOf(last.a, last.b, lr).at(-1) ?? null) : null;
    if (last && this.lastFrag) last.frags = [this.lastFrag];
  }

  // where a run of characters sits, relative to the canvas; a word the browser
  // broke across lines comes back as one fragment per line
  private fragsOf(a: number, b: number, lr: DOMRect): Frag[] {
    const range = document.createRange();
    range.setStart(this.node, a);
    range.setEnd(this.node, b);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    if (rects.length <= 1) {
      const r = rects[0] || range.getBoundingClientRect();
      return [{ a, b, x: r.left - lr.left, top: r.top - lr.top, bottom: r.bottom - lr.top, w: r.width }];
    }
    const frags: Frag[] = [];
    let cur: Frag | null = null;
    for (let k = a; k < b; k++) {
      range.setStart(this.node, k);
      range.setEnd(this.node, k + 1);
      const r = range.getBoundingClientRect();
      const top = r.top - lr.top;
      if (!cur || Math.abs(top - cur.top) > 1) {
        cur = { a: k, b: k + 1, x: r.left - lr.left, top, bottom: r.bottom - lr.top, w: r.width };
        frags.push(cur);
      } else {
        cur.b = k + 1;
        cur.w = r.right - lr.left - cur.x;
      }
    }
    return frags;
  }

  private markGeom() {
    const lr = this.layer.getBoundingClientRect();
    const r = this.mark.getBoundingClientRect();
    return {
      x: r.left - lr.left,
      top: r.top - lr.top,
      bottom: r.bottom - lr.top,
      right: this.cw - PAD - Number.parseFloat(getComputedStyle(this.host).paddingRight)
    };
  }

  // coverage of a run of text (or a drawing), on the canvas-wide dot grid
  private cells(str: string | ((c: CanvasRenderingContext2D) => void), x: number, top: number, bottom: number, w: number, pitch: number, font = this.font): Cell[] {
    const dpr = this.dpr;
    const x0 = Math.floor((x - 2) * dpr);
    const y0 = Math.floor((top - 2) * dpr);
    const W = Math.ceil((w + 4) * dpr) + 2;
    const H = Math.ceil((bottom - top + 4) * dpr) + 2;
    const s = this.scratch;
    if (s.width < W || s.height < H) {
      s.width = Math.max(s.width, W);
      s.height = Math.max(s.height, H);
    }
    const c = this.ctx2d();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);
    c.setTransform(dpr, 0, 0, dpr, -x0, -y0);
    c.font = font;
    (c as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = this.letterSpacing;
    c.fillStyle = '#fff';
    if (typeof str === 'function') str(c);
    else c.fillText(str, x, top + this.ascent);
    const img = c.getImageData(0, 0, W, H).data;
    const pd = pitch * dpr;
    const out: Cell[] = [];
    for (let j = Math.floor(y0 / pd); j * pd < y0 + H; j++) {
      const py0 = Math.max(0, Math.floor(j * pd) - y0);
      const py1 = Math.min(H, Math.floor((j + 1) * pd) - y0);
      if (py1 <= py0) continue;
      for (let i = Math.floor(x0 / pd); i * pd < x0 + W; i++) {
        const px0 = Math.max(0, Math.floor(i * pd) - x0);
        const px1 = Math.min(W, Math.floor((i + 1) * pd) - x0);
        if (px1 <= px0) continue;
        let sum = 0;
        for (let py = py0; py < py1; py++) for (let px = px0; px < px1; px++) sum += img[(py * W + px) * 4 + 3];
        const cov = sum / ((px1 - px0) * (py1 - py0) * 255);
        if (cov < 0.16) continue;
        out.push({ x: (i + 0.5) * pitch, y: (j + 0.5) * pitch, cov, rank: BAYER[(j & 3) * 4 + (i & 3)] });
      }
    }
    return out;
  }

  // ---------- printing ----------

  private layoutNew() {
    const t = this.text;
    const flush = this.ended || this.clock - this.lastWrite > 0.3;
    let ready = t.length;
    if (!flush) {
      ready = 0;
      for (let k = t.length - 1; k >= this.printed; k--)
        if (isSpace(t[k])) {
          ready = k + 1;
          break;
        }
    }
    if (ready <= this.printed) return;
    if (this.thinkAt >= 0) this.stopThinking();
    const lr = this.layer.getBoundingClientRect();
    let i = this.printed;
    while (i < ready) {
      if (isSpace(t[i])) {
        i++;
        continue;
      }
      let j = i;
      while (j < ready && !isSpace(t[j])) j++;
      // a word that was flushed half-way and has since grown: if the browser
      // moved it to the next line, take back what was printed and print it whole
      const prev = this.words[this.words.length - 1];
      if (prev && prev.b === i && i > 0 && !isSpace(t[i - 1])) {
        const now = this.fragsOf(prev.a, prev.b, lr)[0];
        const was = prev.frags[0];
        if (Math.abs(now.top - was.top) > 1 || Math.abs(now.x - was.x) > 1) {
          this.unprint(prev);
          i = prev.a;
        }
      }
      this.printWord(i, j, lr);
      i = j;
    }
    this.printed = ready;
  }

  private show(word: Word) {
    if (word.range) return;
    word.range = new Range();
    word.range.setStart(this.node, word.a);
    word.range.setEnd(this.node, word.b);
    this.shown?.add(word.range);
  }

  private unprint(word: Word) {
    if (word.range) this.shown?.delete(word.range);
    const d = this.drops;
    for (let k = 0; k < d.n; k++) {
      const o = k * F;
      if (d.a[o + 11] > KIND.satellite) continue;
      for (const f of word.frags) {
        if (d.a[o] >= f.x - 1 && d.a[o] <= f.x + f.w + 1 && d.a[o + 1] >= f.top - 1 && d.a[o + 1] <= f.bottom + 1) d.expire[k] = 0;
      }
    }
    d.compact(this.clock);
    this.words.pop();
    this.pending = this.pending.filter((w) => w !== word);
  }

  private printWord(a: number, b: number, lr: DOMRect) {
    const frags = this.fragsOf(a, b, lr);
    const word: Word = { a, b, frags, tShow: 0 };
    this.words.push(word);
    if (this.reduced || this.instant || b <= this.dryUntil) {
      this.show(word);
      this.lastFrag = frags[frags.length - 1];
      return;
    }
    const look = this.o.look;
    const L = TEXT_LOOKS[look] || TEXT_LOOKS.printhead;
    const pitch = this.pitch;
    const r0 = pitch * 0.56;
    const rand = this.rand;
    const k0 = this.drops.n;
    let land = 0;
    for (const f of frags) {
      const n = f.b - f.a;
      const behind = Math.max(0, this.headFree - this.clock);
      const perChar = 1 / (this.o.speed * (1 + behind * 1.5));
      let start = Math.max(this.clock + 0.02, this.headFree);
      if (this.lastFrag && Math.abs(f.top - this.lastFrag.top) > 1) start += 0.05;
      const dur = n * perChar;
      this.segs.push({ t0: start + L.lead, t1: start + dur + L.lead, x0: f.x, x1: f.x + f.w, top: f.top, bottom: f.bottom });
      if (this.segs.length > 64) this.segs.splice(0, this.segs.length - 64);
      this.headFree = start + dur + perChar;
      this.lastFrag = f;
      for (const c of this.cells(this.text.slice(f.a, f.b), f.x, f.top, f.bottom, f.w, pitch)) {
        const x = c.x + (rand() - 0.5) * pitch * 0.24;
        const y = c.y + (rand() - 0.5) * pitch * 0.24;
        const r = r0 * (0.5 + 0.5 * Math.sqrt(Math.min(c.cov, 1)));
        const u = clamp((x - f.x) / Math.max(f.w, 1), 0, 1);
        let t: number;
        let fl: number;
        let fx = 0;
        let fy = 0;
        let z = 1;
        if (look === 'rain') {
          const seen = rand() < 0.35;
          const h = seen ? 10 + rand() * rand() * 45 : 0;
          t = start + u * dur + rand() * 0.18;
          fl = seen ? 0.09 + h / 420 : 0.06;
          fy = -h;
          fx = seen ? (rand() - 0.5) * 3 : 0;
          z = seen ? 1 : 2.4;
        } else if (look === 'develop') {
          t = start + u * dur * 0.3 + (c.rank / 16) * 0.32 + rand() * 0.04;
          fl = 0.05;
          z = 1.8;
        } else if (look === 'fall') {
          fl = 0.2 + rand() * 0.12;
          t = start + u * dur + L.lead - fl + rand() * 0.04;
          fy = -(14 + rand() * 34);
          fx = (rand() - 0.5) * 12;
          z = 1.6 + rand() * 1.4;
        } else {
          t = start + u * dur + ((c.rank / 16) * 0.75 + rand() * 0.25) * 0.07;
          fl = 0.08;
          z = 3.5;
          fx = -6;
        }
        land = Math.max(land, t + fl);
        this.drops.push(x, y, r, t, fx, fy, fl, 0.35, NEVER, NEVER, z, KIND.text, NEVER);
        if (rand() < this.o.satellites) {
          const ang = rand() * Math.PI * 2;
          const d = pitch * (0.7 + rand() * 0.7);
          this.drops.push(x + Math.cos(ang) * d, y + Math.sin(ang) * d, r0 * 0.34, t + 0.004, fx, fy, fl, 0.35, NEVER, NEVER, z, KIND.satellite, NEVER);
        }
      }
    }
    // once the word's ink has soaked in, the real word shows and its drops dry away
    word.tShow = land + 0.15;
    const d = this.drops;
    for (let k = k0; k < d.n; k++) {
      d.a[k * F + 8] = HIGHLIGHTS ? word.tShow : NEVER;
      d.expire[k] = HIGHLIGHTS ? word.tShow + 0.4 : NEVER;
    }
    this.pending.push(word);
  }

  // where the head is, and how bright
  private head(t: number): Head | null {
    if (this.reduced) return null;
    if (this.thinkAt >= 0) {
      const m = this.thinkGeom;
      if (this.o.thinking === 'caret' && m) return [m.x + 0.5, m.top, m.bottom, Math.min(1, (t - this.thinkAt) * 5) * (0.55 + 0.45 * Math.sin(t * 9))];
      if (this.o.thinking === 'skeleton' && this.skel) {
        for (const s of this.skel.sweeps) {
          if (t >= s - 0.05 && t <= s + 0.45) {
            const u = clamp((t - s) / 0.4, 0, 1);
            const a = clamp((t - s + 0.05) / 0.05, 0, 1) * (1 - clamp((t - s - 0.4) / 0.05, 0, 1)) * 0.7;
            return [this.skel.x0 + u * (this.skel.x1 - this.skel.x0), this.skel.top, this.skel.bottom, a];
          }
        }
      }
      return null;
    }
    const segs = this.segs;
    if (!segs.length) return null;
    let k = segs.length - 1;
    while (k > 0 && segs[k].t0 > t) k--;
    const s = segs[k];
    if (t < s.t0) return null;
    const u = clamp((t - s.t0) / Math.max(s.t1 - s.t0, 1e-3), 0, 1);
    const last = segs[segs.length - 1];
    let a = 1;
    if (this.ended && t > last.t1) a = 1 - clamp((t - last.t1) / 0.4, 0, 1);
    return a > 0 ? [s.x0 + u * (s.x1 - s.x0) + 1, s.top, s.bottom, a] : null;
  }

  // ---------- thinking ----------

  private thinkTick() {
    if (!this.thinkGeom) this.thinkGeom = this.markGeom();
    const m = this.thinkGeom;
    const rand = this.rand;
    const kind = this.o.thinking;
    if (kind === 'caret') {
      // the head fizzes where the text will start
      this.spits(this.spitAcc + this.dt * 30, m.x, m.top, m.bottom);
      return;
    }
    if (this.clock < this.nextGen - 0.4) return;
    const c = this.nextGen;
    if (kind === 'skeleton') {
      // halftone bars where the answer will go, darkening, then breathing
      if (!this.skel) {
        const span = Math.max(40, m.right - m.x);
        const baseline = m.top + this.ascent;
        const barH = this.size * 0.62;
        const bars = [1, 0.92, 0.58].map((w, i) => ({ x: m.x, y: baseline + i * this.lineHeight - this.size * 0.68, w: span * w }));
        const p = Math.max(this.pitch * 2, 1.05);
        const cells = this.cells(
          (ctx) => {
            for (const b of bars) {
              ctx.beginPath();
              ctx.roundRect(b.x, b.y, b.w, barH, barH / 2);
              ctx.fill();
            }
          },
          m.x,
          bars[0].y - 2,
          bars[2].y + barH + 2,
          span,
          p
        );
        this.skel = { cells, x0: m.x, x1: m.x + span, top: bars[0].y - 3, bottom: bars[2].y + barH + 3, r: p * 0.56 * 1.3, sweeps: [] };
      }
      const S = this.skel;
      const steps =
        this.gen === 0
          ? [
              [0, 0],
              [1, 0.55],
              [2, 1.1],
              [3, 1.65]
            ]
          : [
              [2, 0],
              [3, 0.3]
            ];
      const life = this.gen === 0 ? 2.9 : 1.4;
      for (const [, at] of steps) S.sweeps.push(c + at);
      for (const cell of S.cells) {
        const step = steps.find((s) => s[0] === cell.rank);
        if (!step) continue;
        const u = (cell.x - S.x0) / (S.x1 - S.x0);
        const t = c + step[1] + u * 0.4 + rand() * 0.01;
        const keep = this.gen === 0 && cell.rank < 2;
        const fade = keep ? NEVER : c + life + u * 0.4;
        this.drops.push(cell.x, cell.y, S.r * (0.5 + 0.5 * Math.sqrt(Math.min(cell.cov, 1))), t, 0, 0, 0.05, 0.3, NEVER, fade, 1.8, KIND.skeleton, keep ? NEVER : fade + 0.3);
      }
      if (S.sweeps.length > 12) S.sweeps.splice(0, S.sweeps.length - 12);
      this.nextGen = c + (this.gen === 0 ? 3.3 : 1.8);
    } else if (kind === 'word') {
      // a word rains in, holds, dries off, and comes again
      const font = `500 ${this.size}px ${getComputedStyle(this.src).fontFamily}`;
      const pitch = this.pitch;
      const c2 = this.ctx2d();
      c2.font = font;
      const w = c2.measureText(this.o.thinkingWord).width;
      for (const cell of this.cells(this.o.thinkingWord, m.x, m.top, m.bottom, w, pitch, font)) {
        const u = (cell.x - m.x) / w;
        const h = 10 + rand() * 24;
        const t = c + 0.05 + u * 0.5 + rand() * 0.25;
        const fade = c + 1.9 + u * 0.3 + rand() * 0.15;
        this.drops.push(cell.x, cell.y, pitch * 0.56 * (0.5 + 0.5 * Math.sqrt(Math.min(cell.cov, 1))), t, (rand() - 0.5) * 2, -h, 0.12 + h / 500, 0.3, NEVER, fade, 1, KIND.word, fade + 0.3);
      }
      this.nextGen = c + 2.6;
    }
    this.gen++;
  }

  // the first word is here: wipe the skeleton or word away, left to right
  private stopThinking() {
    const d = this.drops;
    const m = this.thinkGeom || this.markGeom();
    const span = Math.max(40, (this.skel ? this.skel.x1 : m.right) - m.x);
    for (let k = 0; k < d.n; k++) {
      const o = k * F;
      const kind = d.a[o + 11];
      if (kind !== KIND.skeleton && kind !== KIND.word) continue;
      if (d.a[o + 3] > this.clock) {
        d.a[o + 9] = this.clock;
        d.a[o + 7] = 0.01;
        d.expire[k] = this.clock + 0.05;
        continue;
      }
      const fade = Math.min(d.a[o + 9], this.clock + 0.02 + clamp((d.a[o] - m.x) / span, 0, 1) * 0.35);
      d.a[o + 9] = fade;
      d.a[o + 7] = 0.15;
      d.expire[k] = fade + 0.15;
    }
    d.full = true;
    this.thinkAt = -1;
    this.skel = null;
    this.thinkGeom = null;
  }

  private spits(acc: number, x: number, top: number, bottom: number) {
    const rand = this.rand;
    const r0 = this.pitch * 0.56;
    let left = acc;
    while (left >= 1) {
      left -= 1;
      const t = this.clock;
      this.drops.push(x + 1 + rand() * 6, top + 1 + rand() * (bottom - top - 2), r0 * (1.2 + rand() * 1.6), t, 0, 0, 0.07, 0.22, NEVER, t + 0.17, 3, KIND.spit, t + 0.4);
    }
    this.spitAcc = left;
  }

  // ---------- frame ----------

  /** Advance by dt seconds and draw. Called by the shared animation loop. */
  tick(dt: number): void {
    this.dt = dt;
    this.clock += dt;
    if (this.resized) {
      this.resized = false;
      this.readFont();
      this.measure();
    }
    if (++this.colorAge > 20) {
      this.colorAge = 0;
      const col = getComputedStyle(this.host).color;
      if (col !== this.colorStr) {
        this.colorStr = col;
        const c = parseRgba(col);
        this.ink = [c[0], c[1], c[2]];
        this.style.textContent = `::highlight(${this.name}) { color: ${col}; }\n.${this.name} .ink-text-src::selection { color: ${col}; }`;
        this.full = true;
      }
    }
    if (this.fontReady) {
      if (this.text.length > this.printed) {
        this.measure();
        this.layoutNew();
      }
      if (this.thinkAt >= 0) this.thinkTick();
      // waiting on the model mid-answer: the head idles and fizzes
      const last = this.segs[this.segs.length - 1];
      if (!this.ended && last && this.thinkAt < 0 && this.clock > last.t1 + 0.25 && this.printed >= this.text.length) {
        this.spits(this.spitAcc + this.dt * 12, last.x1, last.top, last.bottom);
      }
    }
    if (this.pending.length) {
      const still: Word[] = [];
      for (const w of this.pending) {
        if (w.tShow <= this.clock) this.show(w);
        else still.push(w);
      }
      this.pending = still;
    }
    this.compactAt += this.dt;
    if (this.compactAt > 0.4) {
      this.compactAt = 0;
      this.drops.compact(this.clock);
    }
    if (this.visible) this.draw();
    // done: every word is showing and every drop has gone
    if (this.ended && this.fontReady && this.printed >= this.text.length && !this.pending.length && !this.drops.n && !this.lastBand) {
      this.destroy();
    }
  }

  private freeBand() {
    if (!this.g || !this.band) return;
    const gl = this.g.gl;
    gl.deleteTexture(this.band.tex);
    gl.deleteFramebuffer(this.band.fb);
    this.band = null;
  }

  private ensureBand(hCss: number): Band | null {
    if (!this.g) return null;
    const dpr = this.dpr;
    const W = this.canvas.width;
    const H = Math.round(Math.ceil(hCss / 128) * 128 * dpr);
    if (this.band && this.band.w === W && this.band.h >= H) return this.band;
    if (this.band) this.freeBand();
    const gl = this.g.gl;
    const tex = gl.createTexture();
    const fb = gl.createFramebuffer();
    if (!tex || !fb) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(W, H))) + 1, gl.RGBA16F, W, H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.band = { tex, fb, w: W, h: H };
    return this.band;
  }

  private draw() {
    const g = this.g;
    if (!g) return;
    const gl = g.gl;
    const dpr = this.dpr;
    const L = TEXT_LOOKS[this.o.look] || TEXT_LOOKS.printhead;
    const d = this.drops;
    d.upload();
    const h = this.head(this.clock);

    // the field only covers the band of the page where drops are in play
    let band: { top: number; h: number } | null = null;
    const fieldBand = d.n ? this.ensureBand(Math.min(this.ch, Math.ceil(d.yMax + 24)) - Math.max(0, Math.floor(d.yMin - (L.persp ? 240 : 60)))) : null;
    if (d.n && fieldBand) {
      // a 3D fall starts well above its line
      const top = Math.max(0, Math.floor(d.yMin - (L.persp ? 240 : 60)));
      band = { top, h: fieldBand.h / dpr };
      gl.bindFramebuffer(gl.FRAMEBUFFER, fieldBand.fb);
      gl.viewport(0, 0, fieldBand.w, fieldBand.h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(g.vao);
      // in a 3D fall the eye hangs over the letters whose drops are in the air
      // (where the head will be in a moment), so the spray comes straight down
      const f = this.lastFrag;
      const ahead = L.persp ? this.head(this.clock + 0.15) || h : null;
      const eye = L.persp && (ahead || f) ? (ahead ? [ahead[0], (ahead[1] + ahead[2]) / 2] : f ? [f.x + f.w / 2, (f.top + f.bottom) / 2] : null) : null;
      for (const prog of [g.field, g.flight]) {
        const u = prog.u;
        gl.useProgram(prog.p);
        gl.uniform1f(u.uTime, this.clock);
        gl.uniform1f(u.uScale, dpr);
        gl.uniform2f(u.uOff, 0, top);
        gl.uniform2f(u.uRes, fieldBand.w, fieldBand.h);
        if (prog === g.field) {
          gl.uniform1f(u.uSpread, L.spread);
          gl.uniform1f(u.uSpreadTau, L.spreadTau);
          gl.uniform1f(u.uBleed, 0);
          gl.uniform1f(u.uSettle, 1);
          gl.uniform1f(u.uDryDur, 0.35);
          gl.uniform1f(u.uWetTau, 0.3);
        } else {
          gl.uniform1f(u.uShutter, L.shutter);
          gl.uniform1f(u.uRing, L.ring);
          gl.uniform1f(u.uRingGrow, L.ringGrow);
          gl.uniform1f(u.uRingDur, L.ringDur);
          gl.uniform4f(u.uPersp, eye ? eye[0] : 0, eye ? eye[1] : 0, eye && L.persp ? L.persp : 0, 0.3);
        }
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, d.n);
      }
      gl.disable(gl.BLEND);
      gl.bindTexture(gl.TEXTURE_2D, fieldBand.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    // composite only where something can have changed
    const rects: [number, number, number, number][] = [];
    if (this.full) rects.push([0, 0, this.cw, this.ch]);
    if (band) rects.push([0, band.top, this.cw, band.top + band.h]);
    if (this.lastBand) rects.push([0, this.lastBand.top, this.cw, this.lastBand.top + this.lastBand.h]);
    for (const hh of [h, this.lastHead]) if (hh) rects.push([hh[0] - 14, hh[1] - 6, hh[0] + 14, hh[2] + 6]);
    this.lastBand = band;
    this.lastHead = h;
    this.full = false;
    if (!rects.length) return;
    let [x0, y0, x1, y1] = rects[0];
    for (const r of rects) {
      x0 = Math.min(x0, r[0]);
      y0 = Math.min(y0, r[1]);
      x1 = Math.max(x1, r[2]);
      y1 = Math.max(y1, r[3]);
    }
    const W = this.canvas.width;
    const H = this.canvas.height;
    const sx = clamp(Math.floor(x0 * dpr), 0, W);
    const sy = clamp(Math.floor(y0 * dpr), 0, H);
    const sw = clamp(Math.ceil(x1 * dpr), 0, W) - sx;
    const sh = clamp(Math.ceil(y1 * dpr), 0, H) - sy;
    if (sw <= 0 || sh <= 0) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(sx, H - sy - sh, sw, sh);
    if (!band) {
      // nothing in play: clear what was there (the head, the last drops)
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    const tex = band ? fieldBand : h ? this.ensureBand(128) : null;
    if (tex) {
      const { p, u } = g.comp;
      gl.useProgram(p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex.tex);
      gl.uniform1i(u.uField, 0);
      gl.uniform2f(u.uCss, this.cw, this.ch);
      gl.uniform2f(u.uDev, W, H);
      gl.uniform1f(u.uDpr, W / this.cw);
      const ink = this.ink;
      const lum = ink[0] * 0.3 + ink[1] * 0.59 + ink[2] * 0.11;
      gl.uniform1f(u.uGlow, lum > 0.5 ? L.glow : 0);
      gl.uniform1f(u.uRough, this.o.rough);
      gl.uniform1f(u.uThresh, this.o.thresh || this.thresh);
      gl.uniform1f(u.uBandTop, band ? band.top : 0);
      gl.uniform1f(u.uBandH, band ? band.h : 1);
      gl.uniform1f(u.uHasBand, band ? 1 : 0);
      gl.uniform3fv(u.uInk, ink);
      gl.uniform4f(u.uHead, h ? h[0] : 0, h ? h[1] : 0, h ? h[2] : 0, h ? h[3] : 0);
      gl.bindVertexArray(g.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.SCISSOR_TEST);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** Convenience: think, print the stream, and finish. Resolves once the text is plain. */
export async function printStream(host: HTMLElement, stream: AsyncIterable<string>, opts?: InkTextOptions): Promise<InkTextEngine> {
  const ink = new InkTextEngine(host, opts);
  ink.think();
  for await (const chunk of stream) ink.write(chunk);
  await ink.end();
  return ink;
}
