import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ghCommand, parseIssue } from '../../../src/main/orchestrator/issues';
import { callTool, createHarness, type Harness } from './harness';

// 004 T028 — register_issue, list_issues and publish_issues with a real worktree and a simulated
// gh: the issues stay local until the user confirms (FR-022 to FR-024, research R8).

let h: Harness;
let token: string;
let worktree: string;

const READY = `# Connexion par e-mail

## Contexte
- L’utilisateur se connecte.

## Critères d’acceptation
- Given un compte, When il saisit son e-mail, Then il est connecté.

## Questions ouvertes
`;

const write = async (name: string, text: string) => {
  await mkdir(join(worktree, '.pact', 'issues'), { recursive: true });
  await writeFile(join(worktree, '.pact', 'issues', name), text);
};

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
  worktree = orchestrator?.worktreePath ?? '';
}, 30_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await h.dispose();
});

const tool = (name: string, args: Record<string, unknown> = {}) =>
  callTool(h.hooks.mcpUrl(), token, name, args);

const current = () => h.workspaces.get(h.workspace.id);

describe('parseIssue', () => {
  it('reads the title, and what keeps the issue from being ready', () => {
    expect(parseIssue(READY)).toEqual({ title: 'Connexion par e-mail', missing: [] });
    expect(
      parseIssue('## Questions ouvertes\n- Quel fournisseur ?\n* Et le mot de passe ?\n'),
    ).toEqual({
      title: '',
      missing: [
        'Aucun critère d’acceptation « Given … When … Then … ».',
        'Questions ouvertes : Quel fournisseur ? ; Et le mot de passe ?',
      ],
    });
  });
});

describe('ghCommand', () => {
  it('runs the user’s gh, or in test mode only the fake one', () => {
    expect(ghCommand({})).toEqual({ file: 'gh', args: [] });
    expect(ghCommand({ PACT_TEST_MODE: '1' })).toBeNull();
    expect(
      ghCommand({ PACT_TEST_MODE: '1', PACT_FAKE_GH: '/f/gh.mjs', PACT_FAKE_NODE: '/n' }),
    ).toEqual({ file: '/n', args: ['/f/gh.mjs'] });
    expect(ghCommand({ PACT_TEST_MODE: '1', PACT_FAKE_GH: '/f/gh.mjs' })).toEqual({
      file: process.execPath,
      args: ['/f/gh.mjs'],
    });
  });
});

describe('register_issue', () => {
  it('keeps a ready issue, named after its file and titled by its first heading', async () => {
    await write('0012-connexion.md', READY);
    const registered = await tool('register_issue', { path: '0012-connexion.md' });
    expect(registered).toMatchObject({ isError: false, text: '0012-connexion : ready.' });
    expect(current()?.issues).toEqual([
      {
        id: '0012-connexion',
        title: 'Connexion par e-mail',
        path: '.pact/issues/0012-connexion.md',
        state: 'ready',
        remote: null,
        trace: { branch: null, agents: [], pr: null },
      },
    ]);
    expect(h.issueChanges.at(-1)).toMatchObject({ workspaceId: h.workspace.id });
  });

  it('keeps an issue without criteria as proposed, saying what it misses', async () => {
    await write('0013-export.md', '## Questions ouvertes\n- Quel format ?\n');
    const registered = await tool('register_issue', { path: '0013-export.md' });
    expect(registered.text).toBe(
      '0013-export : proposed. Manque : Aucun critère d’acceptation « Given … When … Then … ». Questions ouvertes : Quel format ?',
    );
    expect(current()?.issues[0]).toMatchObject({ id: '0013-export', title: '0013-export' });

    // Once completed, the same file is read again and the issue becomes ready.
    await write('0013-export.md', READY);
    await tool('register_issue', { path: '0013-export.md' });
    expect(current()?.issues).toHaveLength(1);
    expect(current()?.issues[0]).toMatchObject({ state: 'ready' });
  });

  it('leaves the state of an issue a loop works on', async () => {
    await write('0012-connexion.md', READY);
    await tool('register_issue', { path: '0012-connexion.md' });
    await h.workspaces.update(h.workspace.id, (ws) => ({
      ...ws,
      issues: ws.issues.map((i) => ({ ...i, state: 'in-progress' as const })),
    }));
    await tool('register_issue', { path: '0012-connexion.md' });
    expect(current()?.issues[0]).toMatchObject({ state: 'in-progress' });
  });

  it('refuses a path out of .pact/issues/, not Markdown, or missing', async () => {
    for (const path of ['../secret.md', '/etc/passwd.md', 'notes.txt']) {
      const refused = await tool('register_issue', { path });
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toBe(`« ${path} » n’est pas un fichier .md de .pact/issues/.`);
    }
    const missing = await tool('register_issue', { path: 'absent.md' });
    expect(missing.text).toBe('Fichier introuvable : .pact/issues/absent.md.');
    expect(current()?.issues).toEqual([]);
  });
});

describe('list_issues', () => {
  it('lists the issues of the workspace', async () => {
    expect((await tool('list_issues')).text).toBe('Aucune issue.');
    await write('0012-connexion.md', READY);
    await tool('register_issue', { path: '0012-connexion.md' });
    const listed = await tool('list_issues');
    expect(listed.text).toBe('0012-connexion · Connexion par e-mail · ready');
    expect(listed.json).toMatchObject({ issues: [{ id: '0012-connexion' }] });
  });
});

