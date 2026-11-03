# Contrat IPC (ajouts à `src/shared/ipc.ts`)

## Requêtes

| Canal | Entrée | Sortie |
|---|---|---|
| `usage:get` | `{}` | `UsageState[]` (état courant, au chargement du renderer) |
| `settings:usageThresholds` | `{ warn: int 1–99, critical: int 2–100 }`, `warn < critical` | `{ warn, critical }` |

## Événements

| Canal | Charge |
|---|---|
| `usage:state` | `UsageState` (data-model), à chaque lecture, changement de part ou de seuil |

L'état initial (`app:state`) gagne `usageThresholds`.
