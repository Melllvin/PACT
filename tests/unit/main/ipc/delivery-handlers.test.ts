import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryServices } from '../../../../src/main/ipc/delivery-handlers';
import { GitService } from '../../../../src/main/git/git-service';
import { openStores } from '../../../../src/main/persistence/store';
import { WorkspaceService } from '../../../../src/main/workspace/workspace-service';
import type { DeliverySettings } from '../../../../src/shared/delivery';
import { IpcFailure, ipcRequests } from '../../../../src/shared/ipc';

// 008 T026 — `delivery:settings` (contracts/ui.md, US2 sc.4, FR-019, FR-020): the settings of the
// project, saved in the workspace and kept after a restart.
//
// RED until T030 creates `src/main/ipc/delivery-handlers.ts` and the channel in `src/shared/ipc.ts`.
//
// API fixed here for the dev (ui.md gives the channel, not the module):
//   createDeliveryServices({ workspaces, delivery, onChange? }) → { 'delivery:settings': handler }
//     workspaces  { get(id), update(id, change) }: a WorkspaceService
//     delivery    { settingsChanged(workspaceId): Promise<void> }: the DeliveryService, told once the
//                 settings are WRITTEN (it merges the PR waiting for a review if Auto is now on, FR-011)
//     onChange?   (workspaceId, { deliveries, delivery }) => void: `workspace:deliveries` to the renderer
//   'delivery:settings'({ workspaceId, settings: Partial<DeliverySettings> }) → the settings now in force
//     * only the keys given change; the others keep their value;
//     * validated like `deliverySettingsSchema` (maxRounds 1–10, polishPasses 0–5, polishBrief ≤ 2000,
//       mergeMode squash|merge|rebase): out of bounds → IpcFailure('INVALID_INPUT', message of the field),
//       nothing is written, nobody is told; unknown workspace → IpcFailure('NOT_FOUND').

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
const services: WorkspaceService[] = [];

const workspaceService = () => {
  const created = new WorkspaceService({
    git: new GitService({ env: gitEnv }),
    stores: openStores(join(root, 'userData')),
  });
  services.push(created);
  return created;
};

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-delivery-settings-')));
  repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
});

