import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// 004 SC-007, 005 FR-005 — no test writes in the user's ~/.claude or ~/.codex: each test file runs
// with a home of its own, and fails if something was written in its .claude or .codex.

const home = mkdtempSync(join(tmpdir(), 'pact-home-'));
const real = { ...process.env };
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
process.env.CODEX_HOME = join(home, '.codex');

afterAll(() => {
  const written = ['.claude', '.codex'].filter((name) => existsSync(join(home, name)));
  rmSync(home, { recursive: true, force: true });
  for (const name of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    if (real[name] === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = real[name];
  }
  if (written.length > 0) {
    throw new Error(`Un test a écrit dans ${written.map((n) => `~/${n}`).join(' et ')}.`);
  }
});
