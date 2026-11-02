'use client';

import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type CSSProperties,
  type ForwardedRef,
} from 'react';
import styles from './UdxLoader.module.css';
import { UDX_LOGO_SRC } from './udxLogo';
import {
  CROSS_GLYPH,
  FRAGMENTS,
  GENERIC_LOGO_INK,
  GLOW,
  LETTER_SPRING,
  LOGO_DEPTH,
  LOGO_EMERGE,
  REDUCED,
  SWEEP,
  TIMELINE,
  UDX_LOGO_INK,
  buildCells,
  clamp01,
  critStep,
  cursorEvents,
  easeOutCubic,
  fragmentDrawScale,
  fragmentPose,
  generateCrossFragments,
  glowStrength,
  lineUnits,
  mulberry32,
  smoothstep,
  springStep,
  cursorExit,
  sweepDuration,
  sweepProgress,
  sweepTimeAt,
  trackedCells,
  trailingSymbolUnits,
  U_DROPS,
  type CrossFragment,
  uDropAt,
  uprightAngle,
} from './timeline';
import { UDX_FONT_FAMILY, UDX_FONT_WEIGHT, loadUdxLoaderFont } from './udxLoaderFont';

/** A URL string, or a bundler image object such as Next.js `StaticImageData`. */
export type UdxImageSource = string | { src: string };

export interface UdxLoaderProps {
  /** Final logo. Defaults to the supplied UDX logo, embedded byte-for-byte in udxLogo.ts. */
  logoSrc?: UdxImageSource;
  /** Accessible name of the logo. */
  logoAlt?: string;
  /** Screen-reader status text. */
  label?: string;
  /** Typed text. Trailing symbols (the ✝ in "UDX✝") are struck by the sweeping caret and shatter. */
  text?: string;
  /** Cursor and symbol colour (the reference's reddish-orange caret). */
  accentColor?: string;
  /** Colour of the typed letters. */
  textColor?: string;
  /** Colour of the dark cross fragments. */
  inkColor?: string;
  /** Colour symbols such as ✝ with the accent, like the reference's "#". */
  accentSymbols?: boolean;
  /** Width of a space as a fraction of one character (monospace = 1). */
  spaceWidth?: number;
  /** Background colour (white by default). */
  background?: string;
  /** Optional paper look: a subtle static film grain and soft vignette over the background. Off by default. */
  texture?: boolean;
  /**
   * Upper bound for the logo's rendered width in CSS px. Defaults to the image's
   * natural width, so the logo is never enlarged beyond the supplied file.
   */
  maxLogoWidth?: number;
  /**
   * Logo size relative to the typed word: 1 = the logo's ink is as wide as the typed
   * "UDX" (the default, with the type sized so that the logo is about 199 px wide on most
   * screens). Kept proportionate on every screen size (never wider than 62 % of the loader
   * or half its height, and never larger than the file).
   */
  logoScale?: number;
  /** Cover the viewport (position: fixed). Otherwise fills its parent. */
  fullscreen?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Fires once, 3.96 s after mount (1 s with reduced motion). */
  onComplete?: () => void;
  /** Fires if the logo can't be loaded (or isn't decoded by 1.2 s); the loader then ends on the typed UDX. */
  onLogoError?: () => void;
  /** Start playing on mount (default). Set false to start paused on frame 0, e.g. for scrubbing. */
  autoPlay?: boolean;
  /** Called after every rendered frame with the current time (s) and whether it is playing. */
  onTimeUpdate?: (seconds: number, playing: boolean) => void;
}

/** Imperative controls, available through a ref: `<UdxLoader ref={loaderRef} />`. */
export interface UdxLoaderHandle {
  /** Jump to a time in seconds (real time, clamped to 0…duration) and pause there. */
  seek: (seconds: number) => void;
  /** Play from the current time (restarts from 0 when at the end). */
  play: () => void;
  pause: () => void;
  getTime: () => number;
  isPlaying: () => boolean;
  /** Length of the animation in seconds (real time: the design timeline ÷ TIMELINE.speed). */
  duration: number;
}

const LOGO_NATURAL = { w: 236, h: 196 };
const LOGO_NATURAL_ASPECT = LOGO_NATURAL.w / LOGO_NATURAL.h;
/**
 * Text size relative to a reference logo width. The typed UDX✝ (and its cursor) is sized with
 * the enlarged logo: 1.55 × the original 0.205, so the logo replaces the word at the same size
 * and the struck cross and its fragments sit exactly where they did relative to the logo.
 */
const FONT_TO_LOGO_ORIGINAL = 0.205;
const FONT_TO_LOGO = FONT_TO_LOGO_ORIGINAL * 1.55;
/**
 * The typed UDX✝ and its cursor are drawn at this share of that size (12 % smaller). The logo
 * is still sized from the full size, so its final size is unchanged; the strike sweep, the
 * logo's reveal and emergence, and the fragments' sizes and paths keep their full-size values.
 */
const TYPE_SCALE = 0.88;
/** Half of JetBrains Mono's cap height: puts the caps' visual centre on the stage centre. */
const CAP_HALF_EM = 0.365;
const FALLBACK_STACK =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const PRIMARY_STACK = `'${UDX_FONT_FAMILY}', ${FALLBACK_STACK}`;

const px = (v: number) => `${Math.round(v * 100) / 100}px`;
/** Corners of the cross glyph's stem and bar (glyph sizes, about its ink centre): its exact outline hull. */
const CROSS_CORNERS: ReadonlyArray<readonly [number, number]> = [CROSS_GLYPH.stem, CROSS_GLYPH.bar].flatMap((r) => [
  [r.x, r.y] as const,
  [r.x + r.w, r.y] as const,
  [r.x, r.y + r.h] as const,
  [r.x + r.w, r.y + r.h] as const,
]);
/** Points on a cross glyph (in glyph sizes, about its ink centre) used to test if it is behind the logo's ink. */
const CROSS_SAMPLES: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [0, -0.33], [0, 0.33], [0, -0.17], [0, 0.17], [-0.2, -0.155], [0.2, -0.155], [-0.1, -0.155], [0.1, -0.155],
];
const num = (v: number) => `${Math.round(v * 10000) / 10000}`;

// ---- glow image helpers (plain functions on typed arrays, kept small so they stay fast) -----
/** Runs `run` over [0, total) in pieces of `size`, yielding between pieces (for idle-time jobs). */
function* inChunks(total: number, size: number, run: (from: number, to: number) => void): Generator<void, void> {
  for (let from = 0; from < total; from += size) {
    run(from, Math.min(total, from + size));
    yield;
  }
}
/** One box-blur pass (radius `rad`) along one line of `a` into `b`, edges clamped. */
function blurLine(a: Float32Array, b: Float32Array, base: number, step: number, len: number, rad: number) {
  const k = 1 / (2 * rad + 1);
  const last = base + (len - 1) * step;
  let sum = a[base] * (rad + 1);
  for (let o = 1; o <= rad; o += 1) sum += a[base + Math.min(len - 1, o) * step];
  for (let q = 0; q < len; q += 1) {
    b[base + q * step] = sum * k;
    const inn = q + rad + 1;
    const out = q - rad;
    sum += (inn < len ? a[base + inn * step] : a[last]) - (out > 0 ? a[base + out * step] : a[base]);
  }
}
/** Box blur of a gw × gh field, `passes` times each way (3 ≈ Gaussian); a new array. */
function* boxBlur(src: Float32Array, gw: number, gh: number, rad: number, passes: number): Generator<void, Float32Array> {
  const a = src.slice();
  const b = new Float32Array(a.length);
  for (let pass = 0; pass < passes; pass += 1) {
    // across (a → b), then down (b → a): the result is in a
    yield* inChunks(gh, 64, (l0, l1) => {
      for (let l = l0; l < l1; l += 1) blurLine(a, b, l * gw, 1, gw, rad);
    });
    yield* inChunks(gw, 64, (l0, l1) => {
      for (let l = l0; l < l1; l += 1) blurLine(b, a, l, gw, gh, rad);
    });
  }
  return a;
}
/** Dilation (`grow`) or erosion by a square of radius r along one line of a 0/1 mask. */
function morphLine(src: Uint8Array, dst: Uint8Array, base: number, step: number, len: number, r: number, grow: boolean) {
  const win = 2 * r + 1;
  let cnt = 0;
  for (let q = 0; q <= r && q < len; q += 1) cnt += src[base + q * step];
  for (let q = 0; q < len; q += 1) {
    dst[base + q * step] = grow ? (cnt > 0 ? 1 : 0) : cnt === win ? 1 : 0;
    if (q + r + 1 < len) cnt += src[base + (q + r + 1) * step];
    if (q - r >= 0) cnt -= src[base + (q - r) * step];
  }
}
const EDT_INF = 1e20;
/**
 * Exact 1-D squared distance transform of `f` into `d` (Felzenszwalb & Huttenlocher), with
 * work buffers `v` and `z` (length ≥ len and len + 1).
 */
