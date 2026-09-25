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
      aria-label="Terminal libre"
      className="relative flex min-h-0 min-w-0 flex-col rounded-md border-2 border-border bg-[#0a0d12]"
    >
      {terminals && (
        <TerminalView
          termId={terminal.id}
          registry={terminals}
          label={`Shell dans ${terminal.cwd}`}
          className="px-3 pt-2.5 pb-7"
        />
      )}
      <span className="absolute right-2.5 bottom-1.5 left-3 truncate text-right font-mono text-[10.5px] text-muted-foreground">
        {terminal.cwd}
      </span>
    </article>
  );
}
