import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '../../shared/model';

// 009 R7 — which usage account an agent counts in.

/**
 * The configuration folder that names an account (005 R3): `undefined` for the CLI's own folder,
 * whether the variable names it or not, so that the account is `default` either way.
 */
export function accountFolder(
  claude: boolean,
  env: Record<string, string | undefined>,
): string | undefined {
  const own = join(env.HOME || homedir(), claude ? '.claude' : '.codex');
  const set = claude ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME;
  return set === own ? undefined : set;
}

/** Closed and paused agents are out, and so are those that crashed; a rate limit error stays. */
export const countsInAccount = (agent: Agent): boolean =>
  agent.state !== 'closed' &&
  agent.state !== 'paused' &&
  (agent.state !== 'error' || agent.lastError?.kind === 'rate-limit');
