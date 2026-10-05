import { z } from 'zod';

/** Agent colors, assigned in this order at creation and never reassigned (FR-016). */
export const AGENT_COLORS = ['purple', 'cyan', 'green', 'magenta', 'yellow', 'slate'] as const;
export const MAX_AGENTS = 6;
export const MAX_RECENT_PROJECTS = 20;

export const agentColorSchema = z.enum(AGENT_COLORS);

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

const isoDate = z.iso.datetime();

export const scheduledResumeSchema = z.object({
  agentId: z.string(),
  at: isoDate,
  attempt: z.int().nonnegative(),
});

export const permissionPreferenceSchema = z.object({
  level: permissionLevelSchema.default('always-allow'),
  autoResume: z.boolean().default(true),
  scope: z.enum(['project', 'global']),
});

export const agentErrorSchema = z.object({
  code: z.int().nullable(),
  kind: z.enum(['crash', 'rate-limit']),
  message: z.string(),
});

/** A path inside the repository, `/`-separated, never absolute nor escaping it (002). */
export const repoPathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/') && !/(^|\/)\.\.(\/|$)/.test(path), {
    message: 'chemin relatif au dépôt attendu',
  });

export const gitIdSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

export const reviewCommentSchema = z.object({
  id: z.uuid(),
  path: repoPathSchema,
  line: z.int().min(1),
  text: z.string().min(1).max(4000),
  createdAt: isoDate,
  treated: z.boolean().default(false),
});

/** `seen`: path → blob id of the content marked « vu » (FR-009, FR-011). */
export const agentReviewSchema = z.object({
  seen: z.record(z.string(), gitIdSchema),
  comments: z.array(reviewCommentSchema),
});

export const agentSchema = z.object({
  id: z.uuid(),
  workspaceId: z.string(),
  position: z.int().min(1).max(MAX_AGENTS),
  color: agentColorSchema,
  cliId: z.string(),
  model: z.string().nullable(),
  permissionLevel: permissionLevelSchema,
  baseBranch: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
  port: z.int().min(1).max(65535),
  startCommand: z.string().nullable(),
  sessionId: z.string().nullable(),
  initialPrompt: z.string().nullable(),
  alwaysAllowRules: z.array(z.string()),
  state: agentStateSchema,
  lastError: agentErrorSchema.nullable(),
  scheduledResume: scheduledResumeSchema.nullable(),
  /** 002 — defaulted so that workspace files from 001 load without a migration (R9). */
  review: agentReviewSchema.default(() => ({ seen: {}, comments: [] })),
});

export const freeTerminalSchema = z.object({
  id: z.uuid(),
  workspaceId: z.string(),
  cwd: z.string(),
  shell: z.string(),
});

const counter = z.int().nonnegative();

const hasDuplicates = (values: readonly unknown[]) => new Set(values).size !== values.length;

export const workspaceSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    name: z.string(),
    mainBranch: z.string(),
    agents: z.array(agentSchema).max(MAX_AGENTS),
    freeTerminals: z.array(freeTerminalSchema),
    quickLaunchCounters: z.object({ freeTerminal: counter }).catchall(counter),
    permissionOverride: permissionPreferenceSchema.nullable(),
    /** `null`: detected from the repository (002 R8). */
    testCommand: z.string().trim().min(1).nullable().default(null),
    lastOpenedAt: isoDate,
    status: z.enum(['available', 'unavailable']),
  })
  .superRefine(({ agents }, ctx) => {
    for (const field of ['position', 'port', 'branch'] as const) {
      if (hasDuplicates(agents.map((a) => a[field]))) {
        ctx.addIssue({ code: 'custom', path: ['agents'], message: `duplicate agent ${field}` });
      }
    }
  });

export const recentProjectSchema = z.object({
  path: z.string(),
  name: z.string(),
  branch: z.string(),
  keptWorktrees: z.int().nonnegative(),
  lastOpenedAt: isoDate,
});
export const recentProjectsSchema = z.array(recentProjectSchema).max(MAX_RECENT_PROJECTS);

export const adapterIdSchema = z.enum(['claude-code', 'codex', 'generic', 'fake']);

export const cliDefinitionSchema = z.object({
  id: z.union([z.enum(['claude-code', 'codex', 'fake']), z.string().regex(/^custom-[a-z0-9-]+$/)]),
  name: z.string(),
  adapter: adapterIdSchema,
  command: z.string(),
  resolvedPath: z.string().nullable(),
  version: z.string().nullable(),
  origin: z.enum(['detected', 'custom']),
  status: z.enum(['installed', 'missing', 'unsupported-version']),
  models: z.array(z.string()),
});

export type AgentColor = z.infer<typeof agentColorSchema>;
export type AgentState = z.infer<typeof agentStateSchema>;
export type PermissionLevel = z.infer<typeof permissionLevelSchema>;
export type PermissionPreference = z.infer<typeof permissionPreferenceSchema>;
export type ScheduledResume = z.infer<typeof scheduledResumeSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type AgentReview = z.infer<typeof agentReviewSchema>;
export type ReviewComment = z.infer<typeof reviewCommentSchema>;
export type FreeTerminal = z.infer<typeof freeTerminalSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type RecentProject = z.infer<typeof recentProjectSchema>;
export type CliDefinition = z.infer<typeof cliDefinitionSchema>;
export type AdapterId = z.infer<typeof adapterIdSchema>;

/** Actions offered by a tile and by the matching À faire item (FR-024, FR-028). */
export type TileAction =
  'allow' | 'deny' | 'always-allow' | 'log' | 'restart' | 'resume' | 'cancel-resume';

/** Derived from agent state, never persisted (data-model TodoItem). */
export type TodoItem = {
  id: `${string}:${TodoKind}`;
  agentId: string;
  kind: TodoKind;
  title: string;
  actions: TileAction[];
};
export type TodoKind = 'answer' | 'rate-limit' | 'prompt' | 'info';
