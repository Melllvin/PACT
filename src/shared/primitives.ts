import { z } from 'zod';

// The schemas the others build on, apart so that model.ts and report.ts both import them.

export const isoDate = z.iso.datetime();

/** A path inside the repository, `/`-separated, never absolute nor escaping it (002). */
export const repoPathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/') && !/(^|\/)\.\.(\/|$)/.test(path), {
    message: 'chemin relatif au dépôt attendu',
  });

export const gitIdSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/** 004 FR-001 — the roles of the delivery chain; 003's orchestrator is the first. */
export const ROLES = ['orchestrator', 'spec', 'design', 'dev', 'test', 'recap'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/** 004 R2 — the reasoning effort, given only to the CLIs that take one. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const effortSchema = z.enum(EFFORTS);
export type Effort = z.infer<typeof effortSchema>;

export const agentStateSchema = z.enum([
  'starting',
  'awaiting-prompt',
  'working',
  'awaiting-answer',
  'done',
  'error',
  'closed',
]);
