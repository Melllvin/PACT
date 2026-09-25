import { useEffect, useRef } from 'react';
import { drawBurst, drawDots, drawFibers, drawGlow, drawOrb, drawSparks } from './draw';
import { SHOCK_LIFE, SPARK_LIFE, atRest, followGlow, insideAny, type Point } from './field';
import { fit, useMotionAllowed } from './motion';
import { BURST_LIFE, burstMotes, type Mote } from './transition';

type Stamp = Point & { t: number };

/** What the effects never draw over nor react in: tiles, the Focus and dialogs (FR-020). */
const SHIELDS = '[data-fx-shield], [role="dialog"]';

const seconds = () => performance.now() / 1000;

/**
 * The ambient background of the interactive mockup (R17): fibers on the home tab; dots pushed by
 * the cursor and by click waves in a workspace, with an orb around the « + » when it is empty;
 * the cursor glow and click sparks. It lies under the content, so the opaque tiles hide it, and
 * its loop stops at rest (FR-042).
 */
export function AmbientCanvas({
  mode,
  view = mode,
}: {
  mode: 'home' | 'workspace';
  /** The tab in front: when it changes, particles come first (FR-042). */
  view?: string;
}) {
  const allowed = useMotionAllowed();
  const ref = useRef<HTMLCanvasElement>(null);
  const shown = useRef(view);
  /** Where the last click was, from which the particles of a change of view leave. */
  const lastDown = useRef<Point | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = allowed && canvas ? canvas.getContext('2d') : null;
    if (!canvas || !context) return;

    let pointer: Point | null = null;
    let glow: Point | null = null;
    let lastPointer = -Infinity;
    let shocks: Stamp[] = [];
    let sparks: Stamp[] = [];
    let frame = 0;
    let burst: { start: number; origin: Point; motes: Mote[] } | null = null;
    if (shown.current !== view) {
      shown.current = view;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      burst = {
        start: seconds(),
        origin: lastDown.current ?? { x: width * 0.8, y: 0 },
        motes: burstMotes(width, height),
      };
    }

    const local = (point: Point) => {
      const box = canvas.getBoundingClientRect();
      return { x: point.x - box.left, y: point.y - box.top };
    };

    const paint = (now: number) => {
      const { width, height } = fit(canvas, context);
      const mouse = pointer && local(pointer);
      shocks = shocks.filter((shock) => now - shock.t < SHOCK_LIFE);
      sparks = sparks.filter((spark) => now - spark.t < SPARK_LIFE);
      if (mode === 'home') drawFibers(context, width, height, now, mouse);
      else {
        const waves = shocks.map((shock) => ({ ...local(shock), age: now - shock.t }));
        drawDots(context, width, height, mouse, waves);
        const plus = document.querySelector('[data-orb-anchor]')?.getBoundingClientRect();
        if (plus) {
          const center = { x: plus.left + plus.width / 2, y: plus.top + plus.height / 2 };
          drawOrb(context, local(center), now, mouse);
        }
      }
      if (burst && now - burst.start > BURST_LIFE) burst = null;
      if (burst) drawBurst(context, burst.motes, local(burst.origin), now - burst.start);
      glow = mouse ? followGlow(glow, mouse) : null;
      if (glow) drawGlow(context, glow);
      drawSparks(
        context,
        sparks.map((spark) => ({ ...local(spark), age: now - spark.t })),
      );
      return mouse;
    };

    const tick = () => {
      frame = 0;
      const now = seconds();
      const target = paint(now);
      if (document.hidden) return;
      if (burst || !atRest({ now, lastPointer, shocks, sparks, glow, target })) {
        frame = requestAnimationFrame(tick);
      }
    };
    const wake = () => {
      if (!frame && !document.hidden) frame = requestAnimationFrame(tick);
    };
    const shielded = (point: Point) =>
      insideAny(
        point,
        [...document.querySelectorAll(SHIELDS)].map((element) => element.getBoundingClientRect()),
      );

    const onMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      lastPointer = seconds();
      wake();
    };
    const onLeave = () => {
      pointer = null;
      wake();
    };
    const onDown = (event: PointerEvent) => {
      const point = { x: event.clientX, y: event.clientY };
      lastDown.current = point;
      lastPointer = seconds();
      if (!shielded(point)) {
        shocks = [...shocks.slice(-3), { ...point, t: lastPointer }];
        sparks.push({ ...point, t: lastPointer });
      }
      wake();
    };
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else wake();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('resize', wake);
    document.documentElement.addEventListener('pointerleave', onLeave);
    document.addEventListener('visibilitychange', onVisibility);
    wake();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('resize', wake);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [allowed, mode, view]);

  if (!allowed) return null;
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 size-full"
    />
  );
}
