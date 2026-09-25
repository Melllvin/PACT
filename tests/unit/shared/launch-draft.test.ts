import { describe, expect, it } from 'vitest';
import {
  conflicts,
  countsOf,
  differences,
  draftFromCounts,
  duplicate,
  effective,
  freeColors,
  freePositions,
  move,
  preview,
  remove,
  setAgent,
  setCommon,
  setOverride,
  toAgentDrafts,
  withCount,
  type LaunchDraft,
} from '../../../src/shared/launch-draft';
import type { Agent } from '../../../src/shared/model';

// T093 — the launch draft behind the quick (1c) and detailed (1d) modes (US6, FR-011).

const models: Record<string, string[]> = {
  'claude-code': ['opus', 'sonnet'],
  codex: ['gpt-5-codex', 'gpt-5'],
};
const modelsOf = (cliId: string) => models[cliId] ?? [];

const existing = (position: number, overrides: Partial<Agent> = {}) =>
  ({
    position,
    color: (['purple', 'cyan', 'green', 'magenta', 'yellow', 'slate'] as const)[position - 1],
    branch: `agent/claude-code-${String(position)}`,
    port: 3000 + position,
    ...overrides,
  }) as Agent;

/** 2 Claude Code then 1 Codex, as in screen 1d. */
const three = (): LaunchDraft => draftFromCounts({ 'claude-code': 2, codex: 1 }, 0);

describe('draftFromCounts / countsOf', () => {
  it('lists one agent per count, CLI by CLI, inheriting everything', () => {
    const draft = three();
    expect(draft.agents.map((a) => a.cliId)).toEqual(['claude-code', 'claude-code', 'codex']);
    expect(draft.agents.every((a) => a.branch === null && a.port === null)).toBe(true);
    expect(draft.agents.map((a) => a.overrides)).toEqual([{}, {}, {}]);
    expect(new Set(draft.agents.map((a) => a.key)).size).toBe(3);
  });

  it('gives the counts back, free terminals included', () => {
    expect(countsOf(draftFromCounts({ codex: 2, aider: 0 }, 1))).toEqual({
      agents: { codex: 2 },
      freeTerminal: 1,
    });
  });
});

describe('withCount (quick mode ↔ detailed mode, US6 scenario 1)', () => {
  it('keeps the agents already configured and adds the new ones at the end', () => {
    let draft = setOverride(three(), 0, 'model', 'sonnet');
    draft = withCount(draft, 'claude-code', 3);
    expect(draft.agents.map((a) => a.cliId)).toEqual([
      'claude-code',
      'claude-code',
      'codex',
      'claude-code',
    ]);
    expect(draft.agents[0]?.overrides).toEqual({ model: 'sonnet' });
  });

  it('removes the last agents of that CLI first', () => {
    let draft = setOverride(three(), 0, 'model', 'sonnet');
    draft = withCount(draft, 'claude-code', 1);
    expect(draft.agents.map((a) => a.cliId)).toEqual(['claude-code', 'codex']);
    expect(draft.agents[0]?.overrides).toEqual({ model: 'sonnet' });
  });

  it('changes nothing when the count is the same', () => {
    const draft = three();
    expect(withCount(draft, 'codex', 1)).toBe(draft);
  });
});

describe('Commun à tous and overrides (US6 scenarios 2 and 3)', () => {
  it('applies a common setting to every agent that does not override it', () => {
    let draft = setCommon(three(), 'baseBranch', 'develop');
    draft = setOverride(draft, 1, 'baseBranch', 'release');
    expect(draft.agents.map((_, i) => effective(draft, i).baseBranch)).toEqual([
      'develop',
      'release',
      'develop',
    ]);
  });

  it('marks and counts what differs from the common settings', () => {
    let draft = setCommon(three(), 'permissionLevel', 'always-allow');
    draft = setOverride(draft, 2, 'model', 'gpt-5-codex');
    draft = setOverride(draft, 2, 'permissionLevel', 'always-ask');
    expect(differences(draft, 2)).toEqual(['model', 'permissionLevel']);
    expect(differences(draft, 0)).toEqual([]);
  });

  it('does not mark an override equal to the common value', () => {
    let draft = setCommon(three(), 'startCommand', 'npm run dev');
    draft = setOverride(draft, 0, 'startCommand', 'npm run dev');
    expect(differences(draft, 0)).toEqual([]);
  });

  it('goes back to the common value when the override is cleared', () => {
    let draft = setCommon(three(), 'startCommand', 'npm run dev');
    draft = setOverride(draft, 0, 'startCommand', 'pnpm dev');
    draft = setOverride(draft, 0, 'startCommand', undefined);
    expect(effective(draft, 0).startCommand).toBe('npm run dev');
    expect(draft.agents[0]?.overrides).toEqual({});
  });

  it('lets the override win at launch', () => {
    let draft = setCommon(three(), 'startCommand', 'npm run dev');
    draft = setOverride(draft, 1, 'startCommand', 'pnpm dev');
    const drafts = toAgentDrafts(draft, 'ask-sensitive', modelsOf);
    expect(drafts.map((d) => d.startCommand)).toEqual(['npm run dev', 'pnpm dev', 'npm run dev']);
  });
});

