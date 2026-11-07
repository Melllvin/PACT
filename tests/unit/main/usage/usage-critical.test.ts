import { describe, expect, it } from 'vitest';
import { UsageService, type UsageSource } from '../../../../src/main/usage/usage-service';

// 007 FR-016, R7 — « critical »: an account of the CLI is at its critical level, the wakes wait.

const source = (over: Partial<UsageSource> = {}): UsageSource => ({
  agentId: 'a1',
  workspaceId: 'w1',
  label: 'Claude Code 1',
  role: null,
  cliId: 'claude-code',
  account: 'default',
  ...over,
});
const sample = (percent: number) => ({
  windows: [{ id: 'five-hour', label: '5 h', usedPercent: percent, resetsAt: null, minutes: 300 }],
  tokens: 0,
});

describe('UsageService.critical', () => {
  const usage = () => new UsageService({ now: () => new Date('2026-11-06T10:00:00.000Z') });

  it('is false without any reading', () => {
    expect(usage().critical('claude-code')).toBe(false);
  });

  it('is true when an account of the CLI is at the critical level, and only for that CLI', () => {
    const service = usage();
    service.record(source(), sample(97));
    expect(service.critical('claude-code')).toBe(true);
    expect(service.critical('codex')).toBe(false);
  });

  it('is false below the critical level', () => {
    const service = usage();
    service.record(source(), sample(85));
    expect(service.critical('claude-code')).toBe(false);
  });
});
