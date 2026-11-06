# Analyse : Échanges entre agents et réveil

`speckit-analyze` sur `spec.md`, `plan.md` et `tasks.md`, le 2026-11-06. Les corrections ci-dessous sont faites.

| ID | Catégorie | Sévérité | Où | Constat | Suite |
|---|---|---|---|---|---|
| I1 | Incohérence | HIGH | FR-002, R8, R11 | FR-002 borne un message à 500 caractères, or une consigne de l'orchestrateur en est un (Q2) et `send_prompt` accepte 8000. | Spec précisée : 500 pour ce qu'écrit un agent ; consignes à 8000, événements de PACT à 2000. **À confirmer par l'orchestrateur.** |
| U1 | Sous-spécification | HIGH | T004, T012 | `EventQueue.close` rend `replaced: true` au redémarrage d'un orchestrateur ; rien ne le reprenait. | `cancelWait` ajouté. |
| U2 | Sous-spécification | MEDIUM | T004, T011 | Un agent fermé restait dans `unreadBy`, donc ses messages n'étaient jamais évincés d'abord. | Retrait ajouté. |
| C1 | Couverture | MEDIUM | T018, T032 | Trois cas limites sans test : lu avant la fin de la fenêtre, passage à `working` pendant la fenêtre, tour sans outil. | Ajoutés. |
| D1 | Constitution I | MEDIUM | T017, T048 | Code du store sans test préalable. | Tests ajoutés à T009 et T043. |
| D2 | Constitution II | MEDIUM | T006 | Suppression de `events.test.ts` sans justification prévue. | Justification exigée dans la PR. |
| F1 | Chevauchement | MEDIUM | T039, T029 | La Phase 4 aurait touché `index.ts`. | Référence posée en T029. |
| F2 | Incohérence | LOW | T065 | README : ligne 94 connue ; `package.json` vaut 1.0.0 alors que la règle de version est 0.x. | README précisé ; version à trancher par l'orchestrateur. |
| F3 | Ambiguïté | LOW | plan.md, Risques | Codex : approbation des outils MCP non vérifiable sans vrai CLI. | Dit tel quel. |

## Couverture

| Exigences | Tâches |
|---|---|
| FR-001 à FR-003 | T003, T041, T045, T046 |
| FR-004 | T004, T018, T022, T044, T049 |
| FR-005, FR-006 | T040, T044, T045, T048 |
| FR-007, FR-008 | T040, T041, T051, T055 |
| FR-009 | T004, T007, T014 |
| FR-010, FR-011 | T003, T018, T020, T023, T027 |
| FR-012 | `research.md` R1 ; T031, T036 ; repli par `midTurnWake` |
| FR-013 à FR-018 | T018, T019, T020, T024, T026, T032, T033, T038, T039 |
| FR-019 | T007, T014 |
| FR-020, FR-032 | T057 à T060 |
| FR-021 | T051, T052, T055, T056 |
| FR-022 | T008, T014, T015 |
| FR-023 | T050, T054 |
| FR-024 | T020, T026 |
| FR-025 | T005, T013 |
| FR-026 | T061 |
| FR-027 | T057, T059, T062, T063 |
| FR-028 | T005, T013, T041, T044, T059 |
| FR-029 à FR-031 | T042, T047 |
| SC-001 à SC-010 | T064 ; T022 ; T019, T022 ; T020, T022 ; T044 ; T050 ; T008 ; T007 ; T061 ; T042, T044 |

**Bilan** : 32 exigences sur 32 ont au moins une tâche ; aucune tâche orpheline ; aucun CRITICAL ; tests avant le code dans chaque phase.

**Limite connue** : FR-012 a été observée en mode `-p`, pas en mode interactif (`research.md` R1).
