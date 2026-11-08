import { describe, expect, it } from 'vitest';
import { accountFolder, countsInAccount } from '../../../../src/main/agents/account';
import type { Agent } from '../../../../src/shared/model';

// 009 R7 — the account an agent counts in.

const agent = (state: Agent['state'], kind?: 'rate-limit' | 'crash') =>
  ({
    state,
    lastError: kind ? { code: null, kind, message: 'x' } : null,
  }) as unknown as Agent;

describe('accountFolder', () => {
  it('is the folder the variable names, for Claude Code and for Codex', () => {
    const env = { HOME: '/h', CLAUDE_CONFIG_DIR: '/comptes/a', CODEX_HOME: '/comptes/b' };
    expect(accountFolder(true, env)).toBe('/comptes/a');
    expect(accountFolder(false, env)).toBe('/comptes/b');
  });

  it('is nothing when the variable is not set, or names the CLI’s own folder', () => {
    expect(accountFolder(true, { HOME: '/h' })).toBeUndefined();
    expect(accountFolder(true, { HOME: '/h', CLAUDE_CONFIG_DIR: '/h/.claude' })).toBeUndefined();
    expect(accountFolder(false, { HOME: '/h', CODEX_HOME: '/h/.codex' })).toBeUndefined();
  });

  it('knows the CLI’s own folder written with a trailing slash', () => {
    expect(accountFolder(true, { HOME: '/h', CLAUDE_CONFIG_DIR: '/h/.claude/' })).toBeUndefined();
  });
});

describe('countsInAccount', () => {
  it.each(['starting', 'working', 'awaiting-prompt', 'awaiting-answer', 'done'] as const)(
    'counts an agent %s',
    (state) => {
      expect(countsInAccount(agent(state))).toBe(true);
    },
  );

  it('counts an agent in a rate limit error, not one that crashed', () => {
    expect(countsInAccount(agent('error', 'rate-limit'))).toBe(true);
    expect(countsInAccount(agent('error', 'crash'))).toBe(false);
    expect(countsInAccount(agent('error'))).toBe(false);
  });

  it('leaves out an agent that is closed or paused', () => {
    expect(countsInAccount(agent('closed'))).toBe(false);
    expect(countsInAccount(agent('paused'))).toBe(false);
  });
});
