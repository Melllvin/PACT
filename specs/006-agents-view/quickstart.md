# Quickstart: Vue des agents

## Prérequis

`npm ci`, puis `npm run build`. Les e2e utilisent le faux CLI (`tests/fixtures/fake-cli`).

## Vérifications automatiques

```sh
npm run check                                     # typecheck, lint, format, unitaires, couverture
npx playwright test tests/e2e/us28-agents-column.spec.ts tests/e2e/us29-lead-tiles.spec.ts \
  tests/e2e/us30-graph.spec.ts tests/e2e/layout.spec.ts
```

Attendu :

- **US1** : un orchestrateur (faux CLI) lance trois agents ; la colonne « Agents » liste quatre lignes ;
  un agent qui pose une question passe en tête avec « ◆ Répondre » ; les autres lignes n'ont aucun
  bouton d'action ; un clic sur une ligne ouvre le Focus ; une demande d'intégration reste en tête.
- **US2** : chaque agent lancé par l'orchestrateur a sa tuile sous l'orchestrateur ; avec cinq
  sous-agents à 1024 × 768, aucune tuile n'est hors écran et l'orchestrateur reste la plus grande.
- **US3** : la vue « Graphe » montre l'orchestrateur relié à ses agents ; une boucle au tour 2
  affiche « dev ↔ test 2/3 » sous son issue ; un changement d'état change le nœud en moins d'une
  seconde ; l'audit axe ne relève aucune violation sérieuse.

## Vérification à la main (vrais CLI)

1. Ouvrir un dépôt, lancer un Claude Code avec « ◎ Orchestrateur ».
2. Lui demander de lancer deux agents (rôles `test` et `dev`) sur une issue et de démarrer la boucle.
3. Vérifier : tuiles sous l'orchestrateur, lignes dans « Agents » avec rôle, état et issue, vue
   « Graphe » avec le groupe de la boucle et le tour.
4. Redémarrer PACT : les liens « lancé par » sont conservés.
