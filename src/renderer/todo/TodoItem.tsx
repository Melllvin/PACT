import { useState, type CSSProperties } from 'react';
import type { Agent, TodoItem as Todo } from '../../shared/model';
import { TileActions } from '../tiles/TileActions';
import { Button } from '@/components/ui/button';
import type { AgentActions } from '../workspace/WorkspaceView';
import { cn } from '@/lib/utils';

type Props = Partial<Omit<AgentActions, 'onClose'>> & {
  todo: Todo;
  /** Absent for a free terminal, which has no color nor actions. */
  agent: Agent | undefined;
};

const none = () => undefined;
const SEPARATOR = ' · ';
const LOCAL_VERB = '◎ Fusionner';

/**
 * One request, in the color of its agent, with the same buttons as its tile (FR-028). Its title
 * reads « what · who · hint »: 1f shows who above, with the agent's dot, and the hint below.
 */
export function TodoItem({ todo, agent, ...handlers }: Props) {
  const style = agent && ({ '--agent-color': `var(--agent-${agent.color})` } as CSSProperties);
  const [what, who, ...hints] = todo.title.split(SEPARATOR);
  const { usage } = todo;
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
        (todo.kind === 'delivery-local' ||
          todo.kind === 'delivery-review' ||
          todo.kind === 'publish-issues' ||
          todo.kind === 'decide') &&
          'border-primary/30 bg-primary/6',
        (todo.kind === 'rate-limit' ||
          todo.kind === 'loop-escalated' ||
          todo.kind === 'exchange-escalated') &&
          'border-destructive/30 bg-destructive/6',
        (todo.kind === 'delivery-silent-ci' || todo.kind === 'delivery-alert') &&
          'border-waiting/30 bg-waiting/6',
        usage?.level === 'warn' && 'border-waiting/30 bg-waiting/6',
        usage?.level === 'critical' && 'border-destructive/30 bg-destructive/6',
      )}
    >
      <span className="font-mono text-[12px] leading-[1.5] break-words text-foreground">
        {todo.kind === 'delivery-local' && what?.startsWith(LOCAL_VERB) ? (
          <>
            <span>{LOCAL_VERB}</span>
            <span>{what.slice(LOCAL_VERB.length)}</span>
          </>
        ) : (
          what
        )}
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
      {todo.detail !== undefined && <span className="text-[12px] text-dim">{todo.detail}</span>}
      <TodoActions todo={todo} agent={agent} {...handlers} />
    </li>
  );
}

type ActionsProps = Props;

