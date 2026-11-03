import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Role } from '../../shared/primitives';
import { ROLE_LABELS } from '../../shared/roles';
import { writePactPlugin } from './plugin';

// 004 R3, contracts/skills.md — the skills of a role and the common contract, copied for each
// agent outside the user's configuration and handed to its CLI.

/** Each agent gets the skills of its role and the contract, nothing else (FR-009). */
export const ROLE_SKILLS: Record<Role, readonly string[]> = {
  orchestrator: ['pact-orchestrator'],
  spec: ['pact-spec'],
  design: ['pact-design-system', 'pact-mockup'],
  dev: ['pact-dev'],
  test: ['pact-test'],
  recap: ['pact-recap'],
};

export const CONTRACT = 'pact-contract.md';

/** The generic CLI's copy, in its worktree and kept out of Git. */
export const ROLE_FILE = '.pact/ROLE.md';

/** Typed before anything else into a generic CLI with a role. */
export const ROLE_FILE_PROMPT = `Lis ${ROLE_FILE} : ton rôle dans ce workspace PACT et ses règles.`;

/** What a launch with a role carries: where its skills are. */
export type RoleSkills = {
  role: Role;
  /** `<rolesDir>/<agentId>/plugin`, Claude Code's `--plugin-dir`. */
  pluginDir: string;
  /** The skills, by name, each `SKILL.md` as an absolute path. */
  skills: { name: string; file: string }[];
  /** The common contract, as an absolute path. */
  contract: string;
};

/** The variable of the agent's environment that holds its MCP token. */
export const mcpTokenVariable = (role: Role) =>
  role === 'orchestrator' ? 'PACT_ORCHESTRATOR_TOKEN' : 'PACT_AGENT_MCP_TOKEN';

/** The instruction that sends an agent to its skills: a line, the content stays in the files. */
export function roleInstruction(skills: RoleSkills): string {
  const files = skills.skills.map((s) => s.file).join(', ');
  return (
    `Tu es l'agent ${ROLE_LABELS[skills.role].toLowerCase()} de PACT. ` +
    `Lis et applique ${files} et ${skills.contract}.`
  );
}

/**
 * Copies the skills of `role` and the contract into `<dir>/plugin` (each skill folder holds a copy
 * of the contract, which the skills name as « dans le dossier de ce skill »), with the plugin's
 * manifest and MCP server.
 */
export async function writeRoleSkills(
  dir: string,
  { role, skillsDir, url }: { role: Role; skillsDir: string; url: string },
): Promise<RoleSkills> {
  const pluginDir = join(dir, 'plugin');
  await rm(join(pluginDir, 'skills'), { recursive: true, force: true });
  await writePactPlugin(pluginDir, { url, tokenVariable: mcpTokenVariable(role) });
  const skills = [];
  for (const name of ROLE_SKILLS[role]) {
    const folder = join(pluginDir, 'skills', name);
    await cp(join(skillsDir, name), folder, { recursive: true });
    await cp(join(skillsDir, CONTRACT), join(folder, CONTRACT));
    skills.push({ name, file: join(folder, 'SKILL.md') });
  }
  const first = skills[0]?.file ?? join(pluginDir, 'skills', 'SKILL.md');
  return { role, pluginDir, skills, contract: join(dirname(first), CONTRACT) };
}

/** Everything the agent of a role reads, in one text: its skills, then the contract. */
export async function roleFileText(skills: RoleSkills): Promise<string> {
  const parts = [];
  for (const { file } of skills.skills) parts.push(await readFile(file, 'utf8'));
  parts.push(await readFile(skills.contract, 'utf8'));
  return parts.map((part) => part.trimEnd()).join('\n\n---\n\n') + '\n';
}

/**
 * The generic CLI's way: `.pact/ROLE.md` in its worktree; the caller adds `/.pact/ROLE.md` to the
 * exclude file of the repository, so `git status` stays clean.
 */
export async function writeRoleFile(worktree: string, skills: RoleSkills): Promise<void> {
  await mkdir(join(worktree, '.pact'), { recursive: true });
  await writeFile(join(worktree, ROLE_FILE), await roleFileText(skills));
}

/** At closing: the agent's copy of its skills, and its `.pact/ROLE.md` if it had one. */
export async function removeRoleFiles(dir: string, worktree: string | null): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  if (worktree !== null) await rm(join(worktree, ROLE_FILE), { force: true });
}
