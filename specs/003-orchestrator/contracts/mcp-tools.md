# Contrat — outils MCP de l'orchestrateur

Serveur `pact`, transport HTTP local (research R1), `POST /mcp`, en-tête
`X-Pact-Token: <jeton de l'orchestrateur>`. Côté Claude Code, les outils s'appellent
`mcp__plugin_pact_pact__<nom>` (vérifié sur 2.1.314).

Règles communes :
- **Désigner un agent** : `agent` est son identifiant ou son nom affiché (« Codex 2 »), insensible à
  la casse. Un nom ambigu ou inconnu est refusé.
- **Agents désignables** : ceux du workspace de l'orchestrateur, sauf lui-même ; jamais un
  terminal libre (FR-008).
- **Résultat** : un bloc `text` lisible, suivi d'un bloc `text` qui contient le JSON décrit ici.
  Un refus est un résultat avec `isError: true` et sa raison (FR-022), jamais une erreur JSON-RPC.
- **Erreurs JSON-RPC** : réservées au protocole (méthode inconnue `-32601`, paramètres invalides
  `-32602`).
- **Refus HTTP** : `401` sans jeton valide ou après retrait du rôle ; `403` si `Host` n'est pas local
  ou si `Origin` est présent (R3).

| Outil | Entrée | Résultat (JSON) | Exigences |
|-------|--------|-----------------|-----------|
| `list_agents` | — | `{ agents: { id, name, cli, branch, state, question: string \| null, toReview: boolean, waitingPrompts: number }[] }` | FR-011 |
| `get_changes` | `{ agent }` | `{ branch, files: ChangedFile[], added, removed, tests: { status, command, passedCount, outputTail } \| null, conflicts: 'none' \| string[] }` (002 data-model) | FR-012 |
| `get_file_diff` | `{ agent, path }` | `{ path, unified: string }` : le diff en texte unifié, ou `{ path, binary: true, size }` / `{ path, tooLarge: true, size }` | FR-012 |
| `run_tests` | `{ agent }` | `{ status: 'running' }` ; le résultat arrive par `get_changes` ou un événement | FR-014 |
| `send_prompt` | `{ agent, text: 1–8 000 caractères }` | `{ queued: true, position: number }` : 0 si tapée tout de suite | FR-009, FR-010 |
| `wait_for_agents` | `{ agents?: string[], timeoutSeconds?: 1–600 (défaut 300) }` | `{ events: OrchestratorEvent[], timedOut: boolean }` | FR-013 |
| `launch_agent` | `{ cli, model?, branch?, baseBranch?, prompt? }` | `{ agent: { id, name, branch, port } }` | FR-015 |
| `close_agent` | `{ agent }` | `{ closed: true, worktreeKept: true }` | FR-016 |
| `request_integration` | `{ agent, message, mode?: 'squash' \| 'keep-commits' }` | `{ requestId, status: 'waiting-user' }` ; l'issue arrive comme événement `integration` | FR-017…FR-020 |

`OrchestratorEvent` est décrit dans [data-model.md](../data-model.md).

Les descriptions des outils, envoyées par `tools/list`, sont en français et rappellent les règles du
skill : une consigne précise par agent, lire les changements et les tests avant de demander une
intégration, les questions des agents sont à l'utilisateur.
