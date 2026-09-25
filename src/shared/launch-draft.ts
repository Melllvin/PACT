import type { AgentDraft } from './ipc';
import { AGENT_COLORS, MAX_AGENTS, type Agent, type PermissionLevel } from './model';

// US6 — the agents about to be launched, shared by the quick mode (1c) and the detailed mode (1d)
// so switching between them loses nothing (FR-011). Pure: the store keeps it, main validates it.

/** « ⚑ Commun à tous »: `null` means the default (CLI model, chosen level, main branch, none). */
export type CommonSettings = {
  model: string | null;
  permissionLevel: PermissionLevel | null;
  baseBranch: string | null;
  startCommand: string | null;
};
export type SettingKey = keyof CommonSettings;

export type DraftAgent = {
  /** Stable across moves, for lists and drag and drop. */
  key: string;
  cliId: string;
  /** Only what this agent sets itself; the rest comes from the common settings. */
  overrides: Partial<CommonSettings>;
  /** Chosen for this agent only; `null`: `agent/<cli>-<n>` and 3000 + position. */
  branch: string | null;
  port: number | null;
};

export type LaunchDraft = {
  common: CommonSettings;
  agents: DraftAgent[];
  freeTerminal: number;
  nextKey: number;
};

export type Conflict = { index: number; kind: 'branch' | 'port'; value: string | number };

const SETTING_KEYS: readonly SettingKey[] = [
  'model',
  'permissionLevel',
  'baseBranch',
  'startCommand',
];

const noCommon: CommonSettings = {
  model: null,
  permissionLevel: null,
  baseBranch: null,
  startCommand: null,
};

const newAgent = (draft: LaunchDraft, cliId: string): [DraftAgent, LaunchDraft] => [
  { key: `a${String(draft.nextKey)}`, cliId, overrides: {}, branch: null, port: null },
  { ...draft, nextKey: draft.nextKey + 1 },
];

const withAgents = (draft: LaunchDraft, agents: DraftAgent[]): LaunchDraft => ({
  ...draft,
  agents,
});

const updateAgent = (draft: LaunchDraft, index: number, change: (a: DraftAgent) => DraftAgent) =>
  withAgents(
    draft,
    draft.agents.map((agent, i) => (i === index ? change(agent) : agent)),
  );

/** The quick mode's counters as a draft, CLI by CLI in the order given. */
export function draftFromCounts(counts: Record<string, number>, freeTerminal: number): LaunchDraft {
  let draft: LaunchDraft = { common: noCommon, agents: [], freeTerminal, nextKey: 1 };
  for (const [cliId, count] of Object.entries(counts)) draft = withCount(draft, cliId, count);
  return draft;
}

export function countsOf(draft: LaunchDraft): {
  agents: Record<string, number>;
  freeTerminal: number;
} {
  const agents: Record<string, number> = {};
  for (const { cliId } of draft.agents) agents[cliId] = (agents[cliId] ?? 0) + 1;
  return { agents, freeTerminal: draft.freeTerminal };
}

/** A quick-mode counter change: new agents go last, removed ones are that CLI's last ones. */
export function withCount(draft: LaunchDraft, cliId: string, count: number): LaunchDraft {
  const current = draft.agents.filter((agent) => agent.cliId === cliId).length;
  if (count === current) return draft;
  if (count < current) {
    let extra = current - count;
    const kept = [...draft.agents]
      .reverse()
      .filter((agent) => !(agent.cliId === cliId && extra-- > 0))
      .reverse();
    return withAgents(draft, kept);
  }
  let next = draft;
  for (let i = current; i < count; i++) {
    const [agent, keyed] = newAgent(next, cliId);
    next = withAgents(keyed, [...keyed.agents, agent]);
  }
  return next;
}

export function setCommon<K extends SettingKey>(
  draft: LaunchDraft,
  key: K,
  value: CommonSettings[K],
): LaunchDraft {
  return { ...draft, common: { ...draft.common, [key]: value } };
}

/** Sets what an agent overrides; `undefined` goes back to the common value. */
export function setOverride<K extends SettingKey>(
  draft: LaunchDraft,
  index: number,
  key: K,
  value: CommonSettings[K] | undefined,
): LaunchDraft {
  return updateAgent(draft, index, (agent) => {
    const overrides = Object.fromEntries(
      Object.entries(agent.overrides).filter(([name]) => name !== key),
    ) as Partial<CommonSettings>;
    return {
      ...agent,
      overrides: value === undefined ? overrides : { ...overrides, [key]: value },
    };
  });
}

