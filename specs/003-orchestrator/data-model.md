# Data Model: Orchestrateur

S'appuie sur `specs/001-agent-workspace-core/data-model.md` et
`specs/002-review-integration/data-model.md`. Schémas zod dans `src/shared/model.ts` (persisté) et
`src/shared/orchestrator.ts` (propre à 003). Noms de champs en anglais, comme en 001 et 002.

## Persisté (JSON par workspace)

### Agent (étendu)

| Champ | Type | Règle |
|-------|------|------|
| `role` | `'orchestrator' \| null` | défaut `null`, pour charger les fichiers de 001/002 sans migration. Au plus un agent `orchestrator` par workspace, d'un CLI dont l'adaptateur le permet (R8) |

### Workspace (étendu)

| Champ | Type | Règle |
|-------|------|------|
| `integrationRequests` | `IntegrationRequest[]` | défaut `[]` ; une demande en attente au plus par agent (FR-020) |

### IntegrationRequest

| Champ | Type | Règle |
|-------|------|------|
| `id` | uuid | |
| `agentId` | uuid | l'agent dont le travail est à intégrer ; jamais l'orchestrateur |
| `mode` | `'squash' \| 'keep-commits'` | défaut `squash` |
| `message` | string, 1 à 4 000 caractères | proposé par l'orchestrateur, modifiable par l'utilisateur |
| `requestedAt` | date ISO | |

Une demande quitte la liste dès que l'utilisateur la confirme ou la refuse, ou que l'agent est fermé.
Son issue n'est pas persistée : elle devient un événement (ci-dessous).

## En mémoire (processus principal)

### OrchestratorSession

| Champ | Type | Règle |
|-------|------|------|
| `agentId` | uuid | l'orchestrateur |
| `workspaceId` | string | |
| `token` | 64 caractères hexadécimaux | régénéré à chaque démarrage, révoqué au retrait du rôle ou à la fermeture (R3) |
| `pluginDir` | chemin absolu | `userData/orchestrator/<agentId>/plugin`, réécrit à chaque démarrage (R2) |
| `events` | `OrchestratorEvent[]` | au plus 100, rendus par la prochaine attente (R5) |
| `waiting` | attente en cours ou rien | au plus une à la fois ; une seconde remplace la première, qui rend « remplacée » |

### OrchestratorEvent

| Champ | Type | Règle |
|-------|------|------|
| `at` | date ISO | |
| `agentId` | uuid | |
| `kind` | `'turn-finished' \| 'awaiting-answer' \| 'error' \| 'closed' \| 'integration'` | |
| `state` | `AgentState` | l'état de l'agent après l'événement |
| `summary` | string | la question en attente, l'erreur, ou l'issue de l'intégration |
| `integration` | `{ outcome: 'integrated' \| 'refused' \| 'conflicted' \| 'failed', commit?, files? }` ou absent | seulement pour `kind: 'integration'` |

### OrchestratorAction (journal, FR-021)

| Champ | Type | Règle |
|-------|------|------|
| `id` | uuid | |
| `at` | date ISO | |
| `tool` | `'send_prompt' \| 'launch_agent' \| 'close_agent' \| 'request_integration' \| 'run_tests'` | les lectures et attentes ne sont pas journalisées |
| `agentId` | uuid ou `null` | `null` pour un lancement refusé |
| `summary` | string, 200 caractères au plus | début de la consigne, CLI et branche, message de commit… |
| `outcome` | `'ok' \| 'refused'` | |
| `reason` | string ou `null` | la raison d'un refus (FR-022) |

Au plus 200 actions par orchestrateur, les plus anciennes oubliées.

## Dérivé (jamais stocké)

- **Disposition** : un workspace dont un agent a `role: 'orchestrator'` s'affiche « chef au centre »
  (R10).
- **Marque « ◎ de l'orchestrateur »** : vraie pour un agent entre l'événement
  `orchestrator:prompted` et son retour à `done` ou `awaiting-prompt` (R4).
- **À faire** : chaque `IntegrationRequest` donne un élément `integration-request` (« ◎ Intégrer
  <agent> → <branche principale> ? »), placé après les réponses attendues et avant les revues.
