# Analyse : spec, plan, tâches (008)

`speckit-analyze` sur `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, `tasks.md`, le 2026-11-08.

## Couverture

Les 43 FR et les 11 SC ont au moins une tâche de test. Les scénarios des 8 user stories sont cités par numéro dans
les tâches de test de leur phase. US8 sc.12 et FR-043 sont dans la Phase 11.

## Constats corrigés

| ID | Catégorie | Constat | Correction |
|---|---|---|---|
| A1 | Couverture | Edge cases sans tâche : CI repassée au rouge avant la décision ; Auto changé pendant une fusion partie ; file par projet | T035, T025 et T012 les testent |
| A2 | Couverture | FR-027 « quel que soit l'état de l'agent » non testé | T035 : Valider pendant que le dev travaille |
| A3 | Incohérence | T036 (Phase 6) testait FR-043, livré en Phase 11 | T036 renvoie à T067 |
| A4 | Sous-spécifié | Aucun moyen d'ouvrir un tour depuis la CI ou le refus : `next` exige un verdict `defects` | `LoopService.reopen` (research R14, T007, T011, T018) |
| A5 | Sous-spécifié | État de la boucle après la chute d'une demande | research R6 : retour à `running`, même tour |
| A6 | Sous-spécifié | Titre et message demandés par « Livrer » | contracts/ui.md : dialogue court pré-rempli |

## Constats laissés (non bloquants)

| ID | Constat | Suite |
|---|---|---|
| B1 | La consigne de l'agent donne la branche distante comme non décidée ; la spec la tranche (Q26) | research P1, Phase 11 isolée |
| B2 | `**Feature Branch**` de la spec vaut `007-010-specs` | sans effet ; à corriger à la prochaine édition de la spec |
| B3 | Fin d'une passe en `defects` répétés non dite par la spec | research P2 |

Aucun constat critique : pas de FR sans tâche, pas de conflit avec la constitution.