describe('toAgentDrafts', () => {
  it('uses the chosen permission level unless the common setting or the agent sets one', () => {
    let draft = setOverride(three(), 2, 'permissionLevel', 'always-ask');
    expect(toAgentDrafts(draft, 'always-allow', modelsOf).map((d) => d.permissionLevel)).toEqual([
      'always-allow',
      'always-allow',
      'always-ask',
    ]);
    draft = setCommon(draft, 'permissionLevel', 'ask-sensitive');
    expect(toAgentDrafts(draft, 'always-allow', modelsOf).map((d) => d.permissionLevel)).toEqual([
      'ask-sensitive',
      'ask-sensitive',
      'always-ask',
    ]);
  });

  it('keeps a common model only for the CLIs that have it; the others use their default', () => {
    const draft = setCommon(three(), 'model', 'opus');
    expect(toAgentDrafts(draft, 'always-allow', modelsOf).map((d) => d.model)).toEqual([
      'opus',
      'opus',
      null,
    ]);
  });

  it('passes the branch and the port chosen for an agent, null when automatic', () => {
    let draft = setAgent(three(), 0, { branch: 'feature/login', port: 4000 });
    draft = setCommon(draft, 'baseBranch', 'develop');
    expect(toAgentDrafts(draft, 'always-allow', modelsOf)[0]).toEqual({
      cliId: 'claude-code',
      model: null,
      permissionLevel: 'always-allow',
      baseBranch: 'develop',
      branch: 'feature/login',
      port: 4000,
      startCommand: null,
    });
    expect(toAgentDrafts(draft, 'always-allow', modelsOf)[1]).toMatchObject({
      branch: null,
      port: null,
    });
  });
});

describe('order, duplicate, remove (US6 scenario 4)', () => {
  it('moves an agent; positions and colors follow the new order', () => {
    const draft = move(three(), 2, 0);
    expect(draft.agents.map((a) => a.cliId)).toEqual(['codex', 'claude-code', 'claude-code']);
    expect(preview(draft, [])).toEqual([
      { position: 1, color: 'purple' },
      { position: 2, color: 'cyan' },
      { position: 3, color: 'green' },
    ]);
  });

  it('places new agents after the ones already running, on the colors left', () => {
    expect(preview(three(), [existing(1), existing(3)])).toEqual([
      { position: 2, color: 'cyan' },
      { position: 4, color: 'magenta' },
      { position: 5, color: 'yellow' },
    ]);
  });

  it('duplicates an agent right after it, with its overrides but automatic branch and port', () => {
    let draft = setOverride(three(), 2, 'model', 'gpt-5');
    draft = setAgent(draft, 2, { branch: 'feature/x', port: 4000 });
    draft = duplicate(draft, 2);
    expect(draft.agents).toHaveLength(4);
    expect(draft.agents[3]).toMatchObject({
      cliId: 'codex',
      overrides: { model: 'gpt-5' },
      branch: null,
      port: null,
    });
    expect(draft.agents[3]?.key).not.toBe(draft.agents[2]?.key);
  });

  it('removes an agent', () => {
    expect(remove(three(), 0).agents.map((a) => a.cliId)).toEqual(['claude-code', 'codex']);
  });

  it('changes the CLI of an agent, forgetting a model of the other CLI', () => {
    let draft = setOverride(three(), 0, 'model', 'opus');
    draft = setAgent(draft, 0, { cliId: 'codex' });
    expect(draft.agents[0]).toMatchObject({ cliId: 'codex', overrides: {} });
  });
});

describe('conflicts (US6 scenario 5)', () => {
  it('finds two agents with the same branch or the same port', () => {
    let draft = setAgent(three(), 0, { branch: 'feature/x', port: 4000 });
    draft = setAgent(draft, 2, { branch: 'feature/x', port: 4000 });
    expect(conflicts(draft, [])).toEqual([
      { index: 2, kind: 'branch', value: 'feature/x' },
      { index: 2, kind: 'port', value: 4000 },
    ]);
  });

  it('finds a branch or a port an agent already running uses', () => {
    const draft = setAgent(three(), 1, { branch: 'agent/claude-code-1', port: 3001 });
    expect(conflicts(draft, [existing(1)])).toEqual([
      { index: 1, kind: 'branch', value: 'agent/claude-code-1' },
      { index: 1, kind: 'port', value: 3001 },
    ]);
  });

  it('accepts a chosen port that another draft agent would only get automatically', () => {
    expect(conflicts(setAgent(three(), 2, { port: 3001 }), [])).toEqual([]);
  });
});

describe('freePositions / freeColors (shared with the agent manager)', () => {
  it('takes the lowest free positions and the colors left, in palette order', () => {
    expect(freePositions([existing(2)], 3)).toEqual([1, 3, 4]);
    expect(freeColors([existing(1)], 2)).toEqual(['cyan', 'green']);
  });
});
