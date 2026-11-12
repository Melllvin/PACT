import { z } from 'zod';
import { MAX_REASON, deliverySchema, deliverySettingsSchema } from './delivery';
import { exchangesPayloadSchema } from './exchanges';
import { orchestratorActionSchema } from './orchestrator';
import { previewFileSchema } from './preview';
import {
  agentErrorSchema,
  agentSchema,
  agentStateSchema,
  cliDefinitionSchema,
  issueSchema,
  loopSchema,
  publishRequestSchema,
  MAX_AGENTS,
  permissionLevelSchema,
  permissionPreferenceSchema,
  recentProjectsSchema,
  roleProfileSchema,
  repoPathSchema,
  reviewCommentSchema,
  scheduledResumeSchema,
  workspaceSchema,
} from './model';
import { effortSchema, gitIdSchema, roleSchema, type Role } from './primitives';
import {
  conflictFileSchema,
  fileDiffSchema,
  integrationAfterSchema,
  integrationModeSchema,
  integrationSchema,
  reviewSnapshotSchema,
  testRunSchema,
} from './review';
import { usageStateSchema, usageThresholdsSchema } from './usage';

// contracts/ipc.md — every channel is validated on both sides of the bridge.

export const IPC_ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_A_REPO',
  'ALREADY_OPEN',
  'LIMIT',
  'BRANCH_CONFLICT',
  'PORT_CONFLICT',
  'NOT_FOUND',
  'CLONE_FAILED',
  'INTERNAL',
  // 002: local changes block an integration (FR-021), main moved twice, git's own error (FR-023).
  'LOCAL_CHANGES',
  'MAIN_MOVED',
  'GIT_FAILED',
] as const;

export const ipcErrorSchema = z.object({
  code: z.enum(IPC_ERROR_CODES),
  message: z.string(),
  /** Existing workspace for ALREADY_OPEN, so the renderer can switch to its tab (FR-004). */
  workspaceId: z.string().optional(),
  /** Files with local changes for LOCAL_CHANGES (FR-021). */
  files: z.array(z.string()).optional(),
});
export type IpcError = z.infer<typeof ipcErrorSchema>;

/** Thrown by main-process services to return a specific, displayable error to the renderer. */
export class IpcFailure extends Error {
  constructor(
    readonly code: IpcError['code'],
    message: string,
    readonly workspaceId?: string,
    readonly files?: string[],
  ) {
    super(message);
    this.name = 'IpcFailure';
  }
}

export function toIpcError(error: unknown): IpcError {
  if (error instanceof IpcFailure) {
    return {
      code: error.code,
      message: error.message,
      ...(error.workspaceId === undefined ? {} : { workspaceId: error.workspaceId }),
      ...(error.files === undefined ? {} : { files: error.files }),
    };
  }
  const parsed = ipcErrorSchema.safeParse(error);
  if (parsed.success) return parsed.data;
  if (error instanceof Error) return { code: 'INTERNAL', message: error.message };
  return { code: 'INTERNAL', message: 'Erreur inattendue' };
}

const nonEmpty = z.string().trim().min(1);
/** POSIX, drive-letter or UNC absolute path: paths from the renderer are never resolved relatively. */
const absolutePath = z.string().regex(/^(\/|[A-Za-z]:[\\/]|\\\\)/, 'chemin absolu attendu');
const agentRef = z.object({ agentId: z.uuid() });
const fileRef = agentRef.extend({ path: repoPathSchema });
const integrationRef = z.object({ integrationId: z.uuid() });
const commentText = reviewCommentSchema.shape.text;
const port = z.int().min(1).max(65535);
const counters = z.object({ freeTerminal: z.int().nonnegative() }).catchall(z.int().nonnegative());

