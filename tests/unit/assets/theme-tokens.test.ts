import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_COLORS } from '../../../src/shared/model';

const themeDir = join(dirname(fileURLToPath(import.meta.url)), '../../../src/renderer/theme');
const css = readFileSync(join(themeDir, 'tokens.css'), 'utf8');
const token = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();

// Direction 1c (spec « Références UI », research.md R10, FR-040).
describe('theme tokens', () => {
  it.each([
    ['bg', '#0d1117'],
    ['surface', '#131820'],
    ['text', '#dfe4eb'],
    ['text-muted', '#8b94a4'],
    ['border', '#27303c'],
    ['waiting', '#d6934f'],
    ['danger', '#c94646'],
    ['accept', '#45c664'],
    ['action', '#6cc5e0'],
    ['radius', '6px'],
  ])('defines --%s as %s', (name, value) => {
    expect(token(name)?.toLowerCase()).toBe(value);
  });

  it('defines one color per agent, in the order agents receive them', () => {
    const expected = ['#a07fdc', '#6cc5e0', '#45c664', '#d466a8', '#c9c85a', '#5a6890'];
    expect(AGENT_COLORS.map((color) => token(`agent-${color}`)?.toLowerCase())).toEqual(expected);
  });

  it('embeds Instrument Sans and JetBrains Mono without any network request', () => {
    const sources = [...css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map((m) => m[1] ?? '');
    expect(sources.length).toBeGreaterThanOrEqual(2);
    for (const source of sources) {
      expect(source).not.toMatch(/^(https?:)?\/\//);
      expect(existsSync(join(themeDir, source))).toBe(true);
    }
    expect(css).toMatch(/font-family:\s*['"]Instrument Sans['"]/);
    expect(css).toMatch(/font-family:\s*['"]JetBrains Mono['"]/);
  });

  it('ships the fonts with their SIL Open Font License', () => {
    expect(readFileSync(join(themeDir, 'fonts', 'OFL-InstrumentSans.txt'), 'utf8')).toContain(
      'SIL OPEN FONT LICENSE',
    );
    expect(readFileSync(join(themeDir, 'fonts', 'OFL-JetBrainsMono.txt'), 'utf8')).toContain(
      'SIL OPEN FONT LICENSE',
    );
  });
});

// research.md R16 — Tailwind v4 and the shadcn/ui theme, built on the 1c tokens.
describe('Tailwind theme', () => {
  const globals = readFileSync(join(themeDir, 'globals.css'), 'utf8');
  const variable = (name: string) =>
    new RegExp(`--${name}:\\s*([^;]+);`).exec(globals)?.[1]?.trim();

  it('loads Tailwind, its animations and the 1c tokens, without any network request', () => {
    expect(globals).toMatch(/@import ['"]tailwindcss['"]/);
    expect(globals).toMatch(/@import ['"]tw-animate-css['"]/);
    expect(globals).toMatch(/@import ['"]\.\/tokens\.css['"]/);
    expect(globals).not.toMatch(/url\(['"]?(https?:)?\/\//);
  });

  // Straight to the Tailwind colors: shadcn's own --border would loop on the 1c --border.
  it.each([
    ['background', 'var(--bg)'],
    ['foreground', 'var(--text)'],
    ['card', 'var(--surface)'],
    ['popover', 'var(--surface)'],
    ['muted', 'var(--surface)'],
    ['muted-foreground', 'var(--text-muted)'],
    ['border', 'var(--border)'],
    ['input', 'var(--border)'],
    ['ring', 'var(--action)'],
    ['primary', 'var(--action)'],
    ['primary-foreground', 'var(--bg)'],
    ['destructive', 'var(--danger)'],
  ])('gives the Tailwind color %s the 1c token %s', (name, value) => {
    expect(variable(`color-${name}`)).toBe(value);
  });

  it('keeps the 1c radius and fonts in the Tailwind theme', () => {
    expect(variable('radius-md')).toBe('var(--radius)');
    expect(variable('font-sans')).toBe('var(--font-ui)');
    expect(variable('font-mono')).toBe('var(--font-mono)');
  });
});
