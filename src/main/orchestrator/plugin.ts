import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 003 research R2, 004 R3 — the Claude Code plugin PACT writes for the session of an agent with a
// role: its skills and the pact MCP server, its token read from the agent's environment.

/** How Claude Code names a skill of the plugin. */
export const pluginSkill = (skill: string) => `pact:${skill}`;

/** 003's orchestrateur skill is now `pact-orchestrator` of the suite (004 T045). */
export const SKILL_NAME = pluginSkill('pact-orchestrator');

/**
 * Writes (again) the plugin manifest and its MCP server in `dir`; the server URL changes with each
 * start of PACT. The skills go in `<dir>/skills/<name>/`, written by the caller.
 */
export async function writePactPlugin(
  dir: string,
  { url, tokenVariable }: { url: string; tokenVariable: string },
) {
  await mkdir(join(dir, '.claude-plugin'), { recursive: true });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    json({
      name: 'pact',
      version: '1.0.0',
      description: "PACT : les rôles d'un workspace et leur serveur MCP",
    }),
  );
  await writeFile(
    join(dir, '.mcp.json'),
    json({
      mcpServers: {
        pact: { type: 'http', url, headers: { 'X-Pact-Token': `\${${tokenVariable}}` } },
      },
    }),
  );
}
