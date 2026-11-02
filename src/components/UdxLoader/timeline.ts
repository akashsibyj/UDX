/**
 * Deterministic timeline for <UdxLoader /> ("reprise"). Everything is a pure function of
 * elapsed seconds, so every mount plays the exact same animation and any frame can be
 * rendered on its own (no integration, no accumulated drift).
 *
 * Sequence: type "UDX✝" with the caret right after the cross → the caret strikes RIGHT→LEFT
 * and does not stop: it passes through the cross (each piece breaks off the moment the caret
 * reaches it, shattering it into tiny cross fragments), then carries on over UDX, wiping it
 * away, toward the left side of the loader. The logo is revealed right→left in its wake,
 * sliding in from the right while it pushes out of the screen. The caret fades out (its trail
 * first) as it passes the U and is gone the instant the U is revealed; every caret layer is
 * then removed for good, long before the logo has fully emerged → hold.
 */

/** All times in seconds from the start of the animation. */
export const TIMELINE = {
  /** Stage 1 (0.00–1.26): cursor fades in at the centre, one soft blink, then typing. */
  cursorIn: [0.04, 0.14] as const,
  cursorBlink: [0.16, 0.32] as const,
  firstKey: 0.38,
  lastKeyMax: 1.06,
  keyInterval: 0.22,
  /**
   * Stage 2 (from 1.26): the strike. One continuous RIGHT→LEFT sweep (see SWEEP) from after
   * the cross to the left side of the loader. The cross shatters on contact; the logo is
   * revealed in the caret's wake and slides in from the right on the same beat.
   */
  sweepStart: 1.26,
  /** Hard cap: from here every caret layer is removed no matter what (e.g. a resize mid-exit). */
  cursorGone: 2.0,
  /** The logo fades in over this long as the sweep begins (it is also masked by the sweep). */
  logoFadeIn: 0.18,
  /** Without a logo: after the sweep, UDX glides to the centre to end cleanly. */
  recenter: 2.85,
  /**
   * Stage 4: remaining fragments fade out (each over its own window inside this one), all
   * gone before the logo's one-time glow begins (GLOW.start).
   */
  fragmentsOut: [2.3, 2.82] as const,
  /** The logo must be decoded by this time (just before the strike), or the loader ends on the typed UDX. */
  logoDeadline: 1.2,
  /** From here the logo is at rest: flat, sharp, no transform/filter/mask/depth layers. */
  hold: 3.3,
  /** 3.96 so onComplete lands inside 4 s even with first-frame latency. */
  end: 3.96,
  /**
   * Playback rate: the whole timeline (every time above and everything built on it) plays
   * this much faster than designed, so every motion keeps exactly its curve, easing and
   * order, only quicker. Real seconds = design seconds ÷ speed (3.96 → about 3.44 s). The
   * public API (duration, seek, getTime, onTimeUpdate) is in real seconds.
   */
  speed: 1.15,
} as const;

/**
 * The strike sweep: a short smooth start, then constant speed (character advances per second)
 * to the left side of the loader, `edge` advances (≥ 12 px) inside the edge. It never slows
 * down while visible, so the caret is never left parked. The duration follows the distance
 * within [minDuration, maxDuration], so it always ends by 2.06 s on any screen.
 * Exit (see cursorExit), during the logo's right→left sweep-in and keyed to its U: it starts
 * as the caret begins passing over the U (the logo's U or the typed U, whichever comes first)
 * and ends the instant the U is revealed (the caret is past the left edge of both), so the
 * caret travels no further left than the U. It lasts at least `fadeMin` s (starting earlier
 * if the U is crossed faster, but never before the caret has cut through the cross). The
 * trail (ghost copies and smear) fades first; the caret fades to exactly 0. Then every caret
 * layer is removed (opacity 0, hidden, display none). The sweep path and speed are unchanged.
 */
export const SWEEP = {
  speed: 30,
  minDuration: 0.55,
  maxDuration: 0.8,
  rampIn: 0.05,
  fadeMin: 0.1,
  trailFade: 0.12,
  edge: 0.6,
} as const;

/** Reduced-motion variant: a single opacity fade. */
export const REDUCED = { fade: 0.3, end: 1.0 } as const;

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOutCubic = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Critically damped spring step response (0 → 1, no overshoot). */
export function critStep(tau: number, omega: number): number {
  if (tau <= 0) return 0;
  return 1 - (1 + omega * tau) * Math.exp(-omega * tau);
}

