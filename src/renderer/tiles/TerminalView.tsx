import { useEffect, useRef } from 'react';
import type { TerminalRegistry } from './terminal-registry';
import styles from './tiles.module.css';

type Props = { termId: string; registry: Pick<TerminalRegistry, 'attach'>; label: string };

/** The body of a tile: the terminal registered for `termId`, attached while the tile is shown. */
export function TerminalView({ termId, registry, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return registry.attach(termId, ref.current);
  }, [termId, registry]);
  return <div ref={ref} aria-label={label} className={styles.terminal} />;
}
