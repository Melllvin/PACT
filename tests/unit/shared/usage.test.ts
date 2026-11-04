import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USAGE_THRESHOLDS,
  agentShareSchema,
  currentWindow,
  launchWarning,
  levelNow,
  readingAge,
  shownWindow,
  usageLevel,
  usageReadingSchema,
  usageStateSchema,
  usageThresholdsSchema,
  usageWindowSchema,
  type UsageReading,
  type UsageState,
  type UsageWindow,
  workspaceShares,
} from '../../../src/shared/usage';

// 005 T003 — the usage of a CLI account and what the gauge derives from it (data-model.md, R4, R6).

const NOW = new Date('2026-11-03T14:00:00.000Z');
const window = (over: Partial<UsageWindow> = {}): UsageWindow => ({
  id: 'five-hour',
  label: '5 h',
  usedPercent: 62,
  resetsAt: '2026-11-03T16:40:00.000Z',
  minutes: 300,
  ...over,
});
const reading = (windows: UsageWindow[], readAt = NOW.toISOString()): UsageReading => ({
  cliId: 'claude-code',
  account: 'default',
  windows,
  readAt,
});

describe('usage schemas', () => {
  it('accepts a reading with a window over 100 %', () => {
    expect(usageReadingSchema.parse(reading([window({ usedPercent: 104 })])).windows[0]).toEqual(
      window({ usedPercent: 104 }),
    );
  });

  it('refuses a negative percentage, a reading with no window or a bad date', () => {
    expect(usageWindowSchema.safeParse(window({ usedPercent: -1 })).success).toBe(false);
    expect(usageReadingSchema.safeParse(reading([])).success).toBe(false);
    expect(usageWindowSchema.safeParse(window({ resetsAt: 'demain' })).success).toBe(false);
  });

  it('describes the share of an agent and the state of an account', () => {
    const share = {
      agentId: '7c1e8f7a-2b54-4e1c-9d1e-0b6f6d2b8a11',
      workspaceId: 'abc123',
      label: 'Claude Code 2',
      role: 'dev' as const,
      tokens: 1200,
      closed: false,
    };
    expect(agentShareSchema.parse(share)).toEqual(share);
    expect(agentShareSchema.safeParse({ ...share, role: null }).success).toBe(true);
    const state = {
      cliId: 'codex',
      account: 'default',
      reading: null,
      shares: [share],
      level: 'ok' as const,
    };
    expect(usageStateSchema.parse(state)).toEqual(state);
    expect(usageStateSchema.safeParse({ ...state, level: 'alerte' }).success).toBe(false);
  });

  it('keeps the thresholds whole, between 1 and 100, warn below critical', () => {
    expect(usageThresholdsSchema.parse(DEFAULT_USAGE_THRESHOLDS)).toEqual({
      warn: 80,
      critical: 95,
    });
    for (const bad of [
      { warn: 95, critical: 95 },
      { warn: 0, critical: 50 },
      { warn: 50, critical: 101 },
      { warn: 50.5, critical: 90 },
    ]) {
      expect(usageThresholdsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('usageLevel', () => {
  it.each([
    [0, 'ok'],
    [79.9, 'ok'],
    [80, 'warn'],
    [94, 'warn'],
    [95, 'critical'],
    [130, 'critical'],
  ] as const)('%d %% is %s', (percent, level) => {
    expect(usageLevel(percent, DEFAULT_USAGE_THRESHOLDS)).toBe(level);
  });

  it('follows the thresholds set by the user', () => {
    expect(usageLevel(60, { warn: 50, critical: 70 })).toBe('warn');
  });
});

describe('currentWindow', () => {
  it('keeps a window that is not reset yet', () => {
    expect(currentWindow(window(), NOW)).toEqual({ ...window(), reset: false });
  });

  it('shows a window whose reset time has passed as reset, at 0 %', () => {
    const past = window({ resetsAt: '2026-11-03T13:59:00.000Z' });
    expect(currentWindow(past, NOW)).toEqual({ ...past, usedPercent: 0, reset: true });
  });

  it('keeps a window with no reset time', () => {
    expect(currentWindow(window({ resetsAt: null }), NOW).reset).toBe(false);
  });
});

describe('shownWindow', () => {
  const week = window({ id: 'week', label: 'semaine', usedPercent: 18, minutes: 10_080 });

  it('shows the window used the most', () => {
    expect(shownWindow(reading([week, window()]), NOW).id).toBe('five-hour');
    expect(shownWindow(reading([window({ usedPercent: 10 }), week]), NOW).id).toBe('week');
  });

  it('shows the shortest window when two are used as much', () => {
    expect(shownWindow(reading([{ ...week, usedPercent: 62 }, window()]), NOW).id).toBe(
      'five-hour',
    );
  });

  it('puts a window of unknown length after the others at equal use', () => {
    const model = window({ id: 'seven_day_opus', label: 'semaine · Opus', minutes: null });
    expect(shownWindow(reading([model, window()]), NOW).id).toBe('five-hour');
  });

  it('compares the windows as they are now, a reset one at 0 %', () => {
    const reset = window({ usedPercent: 90, resetsAt: '2026-11-03T13:00:00.000Z' });
    expect(shownWindow(reading([reset, week]), NOW).id).toBe('week');
  });
});

describe('readingAge', () => {
  const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

  it('is fresh up to 15 minutes', () => {
    expect(readingAge(reading([window()], at(15)), NOW)).toEqual({
      minutes: 15,
      stale: false,
      hidden: false,
    });
  });

  it('is stale after 15 minutes and hidden after 60', () => {
    expect(readingAge(reading([window()], at(20)), NOW)).toEqual({
      minutes: 20,
      stale: true,
      hidden: false,
    });
    expect(readingAge(reading([window()], at(61)), NOW).hidden).toBe(true);
  });
});

// 005 T020 — the warning of a launch, the same for the launcher and launch_agent (FR-012).
describe('launchWarning', () => {
  const NOW = new Date('2026-11-03T14:00:00');
  const state = (cliId: string, percent: number, account = 'default'): UsageState => ({
    cliId,
    account,
    reading: {
      cliId,
      account,
      readAt: NOW.toISOString(),
      windows: [
        {
          id: 'five-hour',
          label: '5 h',
          usedPercent: percent,
          resetsAt: new Date('2026-11-03T16:40:00').toISOString(),
          minutes: 300,
        },
      ],
    },
    shares: [],
    level: 'ok',
  });
  const thresholds = { warn: 80, critical: 95 };

  it('warns with the window, the percentage and the reset time, from the first threshold', () => {
    expect(launchWarning([state('claude-code', 85)], 'claude-code', thresholds, NOW)).toBe(
      'Limite 5 h à 85 % : ces agents risquent de s’arrêter avant 16:40',
    );
    expect(launchWarning([state('claude-code', 79)], 'claude-code', thresholds, NOW)).toBeNull();
    expect(launchWarning([state('codex', 90)], 'claude-code', thresholds, NOW)).toBeNull();
  });

  it('takes the account nearest its limit, and says « sa réinitialisation » without a time', () => {
    const unknown = state('claude-code', 96, '/autre');
    const window = unknown.reading?.windows[0];
    if (window) window.resetsAt = null;
    expect(launchWarning([state('claude-code', 85), unknown], 'claude-code', thresholds, NOW)).toBe(
      'Limite 5 h à 96 % : ces agents risquent de s’arrêter avant sa réinitialisation',
    );
  });

  it('forgets a reading older than an hour', () => {
    const old = state('claude-code', 90);
    if (old.reading) old.reading.readAt = new Date('2026-11-03T12:30:00').toISOString();
    expect(launchWarning([old], 'claude-code', thresholds, NOW)).toBeNull();
    expect(levelNow(old, thresholds, NOW)).toBe('ok');
  });
});

describe('workspaceShares (005 US3)', () => {
  const share = (agentId: string, workspaceId: string, tokens: number, over = {}) => ({
    agentId,
    workspaceId,
    label: agentId,
    role: null,
    tokens,
    closed: false,
    ...over,
  });

  it('gives the part of each agent of the workspace, the largest first, then the others', () => {
    expect(
      workspaceShares(
        [
          share('a', 'w1', 100),
          share('b', 'w2', 300),
          share('c', 'w1', 500, { role: 'dev', closed: true }),
          share('d', 'w2', 100),
        ],
        'w1',
      ),
    ).toEqual({
      agents: [
        { agentId: 'c', label: 'c', role: 'dev', closed: true, percent: 50 },
        { agentId: 'a', label: 'a', role: null, closed: false, percent: 10 },
      ],
      others: 40,
    });
  });

  it('has no parts before any token is counted', () => {
    expect(workspaceShares([share('a', 'w1', 0)], 'w1')).toBeNull();
    expect(workspaceShares([], 'w1')).toBeNull();
  });

  it('has no others when every agent is of the workspace', () => {
    expect(workspaceShares([share('a', 'w1', 10)], 'w1')?.others).toBe(0);
  });
});
