import { z } from 'zod';
import { isoDate, roleSchema } from './primitives';
import type { UsagePause } from './usage-limit';

// 005 data-model.md — the usage limits of a CLI account, as the CLI reports them, and what the
// gauge derives from them (R4, R6). Pure: shared by the main process and the renderer.

export const usageThresholdsSchema = z
  .object({ warn: z.int().min(1).max(99), critical: z.int().min(2).max(100) })
  .refine(({ warn, critical }) => warn < critical, {
    message: 'Le seuil d’alerte doit être sous le seuil critique.',
  });
export type UsageThresholds = z.infer<typeof usageThresholdsSchema>;

export const DEFAULT_USAGE_THRESHOLDS: UsageThresholds = { warn: 80, critical: 95 };

export const usageWindowSchema = z.object({
  /** `five-hour`, `week`, or the CLI's own key for a window per model. */
  id: z.string().min(1),
  /** « 5 h », « semaine », « semaine · Opus ». */
  label: z.string().min(1),
  /** Can exceed 100 when the CLI says so. */
  usedPercent: z.number().min(0),
  resetsAt: isoDate.nullable(),
  /** Length of the window, `null` when unknown: breaks ties for the shortest (R4). */
  minutes: z.int().positive().nullable(),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const usageReadingSchema = z.object({
  cliId: z.string().min(1),
  /** The account key (R3): `default`, or the CLI's configuration folder. */
  account: z.string().min(1),
  windows: z.array(usageWindowSchema).min(1),
  readAt: isoDate,
});
export type UsageReading = z.infer<typeof usageReadingSchema>;

export const agentShareSchema = z.object({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  label: z.string(),
  role: roleSchema.nullable(),
  /** Tokens since the start of the current window (R5). */
  tokens: z.number().min(0),
  closed: z.boolean(),
});
export type AgentShare = z.infer<typeof agentShareSchema>;

export const usageLevelSchema = z.enum(['ok', 'warn', 'critical']);
export type UsageLevel = z.infer<typeof usageLevelSchema>;

/** The `usage:state` event: one per account. */
export const usageStateSchema = z.object({
  cliId: z.string().min(1),
  account: z.string().min(1),
  reading: usageReadingSchema.nullable(),
  shares: z.array(agentShareSchema),
  level: usageLevelSchema,
});
export type UsageState = z.infer<typeof usageStateSchema>;

export const STALE_MINUTES = 15;
export const HIDDEN_MINUTES = 60;

export function usageLevel(percent: number, { warn, critical }: UsageThresholds): UsageLevel {
  if (percent >= critical) return 'critical';
  return percent >= warn ? 'warn' : 'ok';
}

/** A window as it is now: once its reset time has passed, « réinitialisée » at 0 % (R4). */
export function currentWindow(window: UsageWindow, now: Date): UsageWindow & { reset: boolean } {
  const reset = window.resetsAt !== null && Date.parse(window.resetsAt) <= now.getTime();
  return reset ? { ...window, usedPercent: 0, reset } : { ...window, reset };
}

/** The window the gauge shows: the most used, the shortest at equal use (R4). */
export function shownWindow(reading: UsageReading, now: Date): UsageWindow & { reset: boolean } {
  const length = (w: UsageWindow) => w.minutes ?? Number.POSITIVE_INFINITY;
  const windows = reading.windows.map((w) => currentWindow(w, now));
  return windows.reduce((best, w) =>
    w.usedPercent > best.usedPercent ||
    (w.usedPercent === best.usedPercent && length(w) < length(best))
      ? w
      : best,
  );
}

/** How old a reading is: greyed out after 15 minutes, hidden after 60 (FR-008). */
export function readingAge(reading: UsageReading, now: Date) {
  const minutes = Math.floor((now.getTime() - Date.parse(reading.readAt)) / 60_000);
  return { minutes, stale: minutes > STALE_MINUTES, hidden: minutes > HIDDEN_MINUTES };
}

/** « 16:40 », in the system time zone. */
export const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/**
 * 005 FR-010, FR-011 — the window an account is near its limit on, now: its level read again
 * with the thresholds of the moment, so a window reset since its reading is no alert any more.
 * Null at `ok`, or for a reading hidden by its age.
 */
export function usageAlert(state: UsageState, thresholds: UsageThresholds, now: Date) {
  if (!state.reading || readingAge(state.reading, now).hidden) return null;
  const window = shownWindow(state.reading, now);
  const level = usageLevel(window.usedPercent, thresholds);
  return level === 'ok' ? null : { window, level, percent: Math.round(window.usedPercent) };
}

/** The level of an account now, as its gauge shows it (FR-010). */
export const levelNow = (state: UsageState, thresholds: UsageThresholds, now: Date): UsageLevel =>
  usageAlert(state, thresholds, now)?.level ?? 'ok';

/**
 * 005 FR-012 — the warning of a launch of agents of `cliId`, the same for the launcher and for
 * `launch_agent`: « Limite 5 h à 85 % : ces agents risquent de s'arrêter avant 16:40 ». Null
 * when no account of that CLI is near its limit. It never blocks the launch.
 */
export function launchWarning(
  states: readonly UsageState[],
  cliId: string,
  thresholds: UsageThresholds,
  now: Date,
  pauses: readonly Pick<UsagePause, 'cliId' | 'windows' | 'resumeAt'>[] = [],
): string | null {
  const paused = pauses.find((pause) => pause.cliId === cliId);
  const pausedText = paused ? pauseWarning(paused) : null;
  const warning = usageWarning(states, cliId, thresholds, now);
  return pausedText !== null && warning !== null
    ? `${pausedText} ${warning}`
    : (pausedText ?? warning);
}

/** 009 R12 — « PACT est en pause sur la limite 5 h jusqu'à 16:40 : … », said before the warning of 005. */
export function pauseWarning({
  windows,
  resumeAt,
}: Pick<UsagePause, 'windows' | 'resumeAt'>): string {
  const until = resumeAt === null ? 'sa réinitialisation' : clockTime(resumeAt);
  return `PACT est en pause sur la limite ${windows.map((w) => w.label).join(' et ')} jusqu'à ${until} : ces agents ne seront pas arrêtés avant la réinitialisation.`;
}

function usageWarning(
  states: readonly UsageState[],
  cliId: string,
  thresholds: UsageThresholds,
  now: Date,
): string | null {
  const alerts = states.flatMap((state) =>
    state.cliId === cliId ? (usageAlert(state, thresholds, now) ?? []) : [],
  );
  const worst = alerts.reduce<(typeof alerts)[number] | null>(
    (best, alert) => (best === null || alert.percent > best.percent ? alert : best),
    null,
  );
  if (!worst) return null;
  const { window, percent } = worst;
  const until = window.resetsAt === null ? 'sa réinitialisation' : clockTime(window.resetsAt);
  return `Limite ${window.label} à ${String(percent)} % : ces agents risquent de s’arrêter avant ${until}`;
}

/** One row of the parts of a workspace (FR-013): an agent and its percentage of PACT's tokens. */
export type WorkspaceShare = Pick<AgentShare, 'agentId' | 'label' | 'role' | 'closed'> & {
  percent: number;
};

/**
 * 005 FR-013, R5 — the part of each agent of `workspaceId` in the tokens PACT counted for the
 * account, the largest first; the agents of the other workspaces are « autres ». Null before any
 * token is counted.
 */
export function workspaceShares(
  shares: readonly AgentShare[],
  workspaceId: string,
): { agents: WorkspaceShare[]; others: number } | null {
  const total = shares.reduce((sum, share) => sum + share.tokens, 0);
  if (total === 0) return null;
  const part = (tokens: number) => Math.round((tokens / total) * 100);
  const own = shares.filter((share) => share.workspaceId === workspaceId);
  const others = shares
    .filter((share) => share.workspaceId !== workspaceId)
    .reduce((sum, share) => sum + share.tokens, 0);
  return {
    agents: [...own]
      .sort((a, b) => b.tokens - a.tokens)
      .map(({ agentId, label, role, closed, tokens }) => ({
        agentId,
        label,
        role,
        closed,
        percent: part(tokens),
      })),
    others: part(others),
  };
}
