import type { UsageThresholds } from '../../shared/usage';
import type { Stores } from '../persistence/store';
import type { UsageService } from '../usage/usage-service';

// 005 — the usage channels (contracts/ipc.md).

type Dependencies = {
  usage: Pick<UsageService, 'list' | 'setThresholds'>;
  stores: Pick<Stores, 'state'>;
};

export function createUsageServices({ usage, stores }: Dependencies) {
  return {
    'usage:get': () => usage.list(),
    'settings:usageThresholds': async (thresholds: UsageThresholds) => {
      const state = await stores.state.read();
      await stores.state.write({ ...state, usageThresholds: thresholds });
      usage.setThresholds(thresholds);
      return thresholds;
    },
  };
}
