import { z } from 'zod';
import { gitIdSchema, isoDate } from './primitives';

// 008 data-model.md — the delivery of an accepted issue: schemas, constants (research R25) and the
// pure decisions (the truth table of the CI, the gate of `request_delivery`, the body of the PR).

/** The CI of a PR is read this often. */
export const CI_POLL_MS = 30_000;
/** A configured CI that shows no check for this long is signalled (FR-016). */
export const SILENT_CI_MS = 600_000;
/** A forge that fails to answer for this long is signalled. */
export const FORGE_DOWN_MS = 600_000;
/** Rebases without conflict in a row before the user is told (FR-017). */
export const MAX_REBASES_IN_A_ROW = 3;
/** A check name goes to the dev: bounded (R16). */
export const MAX_CHECK_NAME = 100;
/** The tail of a CI log given to the dev (R15). */
export const MAX_CI_LOG = 20_000;
/** A reason given by the user, or written by PACT (FR-014). */
export const MAX_REASON = 2_000;
export const MAX_ROUNDS_LIMIT = 10;
export const MAX_POLISH = 5;
export const MAX_POLISH_BRIEF = 2_000;

export const MERGE_MODES = ['squash', 'merge', 'rebase'] as const;
export const mergeModeSchema = z.enum(MERGE_MODES);
export type MergeMode = z.infer<typeof mergeModeSchema>;

/** `workspace.delivery`: the settings of the project (FR-020). */
export const deliverySettingsSchema = z.object({
  auto: z.boolean().default(false),
  mergeMode: mergeModeSchema.default('squash'),
  maxRounds: z.int().min(1).max(MAX_ROUNDS_LIMIT).default(3),
  polishPasses: z.int().min(0).max(MAX_POLISH).default(0),
  polishBrief: z.string().max(MAX_POLISH_BRIEF).default(''),
});
export type DeliverySettings = z.infer<typeof deliverySettingsSchema>;
export const defaultDeliverySettings = (): DeliverySettings => deliverySettingsSchema.parse({});

export const DELIVERY_STATES = [
  'checking',
  'refused',
  'syncing',
  'conflicted',
  'testing',
  'tests-failed',
  'pushing',
  'opening',
  'watching',
  'ci-red',
  'reviewing',
  'user-refused',
  'merging',
  'merged',
  'merge-failed',
  'dropped',
  'closed-on-forge',
] as const;
export const deliveryStateSchema = z.enum(DELIVERY_STATES);
export type DeliveryState = z.infer<typeof deliveryStateSchema>;

const FINAL_STATES: readonly string[] = [
  'refused',
  'conflicted',
  'tests-failed',
  'ci-red',
  'user-refused',
  'dropped',
  'closed-on-forge',
  'merged',
];

/** The request is over: a new one of the same branch may start, taking its PR over (R22). */
export function isFinalState(state: string): boolean {
  return FINAL_STATES.includes(state);
}

export const ciVerdictSchema = z.enum(['green', 'red', 'pending', 'silent', 'stalled', 'unknown']);
export type CiVerdict = z.infer<typeof ciVerdictSchema>;

export const ciCheckSchema = z.object({
  id: z.int(),
  name: z.string().max(MAX_CHECK_NAME),
  status: z.string(),
  conclusion: z.string().nullable(),
  /** The job of GitHub Actions behind the check, when there is one (R15). */
  job: z.int().nullable(),
});
export type CiCheck = z.infer<typeof ciCheckSchema>;

export const ciStatusSchema = z.object({
  head: gitIdSchema,
  configured: z.union([z.boolean(), z.literal('unknown')]),
  checks: z.array(ciCheckSchema),
  /** `null`: the protection could not be read. */
  required: z.array(z.string()).nullable(),
  verdict: ciVerdictSchema,
  emptySince: isoDate.nullable(),
  failingSince: isoDate.nullable(),
  rerun: z.array(z.int()),
  /** `<head>:<name>` of the checks rerun: a rerun renews the id of the job, never the name. */
  rerunKeys: z.array(z.string()).optional(),
  readAt: isoDate,
});
export type CiStatus = z.infer<typeof ciStatusSchema>;

/** `workspace.deliveries[]`: one request, written at every step (R2). */
export const deliverySchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  testAgentId: z.uuid().nullable(),
  issueId: z.string().min(1).nullable(),
  branch: z.string().min(1),
  target: z.string().min(1),
  channel: z.enum(['github', 'local']),
  unverified: z.boolean(),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(4000),
  frozenCommit: gitIdSchema,
  verdictCommit: gitIdSchema.nullable(),
  pactCommits: z.array(gitIdSchema),
  pushedHead: gitIdSchema.nullable(),
  rebases: z.int().nonnegative(),
  state: deliveryStateSchema,
  reason: z.string().nullable(),
  pr: z
    .object({
      number: z.int().positive(),
      url: z.string().min(1),
      expectedAuthor: z.string().min(1),
    })
    .nullable(),
  ci: ciStatusSchema.nullable(),
  review: z.object({ required: z.boolean(), refusedOnce: z.boolean() }),
  cleanup: z.enum(['none', 'pending', 'done', 'kept']),
  requestedBy: z.enum(['orchestrator', 'user']),
  at: isoDate,
  updatedAt: isoDate,
});
export type Delivery = z.infer<typeof deliverySchema>;

