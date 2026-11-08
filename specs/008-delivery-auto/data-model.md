# Data Model: Livraison automatique

Schémas Zod dans `src/shared/delivery.ts`, intégrés à `workspaceSchema` (`src/shared/model.ts`). Tous les nouveaux
champs ont un défaut : les anciens fichiers se chargent sans migration, sauf les deux conversions dites en fin de page.

## Constantes

Voir `research.md` R25 : `CI_POLL_MS`, `SILENT_CI_MS`, `FORGE_DOWN_MS`, `MAX_REBASES_IN_A_ROW`, `MAX_CHECK_NAME`,
`MAX_CI_LOG`, `MAX_REASON`, `MAX_ROUNDS_LIMIT`, `MAX_POLISH`, `MAX_POLISH_BRIEF` (2000).

## DeliverySettings (`workspace.delivery`)

| Champ | Type | Défaut | Règle |
|---|---|---|---|
| `auto` | booléen | `false` | lu au passage au vert (FR-011) |
| `mergeMode` | `squash` \| `merge` \| `rebase` | `squash` | FR-020 |
| `maxRounds` | entier 1–10 | 3 | FR-020, FR-021 |
| `polishPasses` | entier 0–5 | 0 | FR-020, FR-022 |
| `polishBrief` | chaîne ≤ 2000 | `''` | consigne de projet (Q8) |

## Delivery (`workspace.deliveries[]`, persisté)

| Champ | Type | Règle |
|---|---|---|
| `id` | uuid | |
| `agentId`, `testAgentId` | uuid, uuid \| null | `testAgentId` nul pour une PR sans verdict |
| `issueId` | chaîne \| null | nul pour une PR sans verdict hors boucle |
| `branch`, `target` | chaîne | branche du dev ; cible = `baseBranch` explicite, sinon `mainBranch` (Q12) |
| `channel` | `github` \| `local` | `local` pour un dépôt sans remote (FR-008) |
| `unverified` | booléen | geste « Créer la PR sans verdict » / « Fusionner sans verdict » |
| `title`, `message` | chaîne 1–200, 1–4000 | donnés dans la demande (Q11) |
| `frozenCommit` | sha | F, figé à la demande |
| `verdictCommit` | sha \| null | F, puis R après un recalage sans conflit ; nul sans verdict |
| `pactCommits` | sha[] | F et chaque R (R6) |
| `pushedHead` | sha \| null | bail du prochain push (R7) |
| `rebases` | entier ≥ 0 | recalages sans conflit de suite (FR-017) |
| `state` | voir le cycle | |
| `reason` | chaîne \| null | raison d'un refus, d'une chute ou d'un échec, écrite par PACT |
| `pr` | `{ number, url, expectedAuthor }` \| null | gardé quand la demande tombe (FR-030) |
| `ci` | `CiStatus` \| null | dernière lecture |
| `review` | `{ required: boolean, refusedOnce: boolean }` | FR-011, FR-014 |
| `cleanup` | `none` \| `pending` \| `done` \| `kept` | R17 |
| `requestedBy` | `orchestrator` \| `user` | Q14 |
| `at`, `updatedAt` | date ISO | |

### Cycle

```text
checking ─refus─▶ refused (fin)
   │
syncing ─conflit─▶ conflicted (fin : la boucle repart, nouveau tour)
   │
testing ─rouge─▶ tests-failed (fin : nouveau tour compté)
   │
pushing ─▶ opening ─▶ watching ◀──────────── recalage sans conflit (main a bougé)
                         │  ├─rouge─▶ ci-red (fin : nouveau tour compté ; sans verdict : signalé)
                         │  ├─silencieux 10 min─▶ watching + élément delivery-silent-ci
                         │  └─vert─▶ Auto et verdict ? merging : reviewing
                         │                                         │ Valider ─▶ merging
                         │                                         │ Refuser ─▶ user-refused (fin : nouveau tour)
merging ─▶ merged (fin : boucle merged, issue done, agents fermés, nettoyage)
        └─▶ merge-failed (reste suivi, alerte)
tout état non final ─commit étranger, agent fermé par l'utilisateur, compte changé─▶ dropped (fin, PR gardée)
watching ─PR fermée ou fusionnée sur la forge─▶ closed-on-forge | merged
```

`refused`, `conflicted`, `tests-failed`, `ci-red`, `user-refused`, `dropped`, `closed-on-forge`, `merged` sont finaux.
Une demande finale garde `pr` : la suivante de la même branche le reprend (R22). Une seule demande non finale par agent ;
une file par projet pour les étapes locales (`syncing` à `opening`), comme `IntegrationService.enqueue`.

## CiStatus

| Champ | Type | Règle |
|---|---|---|
| `head` | sha | commit dont les checks sont lus |
| `configured` | booléen \| `unknown` | R10 |
| `checks` | `{ id, name ≤ 100, status, conclusion, job: number \| null }[]` | rien d'autre de la forge |
| `required` | chaîne[] \| null | `null` : protection illisible |
| `verdict` | `green` \| `red` \| `pending` \| `silent` \| `stalled` \| `unknown` | `ciVerdict` |
| `emptySince` | date ISO \| null | premier passage sans check (FR-016) |
| `failingSince` | date ISO \| null | premier échec de lecture de suite (forge injoignable) |
| `rerun` | id de job[] | jobs déjà relancés une fois |
| `readAt` | date ISO | |

## Changements de `Loop` et `Round`

```text
loop.state : running | polishing | accepted | delivering | merged | escalated | closed   (ancien « passed » → closed)
loop.polish : { done: 0–5, total: 0–5, restarted: boolean } | null
loop.round, round.n, storedReport.round : 1–10 ; loop.rounds : ≤ 10
round.proof : { tree, commit: sha | null, exitCode, at }
storedReport.commit : sha | null   (HEAD du dev quand le testeur rend son verdict)
storedReport.dirty : booléen        (worktree du dev ≠ ce commit)
round.kind : 'round' | 'polish'     (une passe n'est pas un aller-retour, FR-023)
```

## TodoKind

| `kind` | Titre | Actions |
|---|---|---|
| `delivery-review` | `◎ Relire la PR #<n> · <issue> · <sha court>` (+ « sans verdict ») | Valider, Refuser (motif), Ouvrir la PR |
| `delivery-silent-ci` | `◆ CI muette · PR #<n> · 10 min sans check` | Attendre encore, Relire |
| `delivery-alert` | `◆ Livraison · <issue> · <raison>` | Ouvrir la PR, Compris |
| `delivery-local` | `◎ Fusionner <agent> → <main> ?` (+ « sans verdict ») | Fusionner, Refuser |
| `worktree-kept` | `◆ Worktree gardé · <agent> · <raison>` | Supprimer quand même, Garder |

Remplace `integration-request`. `delivery-review` et `delivery-local` rejoignent `NOTIFIED` (`src/main/notifications.ts`).

## Retirés

`IntegrationRequests` (`orchestrator/integration-requests.ts`), l'outil `request_integration`, l'usage de
`workspace.integrationRequests` (champ gardé pour la lecture, vidé au chargement, R24), `MAX_ROUNDS` (remplacé par
`workspace.delivery.maxRounds`), le passage de l'issue à `done` dans `LoopService.testRun`.

## En mémoire (non persisté)

| Où | Contenu | Après redémarrage |
|---|---|---|
| `DeliveryService` | verrou de décision par demande, minuterie du suivi | reconstruits depuis `deliveries` |
| `CiWatcher` | prochaine lecture par PR | toutes les demandes `watching` relues aussitôt |
