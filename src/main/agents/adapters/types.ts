import { z } from 'zod';
import type { AdapterId, Effort, PermissionLevel } from '../../../shared/model';
import type { RoleSkills } from '../../orchestrator/role-skills';

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
  /** Main repository; its `.git` must stay writable from a sandboxed worktree (research.md R5). */
  repoPath: string;
  cwd: string;
  model: string | null;
  /** 004 R2 — the reasoning effort; ignored by the CLIs that take none. */
  effort?: Effort | null | undefined;
  permissionLevel: PermissionLevel;
  sessionId?: string;
  port: number;
  hook: { url: string; token: string };
  /** 003 — set for the orchestrator of the workspace: its session plugin, URL and token (R2). */
  orchestrator?: OrchestratorLaunch | null | undefined;
  /** 004 R5 — set for an agent with another role: its own MCP access, submit_report only. */
  agentMcp?: AgentMcpLaunch | null | undefined;
  /** 004 R3 — set for an agent with a role: where its skills and the contract are. */
  skills?: RoleSkills | null | undefined;
};

export type OrchestratorLaunch = {
  pluginDir: string;
  url: string;
  token: string;
  skills: RoleSkills;
};
export type AgentMcpLaunch = { url: string; token: string; skills: RoleSkills };

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
    /** A question to choose from (AskUserQuestion), not a permission: never answered by PACT. */
    question: z.literal(true).optional(),
  }),
  // `sessionId` lets the manager drop signals from another session (Codex title thread, T049).
  z.object({ type: z.literal('turn-finished'), sessionId: z.string().optional() }),
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

/** Runs a short command (`--version`, `--help`…) and resolves with its standard output. */
export type CommandRunner = (file: string, args: string[], env: ResolvedEnv) => Promise<string>;

/** How CLIs without HTTP hooks reach PACT: the built hook bridge run by Electron in Node mode. */
export type HookBridge = { executable: string; script: string };

export type OutputContext = { exitCode?: number; idleMs?: number };

export interface CliAdapter {
  readonly id: AdapterId;
  /** 003 R8 — whether this CLI can be the orchestrator of its workspace. */
  readonly supportsOrchestrator: boolean;
  /** 004 R2 — whether `LaunchInput.effort` reaches the CLI. */
  readonly supportsEffort: boolean;
  detect(env: ResolvedEnv): Promise<DetectionResult>;
  listModels(): Promise<string[]>;
  /** 004 R2 — its models by tier, smallest first; empty when the order is unknown. */
  modelTiers(): string[][];
  buildLaunch(input: LaunchInput): LaunchSpec;
  buildResume(input: LaunchInput & { sessionId: string }): LaunchSpec;
  mapHookEvent(payload: unknown): AgentSignal | null;
  mapOutput(chunk: string, ctx: OutputContext): AgentSignal | null;
  answerKeys(answer: 'allow' | 'deny'): string;
  /**
   * Reply to the hook that announced a permission request, allowing it without a dialog
   * (« Toujours pour ce worktree », FR-034). Without it, PACT types `answerKeys('allow')`.
   */
  permissionDecision?(behavior: 'allow'): unknown;
  parseRateLimitReset(text: string): Date | null;
  /**
   * 005 R1, R2 — where PACT reads the usage limits of its account: the statusLine Claude Code
   * runs, or the rollout Codex writes. None for the other CLIs: no gauge.
   */
  readonly usageSource?: 'claude-statusline' | 'codex-rollout';
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
