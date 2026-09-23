# PACT Constitution

## Core Principles

### I. Tests d'abord (NON NÉGOCIABLE)

- Toute nouvelle feature ou modification de comportement DOIT commencer par l'écriture de
  tests qui décrivent le comportement attendu.
- Ces tests DOIVENT être exécutés et échouer (Red) avant l'écriture du code de production.
- Le code de production est ensuite écrit pour faire passer les tests (Green), puis refactoré
  à tests constants (Refactor).
- Dans `tasks.md`, les tâches de test DOIVENT précéder les tâches d'implémentation qu'elles
  couvrent.

**Rationale** : écrire les tests en amont force une spécification précise du comportement et
garantit que chaque ligne de code est couverte dès sa création.

### II. Aucun merge sur main sans tests verts

- Aucune modification ne PEUT être mergée sur `main` si la suite de tests complète (unitaires,
  intégration, contrat le cas échéant) ne passe pas intégralement.
- Aucun test ne PEUT être désactivé, ignoré (`skip`) ou supprimé pour débloquer un merge sans
  justification écrite dans la PR et approbation explicite.
- Les push directs sur `main` sont interdits ; tout changement passe par une branche et une
  PR/merge request.
- Dès qu'une CI existe, elle DOIT exécuter la suite complète et bloquer le merge en cas d'échec.

**Rationale** : `main` doit rester à tout moment dans un état livrable et fiable.

### III. Zéro régression

- Tout bug corrigé DOIT d'abord être reproduit par un test qui échoue, puis corrigé ; ce test
  reste dans la suite de manière permanente.
- Toute modification DOIT être validée contre la suite complète, pas uniquement les tests
  touchant le code modifié.
- La couverture de tests NE DOIT PAS diminuer d'une PR à l'autre sur le code modifié.
- Un changement cassant un comportement existant DOIT être explicitement documenté et
  approuvé ; sinon il est considéré comme une régression et bloque le merge.

**Rationale** : chaque régression détectée par un test est une régression qui n'atteint
jamais l'utilisateur.

### IV. Réutiliser avant de créer

- Avant d'écrire du nouveau code, le code existant DOIT être recherché (fonctions, modules,
  composants, utilitaires, dépendances déjà présentes) ; s'il couvre le besoin, il DOIT être
  réutilisé.
- Si un code existant couvre partiellement le besoin, il DOIT être étendu ou généralisé
  (avec ses tests) plutôt que dupliqué.
- La duplication de logique est interdite ; une logique apparaissant à deux endroits DOIT être
  factorisée.
- Le plan (`plan.md`) DOIT lister les éléments existants réutilisés et justifier toute
  nouvelle abstraction ou dépendance.

**Rationale** : moins de code signifie moins de bugs, moins de maintenance et un
comportement cohérent dans toute l'application.

### V. Qualité et maintenabilité

- Le code DOIT passer le linter et le formatter du projet sans erreur avant merge.
- Le code DOIT rester simple (YAGNI) : pas de fonctionnalité ni d'abstraction non requise par
  la spec en cours.
- Noms explicites, fonctions courtes à responsabilité unique, pas de code mort ni de code
  commenté laissé dans la base.
- Toute complexité supplémentaire DOIT être justifiée dans la section « Complexity Tracking »
  du plan.

**Rationale** : un code lisible et simple reste modifiable sans risque sur le long terme.

## Contraintes techniques

- Les langages et frameworks ne sont pas encore choisis. Toute stack retenue DOIT disposer
  d'un test runner automatisable, d'un linter et d'un formatter exécutables en ligne de
  commande et en CI.
- Le choix de stack, d'outillage de test et le seuil de couverture minimal chiffré DOIVENT
  être décidés et justifiés lors du premier `/speckit-plan`, puis consignés dans cette
  constitution par amendement.
- Chaque nouvelle dépendance externe DOIT être justifiée (absence d'équivalent déjà présent
  dans le projet, maintenance active, licence compatible).

## Workflow de développement et quality gates

1. `/speckit-specify` → spec validée ; `/speckit-plan` → plan incluant le Constitution Check
   et l'inventaire du code réutilisable ; `/speckit-tasks` → tâches avec tests en premier.
2. Implémentation sur une branche dédiée, en cycle Red → Green → Refactor.
3. Avant toute demande de merge, en local : suite de tests complète verte, linter et
   formatter sans erreur.
4. Revue de la PR : vérification explicite des principes I à V (tests écrits en amont,
   aucune régression, réutilisation, qualité).
5. Merge sur `main` uniquement si tous les gates ci-dessus sont satisfaits (et la CI verte
   lorsqu'elle existe).

## Governance

- Cette constitution prévaut sur toute autre pratique ou convention du projet. En cas de
  conflit, elle s'applique.
- Amendement : toute modification passe par `/speckit-constitution`, fait l'objet d'une PR
  dédiée décrivant le changement et son impact, et met à jour la version et la date
  d'amendement.
- Versioning sémantique :
  - MAJOR : suppression ou redéfinition incompatible d'un principe ou d'une règle de gouvernance.
  - MINOR : ajout d'un principe ou d'une section, ou extension substantielle d'une règle.
  - PATCH : clarifications, reformulations, corrections sans impact sémantique.
- Conformité : chaque plan (`plan.md`) DOIT passer le Constitution Check avant la phase de
  design et après celle-ci ; chaque PR DOIT être revue au regard de ces principes. Toute
  dérogation DOIT être documentée et justifiée dans le plan.

**Version**: 1.0.0 | **Ratified**: 2026-09-23 | **Last Amended**: 2026-09-23
