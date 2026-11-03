import type { UsageService } from '../usage/usage-service';

// 005 — the usage channels (contracts/ipc.md).

type Dependencies = { usage: Pick<UsageService, 'list'> };

export function createUsageServices({ usage }: Dependencies) {
  return {
    'usage:get': () => usage.list(),
  };
}
