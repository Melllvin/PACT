import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type Props = { branch: string; port: number };

/** ⎇: the branch the agent is on now, and its port, on hover or focus (FR-021). */
export function BranchTooltip({ branch, port }: Props) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Branche et port">
          ⎇
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end">
        {branch} · :{port}
      </TooltipContent>
    </Tooltip>
  );
}
