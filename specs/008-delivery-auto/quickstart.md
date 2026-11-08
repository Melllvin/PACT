# Quickstart: Livraison automatique

Vérification de bout en bout, sans vrai `gh` ni réseau : un dépôt temporaire, un remote nu local et le faux `gh`.

## Préparer

```bash
npm ci
npm run check
```

Le faux `gh` lit son état dans `FAKE_GH_STATE` et journalise chaque appel dans `FAKE_GH_LOG`
(`tests/fixtures/fake-cli/fake-gh.mjs`, contrat dans `contracts/gh.md`).

## Scénarios

| Fichier | Couvre |
|---|---|
| `tests/e2e/us50-delivery-pr.spec.ts` | US1 : barrières, `fetch`, recalage, tests, push, PR, réveils |
| `tests/e2e/us51-auto-merge.spec.ts` | US2 : Auto lu au vert, `--match-head-commit`, jamais `--auto`, fermeture après fusion |
| `tests/e2e/us52-review.spec.ts` | US3 : Valider une fois, Refuser avec motif, PR sans verdict |
| `tests/e2e/us53-ci-states.spec.ts` | US4 : sans CI, CI muette, rouge, recalage, PR fusionnée sur la forge |
| `tests/e2e/us54-polish.spec.ts` | US5 : passes et réglages |
| `tests/e2e/us55-restart.spec.ts` | US6 : redémarrage en `watching`, conflit local, agent fermé |
| `tests/e2e/us56-third-party.spec.ts` | US7 : chaîne témoin absente partout |
| `tests/e2e/us57-cleanup.spec.ts` | US8 : worktrees supprimés ou gardés |

```bash
npx playwright test tests/e2e/us5[0-7]-*.spec.ts
```

## À la main (dépôt de démonstration)

1. Ouvrir un projet avec remote, Auto désactivé (défaut), et lancer une boucle sur une issue prête.
2. Faux testeur `accepted`, preuve de PACT : la tuile du dev montre « Livrer ».
3. `request_delivery` par l'orchestrateur : le journal reçoit `pr-opened`, puis `ci-green`, puis `review-requested`.
4. À faire montre « ◎ Relire la PR #1 » : Valider deux fois → une seule ligne `pr merge … --match-head-commit` dans
   `FAKE_GH_LOG`, aucune avec `--auto`.
5. L'issue passe à `done`, le dev et le testeur se ferment, leurs worktrees disparaissent ; l'orchestrateur reste.
6. Activer Auto, recommencer sur une autre issue : la fusion part sans geste au passage au vert.

## Critères

- `grep -- '--auto' "$FAKE_GH_LOG"` ne rend rien (SC-002).
- `grep PACT-INJECTION-WITNESS` ne rend rien dans l'état JSON, le journal et les sorties des faux agents (SC-009).
- Couverture des fichiers modifiés : 80 % hors UI, 70 % UI.
