import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStatusline } from '../../../../src/main/usage/claude-statusline';

// 005 T006 — the statusLine payload of Claude Code (R1, contracts/sources.md).

const fixture = (name: string) =>
  JSON.parse(readFileSync(`tests/fixtures/usage/${name}.json`, 'utf8')) as Record<string, unknown>;

describe('parseStatusline', () => {
  it('reads the 5 h and weekly windows, a window per model, and the tokens of the session', () => {
    expect(parseStatusline(fixture('claude-statusline'))).toEqual({
      windows: [
        {
          id: 'five-hour',
          label: '5 h',
          usedPercent: 62,
          resetsAt: new Date(1793721600 * 1000).toISOString(),
          minutes: 300,
        },
        {
          id: 'week',
          label: 'semaine',
          usedPercent: 18,
          resetsAt: new Date(1794067200 * 1000).toISOString(),
          minutes: 10_080,
        },
        {
          id: 'seven_day_opus',
          label: 'semaine · Opus',
          usedPercent: 40,
          resetsAt: new Date(1794067200 * 1000).toISOString(),
          minutes: 10_080,
        },
      ],
      tokens: 15234 + 4521,
    });
  });

  it('gives no limits for an API key, the tokens still', () => {
    expect(parseStatusline(fixture('claude-statusline-apikey'))).toEqual({
      windows: null,
      tokens: 15234 + 4521,
    });
  });

  it('skips a window without a percentage, keeps one without a reset time', () => {
    expect(
      parseStatusline({
        rate_limits: {
          five_hour: { resets_at: 1 },
          seven_day: { used_percentage: 104 },
          oddity: { used_percentage: 3 },
        },
      }),
    ).toEqual({
      windows: [
        { id: 'week', label: 'semaine', usedPercent: 104, resetsAt: null, minutes: 10_080 },
        { id: 'oddity', label: 'oddity', usedPercent: 3, resetsAt: null, minutes: null },
      ],
      tokens: 0,
    });
  });

  it.each([null, 'texte', 42, [], { rate_limits: 'x', context_window: 3 }])(
    'never throws on %j',
    (payload) => {
      expect(() => parseStatusline(payload)).not.toThrow();
    },
  );

  it('is nothing for what is not a payload', () => {
    expect(parseStatusline('texte')).toBeNull();
    expect(parseStatusline({ rate_limits: 'x' })).toEqual({ windows: null, tokens: 0 });
  });
});
