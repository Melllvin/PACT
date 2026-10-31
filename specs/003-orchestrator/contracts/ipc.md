# Contrat — IPC main ↔ renderer (ajouts de 003)

Ajouts à `src/shared/ipc.ts`, mêmes règles que les contrats de 001 et 002 (schéma zod d'entrée et de
sortie, aucun chemin absolu venu du renderer).

## Changements dans les canaux existants

- `agents:launch` : chaque brouillon gagne `orchestrator: boolean` (défaut `false`). Refusé avec
  `INVALID_INPUT` pour un second orchestrateur dans le workspace ou un CLI qui ne le permet pas.
- `Agent` gagne `role`, `Workspace` gagne `integrationRequests` (data-model).
- `app:getState` donne pour chaque CLI `orchestrator: boolean` (l'adaptateur le permet), pour le
  lanceur.

## Requêtes (renderer → main, `invoke`)

| Canal | Entrée | Sortie | Exigences |
|-------|--------|--------|-----------|
| `orchestrator:revoke` | `{ agentId }` | — ; rôle retiré, jeton révoqué, consignes en file annulées, attente en cours terminée | FR-004 |
| `orchestrator:actions` | `{ agentId }` | `OrchestratorAction[]`, la plus récente en premier | FR-021 |
| `integrationRequest:confirm` | `{ requestId, message, confirmWorking?: boolean }` | `Integration` (comme `integration:start`) | FR-018 |
| `integrationRequest:refuse` | `{ requestId }` | — | FR-018, FR-019 |

## Événements (main → renderer, `on`)

| Canal | Charge | Usage |
|-------|--------|-------|
| `orchestrator:prompted` | `{ agentId }` | marque « ◎ de l'orchestrateur » sur la tuile (FR-010) |
| `orchestrator:action` | `OrchestratorAction & { orchestratorId }` | journal du Focus (FR-021) |
| `workspace:integrationRequests` | `{ workspaceId, requests: IntegrationRequest[] }` | À faire (FR-017) |
