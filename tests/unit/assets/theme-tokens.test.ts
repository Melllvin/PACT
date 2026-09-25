import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_COLORS } from '../../../src/shared/model';

const themeDir = join(dirname(fileURLToPath(import.meta.url)), '../../../src/renderer/theme');
const css = readFileSync(join(themeDir, 'tokens.css'), 'utf8');
const token = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();

// Maquette interactive (spec « Références UI », research.md R17, FR-040).
describe('theme tokens', () => {
  it.each([
    ['bg', '#09090b'],
    ['surface', '#0c0c0f'],
    ['text', '#ededef'],
    ['text-muted', '#8b8b93'],
    ['border', '#232327'],
    ['waiting', '#e0a458'],
    ['danger', '#e06464'],
    ['accept', '#4fcf7d'],
    ['action', '#7cc8e8'],
    ['radius', '10px'],
  ])('defines --%s as %s', (name, value) => {
    expect(token(name)?.toLowerCase()).toBe(value);
  });

  it('defines one color per agent, in the order agents receive them', () => {
    // The 6th stays blue-grey: orange is kept for ◆ attend (FR-016, FR-040, R17).
    const expected = ['#a58be0', '#72c3e3', '#5fc98a', '#dc79b0', '#cfc86a', '#7d89b0'];
    expect(AGENT_COLORS.map((color) => token(`agent-${color}`)?.toLowerCase())).toEqual(expected);
  });

  it('embeds Geist, Geist Mono and, for the terminals, JetBrains Mono without any network request', () => {
    const sources = [...css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map((m) => m[1] ?? '');
    expect(sources.length).toBeGreaterThanOrEqual(2);
    for (const source of sources) {
      expect(source).not.toMatch(/^(https?:)?\/\//);
      expect(existsSync(join(themeDir, source))).toBe(true);
    }
    expect(css).toMatch(/font-family:\s*['"]Geist['"]/);
    expect(css).toMatch(/font-family:\s*['"]Geist Mono['"]/);
    expect(css).toMatch(/font-family:\s*['"]JetBrains Mono['"]/);
  });

  it('uses Geist for the interface and JetBrains Mono for the terminals (R17)', () => {
    expect(token('font-ui')).toMatch(/^'Geist',/);
    expect(token('font-mono')).toMatch(/^'Geist Mono',/);
    expect(token('font-terminal')).toMatch(/^'JetBrains Mono',/);
  });

  it('ships the fonts with their SIL Open Font License', () => {
    expect(readFileSync(join(themeDir, 'fonts', 'OFL-Geist.txt'), 'utf8')).toContain(
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
