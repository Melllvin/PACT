import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliRegistry } from '../../../src/main/agents/cli-registry';
import type { RoleProfile } from '../../../src/shared/model';
import { callTool, createHarness, type Harness } from './harness';

// 004 T010 — launch_agent by role takes the role's profile, refuses a CLI not installed and a model
// beyond the ceiling; list_agents gives each agent's role and loop (FR-005, FR-006).

let h: Harness;
let token: string;
let orchestratorId: string;

beforeEach(async () => {
  h = await createHarness();
  const register = h.hooks.registerMcp.bind(h.hooks);
  vi.spyOn(h.hooks, 'registerMcp').mockImplementation((id, handler) => {
    const issued = register(id, handler);
    token ||= issued;
    return issued;
  });
  token = '';
  const [orchestrator] = await h.launch([h.draft({ orchestrator: true })]);
  orchestratorId = orchestrator?.id ?? '';
  await h.permissions.set({ level: 'ask-sensitive', autoResume: true, scope: 'global' });
}, 30_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await h.dispose();
});

const tool = (name: string, args: Record<string, unknown> = {}) =>
  callTool(h.hooks.mcpUrl(), token, name, args);

const saved = (id: string) => h.workspaces.get(h.workspace.id)?.agents.find((a) => a.id === id);

const setProfiles = (roleProfiles: Partial<Record<'dev' | 'test', RoleProfile>>) =>
  h.workspaces.update(h.workspace.id, (ws) => ({ ...ws, roleProfiles }));

const dev: RoleProfile = {
  cliId: 'fake',
  model: 'fake-small',
  effort: 'low',
  maxModel: 'fake',
  escalate: false,
};

type Launched = { agent: { id: string; role: string | null; model: string | null } };

describe('launch_agent by role', () => {
  it('takes the CLI, model and effort of the default profile', async () => {
    const { isError, json } = await tool('launch_agent', { role: 'dev' });
    expect(isError).toBe(false);
    const { agent } = json as Launched;
    expect(agent).toMatchObject({ role: 'dev', model: 'fake' });
    expect(saved(agent.id)).toMatchObject({ cliId: 'fake', role: 'dev', model: 'fake' });
  });

  it('takes those of the profile the user set', async () => {
    await setProfiles({ dev });
    const { json } = await tool('launch_agent', { role: 'dev' });
    expect(saved((json as Launched).agent.id)).toMatchObject({
      role: 'dev',
      model: 'fake-small',
      effort: 'low',
    });
  });

  it('refuses a model beyond the ceiling of the role, with the reason', async () => {
    await setProfiles({ dev });
    const { isError, text } = await tool('launch_agent', { role: 'dev', model: 'fake-large' });
    expect(isError).toBe(true);
    expect(text).toBe('Modèle au-delà du plafond du rôle dev (fake)');
    const within = await tool('launch_agent', { role: 'dev', model: 'fake' });
    expect(within.isError).toBe(false);
  });

  it('refuses a profile whose CLI is not installed', async () => {
    await setProfiles({ dev: { ...dev, cliId: 'custom-absent' } });
    const { isError, text } = await tool('launch_agent', { role: 'dev' });
    expect(isError).toBe(true);
    expect(text).toBe('Le CLI « custom-absent » du rôle dev n’est pas installé.');
  });

  it('takes the profile of the role on the CLI named, when it is that CLI', async () => {
    await setProfiles({ dev });
    const { json } = await tool('launch_agent', { role: 'dev', cli: 'Fake' });
    expect(saved((json as Launched).agent.id)).toMatchObject({ role: 'dev', model: 'fake-small' });
  });

  it('asks for the CLI or the role, and refuses a role with no CLI installed', async () => {
    const neither = await tool('launch_agent');
    expect(neither).toMatchObject({ isError: true, text: 'Donne le CLI ou le rôle de l’agent.' });
    vi.spyOn(CliRegistry.prototype, 'list').mockReturnValue([]);
    const none = await tool('launch_agent', { role: 'dev' });
    expect(none).toMatchObject({ isError: true, text: 'Aucun CLI installé pour le rôle dev.' });
  });

  it('refuses a second orchestrator', async () => {
    const { isError } = await tool('launch_agent', { role: 'orchestrator' });
    expect(isError).toBe(true);
  });
});

describe('list_agents with roles', () => {
  it('gives the role and the loop of each agent', async () => {
    await tool('launch_agent', { role: 'test' });
    await tool('launch_agent', { cli: 'fake' });
    const { json } = await tool('list_agents');
    const { agents } = json as { agents: { role: string | null; loop: unknown }[] };
    expect(agents.map(({ role, loop }) => ({ role, loop }))).toEqual([
      { role: 'test', loop: null },
      { role: null, loop: null },
    ]);
    expect(agents.some((a) => (a as { id?: string }).id === orchestratorId)).toBe(false);
  });

  it('gives the running loop of its dev and of its test', async () => {
    const launched = async (role: string) =>
      ((await tool('launch_agent', { role })).json as Launched).agent.id;
    const devId = await launched('dev');
    const testId = await launched('test');
    await h.workspaces.update(h.workspace.id, (ws) => ({
      ...ws,
      loops: [
        {
          issueId: 'T001',
          devAgentId: devId,
          testAgentId: testId,
          round: 2,
          rounds: [],
          state: 'running',
          escalatedModel: null,
          polish: null,
        },
      ],
    }));
    const { json } = await tool('list_agents');
    const { agents } = json as { agents: { loop: unknown }[] };
    expect(agents.map(({ loop }) => loop)).toEqual([
      { issueId: 'T001', round: 2 },
      { issueId: 'T001', round: 2 },
    ]);
  });
});
