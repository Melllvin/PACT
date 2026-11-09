import { z } from 'zod';
import { gitIdSchema, isoDate, repoPathSchema, roleSchema } from './primitives';

// 004 contracts/handoff-report.md — what an agent with a role tells at the end of its work.

export const MAX_SUMMARY = 2000;

const checkSchema = z.object({ command: z.string().min(1), exitCode: z.int() });

const verdictSchema = z
  .object({ result: z.enum(['accepted', 'defects']), defects: z.array(z.string().min(1)) })
  .refine((v) => v.result === 'accepted' || v.defects.length > 0, {
    message: 'au moins un défaut attendu',
    path: ['defects'],
  });

/** The fields, in the order of the contract: the order `missingFields` lists them in. */
export const handoffReportFields = z.object({
  issue: z.string().min(1),
  status: z.enum(['done', 'blocked', 'defects']),
  summary: z.string().min(1).max(MAX_SUMMARY),
  files: z.array(repoPathSchema),
  checks: z.array(checkSchema),
  questions: z.array(z.string().min(1)).default([]),
  verdict: verdictSchema.optional(),
});

export const handoffReportSchema = handoffReportFields.superRefine((report, ctx) => {
  if (report.status === 'done' && report.checks.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['checks'], message: 'une vérification au moins' });
  }
  if (report.questions.length > 0 && report.status !== 'blocked') {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'des questions : « blocked »' });
  }
});
export type HandoffReport = z.infer<typeof handoffReportSchema>;

/** A report as PACT keeps it, with who gave it and when (data-model Round). */
export const storedReportSchema = handoffReportFields.extend({
  agentId: z.uuid(),
  role: roleSchema,
  round: z.int().min(1).max(10),
  at: isoDate,
  /** 008 R3 — the head of the dev when the verdict came; `null` in files saved before. */
  commit: gitIdSchema.nullable().default(null),
  /** 008 R3 — the worktree of the dev differed from that commit. */
  dirty: z.boolean().default(false),
});
export type StoredReport = z.infer<typeof storedReportSchema>;

const ORDER = Object.keys(handoffReportFields.shape);

/** The fields missing or wrong in `input`, in the contract's order; `[]` for a valid report. */
export function missingFields(input: unknown): string[] {
  const result = handoffReportSchema.safeParse(input);
  if (result.success) return [];
  const fields = new Set(result.error.issues.map((issue) => String(issue.path[0] ?? 'issue')));
  return ORDER.filter((field) => fields.has(field));
}
