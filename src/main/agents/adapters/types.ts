import { z } from 'zod';
import type { AdapterId, PermissionLevel } from '../../../shared/model';

// contracts/cli-adapter.md

export type ResolvedEnv = Record<string, string | undefined>;

export type DetectionResult = {
  resolvedPath: string | null;
  version: string | null;
  status: 'installed' | 'missing' | 'unsupported-version';
};

export type LaunchInput = {
  agentId: string;
  /** Full path resolved at detection (CliDefinition.resolvedPath). */
  executablePath: string;
  cwd: string;
  model: string | null;
  permissionLevel: PermissionLevel;
  sessionId?: string;
  port: number;
  hook: { url: string; token: string };
};

export type LaunchSpec = {
  file: string;
  args: string[];
  /** PACT variables and adapter-specific ones; merged over the resolved shell environment. */
  env: Record<string, string>;
  cwd: string;
  /** Set when `args` are pre-escaped for cmd.exe (Windows .cmd/.bat shims). */
  windowsVerbatimArguments: boolean;
};

export const agentSignalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session-started'), sessionId: z.string().optional() }),
  z.object({ type: z.literal('prompt-submitted'), prompt: z.string().optional() }),
  z.object({
    type: z.literal('awaiting-answer'),
    summary: z.string(),
    ruleKey: z.string().optional(),
  }),
  z.object({ type: z.literal('turn-finished') }),
  z.object({
    type: z.literal('failed'),
    kind: z.enum(['crash', 'rate-limit']),
    message: z.string(),
    resetAt: z.iso
      .datetime()
      .transform((iso) => new Date(iso))
      .optional(),
  }),
]);
export type AgentSignal = z.output<typeof agentSignalSchema>;

export type OutputContext = { exitCode?: number; idleMs?: number };

export interface CliAdapter {
  readonly id: AdapterId;
  detect(env: ResolvedEnv): Promise<DetectionResult>;
  listModels(): Promise<string[]>;
  buildLaunch(input: LaunchInput): LaunchSpec;
  buildResume(input: LaunchInput & { sessionId: string }): LaunchSpec;
  mapHookEvent(payload: unknown): AgentSignal | null;
  mapOutput(chunk: string, ctx: OutputContext): AgentSignal | null;
  answerKeys(answer: 'allow' | 'deny'): string;
  parseRateLimitReset(text: string): Date | null;
}

/** Variables every agent receives (contract obligation 1, FR-015). */
export const pactEnv = (input: LaunchInput): Record<string, string> => ({
  PORT: String(input.port),
  PACT_PORT: String(input.port),
  PACT_HOOK_URL: input.hook.url,
  PACT_AGENT_TOKEN: input.hook.token,
  PACT_AGENT_ID: input.agentId,
});

const LEVELS: readonly PermissionLevel[] = ['always-allow', 'ask-sensitive', 'always-ask'];

/** Contract obligation 2: an unknown level falls back to the most cautious one. */
export const supportedLevel = (level: string): PermissionLevel =>
  LEVELS.find((known) => known === level) ?? 'always-ask';
