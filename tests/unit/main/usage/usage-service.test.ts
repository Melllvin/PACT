import { describe, expect, it, vi } from 'vitest';
import type { UsageSample } from '../../../../src/main/usage/sample';
import {
  accountOf,
  UsageService,
  type UsageSource,
} from '../../../../src/main/usage/usage-service';
import type { UsageState } from '../../../../src/shared/usage';

// 005 T010 — one reading per account, the latest replacing the previous (R3).

const source = (over: Partial<UsageSource> = {}): UsageSource => ({
  agentId: 'a1',
  workspaceId: 'w1',
  label: 'Claude Code 1',
  role: null,
  cliId: 'claude-code',
  account: 'default',
  ...over,
});
const sample = (percent: number, tokens = 0): UsageSample => ({
  windows: [{ id: 'five-hour', label: '5 h', usedPercent: percent, resetsAt: null, minutes: 300 }],
  tokens,
});

function service() {
  let now = new Date('2026-11-03T14:00:00.000Z');
  const states: UsageState[] = [];
  const usage = new UsageService({
    now: () => now,
    onState: (state) => states.push(state),
  });
  return {
    usage,
    states,
    later: (minutes: number) => {
      now = new Date(now.getTime() + minutes * 60_000);
    },
  };
}

describe('UsageService', () => {
  it('keeps one reading per account, the latest replacing the previous', () => {
    const { usage, states, later } = service();
    usage.record(source(), sample(40));
    later(1);
    usage.record(source({ agentId: 'a2', workspaceId: 'w2' }), sample(45));
    usage.record(source({ account: '/autre/.claude' }), sample(5));
    usage.record(source({ cliId: 'codex' }), sample(10));
    expect(
      usage.list().map((s) => [s.cliId, s.account, s.reading?.windows[0]?.usedPercent]),
    ).toEqual([
      ['claude-code', 'default', 45],
      ['claude-code', '/autre/.claude', 5],
      ['codex', 'default', 10],
    ]);
    expect(states[1]).toEqual({
      cliId: 'claude-code',
      account: 'default',
      reading: {
        cliId: 'claude-code',
        account: 'default',
        windows: sample(45).windows,
        readAt: '2026-11-03T14:01:00.000Z',
      },
      shares: [],
      level: 'ok',
    });
  });

  it('keeps the last reading when a sample has no limits, without an event', () => {
    const { usage, states } = service();
    usage.record(source(), sample(40));
    usage.record(source(), { windows: null, tokens: 10 });
    expect(states).toHaveLength(1);
    expect(usage.list()[0]?.reading?.windows[0]?.usedPercent).toBe(40);
  });

  it('gives the level of the window shown', () => {
    const { usage } = service();
    usage.record(source(), sample(85));
    expect(usage.list()[0]?.level).toBe('warn');
    usage.record(source(), sample(97));
    expect(usage.list()[0]?.level).toBe('critical');
  });

  it('answers a statusLine payload with the line of the terminal, and records it', () => {
    const { usage } = service();
    expect(usage.statusLine(source(), { context_window: {} })).toBe('PACT');
    expect(
      usage.statusLine(source(), {
        rate_limits: {
          five_hour: { used_percentage: 61.6, resets_at: 1793721600 },
          seven_day: { used_percentage: 18, resets_at: 1794067200 },
        },
      }),
    ).toBe('PACT · 5 h 62 %');
    expect(usage.list()[0]?.reading?.windows).toHaveLength(2);
    // Garbage: nothing recorded, nothing thrown, the last reading still told.
    expect(usage.statusLine(source(), 'texte')).toBe('PACT · 5 h 62 %');
  });

  it('follows the rollout of a Codex agent until released', () => {
    const { usage } = service();
    const started: string[] = [];
    let push: ((s: UsageSample) => void) | undefined;
    const stop = vi.fn();
    const followed = new UsageService({
      followRollout: ({ codexHome, sessionId, onSample }) => {
        started.push(`${codexHome}|${sessionId}`);
        push = onSample;
        return { start: vi.fn(), stop };
      },
    });
    const codex = source({ cliId: 'codex', label: 'Codex 1' });
    followed.follow(codex, { codexHome: '/h/.codex', sessionId: 's-1' });
    push?.(sample(30));
    expect(followed.list()[0]).toMatchObject({ cliId: 'codex', reading: { windows: [{}] } });
    expect(started).toEqual(['/h/.codex|s-1']);
    // A new session of the same agent replaces the follower.
    followed.follow(codex, { codexHome: '/h/.codex', sessionId: 's-2' });
    expect(stop).toHaveBeenCalledTimes(1);
    followed.stop();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(usage.list()).toEqual([]);
  });

  it('names the account after the configuration folder, default without one', () => {
    expect(accountOf(undefined)).toBe('default');
    expect(accountOf('')).toBe('default');
    expect(accountOf('/Users/a/.claude-work')).toBe('/Users/a/.claude-work');
  });
});
