import type { CSSProperties } from 'react';
import type { Agent } from '../../shared/model';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

type Props = {
  agents: Agent[];
  current: string;
  name: (cliId: string) => string;
  onSelect: (agentId: string) => void;
};

/** Screen 1p: one pill per agent, in its color, to change agent without the grid (US5). */
export function AgentPills({ agents, current, name, onSelect }: Props) {
  return (
    <ToggleGroup
      type="single"
      aria-label="Agents"
      value={current}
      onValueChange={(agentId) => {
        // Pressing the current pill again keeps it.
        if (agentId) onSelect(agentId);
      }}
      className="gap-1.5"
    >
      {agents.map((agent) => {
        const waiting = agent.state === 'awaiting-answer';
        return (
          <ToggleGroupItem
            key={agent.id}
            value={agent.id}
            aria-label={`${name(agent.cliId)} ${String(agent.position)}${waiting ? ', attend votre réponse' : ''}`}
            style={{ '--agent-color': `var(--agent-${agent.color})` } as CSSProperties}
            className="h-7 gap-1.5 rounded-lg border border-white/8 px-2 data-[state=on]:border-(--agent-color) data-[state=on]:bg-white/5"
          >
            <span aria-hidden className="size-2 rounded-full bg-(--agent-color)" />
            {waiting && (
              <span aria-hidden className="text-[10px] text-waiting">
                ◆
              </span>
            )}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