/** CLI, branch or port of one agent. Another CLI does not keep a model of the previous one. */
export function setAgent(
  draft: LaunchDraft,
  index: number,
  change: Partial<Pick<DraftAgent, 'cliId' | 'branch' | 'port'>>,
): LaunchDraft {
  return updateAgent(draft, index, (agent) => {
    const next = { ...agent, ...change };
    if (change.cliId !== undefined && change.cliId !== agent.cliId) {
      next.overrides = Object.fromEntries(
        Object.entries(agent.overrides).filter(([name]) => name !== 'model'),
      );
    }
    return next;
  });
}

export function effective(draft: LaunchDraft, index: number): CommonSettings {
  return { ...draft.common, ...draft.agents[index]?.overrides };
}

/** The ≠ of an agent: overrides that differ from the common value. */
export function differences(draft: LaunchDraft, index: number): SettingKey[] {
  const overrides = draft.agents[index]?.overrides ?? {};
  return SETTING_KEYS.filter((key) => key in overrides && overrides[key] !== draft.common[key]);
}

export function move(draft: LaunchDraft, from: number, to: number): LaunchDraft {
  const agents = [...draft.agents];
  const [moved] = agents.splice(from, 1);
  if (!moved) return draft;
  agents.splice(to, 0, moved);
  return withAgents(draft, agents);
}

/** « Dupliquer »: right after, same settings; branch and port stay automatic to avoid a conflict. */
export function duplicate(draft: LaunchDraft, index: number): LaunchDraft {
  const source = draft.agents[index];
  if (!source) return draft;
  const [copy, keyed] = newAgent(draft, source.cliId);
  const agents = [...keyed.agents];
  agents.splice(index + 1, 0, { ...copy, overrides: { ...source.overrides } });
  return withAgents(keyed, agents);
}

export function remove(draft: LaunchDraft, index: number): LaunchDraft {
  return withAgents(
    draft,
    draft.agents.filter((_, i) => i !== index),
  );
}

/** Positions 1…6 not taken yet, lowest first. */
export function freePositions(agents: Pick<Agent, 'position'>[], count: number): number[] {
  const taken = new Set(agents.map((agent) => agent.position));
  const free = Array.from({ length: MAX_AGENTS }, (_, i) => i + 1).filter((p) => !taken.has(p));
  return free.slice(0, count);
}

/** Colors go in the order of AGENT_COLORS and an agent keeps its color (FR-016). */
export function freeColors(agents: Pick<Agent, 'color'>[], count: number): Agent['color'][] {
  const taken = new Set(agents.map((agent) => agent.color));
  return AGENT_COLORS.filter((color) => !taken.has(color)).slice(0, count);
}

/** Where each draft agent lands, as the agent manager will place it (the port stays « auto »). */
export function preview(
  draft: LaunchDraft,
  running: Pick<Agent, 'position' | 'color'>[],
): { position: number; color: Agent['color'] }[] {
  const positions = freePositions(running, draft.agents.length);
  const colors = freeColors(running, draft.agents.length);
  return draft.agents.flatMap((_, i) => {
    const position = positions[i];
    const color = colors[i];
    return position === undefined || color === undefined ? [] : [{ position, color }];
  });
}

/**
 * Branches and ports chosen twice, or already used by a running agent (`running`: every agent
 * of every workspace). Main also checks existing Git branches and ports in use by other programs.
 */
export function conflicts(
  draft: LaunchDraft,
  running: Pick<Agent, 'branch' | 'port'>[],
): Conflict[] {
  const branches = new Set(running.map((agent) => agent.branch));
  const ports = new Set(running.map((agent) => agent.port));
  const found: Conflict[] = [];
  draft.agents.forEach(({ branch, port }, index) => {
    if (branch !== null) {
      if (branches.has(branch)) found.push({ index, kind: 'branch', value: branch });
      branches.add(branch);
    }
    if (port !== null) {
      if (ports.has(port)) found.push({ index, kind: 'port', value: port });
      ports.add(port);
    }
  });
  return found;
}

/**
 * What `agents:launch` receives. `level` is the level already chosen (1m or saved) for agents
 * that set none; a model the agent's CLI does not offer falls back to that CLI's default.
 */
export function toAgentDrafts(
  draft: LaunchDraft,
  level: PermissionLevel,
  modelsOf: (cliId: string) => string[],
): AgentDraft[] {
  return draft.agents.map((agent, index) => {
    const settings = effective(draft, index);
    const model =
      settings.model !== null && modelsOf(agent.cliId).includes(settings.model)
        ? settings.model
        : null;
    return {
      cliId: agent.cliId,
      model,
      permissionLevel: settings.permissionLevel ?? level,
      baseBranch: settings.baseBranch,
      branch: agent.branch,
      port: agent.port,
      startCommand: settings.startCommand,
    };
  });
}
