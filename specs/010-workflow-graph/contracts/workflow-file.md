# Contrat : `.pact/workflow.yaml`

Format 1, décrit champ par champ dans [data-model.md](../data-model.md). Ce contrat fixe ce que PACT lit, écrit et
refuse. Il vaut pour le lecteur (`parseWorkflow`, `validateWorkflow`, `machineCheck`) et l'écrivain
(`writeWorkflow`) de `src/shared/workflow.ts` et `src/shared/workflow-yaml.ts`.

## Lecture

- Source : blob de `origin/<main>` (ou `<main>` sans remote), jamais un worktree (research R10).
- Au plus 64 Kio, UTF-8. Un seul document YAML. Ancres, alias, étiquettes, clés en double : refus avec la ligne.
- Clé inconnue : refus avec la ligne (« clé inconnue `stgaes` »), sauf `parallel` et `when`, réservés à la seconde phase.
- `version` absente : « version du format absente (ligne 1) ». `version: 2` : « format plus récent (v2) : mets PACT à
  jour ». Le fichier n'est jamais réécrit (edge case).

## Messages d'erreur

Chaque erreur nomme l'étape ou la ligne (FR-009, SC-004). Formes fixes :

| Code | Message |
|---|---|
| `syntax` | `Ligne <n> : <message du parseur>` |
| `unknown-ref` | `Ligne <n> : étape « <id> » inconnue` |
| `too-many-agents` | `<n> agents : 6 au plus` |
| `missing-role` | `Étape « <id> » : il faut un agent <rôle>` |
| `same-agent-loop` | `Étapes « <dev> » et « <test> » : un même agent ne peut pas être dev et testeur` |
| `bad-outcome` | `Ligne <n> : « <valeur> » n'est pas un résultat de <type> (possibles : <liste>)` |
| `ambiguous-outcome` | `Étape « <id> » : deux transitions sur « <résultat> »` |
| `unreachable` | `Étape « <id> » isolée : aucun chemin depuis « <start> »` |
| `no-end-reachable` | `Étape « <id> » : aucune arrivée atteignable` |
| `uncapped-cycle` | `Boucle <a> → … → <a> sans nombre maximum de tours` |
| `caps-differ` | `Étape « <id> » : plafonds différents (<a> et <b>)` |
| `cap-too-high` | `Ligne <n> : 10 tours au plus` |
| `free-expression` | `Ligne <n> : une condition doit être structurée, pas une expression` |
| `phase2` | `Étape parallèle ou condition (ligne <n>) : prévue en seconde phase, ce workflow ne peut pas s'exécuter` |
| `model-unavailable` | `Agent « <clé> » : modèle « <m> » absent de <cli> sur cette machine` |
| `model-above-ceiling` | `Agent « <clé> » : « <m> » dépasse le plafond du rôle <rôle> (<max>)` |
| `cli-missing` | `Agent « <clé> » : <cli> n'est pas installé sur cette machine` |

Les trois derniers rendent le workflow invalide **sur cette machine** : le fichier n'est pas modifié, et les autres
postes ne sont pas concernés (Q6).

## Écriture

- Seul `WorkflowSaver` écrit, et seulement dans un commit d'une branche `pact/workflow-<horodatage>` (research R12).
- Modèle identique → aucune écriture (SC-003).
- Modèle changé → seuls les nœuds changés sont réécrits ; commentaires, ordre, style et nœuds `parallel` / `when`
  restent tels quels (research R13, FR-006).
- `position` n'est écrite que pour une étape déplacée par l'utilisateur (Q8).
- Création : ordre des clés de data-model, sans position ni commentaire ajouté.

## Jeux de test

`tests/fixtures/workflows/valid/*.yaml` (défaut, peaufinage inséré, recap en arrivée, commentaires et ordre libres,
positions) et `tests/fixtures/workflows/invalid/*.yaml`, un par code d'erreur, chacun avec un fichier `.expected.json`
`{ code, line?, stage? }`. SC-004 : 100 % des fichiers invalides refusés avec leur ligne ou étape.