const OK_CONCLUSIONS = ['success', 'neutral', 'skipped'];
const STALLED_CONCLUSIONS = ['cancelled', 'timed_out', 'stale', 'action_required'];

/**
 * research R9, R10 — what the checks of a head commit say. Never `green` on a failed read.
 * With no check: green only when no CI is configured and the protection is readable (the proof of
 * PACT stands in, FR-015); a configuration PACT could not read counts as configured.
 * `required: null` (protection unreadable) with at least one check: one read and green is enough (P5).
 */
export function ciVerdict(input: {
  checks: readonly { name: string; status: string; conclusion: string | null }[];
  required: readonly string[] | null;
  configured: boolean | 'unknown';
  emptySince: string | null;
  now: string;
  readFailed: boolean;
}): CiVerdict {
  const { checks, required, configured, emptySince, now, readFailed } = input;
  if (readFailed) return 'unknown';
  if (checks.length === 0) {
    if (configured === false && required !== null && required.length === 0) return 'green';
    const waited = emptySince === null ? 0 : Date.parse(now) - Date.parse(emptySince);
    return waited >= SILENT_CI_MS ? 'silent' : 'pending';
  }
  const finished = (check: { status: string }) => check.status === 'completed';
  if (checks.some((c) => finished(c) && c.conclusion === 'failure')) return 'red';
  if (checks.some((c) => finished(c) && STALLED_CONCLUSIONS.includes(c.conclusion ?? ''))) {
    return 'stalled';
  }
  if (!checks.every(finished)) return 'pending';
  if (required?.some((name) => !checks.some((c) => c.name === name))) return 'pending';
  return checks.every((c) => OK_CONCLUSIONS.includes(c.conclusion ?? '')) ? 'green' : 'stalled';
}

const short = (sha: string | null) => (sha === null ? '(aucun)' : sha.slice(0, 7));
const MAX_LISTED = 10;
const list = (files: readonly string[]) => files.slice(0, MAX_LISTED).join(', ');

export type GateFacts = {
  issue: string | null;
  loopState: string | null;
  head: string;
  verdictCommit: string | null;
  proofCommit: string | null;
  uncommitted: readonly string[];
  missingTests: readonly string[];
  polish: { done: number; total: number } | null;
  inFlight: string | null;
  unverified: boolean;
};

/**
 * contracts/mcp-tools.md `request_delivery` — the barriers of the request, in the order of the
 * contract, each with its reason. A PR without a verdict (the user's gesture) needs no loop,
 * verdict, proof or tests of the tester, only a clean place (FR-001).
 */
export function deliveryGate(facts: GateFacts): { ok: true } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  const { head } = facts;
  if (!facts.unverified) {
    const issue = facts.issue ?? '(sans issue)';
    if (facts.loopState === 'polishing' && facts.polish && facts.polish.done < facts.polish.total) {
      return refuse(
        `Passe ${String(facts.polish.done + 1)} sur ${String(facts.polish.total)} à finir.`,
      );
    }
    if (facts.loopState !== 'accepted') {
      return refuse(`La boucle de ${issue} n’est pas acceptée (${facts.loopState ?? 'aucune'}).`);
    }
    if (facts.verdictCommit !== head) {
      return refuse(
        `Le verdict porte sur ${short(facts.verdictCommit)}, la tête est ${short(head)}.`,
      );
    }
    if (facts.proofCommit !== head) {
      return refuse(`Les tests de PACT n’ont pas validé ${short(head)}.`);
    }
  }
  if (facts.uncommitted.length > 0) {
    return refuse(`Changements non commités : ${list(facts.uncommitted)}.`);
  }
  if (!facts.unverified && facts.missingTests.length > 0) {
    return refuse(
      `Tests du testeur manquants : ${list(facts.missingTests)}. Consigne envoyée au dev.`,
    );
  }
  if (facts.inFlight !== null) {
    return refuse(`Une livraison est déjà en cours (${facts.inFlight}).`);
  }
  return { ok: true };
}

/**
 * contracts/gh.md — the body of the PR: the issue (its link when published, its text otherwise),
 * the verdict, the message of the request. A PR without a verdict says so on the first line.
 */
export function prBody(input: {
  issue: { id: string; remote: { number: number; url: string } | null; text: string } | null;
  message: string;
  verdict: { result: string; commit: string; tester: string } | null;
}): string {
  const lines: string[] = [];
  if (input.verdict === null) {
    lines.push('⚠ PR sans verdict : aucun testeur n’a validé ce commit.', '');
  }
  if (input.issue) {
    lines.push(`Issue : ${input.issue.id}`);
    lines.push(
      input.issue.remote ? `Closes #${String(input.issue.remote.number)}` : input.issue.text,
    );
    lines.push('');
  }
  if (input.verdict) {
    lines.push(
      `Verdict : ${input.verdict.result} sur ${short(input.verdict.commit)}, par ${input.verdict.tester}.`,
      '',
    );
  }
  lines.push(input.message);
  return lines.join('\n');
}

/** A check name as the dev reads it: no control character, at most `MAX_CHECK_NAME` characters. */
export function checkName(name: string): string {
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  // A cut must not leave half of a surrogate pair.
  return cleaned.slice(0, MAX_CHECK_NAME).replace(/[\uD800-\uDBFF]$/, '');
}
