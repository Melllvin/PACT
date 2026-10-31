import { Children, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Props = {
  children: ReactNode;
  /** Opens the add menu from a free slot; without it, free slots stay empty. */
  onAdd: (() => void) | undefined;
  /** 003 — the orchestrator's tile, on top and centred; the others go below (R10). */
  lead?: ReactNode;
};

/** Six agents in all: with the lead on top, five at most below. */
const BELOW_LEAD = 5;

const SLOT =
  'grid place-items-center rounded-[14px] border border-dashed border-white/10 text-[28px] font-extralight text-dim transition-[border-color,color] duration-300';

/** FR-019: 2×2 up to 4 tiles, 3×2 for 5 or 6; free slots offer « + » (screens 1f, 1l). */
export function TileGrid({ children, onAdd, lead }: Props) {
  const count = Children.count(children);
  if (lead) {
    const free = Math.max(0, BELOW_LEAD - count);
    const columns = Math.min(3, Math.max(1, count + free));
    return (
      <div
        role="region"
        aria-label="Tuiles"
        data-layout="lead"
        className="grid h-full grid-rows-[minmax(240px,3fr)_minmax(180px,2fr)] gap-3"
      >
        <section aria-label="Orchestrateur" className="flex min-h-0 justify-center">
          <div className="flex min-h-0 w-full max-w-[1100px] flex-col *:flex-1">{lead}</div>
        </section>
        <section
          aria-label="Agents dirigés"
          className="grid min-h-0 auto-rows-[minmax(180px,1fr)] gap-3"
          style={{ gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))` }}
        >
          {children}
          {Array.from({ length: free }, (_, i) => (
            <FreeSlot key={i} onAdd={onAdd} />
          ))}
        </section>
      </div>
    );
  }
  const layout = count <= 4 ? '2x2' : '3x2';
  const free = Math.max(0, (layout === '2x2' ? 4 : 6) - count);
  return (
    <div
      role="region"
      aria-label="Tuiles"
      data-layout={layout}
      className={cn(
        'grid h-full auto-rows-[minmax(200px,1fr)] gap-3',
        layout === '2x2' ? 'grid-cols-2' : 'grid-cols-3',
      )}
    >
      {children}
      {Array.from({ length: free }, (_, i) => (
        <FreeSlot key={i} onAdd={onAdd} />
      ))}
    </div>
  );
}

function FreeSlot({ onAdd }: { onAdd: (() => void) | undefined }) {
  return onAdd ? (
    <button
      className={cn(
        SLOT,
        'cursor-pointer outline-none hover:border-white/30 hover:text-foreground focus-visible:border-primary/60 focus-visible:text-foreground',
      )}
      aria-label="Ajouter un agent"
      onClick={onAdd}
    >
      +
    </button>
  ) : (
    <div className={SLOT} aria-hidden />
  );
}
