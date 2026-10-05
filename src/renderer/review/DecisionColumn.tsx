import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { WORKING_STATES, type Agent } from '../../shared/model';
import type { IntegrationMode, ReviewSnapshot, TestRun } from '../../shared/review';
import type { IntegrateRequest } from '../store/review-store';
import { isSeen } from './FileList';

type Props = {
  agent: Agent;
  snapshot: ReviewSnapshot | null;
  mainBranch: string;
  /** The last test run of the agent, if any. */
  tests: TestRun | null;
  /** An integration of this agent is in progress. */
  busy: boolean;
  error: { message: string; files: string[] } | null;
  onRunTests: () => void;
  onCancelTests: () => void;
  onSetTestCommand: (command: string) => void;
  onIntegrate: (request: IntegrateRequest) => void;
};

const STATE: Partial<Record<Agent['state'], string>> = {
  'awaiting-prompt': 'attend une consigne',
  working: 'travaille encore',
  'awaiting-answer': 'attend votre réponse',
  done: 'a terminé son tour',
  error: 'est en erreur',
};

const MODES: Record<IntegrationMode, string> = {
  squash: 'Squash en 1 commit',
  'keep-commits': 'Garder les commits',
};

const OK = 'text-accept';
const KO = 'text-destructive';
const DIM = 'text-dim';
const ROW = 'm-0 flex items-center gap-2 text-[12px]';

function Row({ mark, tone, children }: { mark: string; tone: string; children: React.ReactNode }) {
  return (
    <p className={ROW}>
      <span aria-hidden className={`w-3 flex-none text-center ${tone}`}>
        {mark}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

/** The Tests line of screen 1h, with what can be done from it (FR-016, FR-017). */
function TestsLine({
  run,
  snapshot,
  onRunTests,
  onCancelTests,
  onSetTestCommand,
}: {
  run: TestRun | null;
  snapshot: ReviewSnapshot;
} & Pick<Props, 'onRunTests' | 'onCancelTests' | 'onSetTestCommand'>) {
  const [command, setCommand] = useState('');
  const configured = snapshot.testCommand !== null;
  if (run?.status === 'running') {
    return (
      <Row mark="◌" tone={DIM}>
        Tests : en cours…{' '}
        <Button variant="link" size="sm" className="h-auto" onClick={onCancelTests}>
          <span className="sr-only">Annuler les tests</span>
          <span aria-hidden>annuler</span>
        </Button>
      </Row>
    );
  }
  if (!run && !configured) {
    return (
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          onSetTestCommand(command.trim());
        }}
      >
        <Row mark="○" tone={DIM}>
          Tests : non configurés
        </Row>
        <div className="flex gap-1.5">
          <Input
            aria-label="Commande de test"
            placeholder="npm test"
            value={command}
            onChange={(event) => {
              setCommand(event.target.value);
            }}
            className="h-7 font-mono text-[12px]"
          />
          <Button type="submit" disabled={command.trim() === ''}>
            Enregistrer
          </Button>
        </div>
      </form>
    );
  }
  if (!run) {
    return (
      <Row mark="○" tone={DIM}>
        Tests : non lancés{' '}
        <Button variant="link" size="sm" className="h-auto" onClick={onRunTests}>
          Lancer
        </Button>
      </Row>
    );
  }
  const result = {
    passed: {
      mark: '✓',
      tone: OK,
      text:
        run.passedCount === null ? 'Tests réussis' : `Tests : ${String(run.passedCount)} réussis`,
    },
    failed: { mark: '✕', tone: KO, text: 'Tests en échec' },
    timeout: { mark: '✕', tone: KO, text: 'Tests : délai dépassé' },
    cancelled: { mark: '○', tone: DIM, text: 'Tests : annulés' },
  }[run.status];
  const output = run.status === 'failed' || run.status === 'timeout';
  return (
    <div className="flex flex-col gap-1.5">
      <Row mark={result.mark} tone={result.tone}>
        {result.text}
        {run.tree !== snapshot.tree && (
          <span className="text-dim"> · avant les derniers changements</span>
        )}{' '}
        {configured && (
          <Button variant="link" size="sm" className="h-auto" onClick={onRunTests}>
            Relancer
          </Button>
        )}
      </Row>
      {output && (
        <pre className="m-0 max-h-40 overflow-auto rounded-lg border border-white/6 bg-black/30 p-2 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
          {run.outputTail.trimEnd()}
        </pre>
      )}
    </div>
  );
}

function ConflictsLine({
  conflicts,
  main,
}: {
  conflicts: ReviewSnapshot['conflicts'];
  main: string;
}) {
  if (conflicts === 'checking') {
    return (
      <Row mark="◌" tone={DIM}>
        Conflits : vérification…
      </Row>
    );
  }
  if (conflicts === 'none') {
    return (
      <Row mark="✓" tone={OK}>
        Aucun conflit avec {main}
      </Row>
    );
  }
  const count = conflicts.length;
  return (
    <Row mark="✕" tone={KO}>
      {count} {count === 1 ? 'conflit' : 'conflits'} avec {main}
    </Row>
  );
}

/** The message proposed: the first line of the agent's prompt, else its branch (spec). */
const proposedMessage = (agent: Agent, branch: string) =>
  agent.initialPrompt
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '') ?? `Intègre ${branch}`;

