import type { UsageWindow } from '../../shared/usage';
import { epochToIso, FIVE_HOURS, isRecord, numberOr, WEEK, type UsageSample } from './sample';

// 005 R1, contracts/sources.md — the JSON Claude Code sends its statusLine command: the limits of
// the account under `rate_limits`, the tokens of the session under `context_window`.

const KNOWN: Record<string, { id: string; label: string; minutes: number }> = {
  five_hour: { id: 'five-hour', label: '5 h', minutes: FIVE_HOURS },
  seven_day: { id: 'week', label: 'semaine', minutes: WEEK },
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** `seven_day_opus` → « semaine · Opus »: a window per model, named after its key. */
function windowOf(key: string, limit: Record<string, unknown>): UsageWindow | null {
  if (typeof limit.used_percentage !== 'number' || limit.used_percentage < 0) return null;
  const known = KNOWN[key];
  const base = Object.entries(KNOWN).find(([prefix]) => key.startsWith(`${prefix}_`));
  const model = base ? capitalize(key.slice(base[0].length + 1).replaceAll('_', ' ')) : null;
  return {
    id: known?.id ?? key,
    label: known?.label ?? (base && model ? `${base[1].label} · ${model}` : key),
    usedPercent: limit.used_percentage,
    resetsAt: epochToIso(limit.resets_at),
    minutes: known?.minutes ?? base?.[1].minutes ?? null,
  };
}

/** What a statusLine payload tells; `null` when it is not one. Never throws. */
export function parseStatusline(payload: unknown): UsageSample | null {
  if (!isRecord(payload)) return null;
  const context = isRecord(payload.context_window) ? payload.context_window : {};
  const tokens = numberOr(context.total_input_tokens, 0) + numberOr(context.total_output_tokens, 0);
  const limits = isRecord(payload.rate_limits) ? payload.rate_limits : {};
  const windows = Object.entries(limits)
    .map(([key, limit]) => (isRecord(limit) ? windowOf(key, limit) : null))
    .filter((window) => window !== null);
  return { windows: windows.length > 0 ? windows : null, tokens };
}
