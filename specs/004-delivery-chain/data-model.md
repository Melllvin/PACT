# Data Model: Chaîne de livraison

Extensions des schémas zod de `src/shared/model.ts` (001–003). Tous les nouveaux champs ont une valeur
par défaut : un fichier de workspace de 003 se lit sans migration.

## Persisté (JSON du workspace)

### Agent (étendu)

| Champ | Type | Règle |
|-------|------|------|
| `role` | `'orchestrator' \| 'spec' \| 'design' \| 'dev' \| 'test' \| 'recap' \| null` | défaut `null` ; un orchestrateur au plus par workspace (003 R8) |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max' \| null` | défaut `null` ; transmis aux seuls CLI qui le gèrent (R2) |

### Workspace (étendu)

| Champ | Type | Règle |
|-------|------|------|
| `roleProfiles` | `Partial<Record<Role, RoleProfile>>` | défaut `{}` ; un rôle absent prend le profil par défaut (R2) |
| `issues` | `Issue[]` | défaut `[]` |
| `loops` | `Loop[]` | défaut `[]` ; une boucle active au plus par issue |
| `testPaths` | `string[]` (motifs glob) | défaut `['**/*.test.*', '**/*.spec.*', 'tests/**', 'test/**', '**/__tests__/**']` (R6) |
| `publishRequests` | `PublishRequest[]` | défaut `[]` ; une demande au plus par workspace (une nouvelle remplace l'ancienne) |

### RoleProfile

| Champ | Type | Règle |
|-------|------|------|
| `cliId` | string | CLI installé, sinon le lancement est refusé avec la raison |
| `model` | string \| null | `null` = modèle par défaut du CLI |
| `effort` | comme `Agent.effort` | |
| `maxModel` | string \| null | plafond ; `null` = pas de plafond ; n'agit que sur les noms des paliers du CLI |
| `escalate` | boolean | défaut `false` (FR-007) |

Profils par défaut (`src/shared/roles.ts`), pour le premier CLI installé qui a des paliers (sinon le
premier installé, modèles `null`) : orchestrateur, spec, design = palier fort ; dev = palier moyen ;
test = palier du dev ou plus ; recap = petit palier. Avertissement (non bloquant) si
`palier(test.model) < palier(dev.model)` (FR-004).

### Issue

| Champ | Type | Règle |
|-------|------|------|
| `id` | string | nom du fichier sans `.md` (`0012-connexion`) ; unique dans le workspace |
| `title` | string | premier titre `# ` du fichier |
| `path` | string | relatif au worktree de l'orchestrateur, sous `.pact/issues/` |
| `state` | `'proposed' \| 'ready' \| 'in-progress' \| 'done' \| 'escalated' \| 'abandoned'` | voir transitions |
| `remote` | `{ number: number; url: string } \| null` | après publication confirmée (FR-023) |
| `trace` | `{ branch: string \| null; agents: string[]; pr: string \| null }` | FR-024 |

Transitions : `proposed → ready` (register_issue : critères présents, aucune question ouverte) ;
`ready → in-progress` (start_loop) ; `in-progress → done` (verdict `accepted` + run PACT à 0, FR-019) ;
`in-progress → escalated` (3ᵉ verdict `defects`) ; `escalated → in-progress` (« Relancer 3 tours ») ;
`escalated → abandoned` (« Abandonner ») ; « Reprendre la main » clôt la boucle et laisse l'issue
`escalated` jusqu'à ce que l'utilisateur la marque faite ou abandonnée.

### Loop

| Champ | Type | Règle |
|-------|------|------|
| `issueId` | string | |
| `devAgentId`, `testAgentId` | uuid | deux agents différents, de rôles `dev` et `test` |
| `round` | 1…3 | |
| `rounds` | `Round[]` | un par tour commencé |
| `state` | `'running' \| 'passed' \| 'escalated' \| 'closed'` | |
| `escalatedModel` | string \| null | modèle du dev au tour 3 si escalade (FR-007) |

### Round

| Champ | Type | Règle |
|-------|------|------|
| `n` | 1…3 | |
| `startedAt` | date ISO | |
| `reports` | `HandoffReport[]` | contracts/handoff-report.md |
| `proof` | `{ tree: gitId; exitCode: number; at: ISO } \| null` | run PACT de la commande de test (R6) |
| `testerTouched` | string[] | fichiers hors tests modifiés par le test pendant ce tour (FR-020) |

### PublishRequest

| Champ | Type | Règle |
|-------|------|------|
| `id` | uuid | |
| `issueIds` | string[] | 1 à 20 issues `ready` sans `remote` |
| `requestedAt` | date ISO | |

## En mémoire (processus principal)

### Jeton d'agent (R5)

Un jeton par agent avec un rôle autre qu'orchestrateur, enregistré sur `/mcp` comme celui de 003 mais
qui n'ouvre que `submit_report`. Révoqué à la fermeture de l'agent.

### OrchestratorEvent (étendu, 003)

`kind` gagne : `'report' | 'report-missing' | 'loop' | 'overlap' | 'mockup' | 'publish'`.

| Champ ajouté | Type | Pour |
|---|---|---|
| `report` | `HandoffReport` | `report` |
| `loop` | `{ issueId, round, state, proof? }` | `loop` |
| `overlap` | `{ agents: uuid[]; files: string[] }` | `overlap` |
| `mockup` | `{ path, decision: 'validated' \| 'refused', comment }` | `mockup` |
| `publish` | `{ outcome: 'published' \| 'refused' \| 'failed', issues?: { id, url }[], error? }` | `publish` |

## Dérivé (renderer)

- **Tuile** : rôle (« dev », « test »…), « tour N/3 » quand l'agent est dans une boucle active.
- **Tuile du chef** : bande « Rapports », dernier rapport par agent (agent, issue, statut, tour).
- **À faire** (après les réponses et les demandes d'intégration de 003, avant les revues) :
  - `loop-escalated` : « ✕ Boucle arrêtée · <issue> · 3 tours » ; Relancer 3 tours, Reprendre la main,
    Abandonner ;
  - `publish-issues` : « ◎ Créer N issues ? » avec les titres ; Créer, Refuser ;
  - `overlap` : « ⚠ Fichiers communs · <agents> » avec les fichiers.