/** « Intégrer dans main » (FR-019, FR-024, FR-025). */
function Integrate({
  agent,
  snapshot,
  mainBranch,
  busy,
  onIntegrate,
}: Pick<Props, 'agent' | 'mainBranch' | 'busy' | 'onIntegrate'> & { snapshot: ReviewSnapshot }) {
  const [mode, setMode] = useState<IntegrationMode>('squash');
  const [message, setMessage] = useState(() => proposedMessage(agent, snapshot.branch));
  const [closeTile, setCloseTile] = useState(true);
  const [removeWorktree, setRemoveWorktree] = useState(true);
  /** The request held while the user confirms an agent still working. */
  const [held, setHeld] = useState<IntegrateRequest | null>(null);
  const ready = !busy && message.trim() !== '';

  const submit = (after: IntegrateRequest['after']) => {
    const request = { mode, message: message.trim(), after };
    if (WORKING_STATES.includes(agent.state)) setHeld(request);
    else onIntegrate(request);
  };

  return (
    <section aria-label={`Intégrer dans ${mainBranch}`} className="flex flex-col gap-2">
      <h3 className="m-0 font-mono text-[10px] font-semibold tracking-[.08em] text-muted-foreground uppercase">
        Intégrer dans {mainBranch}
      </h3>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button className="justify-between">{MODES[mode]} ▾</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={mode}
            onValueChange={(value) => {
              setMode(value as IntegrationMode);
            }}
          >
            <DropdownMenuRadioItem value="squash">{MODES.squash}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="keep-commits">
              {MODES['keep-commits']}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <textarea
        aria-label="Message du commit"
        rows={2}
        value={message}
        onChange={(event) => {
          setMessage(event.target.value);
        }}
        className="resize-none rounded-[10px] border border-white/8 bg-white/2 px-2.5 py-2 text-[12.5px] text-foreground outline-none focus-visible:border-primary/50"
      />
      <label className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <Checkbox
          checked={closeTile}
          onCheckedChange={(value) => {
            setCloseTile(value === true);
          }}
        />
        Fermer la tuile et son serveur :{agent.port}
      </label>
      <label className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <Checkbox
          checked={closeTile && removeWorktree}
          disabled={!closeTile}
          onCheckedChange={(value) => {
            setRemoveWorktree(value === true);
          }}
        />
        Supprimer worktree et branche
      </label>
      <Button
        variant="accept"
        size="md"
        disabled={!ready}
        onClick={() => {
          submit({ closeTile, removeWorktree: closeTile && removeWorktree });
        }}
      >
        {busy ? 'Intégration…' : '✓ Intégrer'}
      </Button>
      <Button
        disabled={!ready}
        onClick={() => {
          submit({ closeTile: false, removeWorktree: false });
        }}
      >
        Conserver le worktree
      </Button>
      {held && (
        <div
          role="alertdialog"
          aria-label="L’agent travaille encore"
          className="flex flex-col gap-2 rounded-xl border border-white/8 bg-surface p-3 text-[12.5px]"
        >
          <p className="m-0">
            L’agent travaille encore. Ses derniers changements ne seront pas inclus.
          </p>
          <div className="flex gap-1.5">
            <Button
              variant="accept"
              onClick={() => {
                setHeld(null);
                onIntegrate({ ...held, confirmWorking: true });
              }}
            >
              Intégrer quand même
            </Button>
            <Button
              onClick={() => {
                setHeld(null);
              }}
            >
              Annuler
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Takes the place of À faire while a review is open (FR-004): what to know about the agent's
 * changes, then their integration into main (screen 1h).
 */
export function DecisionColumn({
  agent,
  snapshot,
  mainBranch,
  tests,
  busy,
  error,
  onRunTests,
  onCancelTests,
  onSetTestCommand,
  onIntegrate,
}: Props) {
  const files = snapshot?.files ?? [];
  const unseen = files.filter((file) => !isSeen(file, agent.review.seen)).length;
  const state = STATE[agent.state];
  const reviewable = snapshot !== null && !snapshot.missing && files.length > 0;
  return (
    <aside
      aria-label="Décision"
      className="relative z-10 flex w-[300px] flex-none flex-col gap-2.5 overflow-y-auto border-l border-white/6 bg-background px-4 py-[18px]"
    >
      <h2 className="m-0 px-0.5 pb-1.5 text-[15px] font-medium tracking-[-0.01em]">Décision</h2>
      {reviewable && (
        <div className="flex flex-col gap-2">
          <TestsLine
            run={tests}
            snapshot={snapshot}
            onRunTests={onRunTests}
            onCancelTests={onCancelTests}
            onSetTestCommand={onSetTestCommand}
          />
          <ConflictsLine conflicts={snapshot.conflicts} main={mainBranch} />
          {unseen === 0 ? (
            <Row mark="✓" tone={OK}>
              Tous les fichiers sont vus
            </Row>
          ) : (
            <Row mark="○" tone={DIM}>
              {unseen} {unseen === 1 ? 'fichier non vu' : 'fichiers non vus'}
            </Row>
          )}
        </div>
      )}
      {state && (
        <Row mark="●" tone="text-primary">
          Agent : {state}
        </Row>
      )}
      {reviewable && (
        <>
          <div aria-hidden className="my-1 h-px bg-white/6" />
          <Integrate
            // A new agent reviewed starts from its own proposals.
            key={agent.id}
            agent={agent}
            snapshot={snapshot}
            mainBranch={mainBranch}
            busy={busy}
            onIntegrate={onIntegrate}
          />
        </>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/8 px-3 py-2.5 text-[12.5px]"
        >
          {error.message}
          {error.files.length > 0 && (
            <ul className="m-0 mt-1.5 list-none p-0 font-mono text-[11.5px]">
              {error.files.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}
