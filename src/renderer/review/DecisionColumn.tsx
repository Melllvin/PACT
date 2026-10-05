import type { Agent } from '../../shared/model';
import type { ReviewSnapshot } from '../../shared/review';
import { isSeen } from './FileList';

type Props = {
  agent: Agent;
  snapshot: ReviewSnapshot | null;
};

const STATE: Partial<Record<Agent['state'], string>> = {
  'awaiting-prompt': 'attend une consigne',
  working: 'travaille encore',
  'awaiting-answer': 'attend votre réponse',
  done: 'a terminé son tour',
  error: 'est en erreur',
};

/**
 * Takes the place of À faire while a review is open (FR-004). This version says what is left to
 * see; integrating, sending back and abandoning come with US2–US4.
 */
export function DecisionColumn({ agent, snapshot }: Props) {
  const files = snapshot?.files ?? [];
  const unseen = files.filter((file) => !isSeen(file, agent.review.seen)).length;
  const state = STATE[agent.state];
  return (
    <aside
      aria-label="Décision"
      className="relative z-10 flex w-[300px] flex-none flex-col gap-2.5 overflow-y-auto border-l border-white/6 bg-background px-4 py-[18px]"
    >
      <h2 className="m-0 px-0.5 pb-1.5 text-[15px] font-medium tracking-[-0.01em]">Décision</h2>
      {snapshot && !snapshot.missing && files.length > 0 && (
        <p className="m-0 rounded-xl border border-white/6 bg-surface p-3 text-[13px]">
          {unseen === 0
            ? 'Tous les fichiers sont vus'
            : `${String(unseen)} ${unseen === 1 ? 'fichier non vu' : 'fichiers non vus'}`}
        </p>
      )}
      {state && <p className="m-0 px-0.5 text-[12px] text-dim">L’agent {state}.</p>}
    </aside>
  );
}