/** One agent to launch; `null` means inherited from « Commun à tous » or chosen automatically. */
export const agentDraftSchema = z.object({
  cliId: nonEmpty,
  model: z.string().nullable(),
  permissionLevel: permissionLevelSchema,
  baseBranch: z.string().nullable(),
  branch: z.string().nullable(),
  port: port.nullable(),
  startCommand: z.string().nullable(),
  /** 003 — the orchestrator of the workspace (FR-001); 004 says it with `role`. */
  orchestrator: z.boolean().optional(),
  /** 004 FR-003 — `null` or absent: no role. */
  role: roleSchema.nullable().optional(),
  effort: effortSchema.nullable().optional(),
});
export type AgentDraft = z.infer<typeof agentDraftSchema>;

/** The role of a draft: 003's `orchestrator: true` is the orchestrator role. */
export const draftRole = (draft: AgentDraft): Role | null =>
  draft.role ?? (draft.orchestrator === true ? 'orchestrator' : null);

const request = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O) => ({
  input,
  output,
});
const none = z.undefined();

export const ipcRequests = {
  'app:getState': request(
    none,
    z.object({
      workspaces: z.array(workspaceSchema),
      recents: recentProjectsSchema,
      clis: z.array(cliDefinitionSchema),
      permission: permissionPreferenceSchema.nullable(),
      /** 005 FR-010 — the alert thresholds of the gauges. */
      usageThresholds: usageThresholdsSchema,
    }),
  ),
  'workspace:open': request(z.object({ path: absolutePath }), workspaceSchema),
  'workspace:initRepo': request(z.object({ path: absolutePath }), workspaceSchema),
  'workspace:clone': request(
    z.object({ url: nonEmpty, destination: absolutePath }),
    z.object({ jobId: z.string() }),
  ),
  'workspace:close': request(z.object({ id: nonEmpty }), none),
  /** Uncommitted changes stay out of the agents' worktrees: the launcher says so (T122). */
  'workspace:hasLocalChanges': request(z.object({ id: nonEmpty }), z.boolean()),
  /** Native folder picker; the main process chooses the dialog, the renderer never passes paths. */
  'dialog:pickFolder': request(
    z.object({ purpose: z.enum(['open-repository', 'clone-destination']) }),
    absolutePath.nullable(),
  ),
  'cli:add': request(z.object({ name: nonEmpty.max(64), command: nonEmpty }), cliDefinitionSchema),
  'cli:redetect': request(none, z.array(cliDefinitionSchema)),
  'permission:set': request(
    permissionPreferenceSchema.extend({
      level: permissionLevelSchema,
      autoResume: z.boolean(),
      workspaceId: z.string().optional(),
    }),
    none,
  ),
  'agents:launch': request(
    z.object({
      workspaceId: nonEmpty,
      agents: z.array(agentDraftSchema).max(MAX_AGENTS),
      freeTerminals: z.int().nonnegative(),
      counters,
    }),
    z.array(agentSchema),
  ),
  'agent:answer': request(
    agentRef.extend({ answer: z.enum(['allow', 'deny']), always: z.boolean().optional() }),
    none,
  ),
  'agent:resume': request(agentRef, none),
  /** `resumeWork`: a closed agent that was working gets a resume prompt (006 FR-026). */
  'agent:restart': request(agentRef.extend({ resumeWork: z.boolean().optional() }), none),
  'agent:close': request(agentRef.extend({ removeWorktree: z.boolean() }), none),
  'agent:cancelAutoResume': request(agentRef, none),
  'agent:log': request(agentRef, z.string()),
  'term:write': request(z.object({ termId: nonEmpty, data: z.string().max(1_000_000) }), none),
  'term:resize': request(
    z.object({ termId: nonEmpty, cols: z.int().min(1).max(1000), rows: z.int().min(1).max(1000) }),
    none,
  ),
  // 002 — review (screen 1h) and integration (screen 1q).
  'review:open': request(agentRef, reviewSnapshotSchema),
  'review:close': request(agentRef, none),
  /** The agents to review, asked once loaded: `review:pending` events sent earlier are lost. */
  'review:listPending': request(z.object({ workspaceId: nonEmpty }), z.array(z.uuid())),
  'review:fileDiff': request(fileRef, fileDiffSchema),
  'review:setSeen': request(fileRef.extend({ seen: z.boolean() }), none),
  'review:comment': request(
    fileRef.extend({ line: z.int().min(1), text: commentText }),
    reviewCommentSchema,
  ),
  'review:send': request(
    z.union([
      agentRef.extend({ kind: z.enum(['fix-comments', 'failing-tests', 'conflict']) }),
      agentRef.extend({ kind: z.literal('request'), text: nonEmpty.max(4000) }),
    ]),
    none,
  ),
  'review:runTests': request(agentRef, testRunSchema),
  'review:cancelTests': request(agentRef, none),
  'workspace:setTestCommand': request(
    z.object({ workspaceId: nonEmpty, command: nonEmpty.nullable() }),
    none,
  ),
  'integration:start': request(
    agentRef.extend({
      mode: integrationModeSchema,
      message: nonEmpty,
      after: integrationAfterSchema,
      confirmWorking: z.boolean().optional(),
    }),
    integrationSchema,
  ),
  'integration:resolve': request(
    z.union([
      integrationRef.extend({
        path: repoPathSchema,
        hunk: z.int().nonnegative(),
        choice: z.enum(['main', 'agent', 'both']),
      }),
      integrationRef.extend({ path: repoPathSchema, content: z.string().max(16_000_000) }),
    ]),
    conflictFileSchema,
  ),
  'integration:openInEditor': request(integrationRef.extend({ path: repoPathSchema }), none),
  'integration:askAgent': request(integrationRef, integrationSchema),
  'integration:finish': request(integrationRef, integrationSchema),
  'integration:cancel': request(integrationRef, none),
  /** 008 US1 — « Livrer » / « Intégrer »: the user asks for a delivery of an agent (FR-001, FR-004). */
  'delivery:request': request(
    z.object({
      workspaceId: z.string(),
      agentId: z.uuid(),
      title: z.string().trim().min(1).max(200),
      message: z.string().trim().min(1).max(4000),
      unverified: z.boolean().optional(),
    }),
    deliverySchema,
  ),
  /** 008 FR-008, FR-027 — « Fusionner » / « Refuser » of the local channel, on the head shown. */
  'delivery:decide': request(
    z.object({
      deliveryId: z.uuid(),
      decision: z.enum(['validate', 'refuse', 'wait', 'review']),
      head: gitIdSchema,
      reason: z.string().max(MAX_REASON).optional(),
    }),
    deliverySchema,
  ),
  /**
   * 008 US3 — « Ouvrir la PR »: the main process opens the PR of a delivery in the browser; the
   * renderer never opens a window itself, and only the https address of the PR on the forge is opened.
   */
  'delivery:openPr': request(z.object({ deliveryId: z.uuid() }), none),
  /**
   * 008 US8 — « Supprimer quand même » / « Garder » of a worktree the cleanup kept (FR-037). `force`
   * without `confirmed` only answers what would be lost; `confirmed: true` deletes, but only when `seen`
   * (the list the user was shown) is still what the removal would lose: PACT reads it again, and if it
   * changed (a file added since) nothing is deleted and the new list is answered (R1).
   */
  'delivery:cleanup': request(
    z.object({
      deliveryId: z.uuid(),
      agentId: z.uuid(),
      decision: z.enum(['force', 'keep']),
      confirmed: z.boolean().optional(),
      seen: z.array(z.string()).optional(),
    }),
    z.object({ lost: z.array(z.string()) }),
  ),
  /**
   * 008 FR-019, FR-020 — the settings of the delivery of a project (Auto first): only the keys given
   * change; the bounds are checked by the handler, which says which field is out of them.
   */
  'delivery:settings': request(
    z.object({
      workspaceId: z.string(),
      settings: z.object({
        auto: z.boolean().optional(),
        mergeMode: z.string().optional(),
        maxRounds: z.number().optional(),
        polishPasses: z.number().optional(),
        polishBrief: z.string().optional(),
      }),
    }),
    deliverySettingsSchema,
  ),
  /** 003 US5 — the journal « ◎ Actions », the latest first (FR-021). */
  /** 005 — the usage of every CLI account read so far, when the renderer loads. */
  'usage:get': request(none, z.array(usageStateSchema)),
  /** 005 FR-010 — the alert thresholds, set by the user. */
  'settings:usageThresholds': request(usageThresholdsSchema, usageThresholdsSchema),
  'orchestrator:actions': request(
    z.object({ agentId: z.uuid() }),
    z.array(orchestratorActionSchema),
  ),
  /** 003 US5 — « Retirer le rôle d'orchestrateur » (FR-004). */
  'orchestrator:revoke': request(z.object({ agentId: z.uuid() }), none),
  /** 006 US5 — « Faire orchestrateur » (FR-027, FR-028). */
  'orchestrator:promote': request(z.object({ agentId: z.uuid() }), none),
  /** 006 #45 — « Renommer ». */
  'agent:rename': request(z.object({ agentId: z.uuid(), name: z.string() }), none),
  /** 004 FR-018 — the user's decision on a loop stopped after 3 rounds. */
  'loop:decide': request(
    z.object({
      workspaceId: z.string(),
      issueId: z.string().min(1),
      decision: z.enum(['restart', 'take-over', 'abandon']),
    }),
    none,
  ),
  /** 007 — the user's decision on two agents that write to each other in a loop. */
  'exchange:decide': request(
    z.object({
      workspaceId: z.string(),
      escalationId: z.uuid(),
      decision: z.enum(['resume', 'cut']),
    }),
    none,
  ),
  /** 004 US1 — the role profiles of a workspace; a weaker test warns without blocking (FR-004). */
  /** 004 US3 — « ◎ Créer N issues ? »: publish with gh, or keep them local (FR-023). */
  'publishRequest:confirm': request(
    z.object({ requestId: z.uuid() }),
    z.object({ issues: z.array(z.object({ id: z.string(), url: z.string() })) }),
  ),
  'publishRequest:refuse': request(z.object({ requestId: z.uuid() }), none),
  'preview:list': request(
    z.object({ agentId: z.uuid() }),
    z.object({ files: z.array(previewFileSchema) }),
  ),
  'preview:decide': request(
    z.object({
      agentId: z.uuid(),
      path: repoPathSchema,
      decision: z.enum(['validated', 'refused']),
      comment: z.string().max(2000).optional(),
    }),
    none,
  ),
  'roles:setProfiles': request(
    z.object({
      workspaceId: z.string().min(1),
      profiles: z.partialRecord(roleSchema, roleProfileSchema),
    }),
    z.object({ warnings: z.array(z.string()) }),
  ),
} as const;

