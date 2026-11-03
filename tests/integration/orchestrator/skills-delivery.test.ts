import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_FILE, ROLE_FILE_PROMPT } from '../../../src/main/orchestrator/role-skills';
import { FAKE_CLI } from '../../fixtures/fake-cli/paths';
import { createHarness, git, type Harness } from './harness';

// 004 T042 — the skills of each role reach its agent outside the user's configuration, and go
// with it (R3, FR-009, FR-014, SC-007).

let h: Harness;
let home: string;
let savedHome: string | undefined;

beforeEach(async () => {
  // Nothing may land in ~/.claude nor ~/.codex: HOME is an empty folder for the test.
  home = await mkdtemp(join(tmpdir(), 'pact-home-'));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  h = await createHarness();
}, 30_000);

afterEach(async () => {
  await h.dispose();
  process.env.HOME = savedHome;
  expect(await readdir(home)).toEqual([]);
  await rm(home, { recursive: true, force: true });
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Sorted: Windows does not list a folder in the order macOS does. */
const skillsOf = async (agentId: string) =>
  (await readdir(join(h.userData, 'roles', agentId, 'plugin', 'skills'))).sort();

describe('the skills of the roles', () => {
  it('gives each agent its own skills and the contract, and removes them at closing', async () => {
    const [lead, design, dev] = await h.launch([
      h.draft({ role: 'orchestrator' }),
      h.draft({ role: 'design' }),
      h.draft({ role: 'dev' }),
    ]);
    const ids = [lead?.id ?? '', design?.id ?? '', dev?.id ?? ''];
    expect(await skillsOf(ids[0] ?? '')).toEqual(['pact-orchestrator']);
    expect(await skillsOf(ids[1] ?? '')).toEqual(['pact-design-system', 'pact-mockup']);
    expect(await skillsOf(ids[2] ?? '')).toEqual(['pact-dev']);
    const contract = join(h.userData, 'roles', ids[2] ?? '', 'plugin', 'skills', 'pact-dev');
    expect((await readdir(contract)).sort()).toEqual(['SKILL.md', 'pact-contract.md']);

    for (const id of ids) await h.manager.close(id, { removeWorktree: false });
    await h.waitFor(() => ids.every((id) => !h.current(id)), 'agents still open');
    await expect.poll(() => readdir(join(h.userData, 'roles'))).toEqual([]);
  });

  it('gives nothing to an agent with no role', async () => {
    const [agent] = await h.launch([h.draft()]);
    expect(await exists(join(h.userData, 'roles', agent?.id ?? ''))).toBe(false);
  });

  it('writes .pact/ROLE.md for a generic CLI, out of Git, and tells it to read it', async () => {
    const cli = await h.registry.add({ name: 'Autre', command: `${process.execPath} ${FAKE_CLI}` });
    const [agent] = await h.manager.launch({
      workspaceId: h.workspace.id,
      agents: [h.draft({ cliId: cli.id, role: 'test' })],
      counters: { freeTerminal: 0 },
    });
    const id = agent?.id ?? '';
    const worktree = agent?.worktreePath ?? '';
    const text = await readFile(join(worktree, ROLE_FILE), 'utf8');
    expect(text).toContain('name: pact-test');
    expect(text).toContain('# Contrat PACT');
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: worktree,
      encoding: 'utf8',
    }).trim();
    expect(await readFile(join(resolve(worktree, commonDir), 'info', 'exclude'), 'utf8')).toContain(
      `/${ROLE_FILE}\n`,
    );
    await h.waitFor(() => h.pty.history(id).includes(ROLE_FILE_PROMPT), 'never told', id);

    await h.manager.close(id, { removeWorktree: false });
    await expect.poll(() => exists(join(worktree, ROLE_FILE))).toBe(false);
  });
});
