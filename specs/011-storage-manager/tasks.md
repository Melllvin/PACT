# Tasks: Gestionnaire de stockage

**Input**: Design documents from `/specs/011-storage-manager/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: obligatoires (constitution I) : chaque phase commence par ses tests rouges, commités avant le code.

**Livraison**: une PR par phase (Phases 1 et 2 ensemble), branche `011-phase-N-…` depuis `011-storage-manager` ; chaque commit dans une chaîne `&&` gardée par `npm run check` et `npm run test:e2e`. Fusion quand converge et CI verte, sans `gh --auto`. La Phase 6 attend la fusion de 008 dans `main`.

**Interdits**: aucune suppression hors des dossiers temporaires des tests ; aucune commande brew ; aucun `git stash` nu ; aucune modification de la configuration de l'utilisateur ; aucun contenu écrit par un tiers lu, récupéré ou affiché ; aucun outil d'agent qui supprime.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [ ] T001 Créer `011-storage-manager` depuis `origin/main` avec `specs/011-storage-manager/` et `.specify/feature.json`, puis lancer `npm ci`
- [ ] T002 Créer `tests/fixtures/storage/traps.ts` (research R20) : `makeRepo({ worktrees, remote })` sur dépôt temporaire avec remote nu ; pièges `symlinkUnderWorktrees(target)`, `externalWorktree()` (enregistré hors `.worktrees/`), `unknownDir()` (sous `.worktrees/`, inconnu de Git), `lockedDeadEntry()`, faux `HOME` avec `.claude/` et `.codex/` ; `fingerprint(paths)` (chemins, tailles, `mtime`, contenu haché, `git for-each-ref`, index) pour SC-002 et SC-004

---

## Phase 2: Foundational (bloque toutes les stories)

**But** : règles pures, lectures Git sans écriture, calcul de tailles interruptible, canaux IPC. Aucune interface encore.

### Tests (rouges d'abord)

- [ ] T003 [P] Tests dans `tests/unit/shared/storage.test.ts` : schémas de data-model (`kind`, `ownership`, `readOnlyReason`, `deletable` « `yes` \| `strong` \| `refused` \| `no` », `refusal`) ; `owned` pour chaque cas de R6 (enfant direct de `.worktrees/` connu de Git, petit-enfant, lien, hors `.worktrees/`, dépôt principal, `integrations/`, chemin d'inventaire exact ou non) ; `totals` (`recoverable` = `safe`, `deletable` sans `readOnly`, `refused`, `state` ; `complete`, `estimate`) ; `fingerprint` stable et sensible à chaque champ de R9 ; `storageNoticeSchema` « entier 1–500 », défaut `{ enabled: true, thresholdGb: 5 }`
- [ ] T004 [P] Tests dans `tests/integration/git/git-readonly.test.ts` avec `tests/fixtures/storage/traps.ts` : `worktreeList` (porcelain `-z` : chemin, `HEAD`, branche, `detached`, `locked`, `prunable`) ; `statusDetailed` (modifiés, non suivis, ignorés, `.env*`) ; `unpushed` sur références distantes connues, borné à 51 ; `containingRemotes` ; `lastChange` (max du dernier commit et du `mtime` des fichiers non ignorés, Q10) ; empreinte du dépôt et des worktrees identique avant et après chaque méthode (SC-002, FR-004)
- [ ] T005 [P] Tests dans `tests/contract/storage-git.contract.test.ts` : chaque commande de lecture de `contracts/git.md` porte `--no-optional-locks` et `GIT_OPTIONAL_LOCKS=0` ; aucune chaîne `fetch`, `pull`, `remote show`, `gc`, `maintenance`, `--merged`, `--is-ancestor`, `pr list`, `search` dans `src/main/storage/` ni dans les nouvelles méthodes de `src/main/git/git-service.ts`
- [ ] T006 [P] Tests dans `tests/unit/main/storage/sizer.test.ts` : taille = `blocks × 512` ou `size` ; lien symbolique non suivi (cible non comptée) ; lien dur compté une fois dans le total global (R4) ; lots émis au plus toutes les 250 ms ; `AbortSignal` arrête le parcours ; une erreur de lecture d'un élément rend `error` sans arrêter les autres ; boucle d'événements jamais bloquée plus de 50 ms sur 20 000 fichiers
- [ ] T007 [P] Tests dans `tests/unit/main/persistence/store.test.ts` : `JsonFile.peek()` lit un fichier valide, rend `null` sur un illisible sans le renommer ni créer de `.corrupt-*` (R7) ; `appStateSchema` lit un ancien `state.json` avec `storageNotice` par défaut
- [ ] T008 [P] Tests dans `tests/unit/shared/ipc.test.ts` : canaux de `contracts/ui.md` (`storage:open`, `storage:close`, `storage:sizes`, `storage:confirm`, `storage:remove`, `storage:prune`, `storage:clean`, `storage:notice`, `settings:storageNotice`, `app:relaunch`), validés des deux côtés

### Implémentation

- [ ] T009 Créer `src/shared/storage.ts` selon data-model (constantes, schémas, `owned`, `totals`, `fingerprint`, `deletability`, `lossOf`)
- [ ] T010 Dans `src/main/git/git-service.ts` : `readOnly` (env `GIT_OPTIONAL_LOCKS=0`, `--no-optional-locks`), `worktreeList`, `statusDetailed`, `unpushed`, `containingRemotes`, `lastChange`, `objectExists` public ; sans toucher `removeWorktree`
- [ ] T011 Créer `src/main/storage/sizer.ts` (R3, R4), avec un délai par fichier lu de `PACT_TEST_SIZER_DELAY_MS` en mode test seulement (`src/main/test-mode.ts`) : parcours `opendir`/`lstat`, file de 4, `setImmediate` tous les 500 fichiers, ensemble `dev:ino`, `AbortSignal`, mode basse priorité (une lecture, pause de 5 ms tous les 200 fichiers)
- [ ] T012 Dans `src/main/persistence/store.ts` : `JsonFile.peek()` ; `storageNotice` dans `appStateSchema` avec défaut
- [ ] T013 Dans `src/shared/ipc.ts` : canaux et schémas de `contracts/ui.md`

**Checkpoint** : `npm run check` et e2e verts, aucun comportement visible changé ; PR « 011 Phase 1-2 ».

---

## Phase 3: User Story 1 — Voir ce qui occupe la place (P1) 🎯 MVP

**But** : onglet « Stockage » des nouveaux Réglages, tous projets puis par projet, tailles au fil du calcul, rien d'écrit. Aucune suppression.

**Test indépendant** : dépôts temporaires avec worktrees de tailles connues ; vue ouverte, totaux comparés, empreinte inchangée.

### Tests (rouges d'abord)

- [ ] T014 [P] [US1] Tests dans `tests/integration/storage/inventory.test.ts` : projets de tous les fichiers de `workspaces/` (ouvert, récent, fermé, absent : données seules, sans worktrees, US1 sc.5) ; fichier illisible signalé sans renommage ; éléments de `<userData>` de R8 aux chemins d'inventaire ; pièges de T002 en `readOnly` avec leur raison ; `deliveries/<id>`, `pact-index-*` et branche `agent/*` sans worktree en `readOnly` `planned` (O1, O2, O5) ; `state.json` en `never` ; empreinte de `userData`, des dépôts et des pièges inchangée (US1 sc.4, SC-002)
- [ ] T015 [P] [US1] Tests dans `tests/unit/main/storage/storage-service-view.test.ts` : `open` rend l'inventaire sans tailles avant tout parcours ; `storage:sizes` par lots, totaux recalculés ; `close` interrompt ; une seconde `open` remplace la première ; filtre `projectId` (US1 sc.6) ; erreur d'un élément isolée
- [ ] T016 [P] [US1] Tests dans `tests/unit/renderer/settings/StoragePanel.test.tsx`, `tests/unit/renderer/settings/SettingsDialog.test.tsx` et `tests/unit/renderer/home/Home.test.tsx` : trois totaux, `estimation`, ligne par projet dépliable (US1 sc.1, 2), `calcul…`, `(absent du disque)`, lecture seule grisée sans case, `aria-live` ; « Réglages » ouvre l'onglet ; « N worktrees conservés » ouvre l'onglet filtré, « Tous les projets » retire le filtre
- [ ] T017 [P] [US1] E2E dans `tests/e2e/us70-storage-view.spec.ts` : US1 sc.1 à 4, SC-001 (vue en moins de 1 s, avec 6 Go annoncés par un calcul ralenti via `PACT_TEST_SIZER_DELAY_MS` : des fichiers creux occupent presque 0 bloc et fausseraient la taille, R4), interface utilisable pendant le calcul, empreinte inchangée, audit axe
- [ ] T018 [P] [US1] E2E dans `tests/e2e/us71-storage-projects.spec.ts` : US1 sc.5 et 6 (projet fermé, projet absent, lien depuis l'accueil filtré)

### Implémentation

- [ ] T019 [US1] Créer `src/main/storage/inventory.ts` (R6, R7, R8) : projets par `peek()`, worktrees par `worktreeList` et `owned`, éléments de `<userData>`, `readOnly` et raisons
- [ ] T020 [US1] Créer `src/main/storage/storage-service.ts` : `open`, `close`, émission `storage:sizes` ; accesseurs en lecture `isRunning` dans `src/main/agents/agent-manager.ts`, `sessionIds` dans `src/main/orchestrator/orchestrator-service.ts`, `busyIds` dans `src/main/review/integration-service.ts`
- [ ] T021 [US1] Créer `src/main/ipc/storage-handlers.ts` (`storage:open`, `storage:close`) ; câbler `StorageService` dans `src/main/index.ts` ; suivre `storage:sizes` dans `src/renderer/store/app-store.ts`
- [ ] T022 [US1] Créer `src/renderer/settings/SettingsDialog.tsx` (onglet unique « Stockage », O4) et `src/renderer/settings/StoragePanel.tsx` selon `contracts/ui.md` ; bouton « Réglages » dans `src/renderer/app/App.tsx` ; dans `src/renderer/home/Home.tsx`, « N worktrees conservés » devient un bouton vers l'onglet filtré
- [ ] T023 [US1] Mesurer SC-001 dans `tests/e2e/us70-storage-view.spec.ts` ; si l'affichage dépasse 1 s, consigner la mesure dans la PR et appliquer O6 (`utilityProcess` pour `src/main/storage/sizer.ts`)

**Checkpoint** : US1 utilisable seule, rien ne se supprime ; PR « 011 Phase 3 US1 ».

---

## Phase 4: User Story 2 — Comprendre un worktree avant d'y toucher (P1)

**But** : les sept informations de chaque worktree, sans `fetch`, « PR inconnue » tant que 008 n'est pas là.

**Test indépendant** : dépôts temporaires couvrant chaque état ; ligne affichée comparée.

### Tests (rouges d'abord)

- [ ] T024 [P] [US2] Tests dans `tests/integration/storage/worktree-info.test.ts` : `WorktreeInfo` de data-model pour un worktree avec agent fermé, sans agent (« aucun agent », US2 sc.2), d'orchestrateur, détaché, d'une ancienne version (`oldVersion`, Q5), avec branche renommée par l'agent (branche réelle, Edge Cases) ; `modified`, `untracked`, `unpushed` sur références connues sans `fetch` (US2 sc.6) ; `remotesReadAt` depuis `FETCH_HEAD` ; `lastChange` (US2 sc.1) ; commit de sauvegarde de 009 compté non poussé ; PR depuis `issue.trace.pr` affichée `#n`, état `unknown` (R13, avant 008) ; aucun appel à `gh` ; empreinte inchangée
- [ ] T025 [P] [US2] Tests dans `tests/unit/renderer/settings/StoragePanel.test.tsx` : ligne de worktree (branche, rôle, état, `PR #n <état>` ou `PR inconnue`, compteurs, date, `ancienne version`), mention « état des branches connu au …, sans fetch » (FR-006)
- [ ] T026 [P] [US2] E2E dans `tests/e2e/us72-worktree-detail.spec.ts` avec `tests/fixtures/fake-cli/scenarios/storage-agents.json` : US2 sc.1, 2, 4 (sans `gh` : « PR inconnue »), 6

### Implémentation

- [ ] T027 [US2] Dans `src/main/storage/inventory.ts` : `WorktreeInfo` (agent par `worktreePath`, rôle, état, `running` ; PR notée par `issue.trace` ; compteurs ; `lastChange` ; `remotesReadAt` ; `oldVersion`)
- [ ] T028 [US2] Dans `src/renderer/settings/StoragePanel.tsx` : ligne de worktree et mention de retard possible selon `contracts/ui.md`

**Checkpoint** : US2 livrée ; PR « 011 Phase 4 US2 ».

---

## Phase 5: User Stories 3 et 5 — Supprimer en sachant ce qui part, et ce qui ne se supprime pas (P1)

**But** : confirmation exacte, relecture juste avant, lot sans arrêt, refus et confirmation renforcée, éléments de `<userData>`, entrées mortes. US5 entre dans la même PR que US3 : aucune suppression ne part sans ses gardes.

**Test indépendant** : dépôts temporaires avec fichier modifié, non suivi, commit non poussé et pièges ; confirmation lue, suppression, disque comparé ; pièges intacts.

### Tests (rouges d'abord)

- [ ] T029 [P] [US3] Tests dans `tests/unit/shared/storage-loss.test.ts` : `lossOf` (modifiés et non suivis irrécupérables, 20 par catégorie puis `more` ; commit absent de toute branche distante irrécupérable, présent récupérable avec sa branche ; branche distante cochée dans la même suppression ne compte plus, Edge Cases ; `.pact/**` et `design/mockups/**` non suivis à part ; ignorés : taille et `.env*` par nom ; sujet borné à 80 caractères)
- [ ] T030 [P] [US3] Tests dans `tests/integration/storage/remove.test.ts` avec `tests/fixtures/storage/traps.ts` : US3 sc.1 à 7 ; empreinte changée (nouveau fichier, agent relancé) → `changed`, rien supprimé (FR-009, sc.4) ; lot de 3 dont un en échec → 2 `removed`, 1 `failed` avec raison, sans arrêt (FR-007, sc.3) ; `branch -D` de la branche réelle, jamais `mainBranch` ni une branche rattachée ailleurs (Edge Cases) ; fichier verrouillé simulé → `failed` sans `rm` en boucle ; deux suppressions simultanées → `gone` ou `busy` ; worktree d'une ancienne version supprimé à l'unité et en lot sur confirmation, avec « PR inconnue » (FR-017, US4 sc.7) ; `prune` retire les entrées mortes et garde la verrouillée (sc.6, FR-018) ; SC-003 : tout ce qui manque après était annoncé ; empreinte des pièges inchangée (SC-004)
- [ ] T031 [P] [US5] Tests dans `tests/integration/storage/protections.test.ts` : US5 sc.1 à 7, 9 et 10 ; processus en cours → `refused` `running` ; orchestrateur ou agent ouvert à l'arrêt → `strong`, texte tapé exigé, liste `.pact/` complète ; intégration (002) en cours → `refused` `integration` ; terminal libre dont le `cwd` noté est dans le worktree → `refused` `terminal`, autre terminal libre ouvert dans le projet → cité dans la confirmation (O9) ; lien sous `.worktrees/` et lien à un chemin d'inventaire : cible intacte (O3) ; `~/.claude`, `~/.codex`, dépôt principal inchangés ; données d'un workspace refusées si projet ouvert ou récent au moment du geste ; rôle orphelin, reste d'intégration retiré de Git, conflit, `.corrupt-*`, `.tmp` d'un `pid` mort supprimés ; `.tmp` d'un `pid` vivant gardé
- [ ] T032 [P] [US5] Tests dans `tests/integration/orchestrator/tools-storage.test.ts` : aucun outil de `src/main/orchestrator/tools.ts` ni de `src/main/orchestrator/agent-tools.ts` ne contient `storage`, `remove`, `prune` ou `clean` dans son nom ; aucun outil n'atteint `StorageService` (FR-019, US5 sc.8)
- [ ] T033 [P] [US5] Tests dans `tests/unit/main/storage/pending-cleanup.test.ts` : le geste sur un cache écrit `pending-cleanup.json` avec des noms de la liste fermée seulement ; au démarrage, suppression des seuls chemins d'inventaire, lien ignoré, fichier retiré ; `restartNeeded` dans le résultat (R12)
- [ ] T034 [P] [US3] Tests dans `tests/unit/renderer/settings/RemovalDialog.test.tsx` et `tests/unit/main/ipc/storage-handlers.test.ts` : textes de `contracts/ui.md` (irrécupérable, récupérable, `Rien d'irrécupérable.`, effet hors worktree), `Annuler` par défaut et au focus, `Supprimer` désactivé tant que le nom tapé diffère, résultat par élément, « Relancer PACT maintenant » ; handlers `storage:confirm`, `storage:remove`, `storage:prune`, `app:relaunch`
- [ ] T035 [P] [US3] E2E dans `tests/e2e/us73-delete-confirm.spec.ts` : US3 sc.1, 2, 4, 5, 7 et SC-003
- [ ] T036 [P] [US3] E2E dans `tests/e2e/us74-delete-batch.spec.ts` : US3 sc.3 et 6 (lot avec un échec, entrées mortes)
- [ ] T037 [P] [US5] E2E dans `tests/e2e/us75-protected.spec.ts` avec `tests/fixtures/fake-cli/scenarios/storage-agents.json` : US5 sc.1 à 6, confirmation renforcée au clavier, pièges intacts (SC-004)
- [ ] T038 [P] [US5] E2E dans `tests/e2e/us76-other-items.spec.ts` : US5 sc.7, 9 et 10 (cache et relance, rôle orphelin, données d'un projet oublié, sauvegarde), `state.json` jamais proposé

### Implémentation

- [ ] T039 [US3] Dans `src/shared/storage.ts` : `lossOf` et `deletability` complets (R9, R15)
- [ ] T040 [US3] Dans `src/main/git/git-service.ts` : `removeOwnedWorktree` (`worktree remove --force` sans `rm` de repli, puis `branch -D` selon R11) et `prune` (`worktree prune --expire=now`, entrées verrouillées rendues)
- [ ] T041 [US3] Dans `src/main/storage/storage-service.ts` : `confirm` (pertes et empreintes), `remove` (relecture de R10, verrou par `id`, élément par élément, résultats), `prune` ; accesseur `terminalsUnder(path)` dans `src/main/agents/free-terminals.ts`
- [ ] T042 [US5] Dans `src/main/storage/storage-service.ts` et `src/main/index.ts` : suppression des éléments de `<userData>` après `owned` relu ; `pending-cleanup.json` écrit au geste et appliqué au démarrage avant `app.whenReady` ; `app:relaunch` (`app.relaunch()` puis `app.quit()`, garde de fermeture conservée)
- [ ] T043 [US3] Dans `src/main/ipc/storage-handlers.ts` et `src/renderer/store/app-store.ts` : `storage:confirm`, `storage:remove`, `storage:prune`, `app:relaunch`
- [ ] T044 [US3] Créer `src/renderer/settings/RemovalDialog.tsx` ; dans `src/renderer/settings/StoragePanel.tsx` : cases, sélection, « Supprimer la sélection », entrées mortes, résultat, cases désactivées des refus

**Checkpoint** : suppression manuelle complète et gardée ; PR « 011 Phase 5 US3 US5 ».

---

## Phase 6: User Story 4 — Nettoyer en une action, état des PR, avis (P2)

**Prérequis** : 008 fusionnée dans `main` (`GhClient`, `workspace.deliveries`, `WorktreeCleanup`, `deleteRemoteBranch`).

**But** : PR lue par son numéro avec les contrôles de FR-015, « Nettoyer » sur les critères de 008, branche distante en option, avis de 5 Go.

**Test indépendant** : faux `gh` avec PR suivies fusionnées (squash compris), ouvertes, d'un autre auteur, et worktrees propres ou non ; liste comparée ; avis selon le seuil.

### Tests (rouges d'abord)

- [ ] T045 [P] [US4] Tests dans `tests/integration/storage/pr-state.test.ts` avec `tests/fixtures/fake-cli/fake-gh.mjs` : PR de `workspace.deliveries` puis de `issue.trace.pr` ; contrôles auteur, `isCrossRepository`, `headRefName` (US2 sc.3) ; PR d'un autre auteur sur une branche de même nom : ni lue, ni affichée, ni liée (US2 sc.5, FR-016) ; scénario `third-party` : `PACT-INJECTION-WITNESS` absent de tout `storage:*` ; `gh` absent, non connecté, hors ligne → `unknown` (US2 sc.4, Q13) ; un seul `pr view` par numéro et par ouverture ; jamais `pr list` ni `search` (journal `FAKE_GH_LOG`)
- [ ] T046 [P] [US4] Tests dans `tests/integration/delivery/cleanup-evaluate.test.ts` : `WorktreeCleanup.evaluate` rend le même verdict que le nettoyage automatique de 008 sur ses cas existants, sans rien supprimer ; les tests de `tests/integration/delivery/cleanup.test.ts` restent verts
- [ ] T047 [P] [US4] Tests dans `tests/integration/storage/clean.test.ts` : US4 sc.1 à 7 et 10 ; dev identique à `headRefOid` et propre → sûr ; testeur contenu par le blob de ses tests → sûr ; modifié ou commit en plus → non ; tous les commits dans `main` sans PR notée → non (sc.4, SC-005) ; squash détecté par la PR (sc.5) ; objet `headRefOid` absent localement → non, sans `fetch` ; orchestrateur et ancienne version jamais ; livraison non finale de 008 sur la branche → `refused` `delivery`, et un reste `integrations/` d'une livraison en cours n'est pas supprimable (Edge Cases) ; `storage:clean` ne supprime rien (sc.6) ; aucune suppression sans geste sur une longue horloge factice (sc.10, FR-021)
- [ ] T048 [P] [US4] Tests dans `tests/integration/storage/remote-branch.test.ts` : case offerte seulement pour une PR suivie `MERGED` dont `origin/<b>` est connue, jamais `mainBranch`, PR ouverte ou sans PR suivie (US3 sc.8, FR-013) ; décochée par défaut ; cochée → `deleteRemoteBranch` avec bail ; bail refusé → `failed`, worktree traité quand même
- [ ] T049 [P] [US4] Tests dans `tests/unit/main/storage/notice.test.ts` avec horloge factice : calcul à basse priorité 30 s après le démarrage et après `onMerged` ; avis au-delà du seuil (US4 sc.8, 9) ; 6 Go d'anciennes versions dans `deletable`, pas `recoverable` (sc.9, Q17) ; seuil à 10 Go ou avis coupé → aucun avis (sc.11) ; rien d'écrit, rien de supprimé ; avis retiré sous le seuil
- [ ] T050 [P] [US4] Tests dans `tests/unit/renderer/settings/StoragePanel.test.tsx` et `tests/unit/renderer/home/Home.test.tsx` : `✓ sûr`, « Nettoyer · <taille> » et `Rien de sûr`, case de branche distante, réglage de l'avis (1 à 500), ligne d'avis de l'accueil et point sur « Réglages »
- [ ] T051 [P] [US4] E2E dans `tests/e2e/us77-pr-state.spec.ts` avec `tests/fixtures/fake-cli/scenarios/storage-prs.json` : US2 sc.3 à 5, US3 sc.8, PR tierce invisible
- [ ] T052 [P] [US4] E2E dans `tests/e2e/us78-clean.spec.ts` avec `tests/fixtures/fake-cli/scenarios/storage-prs.json` : US4 sc.1 à 7, SC-005, SC-006 (3 gestes, souris et clavier)
- [ ] T053 [P] [US4] E2E dans `tests/e2e/us79-notice.spec.ts` avec `PACT_TEST_NOW` : US4 sc.8, 9 et 11

### Implémentation

- [ ] T054 [US4] Dans `src/main/delivery/cleanup.ts` : extraire `evaluate(worktree, delivery)` sans effet, appelé par le nettoyage automatique existant et par 011 (R14)
- [ ] T055 [US4] Dans `src/main/storage/inventory.ts` : PR par `GhClient.prView` avec les contrôles de R13, cache par ouverture ; `safe` par `evaluate` ; `remoteBranch` (R17)
- [ ] T056 [US4] Dans `src/main/storage/storage-service.ts` : `clean` (ids sûrs), refus `delivery` pour une livraison non finale (R15), branche distante dans `remove`, calcul à basse priorité et `storage:notice` ; dans `src/main/index.ts`, branchement sur le démarrage et sur `onMerged` de `DeliveryService`
- [ ] T057 [US4] Dans `src/main/ipc/storage-handlers.ts`, `src/renderer/store/app-store.ts`, `src/renderer/settings/StoragePanel.tsx`, `src/renderer/settings/RemovalDialog.tsx`, `src/renderer/home/Home.tsx` et `src/renderer/app/App.tsx` : `storage:clean`, `settings:storageNotice`, `storage:notice`, « Nettoyer », case de branche distante, réglage et ligne d'avis

**Checkpoint** : US4 livrée ; PR « 011 Phase 6 US4 ».

---

## Phase 7: Polish

- [ ] T058 [P] Test témoin dans `tests/contract/storage-git.contract.test.ts` qui parcourt tout `src/main/storage/` et les méthodes ajoutées à `src/main/git/git-service.ts` à la recherche de `--merged`, `--is-ancestor`, `fetch`, `pr list` (FR-015, FR-004)
- [ ] T059 [P] Vérifier sous Windows dans la CI (`.github/workflows/ci.yml`, job existant) : `tests/integration/storage/remove.test.ts` avec fichier verrouillé, chemins 8.3 et `realpath.native` ; corriger `src/main/storage/inventory.ts` si besoin
- [ ] T060 Dérouler `specs/011-storage-manager/quickstart.md` ; vérifier la couverture des fichiers modifiés (80 % hors UI, 70 % UI)
- [ ] T061 Mettre à jour `README.md` (onglet « Stockage » des Réglages, ce qui est supprimable et ce qui ne l'est jamais) ; ajuster `version` dans `package.json` selon la règle 0.x seulement si l'orchestrateur le demande

---

## Dépendances

```text
Phase 1 → Phase 2 → Phase 3 (US1) → Phase 4 (US2) → Phase 5 (US3 + US5) → Phase 6 (US4, après 008) → Phase 7
```

- US1 est le MVP : la vue sans risque. US2 l'enrichit ; US3 et US5 en ont besoin pour annoncer la perte et reconnaître l'agent.
- US3 et US5 forment une seule PR : la suppression ne part jamais sans ses refus et sa propriété relue.
- US4 dépend de 008 (`GhClient`, `WorktreeCleanup`, `deliveries`). Si 008 tarde, les Phases 3 à 5 se livrent seules : rien n'est sûr, tout reste supprimable à la main sur confirmation.
- Dans une phase, les tests précèdent l'implémentation ; les tâches [P] de test ne partagent pas de fichier, sauf `StoragePanel.test.tsx` (T016, T025, T050) et `Home.test.tsx` (T016, T050), dans des phases différentes.
- Implémentation séquentielle dans une phase : `storage-service.ts`, `inventory.ts` et `StoragePanel.tsx` reviennent dans plusieurs tâches.

## Parallélisation sans chevauchement

Les phases sont séquentielles par conception (une PR chacune, sur les mêmes fichiers `storage/*`). Dans chaque phase, les tests marqués [P] s'écrivent en parallèle :

| Phase | Tests en parallèle |
|---|---|
| 2 | T003, T004, T005, T006, T007, T008 |
| 3 | T014, T015, T016, T017, T018 |
| 4 | T024, T025, T026 |
| 5 | T029 à T038 |
| 6 | T045 à T053 |
| 7 | T058, T059 |

Seule ouverture possible entre lots : T054 (`delivery/cleanup.ts`) peut se faire dès que 008 est fusionnée, en parallèle des Phases 3 à 5, car il ne touche aucun fichier de `storage/`.

## Correspondance des e2e

| Fichier | Couvre |
|---|---|
| `us70-storage-view` | US1 sc.1–4, SC-001, SC-002 |
| `us71-storage-projects` | US1 sc.5–6 |
| `us72-worktree-detail` | US2 sc.1, 2, 4, 6 |
| `us73-delete-confirm` | US3 sc.1, 2, 4, 5, 7, SC-003 |
| `us74-delete-batch` | US3 sc.3, 6 |
| `us75-protected` | US5 sc.1–6, SC-004 |
| `us76-other-items` | US5 sc.7, 9, 10 |
| `us77-pr-state` | US2 sc.3–5, US3 sc.8 |
| `us78-clean` | US4 sc.1–7, SC-005, SC-006 |
| `us79-notice` | US4 sc.8, 9, 11 |

US5 sc.8 et US4 sc.10 se prouvent par tests d'intégration (T032, T047) : ils n'ont pas de geste à jouer.

## Stratégie

MVP = Phases 1 à 3 : l'utilisateur voit où partent les 6 Go, sans aucun risque. Puis US2 pour comprendre chaque worktree, et la Phase 5 pour supprimer à la main, gardée. « Nettoyer » et l'avis arrivent après 008, qui pose les critères de « sûr ».
