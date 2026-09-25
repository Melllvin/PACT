import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';

type Props = { branch: string; port: number };

/** ⎇: the branch the agent is on now, and its port, on hover or focus (FR-021). */
export function BranchTooltip({ branch, port }: Props) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const show = () => {
    setOpen(true);
  };
  const hide = () => {
    setOpen(false);
  };
  return (
    <span className="relative flex">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Branche et port"
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        ⎇
      </Button>
      {open && (
        <span
          role="tooltip"
          id={id}
          className="absolute top-[calc(100%+4px)] right-0 z-10 rounded-[5px] border border-border bg-card px-2 py-1 font-mono text-[11px] whitespace-nowrap text-foreground shadow-[0_8px_20px_rgb(0_0_0/40%)]"
        >
          {branch} · :{port}
        </span>
      )}
    </span>
  );
}
