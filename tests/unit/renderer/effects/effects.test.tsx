import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AmbientCanvas } from '../../../../src/renderer/effects/AmbientCanvas';
import { REST_DELAY } from '../../../../src/renderer/effects/field';
import { Waves } from '../../../../src/renderer/effects/Waves';

/** A 2D context that accepts every call, gradients included. */
function fakeContext() {
  const gradient = { addColorStop: vi.fn() };
  const calls: Record<string | symbol, unknown> = {};
  lastContext = calls;
  return new Proxy(calls, {
    get(target, key) {
      if (!(key in target)) target[key] = vi.fn(() => gradient);
      return target[key];
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

let lastContext: Record<string | symbol, unknown>;
let reduce: boolean;
let listeners: (() => void)[];
let frames: FrameRequestCallback[];
let clock: number;
let getContext: MockInstance<HTMLCanvasElement['getContext']>;

function allowMotion(value: boolean) {
  reduce = !value;
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return reduce;
      },
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
      removeEventListener: vi.fn(),
    })),
  );
}

/** Runs the pending frame, one second later. */
function step(seconds = 1) {
  clock += seconds * 1000;
  const pending = frames;
  frames = [];
  act(() => {
    pending.forEach((frame) => {
      frame(clock);
    });
  });
}

beforeEach(() => {
  listeners = [];
  frames = [];
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((frame: FrameRequestCallback) => frames.push(frame)),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  getContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => fakeContext());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

describe('AmbientCanvas (R17, FR-042)', () => {
  it('draws nothing without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { container } = render(<AmbientCanvas mode="workspace" />);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('draws nothing when the system asks for reduced motion', () => {
    allowMotion(false);
    const { container } = render(<AmbientCanvas mode="home" />);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('stops drawing as soon as the system asks for reduced motion', () => {
    allowMotion(true);
    const { container } = render(<AmbientCanvas mode="home" />);
    expect(container.querySelector('canvas')).not.toBeNull();
    reduce = true;
    act(() => {
      listeners.forEach((listener) => {
        listener();
      });
    });
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('starts no loop without a 2D canvas', () => {
    allowMotion(true);
    getContext.mockReturnValue(null);
    render(<AmbientCanvas mode="workspace" />);
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40 });
    expect(frames).toHaveLength(0);
  });

  it('is decoration only, under the content and out of the pointer’s way', () => {
    allowMotion(true);
    const { container } = render(<AmbientCanvas mode="workspace" />);
    const canvas = container.querySelector('canvas');
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(canvas?.className).toMatch(/pointer-events-none/);
    expect(canvas?.className).toMatch(/-z-10/);
  });

  it('draws one still frame, runs while the cursor moves, then stops at rest', () => {
    allowMotion(true);
    render(<AmbientCanvas mode="workspace" />);
    expect(frames).toHaveLength(1);
    step(0);
    expect(frames).toHaveLength(0);

    fireEvent.pointerMove(window, { clientX: 40, clientY: 40 });
    expect(frames).toHaveLength(1);
    step(0.1);
    expect(frames).toHaveLength(1);
    step(REST_DELAY);
    expect(frames).toHaveLength(0);
  });

  it('keeps running while a click wave spreads', () => {
    allowMotion(true);
    render(<AmbientCanvas mode="workspace" />);
    step(0);
    fireEvent.pointerDown(window, { clientX: 40, clientY: 40 });
    step(REST_DELAY + 0.1);
    expect(frames).toHaveLength(0);
    fireEvent.pointerDown(window, { clientX: 40, clientY: 40 });
    step(0.5);
    expect(frames).toHaveLength(1);
  });

  it('stops while the window is hidden', () => {
    allowMotion(true);
    render(<AmbientCanvas mode="home" />);
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40 });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    fireEvent(document, new Event('visibilitychange'));
    step(0.1);
    expect(frames).toHaveLength(0);
  });

  it('leaves no frame behind once gone', () => {
    allowMotion(true);
    const { unmount } = render(<AmbientCanvas mode="home" />);
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });
});

describe('drawing on a sized canvas', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(120);
    vi.spyOn(HTMLCanvasElement.prototype, 'clientHeight', 'get').mockReturnValue(60);
  });

  /** How many times the page called a method of the last 2D context, 0 if never. */
  const called = (method: string) =>
    method in lastContext ? vi.mocked(lastContext[method] as () => void).mock.calls.length : 0;

  it('draws the dots, the orb around the « + », the glow and the sparks in a workspace', () => {
    allowMotion(true);
    render(
      <>
        <span data-orb-anchor />
        <AmbientCanvas mode="workspace" />
      </>,
    );
    fireEvent.pointerMove(window, { clientX: 30, clientY: 20 });
    fireEvent.pointerDown(window, { clientX: 30, clientY: 20 });
    step(0.2);
    expect(called('arc')).toBeGreaterThan(0);
    expect(called('createRadialGradient')).toBeGreaterThan(4);
    expect(called('stroke')).toBe(8);
  });

  it('sends neither wave nor spark from a click on a tile', () => {
    allowMotion(true);
    render(
      <>
        <article data-fx-shield />
        <AmbientCanvas mode="workspace" />
      </>,
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 100, 100),
    );
    fireEvent.pointerDown(window, { clientX: 30, clientY: 20 });
    step(0.2);
    expect(called('stroke')).toBe(0);
  });

  it('draws the fibers on the home tab', () => {
    allowMotion(true);
    render(<AmbientCanvas mode="home" />);
    fireEvent.pointerMove(window, { clientX: 30, clientY: 20 });
    fireEvent.pointerLeave(document.documentElement);
    step(0.2);
    expect(called('stroke')).toBe(34);
  });

  it('draws three layers of waves', () => {
    allowMotion(true);
    render(<Waves />);
    step(0.2);
    expect(called('arc')).toBeGreaterThan(0);
    expect(called('rect')).toBeGreaterThan(0);
    expect(called('closePath')).toBeGreaterThan(0);
  });
});

describe('Waves (R17: the quick launch header)', () => {
  it('draws nothing when the system asks for reduced motion', () => {
    allowMotion(false);
    const { container } = render(<Waves />);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('runs while shown and visible, and stops once gone', () => {
    allowMotion(true);
    const { container, unmount } = render(<Waves />);
    expect(container.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true');
    step(0.1);
    expect(frames).toHaveLength(1);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    step(0.1);
    expect(frames).toHaveLength(0);
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });
});
