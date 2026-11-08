# Quickstart: Workflow configurable en graphe

Guide de validation. Détails : [contracts/workflow-file.md](contracts/workflow-file.md),
[contracts/mcp-tools.md](contracts/mcp-tools.md), [contracts/ui.md](contracts/ui.md), [data-model.md](data-model.md).

## Prérequis

- Branche `010-workflow-graph`, avec 007, 008 et 009 fusionnées.
- `npm ci` (ajoute `yaml`).
- Aucun vrai CLI ni `gh` : faux CLI (`tests/fixtures/fake-cli/fake-cli.mjs`) et faux `gh` (`fake-gh.mjs`), dépôts Git
  temporaires avec un remote nu.

## Vérifications automatiques

```bash
npm run check
npm run test:e2e -- us60 us61 us62 us63 us64 us65 us66 us67 us68 us69
npx prettier --check specs/010-workflow-graph
```

| Fichier | Prouve |
|---|---|
| `tests/unit/shared/workflow.test.ts` | schémas, résultats, validation par code, défaut, `ignoredLocal` (FR-001 à FR-006, FR-009, FR-011, FR-020) |
| `tests/unit/shared/workflow-yaml.test.ts` | lignes, aller-retour octet pour octet, édition sans perte, seconde phase gardée (SC-003, SC-005) |
| `tests/unit/shared/workflow-layout.test.ts` | couches, retours en arc, positions gardées |
| `tests/unit/main/workflow/workflow-service.test.ts` | transitions, kind `stage`, consignes, version figée, redémarrage, pause de 009 (FR-012 à FR-014, SC-006) |
| `tests/integration/workflow/workflow-source.test.ts` | blob de `origin/<main>`, worktree ignoré, `lastValid`, erreur avec ligne (FR-007, FR-010) |
| `tests/integration/workflow/workflow-saver.test.ts` | branche, PR sans verdict, voie locale, refus sans `gh` (FR-019) |
| `tests/e2e/us60` à `us69` | voir tasks.md |

## Scénario manuel (faux CLI)

1. **Sans fichier** : ouvrir un dépôt temporaire sans `.pact/workflow.yaml`, réglages de livraison à plafond 2 et 1
   passe. Lancer le faux orchestrateur `workflow-default.json`. L'issue passe par spec → test → dev → test → polish →
   pr ; la ligne d'issue montre l'étape à chaque fois ; `git status` du dépôt reste propre (US1 sc.1, sc.4).
2. **Composer** : vue « Workflow ». Ajouter une étape « Peaufinage » entre Test et PR, puis une consigne, et régler le
   plafond à 4. La forme texte change aux mêmes lignes. **Chronométrer** le parcours à la souris puis au clavier seul :
   moins de 2 minutes chacun (SC-002, O5).
3. **Enregistrer** : « Enregistrer (PR) » ouvre une PR sans verdict sur le faux `gh` ; Auto activé, l'élément
   « Relire la PR · workflow » apparaît quand même (US2 sc.6). Avant la fusion, une nouvelle issue suit encore
   l'ancienne version ; après, la suivante suit la nouvelle (US2 sc.3, US3 sc.4).
4. **Invalide** : sur `main`, committer un fichier avec une boucle sans `maxRounds`. PACT affiche
   `Boucle test → … → test sans nombre maximum de tours`, la dernière version valide continue (US3 sc.3).
5. **Seconde phase** : committer un `parallel`. L'en-tête dit « seconde phase : non exécutable » ; enregistrer une
   modification d'une consigne garde le bloc `parallel` à l'identique (US3 sc.5).
6. **Barrière** : le faux orchestrateur `workflow-skip.json` appelle `request_delivery` en étape `polish` : refus
   « Étape en cours : polish. Étapes possibles : pr (sur done). » (US4 sc.1).
7. **Redémarrage** : quitter PACT pendant l'étape `dev`, relancer : l'issue reprend à `dev`, même version (SC-006).
