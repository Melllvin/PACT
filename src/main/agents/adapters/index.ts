import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toSpawnCommand } from '../../env/resolve-command';
import { ClaudeCodeAdapter } from './claude-code';
import { CodexAdapter } from './codex';
import { FakeAdapter } from './fake';
import type { CliAdapter, CommandRunner, HookBridge, ResolvedEnv } from './types';

const DETECTION_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

/** Runs a detection command (`--version`, `--help`…) and resolves with its standard output. */
export async function runCommand(
  file: string,
  args: string[],
  env: ResolvedEnv,
  platform: NodeJS.Platform,
): Promise<string> {
  const command = toSpawnCommand(file, args, platform, env);
  const { stdout } = await execFileAsync(command.file, command.args, {
    env,
    encoding: 'utf8',
    timeout: DETECTION_TIMEOUT_MS,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  });
  return stdout;
}

/**
 * Adapters available on this machine. In test mode only the fake one, pointed at the fake CLI by
 * the e2e harness: e2e runs never depend on the CLIs installed where they run.
 */
export function createAdapters({
  env,
  platform,
  bridge,
  run = (file, args, commandEnv) => runCommand(file, args, commandEnv, platform),
}: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  bridge: HookBridge;
  run?: CommandRunner;
}): CliAdapter[] {
  if (env.PACT_TEST_MODE === '1') {
    return env.PACT_FAKE_CLI ? [new FakeAdapter({ cliPath: env.PACT_FAKE_CLI, platform })] : [];
  }
  return [
    new ClaudeCodeAdapter({ platform, bridge, run }),
    new CodexAdapter({ platform, bridge, run }),
  ];
}
