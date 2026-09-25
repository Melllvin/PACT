import { useState } from 'react';
import { draftFromCounts, type LaunchDraft } from '../../shared/launch-draft';
import type { Agent, CliDefinition, Workspace } from '../../shared/model';
import { DetailedLaunch } from './DetailedLaunch';
import { launchableClis, QuickLaunch } from './QuickLaunch';

export type LaunchPanelProps = {
  clis: CliDefinition[];
  /** Counters last used in this workspace (FR-010). */
  counters: Workspace['quickLaunchCounters'];
  /** Agents of this workspace: the limit of six, and where new tiles land. */
  running: Pick<Agent, 'position' | 'color'>[];
  /** Agents of every workspace: their branches and ports are taken. */
  taken: Pick<Agent, 'branch' | 'port'>[];
  /** Draft of a refused launch, to start again from it. */
  initialDraft: LaunchDraft | null;
  error: string | null;
  onLaunch: (draft: LaunchDraft) => void;
  onClose: () => void;
};

/** The quick counters as a first draft: one agent of the first CLI the very first time. */
function fromCounters(clis: CliDefinition[], counters: Workspace['quickLaunchCounters']) {
  const { detected, other } = launchableClis(clis);
  const firstLaunch = Object.keys(counters).every((key) => key === 'freeTerminal');
  const counts = Object.fromEntries(
    [...detected, ...(other ? [other] : [])].map((cli, index) => [
      cli.id,
      counters[cli.id] ?? (firstLaunch && index === 0 ? 1 : 0),
    ]),
  );
  return draftFromCounts(counts, counters.freeTerminal);
}

/** « + Agents »: the quick mode (1c) and the detailed one (1d), on the same draft (US6 scenario 1). */
export function LaunchPanel({
  clis,
  counters,
  running,
  taken,
  initialDraft,
  error,
  onLaunch,
  onClose,
}: LaunchPanelProps) {
  const [draft, setDraft] = useState(() => initialDraft ?? fromCounters(clis, counters));
  const [detailed, setDetailed] = useState(false);

  return detailed ? (
    <DetailedLaunch
      clis={clis}
      draft={draft}
      onChange={setDraft}
      running={running}
      taken={taken}
      error={error}
      onLaunch={() => {
        onLaunch(draft);
      }}
      onQuick={() => {
        setDetailed(false);
      }}
      onClose={onClose}
    />
  ) : (
    <QuickLaunch
      clis={clis}
      draft={draft}
      onChange={setDraft}
      existingAgents={running.length}
      error={error}
      onLaunch={() => {
        onLaunch(draft);
      }}
      onDetailed={() => {
        setDetailed(true);
      }}
      onClose={onClose}
    />
  );
}
