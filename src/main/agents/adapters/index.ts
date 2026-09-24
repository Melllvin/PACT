import { FakeAdapter } from './fake';
import type { CliAdapter } from './types';

/**
 * Adapters available on this machine. Claude Code and Codex arrive with US2 (T058, T059); the
 * fake one exists only in test mode, pointed at the fake CLI by the e2e harness.
 */
export function createAdapters({
  env,
  platform,
}: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
}): CliAdapter[] {
  const adapters: CliAdapter[] = [];
  if (env.PACT_TEST_MODE === '1' && env.PACT_FAKE_CLI) {
    adapters.push(new FakeAdapter({ cliPath: env.PACT_FAKE_CLI, platform }));
  }
  return adapters;
}
