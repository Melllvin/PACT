import { cn } from '@/lib/utils';

/** Spec edge case « modifications non commitées »: worktrees start from the committed base (T122). */
export function LocalChangesNotice({ className }: { className?: string }) {
  return (
    <p
      role="note"
      className={cn(
        'm-0 rounded-[5px] border border-waiting/30 bg-waiting/6 px-2.5 py-2 text-[12.5px] text-muted-foreground',
        className,
      )}
    >
      Vos modifications locales non commitées ne seront pas incluses : les agents partent de la
      branche de base commitée.
    </p>
  );
}