/**
 * Under-damped spring step response (0 → 1 with overshoot and settle).
 * zeta = damping ratio, omega = natural frequency (rad/s) ~ sqrt(stiffness/mass).
 */
export function springStep(tau: number, zeta: number, omega: number): number {
  if (tau <= 0) return 0;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * omega * tau);
  return 1 - decay * (Math.cos(wd * tau) + ((zeta * omega) / wd) * Math.sin(wd * tau));
}

/** Letter entrance: ~12% overshoot, settles in ~0.25 s (damping 0.55, ω 28). */
export const LETTER_SPRING = { zeta: 0.55, omega: 28 } as const;
/** Cursor glide + line re-centring share this ω. */
export const TRACK_OMEGA = 32;

/**
 * Logo emergence (starts with the strike): deep inside the screen (z = -depth × perspective
 * ≈ 53 % size) and offset `slide` × its width to the RIGHT (slightly low), it slides LEFT into
 * place, in the cursor's direction, while pushing out toward the viewer. Both the push
 * (ω `omega`) and the slide (ω `slideOmega`) are critically damped: a smooth start, a steady
 * ease-out and no overshoot, so it never grows past its size or moves back to the right.
 * Perspective is a multiple of the logo width, so the depth reads the same at every screen
 * size. `full`: the logo has all but emerged `full` s after the strike; the curves are
 * time-scaled by (sweepDuration + afterCursor) / full (fully revealed at about 2.0–2.3 s,
 * design time). The caret is removed during the sweep-in, well before that, on every screen.
 */
export const LOGO_EMERGE = {
  depth: 0.9,
  slide: 0.27,
  slideOmega: 8,
  rise: 0.08,
  perspective: 3.2,
  omega: 9,
  full: 0.55,
  afterCursor: 0.12,
} as const;
/**
 * Layered depth: copies of the logo stacked behind its face (each `step` × perspective
 * deeper, lagging slightly), forming a grey extruded edge that collapses as it arrives.
 */
export const LOGO_DEPTH = { layers: 6, step: 0.035, opacity: 0.28, lag: 0.012 } as const;

/**
 * The ✝ glyph exactly as drawn in the embedded font (font units / 1000 = em):
 * 90u stem, 80u crossbar, ink centred at x 0.300 em, y 0.370 em above the baseline.
 * Canvas copies (the travelling cross and its fragments) are drawn from this.
 */
export const CROSS_GLYPH = {
  centerX: 0.3,
  centerY: 0.37,
  stem: { x: -0.045, y: -0.37, w: 0.09, h: 0.74 },
  bar: { x: -0.22, y: -0.195, w: 0.44, h: 0.08 },
} as const;

/**
 * Horizontal ink extent of the supplied UDX logo as fractions of the image (measured), and
 * the right edge of its first letter, the U (ink columns 41–90 of 236). `channel`: the U's
 * inner channel (open columns 60–72 of 236, open from its top at row 26 down to its floor at
 * about row 138 of 196), as fractions of the image.
 */
export const UDX_LOGO_INK = {
  x0: 0.174,
  x1: 0.852,
  /** vertical ink extent (rows 25–176 of 196): the logo is centred on its ink, not its file */
  y0: 25 / 196,
  y1: 177 / 196,
  u1: 0.386,
  channel: { x0: 60 / 236, x1: 73 / 236, top: 26 / 196, floor: 138 / 196 },
} as const;
/** Any other logo: assume ink may reach the image edges; first letter ≈ the first 30 %. */
export const GENERIC_LOGO_INK = { x0: 0, x1: 1, y0: 0, y1: 1, u1: 0.3 } as const;

export interface Cell {
  ch: string;
  accent: boolean;
  /** Width in character advances (1 for glyphs, `spaceWidth` for spaces). */
  w: number;
  /** Left edge relative to the line's centre, in character advances. */
  x: number;
  /** Time this cell becomes visible (spaces share their next glyph's time). */
  at: number;
}

/**
 * Splits the text into monospace cells and assigns keystroke times. Spaces ride along
 * with the following glyph so visible characters land at a perfectly even cadence.
 */
