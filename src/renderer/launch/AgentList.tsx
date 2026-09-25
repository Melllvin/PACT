import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { differences, move, preview, type LaunchDraft } from '../../shared/launch-draft';
import type { Agent } from '../../shared/model';
import { cn } from '@/lib/utils';

/** What the inspector shows: `'common'`, or one agent by its draft key. */
export type Selection = string;

type AgentListProps = {
  draft: LaunchDraft;
  onChange: (draft: LaunchDraft) => void;
  running: Pick<Agent, 'position' | 'color'>[];
  cliName: (cliId: string) => string;
  selected: Selection;
  onSelect: (selection: Selection) => void;
  canAdd: boolean;
  onAdd: () => void;
};

const ITEM = 'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left';

/**
 * Left of 1d: « ⚑ Commun à tous », then the agents in the color of their future tile. Their order
 * is the order of the tiles: drag the handle, or move it with ↑ / ↓ (US6 scenario 4).
 */
export function AgentList({
  draft,
  onChange,
  running,
  cliName,
  selected,
  onSelect,
  canAdd,
  onAdd,
}: AgentListProps) {
  const places = preview(draft, running);
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const dragged = useRef<number | null>(null);
  // A moved handle keeps the focus, so ↑ / ↓ can be pressed again.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useEffect(() => {
    if (focusKey) handles.current.get(focusKey)?.focus();
  }, [focusKey, draft]);

  const moveBy = (index: number, key: string) => (event: KeyboardEvent) => {
    const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null;
    if (to === null) return;
    event.preventDefault();
    if (to < 0 || to >= draft.agents.length) return;
    onChange(move(draft, index, to));
    setFocusKey(key);
  };

  return (
    <nav className="flex min-h-0 flex-col gap-2 border-r border-border pr-3">
      <button
        className={cn(ITEM, 'border border-border', selected === 'common' && 'bg-accent')}
        aria-current={selected === 'common'}
        onClick={() => {
          onSelect('common');
        }}
      >
        <span aria-hidden>⚑</span>
        <span className="flex-1 font-semibold">Commun à tous</span>
        <span className="text-xs text-muted-foreground">4 réglages</span>
      </button>
      <p className="mt-2 text-xs tracking-wide text-muted-foreground uppercase">
        {`Agents · ${String(draft.agents.length)}`}
      </p>
      <ol aria-label="Agents" className="flex min-h-0 flex-col gap-1 overflow-auto">
        {draft.agents.map((agent, index) => {
          const color = places[index]?.color;
          const changed = differences(draft, index).length;
          const name = cliName(agent.cliId);
          return (
            <li
              key={agent.key}
              style={
                {
                  '--agent-color': color ? `var(--agent-${color})` : 'var(--border)',
                } as CSSProperties
              }
              className={cn(
                'flex items-center gap-1 rounded-sm border-l-4 border-(--agent-color)',
                selected === agent.key && 'bg-accent',
              )}
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const from = dragged.current;
                dragged.current = null;
                if (from !== null && from !== index) onChange(move(draft, from, index));
              }}
            >
              <button
                ref={(element) => {
                  if (element) handles.current.set(agent.key, element);
                  else handles.current.delete(agent.key);
                }}
                aria-label={`Déplacer ${name}`}
                draggable
                className="cursor-grab px-1 text-muted-foreground"
                onDragStart={(event) => {
                  dragged.current = index;
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', agent.key);
                }}
                onKeyDown={moveBy(index, agent.key)}
              >
                ⋮⋮
              </button>
              <button
                className={ITEM}
                aria-current={selected === agent.key}
                onClick={() => {
                  onSelect(agent.key);
                }}
              >
                <span className="flex flex-1 flex-col">
                  <span>{name}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {`${agent.branch ?? 'branche auto'} · ${agent.port ? `:${String(agent.port)}` : 'port auto'}`}
                  </span>
                </span>
                {changed > 0 && (
                  <span className="rounded-sm border border-border px-1 text-xs">{`≠ ${String(changed)}`}</span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
      <button className={cn(ITEM, 'text-muted-foreground')} disabled={!canAdd} onClick={onAdd}>
        + Ajouter un agent
      </button>
      <p className="text-xs text-muted-foreground">Glisser = ordre des tuiles.</p>
    </nav>
  );
}
