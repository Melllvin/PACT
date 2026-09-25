import { Children, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Props = {
  children: ReactNode;
  /** Opens the add menu from a free slot; without it, free slots stay empty. */
  onAdd: (() => void) | undefined;
};

const SLOT =
  'grid place-items-center rounded-[14px] border border-dashed border-white/10 text-[28px] font-extralight text-dim transition-[border-color,color] duration-300';

/** FR-019: 2×2 up to 4 tiles, 3×2 for 5 or 6; free slots offer « + » (screens 1f, 1l). */
export function TileGrid({ children, onAdd }: Props) {
  const count = Children.count(children);
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
      {Array.from({ length: free }, (_, i) =>
        onAdd ? (
          <button
            key={i}
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
          <div key={i} className={SLOT} aria-hidden />
        ),
      )}
    </div>
  );
}
