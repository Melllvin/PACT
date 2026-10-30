import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Agent } from '../../shared/model';
import type { Integration, ReviewSnapshot, TestRun } from '../../shared/review';
import { DIM, KO, MODES, Row, TestsLine } from './DecisionColumn';

type Props = {
  integration: Integration;
  agent: Agent;
  /** « Claude Code », for « Demander à Claude Code ». */
  agentName: string;
  snapshot: ReviewSnapshot | null;
  tests: TestRun | null;
  mainBranch: string;
  /** « Terminer » is on its way. */
  busy: boolean;
  error: { message: string; files: string[] } | null;
  onAskAgent: () => void;
  onFinish: () => void;
  onCancel: () => void;
  onRunTests: () => void;
  onCancelTests: () => void;
  onSetTestCommand: (command: string) => void;
};

/**
 * Takes the place of Décision while an integration is stopped on a conflict (screen 1q): the
 * agent resolves (recommended), or the user does, then « Terminer » or « Annuler » (FR-028…FR-031).
 */
export function IntegrationColumn({
  integration,
  agentName,
  snapshot,
  tests,
  mainBranch,
  busy,
  error,
  onAskAgent,
  onFinish,
  onCancel,
  onRunTests,
  onCancelTests,
  onSetTestCommand,
}: Props) {
  const files = integration.conflicts;
  const resolved = files.filter((file) => file.resolved).length;
  const left = files.length - resolved;
  const waiting = integration.state === 'waiting-agent';
  return (
    <aside
      aria-label="Intégration"
      className="relative z-10 flex w-[300px] flex-none flex-col gap-2.5 overflow-y-auto border-l border-white/6 bg-background px-4 py-[18px]"
    >
      <h2 className="m-0 px-0.5 pb-1.5 text-[15px] font-medium tracking-[-0.01em]">Intégration</h2>
      <div className="flex flex-col gap-2">
        {snapshot && !snapshot.missing && (
          <TestsLine
            run={tests}
            snapshot={snapshot}
            onRunTests={onRunTests}
            onCancelTests={onCancelTests}
            onSetTestCommand={onSetTestCommand}
          />
        )}
        <Row mark="✕" tone={KO}>
          {files.length} {files.length === 1 ? 'conflit' : 'conflits'} avec {mainBranch}
        </Row>
        <Row mark="○" tone={DIM}>
          {MODES[integration.mode]} en attente
        </Row>
      </div>
      <div aria-hidden className="my-1 h-px bg-white/6" />
      <section
        aria-label="Recommandé"
        className="flex flex-col gap-1.5 rounded-xl border border-primary/30 bg-primary/6 p-3"
      >
        <Badge variant="muted" className="self-start">
          Recommandé
        </Badge>
        <p className="m-0 text-[13px] font-medium">Demander à {agentName}</p>
        <p className="m-0 text-[12px] text-muted-foreground">
          Met sa branche à jour depuis {mainBranch} dans le worktree, résout, relance les tests.
        </p>
        {waiting && (
          <p role="status" className="m-0 text-[12px] text-primary">
            ◌ En attente de {agentName}…
          </p>
        )}
        <Button variant="primary" disabled={waiting || busy} onClick={onAskAgent}>
          Demander
        </Button>
      </section>
      <p className="m-0 text-[12px] text-muted-foreground">
        Ou résoudre ici · {resolved} / {files.length} résolu
      </p>
      <Button variant="accept" size="md" disabled={left > 0 || busy || waiting} onClick={onFinish}>
        {busy ? 'Intégration…' : 'Terminer l’intégration'}
      </Button>
      <p className="m-0 text-[12px] text-dim">
        <Button variant="link" size="sm" className="h-auto px-0" onClick={onCancel}>
          Annuler l’intégration
        </Button>{' '}
        · {mainBranch} n’est pas modifié
      </p>
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/8 px-3 py-2.5 text-[12.5px] whitespace-pre-wrap"
        >
          {error.message}
        </div>
      )}
    </aside>
  );
}
