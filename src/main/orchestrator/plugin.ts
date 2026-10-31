import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 003 research R2 — the Claude Code plugin PACT writes for its orchestrator's session: the
// pact:orchestrateur skill and the pact MCP server, its token read from the agent's environment.

export const SKILL_NAME = 'pact:orchestrateur';

const SKILL = `---
name: orchestrateur
description: Diriger les autres agents PACT de ce workspace (consignes, suivi, lecture des changements, intégration). À utiliser dès qu'un travail se répartit entre plusieurs agents.
---
Tu es l'orchestrateur de ce workspace PACT. Les autres agents ont chacun leur CLI, leur worktree et
leur branche ; tu les diriges avec les outils du serveur MCP « pact ».

Méthode :
1. \`list_agents\` : qui est là, qui travaille, qui attend.
2. Découpe le travail et donne à chaque agent une consigne précise et autonome avec
   \`send_prompt\` : le but, les fichiers concernés, ce qui est hors de son périmètre, comment vérifier.
3. \`wait_for_agents\` : attends la fin de leur tour au lieu d'interroger en boucle.
4. \`get_changes\` puis \`get_file_diff\` : lis ce qu'ils ont fait ; \`run_tests\` si besoin.
5. Renvoie une consigne de correction, ou passe à la suite.
6. \`request_integration\` : seulement après avoir lu les changements et l'état des tests. PACT
   demande toujours la confirmation de l'utilisateur ; l'issue t'arrive par \`wait_for_agents\`.

Règles :
- Les questions et autorisations des agents sont à l'utilisateur : tu les vois dans
  \`list_agents\` mais tu n'y réponds pas.
- \`launch_agent\` et \`close_agent\` existent ; fermer garde le worktree et la branche.
- Deux agents ne doivent pas modifier les mêmes fichiers en même temps.
- Un refus de PACT donne sa raison : tiens-en compte au lieu de réessayer à l'identique.
`;

/** Writes (again) the plugin in `dir`; its server URL changes with each start of PACT. */
export async function writeOrchestratorPlugin(dir: string, { url }: { url: string }) {
  await mkdir(join(dir, '.claude-plugin'), { recursive: true });
  await mkdir(join(dir, 'skills', 'orchestrateur'), { recursive: true });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    json({
      name: 'pact',
      version: '1.0.0',
      description: "PACT : diriger les agents d'un workspace",
    }),
  );
  await writeFile(join(dir, 'skills', 'orchestrateur', 'SKILL.md'), SKILL);
  await writeFile(
    join(dir, '.mcp.json'),
    json({
      mcpServers: {
        pact: { type: 'http', url, headers: { 'X-Pact-Token': '${PACT_ORCHESTRATOR_TOKEN}' } },
      },
    }),
  );
}
