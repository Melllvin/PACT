import { Children, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Props = {
  children: ReactNode;
  /** Opens the add menu from the free slot; without it, no slot is offered. */
  onAdd: (() => void) | undefined;
  /** 003 — the orchestrator's tile, on 2 columns × 2 rows top left (006 FR-010). */
  lead?: ReactNode;
};

const SLOT =
  'grid place-items-center rounded-[14px] border border-dashed border-white/10 text-[28px] font-extralight text-dim transition-[border-color,color] duration-300';

/** Rows of half the visible height, less half of the gap between two rows (`gap-3` = 0.75rem). */
const HALF_ROWS = 'auto-rows-[calc((100%_-_0.75rem)/2)]';

/** Without an orchestrator: 1 column for 1 tile, 2 for 2 or 4, 3 for the others (FR-010a). */
const plainColumns = (count: number) => (count === 4 ? 2 : Math.min(3, Math.max(1, count)));

/**
 * FR-010, FR-010a, FR-010b: one grid of at most 3 columns whose rows take half of the visible
 * height, so 3×2 tiles show at most and the rest is reached by scrolling vertically. One « + » only,
 * when the last row has a place left (screens 1f, 1l).
 */
export function TileGrid({ children, onAdd, lead }: Props) {
  const count = Children.count(children);
  const base = cn('grid h-full min-h-0 gap-3 overflow-y-auto overflow-x-hidden', HALF_ROWS);
  if (lead) {
    // The right column of the orchestrator takes the first two agents, rows of 3 follow.
    const free = count < 2 || (count - 2) % 3 !== 0;
    return (
      <div
        role="region"
        aria-label="Tuiles"
        data-layout="lead"
        className={base}
        style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
      >
        <div className="col-span-2 row-span-2 flex min-h-0 min-w-0 flex-col *:flex-1">{lead}</div>
        {children}
        {free && onAdd && <FreeSlot onAdd={onAdd} />}
      </div>
    );
  }
  const columns = plainColumns(count);
  const free = count % columns !== 0;
  const rows = Math.ceil((count + (free && onAdd ? 1 : 0)) / columns);
  return (
    <div
      role="region"
      aria-label="Tuiles"
      data-layout={`${String(columns)}x${String(Math.min(rows, 2))}`}
      className={base}
      style={{
        gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))`,
        // Up to two rows, they share the height: one tile takes the whole grid.
        ...(rows <= 2 && { gridTemplateRows: `repeat(${String(rows)}, minmax(0, 1fr))` }),
      }}
    >
      {children}
      {free && onAdd && <FreeSlot onAdd={onAdd} />}
    </div>
  );
}

function FreeSlot({ onAdd }: { onAdd: () => void }) {
  return (
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
  );
}
