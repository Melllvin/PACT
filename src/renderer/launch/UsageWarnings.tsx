import { cn } from '@/lib/utils';

/** 005 FR-012 — a CLI of the launch near its usage limit; the launch stays the user's choice. */
export type UsageWarning = { cli: string; text: string };

export function UsageWarnings({
  warnings,
  className,
}: {
  warnings: readonly UsageWarning[];
  className?: string;
}) {
  return warnings.map(({ cli, text }) => (
    <p
      key={cli}
      role="note"
      aria-label={`Limite d’usage ${cli}`}
      className={cn(
        'm-0 rounded-[5px] border border-waiting/30 bg-waiting/6 px-2.5 py-2 text-[12.5px] text-muted-foreground',
        className,
      )}
    >
      <strong className="font-semibold text-foreground">{cli}</strong> · {text}
    </p>
  ));
}
