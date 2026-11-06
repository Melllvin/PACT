# Data Model: Vue des agents

## Agent (modifié, persisté)

| Champ | Type | Règle |
|---|---|---|
| `launchedBy` | `string \| null` | id (uuid) de l'orchestrateur qui l'a lancé ; `null` = lancé par l'utilisateur. Défaut `null` à la lecture d'un état ancien. Posé une fois, au lancement ; jamais modifié ensuite. |

## AgentRow (dérivé)

| Champ | Type | Source |
|---|---|---|
| `agent` | `Agent` | workspace |
| `name` | `string` | `<CLI> <position>` |
| `role` | `Role \| null` | `agent.role` |
| `stateLabel` | `string` | `agentStateLabel(agent)` : démarre, travaille, attend une consigne, attend une réponse, fini, erreur, limite de débit, reprise à HH:MM, fermé |
| `issueId` | `string \| null` | `agentPhase` (R5) |
| `todo` | `TodoItem \| null` | premier élément de l'agent selon `ORDER` |
| `pending` | `number` | nombre d'éléments À faire de l'agent |

## AgentsView (dérivé)

`{ head: TodoItem[]; rows: AgentRow[]; agentCount: number; pendingCount: number }` — `head` :
éléments qui ne visent pas un agent seul ; `pendingCount` = éléments non `info` (inchangé).

Ordre de `rows` : `todo !== null` (ordre `ORDER` puis `position`), puis rôle `orchestrator`, puis
`position`.

## Phase (dérivée)

| Cas | `label` | `issueId` | `round` |
|---|---|---|---|
| boucle `running` | `dev ↔ test` | `loop.issueId` | `{ n: loop.round, max: 3 }` |
| boucle `passed` | `boucle terminée` | `loop.issueId` | — |
| boucle `escalated` | `boucle arrêtée` | `loop.issueId` | — |
| rôle `spec` / `design` / `recap`, hors boucle | le rôle | — | — |
| autre | aucune | — | — |

Plusieurs boucles pour un agent : la boucle `running` la plus récente, sinon la dernière du tableau ;
une boucle `closed` est ignorée.

## Graph (dérivé)

- **GraphNode** : `{ agentId, column, row, group: issueId | null }`.
- **GraphEdge** : `{ from, to, kind: 'launched' | 'loop' }` — `launched` : `launchedBy` → agent, si
  l'orchestrateur existe encore ; `loop` : dev ↔ test d'une boucle non `closed`.
- Pas d'orchestrateur ou orchestrateur fermé : aucun lien `launched`, nœuds à plat.
