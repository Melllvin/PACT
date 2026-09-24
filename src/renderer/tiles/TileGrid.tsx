import { Children, type ReactNode } from 'react';
import styles from './tiles.module.css';

type Props = {
  children: ReactNode;
  /** Opens the add menu from a free slot; without it, free slots stay empty. */
  onAdd: (() => void) | undefined;
};

/** FR-019: 2×2 up to 4 tiles, 3×2 for 5 or 6; free slots offer « + » (screens 1f, 1l). */
export function TileGrid({ children, onAdd }: Props) {
  const count = Children.count(children);
  const layout = count <= 4 ? '2x2' : '3x2';
  const free = Math.max(0, (layout === '2x2' ? 4 : 6) - count);
  return (
    <div role="region" aria-label="Tuiles" data-layout={layout} className={styles.grid}>
      {children}
      {Array.from({ length: free }, (_, i) =>
        onAdd ? (
          <button key={i} className={styles.slot} aria-label="Ajouter un agent" onClick={onAdd}>
            +
          </button>
        ) : (
          <div key={i} className={styles.slot} aria-hidden />
        ),
      )}
    </div>
  );
}
