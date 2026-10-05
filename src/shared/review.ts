import { z } from 'zod';
import { gitIdSchema, repoPathSchema } from './model';

// 002 data-model.md « In memory »: what the main process sends about a review and an integration.

const count = z.int().nonnegative();

export const changedFileSchema = z.object({
  path: repoPathSchema,
  /** Set only for a renamed file. */
  oldPath: repoPathSchema.nullable(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  /** `null` for a binary file. */
  added: count.nullable(),
  removed: count.nullable(),
  binary: z.boolean(),
  /** Over 1 MB or 5 000 diff lines: shown without a line diff (R2). */
  tooLarge: z.boolean(),
  /** Differs only by line endings: « fins de ligne seulement » (R2). */
  eolOnly: z.boolean(),
  /** The agent's side; `null` once deleted. Compared with `review.seen[path]`. */
  blob: gitIdSchema.nullable(),
});

export const reviewSnapshotSchema = z.object({
  agentId: z.uuid(),
  base: gitIdSchema,
  tree: gitIdSchema,
  branch: z.string(),
  files: z.array(changedFileSchema),
  added: count,
  removed: count,
  conflicts: z.union([z.literal('none'), z.literal('checking'), z.array(repoPathSchema)]),
  mainHead: gitIdSchema,
  newSinceSeen: z.object({ added: count, removed: count }).nullable(),
  /** The worktree or branch is gone: the review only offers « Abandonner ». */
  missing: z.boolean(),
});

const lineNo = count.nullable();

export const diffLineSchema = z.object({
  kind: z.enum(['context', 'add', 'del']),
  oldNo: lineNo,
  newNo: lineNo,
  text: z.string(),
});

export const diffHunkSchema = z.object({
  oldStart: count,
  newStart: count,
  lines: z.array(diffLineSchema),
});

export const fileDiffSchema = z.object({
  path: repoPathSchema,
  /** Empty for a binary or too large file. */
  hunks: z.array(diffHunkSchema),
  /** In bytes, shown when there is no line diff. */
  size: count,
});

export const testRunSchema = z.object({
  agentId: z.uuid(),
  command: z.string().min(1),
  /** The snapshot it ran on: stale once the current snapshot differs. */
  tree: gitIdSchema,
  status: z.enum(['running', 'passed', 'failed', 'cancelled', 'timeout']),
  passedCount: count.nullable(),
  outputTail: z.string(),
});

export const conflictHunkSchema = z.object({
  index: count,
  line: z.int().min(1),
  main: z.array(z.string()),
  agent: z.array(z.string()),
  resolution: z.enum(['main', 'agent', 'both']).nullable(),
});

export const conflictFileSchema = z.object({
  path: repoPathSchema,
  /** `delete-modify` and `add-add` only offer « Garder main » or « Garder cette version ». */
  kind: z.enum(['content', 'delete-modify', 'add-add']),
  mainCommit: z.object({ short: z.string(), subject: z.string() }),
  hunks: z.array(conflictHunkSchema),
  /** The whole content, from « Modifier… » or the external editor. */
  edited: z.string().nullable(),
  resolved: z.boolean(),
});

export const integrationModeSchema = z.enum(['squash', 'keep-commits']);

export const integrationAfterSchema = z.object({
  closeTile: z.boolean(),
  removeWorktree: z.boolean(),
});

export const integrationStateSchema = z.enum([
  'checking',
  'conflicted',
  'waiting-agent',
  'committing',
  'integrated',
  'blocked',
  'failed',
  'cancelled',
]);

export const integrationSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  mode: integrationModeSchema.default('squash'),
  message: z.string().min(1),
  after: integrationAfterSchema.default(() => ({ closeTile: true, removeWorktree: true })),
  snapshot: gitIdSchema,
  mainAtStart: gitIdSchema,
  state: integrationStateSchema,
  conflicts: z.array(conflictFileSchema),
  /** Git's message as it came (FR-023). */
  error: z.string().nullable(),
});

export type ChangedFile = z.infer<typeof changedFileSchema>;
export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;
export type DiffLine = z.infer<typeof diffLineSchema>;
export type DiffHunk = z.infer<typeof diffHunkSchema>;
export type FileDiff = z.infer<typeof fileDiffSchema>;
export type TestRun = z.infer<typeof testRunSchema>;
export type ConflictHunk = z.infer<typeof conflictHunkSchema>;
export type ConflictFile = z.infer<typeof conflictFileSchema>;
export type IntegrationMode = z.infer<typeof integrationModeSchema>;
export type IntegrationState = z.infer<typeof integrationStateSchema>;
export type Integration = z.infer<typeof integrationSchema>;
