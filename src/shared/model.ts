import { z } from 'zod';
import {
  defaultDeliverySettings,
  deliverySchema,
  deliverySettingsSchema,
  MAX_POLISH,
  MAX_ROUNDS_LIMIT,
} from './delivery';
import { exchangesSchema } from './exchanges';
import {
  agentStateSchema,
  effortSchema,
  gitIdSchema,
  isoDate,
  repoPathSchema,
  roleSchema,
} from './primitives';
import { storedReportSchema } from './report';
import { usagePauseSchema } from './usage-limit';

export {
  agentStateSchema,
  EFFORTS,
  ROLES,
  effortSchema,
  gitIdSchema,
  repoPathSchema,
  roleSchema,
  type Effort,
  type Role,
} from './primitives';

/** Agent colors, assigned in this order at creation and never reassigned (FR-016). */
export const AGENT_COLORS = ['purple', 'cyan', 'green', 'magenta', 'yellow', 'slate'] as const;
export const MAX_AGENTS = 6;
export const MAX_RECENT_PROJECTS = 20;

export const agentColorSchema = z.enum(AGENT_COLORS);

/** An agent still at work: integrating it asks for a confirmation first (002 FR-025). */
export const WORKING_STATES: readonly z.infer<typeof agentStateSchema>[] = [
  'starting',
  'working',
  'awaiting-answer',
];

export const permissionLevelSchema = z.enum(['always-allow', 'ask-sensitive', 'always-ask']);

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
  /** 009 — why and until when PACT stopped it at a limit; non-null only in `paused`. */
  pause: usagePauseSchema.nullable().default(null),
  /** 002 — defaulted so that workspace files from 001 load without a migration (R9). */
  review: agentReviewSchema.default(() => ({ seen: {}, comments: [] })),
  /** Set while an `awaiting-answer` agent asks a question, not a permission (FR-024a). */
  awaiting: z.enum(['question']).optional(),
  /** 003 — the orchestrator of its workspace, at most one (R8); 004 — or another role (FR-001). */
  role: roleSchema.nullable().default(null),
  /** 004 R2 — `null`: the CLI's own. */
  effort: effortSchema.nullable().default(null),
  /**
   * 006 R4 — id (uuid) of the orchestrator that launched it; `null`: launched by the user. Defaulted
   * so that older workspace files load without a migration. Set once, at launch; never changed after.
   */
  launchedBy: z.string().nullable().default(null),
  /** 006 #45 — the name given by the user; absent or `null`: « <CLI> <position> ». Optional so that older files load. */
  name: z.string().nullable().optional(),
  /**
   * 006 FR-026 — the agent was at work (`WORKING_STATES`) when it was closed with its orchestrator:
   * « Reprendre le travail » gives it a resume prompt. Defaulted to false so that older files load.
   */
  closedWhileWorking: z.boolean().default(false),
  /**
   * The last hand-off report of the agent, with or without a loop: « ◆ Décider » reads it. Cleared
   * when the agent works again; absent in workspace files saved before.
   */
  lastReport: z
    .object({
      status: z.enum(['done', 'blocked', 'defects']),
      questions: z.array(z.string()),
    })
    .nullable()
    .optional(),
  /** 007 — a wake held back and signalled: `deriveTodos` reads it (data-model). */
  wakeNotice: z.enum(['input', 'cap']).nullable().optional(),
});

/** 004 R2 — what an agent of a role is launched with; `null` model: the CLI's own. */
export const roleProfileSchema = z.object({
  cliId: z.string().min(1),
  model: z.string().nullable(),
  effort: effortSchema.nullable(),
  /** The ceiling of the role; `null`: none (FR-002). */
  maxModel: z.string().nullable(),
  /** FR-007 — the third round goes to `maxModel`. */
  escalate: z.boolean().default(false),
});

export const issueStateSchema = z.enum([
  'proposed',
  'ready',
  'in-progress',
  'done',
  'escalated',
  'abandoned',
]);

