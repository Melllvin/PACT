# Data Model: Gestionnaire de stockage

Schémas Zod dans `src/shared/storage.ts`. Rien n'est persisté, sauf `storageNotice` dans `state.json` (avec défaut,
sans migration) et `pending-cleanup.json` écrit par le geste de suppression d'un cache (R12). Les tailles, les états et
le total de l'avis vivent en mémoire dans `StorageService`.

## Constantes

| Nom | Valeur | Source |
|---|---|---|
| `NOTICE_DEFAULT_GB` | 5 | Q3, FR-020 |
| `NOTICE_MIN_GB`, `NOTICE_MAX_GB` | 1, 500 | O7 |
| `BACKGROUND_DELAY_MS` | 30 000 | R3 |
| `SIZE_BATCH_MS` | 250 | R3 |
| `MAX_LISTED_FILES` | 20 par catégorie | R9 |
| `MAX_UNPUSHED` | 50 | R5 |
| `MAX_SUBJECT` | 80 | R9 |
| `ELECTRON_CACHES` | liste fermée de R8 | R8, R12 |

## StoredItem

| Champ | Type | Règle |
|---|---|---|
| `id` | chaîne | stable pour une vue : `kind` + chemin résolu, hachés |
| `kind` | `worktree` \| `dead-entry` \| `electron-cache` \| `role-orphan` \| `integration-leftover` \| `conflict-copies` \| `store-backup` \| `workspace-data` \| `state` \| `foreign` | `foreign` : vu mais pas de PACT (worktree externe, dossier inconnu, lien, `deliveries/`, `pact-index-*`, branche seule) |
| `path` | chaîne | chemin résolu affiché |
| `projectId` | chaîne \| null | `null` pour les éléments de l'application |
| `size` | entier ≥ 0 \| null | `null` tant qu'inconnue |
| `ownership` | `pact` \| `readOnly` | R6 ; `readOnly` porte `readOnlyReason` |
| `readOnlyReason` | `external-worktree` \| `unknown-to-git` \| `symlink` \| `never` \| `planned` (O1, O2, O5) \| null | |
| `deletable` | `yes` \| `strong` \| `refused` \| `no` | `strong` : confirmation renforcée ; `refused` : FR-010, porte `refusal` |
| `refusal` | `running` \| `integration` \| `delivery` \| `terminal` \| `open-project` \| null | R15 |
| `safe` | booléen | vrai seulement pour un worktree qui passe R14 |
| `effect` | `restart` \| `workspace-data` \| `backup` \| null | R8 |
| `error` | chaîne \| null | erreur de lecture de cet élément seul (Edge Cases) |

`totals(items)` (pur) : `all` = somme des tailles connues ; `recoverable` = éléments `safe` ; `deletable` = éléments
`deletable ∈ { yes, strong }` et `ownership = pact`, `state` jamais (US5 sc.9). Chaque total porte `complete: boolean`
(toutes les tailles connues) et `estimate: true` (R4).

## WorktreeInfo (élément `worktree`)

| Champ | Type | Règle |
|---|---|---|
| `project` | `{ id, name }` | |
| `branch` | chaîne \| null | branche réelle (`git worktree list`), `null` si détaché |
| `agent` | `{ id, name, role, state, running }` \| null | « aucun agent » si `null` (US2 sc.2) |
| `pr` | `{ number, state: 'open' \| 'merged' \| 'closed' \| 'unknown', tracked: boolean }` \| null | R13 ; jamais de champ textuel |
| `modified`, `untracked` | entier | compte du `status` |
| `unpushed` | entier | R5 |
| `lastChange` | date ISO \| null | Q10 |
| `remotesReadAt` | date ISO \| null | `mtime` de `FETCH_HEAD`, pour « état connu au … » (FR-006) |
| `oldVersion` | booléen | ni agent, ni demande, ni trace (Q5) |
| `remoteBranch` | `{ name, offered: boolean }` \| null | R17 |

## Loss (rendue par `storage:confirm`)

| Champ | Type | Règle |
|---|---|---|
| `itemId` | chaîne | |
| `fingerprint` | sha-256 hex | R9 |
| `modified`, `untracked` | `{ paths: string[], more: number }` | irrécupérables |
| `pactFiles` | chaîne[] | `.pact/**` et `design/mockups/**` non suivis (US3 sc.5, FR-010) |
| `commits` | `{ sha, subject, recoverable: boolean, remote: string \| null }[]` | Q14 ; `more` au-delà de 50 |
| `ignored` | `{ size: number \| null, env: string[] }` | Q11 |
| `effect` | comme `StoredItem.effect` | |
| `strong` | `{ expected: string }` \| null | nom du dossier à taper (FR-010) |
| `openTerminals` | entier | terminaux libres ouverts dans le projet, cités (O9) |
| `remoteBranch` | `{ name }` \| null | case offerte, décochée (FR-013) |

## RemovalRequest et RemovalResult

```text
RemovalRequest = { items: { id, fingerprint, typed: string | null }[], remoteBranches: string[] /* ids */ }
RemovalResult  = { id, outcome: 'removed' | 'changed' | 'refused' | 'gone' | 'busy' | 'failed', reason: string | null,
                   freed: number | null, restartNeeded: boolean }[]
```

`changed` : empreinte différente (FR-009) ; `gone` : déjà absent (Edge Cases) ; `failed` porte le message de Git ou du
système, borné à 500 caractères.

## StorageNotice (`state.json.storageNotice`)

| Champ | Type | Défaut |
|---|---|---|
| `enabled` | booléen | `true` |
| `thresholdGb` | entier 1–500 | 5 |

## En mémoire

| Où | Contenu | Après redémarrage |
|---|---|---|
| `StorageService` | inventaire et tailles de la vue ouverte, `AbortController` du calcul | refait à l'ouverture |
| `StorageService` | total supprimable du calcul à basse priorité | recalculé 30 s après le démarrage |
| `StorageService` | verrous de suppression par `id` | aucun |
| `StorageService` | état des PR lues, par numéro, pour la vue ouverte | relu à l'ouverture suivante |
