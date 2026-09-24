import { describe, expect, it } from 'vitest';
import { tabIndicator } from '../../../src/shared/tab-indicator';
import type { AgentState } from '../../../src/shared/model';

// T081 — ◆ while an agent waits for an answer, otherwise ✕ while one is in error (FR-030).

const agents = (...states: AgentState[]) => states.map((state) => ({ state }));

describe('tabIndicator', () => {
  it('shows ◆ when an agent waits for an answer, even with another in error', () => {
    expect(tabIndicator(agents('error', 'awaiting-answer'))).toBe('waiting');
  });

  it('shows ✕ when an agent is in error and none waits', () => {
    expect(tabIndicator(agents('working', 'error'))).toBe('error');
  });

  it('shows nothing otherwise', () => {
    expect(tabIndicator(agents('awaiting-prompt', 'working', 'done'))).toBeNull();
    expect(tabIndicator([])).toBeNull();
  });
});
