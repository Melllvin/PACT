# Data Model: Workflow configurable en graphe

Schémas Zod dans `src/shared/workflow.ts`. Le fichier `.pact/workflow.yaml` est lu par `parseWorkflow` (YAML → modèle,
avec les lignes) ; l'état d'exécution s'ajoute à `workspaceSchema` (`src/shared/model.ts`). Tous les nouveaux champs ont
un défaut : les anciens fichiers d'état se chargent sans migration.

## Constantes

Voir `research.md` R18.

## Fichier `.pact/workflow.yaml` (format 1)

```yaml
version: 1
name: livraison
agents:
  spec: { role: spec }
  tester: { role: test }
  dev: { role: dev, model: claude-sonnet-5-5 }
stages:
  - { id: spec, type: spec, agents: [spec] }
  - { id: test, type: test, agents: [tester], instruction: "Tests d'abord, sans toucher au code." }
  - { id: dev, type: dev, agents: [dev] }
  - { id: polish, type: polish, agents: [dev, tester], passes: 1, instruction: "Noms et commentaires." }
  - { id: pr, type: pr, mergeMode: squash, position: { x: 640, y: 120 } }
transitions:
  - { from: spec, to: test, on: [ready] }
  - { from: test, to: dev, on: [tests-written, defects], maxRounds: 3 }
  - { from: dev, to: test, on: [done] }
  - { from: test, to: polish, on: [accepted] }
  - { from: polish, to: pr, on: [done] }
  - { from: pr, to: dev, on: [ci-red, tests-failed, conflicted, user-refused], maxRounds: 3 }
start: spec
ends: [pr]
```

Ordre des clés à la création : `version`, `name`, `agents`, `stages`, `transitions`, `start`, `ends`, puis `parallel`.
Un fichier existant garde son ordre (R13).

### Workflow

| Champ | Type | Règle |
|---|---|---|
| `version` | entier | obligatoire ; 1 seul connu (FR-004) ; > 1 → refus sans écriture |
| `name` | chaîne 1–60, `[a-z0-9-]` | nomme le workflow, un par projet en première phase (Q3) |
| `agents` | map clé → `WorkflowAgent` | 1–6 clés (`MAX_AGENTS`), clé `[a-z][a-z0-9-]{0,30}` |
| `stages` | `Stage[]`, 1–20 | `id` uniques |
| `transitions` | `Transition[]` | |
| `start` | id d'étape | |
| `ends` | id d'étape[], ≥ 1 | ni `test` ni `polish` (O6) |
| `parallel` | `ParallelGroup[]`, défaut absent | seconde phase : conservé, non exécuté (FR-006) |

### WorkflowAgent

| Champ | Type | Règle |
|---|---|---|
| `role` | `spec` \| `design` \| `dev` \| `test` \| `recap` | `orchestrator` refusé : l'orchestrateur n'est pas une étape |
| `cli` | id de CLI, optionnel | absent : CLI du profil du rôle ; non installé → invalide sur cette machine |
| `model` | chaîne, optionnelle | absent : modèle du profil ; hors paliers ou au-dessus de `maxModel` → invalide sur cette machine (FR-017) |

### Stage

| Champ | Type | Règle |
|---|---|---|
| `id` | `[a-z][a-z0-9-]{0,30}` | unique |
| `type` | `spec` \| `design` \| `dev` \| `test` \| `polish` \| `pr` \| `recap` | FR-001 |
| `agents` | clé d'agent[] | rôles requis par type (research R4) ; `pr` : vide ou absent |
| `instruction` | chaîne ≤ 2000, optionnelle | consigne libre (Q7), envoyée par PACT (R9) |
| `passes` | entier 0–5 | `polish` seulement, défaut 0 |
| `mergeMode` | `squash` \| `merge` \| `rebase` | `pr` seulement, défaut `squash` (Q5) |
| `position` | `{ x, y }` entiers ≥ 0, optionnelle | sans effet sur le comportement (Q8) |

### Transition

| Champ | Type | Règle |
|---|---|---|
| `from`, `to` | id d'étape | |
| `on` | résultat[], ≥ 1 | liste fermée par type d'étape `from` (research R5) |
| `maxRounds` | entier 1–10, optionnel | obligatoire si la transition ferme un cycle (FR-002) ; même valeur pour toutes les transitions plafonnées vers une même étape |
| `when` | objet, optionnel | seconde phase : conservé, non exécuté ; une chaîne → invalide (US4 sc.4) |

### ParallelGroup (seconde phase, décrit sans être exécuté)

| Champ | Type | Règle |
|---|---|---|
| `id` | identifiant | |
| `stages` | id d'étape[], ≥ 2 | |
| `join` | `all` \| `any` | règle de jonction |

### Résultats (`Outcome`)

```text
ready | done | tests-written | accepted | defects | merged | ci-red | tests-failed | conflicted | user-refused
```

