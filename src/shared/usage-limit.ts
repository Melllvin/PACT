import { z } from 'zod';
import { isoDate } from './primitives';
import { currentWindow, type UsageReading, type UsageState, type UsageWindow } from './usage';

// 009 data-model.md — the stop at a limit of consumption: the threshold of each window, the band it
// is in, and what is kept of a pause. Pure: shared by the main process and the renderer.

export const DEFAULT_STOP = 90;
export const MIN_STOP = 10;
export const MAX_STOP = 100;
/** FR-003 — the save instruction goes this many points before the threshold. */
export const SAVE_BAND = 3;
export const JUMP_STOP_MS = 60_000;
export const STALE_MARGIN = 10;
export const STALE_CHECK_MS = 60_000;

/** R2 — a threshold per CLI and per window id; a window absent from it stops at `DEFAULT_STOP`. */
export const usageStopsSchema = z
  .record(z.string().min(1), z.record(z.string().min(1), z.int().min(MIN_STOP).max(MAX_STOP)))
  .default({});
export type UsageStops = z.infer<typeof usageStopsSchema>;

export const stopOf = (stops: UsageStops, cliId: string, windowId: string): number =>
  stops[cliId]?.[windowId] ?? DEFAULT_STOP;

/** Windows Claude Code shows before any reading (R2). */
const CLAUDE_WINDOWS: readonly { id: string; label: string }[] = [
  { id: 'five-hour', label: '5 h' },
  { id: 'week', label: 'semaine' },
];

/** The windows to set a threshold on: those the readings of that CLI show, once each (R2). */
export function windowsOf(
  cliId: string,
  states: readonly UsageState[],
): { id: string; label?: string }[] {
  const seen = new Map<string, { id: string; label?: string }>();
  if (cliId === 'claude-code') for (const w of CLAUDE_WINDOWS) seen.set(w.id, { ...w });
  for (const state of states) {
    if (state.cliId !== cliId || !state.reading) continue;
    for (const w of state.reading.windows) {
      if (!seen.has(w.id)) seen.set(w.id, { id: w.id, label: w.label });
    }
  }
  return [...seen.values()];
}

export type LimitBand = {
  window: UsageWindow & { reset: boolean };
  stop: number;
  band: 'ok' | 'save' | 'stop';
};

/** R3 — each window by itself, read as it is now: a window reset since its reading is `ok`. */
export function limitBands(reading: UsageReading, stops: UsageStops, now: Date): LimitBand[] {
  return reading.windows.map((raw) => {
    const window = currentWindow(raw, now);
    const stop = stopOf(stops, reading.cliId, window.id);
    const band =
      window.usedPercent >= stop ? 'stop' : window.usedPercent >= stop - SAVE_BAND ? 'save' : 'ok';
    return { window, stop, band };
  });
}

export const usagePauseSchema = z.object({
  cliId: z.string().min(1),
  account: z.string().min(1),
  cause: z.enum(['threshold', 'stale']),
  windows: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        percent: z.number(),
        resetsAt: isoDate.nullable(),
      }),
    )
    .min(1),
  /** The latest of the `resetsAt`, null when one of them is unknown. */
  resumeAt: isoDate.nullable(),
  pausedAt: isoDate,
  /** The agent was in `WORKING_STATES` when stopped (FR-008). */
  midTurn: z.boolean(),
  /** No uncommitted change at the stop (Q9, Q10). */
  saved: z.boolean(),
  /** The question the stop closed, if there was one. */
  closedQuestion: z.string().max(200).nullable(),
  /** The resume waits for a gesture: unknown session (US2 sc.5). */
  blocked: z.enum(['session']).nullable(),
});
export type UsagePause = z.infer<typeof usagePauseSchema>;

export const usageSaveSchema = z.object({
  cliId: z.string(),
  account: z.string(),
  windowId: z.string(),
  /** The reset aimed at; null when unknown. */
  resetsAt: isoDate.nullable(),
  at: isoDate,
  agentIds: z.array(z.uuid()),
});
export type UsageSave = z.infer<typeof usageSaveSchema>;

export const usageOverrideSchema = z.object({
  cliId: z.string(),
  account: z.string(),
  /** null: until a reading shows a reset passed. */
  until: isoDate.nullable(),
  /** null: the whole account; else one agent. */
  agentId: z.uuid().nullable(),
});
export type UsageOverride = z.infer<typeof usageOverrideSchema>;

export const usageDeclinedSchema = z.object({
  cliId: z.string(),
  account: z.string(),
  readAt: isoDate,
  step: z.int().min(1),
});
export type UsageDeclined = z.infer<typeof usageDeclinedSchema>;

export const usageLimitStateSchema = z
  .object({
    saves: z.array(usageSaveSchema).default([]),
    overrides: z.array(usageOverrideSchema).default([]),
    declined: z.array(usageDeclinedSchema).default([]),
    /** Last resume per account, for rule O2. */
    resumed: z.array(z.object({ cliId: z.string(), account: z.string(), at: isoDate })).default([]),
  })
  .default({ saves: [], overrides: [], declined: [], resumed: [] });
export type UsageLimitState = z.infer<typeof usageLimitStateSchema>;
