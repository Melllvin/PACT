# Contrat — IPC main ↔ renderer (ajouts de 002)

Ajouts à `src/shared/ipc.ts`, mêmes règles que `specs/001-agent-workspace-core/contracts/ipc.md` :
- chaque canal a un schéma zod d'entrée et de sortie, validé des deux côtés ;
- le renderer ne passe jamais de chemin absolu ;
- un fichier est désigné par son chemin relatif au dépôt, au format `/`, refusé s'il contient `..`
  ou commence par `/`.

Les types (`ReviewSnapshot`, `FileDiff`, `TestRun`, `Integration`…) sont décrits dans
[data-model.md](../data-model.md).

## Nouveaux codes d'erreur

| Code | Sens |
|------|------|
| `LOCAL_CHANGES` | Intégration refusée : le dépôt principal a des changements locaux sur des fichiers touchés. `files` porte leur liste (FR-021). |
| `MAIN_MOVED` | La branche principale a bougé pendant l'intégration. Le main la revérifie et la relance une fois, puis renvoie cette erreur (R5). |
| `GIT_FAILED` | Erreur git affichée telle quelle (FR-023). |

## Requêtes (renderer → main, `invoke`)

| Canal | Entrée | Sortie | Exigences |
|-------|--------|--------|-----------|
| `review:open` | `{ agentId }` | `ReviewSnapshot` ; commence le suivi du worktree (R3) et lance les tests si besoin (R8) | FR-001, FR-002, FR-017 |
| `review:close` | `{ agentId }` | — ; arrête le suivi | FR-004 |
| `review:listPending` | `{ workspaceId }` | `string[]` : les agents à relire, demandés une fois l'état chargé (les `review:pending` envoyés avant l'ouverture de la fenêtre sont perdus) | FR-002, FR-003 |
| `review:fileDiff` | `{ agentId, path }` | `FileDiff` | FR-008 |
| `review:setSeen` | `{ agentId, path, seen: boolean }` | — ; mémorise ou oublie le blob actuel | FR-007, FR-009, FR-011 |
| `review:comment` | `{ agentId, path, line, text }` | `ReviewComment` ; consigne mise en file (R7) | FR-012, FR-014 |
| `review:send` | `{ agentId, kind: 'fix-comments' \| 'failing-tests' \| 'conflict' \| 'request', text? }` (`text` requis pour `request`) | — ; consigne mise en file | FR-013, FR-015 |
| `review:runTests` | `{ agentId }` | `TestRun` (`running`) | FR-017 |
| `review:cancelTests` | `{ agentId }` | — | |
| `workspace:setTestCommand` | `{ workspaceId, command: string \| null }` (`null` = détecter) | — | FR-017 |
| `integration:start` | `{ agentId, mode, message, after: { closeTile, removeWorktree }, confirmWorking?: boolean }` | `Integration` (`integrated`, `conflicted` ou erreur `LOCAL_CHANGES` / `MAIN_MOVED` / `GIT_FAILED`) ; refusée avec `INVALID_INPUT` si l'agent travaille et que `confirmWorking` est absent | FR-019…FR-027 |
| `integration:resolve` | `{ integrationId, path, hunk: number, choice: 'main' \| 'agent' \| 'both' }` ou `{ integrationId, path, content: string }` | `ConflictFile` | FR-029 |
| `integration:openInEditor` | `{ integrationId, path }` | — ; la copie modifiée revient par `integration:state` | FR-029 |
| `integration:askAgent` | `{ integrationId }` | `Integration` (`waiting-agent`) | FR-028 |
| `integration:finish` | `{ integrationId }` | `Integration` (`integrated`) \| erreur ; refusée tant qu'un conflit n'est pas résolu | FR-030 |
| `integration:cancel` | `{ integrationId }` | — | FR-031 |

L'abandon (FR-032) n'a pas de canal propre : le renderer confirme, puis appelle `agent:close` de
001, qui pose la question garder / supprimer.

## Événements (main → renderer, `on`)

| Canal | Charge | Usage |
|-------|--------|-------|
| `review:changed` | `ReviewSnapshot` | liste, totaux, « Nouveaux changements », conflits (FR-010, SC-006) |
| `review:pending` | `{ workspaceId, agentIds: string[] }` | badge de la vue Revue et bouton « Revue → » (FR-002, FR-003) |
| `review:tests` | `TestRun` | ligne Tests de la colonne Décision (FR-016) |
| `integration:state` | `Integration` | écran 1q, notification « ✓ Intégré » (US2/AC6) |

## Changements dans les canaux de 001

- `Workspace` gagne `testCommand` ; `Agent` gagne `review` (data-model).
- Le Focus active l'onglet Changements ; la vue Revue de la barre d'outils devient active dès que
  `review:pending` n'est pas vide (FR-006 et FR-033 de 001, remplacés par FR-001 de 002).
