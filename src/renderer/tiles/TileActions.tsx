import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentState, ScheduledResume } from '../../shared/model';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';

export type TileActionHandlers = {
  onAnswer: (answer: 'allow' | 'deny') => void;
  onResume: () => void;
  onRestart: () => void;
  onLog: () => void;
  /** « Annuler » of « reprise auto à HH:MM » (FR-036). */
  onCancelAutoResume: () => void;
  /** « Toujours pour ce worktree », offered in the Focus only (FR-034). */
  onAlways?: (() => void) | undefined;
  /** « Revue → », given only for an agent with changes to review (002 FR-002). */
  onReview?: (() => void) | undefined;
  /** « Répondre dans le terminal ↗ »: the Focus on the agent's terminal (FR-024a). */
  onOpenTerminal?: (() => void) | undefined;
};

/**
 * 008 — « Livrer » / « Intégrer » of a dev, by remote and loop (contracts/ui.md). `accepted`: the
 * agent is the dev of an accepted loop; `title`: the issue title, or the branch.
 */
export type DeliveryAction = {
  remote: boolean;
  accepted: boolean;
  title: string;
  onRequest: (request: { title: string; message: string; unverified: boolean }) => void;
};

/** The ⋮ menu of a tile and of the Focus (006): « Faire orchestrateur » and « Renommer ». */
export type TileMenu = {
  /** US5 — `reason`: why the option is unavailable; `working`: the agent restarts mid-task. */
  promote?: { reason: string | null; working: boolean; onConfirm: () => void } | undefined;
  /** #45 */
  rename?: { name: string; onRename: (name: string) => void } | undefined;
};

const GROUP = 'flex flex-none flex-wrap items-center justify-end gap-1.5';

/**
 * Bottom right of a tile, by state (FR-024): answer a question, or recover from an error. Solid
 * green and red to answer, cyan to resume (1f, 1n).
 */
export function TileActions({ menu, ...props }: TileActionsProps) {
  if (!menu || (!menu.promote && !menu.rename)) return <StateActions {...props} />;
  return (
    <span className={GROUP}>
      <StateActions {...props} />
      <MoreActions menu={menu} />
    </span>
  );
}

type TileActionsProps = TileActionHandlers & {
  state: AgentState;
  /** The agent asks a question to choose from, not a permission (FR-024a). */
  question?: boolean;
  scheduledResume?: ScheduledResume | null;
  /** 006 — the ⋮ menu; absent: no menu. */
  menu?: TileMenu | undefined;
  /** 008 — the delivery actions; absent: none. */
  delivery?: DeliveryAction | undefined;
};

