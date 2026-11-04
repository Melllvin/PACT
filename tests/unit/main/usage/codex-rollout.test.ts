import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lastRolloutSample } from '../../../../src/main/usage/codex-rollout';

// 005 T007 — the token_count events of a Codex rollout (R2, contracts/sources.md).

const line = (rateLimits: unknown, usage: unknown = { input_tokens: 10, output_tokens: 5 }) =>
  JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: usage }, rate_limits: rateLimits },
  });

describe('lastRolloutSample', () => {
  it('reads the last token_count of the fixture, an unreadable line skipped', () => {
    expect(
      lastRolloutSample(readFileSync('tests/fixtures/usage/codex-rollout.jsonl', 'utf8')),
    ).toEqual({
      windows: [
        {
          id: 'five-hour',
          label: '5 h',
          usedPercent: 18,
          resetsAt: new Date(1793721600 * 1000).toISOString(),
          minutes: 300,
        },
        {
          id: 'week',
          label: 'semaine',
          usedPercent: 4,
          resetsAt: new Date(1794067200 * 1000).toISOString(),
          minutes: 10_080,
        },
      ],
      tokens: 12000 + 2500,
    });
  });

  it('names a window of another length in hours', () => {
    const text = line({ primary: { used_percent: 7, window_minutes: 120 } });
    expect(lastRolloutSample(text)?.windows).toEqual([
      { id: '120m', label: '2 h', usedPercent: 7, resetsAt: null, minutes: 120 },
    ]);
  });

  it('gives no limits when rate_limits is null, the tokens still', () => {
    expect(lastRolloutSample(line(null))).toEqual({ windows: null, tokens: 15 });
  });

  it('keeps the last limits when a later count has none', () => {
    const text = [
      line({ primary: { used_percent: 30, window_minutes: 300 } }),
      line(null, { input_tokens: 100, output_tokens: 1 }),
    ].join('\n');
    expect(lastRolloutSample(text)).toMatchObject({
      windows: [{ id: 'five-hour', usedPercent: 30 }],
      tokens: 101,
    });
  });

  it('is nothing without a token_count', () => {
    expect(lastRolloutSample('{"type":"session_meta","payload":{}}\n{coupée\n')).toBeNull();
    expect(lastRolloutSample('')).toBeNull();
  });
});
