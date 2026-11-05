import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { TerminalRegistry } from './terminal-registry';

type Props = {
  termId: string;
  registry: Pick<TerminalRegistry, 'attach'>;
  label: string;
  className?: string | undefined;
};

/** The body of a tile: the terminal registered for `termId`, attached while the tile is shown. */
export function TerminalView({ termId, registry, label, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return registry.attach(termId, ref.current);
  }, [termId, registry]);
  // xterm's fit counts the padding of the element it is opened in as free height: the margin is on
  // the labelled body, the terminal opens in an inner div without any (006 T022b).
  return (
    <div
      aria-label={label}
      className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', className)}
    >
      <div ref={ref} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