Par type : voir research R5. `outcomesOf(type)` les rend ; `terminalOutcome(type)` : `merged` pour `pr`, `ready` pour
`spec`, `done` sinon.

## Validation

```text
WorkflowIssue = { code, message, stage?: string, line?: number, column?: number }
Validation    = { workflow: Workflow | null, errors: WorkflowIssue[], phase2: WorkflowIssue[] }
MachineCheck  = WorkflowIssue[]        // FR-017, CLI : invalide sur cette machine seulement
```

`code` ∈ `syntax`, `duplicate-key`, `alias`, `too-large`, `version-missing`, `version-newer`, `schema`, `unknown-ref`,
`too-many-agents`, `missing-role`, `same-agent-loop`, `bad-outcome`, `ambiguous-outcome`, `unreachable`,
`no-end-reachable`, `bad-end`, `uncapped-cycle`, `caps-differ`, `cap-too-high`, `free-expression`, `phase2`,
`model-unavailable`, `model-above-ceiling`, `cli-missing`.

## Workspace (ajouts)

```text
workflow: {
  lastValid: { oid: sha, workflow: Workflow } | null,   // dernière version valide de la branche principale (R10)
  error: { message, line?: number, oid: sha } | null,   // version courante invalide, affichée
  readAt: date ISO | null
}   défaut : { lastValid: null, error: null, readAt: null }

runs: Run[]   défaut []
```

`lastValid: null` et aucun fichier : le workflow est `defaultWorkflow(workspace.delivery)`, jamais écrit (FR-011).

## Run (`workspace.runs[]`, persisté)

| Champ | Type | Règle |
|---|---|---|
| `issueId` | chaîne | une exécution par issue |
| `oid` | sha \| `'default'` | blob du fichier au démarrage, ou défaut |
| `workflow` | `Workflow` | copie figée au démarrage (FR-007, US3 sc.4) |
| `stage` | id d'étape | étape en cours (FR-012) |
| `status` | `active` \| `waiting-user` \| `finished` \| `refused` | `waiting-user` : escalade de 008 ; `refused` : seconde phase ou invalide sur cette machine, avec `reason` |
| `bindings` | map clé d'agent → uuid d'agent | R9 |
| `entries` | map id d'étape → entier ≥ 0 | entrées hors étape `dev` d'une boucle (R7) |
| `lastMessageId` | uuid \| null | dernier message du journal traité (R8) |
| `history` | `{ at, from, to, outcome }[]` ≤ 50 | les plus anciens partent d'abord |
| `reason` | chaîne \| null | raison d'un refus |
| `startedAt`, `updatedAt` | date ISO | |

### Cycle

```text
(register_issue) ─▶ active@start ─résultat avec transition─▶ active@cible ─▶ … ─résultat terminal d'une arrivée─▶ finished
active ─plafond atteint (008 FR-018)─▶ waiting-user ─décision « restart » de l'utilisateur─▶ active
(register_issue) ─seconde phase ou machine invalide─▶ refused   (aucune étape exécutée, SC-005)
```

## Changements dans 007 et 008

| Où | Changement |
|---|---|
| `src/shared/exchanges.ts` (007) | kind `stage` (type `action`), champ structuré `stage: { issue, from, to, outcome }` |
| `Delivery` (008) | `agentId` nullable ; `source: 'agent' \| 'workflow'`, défaut `agent` |
| `LoopServiceDeps` (008) | `maxRounds(workspaceId, issueId): number` ; `polish(workspaceId, issueId): { passes, brief }` |
| `DeliveryService` (008) | `mergeMode` lu par `mergeModeOf(workspaceId, issueId)` ; `requestUnverified({ source: 'workflow' })` |
| `deliveryGate` (008) | relecture forcée si le diff touche `WORKFLOW_PATH` (research R17) |
| `workspace.delivery` (008) | `auto` reste la source ; `mergeMode`, `maxRounds`, `polishPasses`, `polishBrief` ne sont plus lus qu'en l'absence de fichier |

## TodoKind

| `kind` | Titre | Actions |
|---|---|---|
| `workflow-invalid` | `◆ Workflow invalide · ligne <n> · <raison>` | Ouvrir le workflow |
| `workflow-refused` | `◆ Issue <id> · workflow non exécutable · <raison>` | Ouvrir le workflow |

`workflow-invalid` n'apparaît qu'une fois par `oid`. La relecture de la PR d'enregistrement est l'élément
`delivery-review` de 008 (titre suffixé « · workflow »).

## En mémoire (non persisté)

| Où | Contenu | Après redémarrage |
|---|---|---|
| `WorkflowService` | verrou par exécution | messages après `lastMessageId` rejoués |
| Éditeur (renderer) | brouillon, `moved`, sélection | perdus : rien n'est enregistré sans PR |
