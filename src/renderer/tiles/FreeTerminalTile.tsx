import type { FreeTerminal } from '../../shared/model';
import { TerminalView } from './TerminalView';
import type { TerminalRegistry } from './terminal-registry';

type Props = {
  terminal: FreeTerminal;
  terminals: Pick<TerminalRegistry, 'attach'> | undefined;
};

/** A shell at the root of the main repository, in the grid with the agents (FR-025, T079). */
export function FreeTerminalTile({ terminal, terminals }: Props) {
  return (
    <article
      data-fx-shield
      aria-label="Terminal libre"
      className="relative flex min-h-0 min-w-0 flex-col rounded-[14px] border border-white/8 bg-surface"
    >
      {terminals && (
        <TerminalView
          termId={terminal.id}
          registry={terminals}
          label={`Shell dans ${terminal.cwd}`}
          className="px-4 pt-3.5 pb-8"
        />
      )}
      <span className="absolute right-3 bottom-2 left-4 truncate text-right font-mono text-[11px] text-dim">
        {terminal.cwd}
      </span>
    </article>
  );
}
