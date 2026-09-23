import { z } from 'zod';

export const AGENT_COLORS = ['purple', 'cyan', 'green', 'magenta', 'yellow', 'slate'] as const;
export const agentStateSchema = z.enum([
  'starting',
  'awaiting-prompt',
  'working',
  'awaiting-answer',
  'done',
  'error',
  'closed',
]);
export const permissionLevelSchema = z.enum(['always-allow', 'ask-sensitive', 'always-ask']);
export const scheduledResumeSchema = z.object({
  agentId: z.string(),
  at: z.iso.datetime(),
  attempt: z.number().int().nonnegative(),
});
export const permissionPreferenceSchema = z.object({
  level: permissionLevelSchema.default('always-allow'),
  autoResume: z.boolean().default(true),
  scope: z.enum(['project', 'global']),
});
export const agentSchema = z.object({
  id: z.uuid(),
  workspaceId: z.string(),
  position: z.number().int().min(1).max(6),
  color: z.enum(AGENT_COLORS),
  cliId: z.string(),
  model: z.string().nullable(),
  permissionLevel: permissionLevelSchema,
  baseBranch: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
  port: z.number().int().min(1).max(65535),
  startCommand: z.string().nullable(),
  sessionId: z.string().nullable(),
  initialPrompt: z.string().nullable(),
  alwaysAllowRules: z.array(z.string()),
  state: agentStateSchema,
  lastError: z
    .object({
      code: z.number().int().nullable(),
      kind: z.enum(['crash', 'rate-limit']),
      message: z.string(),
    })
    .nullable(),
  scheduledResume: scheduledResumeSchema.nullable(),
});
export const freeTerminalSchema = z.object({
  id: z.uuid(),
  workspaceId: z.string(),
  cwd: z.string(),
  shell: z.string(),
});
export const workspaceSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  mainBranch: z.string(),
  agents: z.array(agentSchema).max(6),
  freeTerminals: z.array(freeTerminalSchema),
  quickLaunchCounters: z.record(z.string(), z.number().int().nonnegative()),
  permissionOverride: permissionPreferenceSchema.nullable(),
  lastOpenedAt: z.iso.datetime(),
  status: z.enum(['available', 'unavailable']),
});
export const recentProjectSchema = z.object({
  path: z.string(),
  name: z.string(),
  branch: z.string(),
  keptWorktrees: z.number().int().nonnegative(),
  lastOpenedAt: z.iso.datetime(),
});
export const recentProjectsSchema = z.array(recentProjectSchema).max(20);
export const cliDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  adapter: z.enum(['claude-code', 'codex', 'generic', 'fake']),
  command: z.string(),
  resolvedPath: z.string().nullable(),
  version: z.string().nullable(),
  origin: z.enum(['detected', 'custom']),
  status: z.enum(['installed', 'missing', 'unsupported-version']),
  models: z.array(z.string()),
});

export type Agent = z.infer<typeof agentSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type RecentProject = z.infer<typeof recentProjectSchema>;
export type CliDefinition = z.infer<typeof cliDefinitionSchema>;
export type PermissionPreference = z.infer<typeof permissionPreferenceSchema>;
export type AgentState = z.infer<typeof agentStateSchema>;
export type TileAction =
  | 'allow'
  | 'deny'
  | 'always-allow'
  | 'log'
  | 'restart'
  | 'resume'
  | 'cancel-resume';
export type TodoItem = {
  id: string;
  agentId: string;
  kind: 'answer' | 'prompt' | 'info' | 'rate-limit';
  title: string;
  actions: TileAction[];
  color: (typeof AGENT_COLORS)[number];
};
