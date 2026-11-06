# Quickstart: valider Échanges et réveil

Prérequis : `npm ci` ; aucune clé ni vrai CLI. Tout passe par le faux CLI et des dépôts Git temporaires.

```bash
npm run check
npm run test:e2e
```

## Scénarios

| Scénario | Commande | Attendu |
|---|---|---|
| Orchestrateur réveillé (US1) | `npx playwright test tests/e2e/us30-wake.spec.ts` | Un pointeur par groupe, aucun texte d'agent dans l'invite, aucun `wait_for_agents` |
| Saisie protégée (SC-003) | même fichier ; signal à 2 min : `npx vitest run tests/unit/main/orchestrator/wake-service.test.ts` (horloge factice) | Rien tapé tant que l'invite n'est pas vide ; signal après 2 min |
| Reprise (FR-004) | même fichier | Journal présent après redémarrage, non-lus annoncés |
| Plein tour (US2) | `npx playwright test tests/e2e/us31-mid-turn-wake.spec.ts` | Pointeur reçu par le hook ; fin de tour sans `report-missing` ; `FAKE_CLI_NO_WAKE_HOOK=1` : pointeur à la fin du tour |
| Échanges et questions (US3) | `npx playwright test tests/e2e/us32-exchanges.spec.ts` | Copie, journal, refus, escalade, pas de `◆ Décider` avec orchestrateur, `◆ Répondre` conservé |
| Boucle (US4) | `npx playwright test tests/e2e/us33-loop-start.spec.ts` | Consignes annoncées ; verdict accepté après recalage |
| Secours (US5) | `npx vitest run tests/integration/orchestrator/tools-read.test.ts` | 20 événements, 200 caractères, `remaining` |
| Témoin d'injection (SC-009) | `npx vitest run tests/integration/orchestrator/third-party.test.ts` | La chaîne témoin n'apparaît nulle part |

## FR-012

Déjà exécutée le 2026-11-06 : `research.md` R1. Pour la refaire après une montée de version du CLI, reprendre le protocole de R1 : `claude -p`, `--settings` en ligne, `--setting-sources ""`, hooks HTTP vers un serveur local. Jamais de touche simulée sur un vrai CLI. Si `additionalContext` ou `block` ne parvient plus à l'agent, passer `midTurnWake` à faux.
