import { useEffect, useRef } from 'react';
import { drawWaves } from './draw';
import { fit, useMotionAllowed } from './motion';

/** The waves across the quick launch header (R17): they run while the dialog is shown. */
export function Waves() {
  const allowed = useMotionAllowed();
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = allowed && canvas ? canvas.getContext('2d') : null;
    if (!canvas || !context) return;

    let frame = 0;
    const tick = () => {
      frame = 0;
      const { width, height } = fit(canvas, context);
      drawWaves(context, width, height, performance.now() / 1000);
      if (!document.hidden) frame = requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      if (!document.hidden && !frame) frame = requestAnimationFrame(tick);
    };
    document.addEventListener('visibilitychange', onVisibility);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [allowed]);

  if (!allowed) return null;
  return <canvas ref={ref} aria-hidden="true" className="pointer-events-none block h-12 w-full" />;
}
