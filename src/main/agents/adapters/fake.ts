import { randomUUID } from 'node:crypto';
import { toSpawnCommand } from '../../env/resolve-command';
import {
  agentSignalSchema,
  pactEnv,
  supportedLevel,
  type AgentSignal,
  type CliAdapter,
  type DetectionResult,
  type LaunchInput,
  type LaunchSpec,
  type OutputContext,
  type ResolvedEnv,
} from './types';

/**
 * Drives tests/fixtures/fake-cli (research.md R13). Only registered in test mode; it runs the
 * fake CLI script with the app's own executable (Electron in Node mode, or Node in tests).
 */
export class FakeAdapter implements CliAdapter {
  readonly id = 'fake';
  private readonly cliPath: string;
  private readonly platform: NodeJS.Platform;

  constructor({ cliPath, platform }: { cliPath: string; platform: NodeJS.Platform }) {
    this.cliPath = cliPath;
    this.platform = platform;
  }

  detect(_env: ResolvedEnv): Promise<DetectionResult> {
    return Promise.resolve({
      resolvedPath: process.execPath,
      version: process.version,
      status: 'installed',
    });
  }

  listModels(): Promise<string[]> {
    return Promise.resolve(['fake']);
  }

  buildLaunch(input: LaunchInput): LaunchSpec {
    return this.spec(input, ['--session-id', input.sessionId ?? randomUUID()]);
  }

  buildResume(input: LaunchInput & { sessionId: string }): LaunchSpec {
    return this.spec(input, ['--resume', input.sessionId]);
  }

  mapHookEvent(payload: unknown): AgentSignal | null {
    const parsed = agentSignalSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  }

  mapOutput(_chunk: string, _ctx: OutputContext): AgentSignal | null {
    return null;
  }

  answerKeys(answer: 'allow' | 'deny'): string {
    return `${answer}\r`;
  }

  parseRateLimitReset(text: string): Date | null {
    const match = /Resets at (\S+)/.exec(text);
    if (!match?.[1]) return null;
    const date = new Date(match[1]);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private spec(input: LaunchInput, sessionArgs: string[]): LaunchSpec {
    const args = [
      this.cliPath,
      ...sessionArgs,
      '--permission',
      supportedLevel(input.permissionLevel),
    ];
    const command = toSpawnCommand(input.executablePath, args, this.platform, process.env);
    return {
      ...command,
      cwd: input.cwd,
      env: { ...pactEnv(input), ELECTRON_RUN_AS_NODE: '1' },
    };
  }
}
