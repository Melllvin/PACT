# Contrat : outils MCP et réveils

Le refus reprend `Refusal` : l'appel échoue avec sa raison, rien n'est fait. Tous les outils rendent la main aussitôt :
le résultat d'une livraison arrive par le journal de 007 (`get_events`), jamais par une attente.

## Retiré

`request_integration` : son nom disparaît de `ORCHESTRATOR_ACTION_TOOLS`, de `tools.ts` et des skills. Un appel par un
ancien orchestrateur reçoit l'erreur MCP standard « outil inconnu ».

## `request_delivery` (orchestrateur)

```text
entrée : { issue: string, title: string (1–200), message: string (1–4000) }
sortie : { deliveryId, state: 'checking' | … , commit: <F court> }
```

Refus, chacun avec sa raison et son remède (FR-002, FR-005, FR-024) :

| Cas | Raison |
|---|---|
| Pas de boucle `accepted` pour l'issue | « La boucle de <issue> n'est pas acceptée (<état>). » |
| Verdict sur un autre commit que la tête du dev | « Le verdict porte sur <a>, la tête est <b>. » |
| Preuve absente ou sur un autre commit | « Les tests de PACT n'ont pas validé <b>. » |
| Worktree du dev non commité | « Changements non commités : <fichiers, 10 au plus>. » |
| Tests du testeur absents ou différents | « Tests du testeur manquants : <fichiers>. Consigne envoyée au dev. » |
| Passes de peaufinage à finir | « Passe <k> sur <N> à finir. » |
| Remote non GitHub, `gh` absent, non connecté | raison et remède (R8) |
| Demande non finale pour ce dev | « Une livraison est déjà en cours (<état>). » |

## `polish_pass` (orchestrateur)

```text
entrée : { issue: string, notes?: string (≤ 2000) }
sortie : { pass: k, total: N, sent: [{ agentId, kind: 'instruction' }] }
```

Refus hors `polishing`, ou si une passe tourne déjà.

## `get_ci_log` (agent de rôle dev)

```text
entrée : { check: string }   // nom tel que reçu dans le défaut de CI
sortie : { check, conclusion, log: string (≤ 20 000, fin du journal), note }
```

Refus sans rien lire : appelant qui n'est pas le dev d'une demande non finale, PR non suivie ou issue d'un fork, check
absent de la tête courante, check sans job d'Actions.

## Outils modifiés

| Outil | Changement |
|---|---|
| `start_loop` | Description : « au plus le plafond du projet (N tours) », N lu dans `workspace.delivery`. |
| `next_round` | Refus au-delà de `maxRounds`, avec la valeur. |
| `close_agent` | Refus si l'agent est le dev ou le testeur d'une demande non finale (FR-007). |
| `list_agents` | Ajoute `delivery: { state, pr? }` par agent concerné. |

## Messages de PACT (kind `delivery`, type `action`)

Écrits par `ExchangeService.record` avec `from: 'pact'`, `to: <orchestrateur>`, `about: <dev>`. Résumé construit par PACT.

| `outcome` | Résumé (exemple) |
|---|---|
| `refused` | `Livraison refusée · <issue> · <raison>` |
| `dropped` | `Livraison tombée · <issue> · commit <sha> étranger à PACT` |
| `conflicted` | `Conflit au recalage · <issue> · <fichiers> : tour <n> ouvert` |
| `tests-failed` | `Tests rouges sur <R> · <issue> : tour <n> ouvert` |
| `pr-opened` | `PR #<n> ouverte · <issue> · <sha>` |
| `ci-green` / `ci-red` | `CI verte · PR #<n>` / `CI rouge · PR #<n> · « <check> »` |
| `review-requested` / `user-refused` | `Relecture demandée · PR #<n>` / `Refusée par l'utilisateur · PR #<n>` |
| `merged` / `merge-failed` | `PR #<n> fusionnée (<mode>)` / `Fusion refusée par la forge · PR #<n> · <raison de gh>` |
| `alert` | `Livraison · PR #<n> · <raison>` |

Les défauts envoyés au dev (CI rouge, refus de l'utilisateur, tests rouges) passent par un message `verdict` au dev,
comme un `defects` du testeur (007 R14), et ouvrent le tour suivant.
