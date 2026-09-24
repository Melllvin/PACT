import { z } from 'zod';
import {
  agentErrorSchema,
  agentSchema,
  agentStateSchema,
  cliDefinitionSchema,
  MAX_AGENTS,
  permissionLevelSchema,
  permissionPreferenceSchema,
  recentProjectsSchema,
  scheduledResumeSchema,
  workspaceSchema,
} from './model';

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
] as const;

export const ipcErrorSchema = z.object({
  code: z.enum(IPC_ERROR_CODES),
  message: z.string(),
  /** Existing workspace for ALREADY_OPEN, so the renderer can switch to its tab (FR-004). */
  workspaceId: z.string().optional(),
});
export type IpcError = z.infer<typeof ipcErrorSchema>;

/** Thrown by main-process services to return a specific, displayable error to the renderer. */
export class IpcFailure extends Error {
  constructor(
    readonly code: IpcError['code'],
    message: string,
    readonly workspaceId?: string,
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
});
export type AgentDraft = z.infer<typeof agentDraftSchema>;

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
    }),
  ),
  'workspace:open': request(z.object({ path: absolutePath }), workspaceSchema),
  'workspace:initRepo': request(z.object({ path: absolutePath }), workspaceSchema),
  'workspace:clone': request(
    z.object({ url: nonEmpty, destination: absolutePath }),
    z.object({ jobId: z.string() }),
  ),
  'workspace:close': request(z.object({ id: nonEmpty }), none),
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
  'agents:reorder': request(z.object({ workspaceId: nonEmpty, order: z.array(z.uuid()) }), none),
  'agent:answer': request(
    agentRef.extend({ answer: z.enum(['allow', 'deny']), always: z.boolean().optional() }),
    none,
  ),
  'agent:resume': request(agentRef, none),
  'agent:restart': request(agentRef, none),
  'agent:close': request(agentRef.extend({ removeWorktree: z.boolean() }), none),
  'agent:cancelAutoResume': request(agentRef, none),
  'agent:log': request(agentRef, z.string()),
  'term:write': request(z.object({ termId: nonEmpty, data: z.string().max(1_000_000) }), none),
  'term:resize': request(
    z.object({ termId: nonEmpty, cols: z.int().min(1).max(1000), rows: z.int().min(1).max(1000) }),
    none,
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
  }),
  'agent:branch': z.object({ agentId: z.uuid(), branch: z.string() }),
  'workspace:status': z.object({ id: z.string(), status: z.enum(['available', 'unavailable']) }),
  'clone:progress': z.union([
    z.object({ jobId: z.string(), percent: z.number().min(0).max(100), phase: z.string() }),
    z.object({ jobId: z.string(), error: ipcErrorSchema }),
    // Clone finished and the repository is open (US1 scenario 2).
    z.object({ jobId: z.string(), workspace: workspaceSchema }),
  ]),
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
