import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTRACT,
  mcpTokenVariable,
  removeRoleFiles,
  ROLE_FILE,
  ROLE_SKILLS,
  roleFileText,
  roleInstruction,
  writeRoleFile,
  writeRoleSkills,
} from '../../../../src/main/orchestrator/role-skills';
import { ROLES } from '../../../../src/shared/primitives';

// 004 T042 — the copy of a role's skills and the contract, per agent (R3, FR-009).

const SKILLS = 'resources/skills';
const URL = 'http://127.0.0.1:4567/mcp';

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pact-roles-'));
  dir = join(root, 'Données utilisateur', 'roles', 'agent 1');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('the skills of each role', () => {
  it('gives design its two skills, every other role its own', () => {
    expect(ROLE_SKILLS).toEqual({
      orchestrator: ['pact-orchestrator'],
      spec: ['pact-spec'],
      design: ['pact-design-system', 'pact-mockup'],
      dev: ['pact-dev'],
      test: ['pact-test'],
      recap: ['pact-recap'],
    });
  });

  it('ships every skill it gives', async () => {
    for (const role of ROLES) {
      for (const name of ROLE_SKILLS[role]) {
        expect(await exists(join(SKILLS, name, 'SKILL.md')), name).toBe(true);
      }
    }
    expect(await exists(join(SKILLS, CONTRACT))).toBe(true);
  });

  it('reads the orchestrator token, or the agent one', () => {
    expect(mcpTokenVariable('orchestrator')).toBe('PACT_ORCHESTRATOR_TOKEN');
    expect(mcpTokenVariable('test')).toBe('PACT_AGENT_MCP_TOKEN');
  });
});

describe('writeRoleSkills', () => {
  it('copies only the skills of the role and the contract into its plugin', async () => {
    const skills = await writeRoleSkills(dir, { role: 'design', skillsDir: SKILLS, url: URL });
    const plugin = join(dir, 'plugin');
    expect(skills.pluginDir).toBe(plugin);
    expect((await readdir(join(plugin, 'skills'))).sort()).toEqual([
      'pact-design-system',
      'pact-mockup',
    ]);
    expect(skills.skills).toEqual([
      {
        name: 'pact-design-system',
        file: join(plugin, 'skills', 'pact-design-system', 'SKILL.md'),
      },
      { name: 'pact-mockup', file: join(plugin, 'skills', 'pact-mockup', 'SKILL.md') },
    ]);
    for (const name of ['pact-design-system', 'pact-mockup']) {
      expect(await readFile(join(plugin, 'skills', name, CONTRACT), 'utf8')).toBe(
        await readFile(join(SKILLS, CONTRACT), 'utf8'),
      );
    }
    expect(skills.contract).toBe(join(plugin, 'skills', 'pact-design-system', CONTRACT));
    expect(await readFile(join(plugin, '.mcp.json'), 'utf8')).toContain('PACT_AGENT_MCP_TOKEN');
  });

  it('starts again from the suite: a skill of a former role does not stay', async () => {
    await writeRoleSkills(dir, { role: 'design', skillsDir: SKILLS, url: URL });
    await writeRoleSkills(dir, { role: 'dev', skillsDir: SKILLS, url: URL });
    expect(await readdir(join(dir, 'plugin', 'skills'))).toEqual(['pact-dev']);
  });

  it('sends the agent to its files in one line', async () => {
    const skills = await writeRoleSkills(dir, { role: 'test', skillsDir: SKILLS, url: URL });
    expect(roleInstruction(skills)).toBe(
      `Tu es l'agent test de PACT. Lis et applique ${skills.skills[0]?.file ?? ''} et ${skills.contract}.`,
    );
  });
});

describe('.pact/ROLE.md of a generic CLI', () => {
  it('holds the skills, then the contract; removed at closing with the copy', async () => {
    const skills = await writeRoleSkills(dir, { role: 'design', skillsDir: SKILLS, url: URL });
    const worktree = join(root, 'dépôt', '.worktrees', 'autre-1');
    await mkdir(worktree, { recursive: true });
    await writeRoleFile(worktree, skills);
    const text = await readFile(join(worktree, ROLE_FILE), 'utf8');
    expect(text).toBe(await roleFileText(skills));
    const order = ['name: pact-design-system', 'name: pact-mockup', '# Contrat PACT'].map((part) =>
      text.indexOf(part),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    await writeFile(join(worktree, '.pact', 'recap.md'), '# Recap\n');
    await removeRoleFiles(dir, worktree);
    expect(await exists(dir)).toBe(false);
    expect(await exists(join(worktree, ROLE_FILE))).toBe(false);
    expect(await exists(join(worktree, '.pact', 'recap.md'))).toBe(true);
  });

  it('removes the copy alone for an agent with no worktree left', async () => {
    await writeRoleSkills(dir, { role: 'dev', skillsDir: SKILLS, url: URL });
    await removeRoleFiles(dir, null);
    expect(await exists(dir)).toBe(false);
  });
});
