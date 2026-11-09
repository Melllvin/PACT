import type { IpcInput } from '../../shared/ipc';
import type { UsageThresholds } from '../../shared/usage';
import type { Stores } from '../persistence/store';
import type { UsageLimitService } from '../usage/usage-limit-service';
import type { UsageService } from '../usage/usage-service';

// 005 — the usage channels (contracts/ipc.md).

type Dependencies = {
  usage: Pick<UsageService, 'list' | 'setThresholds'>;
  stores: Pick<Stores, 'state'>;
  /** 009 US2 — « Reprendre » and « Annuler la reprise » of a pause. */
  limit: Pick<UsageLimitService, 'resumeByHand' | 'cancelResume'>;
};

export function createUsageServices({ usage, stores, limit }: Dependencies) {
  return {
    'usage:get': () => usage.list(),
    'settings:usageThresholds': async (thresholds: UsageThresholds) => {
      const state = await stores.state.read();
      await stores.state.write({ ...state, usageThresholds: thresholds });
      usage.setThresholds(thresholds);
      return thresholds;
    },
    'usage:resume': ({ cliId, account }: IpcInput<'usage:resume'>) =>
      limit.resumeByHand(cliId, account),
    'usage:cancelResume': ({ cliId, account }: IpcInput<'usage:cancelResume'>) =>
      limit.cancelResume(cliId, account),
  };
}
