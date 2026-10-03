import { describe, expect, it } from 'vitest';
import {
  BURST_COUNT,
  BURST_LIFE,
  BURST_PHASE,
  burstMotes,
  moteAt,
} from '../../../../src/renderer/effects/transition';

// T111 / FR-042 — a change of view: particles, then tiles, then borders (Grille réactive).

const sequence = (...values: number[]) => {
  let index = 0;
  return () => values[index++ % values.length] ?? 0;
};

describe('burstMotes', () => {
  it('scatters 700 motes over the area', () => {
    const motes = burstMotes(200, 100);
    expect(motes).toHaveLength(BURST_COUNT);
    expect(BURST_COUNT).toBe(700);
    for (const mote of motes) {
      expect(mote.tx).toBeGreaterThanOrEqual(0);
      expect(mote.tx).toBeLessThanOrEqual(200);
      expect(mote.ty).toBeGreaterThanOrEqual(0);
      expect(mote.ty).toBeLessThanOrEqual(100);
      expect(mote.size).toBeGreaterThanOrEqual(3);
      expect(mote.size).toBeLessThanOrEqual(10);
    }
  });

  it('colors half of them with the action color, the rest with the agents’ colors in turn', () => {
    const actions = burstMotes(10, 10, sequence(0.2), 3).map((mote) => mote.color);
    expect(actions).toEqual(['action', 'action', 'action']);
    const agents = burstMotes(10, 10, sequence(0.7), 5).map((mote) => mote.color);
    expect(agents).toEqual([0, 1, 2, 3, 0]);
  });
});

describe('moteAt', () => {
  const mote = { tx: 100, ty: 50, delay: 0, size: 4, color: 'action' as const, dx: 1, dy: 0 };
  const origin = { x: 0, y: 0 };

  it('leaves from the origin, unseen', () => {
    expect(moteAt(mote, origin, 0)).toEqual({ x: 0, y: 0, alpha: 0 });
  });

  it('has reached its place, fully seen, after the first phase', () => {
    expect(moteAt(mote, origin, BURST_PHASE)).toEqual({ x: 100, y: 50, alpha: 1 });
  });

  it('a later mote leaves later', () => {
    const early = moteAt(mote, origin, BURST_PHASE / 3);
    const late = moteAt({ ...mote, delay: 1 }, origin, BURST_PHASE / 3);
    expect(late?.x ?? 0).toBeLessThan(early?.x ?? 0);
  });

  it('then flies off along its direction and fades out', () => {
    const half = moteAt(mote, origin, BURST_PHASE * 1.5);
    expect(half?.x).toBeCloseTo(100 + 0.25 * 120);
    expect(half?.y).toBe(50);
    expect(half?.alpha).toBeGreaterThan(0);
    expect(half?.alpha).toBeLessThan(1);
    expect(moteAt(mote, origin, BURST_LIFE)?.alpha).toBeCloseTo(0);
  });

  it('is gone once the burst is over', () => {
    expect(BURST_LIFE).toBeCloseTo(2 * BURST_PHASE);
    expect(moteAt(mote, origin, BURST_LIFE + 0.01)).toBeNull();
  });
});
