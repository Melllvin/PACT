import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('types the first prompt as the orchestrator’s', async () => {
    const { json } = await tool('launch_agent', { cli: 'Faux CLI', prompt: 'Écris la fonction' });
    const { id } = (json as Launched).agent;
    await h.waitFor(
      () => h.typed.some((t) => t.agentId === id && t.origin === 'orchestrator'),
      'the prompt was not typed',
      id,
    );
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
