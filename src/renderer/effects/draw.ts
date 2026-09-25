import {
  DOT_SPACING,
  FIBER_COUNT,
  SPARK_LIFE,
  dotOffset,
  fiberY,
  type Point,
  type Wave,
} from './field';

/** Drawing of the ambient effects, ported from the interactive mockup (research.md R17). */

type Context = CanvasRenderingContext2D;

const TAU = Math.PI * 2;
const ACTION = [124, 200, 232] as const;
/** The first four agent colors (tokens.css), for the orb around the « + ». */
const ORB_COLORS = ['#a58be0', '#72c3e3', '#5fc98a', '#dc79b0'];
const FIBER_COLORS = ['#ededef', '#7cc8e8', '#a58be0'];
const WAVE_COLORS = ['#a58be0', '#72c3e3', '#dc79b0'];

const rgba = (hex: string, alpha: number) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${String(n >> 16)},${String((n >> 8) & 255)},${String(n & 255)},${alpha.toFixed(3)})`;
};

/** The workspace dots, pushed by the cursor and the click waves. */
export function drawDots(
  c: Context,
  width: number,
  height: number,
  mouse: Point | null,
  waves: readonly Wave[],
) {
  for (let y = DOT_SPACING / 2; y < height; y += DOT_SPACING) {
    for (let x = DOT_SPACING / 2; x < width; x += DOT_SPACING) {
      const { dx, dy, glow } = dotOffset({ x, y }, mouse, waves);
      c.fillStyle =
        glow > 0
          ? `rgba(${ACTION.join(',')},${(0.12 + glow * 0.7).toFixed(3)})`
          : 'rgba(255,255,255,.07)';
      c.beginPath();
      c.arc(x + dx, y + dy, 1 + glow * 1.4, 0, TAU);
      c.fill();
    }
  }
}

/** Four colored lights turning around the « + » of the empty workspace, hollow in the middle. */
export function drawOrb(c: Context, center: Point, t: number, mouse: Point | null) {
  const near = mouse
    ? Math.max(0, 1 - Math.hypot(mouse.x - center.x, mouse.y - center.y) / 260)
    : 0;
  const radius = 150 * (1 + near * 0.18);
  const speed = 0.35 + near * 0.9;
  c.save();
  c.globalCompositeOperation = 'lighter';
  ORB_COLORS.forEach((color, k) => {
    const a = t * speed + k * 1.571;
    const x = center.x + Math.cos(a) * 30;
    const y = center.y + Math.sin(a * 1.3) * 24;
    const light = c.createRadialGradient(x, y, 0, x, y, radius);
    light.addColorStop(0, rgba(color, 0.16 + near * 0.08));
    light.addColorStop(0.55, rgba(color, 0.05));
    light.addColorStop(1, rgba(color, 0));
    c.fillStyle = light;
    c.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  });
  c.globalCompositeOperation = 'destination-out';
  const hole = c.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius * 0.6);
  hole.addColorStop(0, 'rgba(0,0,0,.95)');
  hole.addColorStop(0.7, 'rgba(0,0,0,.4)');
  hole.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = hole;
  c.fillRect(center.x - radius, center.y - radius, radius * 2, radius * 2);
  c.restore();
}

/** The waving fibers of the home tab. */
export function drawFibers(
  c: Context,
  width: number,
  height: number,
  t: number,
  mouse: Point | null,
) {
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.lineWidth = 0.8;
  for (let i = 0; i < FIBER_COUNT; i++) {
    c.strokeStyle = rgba(FIBER_COLORS[i % 3] ?? '#ededef', 0.035 + 0.04 * Math.sin(t * 0.6 + i));
    c.beginPath();
    for (let x = -20; x <= width + 20; x += 14) {
      const y = fiberY(x, i, height, t, mouse);
      if (x === -20) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
  }
  c.restore();
}

/** The soft light trailing the cursor. */
export function drawGlow(c: Context, glow: Point) {
  c.save();
  c.globalCompositeOperation = 'lighter';
  const halo = c.createRadialGradient(glow.x, glow.y, 0, glow.x, glow.y, 180);
  halo.addColorStop(0, 'rgba(124,200,232,.10)');
  halo.addColorStop(0.4, 'rgba(165,139,224,.04)');
  halo.addColorStop(1, 'rgba(124,200,232,0)');
  c.fillStyle = halo;
  c.fillRect(glow.x - 180, glow.y - 180, 360, 360);
  const core = c.createRadialGradient(glow.x, glow.y, 0, glow.x, glow.y, 14);
  core.addColorStop(0, 'rgba(255,255,255,.18)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = core;
  c.fillRect(glow.x - 14, glow.y - 14, 28, 28);
  c.restore();
}

/** Eight rays flying out of a click, for SPARK_LIFE seconds. */
export function drawSparks(c: Context, sparks: readonly Wave[]) {
  c.save();
  c.lineCap = 'round';
  c.lineWidth = 1.5;
  for (const spark of sparks) {
    const e = spark.age / SPARK_LIFE;
    const eased = 1 - (1 - e) ** 3;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.2;
      const from = 4 + eased * 22;
      const to = from + 9 * (1 - e);
      c.strokeStyle = i % 2 ? `rgba(255,255,255,${(1 - e).toFixed(3)})` : rgba('#7cc8e8', 1 - e);
      c.beginPath();
      c.moveTo(spark.x + Math.cos(a) * from, spark.y + Math.sin(a) * from);
      c.lineTo(spark.x + Math.cos(a) * to, spark.y + Math.sin(a) * to);
      c.stroke();
    }
  }
  c.restore();
}

/** Three layers of dots, squares and diamonds waving across the quick launch header. */
export function drawWaves(c: Context, width: number, height: number, t: number) {
  WAVE_COLORS.forEach((color, layer) => {
    const amplitude = 8 + layer * 4;
    const speed = 0.9 + layer * 0.3;
    const size = 1.6 + layer * 0.5;
    for (let x = 8; x < width; x += 12) {
      const y =
        height / 2 +
        Math.sin(x * 0.018 + t * speed + layer * 1.9) * amplitude +
        Math.sin(x * 0.041 - t * speed * 0.6) * 3;
      c.fillStyle = rgba(color, 0.25 * Math.min(1, x / 80, (width - x) / 80));
      c.beginPath();
      if (layer === 0) c.arc(x, y, size, 0, TAU);
      else if (layer === 1) c.rect(x - size, y - size, size * 2, size * 2);
      else {
        c.moveTo(x, y - size * 1.3);
        c.lineTo(x + size * 1.3, y);
        c.lineTo(x, y + size * 1.3);
        c.lineTo(x - size * 1.3, y);
        c.closePath();
      }
      c.fill();
    }
  });
}
