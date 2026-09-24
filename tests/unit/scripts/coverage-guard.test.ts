import { describe, expect, it } from 'vitest';
import { findRegressions, type CoverageSummary } from '../../../scripts/coverage-guard.ts';

const metric = (pct: number) => ({ total: 10, covered: pct / 10, skipped: 0, pct });
const entry = (lines: number, branches: number) => ({
  lines: metric(lines),
  branches: metric(branches),
  statements: metric(lines),
  functions: metric(100),
});

const summary = (root: string, files: Record<string, [number, number]>): CoverageSummary => ({
  total: entry(0, 0),
  ...Object.fromEntries(
    Object.entries(files).map(([file, [lines, branches]]) => [
      `${root}/${file}`,
      entry(lines, branches),
    ]),
  ),
});

describe('findRegressions', () => {
  it('accepts equal or better coverage', () => {
    const base = summary('/base', { 'src/a.ts': [90, 80] });
    const head = summary('/head', { 'src/a.ts': [95, 80] });
    expect(findRegressions(base, '/base', head, '/head')).toEqual([]);
  });

  it('reports a file whose line or branch coverage dropped', () => {
    const base = summary('/base', { 'src/a.ts': [90, 80], 'src/b.ts': [100, 100] });
    const head = summary('/head', { 'src/a.ts': [90, 75], 'src/b.ts': [99, 100] });
    expect(findRegressions(base, '/base', head, '/head')).toEqual([
      { file: 'src/a.ts', metric: 'branches', base: 80, head: 75 },
      { file: 'src/b.ts', metric: 'lines', base: 100, head: 99 },
    ]);
  });

  it('matches files across checkouts and Windows separators', () => {
    const base = summary('C:\\base', { 'src\\a.ts': [90, 80] });
    const head = summary('D:\\work\\head', { 'src\\a.ts': [80, 80] });
    expect(findRegressions(base, 'C:\\base', head, 'D:\\work\\head')).toEqual([
      { file: 'src/a.ts', metric: 'lines', base: 90, head: 80 },
    ]);
  });

  it('ignores new and deleted files (new files are held by the fixed thresholds)', () => {
    const base = summary('/base', { 'src/old.ts': [100, 100] });
    const head = summary('/head', { 'src/new.ts': [10, 10] });
    expect(findRegressions(base, '/base', head, '/head')).toEqual([]);
  });

  it('ignores the aggregate total entry', () => {
    const base = { ...summary('/base', {}), total: entry(100, 100) };
    const head = { ...summary('/head', {}), total: entry(50, 50) };
    expect(findRegressions(base, '/base', head, '/head')).toEqual([]);
  });
});
