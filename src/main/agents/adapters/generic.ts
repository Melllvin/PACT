import { findExecutable, toSpawnCommand } from '../../env/resolve-command';
import { nextClockTime } from './shared';
import {
  pactEnv,
  type AgentSignal,
  type CliAdapter,
  type DetectionResult,
  type LaunchInput,
  type LaunchSpec,
  type OutputContext,
  type ResolvedEnv,
} from './types';

// contracts/cli-adapter.md « generic » — « Autre CLI » (FR-008): the command the user typed, run
// as is. No hook, no permission flag, no session: PACT follows it through its terminal only.

/** A question is only reported once the CLI has been quiet this long (research.md R4). */
export const IDLE_QUESTION_MS = 3000;

const QUESTION = /(\?|\(y\/n\))$/i;
/** Only plain wordings: an unknown CLI gives nothing else to go on (research.md, limite de débit). */
const RATE_LIMIT = /rate.?limit|usage limit|quota (?:exceeded|reached)|too many requests/i;
/** A CLI that retries on its own (aider, litellm) is waiting, not stuck. */
const RETRYING = /retry|retrying/i;
/** The CLI may print its prompt again below the message. */
const RATE_LIMIT_LINES = 3;

export class GenericAdapter implements CliAdapter {
  readonly id = 'generic';
  private readonly executable: string;
  private readonly args: string[];
  private readonly platform: NodeJS.Platform;
  private readonly now: () => Date;

  constructor({
    command,
    platform,
    now = () => new Date(),
  }: {
    /** As typed: the executable, then its own arguments (`aider --no-git`). */
    command: string;
    platform: NodeJS.Platform;
    now?: () => Date;
  }) {
    const [executable = '', ...args] = command.trim().split(/\s+/);
    this.executable = executable;
    this.args = args;
    this.platform = platform;
    this.now = now;
  }

  /** Found or not; its version is not read: `--version` may mean anything to an unknown CLI. */
  async detect(env: ResolvedEnv): Promise<DetectionResult> {
    const resolvedPath = await findExecutable(this.executable, env, this.platform);
    return { resolvedPath, version: null, status: resolvedPath ? 'installed' : 'missing' };
  }

  listModels(): Promise<string[]> {
    return Promise.resolve([]);
  }

  buildLaunch(input: LaunchInput): LaunchSpec {
    const command = toSpawnCommand(input.executablePath, this.args, this.platform, process.env);
    return { ...command, cwd: input.cwd, env: pactEnv(input) };
  }

  /** No session to resume: « Reprendre » runs the command again. */
  buildResume(input: LaunchInput & { sessionId: string }): LaunchSpec {
    return this.buildLaunch(input);
  }

  mapHookEvent(_payload: unknown): AgentSignal | null {
    return null;
  }

  mapOutput(chunk: string, { exitCode, idleMs }: OutputContext): AgentSignal | null {
    if (exitCode !== undefined) {
      return exitCode === 0
        ? { type: 'turn-finished' }
        : {
            type: 'failed',
            kind: 'crash',
            message: `Le processus s’est arrêté (code ${String(exitCode)}).`,
          };
    }
    if (idleMs === undefined || idleMs < IDLE_QUESTION_MS) return null;
    const lines = chunk
      .trimEnd()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const limit = lines
      .slice(-RATE_LIMIT_LINES)
      .findLast((line) => RATE_LIMIT.test(line) && !RETRYING.test(line));
    if (limit) {
      const resetAt = this.parseRateLimitReset(limit);
      return {
        type: 'failed',
        kind: 'rate-limit',
        message: limit,
        ...(resetAt ? { resetAt } : {}),
      };
    }
    const lastLine = lines.at(-1) ?? '';
    return QUESTION.test(lastLine) ? { type: 'awaiting-answer', summary: lastLine } : null;
  }

  answerKeys(answer: 'allow' | 'deny'): string {
    return answer === 'allow' ? 'y\r' : 'n\r';
  }

  parseRateLimitReset(text: string): Date | null {
    return nextClockTime(text, /(?:try again at|resets(?: at)?)/i, this.now());
  }
}