export function buildCells(text: string, accentSymbols: boolean, spaceWidth = 1): Cell[] {
  const chars = Array.from(text);
  const keys = chars.filter((c) => c.trim() !== '').length;
  const span = TIMELINE.lastKeyMax - TIMELINE.firstKey;
  const interval = keys > 1 ? Math.min(TIMELINE.keyInterval, span / (keys - 1)) : 0;
  const cells: Cell[] = [];
  let k = 0;
  const pending: number[] = [];
  chars.forEach((ch) => {
    const isSpace = ch.trim() === '';
    cells.push({
      ch,
      accent: accentSymbols && !isSpace && !/[\p{L}\p{N}]/u.test(ch),
      w: isSpace ? Math.max(0, spaceWidth) : 1,
      x: 0,
      at: 0,
    });
    if (isSpace) {
      pending.push(cells.length - 1);
    } else {
      const at = TIMELINE.firstKey + k * interval;
      cells[cells.length - 1].at = at;
      pending.forEach((i) => (cells[i].at = at));
      pending.length = 0;
      k += 1;
    }
  });
  const last = cells.length ? cells[cells.length - 1].at : TIMELINE.firstKey;
  pending.forEach((i) => (cells[i].at = last || TIMELINE.firstKey));
  const total = lineUnits(cells);
  let acc = 0;
  cells.forEach((c) => {
    c.x = acc - total / 2;
    acc += c.w;
  });
  return cells;
}

/** Total line width in character advances. */
export function lineUnits(cells: Cell[]): number {
  return cells.reduce((sum, c) => sum + c.w, 0);
}

/** Width (in advances) of the symbols at the END of the line, e.g. the ✝ in "UDX✝". */
export function trailingSymbolUnits(cells: Cell[]): number {
  let w = 0;
  for (let i = cells.length - 1; i >= 0; i -= 1) {
    if (!cells[i].accent) break;
    w += cells[i].w;
  }
  return w;
}

