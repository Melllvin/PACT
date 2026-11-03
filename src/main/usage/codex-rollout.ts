import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { UsageWindow } from '../../shared/usage';
import {
  epochToIso,
  FIVE_HOURS,
  isRecord,
  numberOr,
  WEEK,
  windowLabel,
  type UsageSample,
} from './sample';

// 005 R2, contracts/sources.md — Codex writes its session in
// `$CODEX_HOME/sessions/AAAA/MM/JJ/rollout-*-<session>.jsonl`; its `token_count` events carry the
// limits of the account. PACT only reads the file.

/** How often a followed rollout is read again, at most (R2). */
export const ROLLOUT_INTERVAL_MS = 10_000;

function windowOf(limit: unknown): UsageWindow | null {
  if (!isRecord(limit) || typeof limit.used_percent !== 'number' || limit.used_percent < 0) {
    return null;
  }
  const minutes =
    typeof limit.window_minutes === 'number' && limit.window_minutes > 0
      ? Math.round(limit.window_minutes)
      : null;
  const id =
    minutes === FIVE_HOURS ? 'five-hour' : minutes === WEEK ? 'week' : `${String(minutes)}m`;
  return {
    id,
    label: windowLabel(minutes) ?? id,
    usedPercent: limit.used_percent,
    resetsAt: epochToIso(limit.resets_at),
    minutes,
  };
}

type TokenCount = { windows: UsageWindow[] | null; tokens: number | null };

function tokenCountOf(line: string): TokenCount | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(event) || !isRecord(event.payload) || event.payload.type !== 'token_count') {
    return null;
  }
  const { info, rate_limits: limits } = event.payload;
  const usage = isRecord(info) && isRecord(info.total_token_usage) ? info.total_token_usage : null;
  const windows = isRecord(limits)
    ? [windowOf(limits.primary), windowOf(limits.secondary)].filter((w) => w !== null)
    : [];
  return {
    windows: windows.length > 0 ? windows : null,
    tokens: usage ? numberOr(usage.input_tokens, 0) + numberOr(usage.output_tokens, 0) : null,
  };
}

/**
 * The latest the rollout tells: the limits of its last `token_count` that has some, the tokens of
 * its last one that has them. `null` without either. Unreadable lines are skipped.
 */
export function lastRolloutSample(text: string): UsageSample | null {
  let windows: UsageWindow[] | null = null;
  let tokens: number | null = null;
  for (const line of text.split('\n').reverse()) {
    const count = line.trim() === '' ? null : tokenCountOf(line);
    if (!count) continue;
    windows ??= count.windows;
    tokens ??= count.tokens;
    if (windows && tokens !== null) break;
  }
  return windows === null && tokens === null ? null : { windows, tokens: tokens ?? 0 };
}

/** The rollout of `sessionId` under `codexHome`, or null while Codex has not written it. */
export async function findRollout(codexHome: string, sessionId: string): Promise<string | null> {
  const suffix = `-${sessionId}.jsonl`;
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    // The latest days first: a resumed session may have older days too.
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      const path = join(dir, entry.name);
      if (depth < 3 && entry.isDirectory()) {
        const found = await walk(path, depth + 1);
        if (found) return found;
      } else if (depth === 3 && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) {
        return path;
      }
    }
    return null;
  };
  return walk(join(codexHome, 'sessions'), 0);
}

/** Follows the rollout of one Codex session, read only, at most every `intervalMs`. */
export class CodexRollout {
  private timer: ReturnType<typeof setInterval> | undefined;
  private file: string | null = null;
  private size = -1;
  private reading = false;
  private stopped = false;

  constructor(
    private readonly options: {
      codexHome: string;
      sessionId: string;
      onSample: (sample: UsageSample) => void;
      intervalMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    void this.read();
    this.timer = setInterval(
      () => void this.read(),
      this.options.intervalMs ?? ROLLOUT_INTERVAL_MS,
    );
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads the file again when it grew; a failure keeps the last sample (FR-007). */
  async read(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      this.file ??= await findRollout(this.options.codexHome, this.options.sessionId);
      if (!this.file) return;
      const { size } = await stat(this.file);
      if (size === this.size) return;
      this.size = size;
      const sample = lastRolloutSample(await readFile(this.file, 'utf8'));
      if (sample && !this.stopped) this.options.onSample(sample);
    } catch {
      // The file may be rotated or locked for a moment: the next read tries again.
    } finally {
      this.reading = false;
    }
  }
}