export const ipcEvents = {
  'term:data': z.object({ termId: z.string(), data: z.string() }),
  'term:exit': z.object({ termId: z.string(), code: z.int().nullable() }),
  'agent:state': z.object({
    agentId: z.uuid(),
    state: agentStateSchema,
    lastError: agentErrorSchema.nullable().optional(),
    scheduledResume: scheduledResumeSchema.nullable().optional(),
    /** Sent with an `awaiting-answer` state when the agent asks a question (FR-024a). */
    awaiting: z.enum(['question']).optional(),
    /** `closed` with `kept`: the tile stays, closed, to be restarted (006 FR-025). */
    kept: z.boolean().optional(),
    /** Sent when the agent gives a report (« ◆ Décider » reads its questions). */
    lastReport: z
      .object({
        status: z.enum(['done', 'blocked', 'defects']),
        questions: z.array(z.string()),
      })
      .optional(),
  }),
  'agent:branch': z.object({ agentId: z.uuid(), branch: z.string() }),
  'workspace:status': z.object({ id: z.string(), status: z.enum(['available', 'unavailable']) }),
  'clone:progress': z.union([
    z.object({ jobId: z.string(), percent: z.number().min(0).max(100), phase: z.string() }),
    z.object({ jobId: z.string(), error: ipcErrorSchema }),
    // Clone finished and the repository is open (US1 scenario 2).
    z.object({ jobId: z.string(), workspace: workspaceSchema }),
  ]),
  'review:changed': reviewSnapshotSchema,
  /** Agents to review, for the Revue badge and « Revue → » (FR-002, FR-003). */
  'review:pending': z.object({
    workspaceId: z.string(),
    agentIds: z.array(z.uuid()),
    /** Changed files of each agent to review; absent in older payloads. */
    files: z.record(z.string(), z.int().nonnegative()).optional(),
  }),
  'review:tests': testRunSchema,
  'integration:state': integrationSchema,
  /** 003 FR-010 — a prompt of the orchestrator was typed into this agent. */
  'orchestrator:prompted': z.object({ agentId: z.uuid() }),
  /** 003 FR-021 — a new entry of an orchestrator's journal. */
  'orchestrator:action': orchestratorActionSchema.extend({ orchestratorId: z.uuid() }),
  /** 008 — the deliveries of a workspace, for the tiles and À faire. */
  'workspace:deliveries': z.object({
    workspaceId: z.string(),
    deliveries: z.array(deliverySchema),
    delivery: deliverySettingsSchema,
    hasOrigin: z.boolean().optional(),
  }),
  /** 004 US2 — the loops and issues of a workspace, for the tiles and À faire. */
  'workspace:loops': z.object({
    workspaceId: z.string(),
    loops: z.array(loopSchema),
    issues: z.array(issueSchema),
  }),
  /** 004 US4 — a file the Aperçu of the agent lists changed (FR-027). */
  'preview:changed': z.object({ agentId: z.uuid(), path: repoPathSchema }),
  /** 004 US3 — the issues of a workspace and the publication waiting for the user. */
  'workspace:issues': z.object({
    workspaceId: z.string(),
    issues: z.array(issueSchema),
    publishRequests: z.array(publishRequestSchema),
  }),
  /** 005 — a new reading of a CLI account, or a change of its level. */
  'usage:state': usageStateSchema,
  /** Agents were launched in a workspace, by the launcher or by its orchestrator (003 FR-015). */
  'workspace:agentsLaunched': z.object({
    workspaceId: z.string(),
    /** A clicked notification: the view goes to this agent too. */
    focusAgentId: z.string().optional(),
  }),
  /** 007 — the journal of the exchanges of a workspace, as it is now. */
  'workspace:exchanges': z.object({ workspaceId: z.string(), exchanges: exchangesPayloadSchema }),
  /** 007 — a wake held back for this agent, or released. */
  'agent:wakeNotice': z.object({
    agentId: z.uuid(),
    notice: z.enum(['input', 'cap']).nullable(),
  }),
  /** 004 US2 — a report, a missing one or the end of a loop; 007 — or a question of a report. */
  'orchestrator:report': z.object({
    workspaceId: z.string(),
    agentId: z.uuid(),
    kind: z.enum(['report', 'report-missing', 'loop', 'publish', 'mockup', 'question']),
    summary: z.string(),
  }),
} as const;