/** 004 — a file of `.pact/issues/` and where its work went (FR-022…FR-024). */
export const issueSchema = z.object({
  /** The file's name without `.md`, unique in the workspace. */
  id: z.string().min(1),
  title: z.string(),
  /** Relative to the orchestrator's worktree, under `.pact/issues/`. */
  path: repoPathSchema,
  state: issueStateSchema,
  remote: z.object({ number: z.int().positive(), url: z.url() }).nullable().default(null),
  trace: z
    .object({
      branch: z.string().nullable(),
      agents: z.array(z.uuid()),
      pr: z.string().nullable(),
    })
    .default(() => ({ branch: null, agents: [], pr: null })),
});

const roundNumber = z.int().min(1).max(MAX_ROUNDS_LIMIT);

/** 004 R6 — one round of a loop: its reports and PACT's own run of the tests. */
export const roundSchema = z.object({
  n: roundNumber,
  startedAt: isoDate,
  reports: z.array(storedReportSchema).default([]),
  /** 008 R3 — `commit`: the clean head the tests ran on; `null` in files saved before. */
  proof: z
    .object({
      tree: gitIdSchema,
      commit: gitIdSchema.nullable().default(null),
      exitCode: z.int(),
      at: isoDate,
    })
    .nullable()
    .default(null),
  /** 008 FR-023 — a polish pass is not a round trip. */
  kind: z.enum(['round', 'polish']).default('round'),
  /** Files outside the test paths the test agent changed in this round (FR-020). */
  testerTouched: z.array(repoPathSchema).default([]),
});

/** 008 R12 — a loop saved as « passed » (007) is read as « closed »: it was never delivered by PACT. */
const loopState = z.preprocess(
  (state) => (state === 'passed' ? 'closed' : state),
  z.enum(['running', 'polishing', 'accepted', 'delivering', 'merged', 'escalated', 'closed']),
);

/** 004 FR-017 — the dev ↔ test loop of an issue; the ceiling is `workspace.delivery.maxRounds` (008 R11). */
export const loopSchema = z
  .object({
    issueId: z.string().min(1),
    devAgentId: z.uuid(),
    testAgentId: z.uuid(),
    round: roundNumber,
    rounds: z.array(roundSchema).max(MAX_ROUNDS_LIMIT),
    state: loopState,
    /** 008 R23 — the polish passes; `null` without any. */
    polish: z
      .object({
        done: z.int().min(0).max(MAX_POLISH),
        total: z.int().min(0).max(MAX_POLISH),
        restarted: z.boolean(),
      })
      .nullable()
      .default(null),
    escalatedModel: z.string().nullable().default(null),
  })
  .refine((loop) => loop.devAgentId !== loop.testAgentId, {
    message: 'deux agents différents',
    path: ['testAgentId'],
  });

/** 004 FR-023 — issues to create on the remote, waiting for the user. */
export const publishRequestSchema = z.object({
  id: z.uuid(),
  issueIds: z.array(z.string().min(1)).min(1).max(20),
  requestedAt: isoDate,
});

/** 004 R6 — what a test agent may change; the rest is the dev's. */
export const DEFAULT_TEST_PATHS = [
  '**/*.test.*',
  '**/*.spec.*',
  'tests/**',
  'test/**',
  '**/__tests__/**',
];

