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
    const services = createUsageServices({ usage, stores: stores as never, limit: {} as never });
    expect(await services['settings:usageThresholds']({ warn: 70, critical: 90 })).toEqual({
      warn: 70,
      critical: 90,
    });
    expect(saved).toEqual({ recents: [], usageThresholds: { warn: 70, critical: 90 } });
    expect(usage.setThresholds).toHaveBeenCalledWith({ warn: 70, critical: 90 });
    expect(services['usage:get']()).toEqual([]);
  });
});

// 009 T030 — US2: `usage:resume` and `usage:cancelResume` (contracts/ui.md « IPC »).
//
// API fixed here for the dev (see the report, « API fixées »): `createUsageServices` takes a third
// dependency, `limit`, the `UsageLimitService`, of which it uses
//   resumeByHand(cliId, account): Promise<void>     « Reprendre » of À faire: resumes the account, override of the account
//   cancelResume(cliId, account): Promise<void>     « Annuler la reprise »
// and serves, with no answer (`void`):
//   'usage:resume'        { cliId, account }
//   'usage:cancelResume'  { cliId, account }

type ResumeChannels = Record<
  'usage:resume' | 'usage:cancelResume',
  (input: { cliId: string; account: string }) => Promise<void>
>;

describe('usage handlers: the resume (009 US2)', () => {
  const build = () => {
    const limit = {
      resumeByHand: vi.fn(() => Promise.resolve()),
      cancelResume: vi.fn(() => Promise.resolve()),
    };
    const services = createUsageServices({
      usage: { list: vi.fn(() => []), setThresholds: vi.fn() },
      stores: { state: { read: vi.fn(), write: vi.fn() } } as never,
      limit,
    }) as unknown as ResumeChannels;
    return { limit, services };
  };

  it('Given a paused account, When the renderer asks usage:resume, Then the service resumes that account and the answer is void', async () => {
    const { limit, services } = build();
    await expect(
      services['usage:resume']({ cliId: 'claude-code', account: '/comptes/a' }),
    ).resolves.toBeUndefined();
    expect(limit.resumeByHand).toHaveBeenCalledExactlyOnceWith('claude-code', '/comptes/a');
    expect(limit.cancelResume).not.toHaveBeenCalled();
  });

  it('Given scheduled resumes, When the renderer asks usage:cancelResume, Then the service cancels that account and the answer is void', async () => {
    const { limit, services } = build();
    await expect(
      services['usage:cancelResume']({ cliId: 'codex', account: 'default' }),
    ).resolves.toBeUndefined();
    expect(limit.cancelResume).toHaveBeenCalledExactlyOnceWith('codex', 'default');
    expect(limit.resumeByHand).not.toHaveBeenCalled();
  });

  it('Given the service fails, When the renderer asks usage:resume, Then the error reaches the renderer', async () => {
    const { limit, services } = build();
    limit.resumeByHand.mockRejectedValueOnce(new Error('boom'));
    await expect(services['usage:resume']({ cliId: 'claude-code', account: 'a' })).rejects.toThrow(
      'boom',
    );
  });
});

// 009 T038 — US3: `usage:stale` (contracts/ui.md « IPC »).
//
// API fixed here for the dev: `createUsageServices` uses a third method of `limit`,
//   decideStale(cliId, account, decision): Promise<void>   « Arrêter par prudence » ('stop') / « Pas maintenant » ('later')
// and serves, with no answer (`void`):
//   'usage:stale'  { cliId, account, decision: 'stop' | 'later' }

type StaleChannel = {
  'usage:stale': (input: {
    cliId: string;
    account: string;
    decision: 'stop' | 'later';
  }) => Promise<void>;
};

describe('usage handlers: the offer of a stop by caution (009 US3)', () => {
  const build = () => {
    const limit = {
      resumeByHand: vi.fn(() => Promise.resolve()),
      cancelResume: vi.fn(() => Promise.resolve()),
      decideStale: vi.fn(() => Promise.resolve()),
    };
    const services = createUsageServices({
      usage: { list: vi.fn(() => []), setThresholds: vi.fn() },
      stores: { state: { read: vi.fn(), write: vi.fn() } } as never,
      limit,
    }) as unknown as StaleChannel;
    return { limit, services };
  };

  it.each(['stop', 'later'] as const)(
    'Given an offer, When the renderer answers %s on usage:stale, Then the service decides for that account and the answer is void',
    async (decision) => {
      const { limit, services } = build();
      await expect(
        services['usage:stale']({ cliId: 'claude-code', account: '/comptes/a', decision }),
      ).resolves.toBeUndefined();
      expect(limit.decideStale).toHaveBeenCalledExactlyOnceWith(
        'claude-code',
        '/comptes/a',
        decision,
      );
      expect(limit.resumeByHand).not.toHaveBeenCalled();
    },
  );

  it('Given the service fails, When the renderer answers usage:stale, Then the error reaches the renderer', async () => {
    const { limit, services } = build();
    limit.decideStale.mockRejectedValueOnce(new Error('boom'));
    await expect(
      services['usage:stale']({ cliId: 'claude-code', account: 'a', decision: 'stop' }),
    ).rejects.toThrow('boom');
  });
});
