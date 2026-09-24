// Constitution III: coverage must never decrease from one PR to the next.
// Compares two Vitest `json-summary` reports (base branch vs pull request) file by file.
// Usage: node --experimental-strip-types scripts/coverage-guard.ts <baseSummary> <baseRoot> <headSummary> <headRoot>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Metric = { total: number; covered: number; skipped: number; pct: number };
type FileCoverage = Record<'lines' | 'branches' | 'statements' | 'functions', Metric>;
export type CoverageSummary = Record<string, FileCoverage>;
export type Regression = { file: string; metric: 'lines' | 'branches'; base: number; head: number };

const GUARDED_METRICS = ['lines', 'branches'] as const;

const byRelativePath = (summary: CoverageSummary, root: string) => {
  const prefix = root.normalize('NFC').replaceAll('\\', '/').replace(/\/?$/, '/');
  const files = new Map<string, FileCoverage>();
  for (const [path, coverage] of Object.entries(summary)) {
    if (path === 'total') continue;
    const normalized = path.normalize('NFC').replaceAll('\\', '/');
    files.set(
      normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized,
      coverage,
    );
  }
  return files;
};

export function findRegressions(
  base: CoverageSummary,
  baseRoot: string,
  head: CoverageSummary,
  headRoot: string,
): Regression[] {
  const baseFiles = byRelativePath(base, baseRoot);
  const regressions: Regression[] = [];
  for (const [file, coverage] of [...byRelativePath(head, headRoot)].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const before = baseFiles.get(file);
    if (!before) continue;
    for (const metric of GUARDED_METRICS) {
      if (coverage[metric].pct < before[metric].pct) {
        regressions.push({ file, metric, base: before[metric].pct, head: coverage[metric].pct });
      }
    }
  }
  return regressions;
}

function main([baseSummary, baseRoot, headSummary, headRoot]: string[]) {
  if (!baseSummary || !baseRoot || !headSummary || !headRoot) {
    console.error('usage: coverage-guard <baseSummary> <baseRoot> <headSummary> <headRoot>');
    return 2;
  }
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as CoverageSummary;
  const regressions = findRegressions(read(baseSummary), baseRoot, read(headSummary), headRoot);
  for (const r of regressions) {
    console.error(
      `::error file=${r.file}::${r.metric} coverage dropped from ${String(r.base)}% to ${String(r.head)}%`,
    );
  }
  if (regressions.length === 0) console.log('Coverage did not decrease on any existing file.');
  return regressions.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
