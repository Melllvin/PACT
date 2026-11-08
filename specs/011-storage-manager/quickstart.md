# Quickstart: Gestionnaire de stockage

Validation de bout en bout. Rien ne se fait sur un vrai projet : dépôts, `userData` et `HOME` temporaires, faux CLI et
faux `gh`.

## Prérequis

- `npm ci` dans le worktree de la feature ; Git ≥ 2.36 (`worktree list -z`).
- Phase 6 seulement : 008 fusionnée (`GhClient`, `WorktreeCleanup`, `workspace.deliveries`).

## Automatique

```bash
npm run check                       # lint, types, Vitest, couverture
npm run build && npx playwright test tests/e2e/us7[0-9]-*.spec.ts
```

Attendu : vert. us70 à us79 couvrent US1 à US5 (table de `tasks.md`).

## À la main (dossier temporaire)

1. `PACT_TEST_MODE=1 PACT_USER_DATA_DIR=$(mktemp -d) npm run dev` (isolement de `src/main/test-mode.ts`) ; ouvrir un dépôt jetable, lancer deux agents, en fermer un.
2. Dans le worktree de l'agent fermé : modifier un fichier suivi, créer `.env.local`, faire un commit sans le pousser.
3. Accueil → « Réglages » → « Stockage » : la vue s'affiche aussitôt, les tailles arrivent ensuite (US1 sc.1 à 3).
4. Ouvrir la ligne du worktree : branche, agent `fermé`, `PR inconnue`, 1 modifié, 1 non poussé, date (US2).
5. Cocher le worktree, « Supprimer » : la confirmation nomme le fichier, le commit (irrécupérable) et `.env.local`
   (US3 sc.1, sc.7). Annuler : rien ne change (sc.2).
6. Modifier un autre fichier, puis confirmer la suppression préparée avant : résultat `changé depuis la confirmation`
   (sc.4).
7. Cocher le worktree de l'agent actif : case désactivée, `fermez-le d'abord` (US5 sc.1).
8. Créer `ln -s ~/Documents .worktrees/piege` : ligne en lecture seule ; `~/Documents` intact après toute action (US5 sc.4).
9. Supprimer un cache d'Electron : `Relancer PACT maintenant` ; au redémarrage, le dossier est parti (US5 sc.10).

## Vérification « rien n'est écrit » (SC-002)

Avant l'étape 3 et après le calcul : `find .git -type f -exec stat -f '%N %z %m' {} + | sort | shasum` (macOS) donne la
même empreinte ; `git for-each-ref` est identique.
