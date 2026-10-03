import { describe, expect, it } from 'vitest';
import {
  atRest,
  dotOffset,
  fiberY,
  followGlow,
  insideAny,
  REST_DELAY,
  SHOCK_LIFE,
  SPARK_LIFE,
} from '../../../../src/renderer/effects/field';

describe('dotOffset (R17: the workspace dots)', () => {
  it('leaves a dot in place without cursor nor wave', () => {
    expect(dotOffset({ x: 12, y: 12 }, null, [])).toEqual({ dx: 0, dy: 0, glow: 0 });
  });

  it('ignores a cursor 150 px away or more', () => {
    expect(dotOffset({ x: 162, y: 12 }, { x: 12, y: 12 }, [])).toEqual({ dx: 0, dy: 0, glow: 0 });
  });

  it('pushes a nearer dot away from the cursor by f² × 10', () => {
    const { dx, dy, glow } = dotOffset({ x: 87, y: 12 }, { x: 12, y: 12 }, []);
    expect(glow).toBeCloseTo(0.5);
    expect(dx).toBeCloseTo(2.5);
    expect(dy).toBeCloseTo(0);
  });

  it('pushes the dots the ring of a click reaches, 420 px per second', () => {
    const { dx, glow } = dotOffset({ x: 210, y: 0 }, null, [{ x: 0, y: 0, age: 0.5 }]);
    const band = 1 - 0.5 / SHOCK_LIFE;
    expect(dx).toBeCloseTo(band * 14);
    expect(glow).toBeCloseTo(band * 0.8);
  });

  it('forgets a dot far from the ring, and a wave once it has faded', () => {
    expect(dotOffset({ x: 300, y: 0 }, null, [{ x: 0, y: 0, age: 0.5 }]).dx).toBe(0);
    expect(dotOffset({ x: 588, y: 0 }, null, [{ x: 0, y: 0, age: SHOCK_LIFE }]).dx).toBe(0);
  });
});

describe('fiberY (R17: the home fibers)', () => {
  it('ignores a cursor 220 px away or more', () => {
    const y = fiberY(300, 5, 800, 2, null);
    expect(fiberY(300, 5, 800, 2, { x: 300, y: y + 230 })).toBeCloseTo(y);
  });

  it('pushes the fiber away from a cursor close by', () => {
    const y = fiberY(300, 5, 800, 2, null);
    const pushed = fiberY(300, 5, 800, 2, { x: 300, y: y - 10 });
    expect(pushed - y).toBeCloseTo((1 - 10 / 220) ** 2 * 46);
  });
});

describe('insideAny (FR-020: nothing drawn under a terminal)', () => {
  const tiles = [{ left: 10, top: 10, right: 110, bottom: 60 }];

  it('tells whether a point falls in a tile', () => {
    expect(insideAny({ x: 50, y: 30 }, tiles)).toBe(true);
    expect(insideAny({ x: 150, y: 30 }, tiles)).toBe(false);
    expect(insideAny({ x: 50, y: 30 }, [])).toBe(false);
  });
});

describe('followGlow', () => {
  it('starts on the cursor, then follows it by 16 % each frame', () => {
    expect(followGlow(null, { x: 40, y: 8 })).toEqual({ x: 40, y: 8 });
    const next = followGlow({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(next.x).toBeCloseTo(16);
    expect(next.y).toBeCloseTo(0);
  });
});

describe('atRest (the loop stops at rest)', () => {
  const idle = { now: 10, lastPointer: 10 - REST_DELAY, shocks: [], sparks: [], glow: null };

  it('is at rest when nothing moves', () => {
    expect(atRest({ ...idle, target: null })).toBe(true);
  });

  it('keeps running just after the cursor moved', () => {
    expect(atRest({ ...idle, lastPointer: 9.9, target: null })).toBe(false);
  });

  it('keeps running while a wave or a spark lives', () => {
    expect(atRest({ ...idle, shocks: [{ t: 10 - SHOCK_LIFE / 2 }], target: null })).toBe(false);
    expect(atRest({ ...idle, sparks: [{ t: 10 - SPARK_LIFE / 2 }], target: null })).toBe(false);
    expect(atRest({ ...idle, shocks: [{ t: 10 - SHOCK_LIFE }], target: null })).toBe(true);
  });

  it('keeps running until the glow has caught up with the cursor', () => {
    const target = { x: 100, y: 100 };
    expect(atRest({ ...idle, glow: { x: 90, y: 100 }, target })).toBe(false);
    expect(atRest({ ...idle, glow: { x: 99.8, y: 100 }, target })).toBe(true);
  });
});
