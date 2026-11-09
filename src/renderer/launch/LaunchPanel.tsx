import { useState } from 'react';
import { draftFromCounts, type LaunchDraft } from '../../shared/launch-draft';
import type { Agent, CliDefinition, Role, RoleProfile, Workspace } from '../../shared/model';
import { DetailedLaunch } from './DetailedLaunch';
import { launchableClis, QuickLaunch } from './QuickLaunch';
import type { UsageWarning } from './UsageWarnings';

export type LaunchPanelProps = {
  clis: CliDefinition[];
  /** Counters last used in this workspace (FR-010). */
  counters: Workspace['quickLaunchCounters'];
  /** Agents of this workspace: the limit of six, and where new tiles land. */
  running: (Pick<Agent, 'position' | 'color' | 'role'> & Partial<Pick<Agent, 'state'>>)[];
  /** Agents of every workspace: their branches and ports are taken. */
  taken: Pick<Agent, 'branch' | 'port'>[];
  /** Draft of a refused launch, to start again from it. */
  initialDraft: LaunchDraft | null;
  error: string | null;
  /** The repository has uncommitted changes, left out of the worktrees (T122). */
  localChanges?: boolean;
  /** 004 — the role profiles the user set in this workspace (FR-003). */
  profiles?: Partial<Record<Role, RoleProfile>>;
  /** 005 FR-012 — « Limite 5 h à 85 % : … » for a CLI near its limit, or null. */
  usageWarning?: (cliId: string) => string | null;
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
  localChanges = false,
  profiles = {},
  usageWarning,
  onLaunch,
  onClose,
}: LaunchPanelProps) {
  const [draft, setDraft] = useState(() => initialDraft ?? fromCounters(clis, counters));
  const [detailed, setDetailed] = useState(false);
  // #112 — a closed orchestrator directs nothing: only a live one holds the role.
  const hasLiveOrchestrator = running.some(
    (agent) => agent.role === 'orchestrator' && agent.state !== 'closed',
  );
  // One per CLI of the draft, the orchestrator's included: a warning, never a block.
  const usageWarnings = [...new Set(draft.agents.map((agent) => agent.cliId))].flatMap(
    (cliId): UsageWarning[] => {
      const text = usageWarning?.(cliId) ?? null;
      const cli = clis.find((c) => c.id === cliId)?.name ?? cliId;
      return text === null ? [] : [{ cli, text }];
    },
  );

  return detailed ? (
    <DetailedLaunch
      clis={clis}
      draft={draft}
      onChange={setDraft}
      running={running}
      taken={taken}
      canOrchestrate={!hasLiveOrchestrator}
      error={error}
      localChanges={localChanges}
      usageWarnings={usageWarnings}
      profiles={profiles}
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
      canOrchestrate={!hasLiveOrchestrator}
      error={error}
      localChanges={localChanges}
      usageWarnings={usageWarnings}
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
