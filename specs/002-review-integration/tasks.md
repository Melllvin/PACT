---

description: "Tâches d'implémentation de 002 — revue et intégration"
---

# Tasks: Revue et intégration

**Input**: Design documents from `/specs/002-review-integration/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ipc.md, quickstart.md

**Tests**: OBLIGATOIRES (Constitution I — tests d'abord, non négociable).
- Dans chaque phase, les tâches de test précèdent l'implémentation. Elles DOIVENT être exécutées
  et échouer (Red) avant le code qui les fait passer (Green).
- Les tests git tournent sur de vrais dépôts temporaires, les tests e2e avec le faux CLI.
- `npm run check` DOIT être vert à la fin de chaque phase (Constitution II, III).

**Organization**: tâches groupées par user story (spec.md US1…US5), pour livrer et tester chaque
story seule.

## Format: `[ID] [P?] [Story] Description`

- **[P]** : parallélisable (fichiers différents, aucune dépendance sur une tâche non terminée).
- **[Story]** : user story concernée (US1…US5).
- Chemins relatifs à la racine du dépôt, structure de plan.md.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: outillage commun aux stories.

- [X] T001 [P] Test puis ajout du composant shadcn `dropdown-menu` (rôle `menu`, ouverture au clavier, Échap ferme, focus rendu au déclencheur) dans `tests/unit/renderer/components/dropdown-menu.test.tsx` et `src/renderer/components/ui/dropdown-menu.tsx`, ajouté par le CLI shadcn comme en R16 de 001.
- [X] T002 [P] Tests puis nouvelles étapes du faux CLI (research R11), dans `tests/unit/fixtures/fake-cli.test.ts`, `tests/fixtures/fake-cli/fake-cli.mjs` et de nouveaux scénarios sous `tests/fixtures/fake-cli/scenarios/` :
  - `write` (chemin, contenu), `delete`, `rename` et `commit` (message), relatifs à son dossier courant ;
  - un écho de la saisie collée entre crochets (`ESC[200~ … ESC[201~`), pour vérifier les consignes multilignes.
- [X] T003 [P] Tests puis environnement git commun (research R2) dans `tests/unit/main/git/git-service.test.ts` et `src/main/git/git-service.ts` :
  - chaque appel tourne avec `LC_ALL=C` et `-c core.quotePath=false` ;
  - un chemin accentué revient en UTF-8 ;
  - un message d'erreur revient en anglais.
  - Note : aucune méthode de 001 ne renvoie de chemin de fichier ; le chemin accentué en UTF-8 est vérifié par T008, sur le premier `diff`. Test d'environnement écrit dans `tests/integration/git/git-service.test.ts` (vrai git).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: schémas, contrat IPC, parseur de diff, instantané git et file de consignes, dont
toutes les stories dépendent.

**⚠️ CRITICAL**: aucune story ne commence avant la fin de cette phase.

### Tests (Red)

- [X] T004 [P] Tests des schémas dans `tests/unit/shared/model.test.ts` :
  - `Agent.review` vaut `{ seen: {}, comments: [] }` par défaut, et un fichier de workspace de 001 sans ces champs se charge sans migration ;
  - `ReviewComment.text` : « string, 1–4000 characters » ; `line` : « int ≥ 1 » ; `treated` vaut `false` par défaut ;
  - `Workspace.testCommand` : « `null` means detect it from the repository » ; « An empty string is refused ».
- [X] T005 [P] Tests des schémas de `src/shared/review.ts` (`ReviewSnapshot`, `ChangedFile` avec `status` ∈ `'added' | 'modified' | 'deleted' | 'renamed'`, `FileDiff`, `TestRun`, `Integration`, `ConflictFile`) dans `tests/unit/shared/review.test.ts`.
- [X] T006 [P] Tests du contrat IPC dans `tests/unit/shared/ipc.test.ts` :
  - chaque canal et chaque événement de `contracts/ipc.md` existe ;
  - les codes `LOCAL_CHANGES` (avec `files`), `MAIN_MOVED` et `GIT_FAILED` existent ;
  - un chemin de fichier contenant `..` ou commençant par `/` est refusé ;
  - `review:send` exige `text` pour `request`.
- [X] T007 [P] Tests de `parseUnifiedDiff` dans `tests/unit/shared/diff.test.ts` :
  - plusieurs zones, numéros de ligne des deux côtés ;
  - « \ No newline at end of file » ;
  - fichier ajouté, supprimé, renommé ;
  - lignes avec CR, chemins avec espaces et accents.
- [X] T008 Tests d'intégration de l'instantané git (research R1, R2) sur dépôts temporaires, dans `tests/integration/git/review-git.test.ts` :
  - commits, non commité, non suivi et renommé sont dans l'arbre ; les fichiers ignorés n'y sont pas ;
  - `git status` et l'index du worktree restent identiques ;
  - même arbre ⇒ même id ;
  - numstat et `--raw` donnent statut, lignes et blob ; binaire détecté ;
  - un fichier qui ne diffère que par CRLF reste listé avec `eolOnly` ;
  - le diff d'un fichier ignore les CR de fin de ligne ;
  - un chemin accentué revient en UTF-8, sans guillemets (report de T003).
  - ajouté en Phase 3 : une modification de même taille faite dans la seconde du checkout est vue (l'index copié garde le mtime de l'original, « racy git »).
- [X] T009 Tests de la file de consignes de `AgentManager` (research R7) dans `tests/unit/main/agents/agent-manager.test.ts` :
  - écrite tout de suite quand l'agent est `awaiting-prompt` ou `done` ;
  - rien écrit en `awaiting-answer`, `working` ou `starting` ;
  - N consignes écrites une par passage à l'état prêt, jamais toutes d'un coup ;
  - texte multiligne envoyé entre `ESC[200~` et `ESC[201~` puis `\r` ;
  - « Relancer » (retype de 001) marche toujours.
  - Note : `AgentManager` n'a que des tests d'intégration (avec le faux CLI) ; ces tests vont dans `tests/integration/agents/agent-actions.test.ts`, à côté de ceux de « Relancer », avec le scénario `ask-then-echo`.

### Implementation (Green)

- [X] T010 [P] Ajouter `agentReviewSchema`, `reviewCommentSchema`, `Agent.review` et `Workspace.testCommand` avec leurs valeurs par défaut dans `src/shared/model.ts`.
- [X] T011 [P] Créer les schémas zod de data-model.md dans `src/shared/review.ts`.
- [X] T012 [P] Ajouter les canaux, les événements et les codes d'erreur de `contracts/ipc.md`, plus le schéma de chemin relatif, dans `src/shared/ipc.ts` et `src/preload/api.ts`.
- [X] T013 [P] Implémenter `parseUnifiedDiff` (pur) dans `src/shared/diff.ts`.
- [X] T014 Implémenter dans `GitService` `snapshot(worktree)` (index temporaire copié, `add -A`, `write-tree`, `commit-tree`), `mergeBase`, `changedFiles(base, tree)` (numstat, name-status, raw, `-M`, détection `eolOnly`) et `fileDiff(base, tree, path)` (`--ignore-cr-at-eol`, seuils 1 MB / 5 000 lignes), dans `src/main/git/git-service.ts`.
- [X] T015 Remplacer `retype` par une file FIFO de consignes par agent : états prêts `awaiting-prompt` et `done`, une consigne par passage, collage entre crochets pour le multiligne. Exposer `AgentManager.sendPrompt(agentId, text)` dans `src/main/agents/agent-manager.ts`.

**Checkpoint**: fondations prêtes ; `npm run check` vert.

---

## Phase 3: User Story 1 - Relire les changements d'un agent (Priority: P1) 🎯 MVP

**Goal**: « Revue → » ouvre l'onglet Changements du Focus. Il montre la liste des fichiers, les
totaux, le diff et les fichiers vus ; la revue suit le worktree ; la colonne devient « Décision ».

**Independent Test**: le faux CLI écrit, supprime et renomme des fichiers, commités ou non.
« Revue → » doit montrer la bonne liste, les bons totaux et le bon diff, et « vu » doit être suivi
puis remis à zéro quand le fichier change.

### Tests for User Story 1 ⚠️

- [X] T016 [P] [US1] Tests d'intégration de `ReviewService` sur dépôts temporaires, dans `tests/integration/review/review-service.test.ts` :
  - `open` renvoie `ReviewSnapshot` (base, tree, branche, fichiers triés, totaux) ;
  - une écriture dans le worktree émet `review:changed` en moins de 3 s (SC-006) ;
  - le filet de 5 s rattrape un événement manqué ;
  - `close` arrête le suivi ;
  - `setSeen` mémorise le blob, un fichier vu modifié redevient non vu, `newSinceSeen` est calculé ;
  - `seen` persiste après rechargement des stores (FR-011) ;
  - worktree supprimé ⇒ `missing: true` ;
  - `review:pending` liste les agents `done` ou `awaiting-prompt` qui ont au moins un fichier.
- [X] T017 [P] [US1] Tests des composants dans `tests/unit/renderer/review/` (`ChangesTab.test.tsx`, `FileList.test.tsx`, `DiffView.test.tsx`) :
  - en-tête « Changements · N », branche, « +A −R · V / N vus » ;
  - liste avec type, lignes et case « vu » accessible ;
  - diff avec lignes ajoutées, retirées et numéros ;
  - binaire ou trop gros : message type + taille ;
  - « fins de ligne seulement » ;
  - « Nouveaux changements : +N −M · revoir » ;
  - état vide « rien à relire » ;
  - virtualisation : un diff de 5 000 lignes n'affiche que les lignes visibles.
- [X] T018 [P] [US1] Tests de `FocusView`, `TileActions` et `TodoItem` dans `tests/unit/renderer/focus/FocusView.test.tsx`, `tests/unit/renderer/tiles/TileActions.test.tsx` et `tests/unit/renderer/todo/TodoItem.test.tsx` :
  - l'onglet Changements est actif, Aperçu reste inactif ;
  - la colonne s'intitule « Décision » pendant la revue et redevient « À faire » au retour ;
  - « Revue → » apparaît pour un agent en attente de revue et ouvre Changements ;
  - « ‹ Tuiles » et Échap hors du terminal ramènent aux tuiles.
- [X] T019 [US1] Test e2e : le faux CLI écrit, supprime et renomme, puis « Revue → » ; vérifier liste, totaux, diff, « vu », puis une nouvelle écriture et « Nouveaux changements », dans `tests/e2e/us8-review.spec.ts`.

### Implementation for User Story 1

- [X] T020 [US1] Implémenter `ReviewService` dans `src/main/review/review-service.ts` :
  - instantané, `fs.watch` récursif sans `.git/`, rafales regroupées sur 300 ms, filet de 5 s ;
  - vus et `newSinceSeen` ;
  - `missing` ;
  - calcul de `review:pending`, avec les agents suivis tant qu'ils travaillent.
- [X] T021 [US1] Brancher `review:open`, `review:close`, `review:fileDiff`, `review:setSeen` et les événements `review:changed` / `review:pending` dans `src/main/ipc/review-handlers.ts` et `src/main/app-services.ts`.
  - Note : le service est construit et branché dans `src/main/index.ts` (comme les services agents), pas dans `app-services.ts`. `review:pending` est recalculé à chaque `agent:state` et à l'ouverture d'un espace ; une revue suivie se ferme seule quand l'agent n'existe plus.
- [X] T022 [P] [US1] Créer l'état de revue (instantané, fichier choisi, diff) dans `src/renderer/review/review-store.ts`.
- [X] T023 [P] [US1] Implémenter `FileList.tsx` et `DiffView.tsx` (virtualisée, hauteur de ligne fixe) dans `src/renderer/review/`.
- [X] T024 [US1] Implémenter `ChangesTab.tsx` dans `src/renderer/review/` : liste + diff + terminal de l'agent réutilisé via `terminal-registry`, colonne « Décision » à la place de `TodoColumn`.
- [X] T025 [US1] Activer l'onglet Changements dans `src/renderer/focus/FocusView.tsx`, ajouter « Revue → » dans `src/renderer/tiles/TileActions.tsx` et `src/renderer/todo/TodoItem.tsx`, et dériver l'état « à relire » dans `src/shared/todo.ts`.
  - Note : le renderer demande `review:listPending` (canal ajouté au contrat) une fois l'état chargé, car les `review:pending` émis à la restauration partent avant que la fenêtre existe. « vu » vit dans `agent.review.seen` de l'app-store (une seule source) ; un fichier supprimé se marque vu avec l'id nul (`seenBlob`). La colonne « Décision » de US1 dit ce qui reste à voir et l'état de l'agent ; tests, intégration et renvoi viennent avec US2–US4.
  - Corrigé côté main au passage : une revue fermée pendant son ouverture n'est plus suivie, et un `updatePending` plus ancien qui finit en dernier n'annonce rien.

**Checkpoint**: US1 fonctionnelle et testée seule (MVP).

---

## Phase 4: User Story 2 - Intégrer le travail d'un agent dans la branche principale (Priority: P1)

**Goal**: colonne Décision (tests, conflits, non vus, état de l'agent) et « ✓ Intégrer » :
- squash par défaut, « garder les commits » en option ;
- crochets du dépôt respectés ;
- branche principale déplacée seulement à la fin ;
- sort de la tuile et du worktree réglé par les cases.

**Independent Test**: un agent sans conflit produit un changement ; « Intégrer » doit donner un seul
nouveau commit sur la branche principale, et la tuile, le worktree et la branche doivent suivre les
cases ; un crochet qui refuse, ou des changements locaux sur les fichiers touchés, ne doivent rien
modifier.

### Tests for User Story 2 ⚠️

- [X] T026 [P] [US2] Tests d'intégration de la vérification de conflits (research R4) dans `tests/integration/git/merge-tree.test.ts` :
  - propre ou en conflit, avec les chemins en conflit ;
  - aucune modification de la branche principale, de son dossier ni du worktree, comparés octet par octet ;
  - commit de la branche principale qui a introduit le conflit (`%h`, sujet).
- [X] T027 [P] [US2] Tests d'intégration de `IntegrationService` (research R5) dans `tests/integration/review/integration-service.test.ts` :
  - squash : un commit, parent = branche principale, contenu = instantané, message validé ;
  - garder les commits : avance rapide quand c'est possible, sinon commit de fusion ; les commits de l'agent gardent leurs messages ; le non commité forme un dernier commit ;
  - crochets : `pre-commit` qui sort en 1 ⇒ `GIT_FAILED` avec sa sortie, branche principale inchangée ; `commit-msg` qui réécrit le message est respecté ;
  - branche principale extraite : dossier mis à jour ; changements locaux sur un fichier touché ⇒ `LOCAL_CHANGES` avec la liste et rien de modifié ; changements locaux sur un autre fichier ⇒ intégration réussie et changements intacts ;
  - branche principale non extraite : `update-ref` atomique ; branche déplacée entre-temps ⇒ revérifiée une fois puis `MAIN_MOVED` ;
  - le worktree temporaire est toujours supprimé ;
  - deux intégrations du même workspace passent l'une après l'autre (FR-026) ;
  - cases cochées : `removeWorktree` appelé avec `force: true` ;
  - « Conserver le worktree » : `reset --hard` quand rien n'a changé ; report des écritures postérieures par fusion à trois ; conflit ⇒ worktree laissé tel quel ;
  - chemins avec espaces et accents.
- [X] T028 [P] [US2] Tests de `TestRunner` (research R8) dans `tests/unit/main/review/test-runner.test.ts` et `tests/integration/review/test-runner.test.ts` :
  - détection `npm test` / `pnpm test` / `yarn test` selon le fichier de verrouillage, script de remplacement de npm ignoré ;
  - réussi ou en échec selon le code de sortie ;
  - nombre de tests lu dans les résumés Vitest/Jest, pytest et cargo ;
  - 200 dernières lignes gardées ;
  - délai de 10 min (simulé) puis `timeout` ;
  - annulation ;
  - lancé à `review:open` quand aucun résultat ne correspond à `tree` ;
  - un nouvel instantané rend le résultat ancien.

  > Côté `TestRunner` : `ensure(target, command, tree)` ne relance pas quand le dernier résultat, ou
  > l'exécution en cours, porte sur `tree`. L'appel à `review:open` et le résultat « ancien » (son
  > `tree` diffère de l'instantané) relèvent de T034 et T035.
- [ ] T029 [P] [US2] Tests de `DecisionColumn` dans `tests/unit/renderer/review/DecisionColumn.test.tsx` :
  - lignes Tests (« non configurés » avec saisie de la commande, « non lancés », « en cours », « N réussis », « en échec ») ;
  - conflits (« ✓ Aucun conflit avec main » / « ✕ N conflits ») ;
  - « ○ N fichiers non vus » et état de l'agent ;
  - menu « Squash en 1 commit ▾ » (squash / garder les commits) ;
  - message modifiable ;
  - cases « Fermer la tuile » et « Supprimer worktree et branche » cochées par défaut, « Conserver le worktree » ;
  - confirmation quand l'agent travaille ;
  - erreurs `LOCAL_CHANGES` (liste) et `GIT_FAILED` affichées.
- [ ] T030 [US2] Test e2e : intégration en squash, un commit sur la branche principale, tuile fermée, worktree supprimé, notification « ✓ Intégré » ; puis un crochet `pre-commit` qui refuse ⇒ erreur et branche principale inchangée, dans `tests/e2e/us9-integrate.spec.ts`.

### Implementation for User Story 2

- [X] T031 [US2] Ajouter dans `src/main/git/git-service.ts` :
  - `mergeTree(main, commit)` : arbre, conflits avec étapes, `-z` ;
  - `lastMainCommit(base, main, path)` ;
  - `commitInTempWorktree` (`worktree add --detach`, `read-tree -m -u`, `commit -F`, suppression garantie) ;
  - `mergeNoFfInTempWorktree` ;
  - `fastForward` (`merge --ff-only`, lecture des fichiers refusés) ;
  - `updateRef(ref, new, old)` ;
  - `worktreeOf(branch)`.

  > Note : `commitInTempWorktree` et `mergeNoFfInTempWorktree` ne font qu'une méthode,
  > `commitWithHooks`. Pour un commit de fusion, `merge --no-ff --no-commit -s ours` pose le second
  > parent, puis l'arbre donné (instantané, arbre de merge-tree ou résolu en R6) est committé avec
  > les crochets. `moveWorktree(worktree, commit, arbre)` sert à « Conserver le worktree ».
  > `merge-tree` sort en 1 aussi sur une mauvaise référence : sans arbre affiché, c'est une erreur.
  > Tests des étapes dans `tests/integration/git/integration-git.test.ts`.
- [X] T032 [US2] Implémenter `TestRunner` dans `src/main/review/test-runner.ts` : détection, shell de connexion, `PORT` de l'agent, sortie capturée, délai, annulation, une exécution à la fois par agent.
  > Groupe de processus à lui (`detached`) pour que l'annulation tue aussi ce que la commande a
  > lancé ; `taskkill /T /F` sous Windows. `detectTestCommandIn(cwd)` lit package.json et le
  > fichier de verrouillage du worktree.
- [X] T033 [US2] Implémenter `IntegrationService` dans `src/main/review/integration-service.ts` : états de data-model.md, file par workspace, squash ou garder les commits, déplacement de la branche principale, sort de l'agent après coup.
  > L'instantané est pris au clic, la branche principale relue dans la file. Un conflit rend
  > `conflicted` avec `mainCommit`, `hunks: []` et `resolved: false` : les blocs et leur
  > résolution relèvent de la Phase 6 (R6). Après le déplacement de la branche principale, rien ne
  > fait plus échouer l'intégration. `GitService.treeOf` ajouté pour savoir si l'agent a du non
  > commité ou a écrit depuis l'instantané.
- [X] T034 [US2] Étendre `ReviewService` avec l'état des conflits (vérifié à l'ouverture, à chaque instantané et quand la branche principale bouge), et brancher `review:runTests`, `review:cancelTests`, `workspace:setTestCommand`, `integration:start`, `review:tests` et `integration:state`, dans `src/main/review/review-service.ts` et `src/main/ipc/review-handlers.ts`.
  > Conflits : `git merge-tree` entre `mainHead` et le commit de l'instantané à chaque calcul ;
  > la branche principale qui bouge change `mainHead`, donc le filet de sécurité renvoie la revue.
  > `ReviewService.testPlan` donne worktree, port, commande (`workspace.testCommand`, sinon
  > détectée) et arbre affiché ; `review:open` lance les tests via `ensure`, qui réannonce le
  > dernier résultat s'il porte sur cet arbre ; `review:runTests` sans commande ⇒ `INVALID_INPUT`.
  > Une intégration `integrated` recalcule les revues en attente du workspace.
- [ ] T035 [US2] Implémenter `DecisionColumn.tsx` dans `src/renderer/review/`, et la notification « ✓ Intégré · branche → main » dans `src/renderer/workspace/WorkspaceView.tsx`.

**Checkpoint**: US1 + US2, la boucle relire → intégrer.

---

## Phase 5: User Story 3 - Commenter le diff et renvoyer à l'agent (Priority: P2)

**Goal**: commentaire sur une ligne envoyé à l'agent, raccourcis au-dessus du terminal,
« Renvoyer à l'agent ».

**Independent Test**: commenter une ligne, puis utiliser chaque raccourci ; le faux CLI doit
recevoir le texte attendu, seulement quand il est prêt.

### Tests for User Story 3 ⚠️

- [ ] T036 [P] [US3] Tests de `review-prompts` dans `tests/unit/shared/review-prompts.test.ts` :
  - commentaire `Commentaire sur <path>:<line> — <text>` ;
  - « Corriger les commentaires » qui liste tous les commentaires non traités ;
  - « Tests en échec » avec la commande et les 40 dernières lignes ;
  - « Conflit avec main » avec les fichiers et la demande de mise à jour, de résolution et de relance des tests ;
  - demande libre.
- [ ] T037 [P] [US3] Tests de `ReviewService` pour `comment` et `send` dans `tests/unit/main/review/review-service.test.ts` :
  - commentaire enregistré et persistant (`id`, `createdAt`) ;
  - consigne mise en file par `sendPrompt` ;
  - `fix-comments` marque les commentaires `treated` ;
  - `failing-tests` et `conflict` refusés sans tests en échec ni conflit ;
  - `request` exige `text`.
- [ ] T038 [P] [US3] Tests des composants dans `tests/unit/renderer/review/DiffView.test.tsx` et `tests/unit/renderer/review/ChangesTab.test.tsx` :
  - clic sur une ligne ⇒ champ de commentaire, Entrée valide, Échap annule ;
  - commentaire affiché sous la ligne avec « → envoyé à l'agent ↓ » ;
  - raccourcis « Corriger les commentaires · N », « Tests en échec » et « Conflit avec main », visibles seulement quand ils s'appliquent ;
  - « Renvoyer à l'agent » envoie la demande et revient aux tuiles ;
  - ligne « Agent : correction en cours ».
- [ ] T039 [US3] Test e2e : commentaire ⇒ texte reçu par le faux CLI avec fichier et ligne ; agent en `awaiting-answer` ⇒ rien tapé avant la réponse ; « Corriger les commentaires · 2 » ⇒ une seule consigne, dans `tests/e2e/us10-review-comments.spec.ts`.

### Implementation for User Story 3

- [ ] T040 [P] [US3] Implémenter les textes des consignes (purs) dans `src/shared/review-prompts.ts`.
- [ ] T041 [US3] Ajouter `comment` et `send` à `ReviewService`, et brancher `review:comment` et `review:send`, dans `src/main/review/review-service.ts` et `src/main/ipc/review-handlers.ts`.
- [ ] T042 [US3] Ajouter le commentaire sur une ligne dans `src/renderer/review/DiffView.tsx`, les raccourcis dans `src/renderer/review/ChangesTab.tsx`, et « Renvoyer à l'agent » dans `src/renderer/review/DecisionColumn.tsx`.

**Checkpoint**: US1–US3 testées séparément.

---

## Phase 6: User Story 4 - Résoudre un conflit avec la branche principale (Priority: P2)

**Goal**: écran 1q :
- onglet « Conflits · N » et colonne « Intégration » ;
- « Demander à l'agent » (recommandé) ;
- choix par zone, « Modifier… », « Ouvrir dans l'éditeur ▾ » ;
- « Terminer » inactif tant que tout n'est pas résolu ;
- « Annuler » ne touche à rien.

**Independent Test**: la branche principale et l'agent changent la même ligne. « Intégrer » ne doit
rien modifier ; les deux voies de résolution doivent donner le commit attendu.

### Tests for User Story 4 ⚠️

- [ ] T043 [P] [US4] Tests de `conflicts.ts` dans `tests/unit/shared/conflicts.test.ts` :
  - découpe des marqueurs en zones (`main`, `agent`, ligne) ;
  - choix `main`, `agent`, `both` ;
  - fichier résolu seulement sans `<<<<<<<` ni `>>>>>>>` ;
  - `delete-modify` et `add-add` limités à « Garder main » / « Garder cette version ».
- [ ] T044 [P] [US4] Tests d'intégration de la résolution (research R6) dans `tests/integration/review/integration-conflicts.test.ts` :
  - `integration:start` en conflit ⇒ `conflicted`, branche principale, dossier et worktree inchangés ;
  - chaque choix donne le contenu attendu dans le commit final ;
  - `content` libre ;
  - copie dans `userData/conflicts/<id>/` relue après modification ;
  - `finish` refusé tant qu'un conflit reste ;
  - `cancel` supprime les copies et ne change rien ;
  - `askAgent` met en file la consigne « Conflit avec main », passe en `waiting-agent` puis revérifie à la fin du tour de l'agent ;
  - crochets respectés au commit final.
- [ ] T045 [P] [US4] Tests de `ConflictsTab` dans `tests/unit/renderer/review/ConflictsTab.test.tsx` :
  - onglet « Conflits · N » ;
  - fichiers « ⚠ » et « ✓ N sans conflit » ;
  - zone « conflit i / n · ligne L » avec « main · « sujet » hash » et « cette version » ;
  - boutons « Garder main », « Garder cette version », « Les deux », « Modifier… » ;
  - compteur « N / M résolu » ;
  - « Terminer l'intégration » inactif tant que tout n'est pas résolu ;
  - « Demander à l'agent » marqué « Recommandé » ;
  - « Annuler l'intégration · main n'est pas modifié ».
- [ ] T046 [US4] Test e2e : conflit ⇒ écran 1q ; résolution à la main puis « Terminer » ⇒ commit attendu ; un second conflit puis « Annuler » ⇒ branche principale inchangée ; « Demander à l'agent » ⇒ consigne reçue par le faux CLI, dans `tests/e2e/us11-conflicts.spec.ts`.

### Implementation for User Story 4

- [ ] T047 [P] [US4] Implémenter le découpage en zones et l'application des choix (purs) dans `src/shared/conflicts.ts`.
- [ ] T048 [US4] Ajouter à `IntegrationService` les états `conflicted` et `waiting-agent`, `resolve`, `openInEditor` (copie, `shell.openPath` ou `core.editor`, suivi du fichier), `askAgent`, `finish` (`hash-object -w`, index temporaire, `write-tree`, puis le dernier pas de R5) et `cancel`, dans `src/main/review/integration-service.ts`.
- [ ] T049 [US4] Brancher `integration:resolve`, `integration:openInEditor`, `integration:askAgent`, `integration:finish` et `integration:cancel` dans `src/main/ipc/review-handlers.ts`.
- [ ] T050 [US4] Implémenter `ConflictsTab.tsx` et la colonne « Intégration » (zone de texte à chasse fixe pour « Modifier… ») dans `src/renderer/review/`, ouverts par `FocusView` quand une intégration est `conflicted`.

**Checkpoint**: US1–US4 testées séparément.

---

## Phase 7: User Story 5 - Vue Revue et abandon (Priority: P3)

**Goal**: vue Revue active avec badge, passage d'un agent à l'autre par les pastilles,
« ✕ Abandonner ».

**Independent Test**: deux agents ont des changements. Le badge doit valoir 2, les pastilles
doivent passer de l'un à l'autre, et l'abandon doit laisser la branche principale intacte.

### Tests for User Story 5 ⚠️

- [ ] T051 [P] [US5] Tests de `Toolbar` et `AgentPills` dans `tests/unit/renderer/app/Toolbar.test.tsx` et `tests/unit/renderer/focus/AgentPills.test.tsx` :
  - Revue inactive et sans badge à zéro ;
  - badge = nombre d'agents dans `review:pending` ;
  - ouverture sur le premier agent ;
  - pastilles limitées aux agents à relire en vue Revue.
- [ ] T052 [P] [US5] Tests de l'abandon dans `tests/unit/renderer/review/DecisionColumn.test.tsx` : « ✕ Abandonner » demande confirmation, puis la question garder / supprimer de `CloseAgentDialog` ; rien n'est intégré.
- [ ] T053 [US5] Test e2e : deux agents, badge 2, passage de l'un à l'autre, abandon de l'un, badge 1, branche principale inchangée, dans `tests/e2e/us12-review-view.spec.ts`.

### Implementation for User Story 5

- [ ] T054 [US5] Activer la vue Revue avec son badge dans `src/renderer/app/Toolbar.tsx`, et ouvrir le Focus sur le premier agent à relire dans `src/renderer/store/app-store.ts`.
- [ ] T055 [US5] Ajouter « ✕ Abandonner » (confirmation, puis `CloseAgentDialog` et `agent:close`) dans `src/renderer/review/DecisionColumn.tsx`.

**Checkpoint**: toutes les stories testées séparément.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T056 [P] Test de performance : 50 fichiers modifiés ⇒ liste et premier diff en moins de 2 s (SC-001), écriture visible en moins de 3 s (SC-006), consigne dans l'invite en moins de 1 s (SC-004), dans `tests/e2e/perf.spec.ts`.
- [ ] T057 [P] Test e2e chemins avec espaces et accents : revue, intégration et conflit sur macOS et Windows (FR-033), dans `tests/e2e/paths.spec.ts`.
- [ ] T058 [P] Traduire `research.md`, `data-model.md` et `quickstart.md` de 002 en français, comme le reste des documents (relecture du plan).
- [ ] T059 [P] Mettre à jour `README.md` : revue, intégration, conflits, tests lancés par PACT, crochets git.
- [ ] T060 Dérouler `specs/002-review-integration/quickstart.md` (scénarios automatisés + validation manuelle avec les vrais CLI) sur macOS et Windows, et consigner les résultats dans la PR.

---

## Dependencies & Execution Order

- **Setup (Phase 1)** : aucune dépendance.
- **Foundational (Phase 2)** : après Setup ; bloque toutes les stories.
- **US1 (Phase 3)** : après Foundational ; c'est le MVP.
- **US2 (Phase 4)** : après US1, car la colonne Décision et l'instantané vivent dans la revue.
- **US3 (Phase 5)** : après US1 ; indépendante de US2, sauf les raccourcis « Tests en échec » et « Conflit avec main », qui n'apparaissent qu'avec les données de US2 (testables avec des données simulées).
- **US4 (Phase 6)** : après US2 (intégration) ; « Demander à l'agent » utilise la file de consignes de la Phase 2.
- **US5 (Phase 7)** : après US1 ; l'abandon utilise `agent:close` de 001.
- **Polish (Phase 8)** : après les stories voulues.

Dans chaque story : tests (Red) → services du main → IPC → renderer → e2e vert.

## Parallel Opportunities

- Phase 1 : T001, T002 et T003 en parallèle.
- Phase 2 : T004–T007 en parallèle, puis T010–T013 en parallèle ; T014 après T008, T015 après T009.
- US1 : T016, T017 et T018 en parallèle ; T022 et T023 en parallèle après T021.
- US2 : T026–T029 en parallèle.
- US3 : T036–T038 en parallèle ; T040 dès T036.
- US4 : T043–T045 en parallèle ; T047 dès T043.
- US3 et US5 peuvent avancer en parallèle après US1.

## Implementation Strategy

1. **MVP** : Phases 1–3 (relire les changements d'un agent), à valider seul.
2. **Boucle complète** : + US2 (intégrer). Une PR par phase, comme pour 001.
3. **Confort** : US3 (commentaires), puis US4 (conflits), puis US5 (vue Revue, abandon).
4. **Polish** et quickstart sur les deux plateformes, puis `/speckit-converge`.