/** The buttons of a request: the ones of its tile, and the ones of the requests of the column. */
export function TodoActions({
  todo,
  agent,
  onAnswer = none,
  onResume = none,
  onRestart = none,
  onLog = none,
  onCancelAutoResume = none,
  onReview,
  onDecideLoop,
  onDecideExchange,
  onConfirmPublish,
  onRefusePublish,
  onOpenTerminal,
  onUsageDetail,
  onDecide,
  onDecideDelivery,
  onOpenPr,
}: ActionsProps) {
  const { delivery, loop, publish, usage, decide, exchange } = todo;
  return (
    <>
      {delivery && agent && todo.kind === 'delivery-review' && (
        <DeliveryReview
          key={`${delivery.id}:${delivery.head}`}
          delivery={delivery}
          onDecide={(decision, reason) => {
            if (decision === 'validate') onDecideDelivery?.(delivery.id, decision, delivery.head);
            else onDecideDelivery?.(delivery.id, decision, delivery.head, reason);
          }}
          onOpen={() => {
            onOpenPr?.(delivery.id);
          }}
        />
      )}
      {delivery && agent && todo.kind === 'delivery-silent-ci' && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            onClick={() => {
              onDecideDelivery?.(delivery.id, 'wait', delivery.head);
            }}
          >
            Attendre encore
          </Button>
          <Button
            onClick={() => {
              onDecideDelivery?.(delivery.id, 'review', delivery.head);
              onOpenPr?.(delivery.id);
            }}
          >
            Relire
          </Button>
        </div>
      )}
      {delivery && agent && todo.kind === 'delivery-alert' && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            onClick={() => {
              onOpenPr?.(delivery.id);
            }}
          >
            Ouvrir la PR
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              onDecideDelivery?.(delivery.id, 'wait', delivery.head);
            }}
          >
            Compris
          </Button>
        </div>
      )}
      {delivery && agent && todo.kind === 'delivery-local' && (
        <DeliveryLocal
          onDecide={(decision) => {
            onDecideDelivery?.(delivery.id, decision, delivery.head);
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
            Relancer {String(loop.maxRounds ?? 3)} tours
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
      {exchange && (
        <>
          {/* The text of an agent: React text, never HTML (007 contracts/ui.md). */}
          {exchange.text !== '' && (
            <span className="text-[12px] break-words text-dim">{exchange.text}</span>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button
              onClick={() => {
                onDecideExchange?.(exchange.escalationId, 'resume');
              }}
            >
              Laisser reprendre
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                onDecideExchange?.(exchange.escalationId, 'cut');
              }}
            >
              Couper
            </Button>
          </div>
        </>
      )}
      {publish && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="accept"
            onClick={() => {
              onConfirmPublish?.(publish.requestId);
            }}
          >
            ✓ Créer
          </Button>
          <Button
            onClick={() => {
              onRefusePublish?.(publish.requestId);
            }}
          >
            Refuser
          </Button>
        </div>
      )}
      {usage && onUsageDetail && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            onClick={() => {
              onUsageDetail(todo.agentId);
            }}
          >
            Détail
          </Button>
        </div>
      )}
      {decide && agent && (
        <Decide
          questions={decide.questions}
          onSend={(text) => {
            onDecide?.(agent.id, text);
          }}
        />
      )}
      {agent &&
        todo.kind !== 'delivery-review' &&
        !delivery &&
        !loop &&
        !publish &&
        !decide &&
        !exchange && (
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
    </>
  );
}

/**
 * « ◎ Relire la PR #n »: the PR, its commit and its verdict, then Valider or Refuser (FR-013). One
 * click on Valider, then the button waits for the answer (FR-027); Refuser asks for a reason first.
 * The reason is the user's text, shown as React text only.
 */
function DeliveryReview({
  delivery,
  onDecide,
  onOpen,
}: {
  delivery: NonNullable<Todo['delivery']>;
  onDecide: (decision: 'validate' | 'refuse', reason?: string) => void;
  onOpen: () => void;
}) {
  const [sent, setSent] = useState(false);
  const [refusing, setRefusing] = useState(false);
  const [reason, setReason] = useState('');
  const blank = reason.trim() === '';
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12px] text-dim">
        {delivery.verdict === 'accepted' ? 'Verdict : accepté' : 'sans verdict'}
        {' · '}
        <span className="font-mono">{delivery.head.slice(0, 7)}</span>
      </span>
      {refusing && (
        <textarea
          aria-label="Motif du refus"
          rows={3}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          className="resize-none rounded-[10px] border border-white/8 bg-white/2 px-2.5 py-2 font-mono text-[12px] text-foreground outline-none focus-visible:border-primary/50"
        />
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="accept"
          disabled={sent}
          onClick={() => {
            setSent(true);
            onDecide('validate');
          }}
        >
          Valider
        </Button>
        <Button
          disabled={sent || (refusing && blank)}
          onClick={() => {
            if (!refusing) {
              setRefusing(true);
              return;
            }
            setSent(true);
            onDecide('refuse', reason.trim());
          }}
        >
          Refuser
        </Button>
        {delivery.url !== undefined && (
          <a
            href={delivery.url}
            rel="noreferrer"
            className="text-[12px] text-primary underline-offset-2 hover:underline"
            onClick={(event) => {
              event.preventDefault();
              onOpen();
            }}
          >
            Ouvrir la PR
          </a>
        )}
      </div>
    </div>
  );
}

/** « ◎ Fusionner <agent> → <main> ? »: one click, then the button waits for the answer (FR-027). */
function DeliveryLocal({
  onDecide,
  onReview,
}: {
  onDecide: (decision: 'validate' | 'refuse') => void;
  onReview: (() => void) | undefined;
}) {
  const [sent, setSent] = useState(false);
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button
        variant="accept"
        disabled={sent}
        onClick={() => {
          setSent(true);
          onDecide('validate');
        }}
      >
        Fusionner
      </Button>
      <Button
        onClick={() => {
          onDecide('refuse');
        }}
      >
        Refuser
      </Button>
      {onReview && (
        <Button variant="ghost" onClick={onReview}>
          Revue →
        </Button>
      )}
    </div>
  );
}

/** « ◆ Décider »: the questions of the agent, and the answer sent to it as a prompt. */
function Decide({ questions, onSend }: { questions: string[]; onSend: (text: string) => void }) {
  const [answer, setAnswer] = useState('');
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSend(answer.trim());
        setAnswer('');
      }}
    >
      <ol className="flex list-decimal flex-col gap-1 pl-4 text-[12px] text-foreground">
        {questions.map((question, index) => (
          <li key={index}>{question}</li>
        ))}
      </ol>
      <textarea
        aria-label="Réponse à l’agent"
        rows={3}
        value={answer}
        onChange={(event) => {
          setAnswer(event.target.value);
        }}
        className="resize-none rounded-[10px] border border-white/8 bg-white/2 px-2.5 py-2 font-mono text-[12px] text-foreground outline-none focus-visible:border-primary/50"
      />
      <div className="flex flex-wrap gap-1.5">
        <Button type="submit" variant="accept" disabled={answer.trim() === ''}>
          Envoyer
        </Button>
      </div>
    </form>
  );
}
