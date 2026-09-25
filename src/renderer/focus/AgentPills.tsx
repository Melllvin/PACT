import type { CSSProperties } from 'react';
import type { Agent } from '../../shared/model';
import { cn } from '@/lib/utils';

type Props = {
  agents: Agent[];
  current: string;
  name: (cliId: string) => string;
  onSelect: (agentId: string) => void;
};

/** Screen 1p: one pill per agent, in its color, to change agent without the grid (US5). */
export function AgentPills({ agents, current, name, onSelect }: Props) {
  return (
    <div role="group" aria-label="Agents" className="flex gap-1.5">
      {agents.map((agent) => {
        const waiting = agent.state === 'awaiting-answer';
        const selected = agent.id === current;
        return (
          <button
            key={agent.id}
            aria-label={`${name(agent.cliId)} ${String(agent.position)}${waiting ? ', attend votre réponse' : ''}`}
            aria-pressed={selected}
            onClick={() => {
              onSelect(agent.id);
            }}
            style={{ '--agent-color': `var(--agent-${agent.color})` } as CSSProperties}
            className={cn(
              'flex cursor-pointer items-center gap-1.5 rounded-[5px] border border-white/8 px-2 py-1',
              selected && 'border-(--agent-color) bg-secondary',
            )}
          >
            <span aria-hidden className="size-2 rounded-full bg-(--agent-color)" />
            {waiting && (
              <span aria-hidden className="text-[10px] text-waiting">
                ◆
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
