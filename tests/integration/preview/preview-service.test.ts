import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewService } from '../../../src/main/preview/preview-service';
import type { Agent, Workspace } from '../../../src/shared/model';

// 004 T035 — what the Aperçu lists, its refreshes, and the decision on a mockup (FR-025, FR-027,
// FR-028).

let root: string;
let workspaces: Workspace[];
let listeners: Map<string, (file: string | null) => void>;
const stops: string[] = [];
const AGENT = '6f1c2a4e-8b3d-4e5f-9a7b-1c2d3e4f5a6b';

const agent = (worktreePath: string) => ({ id: AGENT, worktreePath }) as Agent;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  root = await mkdtemp(join(tmpdir(), 'pact-preview-service-'));
  workspaces = [{ id: 'w1', agents: [agent(root)] } as Workspace];
  listeners = new Map();
  stops.length = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

const service = () => {
  const changed: [string, string][] = [];
  const notices: unknown[] = [];
  const preview = new PreviewService({
    workspaces: { list: () => workspaces },
    watch: (dir, onChange) => {
      listeners.set(dir, onChange);
      return () => stops.push(dir);
    },
    onChanged: (agentId, path) => changed.push([agentId, path]),
    notify: (workspaceId, notice) => notices.push({ workspaceId, ...notice }),
  });
  return { preview, changed, notices };
};

describe('PreviewService', () => {
  it('lists the recap first, then the mockups, then the issues', async () => {
    await mkdir(join(root, 'design/mockups'), { recursive: true });
    await mkdir(join(root, '.pact/issues'), { recursive: true });
    for (const file of [
      'design/mockups/b.html',
      'design/mockups/a.html',
      'design/mockups/notes.txt',
      '.pact/recap.md',
      '.pact/other.md',
      '.pact/issues/0012.md',
    ]) {
      await writeFile(join(root, file), '');
    }
    const { preview } = service();
    expect(await preview.list(AGENT)).toEqual([
      { path: '.pact/recap.md', kind: 'recap' },
      { path: 'design/mockups/a.html', kind: 'mockup' },
      { path: 'design/mockups/b.html', kind: 'mockup' },
      { path: '.pact/issues/0012.md', kind: 'issue' },
    ]);
    expect(preview.worktreeOf(AGENT)).toBe(root);
    expect(preview.worktreeOf('x')).toBeNull();
  });

  it('lists nothing in a worktree without them, and refuses an agent gone', async () => {
    const { preview } = service();
    expect(await preview.list(AGENT)).toEqual([]);
    await expect(preview.list('x')).rejects.toThrow('Cet agent n’est plus ouvert.');
  });

  it('tells once a listed file changes, and stops once the agent is gone', async () => {
    const { preview, changed } = service();
    await preview.list(AGENT);
    await preview.list(AGENT);
    const onChange = listeners.get(root);
    for (const file of ['design/mockups/a.html', 'design/mockups/a.html', 'src/a.ts', null]) {
      onChange?.(file);
    }
    vi.advanceTimersByTime(100);
    expect(changed).toEqual([[AGENT, 'design/mockups/a.html']]);

    workspaces = [];
    onChange?.('.pact/recap.md');
    expect(stops).toEqual([root]);
    vi.advanceTimersByTime(100);
    expect(changed).toHaveLength(1);
  });

  it('stops following on dispose, its pending refreshes too', async () => {
    const { preview, changed } = service();
    await preview.list(AGENT);
    listeners.get(root)?.('.pact/recap.md');
    preview.dispose();
    vi.advanceTimersByTime(100);
    expect(stops).toEqual([root]);
    expect(changed).toEqual([]);
  });

  it('tells the orchestrator the user’s decision on a mockup', () => {
    const { preview, notices } = service();
    preview.decide(AGENT, 'design/mockups/a.html', 'validated', '  Bien  ');
    preview.decide(AGENT, 'design/mockups/a.html', 'refused');
    expect(notices).toEqual([
      {
        workspaceId: 'w1',
        agentId: AGENT,
        kind: 'mockup',
        summary: 'maquette design/mockups/a.html validée par l’utilisateur. Commentaire : Bien',
      },
      {
        workspaceId: 'w1',
        agentId: AGENT,
        kind: 'mockup',
        summary: 'maquette design/mockups/a.html refusée par l’utilisateur.',
      },
    ]);
    expect(() => {
      preview.decide(AGENT, '.pact/recap.md', 'validated');
    }).toThrow('« .pact/recap.md » n’est pas une maquette.');
    expect(() => {
      preview.decide('x', 'design/mockups/a.html', 'validated');
    }).toThrow('Cet agent n’est plus ouvert.');
  });
});
