import { useState, type CSSProperties } from 'react';
import type { Agent, TodoItem as Todo } from '../../shared/model';
import { TileActions } from '../tiles/TileActions';
import { Button } from '@/components/ui/button';
import type { AgentActions } from '../workspace/WorkspaceView';
import { cn } from '@/lib/utils';

type Props = Omit<AgentActions, 'onClose'> & {
  todo: Todo;
  /** Absent for a free terminal, which has no color nor actions. */
  agent: Agent | undefined;
};

const SEPARATOR = ' · ';

/**
 * One request, in the color of its agent, with the same buttons as its tile (FR-028). Its title
 * reads « what · who · hint »: 1f shows who above, with the agent's dot, and the hint below.
 */
export function TodoItem({
  todo,
  agent,
  onAnswer,
  onResume,
  onRestart,
  onLog,
  onCancelAutoResume,
  onReview,
  onConfirmIntegration,
  onRefuseIntegration,
  onDecideLoop,
  onOpenTerminal,
}: Props) {
  const style = agent && ({ '--agent-color': `var(--agent-${agent.color})` } as CSSProperties);
  const [what, who, ...hints] = todo.title.split(SEPARATOR);
  const { request, loop } = todo;
  const separator = <span className="sr-only">{SEPARATOR}</span>;

  if (todo.kind === 'info') {
    return (
      <li
        data-kind={todo.kind}
        style={style}
        className="mt-auto border-t border-white/6 pt-3 text-[12px] text-dim"
      >
        {todo.title}
      </li>
    );
  }
  return (
    <li
      data-kind={todo.kind}
      style={style}
      className={cn(
        'flex origin-top animate-unfold flex-col gap-2.5 overflow-hidden rounded-xl border border-white/6 bg-surface p-3 motion-reduce:animate-none',
        todo.kind === 'answer' && 'border-waiting/30 bg-waiting/6',
        todo.kind === 'integration-request' && 'border-primary/30 bg-primary/6',
        (todo.kind === 'rate-limit' || todo.kind === 'loop-escalated') &&
          'border-destructive/30 bg-destructive/6',
        todo.kind === 'overlap' && 'border-waiting/30 bg-waiting/6',
      )}
    >
      <span className="font-mono text-[12px] leading-[1.5] break-words text-foreground">
        {what}
      </span>
      {who !== undefined && (
        <span className="order-first flex items-center gap-2 text-[12px] text-[#a1a1aa]">
          {separator}
          <span aria-hidden className="size-[7px] flex-none rounded-full bg-(--agent-color)" />
          <span className="min-w-0 truncate">{who}</span>
        </span>
      )}
      {hints.length > 0 && (
        <span className="text-[12px] text-dim">
          {separator}
          <span>{hints.join(SEPARATOR)}</span>
        </span>
      )}
      {request && agent && (
        <IntegrationRequest
          request={request}
          onConfirm={(message) => {
            onConfirmIntegration?.(request.id, message);
          }}
          onRefuse={() => {
            onRefuseIntegration?.(request.id);
          }}
          onReview={
            onReview &&
            (() => {
              onReview(agent.id);
            })
          }
        />
      )}
      {loop && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            onClick={() => {
              onDecideLoop?.(loop.issueId, 'restart');
            }}
          >
            Relancer 3 tours
          </Button>
          <Button
            onClick={() => {
              onDecideLoop?.(loop.issueId, 'take-over');
            }}
          >
            Reprendre la main
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              onDecideLoop?.(loop.issueId, 'abandon');
            }}
          >
            Abandonner
          </Button>
        </div>
      )}
      {agent && !request && !loop && todo.kind !== 'overlap' && (
        <TileActions
          state={agent.state}
          question={todo.actions.includes('open-terminal')}
          scheduledResume={agent.scheduledResume}
          onAnswer={(answer) => {
            onAnswer(agent.id, answer);
          }}
          onOpenTerminal={
            onOpenTerminal
              ? () => {
                  onOpenTerminal(agent.id);
                }
              : undefined
          }
          onResume={() => {
            onResume(agent.id);
          }}
          onRestart={() => {
            onRestart(agent.id);
          }}
          onLog={() => {
            onLog(agent.id);
          }}
          onCancelAutoResume={() => {
            onCancelAutoResume(agent.id);
          }}
          onReview={
            todo.kind === 'review' && onReview
              ? () => {
                  onReview(agent.id);
                }
              : undefined
          }
        />
      )}
    </li>
  );
}

/** « ◎ Intégrer <agent> → <main> ? »: the message stays the user's to change (003 FR-018). */
function IntegrationRequest({
  request,
  onConfirm,
  onRefuse,
  onReview,
}: {
  request: { id: string; message: string };
  onConfirm: (message: string) => void;
  onRefuse: () => void;
  onReview: (() => void) | undefined;
}) {
  const [message, setMessage] = useState(request.message);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm(message.trim());
      }}
    >
      <textarea
        aria-label="Message de commit"
        rows={2}
        value={message}
        onChange={(event) => {
          setMessage(event.target.value);
        }}
        className="resize-none rounded-[10px] border border-white/8 bg-white/2 px-2.5 py-2 font-mono text-[12px] text-foreground outline-none focus-visible:border-primary/50"
      />
      <div className="flex flex-wrap gap-1.5">
        <Button type="submit" variant="accept" disabled={message.trim() === ''}>
          ✓ Intégrer
        </Button>
        <Button type="button" onClick={onRefuse}>
          Refuser
        </Button>
        {onReview && (
          <Button type="button" variant="ghost" onClick={onReview}>
            Revue →
          </Button>
        )}
      </div>
    </form>
  );
}
