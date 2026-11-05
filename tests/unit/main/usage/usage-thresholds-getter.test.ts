import { describe, expect, it } from 'vitest';
import { UsageService } from '../../../../src/main/usage/usage-service';

// fix-todo-diff-notifications — the notifications of limits read the thresholds in force.

describe('UsageService.getThresholds', () => {
  it('gives the thresholds it was made with, then the new ones', () => {
    const usage = new UsageService({ thresholds: { warn: 70, critical: 90 } });
    expect(usage.getThresholds()).toEqual({ warn: 70, critical: 90 });
    usage.setThresholds({ warn: 60, critical: 85 });
    expect(usage.getThresholds()).toEqual({ warn: 60, critical: 85 });
  });
});
