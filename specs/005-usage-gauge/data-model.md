# Data Model: Jauge de limite d'usage

## Persisté

### AppState (étendu)

| Champ | Type | Règle |
|---|---|---|
| `usageThresholds` | `{ warn: number; critical: number }` | défaut `{ warn: 80, critical: 95 }` ; entiers 1…100, `warn < critical` |

## En mémoire (processus principal)

### UsageWindow

| Champ | Type | Règle |
|---|---|---|
| `id` | `'five-hour' \| 'week' \| string` | `string` pour une fenêtre par modèle |
| `label` | string | « 5 h », « semaine », « semaine · Opus » |
| `usedPercent` | number | ≥ 0, peut dépasser 100 |
| `resetsAt` | date ISO \| null | |

### UsageReading

| Champ | Type | Règle |
|---|---|---|
| `cliId` | string | `claude-code` ou `codex` |
| `account` | string | clé de compte (R3) ; `default` sans dossier de configuration personnalisé |
| `windows` | `UsageWindow[]` | au moins une |
| `readAt` | date ISO | |

### AgentShare

| Champ | Type | Règle |
|---|---|---|
| `agentId` | uuid | |
| `workspaceId` | uuid | |
| `label` | string | « Claude Code 2 » |
| `role` | `Agent.role` | 004, `null` sinon |
| `tokens` | number | delta depuis le début de la fenêtre courante (R5) |
| `closed` | boolean | |

### UsageState (événement `usage:state`, un par compte)

`{ cliId, account, reading: UsageReading | null, shares: AgentShare[], level: 'ok' | 'warn' | 'critical' }`

## Dérivé (renderer, `src/shared/usage.ts`, pur)

- **fenêtre affichée** : plus grand `usedPercent`, la plus courte à égalité (R4) ;
- **âge** : `now - readAt` ; `stale` > 15 min ; masquée > 60 min ;
- **jauges d'un workspace** : comptes dont un agent ouvert du workspace a le CLI, ou dont la lecture a
  moins d'une heure et qu'un agent du workspace a utilisé ;
- **À faire** `usage-limit` : « ◆ Limite <CLI> à <N> % · <fenêtre> · réinitialisation <heure> »,
  une par compte au niveau `warn` ou `critical` ;
- **parts du workspace** : agents du workspace triés par `tokens` décroissant, puis « autres ».