/** Solves critStep(τ, ω) = target for τ (bisection; target in (0, 1)). */
function critStepInverse(target: number, omega: number): number {
  let lo = 0;
  let hi = 2;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (critStep(mid, omega) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Cursor moves while typing, as [(startTime, advancesMoved)]. Each move starts early enough
 * that the cursor crosses each new glyph's centre exactly at its reveal time (the caret
 * leads, the letter springs up in its wake). The strike is a separate, explicit path.
 */
export function cursorEvents(cells: Cell[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const total = lineUnits(cells);
  let pos = 0;
  cells.forEach((c) => {
    if (c.ch.trim() === '') return;
    const left = c.x + total / 2;
    const target = left + c.w;
    const delta = target - pos;
    if (delta <= 0) return;
    const lead = critStepInverse((left + c.w / 2 - pos) / delta, TRACK_OMEGA);
    out.push([c.at - lead, delta]);
    pos = target;
  });
  if (pos < total) out.push([cells[cells.length - 1].at, total - pos]);
  return out;
}

/** Smoothly tracked cursor distance from the line's left edge (in advances) at time t. */
export function trackedCells(events: Array<[number, number]>, t: number): number {
  let m = 0;
  for (const [at, n] of events) m += n * critStep(t - at, TRACK_OMEGA);
  return m;
}

/** Deterministic PRNG (mulberry32) so the shed is identical on every mount. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sweep duration (s) for a distance in character advances: consistent speed, bounded. */
export function sweepDuration(distanceAdv: number): number {
  const d = distanceAdv / SWEEP.speed;
  if (!Number.isFinite(d)) return SWEEP.minDuration;
  return Math.min(SWEEP.maxDuration, Math.max(SWEEP.minDuration, d));
}

/**
 * Sweep progress 0 → 1 at time t: a short smooth start (half-cosine velocity ramp, so position
 * and velocity are continuous), then constant speed until it arrives. Never reverses.
 */
export function sweepProgress(t: number, duration: number): number {
  const D = Math.max(1e-3, duration);
  const tau = (t - TIMELINE.sweepStart) / D;
  if (!(tau > 0)) return 0;
  if (tau >= 1) return 1;
  const ra = Math.min(SWEEP.rampIn, 0.1 * D) / D;
  const vc = 1 / (1 - ra / 2);
  if (tau < ra) return vc * (tau / 2 - (ra / (2 * Math.PI)) * Math.sin((Math.PI * tau) / ra));
  return vc * (tau - ra / 2);
}

/** Below this an opacity is invisible (under one 8-bit step), so it snaps to exactly 0. */
const INVISIBLE = 1 / 255;

/**
 * Caret exit opacity factors at time t, for an exit from `start` to `end` (see SWEEP). The
 * trail (ghost copies + smear) fades out first (within SWEEP.trailFade s, at most 60 % of the
 * exit); the caret fades smoothly over [start, end]. From `end` on both are exactly 0, and any
 * value under 1/255 snaps to 0, so there are no faint afterimages.
 */
export function cursorExit(t: number, start: number, end: number): { caret: number; trail: number } {
  const s = Math.max(TIMELINE.sweepStart, Number.isFinite(start) ? start : TIMELINE.sweepStart);
  const e = Math.max(s + 1e-3, Number.isFinite(end) ? end : s + SWEEP.fadeMin);
  if (!(t < e)) return { caret: 0, trail: 0 };
  const caret = 1 - smoothstep(s, e, t);
  const trail = caret * (1 - smoothstep(s, s + Math.min(SWEEP.trailFade, 0.6 * (e - s)), t));
  return { caret: caret < INVISIBLE ? 0 : caret, trail: trail < INVISIBLE ? 0 : trail };
}

/** First time the sweep reaches progress p (inverse of sweepProgress, by bisection). */
export function sweepTimeAt(p: number, duration: number): number {
  const D = Math.max(1e-3, duration);
  if (!(p > 0)) return TIMELINE.sweepStart;
  if (p >= 1) return TIMELINE.sweepStart + D;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 32; i += 1) {
    const mid = (lo + hi) / 2;
    if (sweepProgress(TIMELINE.sweepStart + mid * D, D) < p) lo = mid;
    else hi = mid;
  }
  return TIMELINE.sweepStart + ((lo + hi) / 2) * D;
}

/** A tiny cross knocked off the struck cross. Units: em of the typed text. */
export interface CrossFragment {
  /** where it sits on the cross's ink, relative to the ink centre */
  ox: number;
  oy: number;
  /** its own scatter velocity (em/s) */
  kickX: number;
  kickY: number;
  /** share of the caret's push it takes (leftward) */
  push: number;
  scale: number;
  /** orientation it breaks off with (kept by fragments that don't rotate) */
  rot0: number;
  /**
   * Rotation added since break-off, sampled every FRAGMENTS.rotStep s (radians). All zeros
   * for fragments flying straight; see fragmentRotationTable.
   */
  turn: Float32Array;
  fadeStart: number;
  fadeEnd: number;
  accent: boolean;
}

export const FRAGMENTS = {
  count: 14,
  /**
   * Pieces left out of the burst (generation order): the five flung downward that would fall
   * into the open space below the logo's sloping bottom edge (3, 7, 9, 11, 13) and the two
   * small ones recoiling to the right of the X (5, 10). Every piece is still generated, so
   * the others keep exactly the same paths.
   */
  omit: [3, 5, 7, 9, 10, 11, 13],
  /**
   * Re-aimed pieces (generation index → [dx, dy, at]): the five that would otherwise bunch up
   * over the top of the U/D join are each launched so that their flight has carried them dx, dy
   * em (from their spot on the cross) `at` s after breaking off, spreading them over the logo's
   * negative spaces: the U's channel (above where the U drops settle), the U|D slit, the D's
   * counter, the D|X slit and the X's top notch (the smallest piece, which breaks off right
   * under it: a large one that close to the X's edge would be faded out by `bound`). Each stays
   * a glyph's reach inside the logo's outer silhouette. Only their launch velocity changes: drag,
   * gravity, push, size, colour, timing and the selective rotation (worked out from the new
   * launch, so some turn and some fly straight) are as for every other piece.
   */
  aim: {
    0: [-1.36, -0.42, 1.5],
    2: [-1.25, -0.31, 1.3],
    4: [-0.76, -0.62, 1],
    6: [-0.02, -0.6, 1.1],
    8: [-0.45, -0.45, 1],
  },
  /** drag: velocity left after τ is e^(-k·τ); slow enough that they still drift at 2.3 s */
  drag: 2.6,
  /** slow settle-down drift (em/s²) */
  gravity: 0.45,
  /** caret push carried into the fragments (em/s at full share) */
  pushSpeed: 1.2,
  /** upper bound of how far (em) a fragment travels; used to fit narrow screens */
  reach: 1.8,
  /** motion-blur shutter (s): each fragment is smeared over this window */
  shutter: 0.035,
  /**
   * Selective, trajectory-driven rotation (see fragmentRotationTable). `select`: a fragment
   * rotates only if its launch direction is diagonal (sin²2θ from select[0] to select[1]:
   * none → full); straighter ones keep their orientation. `tumble`: spin per em travelled
   * at an angle (min, + span × its own random), larger for smaller pieces; `follow`: share of
   * its path's turn (as gravity bends it into a fall) that it follows. Sampled every `rotStep`
   * s for `rotSpan` s (after which nothing turns any more). `upright`: no cross is ever drawn
   * more than `limit` rad from upright; up to `knee` its angle is exactly as its motion turns
   * it, beyond that the turn eases off smoothly (see uprightAngle).
   */
  rotation: {
    select: [0.8, 0.95],
    tumble: [0.9, 1.3],
    follow: [0.35, 0.35],
    rotStep: 1 / 240,
    rotSpan: 3,
    upright: { knee: (35 * Math.PI) / 180, limit: (60 * Math.PI) / 180 },
  },
  /**
   * How the pieces are drawn, so they read clearly (the smallest as crosses instead of faint
   * hairlines). Drawing only: count, paths, rotation, timing and masking are unchanged. Every
   * piece is drawn `grow` larger, pieces smaller than `liftBelow` up to `lift` more (the
   * smallest the most), and no stroke is ever thinner than `minStroke` CSS px.
   */
  visibility: { grow: 0.1, lift: 0.25, liftBelow: 0.32, minStroke: 1.5 },
  /**
   * The pieces stay around the logo (where it comes to rest, i.e. the place the emerging logo
   * grows into, as in the original burst, or where it is on screen at that moment): within its
   * outer silhouette (the mark with its channels, notches, slits and
   * counters closed and filled; gaps up to 2 × `close` × the ink width bridged) or the band
   * just above it (each column of the silhouette extends `above` × the logo height above its
   * top), so the burst rises above the logo as in the original but never drifts off beside or
   * below it. A piece fades out over `fade` s just before its glyph (plus `margin` px) would
   * first touch that area's edge, so it never crosses it; its path, rotation and timing are
   * unchanged. As it breaks off it may also be within `impact` em of the struck cross's ink
   * centre (the cross stands just right of the X); a piece leaving the cross away from the
   * logo fades out before it gets clear of it.
   */
  bound: { close: 0.056, above: 0.5, fade: 0.1, impact: 0.4, margin: 1.5 },
} as const;

/** Drawn size of a fragment (em of the typed text) for its generated `scale` (see FRAGMENTS.visibility). */
export function fragmentDrawScale(scale: number): number {
  const V = FRAGMENTS.visibility;
  const s = Number.isFinite(scale) && scale > 0 ? scale : 0;
  const smallest = 0.15; // the smallest piece generateCrossFragments makes
  return s * (1 + V.grow + V.lift * clamp01((V.liftBelow - s) / (V.liftBelow - smallest)));
}

/**
 * Seeded, so every mount sheds the same fragments (the rotation is selective and
 * trajectory-driven, see fragmentRotationTable). The caret slices through the cross
 * horizontally, so the pieces are flung mostly up and down, perpendicular to the cut
 * (alternating, so it stays balanced), carrying part of the caret's leftward push; a couple
 * of small ones recoil to the right. They clear the text line instead of piling onto it.
 * Sizes vary. Not a radial explosion. The pieces in FRAGMENTS.aim are launched toward their
 * own spots over the logo instead of along the fan; every random draw is still made, so the
 * others keep exactly the same paths.
 */
export function generateCrossFragments(): CrossFragment[] {
  const rand = mulberry32(0x57a1e);
  const out: CrossFragment[] = [];
  const n = FRAGMENTS.count;
  const aim: Readonly<Partial<Record<number, readonly [number, number, number]>>> = FRAGMENTS.aim;
  for (let i = 0; i < n; i += 1) {
    const r = Array.from({ length: 9 }, rand);
    const recoil = i === 5 || i === 10;
    const side = i % 2 === 0 ? -1 : 1; // up / down
    // screen angles: π = left; side·(…) tilts it up (negative y) or down
    // spread evenly over a 30°–82° fan above / below "left" (index-stratified, then jittered)
    const slot = (Math.floor(i / 2) + 0.5) / Math.ceil(n / 2);
    const ang = recoil
      ? side * (0.5 + r[0] * 0.4)
      : Math.PI - side * (0.52 + 0.9 * Math.min(1, Math.max(0, slot + (r[0] - 0.5) * 0.15)));
    const kick = recoil ? 0.9 + r[1] * 0.6 : 1.6 + r[1] * 2.2;
    const onStem = r[2] < 0.6;
    const push = recoil ? 0 : 0.3 + r[5] * 0.4;
    // re-aimed: the launch that covers [dx, dy] by `at` under the same drag, push and gravity
    // as fragmentPose (at full spread)
    const to = aim[i];
    const at = to && to[2] > 0 ? to[2] : 0;
    const travel = at > 0 ? (1 - Math.exp(-FRAGMENTS.drag * at)) / FRAGMENTS.drag : 0;
    const aimed = !!to && travel > 1e-6;
    const kickX = aimed ? to[0] / travel + push * FRAGMENTS.pushSpeed : Math.cos(ang) * kick;
    const kickY = aimed ? (to[1] - 0.5 * FRAGMENTS.gravity * at * at) / travel : Math.sin(ang) * kick;
    const scale = (recoil ? 0.12 : 0.15) + Math.pow(r[6], 1.5) * (recoil ? 0.12 : 0.33);
    out.push({
      ox: onStem ? (r[3] - 0.5) * 0.09 : (r[3] - 0.5) * 0.44,
      oy: onStem ? (r[4] - 0.5) * 0.74 : -0.155 + (r[4] - 0.5) * 0.08,
      kickX,
      kickY,
      push,
      scale,
      rot0: (r[7] - 0.5) * 1.0,
      turn: fragmentRotationTable(kickX - push * FRAGMENTS.pushSpeed, kickY, scale, r[7], r[8]),
      fadeStart: TIMELINE.fragmentsOut[0] + r[5] * 0.25,
      fadeEnd: Math.min(TIMELINE.fragmentsOut[1], TIMELINE.fragmentsOut[0] + 0.35 + r[5] * 0.25),
      accent: i % 4 !== 1,
    });
  }
  const omit: readonly number[] = FRAGMENTS.omit;
  return out.filter((_, i) => !omit.includes(i));
}

/**
 * Two small crosses that drop into the U's inner channel after the strike (UDX logo only).
 * Positions are fractions of the logo: `x` and `sway` in half-widths of the channel from its
 * centre, `from`/`to` in its height. Each falls from just inside the channel's open top to its
 * own resting height (`to`) in `dur` s, starting gently, then settling (a damped curve), with
 * its own sideways sway that dies out as it settles and a small tilt that follows the sway
 * (`rot0` + `tilt`, radians: always near upright). From `fadeAt` it eases out over `fadeDur`
 * s, sinking a little further (`sink`) as it fades, well inside the channel. `size`: its
 * glyph size as a share of the logo's width (it fits the channel at any size).
 */
export const U_DROPS = [
  // The deeper one drops first, so the two never pass each other in the channel. Same paths
  // as before (positions are a function of each one's own progress), about 35 % quicker; both
  // are gone by 2.8 s, before the logo's glow begins.
  { start: 1.68, dur: 0.78, from: 0.17, to: 0.58, x: 0.14, sway: -0.28, rot0: 0.11, tilt: -0.16, size: 0.043, fadeAt: 2.42, fadeDur: 0.38, sink: 0.03 },
  { start: 1.9, dur: 0.68, from: 0.175, to: 0.4, x: -0.12, sway: 0.34, rot0: -0.09, tilt: 0.2, size: 0.05, fadeAt: 2.5, fadeDur: 0.3, sink: 0.025 },
] as const;
export type UDrop = (typeof U_DROPS)[number];

/**
 * One U drop at time t: its centre (`u`: half-widths of the channel from its centre; `v`:
 * fraction of the logo height), angle (radians) and opacity. Null before it starts or after
 * it has gone. Pure.
 */
export function uDropAt(d: UDrop, t: number): { u: number; v: number; rot: number; alpha: number } | null {
  const tau = t - d.start;
  if (!(tau >= 0) || t >= d.fadeAt + d.fadeDur) return null;
  const x = Math.min(1, tau / d.dur);
  const p = critStep(x, 5.2) / critStep(1, 5.2); // 0 → 1: starts gently, settles softly
  // sideways sway, dying out as it settles, and its velocity (for the tilt)
  const ph = 1.5 * Math.PI * p;
  const sway = Math.sin(ph) * (1 - p);
  const swayV = 1.5 * Math.PI * Math.cos(ph) * (1 - p) - Math.sin(ph);
  const out = smoothstep(d.fadeAt, d.fadeAt + d.fadeDur, t);
  return {
    u: d.x + d.sway * sway,
    v: d.from + (d.to - d.from) * p + d.sink * out,
    rot: d.rot0 + (d.tilt * swayV) / (1.5 * Math.PI),
    alpha: smoothstep(0, 0.14, tau) * (1 - out),
  };
}

/**
 * The logo's one-time glow (UDX logo or any logo whose pixels can be read), traced from the
 * logo's complete pixel mask (every edge of the mark: its angular corners, notches and lower
 * contours, the slits between letters and the D's counter included):
 *  - rim: an emissive orange-red line on the black's own outer edges, hottest right at the
 *    edge and fading into the ink within `width` (× logo height);
 *  - halo: a tight glow just outside the edges, fading over `width`;
 *  - bloom: a soft aura shaped like the halo (blurred over `radius`), hugging the silhouette
 *    (`drop`: how far it sinks, × logo height; 0 keeps it centred on the edges).
 * The light comes from the bottom contour: edges facing down (the U's pointed bottom, the
 * rising diagonal towards the X, the X's lower edges) glow fully, ramping in with how much
 * they face down (`facing`: smoothstep from [0] to [1] of the normal's downward part, to the
 * power [2]); sides, tops and slit walls keep only `around` (a faint reflected light) and
 * the D's enclosed counter none, so the upper U, D and X stay solid black. It is a soft
 * emission seeping a little into the black with a gentle bloom below, not an outline;
 * `blend` smooths the change around corners. The rim and halo are drawn at about the logo's on-screen device resolution (`fine`).
 * It begins only once every cross has gone (`start`, after TIMELINE.fragmentsOut and the U
 * drops), eases in over `rise` s, holds its peak for `hold` s, eases out over `fall` s and is
 * gone before the animation ends: the logo is left plain black. It happens exactly once.
 * Opacities are per layer at the peak.
 */
export const GLOW = {
  start: 2.86,
  rise: 0.42,
  hold: 0.14,
  fall: 0.48,
  /**
   * The narrow slits between letters (gaps up to 2 × `slit` × the ink width, at least
   * `slitLength` × the ink height long): their walls glow, the gap itself stays clear.
   */
  slit: 0.019,
  slitLength: 0.2,
  around: 0.03,
  facing: [0.05, 0.9, 1.4],
  /** smoothing used to read each edge's direction, × logo height */
  normal: 0.012,
  /** fine grid: up to `maxScale` × the silhouette's resolution and `maxCells` pixels; margin × logo height */
  fine: { maxScale: 2, maxCells: 600_000, margin: 0.12 },
  rim: { hot: [255, 150, 78], deep: [214, 58, 24], opacity: 0.85, width: 0.024, blend: 0.02 },
  halo: { color: [255, 92, 40], opacity: 0.6, width: 0.02, blend: 0.035 },
  bloom: { color: [255, 104, 56], opacity: 0.34, radius: 0.045, gain: 2.4, drop: 0.012, margin: 0.3 },
} as const;

/**
 * The glow's strength (0–1) at time t: 0 until GLOW.start, a smooth ease-in-out rise to 1,
 * a brief hold at the peak, a smooth ease-in-out fall back to 0, then 0 for good. Pure.
 */
export function glowStrength(t: number): number {
  const up = GLOW.start;
  const peak = up + GLOW.rise;
  const down = peak + GLOW.hold;
  const off = down + GLOW.fall;
  if (!(t > up) || t >= off) return 0;
  return Math.min(smoothstep(up, peak, t), 1 - smoothstep(down, off, t));
}

/**
 * Rotation of one fragment over time, driven by its own trajectory (launch velocity vx0, vy0
 * in em/s; the same drag and gravity as fragmentPose). Pure and deterministic.
 *  - Selective: only a diagonal launch (≈ 35°–55° from horizontal) rotates; fragments flying
 *    straighter (flatter, or steeper) keep their orientation (all zeros).
 *  - Tumble: spin accumulates with distance travelled AT AN ANGLE (speed × sin²2θ of the current
 *    heading), so it is fastest in the burst, slows as the fragment slows and stops once it
 *    falls straight down. Smaller pieces spin a little faster; each has its own rate.
 *  - Direction: pieces flung upward and downward spin in mirror directions (the recoiling
 *    piece follows its own path), and a piece also follows part of its path's turn as gravity
 *    bends it into a fall, but only when that turn goes the same way as its spin, so no
 *    fragment ever reverses.
 */
export function fragmentRotationTable(vx0: number, vy0: number, scale: number, r7: number, r8: number): Float32Array {
  const R = FRAGMENTS.rotation;
  const steps = Math.ceil(R.rotSpan / R.rotStep);
  const table = new Float32Array(steps + 1);
  const sp0 = Math.hypot(vx0, vy0);
  if (!(sp0 > 1e-6)) return table;
  const diag0 = Math.pow((2 * vx0 * vy0) / (sp0 * sp0), 2);
  const sel = smoothstep(R.select[0], R.select[1], diag0);
  if (sel <= 0) return table; // flying straight: keeps its orientation
  const dir = vx0 * vy0 > 0 ? -1 : 1; // up-left / down-right → counter-clockwise; mirrored otherwise
  const turnDir = vx0 < 0 ? -1 : 1; // how gravity bends its heading
  const tumble = (R.tumble[0] + R.tumble[1] * r8) * Math.sqrt(0.3 / Math.max(0.15, scale));
  const follow = dir === turnDir ? R.follow[0] + R.follow[1] * ((r8 * 9.7 + r7 * 3.1) % 1) : 0;
  const k = FRAGMENTS.drag;
  const g = FRAGMENTS.gravity;
  const rate = (vx: number, vy: number) => {
    const sp = Math.hypot(vx, vy);
    return sp > 1e-9 ? sp * Math.pow((2 * vx * vy) / (sp * sp), 2) : 0;
  };
  let pvx = vx0;
  let pvy = vy0;
  let heading = 0;
  let spin = 0;
  for (let j = 1; j <= steps; j += 1) {
    const t = j * R.rotStep;
    const e = Math.exp(-k * t);
    const vx = vx0 * e;
    const vy = vy0 * e + g * t;
    heading += Math.atan2(pvx * vy - pvy * vx, pvx * vx + pvy * vy);
    spin += 0.5 * (rate(pvx, pvy) + rate(vx, vy)) * R.rotStep;
    table[j] = sel * (follow * heading + dir * tumble * spin);
    pvx = vx;
    pvy = vy;
  }
  return table;
}

/** Rotation (radians) a fragment has added τ seconds after break-off (linear interpolation). */
function fragmentTurn(f: CrossFragment, tau: number): number {
  const tb = f.turn;
  if (!tb || tb.length === 0 || !(tau > 0)) return 0;
  const x = tau / FRAGMENTS.rotation.rotStep;
  const i = Math.floor(x);
  if (i >= tb.length - 1) return tb[tb.length - 1];
  return tb[i] + (tb[i + 1] - tb[i]) * (x - i);
}

/**
 * The angle a fragment is drawn at, from the rotation its motion gives it (radians, 0 =
 * upright): unchanged up to FRAGMENTS.rotation.upright.knee either way; beyond it, the turn
 * eases off smoothly (same direction, never reversing, no kink) toward `limit`, which it never
 * reaches. So a cross can tilt as its motion demands but is never sideways or upside down.
 */
export function uprightAngle(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  const { knee, limit } = FRAGMENTS.rotation.upright;
  const a = Math.abs(raw);
  if (a <= knee) return raw;
  const room = limit - knee;
  return Math.sign(raw) * (knee + room * Math.tanh((a - knee) / room));
}

/**
 * Fragment offset (em, from the cross's ink centre) and rotation τ seconds after the caret
 * knocked it off: its kick plus a share of the caret's leftward push, decaying with drag,
 * plus a slow fall. `spread` (0–1) shrinks the scatter on narrow screens. The rotation is
 * kept upright (uprightAngle).
 */
export function fragmentPose(f: CrossFragment, tau: number, spread = 1): [number, number, number] {
  const t = Math.max(0, tau);
  const k = FRAGMENTS.drag;
  const travel = (1 - Math.exp(-k * t)) / k;
  const vx = f.kickX - f.push * FRAGMENTS.pushSpeed;
  return [
    f.ox + vx * travel * spread,
    f.oy + (f.kickY * travel + 0.5 * FRAGMENTS.gravity * t * t) * spread,
    uprightAngle(f.rot0 + fragmentTurn(f, t)),
  ];
}
