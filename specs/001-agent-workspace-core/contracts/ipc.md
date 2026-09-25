# Contrat — IPC main ↔ renderer

Fichier : `src/shared/ipc.ts`. Chaque canal a un schéma zod d'entrée et de sortie, validé dans le
preload (côté renderer) et dans le handler (côté main). Le renderer n'a accès qu'à `window.pact`.

## Requêtes (renderer → main, `invoke`)

| Canal | Entrée | Sortie | Exigences |
|-------|--------|--------|-----------|
| `app:getState` | — | `{ workspaces, recents, clis, permission }` | FR-005 |
| `workspace:open` | `{ path }` | `Workspace` \| erreur `NOT_A_REPO` / `ALREADY_OPEN(id)` | FR-003, FR-004 |
| `workspace:initRepo` | `{ path }` | `Workspace` | US1 sc. 5 |
| `workspace:clone` | `{ url, destination }` | `{ jobId }` (progression via événement) | FR-003 |
| `workspace:close` | `{ id }` | — | |
| `workspace:hasLocalChanges` | `{ id }` | `boolean` (modifications non commitées dans le dépôt principal, que les worktrees n'incluent pas) | Edge case « modifications non commitées », T122 |
| `dialog:pickFolder` | `{ purpose: 'open-repository' \| 'clone-destination' }` | chemin absolu \| `null` (annulé) | US1 sc. 1, 2 |
| `cli:add` | `{ name, command }` | `CliDefinition` (avec `status`) | FR-008 |
| `cli:redetect` | — | `CliDefinition[]` | FR-007 |
| `permission:set` | `PermissionPreference & { workspaceId? }` (inclut `autoResume`) | — | FR-012, FR-035 |
| `agents:launch` | `{ workspaceId, agents: AgentDraft[], freeTerminals: number, counters }` | `Agent[]` \| erreurs de validation (`LIMIT`, `BRANCH_CONFLICT`, `PORT_CONFLICT`) ; l'ordre de `agents` est celui des tuiles | FR-009…FR-018, US6 sc. 4 |
| `agent:answer` | `{ agentId, answer: 'allow' \| 'deny', always?: boolean }` | — | FR-024, FR-034 |
| `agent:resume` | `{ agentId }` | — | FR-024 |
| `agent:restart` | `{ agentId }` | — | FR-024 |
| `agent:close` | `{ agentId, removeWorktree: boolean }` | — | FR-037 |
| `agent:cancelAutoResume` | `{ agentId }` | — | FR-036 |
| `agent:log` | `{ agentId }` | `string` (sortie complète du tampon) | « Journal » |
| `term:write` | `{ termId, data }` | — (fire-and-forget) | FR-020 |
| `term:resize` | `{ termId, cols, rows }` | — | |

## Événements (main → renderer, `on`)

| Canal | Charge | Usage |
|-------|--------|-------|
| `term:data` | `{ termId, data }` regroupé par trame | rendu xterm |
| `term:exit` | `{ termId, code }` | |
| `agent:state` | `{ agentId, state, lastError?, scheduledResume? }` | pulse, halo, actions, À faire |
| `agent:branch` | `{ agentId, branch }` | infobulle ⎇ |
| `workspace:status` | `{ id, status }` | dossier disparu |
| `clone:progress` | `{ jobId, percent, phase }` / `{ jobId, error }` / `{ jobId, workspace }` (terminé, dépôt ouvert) | US1 sc. 2 |

## Règles

- Aucun chemin, commande ou argument venant du renderer n'est exécuté sans validation zod et
  résolution côté main (pas de commande shell arbitraire, sauf `cli:add` qui enregistre une
  commande choisie explicitement par l'utilisateur).
- Toute erreur est renvoyée sous la forme `{ code, message }` avec un message affichable.
  Codes : `INVALID_INPUT`, `NOT_A_REPO`, `ALREADY_OPEN` (avec `workspaceId` de l'onglet existant,
  FR-004), `LIMIT`, `BRANCH_CONFLICT`, `PORT_CONFLICT`, `NOT_FOUND`, `CLONE_FAILED`, `INTERNAL`.
- Les chemins reçus du renderer (`workspace:open`, `workspace:initRepo`, `workspace:clone`)
  doivent être absolus.

## AgentDraft

Un agent à lancer (mode rapide ou détaillé, FR-011) : `{ cliId, model, permissionLevel,
baseBranch, branch, port, startCommand }`. `null` signifie « hérité de Commun à tous » ou « choisi
automatiquement » (branche `agent/<cli>-<n>`, port 3000 + position).
