import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clockTime } from '../../../src/shared/usage';
import { callTool, createHarness, git, type Harness } from './harness';

// 003 T037 — launch_agent and close_agent: the launcher's checks and permission level, the first
// prompt, a close that keeps the worktree and the branch (FR-015, FR-016).

let h: Harness;
let token: string;
let orchestratorId: string;

beforeEach(async () => {
  h = await createHarness();
  const register = h.hooks.registerMcp.bind(h.hooks);
  vi.spyOn(h.hooks, 'registerMcp').mockImplementation((id, handler) => {
    token = register(id, handler);
    return token;
  });
  const [orchestrator] = await h.launch([h.draft({ orchestrator: true })]);
  orchestratorId = orchestrator?.id ?? '';
  await h.permissions.set({ level: 'ask-sensitive', autoResume: true, scope: 'global' });
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const tool = (name: string, args: Record<string, unknown> = {}) =>
  callTool(h.hooks.mcpUrl(), token, name, args);

const others = () =>
  (h.workspaces.get(h.workspace.id)?.agents ?? []).filter((a) => a.id !== orchestratorId);

type Launched = { agent: { id: string; name: string; branch: string; port: number } };

describe('launch_agent', () => {
  // 005 FR-012 — the orchestrator is told, as the launcher tells the user; it is not refused.
  it('adds the usage warning of its CLI to its answer, and launches all the same', async () => {
    h.usageWarnings.fake = 'Limite 5 h à 85 % : ces agents risquent de s’arrêter avant 16:40';
    const { isError, text, json } = await tool('launch_agent', { cli: 'Faux CLI' });
    expect(isError).toBe(false);
    expect(text).toMatch(
      /^Faux CLI 2 lancé sur .+\. Limite 5 h à 85 % : ces agents risquent de s’arrêter avant 16:40\.$/,
    );
    expect((json as Launched).agent.name).toBe('Faux CLI 2');
  });

  it('launches an agent with its tile, worktree and branch, at the level chosen in PACT', async () => {
    const { isError, json } = await tool('launch_agent', { cli: 'Faux CLI', branch: 'feat/un' });
    expect(isError).toBe(false);
    const { agent } = json as Launched;
    expect(agent).toMatchObject({ name: 'Faux CLI 2', branch: 'feat/un' });
    expect(agent.port).toBeGreaterThan(0);
    const [saved] = others();
    expect(saved).toMatchObject({ id: agent.id, permissionLevel: 'ask-sensitive', role: null });
    expect(git(h.repo, 'branch', '--list', 'feat/un')).toContain('feat/un');
    await h.waitForState(agent.id, 'awaiting-prompt');
  });

  it('accepts the CLI by its id, a model and a base branch', async () => {
    git(h.repo, 'branch', 'socle');
    const { json } = await tool('launch_agent', {
      cli: 'fake',
      model: 'fort',
      baseBranch: 'socle',
    });
    const [saved] = others();
    expect(saved).toMatchObject({
      id: (json as Launched).agent.id,
      model: 'fort',
      baseBranch: 'socle',
    });
  });

  it('wakes the agent for the first prompt of the orchestrator, by a pointer', async () => {
    const { json } = await tool('launch_agent', { cli: 'Faux CLI', prompt: 'Écris la fonction' });
    const { id } = (json as Launched).agent;
    // 007 R11: the prompt is an instruction of the journal; a pointer is typed, never its text.
    await h.waitForState(id, 'awaiting-prompt');
    h.wake?.deliver(id);
    await h.waitFor(
      () => h.typed.some((t) => t.agentId === id && t.origin === 'wake'),
      'the pointer was not typed',
      id,
    );
    expect(h.typed.some((t) => t.agentId === id && t.origin === 'orchestrator')).toBe(false);
  });

  it('is refused without a permission level chosen in PACT', async () => {
    const state = await h.stores.state.read();
    await h.stores.state.write({ ...state, permission: null });
    const { isError, text } = await tool('launch_agent', { cli: 'Faux CLI' });
    expect(isError).toBe(true);
    expect(text).toContain('Choisissez d’abord les autorisations dans PACT');
    expect(others()).toEqual([]);
  });

  it('is refused as the launcher refuses: unknown CLI, existing branch, six agents', async () => {
    const unknown = await tool('launch_agent', { cli: 'Inconnu' });
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.text).toContain('Inconnu');

    git(h.repo, 'branch', 'prise');
    const branch = await tool('launch_agent', { cli: 'Faux CLI', branch: 'prise' });
    expect(branch).toMatchObject({ isError: true });
    expect(branch.text).toContain('prise');

    await h.launch([h.draft(), h.draft(), h.draft(), h.draft(), h.draft()]);
    const limit = await tool('launch_agent', { cli: 'Faux CLI' });
    expect(limit).toMatchObject({ isError: true });
    expect(limit.text).toContain('Six agents');
  }, 30_000);

  it('is refused with a branch or a prompt that is not a text, or a prompt too long', async () => {
    const branch = await tool('launch_agent', { cli: 'Faux CLI', branch: 12 });
    expect(branch).toMatchObject({ isError: true });
    expect(branch.text).toContain('Argument « branch » : texte attendu.');

    const blank = await tool('launch_agent', { cli: 'Faux CLI', prompt: '  ' });
    expect(blank.text).toContain('Argument « prompt » : texte attendu.');

    const long = await tool('launch_agent', { cli: 'Faux CLI', prompt: 'a'.repeat(8001) });
    expect(long).toMatchObject({ isError: true });
    expect(long.text).toContain('Consigne de 1 à 8000 caractères attendue.');
    expect(others()).toHaveLength(0);
  });
});

// 006 T006 — which orchestrator launched an agent (data-model « Agent.launchedBy »).
describe('launch_agent: launchedBy', () => {
  it('records the orchestrator that launched each agent, and survives a reload of the state', async () => {
    const first = await tool('launch_agent', { cli: 'Faux CLI', branch: 'feat/a' });
    const second = await tool('launch_agent', { cli: 'Faux CLI', branch: 'feat/b' });
    const ids = [first, second].map((r) => (r.json as Launched).agent.id);
    expect(others().map((a) => a.launchedBy)).toEqual([orchestratorId, orchestratorId]);

    const saved = await h.stores.workspace(h.workspace.id).read();
    expect(saved?.agents.filter((a) => ids.includes(a.id)).map((a) => a.launchedBy)).toEqual([
      orchestratorId,
      orchestratorId,
    ]);

    await h.restart();
    const reloaded = (h.workspaces.get(h.workspace.id)?.agents ?? []).filter((a) =>
      ids.includes(a.id),
    );
    expect(reloaded.map((a) => a.launchedBy)).toEqual([orchestratorId, orchestratorId]);
  }, 30_000);

  it('leaves null on an agent launched from the interface, orchestrator included', async () => {
    const [byUser] = await h.launch([h.draft()]);
    expect(h.current(byUser?.id ?? '')?.launchedBy).toBeNull();
    expect(h.current(orchestratorId)?.launchedBy).toBeNull();
  }, 30_000);
});

describe('close_agent', () => {
  it('closes the tile and keeps the worktree and the branch', async () => {
    const { json } = await tool('launch_agent', { cli: 'Faux CLI', branch: 'feat/garde' });
    const { id } = (json as Launched).agent;
    await h.waitForState(id, 'awaiting-prompt');
    const worktree = others()[0]?.worktreePath ?? '';

    const closed = await tool('close_agent', { agent: 'Faux CLI 2' });
    expect(closed).toMatchObject({ isError: false, json: { closed: true, worktreeKept: true } });
    expect(others()).toEqual([]);
    // `git worktree list` quotes accented paths and writes `/` on Windows: ask the worktree itself.
    expect(existsSync(worktree)).toBe(true);
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/garde');
    expect(git(h.repo, 'branch', '--list', 'feat/garde')).toContain('feat/garde');
  });

  it('cannot close the orchestrator itself, nor an unknown agent', async () => {
    expect((await tool('close_agent', { agent: 'Faux CLI 1' })).isError).toBe(true);
    expect((await tool('close_agent', { agent: orchestratorId })).isError).toBe(true);
    expect((await tool('close_agent', { agent: 'Faux CLI 9' })).isError).toBe(true);
    expect(h.current(orchestratorId)).toBeDefined();
  });
});

// 007 T008 — launch_agent says it when the fetch failed (FR-022, US4 sc.5 to 7).
describe('launch_agent: the warning of the fetch', () => {
  let origin: string;

  beforeEach(() => {
    origin = join(h.root, 'origin.git');
    git(h.root, 'init', '--bare', '-b', 'main', origin);
    git(h.repo, 'remote', 'add', 'origin', origin);
    git(h.repo, 'push', '-q', 'origin', 'main');
    git(h.repo, 'fetch', '-q', 'origin');
  });

  it('adds a warning to its answer when the fetch fails, and starts from the last origin/main known', async () => {
    const known = git(h.repo, 'rev-parse', 'origin/main');
    git(h.repo, 'remote', 'set-url', 'origin', join(h.root, 'absent.git'));
    const { isError, text, json } = await tool('launch_agent', { cli: 'Faux CLI' });
    expect(isError).toBe(false);
    expect(text).toMatch(/fetch|origin/i);
    const { agent } = json as Launched;
    expect(git(others()[0]?.worktreePath ?? '', 'rev-parse', 'HEAD')).toBe(known);
    expect(agent.name).toBe('Faux CLI 2');
  }, 30_000);

  it('adds no warning when the fetch succeeds', async () => {
    const { isError, text } = await tool('launch_agent', { cli: 'Faux CLI' });
    expect(isError).toBe(false);
    expect(text).not.toMatch(/fetch|origin/i);
  }, 30_000);

  it('adds no warning without a remote', async () => {
    git(h.repo, 'remote', 'remove', 'origin');
    const { isError, text } = await tool('launch_agent', { cli: 'Faux CLI' });
    expect(isError).toBe(false);
    expect(text).not.toMatch(/fetch|origin/i);
  }, 30_000);

  it('adds no warning with an explicit baseBranch, which is respected', async () => {
    git(h.repo, 'branch', 'socle');
    git(h.repo, 'remote', 'set-url', 'origin', join(h.root, 'absent.git'));
    const { isError, text } = await tool('launch_agent', { cli: 'Faux CLI', baseBranch: 'socle' });
    expect(isError).toBe(false);
    expect(text).not.toMatch(/fetch|origin/i);
    expect(others()[0]?.baseBranch).toBe('socle');
  }, 30_000);

  it('keeps the warning of the usage next to it', async () => {
    h.usageWarnings.fake = 'Limite 5 h à 85 %';
    git(h.repo, 'remote', 'set-url', 'origin', join(h.root, 'absent.git'));
    const { text } = await tool('launch_agent', { cli: 'Faux CLI' });
    expect(text).toContain('Limite 5 h à 85 %');
    expect(text).toMatch(/fetch|origin/i);
  }, 30_000);
});

// 009 T018 — FR-010, R12: during the pause of an account of the CLI, `launch_agent` is refused, with the text of
// contracts/events.md « launch_agent ». The harness gives the tools `pausedFor(cliId)` (the pause of
// `UsageLimitService`, or null) from `h.usagePauses`.
describe('launch_agent during a pause at a limit (009 FR-010)', () => {
  const RESET = '2030-01-01T11:00:00.000Z';

  it('Given an account of the CLI in pause, When the orchestrator launches an agent of that CLI, Then it is refused with the text of the contract and nothing is launched', async () => {
    h.usagePauses.fake = { windows: [{ label: '5 h' }], resumeAt: RESET };
    const { isError, text } = await tool('launch_agent', { cli: 'Faux CLI' });
    expect(isError).toBe(true);
    expect(text).toBe(
      `Refusé : PACT est en pause sur la limite 5 h de Faux CLI jusqu'à ${clockTime(RESET)}. Aucun agent de ce CLI ne peut être lancé avant la reprise.`,
    );
    expect(others()).toEqual([]);
  });

  it('Given a pause with no known reset, When the orchestrator launches an agent, Then the refusal says « jusqu’à sa réinitialisation »', async () => {
    h.usagePauses.fake = { windows: [{ label: 'semaine' }], resumeAt: null };
    const { isError, text } = await tool('launch_agent', { cli: 'Faux CLI' });
    expect(isError).toBe(true);
    expect(text).toBe(
      "Refusé : PACT est en pause sur la limite semaine de Faux CLI jusqu'à sa réinitialisation. Aucun agent de ce CLI ne peut être lancé avant la reprise.",
    );
    expect(others()).toEqual([]);
  });

  it('Given the pause of another CLI, When the orchestrator launches an agent, Then it is launched as usual', async () => {
    h.usagePauses.codex = { windows: [{ label: '5 h' }], resumeAt: RESET };
    const { isError, json } = await tool('launch_agent', { cli: 'Faux CLI' });
    expect(isError).toBe(false);
    expect((json as Launched).agent.name).toBe('Faux CLI 2');
  });

  it('Given a pause that ended, When the orchestrator launches an agent, Then it is launched', async () => {
    h.usagePauses.fake = { windows: [{ label: '5 h' }], resumeAt: RESET };
    expect((await tool('launch_agent', { cli: 'Faux CLI' })).isError).toBe(true);
    delete h.usagePauses.fake;
    const { isError } = await tool('launch_agent', { cli: 'Faux CLI' });
    expect(isError).toBe(false);
    expect(others()).toHaveLength(1);
  });
});