/** « Plus d’actions »: the menu, the confirmation of the promotion and the field of the rename. */
function MoreActions({ menu }: { menu: TileMenu }) {
  const [asking, setAsking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const { promote, rename } = menu;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Plus d’actions">
            ⋮
          </Button>
        </DropdownMenuTrigger>
        {/* The focus goes to what the choice opens, not back to the button. */}
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          {promote && (
            <DropdownMenuItem
              disabled={promote.reason !== null}
              onSelect={() => {
                setAsking(true);
              }}
            >
              <span className="flex flex-col">
                Faire orchestrateur
                {promote.reason !== null && (
                  <span className="text-[11px] text-muted-foreground">{promote.reason}</span>
                )}
              </span>
            </DropdownMenuItem>
          )}
          {rename && (
            <DropdownMenuItem
              onSelect={() => {
                setRenaming(true);
              }}
            >
              Renommer
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {rename && renaming && (
        <RenameField
          name={rename.name}
          onDone={(next) => {
            setRenaming(false);
            if (next !== null) rename.onRename(next);
          }}
        />
      )}
      {promote && asking && (
        <Dialog
          open
          onOpenChange={() => {
            setAsking(false);
          }}
        >
          <DialogContent aria-describedby={undefined} className="w-[min(440px,calc(100vw-32px))]">
            <DialogBody>
              <DialogTitle>Faire orchestrateur ?</DialogTitle>
              <DialogDescription>
                L’agent pilotera les autres agents du workspace. Il redémarre pour recevoir son
                accès d’orchestrateur, dans la même session.
                {promote.working &&
                  ' Il travaille : sa tâche en cours sera interrompue au redémarrage.'}
              </DialogDescription>
            </DialogBody>
            <DialogFooter className="justify-end">
              <Button
                variant="ghost"
                size="md"
                onClick={() => {
                  setAsking(false);
                }}
              >
                Annuler
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={() => {
                  setAsking(false);
                  promote.onConfirm();
                }}
              >
                Confirmer
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/** Enter keeps the name, Escape drops it; an empty name keeps the field open. */
function RenameField({ name, onDone }: { name: string; onDone: (next: string | null) => void }) {
  const [value, setValue] = useState(name);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(onDone);
  useLayoutEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    // The menu that opened the field hands the focus back on its own time: take it after.
    const focus = setTimeout(() => field.current?.select(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      done.current(null);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      clearTimeout(focus);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
  return (
    <Input
      ref={field}
      aria-label="Nom de l’agent"
      className="h-7 w-40 text-[12.5px]"
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && value.trim() !== '') onDone(value.trim());
      }}
    />
  );
}

function StateActions({
  state,
  onAnswer,
  onResume,
  onRestart,
  onLog,
  onCancelAutoResume,
  onAlways,
  onReview,
  onOpenTerminal,
  delivery,
  question = false,
  scheduledResume = null,
}: Omit<TileActionsProps, 'menu'>) {
  // A question is answered in the CLI: its options are its own, PACT types nothing (FR-024a).
  if (state === 'awaiting-answer' && question) {
    return (
      <span className={GROUP}>
        {onOpenTerminal && (
          <Button variant="accept" onClick={onOpenTerminal}>
            Répondre dans le terminal ↗
          </Button>
        )}
      </span>
    );
  }
  if (state === 'awaiting-answer') {
    return (
      <span className={GROUP}>
        {onAlways && <Button onClick={onAlways}>Toujours pour ce worktree</Button>}
        <Button
          variant="danger"
          onClick={() => {
            onAnswer('deny');
          }}
        >
          ✕ Refuser
        </Button>
        <Button
          variant="accept"
          onClick={() => {
            onAnswer('allow');
          }}
        >
          ✓ Autoriser
        </Button>
      </span>
    );
  }
  // 006 FR-025: closed with its orchestrator, the tile stays and can start again.
  if (state === 'closed') {
    return (
      <span className={GROUP}>
        <Button onClick={onLog}>Journal</Button>
        <Button variant="primary" onClick={onRestart}>
          Relancer
        </Button>
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className={GROUP}>
        {scheduledResume && (
          <>
            <span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground">
              reprise auto à {resumeTime(scheduledResume)}
            </span>
            <Button variant="link" onClick={onCancelAutoResume}>
              Annuler
            </Button>
          </>
        )}
        <Button onClick={onLog}>Journal</Button>
        <Button onClick={onRestart}>Relancer</Button>
        <Button variant="primary" onClick={onResume}>
          Reprendre
        </Button>
      </span>
    );
  }
  if ((onReview ?? delivery) && (state === 'done' || state === 'awaiting-prompt')) {
    return (
      <span className={GROUP}>
        {delivery && <DeliveryButtons delivery={delivery} />}
        {onReview && (
          <Button variant="primary" onClick={onReview}>
            Revue →
          </Button>
        )}
      </span>
    );
  }
  return null;
}

/** HH:MM in the local time zone, as the rate limit banners of the CLIs give it. */
function resumeTime({ at }: ScheduledResume) {
  return new Date(at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

const NEEDS_LOOP = 'demande une boucle acceptée';

/** « Livrer » / « Intégrer », and their no-verdict twin when the agent has no accepted loop. */
function DeliveryButtons({ delivery }: { delivery: DeliveryAction }) {
  const { remote, accepted, title } = delivery;
  const [asking, setAsking] = useState<'verified' | 'unverified' | null>(null);
  const main = remote ? 'Livrer' : 'Intégrer';
  const twin = remote ? 'Créer la PR sans verdict' : 'Fusionner sans verdict';
  return (
    <>
      <Button
        variant="primary"
        disabled={!accepted}
        title={accepted ? undefined : NEEDS_LOOP}
        aria-description={accepted ? undefined : NEEDS_LOOP}
        onClick={() => {
          setAsking('verified');
        }}
      >
        {main}
      </Button>
      {!accepted && (
        <>
          <span className="sr-only">{NEEDS_LOOP}</span>
          <Button
            onClick={() => {
              setAsking('unverified');
            }}
          >
            {twin}
          </Button>
        </>
      )}
      {asking !== null && remote && (
        <RequestDialog
          title={title}
          unverified={asking === 'unverified'}
          onClose={() => {
            setAsking(null);
          }}
          onRequest={delivery.onRequest}
        />
      )}
      {asking !== null && !remote && (
        <Dialog
          open
          onOpenChange={() => {
            setAsking(null);
          }}
        >
          <DialogContent aria-describedby={undefined} className="w-[min(440px,calc(100vw-32px))]">
            <DialogBody>
              <DialogTitle>
                {asking === 'unverified' ? 'Fusionner sans verdict ?' : 'Intégrer ?'}
              </DialogTitle>
              <DialogDescription>
                {asking === 'unverified'
                  ? 'Aucun testeur n’a donné de verdict : la fusion te sera demandée, sans preuve.'
                  : 'La fusion te sera demandée dans À faire.'}
              </DialogDescription>
            </DialogBody>
            <DialogFooter className="justify-end">
              <Button
                variant="ghost"
                size="md"
                onClick={() => {
                  setAsking(null);
                }}
              >
                Annuler
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={() => {
                  setAsking(null);
                  delivery.onRequest({
                    title,
                    message: title,
                    unverified: asking === 'unverified',
                  });
                }}
              >
                Confirmer
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/** The title (pre-filled) and the message of the pull request. */
function RequestDialog({
  title: initial,
  unverified,
  onClose,
  onRequest,
}: {
  title: string;
  unverified: boolean;
  onClose: () => void;
  onRequest: DeliveryAction['onRequest'];
}) {
  const [title, setTitle] = useState(initial);
  const [message, setMessage] = useState('');
  const ready = title.trim() !== '' && message.trim() !== '';
  return (
    <Dialog
      open
      onOpenChange={() => {
        onClose();
      }}
    >
      <DialogContent aria-describedby={undefined} className="w-[min(480px,calc(100vw-32px))]">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            onClose();
            onRequest({ title: title.trim(), message: message.trim(), unverified });
          }}
        >
          <DialogBody>
            <DialogTitle>{unverified ? 'Créer la PR sans verdict' : 'Livrer'}</DialogTitle>
            <label className="flex flex-col gap-1 text-[12.5px]">
              Titre
              <Input
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-[12.5px]">
              Message
              <textarea
                rows={3}
                value={message}
                onChange={(event) => {
                  setMessage(event.target.value);
                }}
                className="resize-none rounded-[10px] border border-white/8 bg-white/2 px-2.5 py-2 font-mono text-[12px] text-foreground outline-none focus-visible:border-primary/50"
              />
            </label>
          </DialogBody>
          <DialogFooter className="justify-end">
            <Button type="button" variant="ghost" size="md" onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" variant="primary" size="md" disabled={!ready}>
              Demander
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
