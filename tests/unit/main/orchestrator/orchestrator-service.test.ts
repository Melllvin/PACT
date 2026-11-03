import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../../../src/shared/model';
import { OrchestratorService } from '../../../../src/main/orchestrator/orchestrator-service';
import { ROLE_FILE, writeRoleFile } from '../../../../src/main/orchestrator/role-skills';

// 004 R3, R5 — the skills an agent with a role gets, and what goes when its role is released.

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pact-orchestrator-service-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

function service(workspaces: Workspace[] = []) {
  const hooks = {
    registerMcp: vi.fn(() => 'token'),
    revokeMcp: vi.fn(),
    mcpUrl: () => 'http://127.0.0.1:1/mcp',
  };
  const orchestrator = new OrchestratorService({
    hooks,
    workspaces: { list: () => workspaces },
    rolesDir: join(root, 'roles'),
    skillsDir: 'resources/skills',
    onTurnFinished: () => undefined,
  });
  return { orchestrator, hooks };
}

describe('OrchestratorService', () => {
  it('hands the skills of a developer to an agent without a role', async () => {
    const { orchestrator } = service();
    const launch = await orchestrator.prepareAgent({ id: 'a1', role: null });
    expect(launch.skills.role).toBe('dev');
    expect(await readdir(join(root, 'roles', 'a1', 'plugin', 'skills'))).toEqual(['pact-dev']);
  });

  it('releases an unknown agent: its token and its skills go', async () => {
    const { orchestrator, hooks } = service();
    await orchestrator.prepareAgent({ id: 'a1', role: 'test' });
    orchestrator.release('a1');
    expect(hooks.revokeMcp).toHaveBeenCalledWith('a1');
    await vi.waitFor(async () => {
      expect(await exists(join(root, 'roles', 'a1'))).toBe(false);
    });
  });

  it('removes the role file from the worktree of a known agent', async () => {
    const worktree = join(root, 'worktree');
    const workspace = {
      id: 'ws',
      agents: [{ id: 'a1', worktreePath: worktree }],
    } as unknown as Workspace;
    const { orchestrator } = service([workspace]);
    const launch = await orchestrator.prepareAgent({ id: 'a1', role: 'spec' });
    await writeRoleFile(worktree, launch.skills);
    expect(await exists(join(worktree, ROLE_FILE))).toBe(true);
    orchestrator.release('a1');
    await vi.waitFor(async () => {
      expect(await exists(join(worktree, ROLE_FILE))).toBe(false);
    });
  });
});
