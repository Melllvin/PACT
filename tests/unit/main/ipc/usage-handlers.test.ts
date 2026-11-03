import { describe, expect, it, vi } from 'vitest';
import { createUsageServices } from '../../../../src/main/ipc/usage-handlers';

// 005 T021 — `settings:usageThresholds`: saved with the state, told to the gauges (FR-010).

describe('usage handlers', () => {
  it('saves the thresholds and hands them to the usage service', async () => {
    let saved: Record<string, unknown> = {
      recents: [],
      usageThresholds: { warn: 80, critical: 95 },
    };
    const stores = {
      state: {
        read: vi.fn(() => Promise.resolve(saved)),
        write: vi.fn((value: Record<string, unknown>) => {
          saved = value;
          return Promise.resolve();
        }),
      },
    };
    const usage = { list: vi.fn(() => []), setThresholds: vi.fn() };
    const services = createUsageServices({ usage, stores: stores as never });
    expect(await services['settings:usageThresholds']({ warn: 70, critical: 90 })).toEqual({
      warn: 70,
      critical: 90,
    });
    expect(saved).toEqual({ recents: [], usageThresholds: { warn: 70, critical: 90 } });
    expect(usage.setThresholds).toHaveBeenCalledWith({ warn: 70, critical: 90 });
    expect(services['usage:get']()).toEqual([]);
  });
});
