# Analyse : spec, plan et tasks de 010

`speckit-analyze` sur `spec.md`, `plan.md`, `tasks.md`, `research.md`, `data-model.md` et `contracts/`, le
2026-11-08. Les écarts trouvés sont corrigés dans ces fichiers. La spec n'a pas été touchée.

## Constats et corrections

| ID | Catégorie | Gravité | Où | Constat | Correction |
|---|---|---|---|---|---|
| C1 | Constitution I | CRITICAL | tasks.md T034, T035 | La Phase 4 créait la vue en lecture, `workflow-layout.ts` et `workflow:get` sans test rouge dans la phase : les tests de la disposition n'étaient qu'en Phase 5. | Les tests de la disposition, de la vue en lecture, de `workflow:get` et de `Toolbar` passent dans T029 (Phase 4). T035 ne garde que le brouillon et la durée. |
| G1 | Couverture | HIGH | FR-015, US1 sc.3 | Aucun test ne vérifiait qu'à l'étape PR, `request_delivery` reste la livraison de 008, sans changement. | T015 le teste. Research O7 dit qui lance l'étape. |
| G2 | Couverture | MEDIUM | research R9, O2 | La consigne de l'étape `spec` au lancement d'un agent `spec` n'avait ni test ni tâche. | Ajoutée à T014 et T023. |
| I1 | Incohérence | LOW | plan.md, Scale/Scope | « 5 outils modifiés » alors que `contracts/mcp-tools.md` en liste 7. | Corrigé : 7. |
| I2 | Incohérence | LOW | research R15, contracts/mcp-tools.md | `advance_stage` : la research ne citait que `done`, le contrat `done` ou `ready`. | La research cite aussi `ready`. |
| I3 | Incohérence | LOW | spec.md, en-tête | `Feature Branch: 007-010-specs` alors que le plan est sur `010-plan`. | Non corrigé : la spec est validée. Sans effet sur le plan. |

## Couverture

| Exigence | Tâches |
|---|---|
| FR-001 à FR-004 | T005, T008, T010 |
| FR-005, FR-006 | T007, T011, T028, T036 |
| FR-007, FR-010 | T027, T032 |
| FR-008 | T037, T040, T041 |
| FR-009 | T005, T010 |
| FR-011, FR-020 | T006, T016, T043 |
| FR-012 à FR-014 | T013, T014, T019, T021, T052 |
| FR-015, FR-016 | T015, T022, T045 |
| FR-017 | T006, T051 |
| FR-018 | T053, T056 |
| FR-019 | T043 à T050 |
| SC-001 | T026 |
| SC-002 | T059 (manuel, research O5) |
| SC-003, SC-005 | T007, T028, T043 |
| SC-004 | T003, T005 |
| SC-006 | T013, T019 |

Cas limites : tous couverts, sauf « deux étapes d'une même séquence modifient les mêmes fichiers ». La règle de 004
reste inchangée et ne demande aucune tâche.

## Mesures

- Exigences : 20 FR et 6 SC. Couverture : 100 %.
- Tâches : 60. Tâches sans exigence : T001, T002, T004 (préparation), T059 et T060 (finition).
- Ambiguïtés restantes : 0 dans le plan. 7 points ouverts dans la research, chacun avec une recommandation.
- Doublons : 0. Problèmes critiques restants : 0.