/** 003 — an integration the orchestrator asks for, waiting for the user (FR-017, FR-020). */
export const integrationRequestSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  mode: z.enum(['squash', 'keep-commits']).default('squash'),
  message: z.string().min(1).max(4000),
  requestedAt: isoDate,
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
    /** 003 — integrations the orchestrator asked for, waiting for the user (R6). */
    integrationRequests: z.array(integrationRequestSchema).default([]),
    /** 004 — absent roles take the default profile (R2). */
    roleProfiles: z.partialRecord(roleSchema, roleProfileSchema).default({}),
    issues: z.array(issueSchema).default([]),
    loops: z.array(loopSchema).default([]),
    testPaths: z.array(z.string().min(1)).default(() => [...DEFAULT_TEST_PATHS]),
    /** At most one: a new one replaces the old one. */
    publishRequests: z.array(publishRequestSchema).max(1).default([]),
    /** 007 — the journal of the exchanges between the agents; old files load without it. */
    exchanges: exchangesSchema,
    /** 008 — the settings of the delivery and the requests, written at every step (R2, R11). */
    delivery: deliverySettingsSchema.default(defaultDeliverySettings),
    deliveries: z.array(deliverySchema).default([]),
    /** 008 — the repository has a remote called `origin`: « Livrer » instead of « Intégrer ». */
    hasOrigin: z.boolean().optional(),
    lastOpenedAt: isoDate,
    status: z.enum(['available', 'unavailable']),
  })
  .superRefine(({ agents }, ctx) => {
    for (const field of ['position', 'port', 'branch'] as const) {
      if (hasDuplicates(agents.map((a) => a[field]))) {
        ctx.addIssue({ code: 'custom', path: ['agents'], message: `duplicate agent ${field}` });
      }
    }
    if (agents.filter((agent) => agent.role === 'orchestrator').length > 1) {
      ctx.addIssue({ code: 'custom', path: ['agents'], message: 'more than one orchestrator' });
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
  /** 003 — its adapter can make it the orchestrator of a workspace (R8). */
  orchestrator: z.boolean().optional(),
  /** 004 R2 — its models by tier, smallest first; absent or empty: order unknown. */
  modelTiers: z.array(z.array(z.string())).default([]),
  /** 004 R2 — it takes a reasoning effort. */
  supportsEffort: z.boolean().optional(),
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
export type RoleProfile = z.infer<typeof roleProfileSchema>;
export type Issue = z.infer<typeof issueSchema>;
export type PublishRequest = z.infer<typeof publishRequestSchema>;
export type Loop = z.infer<typeof loopSchema>;
export type RecentProject = z.infer<typeof recentProjectSchema>;
export type CliDefinition = z.infer<typeof cliDefinitionSchema>;
export type AdapterId = z.infer<typeof adapterIdSchema>;

/** Actions offered by a tile and by the matching À faire item (FR-024, FR-028). */
export type TileAction =
  | 'allow'
  | 'deny'
  | 'always-allow'
  | 'log'
  | 'restart'
  | 'resume'
  | 'cancel-resume'
  /** « Revue → »: opens the Changements tab (002 FR-002). */
  | 'review'
  /** « Répondre dans le terminal ↗ »: a question is answered there (FR-024a). */
  | 'open-terminal';

/** Derived from agent state, never persisted (data-model TodoItem). */
export type TodoItem = {
  id: `${string}:${TodoKind}`;
  agentId: string;
  kind: TodoKind;
  title: string;
  actions: TileAction[];
  /**
   * 008 contracts/ui.md — the delivery the user decides on and the head shown. `delivery-review` adds
   * the link of the PR and its verdict (`null`: a PR without a verdict).
   */
  delivery?: { id: string; head: string; url?: string; verdict?: 'accepted' | null };
  /** 004 FR-018 — the loop stopped at the ceiling of the project, for `loop-escalated`. */
  loop?: { issueId: string; maxRounds?: number };
  /** 007 FR-006 — the escalation of an exchange in a loop, and its last message as text. */
  exchange?: { escalationId: string; text: string };
  /** 004 FR-023 — the issues the orchestrator asks to publish, for `publish-issues`. */
  publish?: { requestId: string };
  /** 005 FR-011 — the account near its limit, for `usage-limit`. */
  usage?: { cliId: string; account: string; level: 'warn' | 'critical' };
  /** 009 — the account stopped at its limit, or asking for a stop by prudence. */
  usageLimit?: { cliId: string; account: string; kind: 'paused' | 'stale'; step?: number };
  /** The questions of an agent stopped on a `blocked` report, for `decide`. */
  decide?: { questions: string[] };
  /** 007 — the sentence under the title, for `wake-held`. */
  detail?: string;
};
export type TodoKind =
  | 'answer'
  | 'decide'
  | 'delivery-local'
  | 'delivery-review'
  | 'delivery-silent-ci'
  | 'delivery-alert'
  | 'worktree-kept'
  | 'publish-issues'
  | 'loop-escalated'
  | 'exchange-escalated'
  | 'usage-paused'
  | 'usage-stale'
  | 'rate-limit'
  | 'usage-limit'
  | 'wake-held'
  | 'review'
  | 'prompt'
  | 'info';