afterEach(async () => {
  for (const created of services.splice(0)) created.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const wire = (workspaces: WorkspaceService) => {
  const delivery = { settingsChanged: vi.fn(() => Promise.resolve()) };
  const onChange = vi.fn();
  const handlers = createDeliveryServices({ workspaces, delivery, onChange });
  const settings = (workspaceId: string, patch: Partial<DeliverySettings>) =>
    handlers['delivery:settings']({ workspaceId, settings: patch });
  return { delivery, onChange, settings };
};

describe('delivery:settings', () => {
  it('Given a new project, When it is opened, Then Auto is off (sc.4)', async () => {
    const workspaces = workspaceService();
    const opened = await workspaces.open(repo);

    expect(opened.delivery.auto).toBe(false);
  });

  it('Given a project, When Auto is turned on, Then it is saved in the workspace, the other settings untouched, and the delivery is told after the write', async () => {
    const workspaces = workspaceService();
    const { id } = await workspaces.open(repo);
    const { delivery, onChange, settings } = wire(workspaces);
    delivery.settingsChanged.mockImplementation(() => {
      // Told after the write: the service reads the new value.
      expect(workspaces.get(id)?.delivery.auto).toBe(true);
      return Promise.resolve();
    });

    const result = await settings(id, { auto: true });

    expect(result).toEqual({
      auto: true,
      mergeMode: 'squash',
      maxRounds: 3,
      polishPasses: 0,
      polishBrief: '',
    });
    expect(workspaces.get(id)?.delivery).toEqual(result);
    expect(delivery.settingsChanged).toHaveBeenCalledWith(id);
    const [told, change] = onChange.mock.calls[0] as unknown as [
      string,
      { delivery: DeliverySettings },
    ];
    expect(told).toBe(id);
    expect(change.delivery.auto).toBe(true);
  });

  it('Given Auto turned on, When PACT restarts, Then the project is restored with Auto on and its other settings (sc.4)', async () => {
    const first = workspaceService();
    const { id } = await first.open(repo);
    await wire(first).settings(id, { auto: true, mergeMode: 'rebase', maxRounds: 5 });
    first.dispose();

    const [restored] = await workspaceService().restore();

    expect(restored?.delivery).toMatchObject({ auto: true, mergeMode: 'rebase', maxRounds: 5 });
  });

  it('Given a change of the settings, When only one key is given, Then the others keep what they had', async () => {
    const workspaces = workspaceService();
    const { id } = await workspaces.open(repo);
    const { settings } = wire(workspaces);

    await settings(id, { mergeMode: 'merge', polishBrief: 'Relis les noms.' });
    const result = await settings(id, { auto: true });

    expect(result).toMatchObject({
      auto: true,
      mergeMode: 'merge',
      polishBrief: 'Relis les noms.',
    });
  });

  it.each([
    ['maxRounds under 1', { maxRounds: 0 }],
    ['maxRounds over 10', { maxRounds: 11 }],
    ['polishPasses over 5', { polishPasses: 6 }],
    ['polishPasses under 0', { polishPasses: -1 }],
    ['a polishBrief over 2000 characters', { polishBrief: 'x'.repeat(2001) }],
    ['an unknown merge mode', { mergeMode: 'fast-forward' }],
  ])(
    'Given %s, When it is saved, Then it is refused as invalid, nothing is written and nobody is told',
    async (_what, patch) => {
      const workspaces = workspaceService();
      const { id } = await workspaces.open(repo);
      const { delivery, onChange, settings } = wire(workspaces);
      const before = workspaces.get(id)?.delivery;

      await expect(settings(id, patch as Partial<DeliverySettings>)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });

      expect(workspaces.get(id)?.delivery).toEqual(before);
      expect(delivery.settingsChanged).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it('Given a workspace that does not exist, When its settings are saved, Then the refusal says it is not found', async () => {
    const { settings } = wire(workspaceService());

    await expect(settings('nope', { auto: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// 008 T063 — `delivery:cleanup` (contracts/ui.md, US8 sc.3, FR-037): « Supprimer quand même » says what
// would be lost BEFORE it deletes; « Garder » deletes nothing.
//
// RED until T066. API fixed here for the dev (ui.md gives the channel and `{ lost }`, not the two steps):
//   createDeliveryServices({ workspaces, delivery, cleanup, onChange? }) → also 'delivery:cleanup'
//     cleanup   { lost(deliveryId, agentId): Promise<string[] | null>      what the removal would lose now,
//                                                                       `null` for an unknown delivery/agent
//               force(deliveryId, agentId): Promise<void>                removal with force (the user said so)
//               keep(deliveryId, agentId): Promise<void> }               the worktree is kept, the item goes
//     (the module `src/main/delivery/cleanup.ts` of T065 and its `lost()`; the handler only routes)
//   'delivery:cleanup'({ deliveryId, agentId, decision: 'force' | 'keep', confirmed?: boolean }) → { lost }
//     * 'force' WITHOUT `confirmed`: answers `{ lost }` and deletes NOTHING (the renderer shows it first);
//     * 'force' WITH `confirmed: true`: reads `lost()`, then `force()`, and answers the `{ lost }` it read;
//     * 'keep': `keep()`, nothing deleted, `{ lost: [] }`;
//     * unknown delivery or agent (`lost()` is null) → IpcFailure('NOT_FOUND'), nothing deleted;
//     * a removal that fails: the error of `force()` reaches the caller (the user reads why);
//     * `decision` other than force|keep, or an id that is not a uuid: refused by the schema of the channel.
//   `confirmed` is the one field added to the contract of ui.md (see the report).
describe('delivery:cleanup', () => {
  const DELIVERY = '4b6e1b0e-3b43-4b69-9a6f-0a8c6e7d1a11';
  const AGENT = '9f1c5f1d-8c5e-4f0e-8d57-3f1d2f2b6a22';
  const LOST = ['notes.txt', '.env.local', 'encore (commit absent de la PR)'];

  const cleanupHandler = () => {
    const cleanup = {
      lost: vi.fn((_d: string, _a: string): Promise<string[] | null> => Promise.resolve(LOST)),
      force: vi.fn((_d: string, _a: string) => Promise.resolve()),
      keep: vi.fn((_d: string, _a: string) => Promise.resolve()),
    };
    const workspaces = workspaceService();
    const handlers = createDeliveryServices({
      workspaces,
      delivery: { settingsChanged: vi.fn(() => Promise.resolve()) },
      cleanup,
    }) as unknown as Record<
      string,
      (input: {
        deliveryId: string;
        agentId: string;
        decision: string;
        confirmed?: boolean;
      }) => Promise<{ lost: string[] }>
    >;
    const call = (decision: string, confirmed?: boolean) => {
      const handler = handlers['delivery:cleanup'];
      if (typeof handler !== 'function') throw new Error('delivery:cleanup is not served');
      return handler({
        deliveryId: DELIVERY,
        agentId: AGENT,
        decision,
        ...(confirmed === undefined ? {} : { confirmed }),
      });
    };
    return { cleanup, call };
  };

  it('Given « Supprimer quand même » clicked, When the handler is called without confirmation, Then it answers what would be lost and deletes nothing (sc.3)', async () => {
    const { cleanup, call } = cleanupHandler();

    const result = await call('force');

    expect(result).toEqual({ lost: LOST });
    expect(cleanup.lost).toHaveBeenCalledWith(DELIVERY, AGENT);
    expect(cleanup.force).not.toHaveBeenCalled();
    expect(cleanup.keep).not.toHaveBeenCalled();
  });

  it('Given the confirmation, When the handler is called with confirmed, Then what is lost is read, then the removal is forced once, for that delivery and that agent', async () => {
    const { cleanup, call } = cleanupHandler();

    const result = await call('force', true);

    expect(result).toEqual({ lost: LOST });
    expect(cleanup.force).toHaveBeenCalledExactlyOnceWith(DELIVERY, AGENT);
    const lostAt = cleanup.lost.mock.invocationCallOrder[0] ?? Infinity;
    const forceAt = cleanup.force.mock.invocationCallOrder[0] ?? 0;
    expect(lostAt).toBeLessThan(forceAt);
  });

  it('Given « Garder », When the handler is called, Then the worktree is kept and nothing is deleted', async () => {
    const { cleanup, call } = cleanupHandler();

    const result = await call('keep');

    expect(result).toEqual({ lost: [] });
    expect(cleanup.keep).toHaveBeenCalledExactlyOnceWith(DELIVERY, AGENT);
    expect(cleanup.force).not.toHaveBeenCalled();
  });

  it('Given a confirmed deletion with « keep », When the handler is called, Then keep wins: nothing is deleted', async () => {
    const { cleanup, call } = cleanupHandler();

    await call('keep', true);

    expect(cleanup.force).not.toHaveBeenCalled();
  });

  it('Given an unknown delivery or agent, When the handler is called, Then it fails with NOT_FOUND and deletes nothing', async () => {
    const { cleanup, call } = cleanupHandler();
    cleanup.lost.mockResolvedValue(null);

    for (const confirmed of [false, true]) {
      const failure = await call('force', confirmed).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(IpcFailure);
      expect((failure as IpcFailure).code).toBe('NOT_FOUND');
    }
    expect(cleanup.force).not.toHaveBeenCalled();
  });

  it('Given a removal that fails, When the user confirmed, Then the error reaches the caller', async () => {
    const { cleanup, call } = cleanupHandler();
    cleanup.force.mockRejectedValue(new Error('cannot remove a locked working tree'));

    await expect(call('force', true)).rejects.toThrow('cannot remove a locked working tree');
  });

  it('Given the channel, When its input is parsed, Then force and keep pass, any other decision and a bad id are refused', () => {
    const channel = (
      ipcRequests as unknown as Record<
        string,
        { input: { safeParse(x: unknown): { success: boolean } } }
      >
    )['delivery:cleanup'];
    if (!channel) throw new Error('the channel delivery:cleanup is not declared');
    const ok = { deliveryId: DELIVERY, agentId: AGENT };

    expect(channel.input.safeParse({ ...ok, decision: 'force' }).success).toBe(true);
    expect(channel.input.safeParse({ ...ok, decision: 'force', confirmed: true }).success).toBe(
      true,
    );
    expect(channel.input.safeParse({ ...ok, decision: 'keep' }).success).toBe(true);
    expect(channel.input.safeParse({ ...ok, decision: 'delete' }).success).toBe(false);
    expect(channel.input.safeParse({ ...ok, decision: 'force', confirmed: 'yes' }).success).toBe(
      false,
    );
    expect(
      channel.input.safeParse({ deliveryId: 'x', agentId: AGENT, decision: 'keep' }).success,
    ).toBe(false);
  });
});
