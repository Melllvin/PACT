import { useEffect, useId, useState, type FocusEvent } from 'react';
import type { CliDefinition, Workspace } from '../../shared/model';
import {
  clockTime,
  currentWindow,
  DEFAULT_USAGE_THRESHOLDS,
  levelNow,
  readingAge,
  shownWindow,
  type UsageReading,
  type UsageState,
  type UsageThresholds,
} from '../../shared/usage';
import { UsageThresholdsDialog } from '../settings/UsageThresholds';
import { cn } from '@/lib/utils';

// 005 US1 — the usage limits of each CLI account of the workspace, in its bar (FR-001 to FR-009).

const LEVEL_COLOR: Record<UsageState['level'], string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-[var(--waiting)]',
  critical: 'bg-destructive',
};

const time = clockTime;

/** The key of an account: of its gauge, and of its alert in À faire (`usage:<cliId>:<account>`). */
export const usageKey = (state: Pick<UsageState, 'cliId' | 'account'>) =>
  `usage:${state.cliId}:${state.account}`;

/**
 * The clock of the gauges: a tick every 30 s, since the age of a reading moves on without a new
 * one; a reading fresher than the last tick moves it on.
 */
export function useUsageClock(usage: readonly UsageState[]): Date {
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      setTick(new Date());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return new Date(
    Math.max(
      tick.getTime(),
      ...usage.map((state) => (state.reading ? Date.parse(state.reading.readAt) : 0)),
    ),
  );
}

/** « réinitialisation 16:40 », with the day when it is not today (system time zone). */
function resetText(iso: string | null, now: Date): string {
  if (iso === null) return 'réinitialisation inconnue';
  const date = new Date(iso);
  const sameDay = date.toDateString() === now.toDateString();
  const day = date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  return `réinitialisation ${sameDay ? '' : `${day} `}${time(iso)}`;
}

const percent = (value: number) => `${String(Math.round(value))} %`;

/** The accounts the workspace shows: those of the CLIs of its agents, read less than 1 h ago. */
export function workspaceGauges(
  workspace: Pick<Workspace, 'agents'>,
  usage: readonly UsageState[],
  now: Date,
): (UsageState & { reading: UsageReading })[] {
  const clis = new Set(workspace.agents.map((agent) => agent.cliId));
  return usage.filter(
    (state): state is UsageState & { reading: UsageReading } =>
      state.reading !== null && clis.has(state.cliId) && !readingAge(state.reading, now).hidden,
  );
}

type Props = {
  state: UsageState & { reading: UsageReading };
  cliName: string;
  now: Date;
  thresholds?: UsageThresholds;
  /** Kept open by a click, or by « Détail » of its alert in À faire; its own state without. */
  pinned?: boolean;
  onPinnedChange?: (pinned: boolean) => void;
  /** « Seuils d’alerte… » in its detail (FR-010). */
  onThresholds?: () => void;
};

