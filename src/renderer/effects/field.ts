/**
 * The arithmetic of the ambient effects of the interactive mockup (research.md R17), kept apart
 * from the drawing so it can be tested. Times are in seconds, distances in CSS pixels.
 */

export type Point = { x: number; y: number };
export type Rect = { left: number; top: number; right: number; bottom: number };
/** A click wave, `age` seconds after the click. */
export type Wave = Point & { age: number };

/** Spacing of the workspace dots. */
export const DOT_SPACING = 24;
/** How long a click wave spreads, and a spark flies. */
export const SHOCK_LIFE = 1.4;
export const SPARK_LIFE = 0.45;
/** How long the loop keeps running after the last move of the cursor. */
export const REST_DELAY = 1.5;
export const FIBER_COUNT = 34;

const DOT_REACH = 150;
const RING_SPEED = 420;
const RING_BAND = 50;
const FIBER_REACH = 220;
const GLOW_FOLLOW = 0.16;

/** How far a dot is pushed by the cursor and the waves, and how much it lights up (0 to 1). */
export function dotOffset(dot: Point, mouse: Point | null, waves: readonly Wave[]) {
  let dx = 0;
  let dy = 0;
  let glow = 0;
  if (mouse) {
    const x = dot.x - mouse.x;
    const y = dot.y - mouse.y;
    const d = Math.hypot(x, y);
    if (d < DOT_REACH) {
      glow = 1 - d / DOT_REACH;
      const push = glow * glow * 10;
      dx += (x / (d || 1)) * push;
      dy += (y / (d || 1)) * push;
    }
  }
  for (const wave of waves) {
    const x = dot.x - wave.x;
    const y = dot.y - wave.y;
    const d = Math.hypot(x, y);
    const band =
      Math.max(0, 1 - Math.abs(d - wave.age * RING_SPEED) / RING_BAND) *
      Math.max(0, 1 - wave.age / SHOCK_LIFE);
    if (band > 0) {
      dx += (x / (d || 1)) * band * 14;
      dy += (y / (d || 1)) * band * 14;
      glow = Math.max(glow, band * 0.8);
    }
  }
  return { dx, dy, glow };
}

/** Height of the fiber `index` at `x` on the home tab, pushed away from a cursor close by. */
export function fiberY(x: number, index: number, height: number, t: number, mouse: Point | null) {
  const phase = index * 0.7;
  const base = height * (0.42 + (0.5 * index) / FIBER_COUNT);
  let y =
    base +
    Math.sin(x * 0.0035 + t * 0.22 + phase) * 70 +
    Math.sin(x * 0.011 - t * 0.37 + phase * 2) * 16;
  if (mouse) {
    const d = Math.hypot(x - mouse.x, y - mouse.y);
    if (d < FIBER_REACH) y += (y >= mouse.y ? 1 : -1) * (1 - d / FIBER_REACH) ** 2 * 46;
  }
  return y;
}

/** Whether a point falls in one of the rectangles: the tiles, where nothing is drawn (FR-020). */
export function insideAny(point: Point, rects: readonly Rect[]) {
  return rects.some(
    (r) => point.x > r.left && point.x < r.right && point.y > r.top && point.y < r.bottom,
  );
}

/** The cursor glow trails the cursor: it starts on it, then closes 16 % of the gap per frame. */
export function followGlow(glow: Point | null, target: Point): Point {
  if (!glow) return { ...target };
  return {
    x: glow.x + (target.x - glow.x) * GLOW_FOLLOW,
    y: glow.y + (target.y - glow.y) * GLOW_FOLLOW,
  };
}

type Activity = {
  now: number;
  lastPointer: number;
  shocks: readonly { t: number }[];
  sparks: readonly { t: number }[];
  glow: Point | null;
  target: Point | null;
};

/** Nothing left to animate: the loop can stop until the next move of the cursor. */
export function atRest({ now, lastPointer, shocks, sparks, glow, target }: Activity) {
  if (now - lastPointer < REST_DELAY) return false;
  if (shocks.some((shock) => now - shock.t < SHOCK_LIFE)) return false;
  if (sparks.some((spark) => now - spark.t < SPARK_LIFE)) return false;
  return !(glow && target && Math.hypot(target.x - glow.x, target.y - glow.y) > 0.5);
}
