import type { FreeTerminal } from '../../shared/model';
import { TerminalView } from './TerminalView';
import type { TerminalRegistry } from './terminal-registry';
import styles from './tiles.module.css';

type Props = {
  terminal: FreeTerminal;
  terminals: Pick<TerminalRegistry, 'attach'> | undefined;
};

/** A shell at the root of the main repository, in the grid with the agents (FR-025, T079). */
export function FreeTerminalTile({ terminal, terminals }: Props) {
  return (
    <article aria-label="Terminal libre" className={styles.tile}>
      {terminals && (
        <TerminalView
          termId={terminal.id}
          registry={terminals}
          label={`Shell dans ${terminal.cwd}`}
        />
      )}
      <footer className={styles.bar}>
        <span className={styles.meta}>{terminal.cwd}</span>
      </footer>
    </article>
  );
}
