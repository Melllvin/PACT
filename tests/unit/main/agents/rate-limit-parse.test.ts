import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../../../src/main/agents/adapters/claude-code';
import { CodexAdapter } from '../../../../src/main/agents/adapters/codex';
import type { CommandRunner } from '../../../../src/main/agents/adapters/types';

// T104 — US7: the reset time read in the rate-limit messages of Claude Code and Codex (T049),
// as the next such local time.

const bridge = { executable: '/Applications/PACT.app/Contents/MacOS/PACT', script: '/app/hook.js' };
const run: CommandRunner = () => Promise.resolve('');
const now = new Date(2026, 8, 24, 14, 20);

const claude = new ClaudeCodeAdapter({ platform: 'darwin', bridge, run, now: () => now });
const codex = new CodexAdapter({ platform: 'darwin', bridge, run, now: () => now });

describe('parseRateLimitReset', () => {
  it('Claude Code: « resets 3pm », « resets at 9:30am », later today or tomorrow', () => {
    expect(claude.parseRateLimitReset("You've hit your limit · resets 3pm")).toEqual(
      new Date(2026, 8, 24, 15, 0),
    );
    expect(claude.parseRateLimitReset('5-hour limit reached ∙ resets at 9:30am')).toEqual(
      new Date(2026, 8, 25, 9, 30),
    );
    expect(claude.parseRateLimitReset('resets 2:20pm')).toEqual(new Date(2026, 8, 25, 14, 20));
  });

  it('Codex: « Try again at 3:45 PM », upper case, noon and midnight', () => {
    expect(codex.parseRateLimitReset("You've hit your usage limit. Try again at 3:45 PM.")).toEqual(
      new Date(2026, 8, 24, 15, 45),
    );
    expect(codex.parseRateLimitReset('Try again at 12 PM')).toEqual(new Date(2026, 8, 25, 12, 0));
    expect(codex.parseRateLimitReset('Try again at 12:05 AM')).toEqual(new Date(2026, 8, 25, 0, 5));
  });

  it('gives nothing without a time', () => {
    expect(claude.parseRateLimitReset("You've hit your limit")).toBeNull();
    expect(codex.parseRateLimitReset("You've hit your usage limit. Try again later.")).toBeNull();
    expect(codex.parseRateLimitReset('')).toBeNull();
  });
});
