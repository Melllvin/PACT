# Contract: canaux IPC ajoutés (src/shared/ipc.ts)

## Changements de schémas

- `agents:launch` : chaque brouillon gagne `role` (défaut `null`) et `effort` (défaut `null`) ;
  `orchestrator: true` (003) reste accepté et vaut `role: 'orchestrator'`.
- `app:getState` : chaque CLI gagne `modelTiers: string[][]`, `supportsEffort: boolean`.
- `Workspace` gagne `roleProfiles`, `issues`, `loops`, `testPaths`, `publishRequests` (data-model).

## Requêtes (renderer → main)

| Canal | Entrée | Sortie | Exigences |
|-------|--------|--------|-----------|
| `roles:setProfiles` | `{ workspaceId, profiles: Partial<Record<Role, RoleProfile>> }` | `{ warnings: string[] }` | FR-003, FR-004 |
| `loop:decide` | `{ workspaceId, issueId, decision: 'restart' \| 'take-over' \| 'abandon' }` | `Loop` | FR-018 |
| `publishRequest:confirm` | `{ requestId }` | `{ issues: { id, url }[] }` | FR-023 |
| `publishRequest:refuse` | `{ requestId }` | — | FR-023 |
| `preview:list` | `{ agentId }` | `{ files: { path, kind: 'mockup' \| 'recap' \| 'issue' \| 'other' }[] }` | FR-025 |
| `preview:decide` | `{ agentId, path, decision: 'validated' \| 'refused', comment? }` | — | FR-028 |

## Événements (main → renderer)

| Canal | Charge | Usage |
|-------|--------|-------|
| `orchestrator:report` | `HandoffReport & { orchestratorId }` | bande « Rapports », onglet « ◎ Rapports » (FR-006a) |
| `preview:changed` | `{ agentId, path }` | rafraîchir l'Aperçu (FR-027) |
| `preview:blocked` | `{ agentId, url }` | « ressource externe bloquée » (FR-026) |

Les listes du workspace (`issues`, `loops`, `publishRequests`) arrivent par l'événement de workspace
existant, comme `integrationRequests` de 003.
