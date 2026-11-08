import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { toSpawnCommand } from '../../env/resolve-command';
import { bridgeCommand } from './shared';
import {
  agentSignalSchema,
  pactEnv,
  supportedLevel,
  type AgentSignal,
  type CliAdapter,
  type DetectionResult,
  type HookBridge,
  type LaunchInput,
  type LaunchSpec,
  type OutputContext,
  type ResolvedEnv,
} from './types';

/**
 * Drives tests/fixtures/fake-cli (research.md R13). Only registered in test mode; it runs the
 * fake CLI script with `runtime`, by default the app's own executable (Electron in Node mode, or
 * Node in tests). Electron gets no console in a Windows pseudo-terminal, so e2e runs pass a Node.
 */
export class FakeAdapter implements CliAdapter {
  readonly id = 'fake';
  readonly supportsOrchestrator = true;
  /** 005 R9 — like Claude Code: runs the statusLine of its `--settings`. */
  readonly usageSource = 'claude-statusline' as const;
  private readonly cliPath: string;
  private readonly bridge: HookBridge | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly runtime: string;

  constructor({
    cliPath,
    platform,
    runtime = process.execPath,
    bridge,
  }: {
    cliPath: string;
    platform: NodeJS.Platform;
    runtime?: string | undefined;
    bridge?: HookBridge;
  }) {
    this.cliPath = cliPath;
    this.bridge = bridge;
    this.platform = platform;
    this.runtime = runtime;
  }

  detect(_env: ResolvedEnv): Promise<DetectionResult> {
    return Promise.resolve({
      resolvedPath: this.runtime,
      version: process.version,
      status: 'installed',
    });
  }

  readonly supportsEffort = true;
  /** 007 — plays Claude Code's hooks, unless FAKE_CLI_NO_WAKE_HOOK=1: a CLI that has none. */
  readonly midTurnWake = process.env['FAKE_CLI_NO_WAKE_HOOK'] !== '1';

  modelTiers(): string[][] {
    return [['fake-small'], ['fake'], ['fake-large']];
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

  isWakePoint(payload: unknown): 'tool' | 'stop' | null {
    if (!this.midTurnWake) return null;
    const parsed = z
      .looseObject({ type: z.string(), agent_id: z.string().optional() })
      .safeParse(payload);
    if (!parsed.success || parsed.data.agent_id !== undefined) return null;
    if (parsed.data.type === 'post-tool') return 'tool';
    return parsed.data.type === 'turn-finished' ? 'stop' : null;
  }

  wakeReply(payload: unknown, pointer: string): object | null {
    const point = this.isWakePoint(payload);
    if (point === 'tool') {
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: pointer } };
    }
    return point === 'stop' ? { decision: 'block', reason: pointer } : null;
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
      ...(this.bridge
        ? [
            '--settings',
            JSON.stringify({
              statusLine: { type: 'command', command: bridgeCommand(this.bridge, '--statusline') },
            }),
          ]
        : []),
    ];
    const command = toSpawnCommand(input.executablePath, args, this.platform, process.env);
    return {
      ...command,
      cwd: input.cwd,
      env: {
        ...pactEnv(input),
        ELECTRON_RUN_AS_NODE: '1',
        // 003 R11: the fake orchestrator calls PACT's tools itself, with no plugin to read.
        ...(input.orchestrator
          ? {
              PACT_ORCHESTRATOR_URL: input.orchestrator.url,
              PACT_ORCHESTRATOR_TOKEN: input.orchestrator.token,
            }
          : {}),
        // 004 R5: the fake agent of a role reports with submit_report itself.
        ...(input.agentMcp
          ? { PACT_AGENT_MCP_URL: input.agentMcp.url, PACT_AGENT_MCP_TOKEN: input.agentMcp.token }
          : {}),
      },
    };
  }
}
