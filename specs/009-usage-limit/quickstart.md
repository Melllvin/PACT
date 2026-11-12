# Quickstart: Arrêt à une limite de consommation

Guide de validation. Détails des formats : [contracts/events.md](contracts/events.md), [contracts/ui.md](contracts/ui.md), [data-model.md](data-model.md).

## Prérequis

- Une branche à jour de `main` : 007 (journal, `WakeService`, hooks) et les phases 1 à 6 de la 009 y sont fusionnées.
- `npm ci`.
- Aucun vrai CLI d'agent : tout passe par `tests/fixtures/fake-cli/fake-cli.mjs` et une horloge pilotée.

## Vérifications automatiques

```bash
npm run check                 # typecheck, lint, format, unitaires, intégration, couverture
npm run test:e2e -- us40 us41 us42   # PACT_* retirées de l'environnement : env -u
```

| Fichier | Prouve |
|---|---|
| `tests/unit/shared/usage-limit.test.ts` | bandes par fenêtre, reset, bornes, proposition par prudence (FR-002, FR-009) |
| `tests/unit/main/usage/usage-limit-service.test.ts` | consigne une fois par reset, arrêt immédiat ou en 60 s, comptes séparés, dérogations, seuil changé |
| `tests/integration/usage/usage-stop.test.ts` | arrêt réel par `AgentManager.pause`, `saved`, remote nu inchangé (SC-007) |
| `tests/integration/usage/usage-resume.test.ts` | `--resume`, orchestrateur d'abord, deux fenêtres, redémarrage, session inconnue, verrou Git |
| `tests/integration/usage/usage-edge.test.ts` | cas limites : terminal libre épargné, test de PACT qui continue et événement en attente, plafond de réveils sans effet sur la consigne |
| `tests/e2e/us40-usage-stop.spec.ts` | US1 de bout en bout |
| `tests/e2e/us41-usage-resume.spec.ts` | US2 de bout en bout |
| `tests/e2e/us42-usage-stale.spec.ts` | US3 et US4 |

## Scénario manuel (faux CLI)

1. Lancer PACT en mode test sur un dépôt temporaire avec un remote nu. Lancer un orchestrateur et deux agents `fake`, avec le scénario `tests/fixtures/fake-cli/scenarios/usage-stop.json` : paliers 80, 87, 90 sur `five_hour`, `onPointer: 'commit'` pour l'un, `onPointer: 'ignore'` pour l'autre.
2. Au palier 87 : le journal de l'onglet Actions montre deux `usage-save`. Le premier agent imprime `Sauvegardé`.
3. Au palier 90 : les trois tuiles passent à « en pause · reprise à HH:MM ». L'agent muet porte « non sauvegardé ». À faire montre `◆ En pause`. `git ls-remote` du remote nu est inchangé.
4. Lancer un agent depuis le lanceur : l'avertissement « PACT est en pause sur la limite … » s'affiche (avant celui de 005) et le lancement passe. Depuis l'orchestrateur, `launch_agent` est refusé avec le texte du contrat.
5. Quitter et relancer PACT : les tuiles sont toujours en pause, jamais en erreur.
6. Avancer l'horloge au reset : l'orchestrateur repart d'abord, puis les agents, avec `--resume`. Celui qui travaillait reçoit un pointeur et lit `usage-resumed`.
7. Réglages : passer la semaine à 80 % alors qu'une lecture l'indique à 85 % : la consigne part, puis l'arrêt en 60 s au plus.
8. Lecture vieillie de 16 min à 82 %, un agent qui travaille : À faire propose « Arrêter par prudence ». « Pas maintenant » la retire jusqu'à 30 min.

## Résultats attendus

- Aucun push, aucune branche créée sur le remote (SC-007).
- Aucun agent en pause présenté comme en erreur, avant et après redémarrage (SC-003).
- Aucun arrêt sur une lecture ancienne sans clic (SC-006).
- Un agent `generic`, sans lecture, ne s'arrête jamais ; un agent Codex continue quand le compte Claude est en pause (FR-011, US1 sc.8).
