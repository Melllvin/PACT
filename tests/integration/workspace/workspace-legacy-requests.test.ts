import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';
import { openStores } from '../../../src/main/persistence/store';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';

// 008 T016 (R24, spec « mise à jour ») — the requests of `request_integration` still saved when the
// app updates are dropped at load: nothing can answer them any more.
//
// RED until T022. Assumed: `restore()` empties `workspace.integrationRequests` and saves the
// empty list. How the user is told (« N demandes d’intégration retirées : redemande-les par
// Livrer ») is not tested: the spec does not say where it is kept (see the report).

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

let root: string;

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-legacy-')));
  git(root, 'init', '-b', 'main');
  await writeFile(join(root, 'README.md'), '# test\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const request = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000000${String(n)}`,
  agentId: '00000000-0000-4000-8000-000000000009',
  mode: 'squash' as const,
  message: `feat: ${String(n)}`,
  requestedAt: '2026-11-03T00:00:00.000Z',
});

describe('Given a workspace saved with integration requests', () => {
  it('When the app restores it, Then the requests are gone, in memory and on the disk', async () => {
    const userData = join(root, '..', `ud-${String(Date.now())}`);
    const stores = openStores(userData);
    const before = new WorkspaceService({ git: new GitService({ env }), stores });
    const opened = await before.open(root);
    await before.update(opened.id, (ws) => ({
      ...ws,
      integrationRequests: [request(1), request(2)],
    }));
    expect(before.get(opened.id)?.integrationRequests).toHaveLength(2);

    const after = new WorkspaceService({ git: new GitService({ env }), stores });
    await after.restore();

    expect(after.get(opened.id)?.integrationRequests).toEqual([]);
    expect((await stores.workspace(opened.id).read())?.integrationRequests).toEqual([]);
    await rm(userData, { recursive: true, force: true });
  });
});
