import type { UsageWindow } from '../../shared/usage';

// 005 contracts/sources.md — what one source tells at one time: the limits of the account, when
// the CLI gives them, and the tokens of the agent's session (R5).

export type UsageSample = {
  /** `null`: no limits in this sample (an API key, or before a first answer). */
  windows: UsageWindow[] | null;
  /** Input and output tokens of the session so far. */
  tokens: number;
};

export const FIVE_HOURS = 300;
export const WEEK = 10_080;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const numberOr = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Seconds since the epoch, as both CLIs write them, to an ISO date. */
export const epochToIso = (value: unknown): string | null =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;

/** The label of a window of `minutes`: « 5 h », « semaine », « N h ». */
export function windowLabel(minutes: number | null): string | null {
  if (minutes === FIVE_HOURS) return '5 h';
  if (minutes === WEEK) return 'semaine';
  return minutes === null ? null : `${String(Math.round(minutes / 60))} h`;
}
