import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FreeTerminals, freeTerminalShell } from '../../../src/main/agents/free-terminals';
import { GitService } from '../../../src/main/git/git-service';
import { openStores, type Stores } from '../../../src/main/persistence/store';
import { PtyManager } from '../../../src/main/pty/pty-manager';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import type { Workspace } from '../../../src/shared/model';

// FR-025 — « Terminal libre »: a shell at the root of the main repository.

const isWindows = process.platform === 'win32';

let root: string;
let repo: string;
let stores: Stores;
let workspaces: WorkspaceService;
let workspace: Workspace;
let pty: PtyManager;
let terminals: FreeTerminals[];

const env: Record<string, string> = { ...process.env, SHELL: '/bin/sh' };

const create = (manager = pty) => {
  const created = new FreeTerminals({
    workspaces,
    pty: manager,
    resolveEnv: () => Promise.resolve(env),
    platform: process.platform,
  });
  terminals.push(created);
  return created;
};

const waitFor = async (check: () => boolean, what: string) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 10_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-free-')));
  repo = join(root, 'Développement');
  await mkdir(repo);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
  stores = openStores(join(root, 'userData'));
  workspaces = new WorkspaceService({ git: new GitService(), stores });
  workspace = await workspaces.open(repo);
  pty = new PtyManager();
  terminals = [];
}, 30_000);

afterEach(async () => {
  for (const terminal of terminals) await terminal.dispose();
  await pty.dispose();
  workspaces.dispose();
  await stores.workspace(workspace.id).read();
  await rm(root, { recursive: true, force: true });
}, 30_000);

describe.skipIf(isWindows)('FreeTerminals', () => {
  it('opens shells at the root of the main repository and saves them', async () => {
    const opened = await create().open(workspace.id, 2);
    expect(opened).toHaveLength(2);
    for (const terminal of opened) {
      expect(terminal).toMatchObject({ workspaceId: workspace.id, cwd: repo, shell: '/bin/sh' });
      expect(pty.has(terminal.id)).toBe(true);
    }
    expect((await stores.workspace(workspace.id).read())?.freeTerminals).toEqual(opened);
  });

  it('runs what the user types there', async () => {
    const [terminal] = await create().open(workspace.id, 1);
    const id = terminal?.id ?? '';
    pty.write(id, 'pwd\r');
    await waitFor(() => pty.history(id).includes(repo), 'pwd output');
  });

  it('forgets a terminal whose shell was exited', async () => {
    const [terminal] = await create().open(workspace.id, 1);
    pty.write(terminal?.id ?? '', 'exit\r');
    await waitFor(() => workspaces.get(workspace.id)?.freeTerminals.length === 0, 'removal');
  });

  it('reopens the saved terminals after a restart', async () => {
    const first = create();
    const opened = await first.open(workspace.id, 1);
    await first.dispose();
    expect(workspaces.get(workspace.id)?.freeTerminals).toEqual(opened);

    const restarted = new PtyManager();
    await create(restarted).restore(workspace.id);
    expect(restarted.has(opened[0]?.id ?? '')).toBe(true);
    await restarted.dispose();
  });

  it('opens nothing for zero terminals and refuses an unknown workspace', async () => {
    expect(await create().open(workspace.id, 0)).toEqual([]);
    await expect(create().open('nope', 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('freeTerminalShell', { timeout: 30_000 }, () => {
  it('uses $SHELL as a login shell on macOS, /bin/zsh without it', async () => {
    expect(await freeTerminalShell({ SHELL: '/opt/homebrew/bin/fish' }, 'darwin')).toEqual({
      file: '/opt/homebrew/bin/fish',
      args: ['-l'],
    });
    expect(await freeTerminalShell({}, 'darwin')).toEqual({ file: '/bin/zsh', args: ['-l'] });
    expect(await freeTerminalShell({}, 'linux')).toEqual({ file: '/bin/sh', args: ['-l'] });
  });

  it('prefers pwsh on Windows, powershell.exe otherwise', async () => {
    const found = await freeTerminalShell({ PATH: 'C:\\pwsh' }, 'win32', (command) =>
      Promise.resolve(command === 'pwsh' ? 'C:\\pwsh\\pwsh.exe' : null),
    );
    expect(found).toEqual({ file: 'C:\\pwsh\\pwsh.exe', args: ['-NoLogo'] });
    const fallback = await freeTerminalShell({}, 'win32', () => Promise.resolve(null));
    expect(fallback).toEqual({ file: 'powershell.exe', args: ['-NoLogo'] });
  });
});
