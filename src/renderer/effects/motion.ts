import { useEffect, useState } from 'react';

const REDUCE = '(prefers-reduced-motion: reduce)';

const allowedNow = () =>
  typeof window.matchMedia === 'function' && !window.matchMedia(REDUCE).matches;

/**
 * Whether the ambient effects may move: never without `matchMedia`, never under
 * `prefers-reduced-motion`, and they stop as soon as the system setting changes (FR-042).
 */
export function useMotionAllowed() {
  const [allowed, setAllowed] = useState(allowedNow);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(REDUCE);
    const update = () => {
      setAllowed(!media.matches);
    };
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
    };
  }, []);
  return allowed;
}

/** Sizes the canvas to its box at the screen's density, then clears it. */
export function fit(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  const density = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * density)) canvas.width = Math.round(width * density);
  if (canvas.height !== Math.round(height * density)) canvas.height = Math.round(height * density);
  context.setTransform(density, 0, 0, density, 0, 0);
  context.clearRect(0, 0, width, height);
  return { width, height };
}