export type IpcRequestChannel = keyof typeof ipcRequests;
export type IpcEventChannel = keyof typeof ipcEvents;
export type IpcInput<C extends IpcRequestChannel> = z.input<(typeof ipcRequests)[C]['input']>;
export type IpcOutput<C extends IpcRequestChannel> = z.output<(typeof ipcRequests)[C]['output']>;
export type IpcEvent<C extends IpcEventChannel> = z.output<(typeof ipcEvents)[C]>;

/** What travels back over `invoke`: Electron mangles thrown errors, so results are wrapped. */
export type IpcEnvelope<T> = { ok: true; data: T } | { ok: false; error: IpcError };

type InputArgs<C extends IpcRequestChannel> = undefined extends IpcInput<C> ? [] : [IpcInput<C>];

/** The API exposed as `window.pact` by the preload (contracts/ipc.md). */
export interface PactApi {
  /** Rejects with a plain `IpcError` object (it must survive the context bridge). */
  invoke<C extends IpcRequestChannel>(channel: C, ...input: InputArgs<C>): Promise<IpcOutput<C>>;
  on<C extends IpcEventChannel>(channel: C, listener: (payload: IpcEvent<C>) => void): () => void;
  /** Path of a dropped file: the sandboxed renderer cannot read it itself (webUtils). */
  pathForFile(file: File): string;
}