describe('publish_issues', () => {
  beforeEach(async () => {
    await write('0012-connexion.md', READY);
    await write('0013-export.md', READY.replace('Connexion par e-mail', 'Export CSV'));
    await write('0014-brouillon.md', '# Brouillon\n');
    for (const path of ['0012-connexion.md', '0013-export.md', '0014-brouillon.md']) {
      await tool('register_issue', { path });
    }
  });

  it('is refused for unknown, unready or no issues, or without a remote or gh', async () => {
    const cases: [unknown, string][] = [
      [[], 'Donne de 1 à 20 issues à publier.'],
      [['0099'], 'Issue inconnue : 0099.'],
      [['0014-brouillon'], 'L’issue 0014-brouillon n’est pas prête.'],
      ['0012', 'Argument « ids » : liste d’identifiants attendue.'],
    ];
    for (const [ids, text] of cases) {
      expect((await tool('publish_issues', { ids })).text).toBe(text);
    }
    h.gh.answer = () =>
      Promise.reject(Object.assign(new Error('exit 1'), { stderr: 'no git remotes found\nmore' }));
    expect((await tool('publish_issues', { ids: ['0012-connexion'] })).text).toBe(
      'Publication impossible (dépôt distant ou gh connecté requis) : no git remotes found',
    );
    expect(current()?.publishRequests).toEqual([]);
  });

  it('waits for the user: one request per workspace, the new one replacing the old', async () => {
    const first = await tool('publish_issues', { ids: ['0012-connexion'] });
    expect(first).toMatchObject({
      isError: false,
      text: 'Demande envoyée à l’utilisateur : 0012-connexion.',
      json: { status: 'waiting-user' },
    });
    const second = await tool('publish_issues', {
      ids: ['0012-connexion', '0013-export', '0013-export'],
    });
    const { requestId } = second.json as { requestId: string };
    expect(current()?.publishRequests).toMatchObject([
      { id: requestId, issueIds: ['0012-connexion', '0013-export'] },
    ]);
    expect(h.gh.calls.map((c) => c.args)).toEqual([
      ['repo', 'view', '--json', 'url'],
      ['repo', 'view', '--json', 'url'],
    ]);
    expect(h.gh.calls[0]?.cwd).toBe(h.repo);
  });

  it('creates the issues once confirmed, keeps their number and tells the orchestrator', async () => {
    const { requestId } = (await tool('publish_issues', { ids: ['0012-connexion', '0013-export'] }))
      .json as { requestId: string };
    h.gh.calls.length = 0;
    expect(await h.issues.confirm(requestId)).toEqual({
      issues: [
        { id: '0012-connexion', url: 'https://github.com/pact/test/issues/1' },
        { id: '0013-export', url: 'https://github.com/pact/test/issues/2' },
      ],
    });
    expect(h.gh.calls[0]?.args).toEqual([
      'issue',
      'create',
      '--title',
      'Connexion par e-mail',
      '--body-file',
      join(worktree, '.pact/issues/0012-connexion.md'),
    ]);
    expect(current()?.publishRequests).toEqual([]);
    expect(current()?.issues.map((i) => i.remote)).toEqual([
      { number: 1, url: 'https://github.com/pact/test/issues/1' },
      { number: 2, url: 'https://github.com/pact/test/issues/2' },
      null,
    ]);
    expect(h.reports.at(-1)).toMatchObject({
      kind: 'publish',
      summary:
        'Issues publiées : 0012-connexion → https://github.com/pact/test/issues/1, 0013-export → https://github.com/pact/test/issues/2.',
    });
    // Published once: asking again is refused.
    expect((await tool('publish_issues', { ids: ['0012-connexion'] })).text).toBe(
      'L’issue 0012-connexion est déjà publiée.',
    );
  });

  it('stops at the first failure of gh, keeping the issues already created', async () => {
    const { requestId } = (await tool('publish_issues', { ids: ['0012-connexion', '0013-export'] }))
      .json as { requestId: string };
    h.gh.calls.length = 0;
    h.gh.answer = () =>
      h.gh.calls.length === 1
        ? Promise.resolve('https://github.com/pact/test/issues/7\n')
        : Promise.reject(new Error('HTTP 502'));
    expect((await h.issues.confirm(requestId)).issues).toEqual([
      { id: '0012-connexion', url: 'https://github.com/pact/test/issues/7' },
    ]);
    expect(current()?.issues.map((i) => i.remote?.number ?? null)).toEqual([7, null, null]);
    expect(h.reports.at(-1)?.summary).toBe(
      'Publication arrêtée : HTTP 502 (déjà publiées : 0012-connexion → https://github.com/pact/test/issues/7).',
    );
  });

  it('publishes nothing once refused, and tells the orchestrator', async () => {
    const { requestId } = (await tool('publish_issues', { ids: ['0012-connexion'] })).json as {
      requestId: string;
    };
    await h.issues.refuse(requestId);
    expect(current()?.publishRequests).toEqual([]);
    expect(current()?.issues.every((i) => i.remote === null)).toBe(true);
    expect(h.reports.at(-1)).toMatchObject({
      kind: 'publish',
      summary: 'Publication refusée par l’utilisateur : les issues restent locales.',
    });
    const { text } = await tool('wait_for_agents', { timeoutSeconds: 1 });
    expect(text).toContain('Publication refusée par l’utilisateur : les issues restent locales.');
    await expect(h.issues.refuse(requestId)).rejects.toThrow(
      'Cette demande de publication n’existe plus.',
    );
  });
});
