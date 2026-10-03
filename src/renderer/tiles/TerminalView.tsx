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
  return (
    <div ref={ref} aria-label={label} className={cn('min-h-0 flex-1 overflow-hidden', className)} />
  );
}
