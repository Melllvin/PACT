import { describe, expect, it } from 'vitest';
import { detectTestCommand, passedCount, tail } from '../../../../src/main/review/test-runner';

// 002 T028 — the test command of a worktree and the reading of its output (research R8).

const NPM_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';

describe('detectTestCommand', () => {
  const pkg = (test?: string) => JSON.stringify({ name: 'app', scripts: test ? { test } : {} });

  it('runs the test script with the package manager of the lockfile', () => {
    expect(detectTestCommand(pkg('vitest run'), [])).toBe('npm test');
    expect(detectTestCommand(pkg('vitest run'), ['package-lock.json'])).toBe('npm test');
    expect(detectTestCommand(pkg('vitest run'), ['pnpm-lock.yaml'])).toBe('pnpm test');
    expect(detectTestCommand(pkg('jest'), ['yarn.lock'])).toBe('yarn test');
  });

  it('finds nothing without a test script, with npm’s placeholder, or without package.json', () => {
    expect(detectTestCommand(pkg(), [])).toBeNull();
    expect(detectTestCommand(pkg(NPM_PLACEHOLDER), [])).toBeNull();
    expect(detectTestCommand(null, ['yarn.lock'])).toBeNull();
    expect(detectTestCommand('{ pas du json', [])).toBeNull();
    expect(detectTestCommand('[]', [])).toBeNull();
  });
});

describe('passedCount', () => {
  it('reads the summary of Vitest and Jest', () => {
    expect(passedCount(' Test Files  3 passed (3)\n      Tests  24 passed (24)\n')).toBe(24);
    expect(passedCount('      Tests  1 failed | 23 passed (24)\n')).toBe(23);
    expect(passedCount('Tests:       24 passed, 24 total\n')).toBe(24);
    expect(passedCount('Tests:       1 failed, 23 passed, 24 total\n')).toBe(23);
  });

  it('reads the summary of pytest', () => {
    expect(passedCount('============ 12 passed in 0.31s ============\n')).toBe(12);
    expect(passedCount('====== 1 failed, 11 passed in 0.40s ======\n')).toBe(11);
  });

  it('adds up the results of cargo test, one per crate', () => {
    expect(
      passedCount(
        'test result: ok. 7 passed; 0 failed; 0 ignored\n' +
          'test result: ok. 2 passed; 0 failed; 0 ignored\n',
      ),
    ).toBe(9);
  });

  it('gives nothing for an output it does not know', () => {
    expect(passedCount('ok\n')).toBeNull();
  });
});

describe('tail', () => {
  it('keeps the last lines only', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `ligne ${String(i + 1)}`);
    const kept = tail(`${lines.join('\n')}\n`, 200).split('\n');
    expect(kept[0]).toBe('ligne 51');
    expect(kept.at(-1)).toBe('');
    expect(kept).toHaveLength(201);
    expect(tail('court\n', 200)).toBe('court\n');
  });
});