function edtLine(f: Float64Array, d: Float64Array, len: number, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -EDT_INF;
  z[1] = EDT_INF;
  for (let q = 1; q < len; q += 1) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (k > 0 && s <= z[k]) {
      k -= 1;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = EDT_INF;
  }
  k = 0;
  for (let q = 0; q < len; q += 1) {
    while (z[k + 1] < q) k += 1;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}
/** Euclidean distance (px) from every pixel of a gw × gh grid to the nearest pixel where mask === want. */
function* distanceTo(mask: Uint8Array, want: number, gw: number, gh: number): Generator<void, Float32Array> {
  const n = gw * gh;
  const out = new Float32Array(n);
  const len = Math.max(gw, gh);
  const f = new Float64Array(len);
  const d = new Float64Array(len);
  const v = new Int32Array(len);
  const z = new Float64Array(len + 1);
  yield* inChunks(n, 131072, (i0, i1) => {
    for (let i = i0; i < i1; i += 1) out[i] = mask[i] === want ? 0 : EDT_INF;
  });
  yield* inChunks(gw, 48, (x0, x1) => {
    for (let x = x0; x < x1; x += 1) {
      for (let y = 0; y < gh; y += 1) f[y] = out[y * gw + x];
      edtLine(f, d, gh, v, z);
      for (let y = 0; y < gh; y += 1) out[y * gw + x] = d[y];
    }
  });
  yield* inChunks(gh, 48, (y0, y1) => {
    for (let y = y0; y < y1; y += 1) {
      const base = y * gw;
      for (let x = 0; x < gw; x += 1) f[x] = out[base + x];
      edtLine(f, d, gw, v, z);
      for (let x = 0; x < gw; x += 1) out[base + x] = Math.sqrt(d[x]);
    }
  });
  return out;
}
/** Closing (dilate, then erode) of a gw × gh 0/1 mask by a square of radius r: gaps up to 2r px wide are bridged. */
function* closeMask(src: Uint8Array, gw: number, gh: number, r: number): Generator<void, Uint8Array> {
  let a = src;
  for (const [horizontal, grow] of [
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ] as const) {
    const from = a;
    const to = new Uint8Array(from.length);
    yield* inChunks(horizontal ? gh : gw, 96, (l0, l1) => {
      for (let l = l0; l < l1; l += 1) {
        if (horizontal) morphLine(from, to, l * gw, 1, gw, r, grow);
        else morphLine(from, to, l, gw, gh, r, grow);
      }
    });
    a = to;
  }
  return a;
}
/** 1 for every pixel reachable from the grid's border without crossing `wall` (4-connected). */
function* reachableFromBorder(wall: Uint8Array, gw: number, gh: number): Generator<void, Uint8Array> {
  const n = gw * gh;
  const out = new Uint8Array(n);
  const st = new Int32Array(n);
  let top = 0;
  const reach = (i: number) => {
    if (!wall[i] && !out[i]) {
      out[i] = 1;
      st[top++] = i;
    }
  };
  for (let x = 0; x < gw; x += 1) {
    reach(x);
    reach(n - gw + x);
  }
  for (let y = 0; y < gh; y += 1) {
    reach(y * gw);
    reach(y * gw + gw - 1);
  }
  const flood = () => {
    for (let popped = 0; top > 0 && popped < 65536; popped += 1) {
      const i = st[--top];
      const x = i % gw;
      if (x > 0) reach(i - 1);
      if (x < gw - 1) reach(i + 1);
      if (i >= gw) reach(i - gw);
      if (i < n - gw) reach(i + gw);
    }
  };
  while (top > 0) {
    flood();
    yield;
  }
  return out;
}
/**
 * The long, narrow gaps between parts of `ink` that `closed` bridges (the slits between
 * letters): 1 for gap components at least `minLen` px long; short fills (a V's tip, a corner)
 * are left out.
 */
function* longGaps(ink: Uint8Array, closed: Uint8Array, gw: number, gh: number, minLen: number): Generator<void, Uint8Array> {
  const n = gw * gh;
  const out = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const comp = new Int32Array(n);
  const st = new Int32Array(n);
  const gap = (j: number) => closed[j] === 1 && ink[j] === 0 && seen[j] === 0;
  yield* inChunks(n, 65536, (i0, i1) => {
    for (let i = i0; i < i1; i += 1) {
      if (!gap(i)) continue;
      let top = 0;
      let m = 0;
      let x0 = gw;
      let x1 = -1;
      let y0 = gh;
      let y1 = -1;
      seen[i] = 1;
      st[top++] = i;
      while (top > 0) {
        const j = st[--top];
        comp[m++] = j;
        const x = j % gw;
        const y = (j - x) / gw;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        for (const q of [x > 0 ? j - 1 : -1, x < gw - 1 ? j + 1 : -1, y > 0 ? j - gw : -1, y < gh - 1 ? j + gw : -1]) {
          if (q >= 0 && gap(q)) {
            seen[q] = 1;
            st[top++] = q;
          }
        }
      }
      if (Math.max(x1 - x0, y1 - y0) + 1 >= minLen) for (let q = 0; q < m; q += 1) out[comp[q]] = 1;
    }
  });
  return out;
}

function UdxLoaderImpl(
  {
  logoSrc = UDX_LOGO_SRC,
  logoAlt = 'UDX',
  label = 'Loading',
  text = 'UDX✝',
  accentColor = '#D35A36',
  textColor = '#3D3D3A',
  inkColor = '#111111',
  accentSymbols = true,
  spaceWidth = 1,
  background = '#FFFFFF',
  texture = false,
  maxLogoWidth,
  logoScale = 1,
  fullscreen = false,
  className,
  style,
  onComplete,
  onLogoError,
  autoPlay = true,
  onTimeUpdate,
}: UdxLoaderProps,
  ref: ForwardedRef<UdxLoaderHandle>,
) {
  const logoUrl = typeof logoSrc === 'string' ? logoSrc : (logoSrc?.src ?? '');
  const cells = useMemo(() => buildCells(text, accentSymbols, spaceWidth), [text, accentSymbols, spaceWidth]);

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const charsRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const trailRef = useRef<HTMLSpanElement>(null);
  const grainRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Latest props that must not restart the timeline.
  const live = useRef({
    onComplete,
    onLogoError,
    onTimeUpdate,
    autoPlay,
    accentColor,
    textColor,
    inkColor,
    maxLogoWidth,
    logoScale,
  });
  useEffect(() => {
    live.current = {
      onComplete,
      onLogoError,
      onTimeUpdate,
      autoPlay,
      accentColor,
      textColor,
      inkColor,
      maxLogoWidth,
      logoScale,
    };
  });

  // The timeline lives inside the effect below; the handle forwards to it.
  const ctrl = useRef<Omit<UdxLoaderHandle, 'duration'> | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      seek: (s: number) => ctrl.current?.seek(s),
      play: () => ctrl.current?.play(),
      pause: () => ctrl.current?.pause(),
      getTime: () => ctrl.current?.getTime() ?? 0,
      isPlaying: () => ctrl.current?.isPlaying() ?? false,
      duration: TIMELINE.end / TIMELINE.speed,
    }),
    [],
  );

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const line = lineRef.current;
    const chars = charsRef.current;
    const cursor = cursorRef.current;
    const trail = trailRef.current;
    const logo = logoRef.current;
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!root || !canvas || !line || !chars || !cursor || !trail || !logo || !img) return;

    const charEls = Array.from(chars.children) as HTMLElement[];
    const trailEls = Array.from(trail.children) as HTMLElement[];
    const smearEl = trailEls.find((el) => el.dataset.smear === '') ?? null;
    const ghosts = trailEls.filter((el) => el !== smearEl);
    const units = lineUnits(cells);
    const events = cursorEvents(cells); // typing only; the strike is an explicit path
    const cellCenterEm = (i: number, adv: number) => (cells[i].x + cells[i].w / 2) * adv;
    // Trailing symbols (the ✝ of "UDX✝") are struck by the caret and shatter; the letters
    // stay intact until the logo sweeps out of the screen through them.
    const trailing = trailingSymbolUnits(cells);
    const symbolIdx = cells
      .map((c, i) => (c.accent ? i : -1))
      .filter((i) => i >= 0 && i >= cells.length - Math.round(trailing));
    const wordCells = cells.filter((c) => !c.accent && c.ch.trim() !== '').length;
    // first letter of the typed word (the U of "UDX"): the caret is gone once it is revealed
    const firstWord = cells.findIndex((c) => !c.accent && c.ch.trim() !== '');
    const logoDepth = Array.from(logo.querySelectorAll('img[data-depth]')) as HTMLImageElement[];
    const logoImgs = [img, ...logoDepth];
    const fragments = generateCrossFragments();
    const ink = logoUrl === UDX_LOGO_SRC ? UDX_LOGO_INK : GENERIC_LOGO_INK;
    const glowEl = (name: string) => logo.querySelector<HTMLCanvasElement>(`canvas[data-glow="${name}"]`);
    const glowEls = { bloom: glowEl('bloom'), halo: glowEl('halo'), rim: glowEl('rim') };

    // ---- style writes, skipped when unchanged -------------------------------------------
    const written = new Map<HTMLElement, Record<string, string>>();
    const set = (el: HTMLElement, prop: string, value: string) => {
      let rec = written.get(el);
      if (!rec) written.set(el, (rec = {}));
      if (rec[prop] === value) return;
      rec[prop] = value;
      el.style.setProperty(prop, value);
    };

    // ---- state (plain variables: nothing here causes a React render) ---------------------
    let disposed = false;
    let raf = 0;
    let lastNow = -1;
    let t = 0;
    let completed = false;
    let fontCss = PRIMARY_STACK;
    let fontDecided = false;
    let advEm = 0.6;
    let baselineEm = 0.86;
    let canvasDirty = false;
    let logoState: 'pending' | 'ready' | 'failed' = 'pending';
    let logoErrorReported = false;
    let logoAspect = LOGO_NATURAL_ASPECT;
    let logoNaturalW = LOGO_NATURAL.w;
    let reducedReadyAt = -1;
    let playing = live.current.autoPlay !== false;
    let scrubbed = false;
    let pendingDraw = 0;
    let cursorRetiredAt = Number.POSITIVE_INFINITY;
    /**
     * The logo's actual ink shape: per-pixel ink coverage (0–255; counters, slits and every
     * other negative space are 0) and its bottom outline: per column (x0…x1), the lowest ink
     * row, with narrow notches (the slits) bridged so the edge is continuous.
     */
    let sil: { mask: Uint8ClampedArray; bottom: Int32Array; x0: number; x1: number; w: number; h: number } | null =
      null;
    /**
     * Where the fragments may be (FRAGMENTS.bound): the logo's outer silhouette and the band just
     * above it, on the silhouette's grid with margins of `padX` px (sides, bottom) and `padTop`
     * px (top): how deep each point lies inside that area (silhouette px; 0 outside).
     */
    let shape: { depth: Float32Array; gw: number; gh: number; padX: number; padTop: number; w: number; h: number } | null =
      null;
    /** Builds `shape` in small slices of idle time (finished on demand if needed sooner). */
    let shapeWork: Generator<void, void> | null = null;
    let shapeIdle: { id: number; idle: boolean } | null = null;
    function* shapeJob(mask: Uint8ClampedArray, w: number, h: number): Generator<void, void> {
      // the outer silhouette: closed (channels, notches, slits bridged) and filled (counters)
      const r = Math.max(1, Math.round(FRAGMENTS.bound.close * (ink.x1 - ink.x0) * w));
      const padX = r + 2;
      const up = Math.max(0, Math.round(FRAGMENTS.bound.above * h));
      const padTop = padX + up;
      const gw = w + 2 * padX;
      const gh = h + padTop + padX;
      const solid = new Uint8Array(gw * gh);
      for (let yy = 0; yy < h; yy += 1) {
        for (let xx = 0; xx < w; xx += 1) solid[(yy + padTop) * gw + xx + padX] = mask[yy * w + xx] >= 128 ? 1 : 0;
      }
      yield;
      const closed = yield* closeMask(solid, gw, gh, r);
      const outside = yield* reachableFromBorder(closed, gw, gh);
      // ...and the band above it: every column of the silhouette extends `up` px above its top
      for (let x = 0; x < gw; x += 1) {
        let top = 0;
        while (top < gh && outside[top * gw + x]) top += 1;
        if (top >= gh) continue; // no silhouette in this column
        for (let y = Math.max(0, top - up); y < top; y += 1) outside[y * gw + x] = 0;
      }
      yield;
      const depth = yield* distanceTo(outside, 1, gw, gh);
      shape = { depth, gw, gh, padX, padTop, w, h };
    }
    /** Works on the silhouette shape while `more()` allows (always at least one step). */
    const advanceShape = (more: () => boolean) => {
      if (!shapeWork) return;
      try {
        do {
          if (shapeWork.next().done) {
            shapeWork = null;
            return;
          }
        } while (more());
      } catch {
        shapeWork = null;
        shape = null; // fragments keep their plain fade
      }
    };
    const cancelShapeIdle = () => {
      if (!shapeIdle) return;
      if (shapeIdle.idle) window.cancelIdleCallback?.(shapeIdle.id);
      else window.clearTimeout(shapeIdle.id);
      shapeIdle = null;
    };
    const scheduleShape = () => {
      if (shapeIdle || !shapeWork || disposed) return;
      const run = (deadline?: IdleDeadline) => {
        shapeIdle = null;
        if (disposed || !shapeWork) return;
        const until = performance.now() + 4;
        advanceShape(() => (deadline ? deadline.timeRemaining() > 2 : performance.now() < until));
        if (shapeWork) scheduleShape();
        else scheduleHideTimes(); // then work out the fragments' bounds in idle time too
      };
      if (typeof window.requestIdleCallback === 'function') {
        shapeIdle = { id: window.requestIdleCallback(run, { timeout: 300 }), idle: true };
      } else {
        shapeIdle = { id: window.setTimeout(run, 16), idle: false };
      }
    };
    type HideJob = {
      key: string;
      at: Float64Array[];
      prevCovered: Float64Array[];
      prevBelow: Uint8Array[];
      spots: Array<{ ox: number; oy: number; spawn: number[] }>;
      t: number;
      open: number;
      done: boolean;
    };
    let hideJob: HideJob | null = null;
    let hideIdle: { id: number; idle: boolean } | null = null;
    /**
     * Fragment hide times cost a few ms once per layout. They are worked out in small slices of
     * idle time (during the typing, long before the strike), so no frame is ever held up;
     * drawCanvas finishes whatever is left on demand if they aren't ready yet (e.g. right after
     * a resize).
     */
    const scheduleHideTimes = () => {
      if (hideIdle || disposed) return;
      const run = (deadline?: IdleDeadline) => {
        hideIdle = null;
        if (disposed || logoState !== 'ready' || !sil || !fontDecided || !(L.w > 0)) return;
        try {
          const g = geometry();
          const job = hideJobFor(g);
          const until = performance.now() + 4;
          let first = true; // always make progress, even if the idle period is already over
          advanceHideJob(job, g, () => {
            if (first) {
              first = false;
              return true;
            }
            return deadline ? deadline.timeRemaining() > 1 : performance.now() < until;
          });
          if (!job.done) scheduleHideTimes();
          else if (!shapeWork) fragmentBounds(g); // where each piece must be gone by (cached; cheap)
        } catch {
          hideJob = null; // computed on demand instead
        }
      };
      if (typeof window.requestIdleCallback === 'function') {
        hideIdle = { id: window.requestIdleCallback(run, { timeout: 250 }), idle: true };
      } else {
        hideIdle = { id: window.setTimeout(run, 16), idle: false };
      }
    };
    /**
     * Layout in px. `sx`, `sy`: the stage centre (root px), where the typed line, cursor, struck
     * cross and fragments are anchored: the logo's own centre, so the word, the cross and its
     * fragments keep exactly their original placement relative to the logo (whose ink is centred
     * in the loader).
     */
    const L = { w: 0, h: 0, font: 40, fontFull: 45, logoW: 200, logoH: 166, dpr: 1, snap: 1, cw: 2, logoX: 0, logoY: 0, sx: 0, sy: 0 };
    const ctx = (() => {
      try {
        return canvas.getContext('2d');
      } catch {
        return null;
      }
    })();

    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    let reduced = !!mq?.matches;

    // ---- layout ------------------------------------------------------------------------
    const applyLayout = () => {
      const r = root.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      L.w = r.width;
      L.h = r.height;
      const userCap = live.current.maxLogoWidth;
      const fit = (aspect: number, cap: number) =>
        Math.round(Math.max(48, Math.min(cap, L.w * 0.62, L.h * 0.5 * aspect)));
      // Text size depends on the container only, so a late-loading logo can't resize it mid-typing.
      const textCap = userCap && userCap > 0 ? userCap : LOGO_NATURAL.w;
      // fontFull: the size the logo is matched to; the typed line and cursor are drawn TYPE_SCALE of it
      L.fontFull = Math.min(fit(LOGO_NATURAL_ASPECT, textCap) * FONT_TO_LOGO, (L.w * 0.86) / Math.max(1, units * advEm));
      L.font = L.fontFull * TYPE_SCALE;
      // Logo size follows the typed word: its ink is as wide as "UDX" × logoScale, never
      // larger than the file itself, maxLogoWidth, or the container.
      const wordW = (wordCells > 0 ? wordCells : units) * advEm * L.fontFull;
      const scale = live.current.logoScale > 0 && Number.isFinite(live.current.logoScale) ? live.current.logoScale : 1;
      const target = (wordW * scale) / Math.max(0.2, ink.x1 - ink.x0);
      const capW = userCap && userCap > 0 ? userCap : logoNaturalW;
      L.logoW = Math.round(Math.max(24, Math.min(target, capW, L.w * 0.62, L.h * 0.5 * logoAspect)));
      L.logoH = L.logoW / logoAspect; // exact: the image keeps the file's proportions
      L.snap = window.devicePixelRatio || 1;
      L.dpr = Math.min(2, L.snap);
      hideJob = null; // fragment hide times depend on the layout

      const cw = Math.round(L.w * L.dpr);
      const ch = Math.round(L.h * L.dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
        canvasDirty = true;
      }

      const F = L.font;
      const adv = advEm * F;
      set(root, '--udx-font-size', px(F));
      charEls.forEach((el, i) => {
        set(el, 'left', px(cells[i].x * adv));
        set(el, 'top', px((CAP_HALF_EM - baselineEm) * F));
        set(el, 'width', px(cells[i].w * adv));
        set(el, 'height', px(F));
        set(el, 'transform-origin', `50% ${num(baselineEm * 100)}%`);
      });
      // Caret proportions measured from the reference: 1.13 em tall, top 0.874 em above
      // the baseline, ~0.075 em wide. Integer px so it never resamples while it moves.
      const cwPx = Math.max(2, Math.round(F * 0.075));
      L.cw = cwPx;
      const chPx = Math.round(F * 1.13);
      if (smearEl) {
        set(smearEl, 'height', `${Math.round(chPx * 0.7)}px`);
        set(smearEl, 'top', `${Math.round((CAP_HALF_EM - 0.874) * F + chPx * 0.15)}px`);
      }
      [cursor, ...ghosts].forEach((el) => {
        set(el, 'width', `${cwPx}px`);
        set(el, 'height', `${chPx}px`);
        set(el, 'left', `${-cwPx / 2}px`);
        set(el, 'top', `${Math.round((CAP_HALF_EM - 0.874) * F)}px`);
      });
      // Whole-pixel box and position, centred. The logo layer itself covers the whole
      // loader, so the slide and the 3D depth layers can never be clipped.
      // centred on its ink (the file has uneven margins), so the mark itself sits in the middle
      L.logoX = Math.round(L.w / 2 - ((ink.x0 + ink.x1) / 2) * L.logoW);
      L.logoY = Math.round(L.h / 2 - ((ink.y0 + ink.y1) / 2) * L.logoH);
      L.sx = Math.round(L.logoX + L.logoW / 2);
      L.sy = Math.round(L.logoY + L.logoH / 2);
      if (stage) {
        set(stage, 'left', `${L.sx}px`);
        set(stage, 'top', `${L.sy}px`);
      } else {
        L.sx = L.w / 2; // the stage stays at its CSS centre
        L.sy = L.h / 2;
      }
      logoImgs.forEach((el) => {
        set(el, 'width', `${L.logoW}px`);
        set(el, 'height', 'auto'); // from the width and the file's own aspect ratio
        set(el, 'left', `${L.logoX}px`);
        set(el, 'top', `${L.logoY}px`);
      });
      placeGlow();
      refreshGlow();
      if (disposed) return;
      scheduleHideTimes(); // precompute off the critical frames (idle time while typing)
      draw(t);
    };

    // ---- font ----------------------------------------------------------------------------
    const decideFont = (ok: boolean) => {
      if (fontDecided || disposed) return;
      fontDecided = true;
      if (!ok) {
        fontCss = FALLBACK_STACK;
        set(root, '--udx-font-family', FALLBACK_STACK);
      }
      try {
        const m = document.createElement('canvas').getContext('2d');
        if (m) {
          m.font = `${UDX_FONT_WEIGHT} 100px ${fontCss}`;
          const w = m.measureText('0').width;
          if (w > 0) advEm = w / 100;
        }
        const probe = document.createElement('span');
        probe.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;white-space:pre;font:${UDX_FONT_WEIGHT} 100px/1 ${fontCss}`;
        probe.textContent = 'U';
        const mark = document.createElement('span');
        mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
        probe.appendChild(mark);
        root.appendChild(probe);
        const b = mark.getBoundingClientRect().top - probe.getBoundingClientRect().top;
        root.removeChild(probe);
        if (b > 20 && b < 140) baselineEm = b / 100;
      } catch {
        /* keep JetBrains Mono defaults */
      }
      applyLayout();
    };

    // ---- logo ----------------------------------------------------------------------------
    /**
     * Reads the logo's ink shape from its own pixels (dark, opaque = ink; edges keep their
     * anti-aliasing). Occlusion itself is done by the layering (fragments are beneath the logo,
     * so only black ink hides them and negative spaces stay see-through); this shape is used to
     * tell when a fragment is completely behind the ink and where it would come out again. If
     * the image can't be read (e.g. a cross-origin URL without CORS), the layering still works.
     */
    const buildSilhouette = () => {
      sil = null;
      shape = null;
      shapeWork = null;
      cancelShapeIdle();
      hideJob = null;
      try {
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        if (!nw || !nh) return;
        const k = Math.min(1, 512 / Math.max(nw, nh));
        const w = Math.max(1, Math.round(nw * k));
        const h = Math.max(1, Math.round(nh * k));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const x = c.getContext('2d', { willReadFrequently: true });
        if (!x) return;
        x.drawImage(img, 0, 0, w, h);
        const d = x.getImageData(0, 0, w, h).data; // throws on a tainted (cross-origin) image
        const mask = new Uint8ClampedArray(w * h);
        const bottom = new Int32Array(w).fill(-1);
        for (let yy = 0; yy < h; yy += 1) {
          for (let xx = 0; xx < w; xx += 1) {
            const i = yy * w + xx;
            const lum = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
            const cv = (d[i * 4 + 3] / 255) * (1 - lum / 255);
            mask[i] = Math.round(cv * 255);
            if (cv > 0.5) bottom[xx] = yy;
          }
        }
        let x0 = 0;
        while (x0 < w && bottom[x0] < 0) x0 += 1;
        let x1 = w - 1;
        while (x1 >= 0 && bottom[x1] < 0) x1 -= 1;
        if (x0 > x1) return; // no ink at all
        // Bridge narrow notches in the bottom outline (the slits between letters, and columns with
        // only a few ink pixels near the top): a column's edge is never higher than the lower of
        // the lowest edges within ~5 % of the width on both sides. Wider features (the U's point,
        // the curved bottom) are untouched.
        const raw = bottom.slice();
        const reach = Math.max(3, Math.round(0.05 * w));
        for (let u = x0; u <= x1; u += 1) {
          let left = -1;
          let right = -1;
          for (let m = Math.max(x0, u - reach); m < u; m += 1) left = Math.max(left, raw[m]);
          for (let m = u + 1; m <= Math.min(x1, u + reach); m += 1) right = Math.max(right, raw[m]);
          bottom[u] = Math.max(raw[u], Math.min(left, right));
        }
        sil = { mask, bottom, x0, x1, w, h };
        shapeWork = shapeJob(mask, w, h); // the outer silhouette for the fragments, in idle time
        scheduleShape();
      } catch {
        sil = null; // keep the plain layering
        shape = null;
        shapeWork = null;
      }
    };
    // ---- glow ------------------------------------------------------------------------------
    /**
     * One of the glow's bitmaps, placed over the logo's box: `gw` × `gh` px, the logo image
     * filling `iw` × `ih` of it inside a margin of `pad` px.
     */
    type GlowGrid = { gw: number; gh: number; iw: number; ih: number; pad: number };
    /** `fine`: rim and halo (about the logo's device resolution); `coarse`: bloom. */
    let glowLayout: { fine: GlowGrid; coarse: GlowGrid } | null = null;
    let glowWork: Generator<void, boolean> | null = null;
    let glowIdle: { id: number; idle: boolean } | null = null;
    /** Device px of the logo the glow was built for (it is rebuilt if the logo is later shown much sharper). */
    let glowBuiltFor = 0;
    /**
     * Timeline time at which the glow became ready, if that was only during its own pulse (a
     * very slow device): it then eases in from there instead of popping in. -∞: ready in time.
     */
    let glowLateAt = Number.NEGATIVE_INFINITY;
    /** Fine-grid scale (× the silhouette) for a logo shown `device` px wide. */
    const glowScale = (device: number, w: number) => Math.min(GLOW.fine.maxScale, Math.max(1, device / Math.max(1, w)));
    /**
     * Builds the glow's three layers from the logo's own pixels, traced from its exact
     * silhouette (see GLOW):
     *  - the source is the logo's complete pixel mask: everything that isn't ink is outside, so
     *    every edge glows, the slits between letters and the D's counter included (the slits
     *    themselves stay clear of halo and bloom, so the letters stay apart). On the
     *    silhouette's own grid (coarse), the direction each edge faces sets how strongly it
     *    glows (down: full, up: `around`), as smooth fields;
     *  - the logo is read again at about its on-screen device resolution (fine), and exact
     *    distances to its outline (inside and outside) shape the rim and the halo, so the light
     *    follows its edges, corners and notches as sharply as the logo itself is drawn;
     *  - the bloom is the halo blurred into a soft aura on the coarse grid, outside only.
     * A resumable job: small slices of idle time during the typing, so no frame is held up.
     */
    function* glowJob(): Generator<void, boolean> {
      const sh = sil;
      const { rim: cRim, halo: cHalo, bloom: cBloom } = glowEls;
      const el = img; // narrowed once (generators don't keep the outer narrowing)
      if (!sh || !cRim || !cHalo || !cBloom || !el || !el.naturalWidth || !el.naturalHeight) return false;
      const { w, h, mask } = sh;

      // ==== coarse grid (the silhouette's resolution, with the bloom's margin): the outline's
      // structure, which way each edge faces and how strongly it glows (smooth fields), the bloom
      const cpad = Math.max(8, Math.round(GLOW.bloom.margin * h));
      const cgw = w + 2 * cpad;
      const cgh = h + 2 * cpad;
      const cn = cgw * cgh;
      const inkC = new Uint8Array(cn);
      yield* inChunks(h, 128, (y0, y1) => {
        for (let y = y0; y < y1; y += 1) {
          for (let x = 0; x < w; x += 1) inkC[(y + cpad) * cgw + x + cpad] = mask[y * w + x] >= 128 ? 1 : 0;
        }
      });
      // the complete mask: everything that isn't ink is outside, so every edge of the mark glows
      // (the slits between letters and the D's counter included)
      const extC = new Uint8Array(cn);
      // the slits themselves stay clear of halo and bloom (their walls glow, so the letters stay
      // apart): long, narrow gaps a small closing bridges
      const bridged = yield* closeMask(inkC, cgw, cgh, Math.max(1, Math.round(GLOW.slit * (ink.x1 - ink.x0) * w)));
      const slitC = yield* longGaps(inkC, bridged, cgw, cgh, GLOW.slitLength * Math.max(0.05, ink.y1 - ink.y0) * h);
      const solidC = new Float32Array(cn);
      yield* inChunks(cn, 131072, (i0, i1) => {
        for (let i = i0; i < i1; i += 1) extC[i] = inkC[i] ? 0 : 1;
      });
      // edge directions (outward normal from a smoothed outline) → strength: down 1, up `around`
      yield* inChunks(cn, 131072, (i0, i1) => {
        for (let i = i0; i < i1; i += 1) solidC[i] = extC[i] ? 0 : 1;
      });
      const smoothC = yield* boxBlur(solidC, cgw, cgh, Math.max(1, Math.round(GLOW.normal * h)), 2);
      const edgeC = new Float32Array(cn);
      const edgeWC = new Float32Array(cn);
      yield* inChunks(cgh - 2, 128, (r0, r1) => {
        for (let y = r0 + 1; y < r1 + 1; y += 1) {
          for (let x = 1; x < cgw - 1; x += 1) {
            const i = y * cgw + x;
            const e = extC[i];
            if (extC[i - 1] === e && extC[i + 1] === e && extC[i - cgw] === e && extC[i + cgw] === e) continue;
            const gx = smoothC[i + 1] - smoothC[i - 1];
            const gy = smoothC[i + cgw] - smoothC[i - cgw];
            const len = Math.hypot(gx, gy);
            const down = len > 1e-6 ? -gy / len : 0; // the outward normal's downward part
            edgeC[i] = 1;
            edgeWC[i] = GLOW.around + (1 - GLOW.around) * smoothstep(-0.9, 1, down);
          }
        }
      });
      /** The nearby edges' average strength at every coarse pixel (smooth around corners). */
      const strength = function* (blend: number): Generator<void, Float32Array> {
        const rad = Math.max(1, Math.round(blend * h));
        const sum = yield* boxBlur(edgeWC, cgw, cgh, rad, 3);
        const cnt = yield* boxBlur(edgeC, cgw, cgh, rad, 3);
        yield* inChunks(cn, 131072, (i0, i1) => {
          for (let i = i0; i < i1; i += 1) sum[i] = cnt[i] > 1e-7 ? Math.min(1, sum[i] / cnt[i]) : GLOW.around;
        });
        return sum;
      };
      const wRimC = yield* strength(GLOW.rim.blend);
      const wHaloC = yield* strength(GLOW.halo.blend);

      // ==== fine grid: the logo at about its on-screen device resolution, so the light follows
      // its edges, corners and notches as sharply as the logo itself is drawn
      glowBuiltFor = Math.max(1, L.logoW) * (L.snap || 1);
      let s = glowScale(glowBuiltFor, w);
      const cellsAt = (k: number) => {
        const p = 2 * (Math.ceil(GLOW.fine.margin * h * k) + 2);
        return (w * k + p) * (h * k + p);
      };
      while (s > 1 && cellsAt(s) > GLOW.fine.maxCells) s = Math.max(1, s * 0.9);
      const iw = Math.max(1, Math.round(w * s));
      const ih = Math.max(1, Math.round(h * s));
      const pad = Math.ceil(GLOW.fine.margin * ih) + 2;
      const gw = iw + 2 * pad;
      const gh = ih + 2 * pad;
      const n = gw * gh;
      // fine pixel → coarse position (bilinear): per column and per row
      const sxk = w / iw;
      const syk = h / ih;
      const cx0 = new Int32Array(gw);
      const cxf = new Float32Array(gw);
      const cy0 = new Int32Array(gh);
      const cyf = new Float32Array(gh);
      for (let x = 0; x < gw; x += 1) {
        const u = Math.min(cgw - 1.001, Math.max(0, (x - pad + 0.5) * sxk - 0.5 + cpad));
        cx0[x] = Math.floor(u);
        cxf[x] = u - cx0[x];
      }
      for (let y = 0; y < gh; y += 1) {
        const v = Math.min(cgh - 1.001, Math.max(0, (y - pad + 0.5) * syk - 0.5 + cpad));
        cy0[y] = Math.floor(v);
        cyf[y] = v - cy0[y];
      }
      const lerpC = (f: Float32Array, x: number, y: number) => {
        const j = cy0[y] * cgw + cx0[x];
        const ax = cxf[x];
        const ay = cyf[y];
        const top = f[j] + (f[j + 1] - f[j]) * ax;
        const bot = f[j + cgw] + (f[j + cgw + 1] - f[j + cgw]) * ax;
        return top + (bot - top) * ay;
      };
      const cov = new Float32Array(n); // ink coverage (0–1), as the logo's own pixels give it
      const ext = new Uint8Array(n); // outside the ink (the complete mask)
      const slitF = new Uint8Array(n); // in a slit (nearest coarse pixel)
      {
        const c = document.createElement('canvas');
        c.width = iw;
        c.height = ih;
        const x = c.getContext('2d', { willReadFrequently: true });
        if (!x) return false;
        x.imageSmoothingEnabled = true;
        x.imageSmoothingQuality = 'high';
        x.drawImage(el, 0, 0, iw, ih);
        const d = x.getImageData(0, 0, iw, ih).data; // readable: the silhouette was read already
        yield;
        yield* inChunks(gh, 64, (y0, y1) => {
          for (let yy = y0; yy < y1; yy += 1) {
            for (let xx = 0; xx < gw; xx += 1) {
              const i = yy * gw + xx;
              const ix = xx - pad;
              const iy = yy - pad;
              let v = 0;
              if (ix >= 0 && ix < iw && iy >= 0 && iy < ih) {
                const k = (iy * iw + ix) * 4;
                const lum = 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
                v = (d[k + 3] / 255) * (1 - lum / 255);
              }
              cov[i] = v;
              ext[i] = v >= 0.5 ? 0 : 1;
              slitF[i] = v < 0.5 && slitC[(cy0[yy] + (cyf[yy] >= 0.5 ? 1 : 0)) * cgw + cx0[xx] + (cxf[xx] >= 0.5 ? 1 : 0)] ? 1 : 0;
            }
          }
        });
      }
      // exact distances: outside, to the outline; inside, to the outside
      const dOut = yield* distanceTo(ext, 0, gw, gh);
      const dIn = yield* distanceTo(ext, 1, gw, gh);
      // ---- rim: a crisp band on the ink's own outer edges, hottest at the lower edges. Full
      // strength right through the edge's anti-aliased pixels, so no pale seam shows.
      const rimA = new Float32Array(n);
      const rimT = new Float32Array(n); // 0: hot (at the edge) → 1: deep red
      const lr = Math.max(0.6, GLOW.rim.width * ih);
      // ---- halo: just outside the edges, continuing under the ink's edge (hidden there)
      const halo0 = new Float32Array(n);
      const lh = Math.max(0.8, GLOW.halo.width * ih);
      const reachH = 6 * lh * 1.2; // beyond this the halo is invisible
      yield* inChunks(gh, 48, (y0, y1) => {
        for (let y = y0; y < y1; y += 1) {
          for (let x = 0; x < gw; x += 1) {
            const i = y * gw + x;
            const out = ext[i] === 1;
            if (cov[i] > 0.004) {
              const depth = out ? 0 : Math.max(0, dIn[i] - 0.5);
              if (depth <= 3.6 * lr) {
                const wi = lerpC(wRimC, x, y);
                const li = lr * (0.75 + 0.35 * wi); // reaches a little further in on the lower edges
                const q = depth / li;
                rimA[i] = wi * Math.exp(-q * q) * Math.min(1, 2.5 * cov[i]); // no haze in the black
                rimT[i] = Math.max(Math.min(1, depth / (1.5 * li)), 0.6 * (1 - wi));
              }
            }
            if (out) {
              if (dOut[i] < reachH) {
                const wi = lerpC(wHaloC, x, y);
                halo0[i] = wi * Math.exp(-Math.max(0, dOut[i] - 0.5) / (lh * (0.8 + 0.3 * wi)));
              }
            } else if (cov[i] >= 0.5 && dIn[i] < 4) halo0[i] = lerpC(wHaloC, x, y);
          }
        }
      });
      // a touch of softening (about one device pixel) so no crease shows at inner corners
      const haloA = yield* boxBlur(halo0, gw, gh, Math.max(1, Math.round(0.4 * s)), 1);
      yield* inChunks(n, 131072, (i0, i1) => {
        for (let i = i0; i < i1; i += 1) if (slitF[i]) haloA[i] = 0; // the slits stay clear
      });
      // ---- bloom (coarse): the halo blurred into a soft aura around the silhouette, outside only
      const src = new Float32Array(cn);
      const drop = GLOW.bloom.drop * h;
      const fxk = iw / w;
      const fyk = ih / h;
      yield* inChunks(cgh, 48, (c0, c1) => {
        for (let cy = c0; cy < c1; cy += 1) {
          const ys = Math.round((cy - cpad - drop + 0.5) * fyk - 0.5) + pad; // source row (sunk by `drop`)
          if (ys < 0 || ys >= gh) continue;
          for (let cx = 0; cx < cgw; cx += 1) {
            const x = Math.round((cx - cpad + 0.5) * fxk - 0.5) + pad;
            if (x < 0 || x >= gw) continue;
            src[cy * cgw + cx] = haloA[ys * gw + x];
          }
        }
      });
      const bl = yield* boxBlur(src, cgw, cgh, Math.max(2, Math.round(GLOW.bloom.radius * h)), 3);
      const outC = new Float32Array(cn);
      yield* inChunks(cn, 131072, (i0, i1) => {
        for (let i = i0; i < i1; i += 1) outC[i] = extC[i] && !slitC[i] ? 1 : 0;
      });
      const soft = yield* boxBlur(outC, cgw, cgh, 1, 1);
      const bloomA = new Float32Array(cn);
      yield* inChunks(cn, 131072, (i0, i1) => {
        for (let i = i0; i < i1; i += 1) bloomA[i] = Math.min(1, GLOW.bloom.gain * bl[i]) * soft[i];
      });
      // ---- paint the three bitmaps
      const paint = function* (
        c: HTMLCanvasElement,
        cw: number,
        ch: number,
        alpha: Float32Array,
        tone: Float32Array | null,
        from: readonly number[],
        to: readonly number[],
      ): Generator<void, boolean> {
        const data = new Uint8ClampedArray(cw * ch * 4);
        yield* inChunks(cw * ch, 65536, (i0, i1) => {
          for (let i = i0; i < i1; i += 1) {
            const a = alpha[i];
            if (!(a > 0.002)) continue;
            const k = tone ? tone[i] : 0;
            data[i * 4] = from[0] + (to[0] - from[0]) * k;
            data[i * 4 + 1] = from[1] + (to[1] - from[1]) * k;
            data[i * 4 + 2] = from[2] + (to[2] - from[2]) * k;
            data[i * 4 + 3] = Math.min(1, a) * 255;
          }
        });
        c.width = cw;
        c.height = ch;
        const x = c.getContext('2d');
        if (!x) return false;
        const im = x.createImageData(cw, ch);
        im.data.set(data);
        x.putImageData(im, 0, 0);
        return true;
      };
      const rimOk = yield* paint(cRim, gw, gh, rimA, rimT, GLOW.rim.hot, GLOW.rim.deep);
      const haloOk = yield* paint(cHalo, gw, gh, haloA, null, GLOW.halo.color, GLOW.halo.color);
      const bloomOk = yield* paint(cBloom, cgw, cgh, bloomA, null, GLOW.bloom.color, GLOW.bloom.color);
      if (!(rimOk && haloOk && bloomOk)) return false;
      glowLayout = {
        fine: { gw, gh, iw, ih, pad },
        coarse: { gw: cgw, gh: cgh, iw: w, ih: h, pad: cpad },
      };
      return true;
    }
    /**
     * Works on the glow while `more()` allows (always at least one step). `now`: the timeline
     * time; if the glow only becomes ready during its own pulse, it eases in from then on.
     */
    const advanceGlow = (more: () => boolean, now: number) => {
      if (!glowWork) return;
      try {
        do {
          const r = glowWork.next();
          if (r.done) {
            glowWork = null;
            if (r.value) {
              placeGlow();
              glowLateAt = now > GLOW.start ? now : Number.NEGATIVE_INFINITY;
            }
            return;
          }
        } while (more());
      } catch {
        glowWork = null;
        glowLayout = null; // no glow; everything else is unaffected
      }
    };
    const cancelGlowIdle = () => {
      if (!glowIdle) return;
      if (glowIdle.idle) window.cancelIdleCallback?.(glowIdle.id);
      else window.clearTimeout(glowIdle.id);
      glowIdle = null;
    };
    const scheduleGlow = () => {
      if (glowIdle || !glowWork || disposed) return;
      const run = (deadline?: IdleDeadline) => {
        glowIdle = null;
        if (disposed || !glowWork) return;
        const until = performance.now() + 4;
        advanceGlow(() => (deadline ? deadline.timeRemaining() > 2 : performance.now() < until), t);
        scheduleGlow();
      };
      if (typeof window.requestIdleCallback === 'function') {
        glowIdle = { id: window.requestIdleCallback(run, { timeout: 500 }), idle: true };
      } else {
        glowIdle = { id: window.setTimeout(run, 16), idle: false };
      }
    };
    const buildGlow = () => {
      cancelGlowIdle();
      glowLayout = null;
      glowBuiltFor = 0;
      glowLateAt = Number.NEGATIVE_INFINITY;
      glowWork = sil ? glowJob() : null; // a logo that can't be read: no glow
      scheduleGlow();
    };
    /**
     * After a layout change: if the logo is now shown much sharper than the glow was built for
     * (e.g. it was built before the first layout, or the window moved to a denser screen), it is
     * rebuilt in idle time, as long as there is plenty of time before it lights up.
     */
    const refreshGlow = () => {
      if (logoState !== 'ready' || !sil || !(glowBuiltFor > 0) || !(t < GLOW.start - 0.6)) return;
      const now = glowScale(L.logoW * (L.snap || 1), sil.w);
      if (now > glowScale(glowBuiltFor, sil.w) * 1.25) buildGlow();
    };
    /** Places the glow layers exactly over the logo (their margins around it, same scale). */
    const placeGlow = () => {
      const gl = glowLayout;
      if (!gl || !(L.logoW > 0) || !(L.logoH > 0)) return;
      const put = (el: HTMLCanvasElement | null, g: GlowGrid) => {
        if (!el) return;
        const kx = L.logoW / g.iw;
        const ky = L.logoH / g.ih;
        set(el, 'width', px(g.gw * kx));
        set(el, 'height', px(g.gh * ky));
        set(el, 'left', px(L.logoX - g.pad * kx));
        set(el, 'top', px(L.logoY - g.pad * ky));
      };
      put(glowEls.bloom, gl.coarse);
      put(glowEls.halo, gl.fine);
      put(glowEls.rim, gl.fine);
    };
    /**
     * Shows the glow at `strength` (0–1), on the logo's own transform (`base`, the same string
     * as the logo image's), so it stays locked to the silhouette: only the opacities change.
     */
    const applyGlow = (strength: number, base: string) => {
      const on = !!glowLayout && logoState === 'ready' && strength > 0.002;
      const layers = [
        [glowEls.bloom, GLOW.bloom.opacity],
        [glowEls.halo, GLOW.halo.opacity],
        [glowEls.rim, GLOW.rim.opacity],
      ] as const;
      layers.forEach(([el, opacity]) => {
        if (!el) return;
        if (!on) {
          set(el, 'opacity', '0');
          return;
        }
        set(el, 'opacity', num(opacity * strength));
        set(el, 'transform', base || 'none');
      });
    };

    const pre = new Image();
    const failLogo = () => {
      logoState = 'failed';
      sil = null;
      shape = null;
      shapeWork = null;
      cancelShapeIdle();
      hideJob = null;
      cancelGlowIdle();
      glowWork = null;
      glowLayout = null;
      pre.onload = pre.onerror = null;
      img.removeAttribute('src');
      logoDepth.forEach((g) => g.removeAttribute('src'));
      if (logoErrorReported || disposed) return;
      logoErrorReported = true;
      try {
        live.current.onLogoError?.();
      } catch {
        /* consumer callback errors must not break the loader */
      }
    };
    if (logoUrl) {
      pre.decoding = 'async';
      pre.onload = () => {
        if (disposed || logoState !== 'pending') return;
        img.src = logoUrl;
        const ready = () => {
          if (disposed || logoState !== 'pending') return;
          if (!img.naturalWidth) return failLogo();
          logoState = 'ready';
          buildSilhouette();
          buildGlow();
          logoDepth.forEach((g) => (g.src = logoUrl));
          logoAspect = img.naturalWidth / img.naturalHeight || LOGO_NATURAL_ASPECT;
          logoNaturalW = img.naturalWidth;
          applyLayout();
        };
        (typeof img.decode === 'function' ? img.decode() : Promise.resolve()).then(ready, () => {
          if (img.complete && img.naturalWidth) ready();
          else failLogo();
        });
      };
      pre.onerror = () => {
        if (!disposed && logoState === 'pending') failLogo();
      };
      pre.src = logoUrl;
    } else {
      failLogo();
    }

    // ---- frame -----------------------------------------------------------------------------
    const hideAll = (els: HTMLElement[]) => els.forEach((el) => set(el, 'visibility', 'hidden'));
    /** Shows, or removes from rendering entirely (opacity 0, hidden, display none), every caret layer. */
    const showCursorLayers = (on: boolean) => {
      [cursor, trail, ...trailEls].forEach((el) => {
        // the layers' own opacities are re-applied every visible frame; the container has none
        if (!on && el !== trail) set(el, 'opacity', '0');
        set(el, 'visibility', on ? 'visible' : 'hidden');
        set(el, 'display', on ? '' : 'none');
      });
    };

    /**
     * The logo image's filter. Supplied UDX logo only: when the file is shown larger than its
     * own pixels (high-density screens), a matching contrast keeps its edges as crisp as the
     * original. It only steepens the grey anti-aliasing of the black-on-white mark: its outline
     * stays exactly where it is and the black stays black. Eased in as the logo emerges.
     */
    const logoFilter = (blur: number, ec: number) => {
      const up = ink === UDX_LOGO_INK ? (L.logoW * L.snap) / Math.max(1, logoNaturalW) : 1;
      const c = 1 + (Math.min(2.6, Math.max(1, up)) - 1) * clamp01(ec);
      const parts: string[] = [];
      if (blur > 0.05) parts.push(`blur(${px(blur)})`);
      if (c > 1.01) parts.push(`contrast(${num(c)})`);
      return parts.join(' ') || 'none';
    };

    function renderReduced(time: number) {
      showCursorLayers(false);
      set(line!, 'transform', 'none');
      logoDepth.forEach((g) => set(g, 'opacity', '0'));
      set(logo!, 'mask-image', 'none');
      set(logo!, '-webkit-mask-image', 'none');
      if (logoState === 'ready') {
        if (reducedReadyAt < 0) reducedReadyAt = time;
        hideAll(charEls);
        set(logo!, 'visibility', 'visible');
        const shown = smoothstep(0, REDUCED.fade, time - reducedReadyAt);
        set(img!, 'opacity', num(shown));
        set(img!, 'transform', 'none');
        set(img!, 'filter', logoFilter(0, 1));
        applyGlow(0, ''); // reduced motion: no glow pulse
      } else if (logoState === 'failed') {
        charEls.forEach((el) => {
          set(el, 'visibility', 'visible');
          set(el, 'opacity', '1');
          set(el, 'transform', 'none');
          set(el, 'filter', 'none');
          set(el, 'mask-image', 'none');
          set(el, '-webkit-mask-image', 'none');
        });
      }
    }

    /** Geometry of the current layout in px (stage origin = centre of the root). */
    function geometry() {
      const F = L.font; // the typed line
      const adv = advEm * F;
      const Ff = L.fontFull; // full size: sweep pace and duration, logo reveal, fragments
      const advF = advEm * Ff;
      // The strike: from the end of the line (right of the cross), one continuous sweep to the
      // left side of the loader (and always past the logo's left ink edge and the word).
      const strikeFrom = (units / 2) * adv;
      const logoInkLeft = L.logoX - L.sx + ink.x0 * L.logoW;
      const sweepTo = Math.min(
        -L.sx + Math.max(12, SWEEP.edge * adv, 3 * L.cw),
        logoInkLeft - 0.35 * adv,
        strikeFrom - units * adv - 0.35 * adv,
      );
      // Duration follows the distance, so the speed is the same on every screen (bounded). It is
      // measured in the original type size's character widths, so the sweep keeps its on-screen
      // speed and timing now that the type is larger (the logo's emergence is timed from it).
      // The duration is that of the full-size line (TYPE_SCALE), so the strike, the sweep and the
      // logo's emergence (timed from it) keep their timing with the smaller type.
      const advPace = advF * (FONT_TO_LOGO_ORIGINAL / FONT_TO_LOGO);
      const strikeFromF = (units / 2) * advF;
      const sweepToF = Math.min(
        -L.sx + Math.max(12, SWEEP.edge * advF, 3 * Math.max(2, Math.round(Ff * 0.075))),
        logoInkLeft - 0.35 * advF,
        strikeFromF - units * advF - 0.35 * advF,
      );
      const sweepDur = sweepDuration((strikeFromF - sweepToF) / Math.max(1e-3, advPace));
      // Caret exit, keyed to the U (same sweep path and speed): it fades as the caret passes
      // over the U and is gone the instant the U is revealed, i.e. when the caret's centre (which
      // drives the wipe) is past the left edge of both the typed U and the logo's U. At least
      // SWEEP.fadeMin s, starting earlier if needed, but never before the caret has cut through
      // the cross (its leading edge has left it). Then every caret layer is removed.
      const exitSpan = strikeFrom - sweepTo;
      const at = (p: number) => sweepTimeAt(exitSpan > 0 ? p / exitSpan : 1, sweepDur);
      const centreAt = (x: number) => at(strikeFrom - x);
      const leadAt = (x: number) => at(strikeFrom - L.cw / 2 - x);
      const typedU = firstWord >= 0 ? cells[firstWord] : null;
      const logoU0 = logoInkLeft; // left ink edge of the logo = left edge of its U
      const logoU1 = L.logoX - L.sx + ink.u1 * L.logoW;
      const uLeft = Math.min(logoU0, typedU ? typedU.x * adv : logoU0);
      const uRight = Math.max(logoU1, typedU ? (typedU.x + typedU.w) * adv : logoU1);
      const crossCut = leadAt((units / 2 - trailing) * adv);
      const exitEnd = Math.min(TIMELINE.cursorGone, TIMELINE.sweepStart + sweepDur, centreAt(uLeft));
      const exitStart = Math.min(exitEnd, Math.max(crossCut, Math.min(centreAt(uRight), exitEnd - SWEEP.fadeMin)));
      // Room to the left of the cross for the scatter; shrink it on very narrow screens.
      const crossX = symbolIdx.length ? cellCenterEm(symbolIdx[0], advEm) * F : 0;
      const room = crossX + L.sx - 0.5 * Ff;
      const spread = Math.min(1, Math.max(0.3, room / (FRAGMENTS.reach * Ff)));
      // Text wipe and logo reveal edges (as in the previous version): the text is wiped just
      // behind the caret; the logo shows from a little LEFT of it over a long soft edge (full size).
      const feather = Math.max(4, 0.3 * adv);
      const lead = 1.1 * advF;
      const soft = Math.max(8, 1.4 * advF);
      return { F, Ff, adv, strikeFrom, sweepTo, sweepDur, exitStart, exitEnd, spread, feather, lead, soft };
    }

    /** Line offset: centred while typing; without a logo, UDX glides to the centre at the end. */
    function lineOffset(time: number, adv: number) {
      const m = trackedCells(events, time);
      const typing = ((units - m) / 2) * adv;
      const settle = logoState === 'failed' ? (trailing / 2) * adv * critStep(time - TIMELINE.recenter, 12) : 0;
      return typing + settle;
    }

    /** Caret position in line coordinates: typing (tracked), then the strike sweep to the left side. */
    function caretLocal(time: number, g: ReturnType<typeof geometry>) {
      if (time < TIMELINE.sweepStart) {
        return (trackedCells(events, time) - units / 2) * g.adv;
      }
      return g.strikeFrom + (g.sweepTo - g.strikeFrom) * sweepProgress(time, g.sweepDur);
    }

    /** Time the caret's leading (left) edge reaches line-coordinate x during the sweep. */
    function contactTime(x: number, g: ReturnType<typeof geometry>) {
      const lead = g.strikeFrom - L.cw / 2;
      const span = g.strikeFrom - g.sweepTo;
      return sweepTimeAt(span > 0 ? (lead - x) / span : 1, g.sweepDur);
    }

    type Geo = ReturnType<typeof geometry>;

    /**
     * A fragment's position (root px) for its pose offsets (fx, fy from fragmentPose): its spot
     * on the struck cross (cx, cy: the cross's ink centre; type size F) plus its flight, at the
     * full size Ff, so its path and size are those of the full-size type.
     */
    const fragXY = (cx: number, cy: number, fr: CrossFragment, fx: number, fy: number, g: Geo): [number, number] => [
      cx + fr.ox * g.F + (fx - fr.ox) * g.Ff,
      cy + fr.oy * g.F + (fy - fr.oy) * g.Ff,
    ];

    /** The logo's pose at time tt: the exact values the logo layer is rendered with. */
    function logoPoseAt(tt: number, g: Geo) {
      const P = Math.max(80, L.logoW * LOGO_EMERGE.perspective);
      // Time-scaled to the sweep (unchanged); the caret is removed well before it has fully emerged.
      const tscale = Math.max(1, (g.sweepDur + LOGO_EMERGE.afterCursor) / LOGO_EMERGE.full);
      const u = (tt - TIMELINE.sweepStart) / tscale;
      const e = critStep(u, LOGO_EMERGE.omega); // smooth, no overshoot
      const sl = critStep(u, LOGO_EMERGE.slideOmega); // monotonic: never back to the right
      return {
        P,
        e,
        z: -LOGO_EMERGE.depth * P * (1 - e),
        dx: LOGO_EMERGE.slide * L.logoW * (1 - sl),
        dy: LOGO_EMERGE.rise * L.logoH * (1 - e),
      };
    }

    /**
     * Where the logo is on screen at time t (root px) and how opaque it is, mirroring the logo
     * layer: perspective(P) translate3d(dx, dy, z) about its centre is, for this screen-parallel
     * plane, a uniform scale P / (P − z) plus a shift. `clipX`: left edge of the sweep's reveal.
     */
    function logoOnScreen(t: number, g: Geo) {
      const S0 = TIMELINE.sweepStart;
      if (logoState !== 'ready' || !(t >= S0)) return null;
      const W = L.logoW;
      const H = L.logoH;
      if (t >= TIMELINE.hold) return { op: 1, x: L.logoX, y: L.logoY, w: W, h: H, clipX: Number.NEGATIVE_INFINITY };
      const p = logoPoseAt(t, g);
      const k = p.P / Math.max(1e-3, p.P - p.z);
      const op = smoothstep(S0, S0 + TIMELINE.logoFadeIn, t) * (0.5 + 0.5 * clamp01(p.e));
      const a1 = L.sx + lineOffset(t, g.adv) + caretLocal(t, g) - g.lead;
      const masking = t < S0 + g.sweepDur && a1 > L.logoX - 0.1 * W;
      return {
        op,
        x: L.logoX + W / 2 + (-W / 2 + p.dx) * k,
        y: L.logoY + H / 2 + (-H / 2 + p.dy) * k,
        w: W * k,
        h: H * k,
        clipX: masking ? a1 - g.soft / 2 : Number.NEGATIVE_INFINITY,
      };
    }

    /** Logo ink coverage (0–1) at root point (X, Y) for a logo placement; 0 in negative space. */
    function inkAt(ls: NonNullable<ReturnType<typeof logoOnScreen>>, X: number, Y: number) {
      if (!sil || X < ls.clipX || !(ls.w > 0) || !(ls.h > 0)) return 0;
      const u = Math.floor(((X - ls.x) / ls.w) * sil.w);
      const v = Math.floor(((Y - ls.y) / ls.h) * sil.h);
      if (u < 0 || v < 0 || u >= sil.w || v >= sil.h) return 0;
      return sil.mask[v * sil.w + u] / 255;
    }

    /** True if root point (X, Y) is under the logo's bottom outline (between its leftmost and rightmost ink). */
    function belowLogo(ls: NonNullable<ReturnType<typeof logoOnScreen>>, X: number, Y: number) {
      if (!sil || !(ls.w > 0) || !(ls.h > 0)) return false;
      const u = Math.floor(((X - ls.x) / ls.w) * sil.w);
      if (u < sil.x0 || u > sil.x1) return false; // beside the logo
      return ((Y - ls.y) / ls.h) * sil.h >= sil.bottom[u] + 1;
    }

    /**
     * Clip region for fragments that sank behind the logo's lower part: the whole canvas minus
     * everything under the logo's bottom outline (at the logo's pose at time t), as an even-odd
     * Path2D. A fragment drawn through it is cut off exactly along the logo's bottom edge.
     */
    function bottomEdgeClip(t: number, g: Geo): Path2D | null {
      if (!sil || typeof Path2D !== 'function') return null;
      const ls = logoOnScreen(t, g);
      if (!ls || !(ls.w > 0) || !(ls.h > 0)) return null;
      const sx = ls.w / sil.w;
      const sy = ls.h / sil.h;
      const yEnd = Math.max(L.h, ls.y + ls.h) + 16;
      const p = new Path2D();
      p.rect(0, 0, L.w, L.h);
      p.moveTo(ls.x + sil.x0 * sx, yEnd);
      for (let u = sil.x0; u <= sil.x1; u += 1) {
        const y = ls.y + (sil.bottom[u] + 1) * sy;
        p.lineTo(ls.x + u * sx, y);
        p.lineTo(ls.x + (u + 1) * sx, y);
      }
      p.lineTo(ls.x + (sil.x1 + 1) * sx, yEnd);
      p.closePath();
      return p;
    }

    /**
     * To keep every fragment around the logo (FRAGMENTS.bound): within its outer silhouette or
     * the band just above it, either where the logo comes to rest (the burst rises over the place
     * the emerging logo grows into, as in the original) or where the logo is on screen at that
     * moment (a piece sinking behind the emerging logo), or, as it breaks off, within the struck
     * cross itself (`impact` em around its ink centre): per symbol and fragment, the moment
     * `out` its glyph would first leave all of these, and `from`, when its fade-out starts
     * (FRAGMENTS.bound.fade before, never before it breaks off), so it is gone before it crosses
     * the edge. Infinity: it stays inside until its own fade-out. A pure function of the layout
     * (cached), so scrubbing back shows the pieces again. Null without a readable logo.
     */
    let boundsCache: { key: string; from: Float64Array[]; out: Float64Array[] } | null = null;
    function fragmentBounds(g: Geo): { from: Float64Array[]; out: Float64Array[] } | null {
      if (shapeWork) advanceShape(() => true); // finish now if idle time didn't
      const sh = shape;
      if (!sh || logoState !== 'ready' || !(L.logoW > 0) || !(L.logoH > 0)) return null;
      const key = [L.w, L.h, L.font, L.fontFull, L.logoW, L.logoH, L.logoX, L.logoY, L.cw, advEm, g.spread, g.sweepDur, sh.w].join('|');
      if (boundsCache && boundsCache.key === key) return boundsCache;
      /** How deep (px) a point lies inside the silhouette for the logo box ls; 0 outside. */
      const depthIn = (ls: { x: number; y: number; w: number; h: number }, x: number, y: number) => {
        const toPx = ls.w / sh.w;
        const u = ((x - ls.x) / ls.w) * sh.w + sh.padX - 0.5;
        const v = ((y - ls.y) / ls.h) * sh.h + sh.padTop - 0.5;
        if (!(u >= 0 && v >= 0 && u < sh.gw - 1 && v < sh.gh - 1)) return 0;
        const x0 = Math.floor(u);
        const y0 = Math.floor(v);
        const ax = u - x0;
        const ay = v - y0;
        const j = y0 * sh.gw + x0;
        const d = sh.depth;
        const top = d[j] + (d[j + 1] - d[j]) * ax;
        const bot = d[j + sh.gw] + (d[j + sh.gw + 1] - d[j + sh.gw]) * ax;
        return (top + (bot - top) * ay) * toPx;
      };
      const B = FRAGMENTS.bound;
      const step = 1 / 240;
      const from: Float64Array[] = [];
      const out: Float64Array[] = [];
      // per symbol: the cross's ink centre and each piece's break-off time and size
      const spots = symbolIdx.map((i) => {
        const lx = cellCenterEm(i, advEm) * g.F + (CROSS_GLYPH.centerX - g.adv / g.F / 2) * g.F;
        return {
          ox: L.sx + lx,
          oy: L.sy + (CAP_HALF_EM - CROSS_GLYPH.centerY) * g.F,
          spawn: fragments.map((fr) => contactTime(lx + fr.ox * g.F, g)),
        };
      });
      spots.forEach(() => {
        out.push(new Float64Array(fragments.length).fill(Number.POSITIVE_INFINITY));
        from.push(new Float64Array(fragments.length).fill(Number.POSITIVE_INFINITY));
      });
      const reach = fragments.map((fr) => 0.42 * g.Ff * fragmentDrawScale(fr.scale) + B.margin); // the glyph lies within this
      const impact = B.impact * g.F;
      const t0 = Math.min(...spots.map((sp) => Math.min(...sp.spawn.filter(Number.isFinite))), Number.POSITIVE_INFINITY);
      const t1 = Math.max(...fragments.map((fr) => fr.fadeEnd));
      let open = spots.length * fragments.length;
      const rest = { x: L.logoX, y: L.logoY, w: L.logoW, h: L.logoH }; // the logo at rest
      for (let t = t0; Number.isFinite(t) && t <= t1 && open > 0; t += step) {
        const ls = logoOnScreen(t, g); // the logo now (one placement per step, shared)
        spots.forEach((sp, si) => {
          fragments.forEach((fr, k) => {
            const sp0 = sp.spawn[k];
            if (!Number.isFinite(sp0) || t < sp0 || t > fr.fadeEnd || Number.isFinite(out[si][k])) return;
            const [fx, fy] = fragmentPose(fr, t - sp0, g.spread);
            const [cx, cy] = fragXY(sp.ox, sp.oy, fr, fx, fy, g);
            if (Math.hypot(cx - sp.ox, cy - sp.oy) <= impact) return; // still at the struck cross
            const deep =
              depthIn(rest, cx, cy) >= reach[k] || (!!ls && ls.w > 0 && ls.h > 0 && depthIn(ls, cx, cy) >= reach[k]);
            if (!deep) {
              out[si][k] = t;
              from[si][k] = Math.max(sp0, t - B.fade);
              open -= 1;
            }
          });
        });
      }
      boundsCache = { key, from, out };
      return boundsCache;
    }

    /**
     * For every fragment that sinks behind the logo's solid lower part: the moment just before
     * it would start to come out under the logo's bottom edge. From then on it is drawn clipped
     * at that edge (bottomEdgeClip), so it is cut off spatially as it keeps falling, never by
     * fading; it keeps moving and nothing is reset. Everything else is plain layering: black
     * ink hides fragments pixel by pixel and negative spaces (the D's counter, the slits) show
     * them. A pure function of the layout (cached), so scrubbing back shows them again.
     * Infinity = never clipped.
     */
    function fragmentHideTimes(g: Geo): Float64Array[] {
      const job = hideJobFor(g);
      if (!job.done) advanceHideJob(job, g, () => true); // finish now if idle time didn't
      return job.at;
    }

    /** The (resumable) hide-time computation for the current layout; a new one after a change. */
    function hideJobFor(g: Geo): HideJob {
      const key = [L.w, L.h, L.font, L.fontFull, L.logoW, L.logoX, L.logoY, L.cw, advEm, logoState, sil ? sil.w : 0].join('|');
      if (hideJob && hideJob.key === key) return hideJob;
      const { F, adv } = g;
      const n = fragments.length;
      // per symbol: cross ink centre and each fragment's break-off time
      const spots = symbolIdx.map((i) => {
        const lx = cellCenterEm(i, advEm) * F + (CROSS_GLYPH.centerX - adv / F / 2) * F;
        return {
          ox: L.sx + lx,
          oy: L.sy + (CAP_HALF_EM - CROSS_GLYPH.centerY) * F,
          spawn: fragments.map((fr) => contactTime(lx + fr.ox * F, g)),
        };
      });
      hideJob = {
        key,
        at: symbolIdx.map(() => new Float64Array(n).fill(Number.POSITIVE_INFINITY)),
        // previous step: share of the fragment behind the ink, and whether any of it was under
        // the logo's bottom outline
        prevCovered: symbolIdx.map(() => new Float64Array(n)),
        prevBelow: symbolIdx.map(() => new Uint8Array(n)),
        spots,
        t: spots.length ? Math.min(...spots.map((sp) => Math.min(...sp.spawn))) : 0,
        open: symbolIdx.length * n,
        done: !sil || symbolIdx.length === 0,
      };
      return hideJob;
    }

    /** Advances the job one time step at a time while `more()` allows; marks it done at the end. */
    function advanceHideJob(job: HideJob, g: Geo, more: () => boolean) {
      const { spread } = g;
      const step = 1 / 120;
      const { at, prevCovered, prevBelow, spots } = job;
      // one logo placement per time step, shared by every fragment
      for (; !job.done; job.t += step) {
        if (job.t > TIMELINE.fragmentsOut[1] || job.open <= 0) {
          job.done = true;
          break;
        }
        if (!more()) return;
        const t = job.t;
        const ls = logoOnScreen(t, g);
        if (!ls) continue;
        spots.forEach((sp, si) => {
          fragments.forEach((fr, k) => {
            if (Number.isFinite(at[si][k]) || t < sp.spawn[k] || t > fr.fadeEnd) return;
            const [fx, fy, rot] = fragmentPose(fr, t - sp.spawn[k], spread);
            const size = g.Ff * fragmentDrawScale(fr.scale);
            const [cx, cy] = fragXY(sp.ox, sp.oy, fr, fx, fy, g);
            const r = 0.38 * size; // the whole glyph lies within this radius
            let covered = 0; // share of the glyph behind the logo's ink (ink coverage, not opacity)
            let anyBelow = false;
            if (cx + r < ls.x || cx - r > ls.x + ls.w || cy + r < ls.y || cy - r > ls.y + ls.h) {
              // clear of the logo box: entirely under it, or beside / above it
              anyBelow = cy - r > ls.y + ls.h && belowLogo(ls, cx, cy);
            } else {
              const c = Math.cos(rot);
              const sn = Math.sin(rot);
              for (const [ux, uy] of CROSS_SAMPLES) {
                covered += inkAt(ls, cx + (ux * c - uy * sn) * size, cy + (ux * sn + uy * c) * size);
              }
              covered /= CROSS_SAMPLES.length;
              for (const [ux, uy] of CROSS_CORNERS) {
                if (belowLogo(ls, cx + (ux * c - uy * sn) * size, cy + (ux * sn + uy * c) * size)) {
                  anyBelow = true;
                  break;
                }
              }
            }
            // It starts to cross the logo's bottom edge coming from behind the logo: the logo is
            // solid (it has emerged, so its edge isn't sweeping over fragments any more), the
            // fragment is falling, it was partly behind the ink a step ago and nothing of it was
            // under the edge yet. From that step on it is clipped at the edge, so it slides behind
            // it and never comes out underneath; nothing of it was under the edge then, so
            // nothing visible changes.
            const falling = fragmentPose(fr, t - sp.spawn[k] + step, spread)[1] > fy;
            if (anyBelow && !prevBelow[si][k] && prevCovered[si][k] >= 0.15 && ls.op >= 0.9 && falling) {
              at[si][k] = t - step;
              job.open -= 1;
              return;
            }
            prevBelow[si][k] = anyBelow ? 1 : 0;
            prevCovered[si][k] = covered;
          });
        });
      }
    }

    /** Renders a frame and reports the time to onTimeUpdate. */
    function draw(time: number) {
      render(time);
      try {
        live.current.onTimeUpdate?.(time / TIMELINE.speed, playing); // real seconds
      } catch {
        /* consumer callback errors must not break the loader */
      }
    }

    function render(time: number) {
      // Reduced motion shortens autoplay to a fade; scrubbing is user-driven, so it shows every frame.
      if (reduced && !scrubbed) return renderReduced(time);
      const g = geometry();
      const { F, adv } = g;
      const logoOk = logoState === 'ready';
      const S0 = TIMELINE.sweepStart;
      const struck = symbolIdx.length > 0 && time >= S0;

      const lineX = lineOffset(time, adv);
      set(line!, 'transform', `translate3d(${px(lineX)},0,0)`);
      set(chars!, 'transform', 'none');
      set(chars!, 'color', live.current.textColor);

      const screenX = (tt: number) => lineOffset(tt, adv) + caretLocal(tt, g);
      const cx = screenX(time);
      // With the logo, the sweeping caret wipes the typed word away (visible only to its
      // left, soft edge) while the logo is revealed in its wake. Without a logo it stays.
      const wiping = logoOk && time >= S0;
      charEls.forEach((el, i) => {
        const tau = time - cells[i].at;
        // the struck cross is handed to the canvas, which slices it at the caret
        const handed = struck && symbolIdx.includes(i);
        const xc = cx - (lineX + cells[i].x * adv); // caret position inside this letter's box
        if (tau < 0 || !fontDecided || handed || (wiping && xc <= 0)) {
          set(el, 'visibility', 'hidden');
          return;
        }
        const q = springStep(tau, LETTER_SPRING.zeta, LETTER_SPRING.omega);
        const y = 0.22 * F * (1 - q);
        const s = 0.88 + 0.12 * q;
        const blur = 2.4 * (1 - easeOutCubic(tau / 0.08));
        const mask =
          wiping && xc - g.feather < cells[i].w * adv
            ? `linear-gradient(to right, #000 ${px(xc - g.feather)}, transparent ${px(xc)})`
            : 'none';
        set(el, 'visibility', 'visible');
        set(el, 'opacity', num(easeOutCubic(tau / 0.09)));
        set(el, 'transform', `translate3d(0,${px(y)},0) scale(${num(s)})`);
        set(el, 'filter', blur > 0.05 ? `blur(${px(blur)})` : 'none');
        set(el, 'mask-image', mask);
        set(el, '-webkit-mask-image', mask);
      });

      // Cursor: fade in, blink, types, then strikes RIGHT→LEFT through the cross and completes
      // its sweep to the left side at a steady speed (it never slows or parks while visible).
      // Once it has uncovered the logo it exits: the trail fades first, then the caret, to
      // exactly 0 as it arrives; from then on every caret layer is hidden. It never moves right.
      let base = smoothstep(TIMELINE.cursorIn[0], TIMELINE.cursorIn[1], time);
      const [b0, b1] = TIMELINE.cursorBlink;
      if (time > b0 && time < b1) base *= 1 - Math.pow(Math.sin((Math.PI * (time - b0)) / (b1 - b0)), 2);
      const exit = time >= S0 ? cursorExit(time, g.exitStart, g.exitEnd) : { caret: 1, trail: 1 };
      // Retired: after its exit (or the hard cap) every caret layer is removed, and once retired
      // it stays removed for every later time, even if a resize moves the exit afterwards.
      if (time >= g.exitEnd || time >= TIMELINE.cursorGone) cursorRetiredAt = Math.min(cursorRetiredAt, time);
      const gone = time >= cursorRetiredAt;
      const cop = gone ? 0 : base * exit.caret;
      const op = (o: number) => (gone || o < 1 / 255 ? '0' : num(o)); // exactly 0, never a faint remnant
      showCursorLayers(!gone);
      // Snap the caret's left edge to the device-pixel grid so its rendered width never shimmers.
      const edge = L.sx - L.cw / 2;
      const caret = (x: number) => px(Math.round((edge + x) * L.snap) / L.snap - edge - lineX);
      set(cursor!, 'opacity', op(cop));
      set(cursor!, 'transform', `translate3d(${caret(cx)},0,0)`);
      // Motion trail: a smooth horizontal smear plus a faint double image, never a stretch.
      const v = Math.abs(cx - screenX(time - 0.016)) / 0.016;
      const k = Math.min(0.45, v / Math.max(1, adv * 12)) * base * exit.trail;
      ghosts.forEach((el, n) => {
        const lag = (n + 1) * 0.02;
        set(el, 'opacity', op(k * (n === 0 ? 0.55 : 0.25)));
        set(el, 'transform', `translate3d(${caret(screenX(time - lag))},0,0)`);
      });
      if (smearEl) {
        const back = screenX(time - 0.05);
        const width = Math.abs(cx - back);
        const leftward = back > cx;
        set(smearEl, 'opacity', width > 1 ? op(Math.min(0.3, k * 0.9)) : '0');
        set(smearEl, 'width', px(width));
        set(smearEl, 'transform', `translate3d(${px(Math.min(cx, back) - lineX)},0,0)`);
        set(smearEl, 'background-image', `linear-gradient(to ${leftward ? 'left' : 'right'}, transparent, var(--udx-accent))`);
      }

      // Logo: starts with the strike, deep inside the screen behind the word (small, grey,
      // soft, offset to the RIGHT and a little low). It is revealed RIGHT→LEFT in the caret's
      // wake (same as the previous version) and slides LEFT into place, with the caret, while
      // pushing out toward the viewer through a perspective camera; depth layers behind its
      // face form an extruded edge and collapse as it arrives. From TIMELINE.hold on it is
      // untouched: no transform, mask, filter or layers.
      if (logoOk && time >= S0) {
        const rest = time >= TIMELINE.hold;
        const fade = rest ? 1 : smoothstep(S0, S0 + TIMELINE.logoFadeIn, time);
        const pose = (tt: number) => logoPoseAt(tt, g); // shared with the fragment mask
        const now = pose(time);
        const P = now.P;
        const ec = rest ? 1 : clamp01(now.e);
        // Reveal: visible from a little LEFT of the caret rightward, over a soft edge. Dropped
        // once the caret is past the logo (or the sweep has ended): nothing left to hide.
        const xr = L.sx + cx; // caret, root coordinates (the logo layer covers the root)
        const a1 = xr - g.lead;
        const a0 = a1 - g.soft;
        const masking = !rest && time < S0 + g.sweepDur && a1 > L.logoX - 0.1 * L.logoW;
        const mask = masking ? `linear-gradient(to right, transparent ${px(a0)}, #000 ${px(a1)})` : 'none';
        set(logo!, 'visibility', 'visible');
        set(logo!, 'mask-image', mask);
        set(logo!, '-webkit-mask-image', mask);
        const flat = rest || (Math.abs(now.z) < 0.05 && Math.abs(now.dx) < 0.01 && Math.abs(now.dy) < 0.01);
        const blur = rest ? 0 : 2.2 * (1 - ec);
        set(img!, 'opacity', rest ? '1' : num(fade * (0.5 + 0.5 * ec)));
        set(img!, 'filter', logoFilter(blur, ec));
        const pose3d = flat ? '' : `perspective(${px(P)}) translate3d(${px(now.dx)},${px(now.dy)},${px(now.z)})`;
        set(img!, 'transform', pose3d || 'none');
        // the one-time glow, on the logo's own transform. Built in idle time while typing; on a
        // very slow device that hasn't finished it yet, it continues in small slices per frame (no
        // frame is held up) and eases in when ready instead of popping in.
        if (glowWork && time >= GLOW.start - 0.2) {
          const until = performance.now() + 6;
          advanceGlow(() => performance.now() < until, time);
        }
        if (time < GLOW.start) glowLateAt = Number.NEGATIVE_INFINITY;
        const late = glowLateAt > GLOW.start ? smoothstep(glowLateAt, glowLateAt + 0.15, time) : 1;
        applyGlow(glowStrength(time) * late, pose3d);
        const step = LOGO_DEPTH.step * P * (1 - ec);
        const layerK = 1 - smoothstep(0.55, 0.98, ec);
        logoDepth.forEach((el, n) => {
          const kk = n + 1;
          const op = rest ? 0 : fade * LOGO_DEPTH.opacity * (1 - kk / (logoDepth.length + 1)) * layerK;
          if (op <= 0.004) {
            set(el, 'opacity', '0');
            set(el, 'transform', 'none');
            return;
          }
          const lagged = pose(time - kk * LOGO_DEPTH.lag);
          set(el, 'opacity', num(op));
          set(
            el,
            'transform',
            `perspective(${px(P)}) translate3d(${px(lagged.dx)},${px(lagged.dy)},${px(lagged.z - kk * step)})`,
          );
        });
      } else {
        set(logo!, 'visibility', 'hidden');
        set(logo!, 'mask-image', 'none');
        set(logo!, '-webkit-mask-image', 'none');
        set(img!, 'opacity', '0');
        logoDepth.forEach((gh) => set(gh, 'opacity', '0'));
        applyGlow(0, '');
      }

      drawCanvas(time);
    }

    /**
     * Draws one copy of the ✝ glyph (same geometry as the font's) centred at (x, y). Strokes
     * thinner than `minStroke` px are thickened about their own centre lines (fragments only).
     */
    function drawCross(c: CanvasRenderingContext2D, x: number, y: number, size: number, rot: number, minStroke = 0) {
      c.save();
      c.translate(x, y);
      if (rot) c.rotate(rot);
      const { stem, bar } = CROSS_GLYPH;
      const sw = Math.max(stem.w * size, minStroke);
      const bh = Math.max(bar.h * size, minStroke);
      c.fillRect(stem.x * size - (sw - stem.w * size) / 2, stem.y * size, sw, stem.h * size);
      c.fillRect(bar.x * size, bar.y * size - (bh - bar.h * size) / 2, bar.w * size, bh);
      c.restore();
    }

    /**
     * Stages 2–5 canvas (beneath the logo layer, so the logo's ink occludes it): the struck cross, sliced at the caret's
     * leading edge, and the tiny cross fragments that break off the moment the caret
     * reaches them, scatter, drift and fade.
     */
    function drawCanvas(time: number) {
      if (!ctx) return;
      const S0 = TIMELINE.sweepStart;
      const active = symbolIdx.length > 0 && fontDecided && time >= S0 && time <= TIMELINE.fragmentsOut[1] + 0.05;
      if (!active || (reduced && !scrubbed)) {
        if (canvasDirty) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas!.width, canvas!.height);
          canvasDirty = false;
        }
        return;
      }
      canvasDirty = true;
      const g = geometry();
      const { F, adv, spread } = g;
      ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
      ctx.clearRect(0, 0, L.w, L.h);
      const accent = live.current.accentColor;
      const dark = live.current.inkColor;
      // Fragments that sank behind the logo's lower part are clipped at its bottom edge
      // (occlusion itself is the layering: the logo is the foreground layer).
      const hideAt = sil && logoState === 'ready' ? fragmentHideTimes(g) : null;
      // ...and fade out before they would leave the logo's outer silhouette
      const bound = fragmentBounds(g);
      let edgeClip: Path2D | null | undefined; // built once per frame, only if needed
      const clipAtEdge = () => (edgeClip === undefined ? (edgeClip = bottomEdgeClip(time, g)) : edgeClip);
      // The line has not moved since typing settled (any re-centring only happens later).
      const lead = caretLocal(time, g) - L.cw / 2; // caret's leading edge, line coords
      symbolIdx.forEach((i, si) => {
        // ink centre of the struck glyph, line coords and root px
        const lx = cellCenterEm(i, advEm) * F + (CROSS_GLYPH.centerX - adv / F / 2) * F;
        const ox = L.sx + lx;
        const oy = L.sy + (CAP_HALF_EM - CROSS_GLYPH.centerY) * F;
        // The cross itself: only the part the caret hasn't reached yet remains.
        if (time < S0 + g.sweepDur) {
          const cutX = L.sx + lead;
          if (cutX > ox - 0.25 * F) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, Math.max(0, cutX), L.h);
            ctx.clip();
            ctx.globalAlpha = 1;
            ctx.fillStyle = accent;
            drawCross(ctx, ox, oy, F, 0);
            ctx.restore();
          }
        }
        // Fragments: each breaks off when the caret's edge reaches its spot on the cross.
        fragments.forEach((fr, k) => {
          const spawn = contactTime(lx + fr.ox * F, g);
          if (time < spawn) return;
          const tau = time - spawn;
          const leave = bound && Number.isFinite(bound.out[si][k]) ? 1 - smoothstep(bound.from[si][k], bound.out[si][k], time) : 1;
          const alpha = smoothstep(0, 0.02, tau) * (1 - smoothstep(fr.fadeStart, fr.fadeEnd, time)) * leave;
          if (alpha <= 0.01) return;
          ctx.fillStyle = fr.accent ? accent : dark;
          const size = g.Ff * fragmentDrawScale(fr.scale);
          const [nx, ny] = fragmentPose(fr, tau, spread);
          const [px0, py0] = fragmentPose(fr, tau - FRAGMENTS.shutter, spread);
          const smear = Math.min(1, (Math.hypot(nx - px0, ny - py0) * g.Ff) / (size * 0.8));
          const steps = 5;
          // sank behind the logo's lower part: cut off spatially at its bottom edge from then on
          const clip = hideAt && time >= hideAt[si][k] ? clipAtEdge() : null;
          if (clip) {
            ctx.save();
            ctx.clip(clip, 'evenodd');
          }
          for (let e = steps; e >= 0; e -= 1) {
            const te = Math.max(0, tau - (e / steps) * FRAGMENTS.shutter);
            const [fx, fy, rot] = fragmentPose(fr, te, spread);
            const a = e === 0 ? alpha : alpha * smear * 0.22 * (1 - e / (steps + 1));
            if (a <= 0.01) continue;
            ctx.globalAlpha = a;
            const [dx, dy] = fragXY(ox, oy, fr, fx, fy, g);
            drawCross(ctx, dx, dy, size, rot, FRAGMENTS.visibility.minStroke);
          }
          if (clip) ctx.restore();
        });
      });
      // Two small crosses dropping into the U's inner channel (supplied UDX logo only). Placed
      // with the logo's exact on-screen pose and sized to its channel; beneath the logo like the
      // fragments, they are seen through the channel.
      if (ink === UDX_LOGO_INK && logoState === 'ready') {
        const ls = logoOnScreen(time, g);
        if (ls && ls.w > 0 && ls.h > 0) {
          const ch = UDX_LOGO_INK.channel;
          const mid = ls.x + ((ch.x0 + ch.x1) / 2) * ls.w;
          const half = ((ch.x1 - ch.x0) / 2) * ls.w;
          ctx.fillStyle = accent;
          U_DROPS.forEach((d) => {
            const p = uDropAt(d, time);
            if (!p || p.alpha <= 0.01) return;
            ctx.globalAlpha = p.alpha;
            drawCross(ctx, mid + p.u * half, ls.y + p.v * ls.h, d.size * ls.w, uprightAngle(p.rot));
          });
        }
      }
      ctx.globalAlpha = 1;
    }

    function finish() {
      if (completed) return;
      completed = true;
      showCursorLayers(false);
      if (logoState === 'ready') {
        hideAll(charEls);
        logoDepth.forEach((gh) => {
          set(gh, 'opacity', '0');
          set(gh, 'transform', 'none');
        });
        set(logo!, 'visibility', 'visible');
        set(logo!, 'mask-image', 'none');
        set(logo!, '-webkit-mask-image', 'none');
        set(img!, 'opacity', '1');
        set(img!, 'transform', 'none');
        set(img!, 'filter', logoFilter(0, 1));
        applyGlow(0, ''); // the one-time glow is over: plain black logo
      }
      drawCanvas(Number.POSITIVE_INFINITY);
      root!.setAttribute('aria-busy', 'false');
      try {
        live.current.onComplete?.();
      } catch {
        /* consumer callback errors must not break the loader */
      }
    }

    // ---- loop ------------------------------------------------------------------------------
    const tick = (now: number) => {
      if (disposed || !playing) return;
      if (lastNow < 0) lastNow = now;
      // Large gaps (background tab) are treated as one frame so nothing is skipped.
      // t is design time: it runs TIMELINE.speed times faster than the clock (same motion, quicker)
      t += Math.min(0.1, Math.max(0, (now - lastNow) / 1000) * TIMELINE.speed);
      lastNow = now;

      if (!fontDecided && t >= TIMELINE.firstKey - 0.07) decideFont(false);
      if (logoState === 'pending') {
        const deadline = reduced ? 1.5 : TIMELINE.logoDeadline;
        if (t >= deadline) failLogo();
      }

      const end = reduced && !scrubbed
        ? logoState === 'pending'
          ? Infinity
          : Math.max(REDUCED.end, reducedReadyAt >= 0 ? reducedReadyAt + REDUCED.fade + 0.4 : 0)
        : TIMELINE.end;
      if (t >= end) {
        if (!(reduced && !scrubbed)) t = Math.min(t, TIMELINE.end);
        playing = false;
        draw(t);
        finish();
        return;
      }
      draw(t);
      raf = requestAnimationFrame(tick);
    };

    // ---- controls (seek / play / pause) ------------------------------------------------------
    const requestDraw = () => {
      if (pendingDraw || disposed) return;
      pendingDraw = requestAnimationFrame(() => {
        pendingDraw = 0;
        if (!disposed) draw(t);
      });
    };
    ctrl.current = {
      seek(seconds: number) {
        if (disposed || !Number.isFinite(seconds)) return;
        scrubbed = true;
        playing = false;
        cancelAnimationFrame(raf);
        t = Math.min(TIMELINE.end, Math.max(0, seconds * TIMELINE.speed)); // real → design time
        requestDraw();
      },
      play() {
        if (disposed || playing) return;
        if (t >= TIMELINE.end - 1e-3) {
          t = 0;
          completed = false;
          root!.setAttribute('aria-busy', 'true');
        }
        playing = true;
        lastNow = -1;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(tick);
      },
      pause() {
        if (disposed || !playing) return;
        playing = false;
        cancelAnimationFrame(raf);
        requestDraw();
      },
      getTime: () => t / TIMELINE.speed,
      isPlaying: () => playing,
    };

    const onMotionPref = () => {
      if (mq?.matches && !reduced) {
        reduced = true;
        charEls.forEach((el) => set(el, 'filter', 'none'));
        set(chars!, 'transform', 'none');
        drawCanvas(Number.POSITIVE_INFINITY);
      }
    };
    mq?.addEventListener?.('change', onMotionPref);

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => applyLayout()) : null;
    ro?.observe(root);
    if (!ro) window.addEventListener('resize', applyLayout);

    // Film grain: a small seeded noise tile, generated once. Missing canvas = no grain.
    const grain = grainRef.current;
    if (grain) {
      try {
        const size = 160;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const g2 = c.getContext('2d');
        if (g2) {
          const data = g2.createImageData(size, size);
          const rand = mulberry32(0x9a1e);
          for (let i = 0; i < data.data.length; i += 4) {
            const r = rand();
            const dark = r < 0.5;
            const v = dark ? 40 : 255;
            data.data[i] = v;
            data.data[i + 1] = dark ? v - 6 : v;
            data.data[i + 2] = dark ? v - 14 : v - 8;
            data.data[i + 3] = Math.round(Math.pow(rand(), 2.2) * (dark ? 46 : 30));
          }
          g2.putImageData(data, 0, 0);
          grain.style.backgroundImage = `url(${c.toDataURL('image/png')})`;
        }
      } catch {
        /* grain is decorative */
      }
    }

    set(root, '--udx-font-family', PRIMARY_STACK);
    root.setAttribute('aria-busy', 'true');
    applyLayout();
    loadUdxLoaderFont().then((ok) => decideFont(ok));
    if (playing) raf = requestAnimationFrame(tick);
    else requestDraw();

    return () => {
      disposed = true;
      ctrl.current = null;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(pendingDraw);
      cancelGlowIdle();
      glowWork = null;
      cancelShapeIdle();
      shapeWork = null;
      if (hideIdle) {
        if (hideIdle.idle) window.cancelIdleCallback?.(hideIdle.id);
        else window.clearTimeout(hideIdle.id);
        hideIdle = null;
      }
      ro?.disconnect();
      if (!ro) window.removeEventListener('resize', applyLayout);
      mq?.removeEventListener?.('change', onMotionPref);
      pre.onload = pre.onerror = null;
    };
  }, [cells, logoUrl]);

  const rootStyle = {
    '--udx-accent': accentColor,
    '--udx-text': textColor,
    '--udx-bg': background,
    '--udx-ink': inkColor,
    '--udx-font-family': PRIMARY_STACK,
    ...style,
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={[styles.root, fullscreen ? styles.fullscreen : '', className ?? ''].filter(Boolean).join(' ')}
      style={rootStyle}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className={styles.srOnly}>{label}</span>
      {texture && <div className={styles.vignette} aria-hidden="true" />}
      {texture && <div ref={grainRef} className={styles.grain} aria-hidden="true" />}
      {/* Behind the logo: the logo layer is multiplied onto everything beneath it, so its
          black ink occludes the cross fragments (they pass behind the D and X), while its
          pure-white background lets them through untouched outside the silhouette. */}
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      <div ref={logoRef} className={styles.logo} aria-hidden="true">
        {/* The one-time glow: bloom and halo beneath the logo (outside its outline), rim on its
            black edges (screen). Filled once from the logo's pixels; only opacity and
            transform change per frame. */}
        <canvas className={styles.glow} data-glow="bloom" aria-hidden="true" />
        <canvas className={styles.glow} data-glow="halo" aria-hidden="true" />
        {Array.from({ length: LOGO_DEPTH.layers }, (_, k) => (
          <img key={k} className={styles.logoDepth} data-depth="" alt="" width={LOGO_NATURAL.w} height={LOGO_NATURAL.h} draggable={false} />
        ))}
        <img ref={imgRef} className={styles.logoImg} alt={logoAlt} width={LOGO_NATURAL.w} height={LOGO_NATURAL.h} draggable={false} />
        <canvas className={`${styles.glow} ${styles.glowRim}`} data-glow="rim" aria-hidden="true" />
      </div>
      <div ref={stageRef} className={styles.stage} aria-hidden="true">
        <div ref={lineRef} className={styles.line}>
          <div ref={charsRef} className={styles.chars}>
            {cells.map((c, i) => (
              <span key={i} className={c.accent ? `${styles.char} ${styles.accent}` : styles.char}>
                {c.ch}
              </span>
            ))}
          </div>
          <span ref={trailRef} className={styles.trail}>
            <span className={styles.smear} data-smear="" />
            <span className={styles.cursor} />
            <span className={styles.cursor} />
          </span>
          <span ref={cursorRef} className={styles.cursor} />
        </div>
      </div>
    </div>
  );
}

/** Length of the animation in seconds (onComplete fires here). */
export const UDX_LOADER_DURATION = TIMELINE.end / TIMELINE.speed;

/**
 * Premium minimalist loader: types "UDX✝"; the caret strikes RIGHT→LEFT through the cross,
 * shattering it into tiny cross fragments, and keeps sweeping to the left side while the UDX
 * logo is revealed right→left in its wake and slides in from the right, out of the screen,
 * and settles. < 4 s.
 */
export const UdxLoader = memo(forwardRef<UdxLoaderHandle, UdxLoaderProps>(UdxLoaderImpl));
export default UdxLoader;
