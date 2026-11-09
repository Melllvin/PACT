import { describe, expect, it } from 'vitest';
import { agentStateLabel } from '../../../src/shared/agents-view';
import type { Agent } from '../../../src/shared/model';

// 009 contracts/ui.md — the label of a pause whose resume time has gone by, or that names no window.

const now = new Date('2026-11-08T12:00:00.000Z');
const window = (label: string) => ({ id: label, label, percent: 91, resetsAt: null });
const paused = (over: Record<string, unknown>) =>
  ({
    state: 'paused',
    scheduledResume: null,
    pause: {
      cliId: 'claude-code',
      account: 'default',
      cause: 'threshold',
      windows: [window('5 h')],
      resumeAt: '2026-11-08T11:00:00.000Z',
      pausedAt: '2026-11-08T10:00:00.000Z',
      midTurn: false,
      saved: true,
      closedQuestion: null,
      blocked: null,
      ...over,
    },
  }) as unknown as Agent;

describe('agentStateLabel of a paused agent, other cases', () => {
  it('names the window when the planned resume has gone by', () => {
    const late = {
      ...paused({}),
      scheduledResume: { agentId: 'a', at: '2026-11-08T11:00:00.000Z', attempt: 0 },
    };
    expect(agentStateLabel(late, now)).toBe('en pause · 5 h');
  });

  it('names every window in cause', () => {
    expect(agentStateLabel(paused({ windows: [window('5 h'), window('semaine')] }), now)).toBe(
      'en pause · 5 h · semaine',
    );
  });

  it('says only « en pause » for a paused agent that has no pause', () => {
    expect(agentStateLabel({ ...paused({}), pause: null }, now)).toBe('en pause');
  });
});
