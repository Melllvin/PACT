import type { Point } from './field';

/**
 * The particles of a change of view (FR-042), ported from the « Grille réactive » mockup: motes
 * fly from the click to their place in the view, then scatter and fade; the tiles and their
 * borders come in after, in CSS. Times in seconds, distances in CSS pixels.
 */

export const BURST_COUNT = 700;
/** Each half of the burst: coming together, then scattering. */
export const BURST_PHASE = 0.34;
export const BURST_LIFE = 2 * BURST_PHASE;
const SCATTER = 120;

export type Mote = {
  /** Its place in the view. */
  tx: number;
  ty: number;
  /** 0 to 1: how late it leaves. */
  delay: number;
  size: number;
  /** The action color, or one of the first four agent colors. */
  color: 'action' | 0 | 1 | 2 | 3;
  /** Where it scatters to. */
  dx: number;
  dy: number;
};

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const easeOut = (value: number) => 1 - (1 - value) ** 3;

export function burstMotes(
  width: number,
  height: number,
  random: () => number = Math.random,
  count = BURST_COUNT,
): Mote[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = random() * Math.PI * 2;
    return {
      tx: random() * width,
      ty: random() * height,
      delay: random(),
      size: 3 + random() * 7,
      color: random() < 0.5 ? 'action' : ((index % 4) as 0 | 1 | 2 | 3),
      dx: Math.cos(angle),
      dy: Math.sin(angle),
    };
  });
}

/** Where a mote is `elapsed` seconds into the burst, and how visible; null once it is over. */
export function moteAt(mote: Mote, origin: Point, elapsed: number) {
  if (elapsed > BURST_LIFE) return null;
  const phase = elapsed / BURST_PHASE;
  if (phase <= 1) {
    const k = easeOut(clamp(phase * 1.3 - mote.delay * 0.3));
    return {
      x: origin.x + (mote.tx - origin.x) * k,
      y: origin.y + (mote.ty - origin.y) * k,
      alpha: k,
    };
  }
  const q = phase - 1;
  return {
    x: mote.tx + mote.dx * q * q * SCATTER,
    y: mote.ty + mote.dy * q * q * SCATTER,
    alpha: 1 - easeOut(q),
  };
}