export function UsageGauge({
  state,
  cliName,
  now,
  thresholds = DEFAULT_USAGE_THRESHOLDS,
  pinned: shownPinned,
  onPinnedChange,
  onThresholds,
}: Props) {
  // Open while hovered or focused; a click keeps it open until another one, Échap or a blur.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [ownPinned, setOwnPinned] = useState(false);
  const pinned = shownPinned ?? ownPinned;
  const setPinned = (next: boolean) => {
    setOwnPinned(next);
    onPinnedChange?.(next);
  };
  const open = hovered || focused || pinned;
  // The level now, with the thresholds of the moment: a window reset since is no alert any more.
  const level = levelNow(state, thresholds, now);
  const close = () => {
    setHovered(false);
    setFocused(false);
    setPinned(false);
  };
  const detailId = useId();
  const { reading } = state;
  const shown = shownWindow(reading, now);
  const age = readingAge(reading, now);
  const value = Math.round(shown.usedPercent);
  const label = `${cliName} ${percent(shown.usedPercent)} · ${shown.label}`;
  return (
    <div
      className="relative"
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        // Within the gauge, from its button to « Seuils d’alerte… », it stays open.
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setFocused(false);
        setPinned(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => {
          // Hovering opened it: the click keeps it open; a second one closes it.
          if (pinned) close();
          else setPinned(true);
        }}
        className={cn(
          'flex h-8 items-center gap-2 rounded-[9px] border border-white/6 bg-white/3 px-2.5 text-[12px]',
          age.stale && 'opacity-50',
        )}
      >
        <span
          role="meter"
          aria-label={`Limite d’usage ${cliName}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(value, 100)}
          aria-valuetext={`${percent(shown.usedPercent)} de la fenêtre ${shown.label}${
            level === 'ok'
              ? ''
              : level === 'warn'
                ? ', proche de la limite'
                : ', limite presque atteinte'
          }`}
          data-level={level}
          className="relative h-1.5 w-10 overflow-hidden rounded-full bg-white/10"
        >
          <span
            className={cn('absolute inset-y-0 left-0', LEVEL_COLOR[level])}
            style={{ width: `${String(Math.min(value, 100))}%` }}
          />
        </span>
        <span className="usage-gauge-long whitespace-nowrap">{label}</span>
        <span className="usage-gauge-short whitespace-nowrap">{percent(shown.usedPercent)}</span>
        {age.stale && (
          <span className="whitespace-nowrap text-muted-foreground">
            lu il y a {age.minutes} min
          </span>
        )}
      </button>
      {open && (
        <section
          id={detailId}
          aria-label={`Détail de l’usage ${cliName}`}
          className="absolute right-0 top-9 z-20 w-72 rounded-xl border border-white/10 bg-popover p-3 text-[12px] shadow-lg"
        >
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {reading.windows.map((raw) => {
              const window = currentWindow(raw, now);
              return (
                <li key={window.id}>
                  <strong>{window.label}</strong> : {percent(window.usedPercent)} ·{' '}
                  {window.reset ? 'réinitialisée' : resetText(window.resetsAt, now)}
                </li>
              );
            })}
          </ul>
          <p className="mb-0 mt-2 text-muted-foreground">Lu à {time(reading.readAt)}</p>
          {onThresholds && (
            <button
              type="button"
              onClick={onThresholds}
              className="mt-2 cursor-pointer text-[12px] text-primary hover:underline"
            >
              Seuils d’alerte…
            </button>
          )}
        </section>
      )}
    </div>
  );
}

/** Every gauge of the workspace; nothing without a reading (FR-006). */
export function UsageGauges({
  workspace,
  usage,
  clis,
  now,
  thresholds = DEFAULT_USAGE_THRESHOLDS,
  detail = null,
  onDetail,
  onThresholds,
}: {
  workspace: Pick<Workspace, 'agents'>;
  usage: readonly UsageState[];
  clis: readonly Pick<CliDefinition, 'id' | 'name'>[];
  now: Date;
  thresholds?: UsageThresholds;
  /** The account whose detail « Détail » of À faire opened (`usageKey`). */
  detail?: string | null;
  onDetail?: (key: string | null) => void;
  onThresholds?: (thresholds: UsageThresholds) => void;
}) {
  const [editing, setEditing] = useState(false);
  const gauges = workspaceGauges(workspace, usage, now);
  if (gauges.length === 0) return null;
  return (
    <div role="group" aria-label="Limites d’usage" className="flex items-center gap-2">
      {gauges.map((state) => {
        const key = usageKey(state);
        return (
          <UsageGauge
            key={key}
            state={state}
            cliName={clis.find((cli) => cli.id === state.cliId)?.name ?? state.cliId}
            now={now}
            thresholds={thresholds}
            {...(onDetail && {
              pinned: detail === key,
              onPinnedChange: (pinned: boolean) => {
                onDetail(pinned ? key : null);
              },
            })}
            {...(onThresholds && {
              onThresholds: () => {
                setEditing(true);
              },
            })}
          />
        );
      })}
      {editing && onThresholds && (
        <UsageThresholdsDialog
          thresholds={thresholds}
          onSave={onThresholds}
          onClose={() => {
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}
