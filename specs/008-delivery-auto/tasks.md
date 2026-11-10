# Tasks: Livraison automatique

**Input**: Design documents from `/specs/008-delivery-auto/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: obligatoires (constitution I) : chaque phase commence par ses tests rouges, commités avant le code.

**Livraison**: une PR par phase (Phases 1 et 2 ensemble), branche `008-phase-N-…` depuis `008-delivery-auto` ; chaque commit dans une chaîne `&&` gardée par `npm run check` et `npm run test:e2e`. Fusion quand converge et CI verte, sans `gh --auto`.

**Interdits**: aucun vrai `gh` ni accès réseau dans les tests ; aucun vrai CLI d'agent avec des touches simulées ; aucune commande brew ; aucune modification de la configuration de l'utilisateur ; aucun contenu écrit par un tiers lu, récupéré ou transmis.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [ ] T001 Créer `008-delivery-auto` depuis `origin/main` si 007 y est fusionnée, sinon depuis `origin/007-agent-exchanges`, avec `specs/008-delivery-auto/` et `.specify/feature.json`, puis lancer `npm ci`
- [ ] T002 Étendre `tests/fixtures/fake-cli/fake-gh.mjs` selon `contracts/gh.md` : état `FAKE_GH_STATE` (PR par numéro, checks et statuts par commit, requis, protection lisible ou 403, login, échecs programmés de `pr create` et `pr merge`, forge injoignable), `auth status`, `api user`, `repo view`, `pr create` (numéro suivant, tête lue dans le remote nu), `pr view` qui ne sert que les champs `--json` demandés, `api …/check-runs`, `…/status`, `…/protection/required_status_checks`, `…/rules/branches/…`, `…/actions/jobs/<id>/rerun`, `run view --job --log-failed`, `pr merge --match-head-commit` (refus si la tête diffère, fusion dans le remote nu selon le mode) ; chaque appel journalisé dans `FAKE_GH_LOG` ; un appel hors contrat sort en code 2

---

## Phase 2: Foundational (bloque toutes les stories)

**But** : schémas, réglages, verdict et preuve liés à un commit, client `gh` fermé, appels `git` distants. Aucun comportement visible : `request_integration` fonctionne encore.

### Tests (rouges d'abord)

- [ ] T003 [P] Tests dans `tests/unit/shared/delivery.test.ts` : `deliverySettingsSchema` (défauts et bornes de data-model), `deliverySchema` (champs, états finaux), `ciVerdict` sur la table complète de research R9 (aucun check + non configurée → `green` ; aucun check + configurée → `pending` puis `silent` après `SILENT_CI_MS` ; `failure` → `red` ; `cancelled`, `timed_out`, `stale` → `stalled` ; requis absent → `pending` ; requis `null` + aucun check → jamais `green` ; lecture en échec → `unknown`), `deliveryGate` (chaque refus de `contracts/mcp-tools.md` avec sa raison), `prBody` (issue publiée → `Closes #n`, sinon texte ; sans verdict en tête), `checkName` (borné à 100, sans caractère de contrôle)
- [ ] T004 [P] Tests dans `tests/unit/shared/model.test.ts` et `tests/unit/shared/report.test.ts` : `workspace.delivery` et `workspace.deliveries` par défaut sur un ancien fichier ; `loop.state` `passed` chargé comme `closed` ; tours jusqu'à 10 ; `proof.commit` et `storedReport.commit` nuls par défaut ; `round.kind` par défaut `round`
- [ ] T005 [P] Tests dans `tests/contract/gh-client.contract.test.ts` : chaque méthode de `GhClient` produit exactement les arguments de `contracts/gh.md` ; aucun argument ne contient `--auto`, `--delete-branch`, `pr list`, `search`, `refs/pull`, `title`, `body`, `comments`, `reviews` ; `prView` ne garde que les champs du contrat même si le faux `gh` en rend plus ; `availability` rend la raison et le remède pour `gh` absent, non connecté, remote non GitHub (FR-005, US1 sc.10)
- [ ] T006 [P] Tests dans `tests/integration/git/git-remote.test.ts`, dépôt temporaire et remote nu : `fetchRefs` ne crée que les refs demandées, jamais `refs/pull/*` (FR-033) ; `rebaseOnto` sans conflit rend R au même contenu rejoué et ne touche pas le worktree du dev, avec conflit rend les fichiers et ne laisse rien ; `pushBranch` avec bail refuse si la tête distante a changé ; `deleteRemoteBranch` avec bail ; `statusIgnored` distingue modifiés, non suivis, ignorés `.env*` et autres ignorés
- [ ] T007 [P] Tests dans `tests/unit/main/orchestrator/loop-service.test.ts` : `reopen` ouvre un tour compté et escalade au plafond ; verdict stocké avec `commit` et `dirty` ; preuve seulement si le worktree du dev est propre, avec `commit` ; preuve → boucle `accepted` (ou `polishing` si `polishPasses > 0`) et issue toujours `in-progress` (FR-007) ; résumé « changements non commités » sinon

### Implémentation

- [ ] T008 Créer `src/shared/delivery.ts` selon data-model et research R25 (constantes, schémas, `ciVerdict`, `deliveryGate`, `prBody`, `checkName`) ; dans `src/shared/model.ts` : `workspace.delivery`, `workspace.deliveries`, états de `loopSchema`, `polish`, `round.kind`, `proof.commit`, bornes à 10 ; dans `src/shared/report.ts` : `commit`, `dirty`, `round` ≤ 10 ; dans `src/shared/exchanges.ts` : kind `delivery` (action) et son champ structuré (research R21)
- [x] T009 Créer `src/main/delivery/gh-client.ts` sur `ghCommand` de `src/main/orchestrator/issues.ts` : méthodes de `contracts/gh.md` seulement, sortie parsée et réduite aux champs du contrat
- [x] T010 Dans `src/main/git/git-service.ts` : `fetchRefs`, `rebaseOnto` (worktree temporaire détaché, `core.hooksPath` vide), `pushBranch`, `deleteRemoteBranch`, `statusIgnored`, `hasWorkflows(ref)`
- [x] T011 Dans `src/main/orchestrator/loop-service.ts` : `commit` et `dirty` au verdict ; preuve sur commit propre ; états `accepted`, `polishing`, `delivering`, `merged`, méthode `reopen` ; plus de passage de l'issue à `done` ; adapter `src/shared/todo.ts` et `src/shared/agents-view.ts` aux nouveaux états

**Checkpoint** : `npm run check` et e2e verts ; `request_integration` encore en place ; PR « 008 Phase 1-2 ».

---

## Phase 3: User Story 1 — De `accepted` à la PR sans geste manuel (P1) 🎯 MVP

**But** : `request_delivery` et « Livrer » : barrières, `fetch`, recalage, tests, push, PR, réveils. `request_integration` disparaît. Sans remote : fusion locale confirmée.

**Test indépendant** : dépôt temporaire, remote nu, faux `gh` ; lire les commandes, le corps de la PR et les messages `delivery`.

### Tests (rouges d'abord)

- [ ] T012 [P] [US1] Tests dans `tests/integration/delivery/delivery-request.test.ts` : US1 sc.1 à 4 (refus sans `accepted`, verdict ou preuve sur un autre commit, non commité, tests du testeur absents avec la liste et la consigne au dev, commit ajouté avant la PR → `dropped` et réveil) ; une seule demande non finale par dev ; deux demandes du même projet passent l'une après l'autre (file par projet) ; chute → boucle `running` sur le même tour, sans compteur (research R6)
- [ ] T013 [P] [US1] Tests dans `tests/integration/delivery/delivery-flow.test.ts` : US1 sc.5, 6, 8, 9 (ordre `fetchRefs` → `rebaseOnto` → tests sur R → `pushBranch` → `pr create` ; corps de `prBody` ; `verdictCommit` passe à R ; tests rouges ou recalage en échec → rien poussé, tour ouvert ; conflit → `conflicted`, tour compté, consigne de recalage au dev) ; branche cible = `baseBranch` explicite, sinon principale ; worktree du dev amené sur R seulement s'il est propre, sur F et inactif ; un message `delivery` par résultat (FR-006)
- [ ] T014 [P] [US1] Tests dans `tests/integration/delivery/delivery-local.test.ts` : US1 sc.7 et sc.12 (sans remote : mêmes barrières, élément `delivery-local`, `IntegrationService.start` avec `requestId` à la confirmation ; Auto sans effet ; « Fusionner sans verdict » confirmé) ; US1 sc.10 (refus avec remède, aucune fusion locale)
- [ ] T015 [P] [US1] Tests dans `tests/integration/orchestrator/tools-delivery.test.ts` : `request_delivery` selon `contracts/mcp-tools.md` ; `request_integration` absent de la liste des outils et de `ORCHESTRATOR_ACTION_TOOLS` ; `close_agent` refusé pour le dev ou le testeur d'une demande non finale
- [ ] T016 [P] [US1] Tests dans `tests/unit/shared/todo.test.ts`, `tests/unit/renderer/tiles/TileActions.test.tsx` et `tests/unit/renderer/todo/TodoItem.test.tsx` : actions de `contracts/ui.md` selon remote et boucle (US1 sc.11, sc.12) ; `delivery-local` ; plus aucun `integration-request` ; R24 : anciennes demandes vidées et élément info une fois
- [ ] T017 [P] [US1] E2E dans `tests/e2e/us50-delivery-pr.spec.ts` avec `tests/fixtures/fake-cli/scenarios/delivery-pr.json` : US1 sc.1, 5 et 11, SC-003 (aucun geste entre la demande et la PR)

### Implémentation

- [x] T018 [US1] Créer `src/main/delivery/delivery-service.ts` : `request` (barrières par `deliveryGate`, gel de F, file par projet), étapes `checking` à `opening` écrites avant chaque effet, chute sur commit étranger, messages `delivery` par `ExchangeService.record`, défauts au dev par message `verdict` et `LoopService.reopen(issue, reason)` (nouveau tour compté, boucle `delivering` → `running`, escalade au plafond)
- [x] T019 [US1] Dans `src/main/review/integration-service.ts` : `requestId` repris dans `Integration` (R20) ; voie `local` de `DeliveryService` sur `start`
- [x] T020 [US1] Dans `src/main/orchestrator/tools.ts` et `src/shared/orchestrator.ts` : outil `request_delivery`, retrait de `request_integration`, refus de `close_agent` en livraison ; supprimer `src/main/orchestrator/integration-requests.ts` et ses tests, leur couverture passant à `delivery-request.test.ts` (justification dans la PR, constitution II)
- [x] T021 [US1] Créer `src/main/ipc/delivery-handlers.ts` (`delivery:request`, `workspace:deliveries`) ; dans `src/shared/ipc.ts`, `src/main/index.ts`, `src/renderer/store/app-store.ts` : canaux de `contracts/ui.md`, retrait de `workspace:integrationRequests`, création de `GhClient` et `DeliveryService`
- [x] T022 [US1] Dans `src/shared/todo.ts`, `src/renderer/todo/TodoItem.tsx`, `src/renderer/tiles/TileActions.tsx` : « Livrer », « Créer la PR sans verdict », « Intégrer », « Fusionner sans verdict », élément `delivery-local`, retrait de `integration-request`, nettoyage R24 dans `src/main/workspace/workspace-service.ts`
- [x] T023 [US1] Migrer `tests/e2e/us15-orchestrator-integrate.spec.ts` et les tests qui appelaient `request_integration` vers `request_delivery`, sans `skip` ni suppression d'attendu

**Checkpoint** : US1 utilisable seule (PR ouverte, relue à la main sur la forge) ; PR « 008 Phase 3 US1 ».

---

## Phase 4: User Story 2 — Auto fusionne ce que la CI a validé, et rien d'autre (P1)

**But** : `CiWatcher`, toggle Auto, fusion par `--match-head-commit`, clôture après la fusion.

**Test indépendant** : faux `gh` pilotant les checks ; une seule commande de fusion, sans `--auto`, avec le commit attendu.

### Tests (rouges d'abord)

- [ ] T024 [P] [US2] Tests dans `tests/unit/main/delivery/ci-watcher.test.ts`, horloge factice : lecture toutes les 30 s ; Auto lu au passage au vert, pas avant (US2 sc.5, 6, SC-004) ; tête de PR ∉ `pactCommits` → `dropped` (sc.2) ; `stalled` → une relance par job puis `delivery-alert`, sans aller-retour (sc.9) ; forge injoignable → `unknown`, alerte après 10 min, jamais vert
- [ ] T025 [P] [US2] Tests dans `tests/integration/delivery/delivery-merge.test.ts` : sc.1 (fusion de la tête dans le mode du projet, `--match-head-commit`), sc.3 (commit poussé entre lecture et fusion → échec sans effet, signalé), sc.7 (boucle `merged`, issue `done`, dev et testeur fermés, pas avant), sc.8 (PR en relecture fusionnée à l'activation d'Auto), FR-031 (auteur, fork, tête, login relus avant fusion ; un écart → pas de fusion, alerte) ; protection qui refuse → raison de la forge, aucun changement de mode ; Auto désactivé pendant une fusion partie → elle n'est pas annulée
- [ ] T026 [P] [US2] Tests dans `tests/unit/renderer/delivery/DeliveryBar.test.tsx` et `tests/unit/main/ipc/delivery-handlers.test.ts` : toggle par projet, désactivé par défaut, conservé après rechargement (sc.4), inactif sans remote ; `delivery:settings`
- [ ] T027 [P] [US2] E2E dans `tests/e2e/us51-auto-merge.spec.ts` avec `tests/fixtures/fake-cli/scenarios/delivery-auto.json` : sc.1, 4, 5, 6, 7 et SC-002 (aucun `--auto` dans `FAKE_GH_LOG`)

### Implémentation

- [ ] T028 [US2] Créer `src/main/delivery/ci-watcher.ts` : minuterie par PR suivie, lecture `prView` puis checks de `headRefOid`, `ciVerdict`, relance unique, reprise de toutes les demandes `watching` au démarrage
- [ ] T029 [US2] Dans `src/main/delivery/delivery-service.ts` : `onGreen` (lecture d'Auto, verdict valable pour la tête), `merge` (relectures de FR-031, état `merging` écrit avant l'appel, reprise par `prView` après redémarrage), `onMerged` (boucle `merged`, issue `done`, fermeture des agents par `AgentManager.close` sans suppression), activation d'Auto qui fusionne les PR en relecture (FR-011)
- [ ] T030 [US2] Créer `src/renderer/delivery/DeliveryBar.tsx` (contracts/ui.md) et le monter dans `src/renderer/workspace/WorkspaceView.tsx` ; `delivery:settings` dans `src/main/ipc/delivery-handlers.ts`

**Checkpoint** : US2 livrée ; PR « 008 Phase 4 US2 ».

---

## Phase 5: User Story 7 — Un dépôt public ne donne aucune prise (P1)

**But** : prouver que la chaîne témoin n'atteint rien et qu'aucune PR tierce n'est touchée. Les protections sont posées en Phases 2 à 4 ; cette phase les éprouve et corrige ce qui fuit.

**Test indépendant** : scénario `third-party` du faux `gh`, livraison complète Auto activé.

### Tests (rouges d'abord)

- [x] T031 [P] [US7] Tests dans `tests/integration/delivery/third-party.test.ts` : US7 sc.1 à 7 et 9 ; recherche de `PACT-INJECTION-WITNESS` dans le journal de 007, `deriveTodos`, l'état JSON écrit, les notices et les arguments passés aux faux agents ; aucun appel de `FAKE_GH_LOG` ne vise les PR tierces ; PR d'un fork au même nom de branche jamais adoptée (sc.4) ; login changé → pas de fusion, alerte (sc.9)
- [x] T032 [P] [US7] Tests dans `tests/integration/git/git-remote.test.ts` : le remote nu expose `refs/pull/1/head` ; après une livraison, aucune ref locale ne le reflète (sc.8)
- [x] T033 [P] [US7] E2E dans `tests/e2e/us56-third-party.spec.ts` avec `tests/fixtures/fake-cli/scenarios/third-party.json` : sc.1 et 3, SC-009 (chaîne absente des sorties des faux agents et du DOM)

### Implémentation

- [x] T034 [US7] Corriger ce que T031 à T033 révèlent dans `src/main/delivery/gh-client.ts`, `src/main/delivery/ci-watcher.ts` ou `src/shared/delivery.ts` (`checkName`) ; documenter dans la PR chaque fuite trouvée, ou son absence

**Checkpoint** : US7 éprouvée ; PR « 008 Phase 5 US7 ».

---

## Phase 6: User Story 3 — Relire, Valider ou Refuser (P1)

**But** : élément de relecture, Valider idempotent, Refuser avec motif, PR sans verdict, reprise d'une PR ouverte.

**Test indépendant** : faux `gh` ; une seule fusion au double clic, motif reçu par le dev, compteur.

### Tests (rouges d'abord)

- [x] T035 [P] [US3] Tests dans `tests/integration/delivery/delivery-review.test.ts` : sc.1 à 6 (élément, double Valider → une fusion, Refuser sans motif refusé, motif au dev en `verdict`, tour compté, PR ouverte, retour une fois après la nouvelle CI même Auto activé, nouvelle demande qui reprend la PR) ; sc.12 à 15 (reprise par numéro après les contrôles, PR fermée → nouvelle PR, auteur ou fork différent → ni reprise ni création, alerte ; tête après push vérifiée) ; FR-013 (Valider refusé si la CI est configurée et aucun check lu) ; FR-027 (Valider pendant que le dev travaille : aucun dialogue, une fusion) ; CI repassée au rouge avant la décision → élément retiré
- [x] T036 [P] [US3] Tests dans `tests/integration/delivery/delivery-unverified.test.ts` : sc.7 à 11 (Auto ne fusionne jamais une PR sans verdict ; Valider vérifie CI, auteur, fork et tête ; CI rouge, conflit et refus signalés sans compteur ; nouveau commit → chute, même geste qui recrée ; après fusion, aucun worktree supprimé ; la branche distante relève de T067)
- [x] T037 [P] [US3] Tests dans `tests/unit/renderer/todo/TodoItem.test.tsx` et `tests/unit/renderer/store/delivery-store.test.ts` : `delivery-review` (lien, commit, verdict ou « sans verdict »), bouton Valider inactif après clic, champ de motif obligatoire, `delivery:decide` avec la tête affichée ; notification de `delivery-review` dans `tests/unit/main/notifications.test.ts`
- [x] T038 [P] [US3] E2E dans `tests/e2e/us52-review.spec.ts` avec `tests/fixtures/fake-cli/scenarios/delivery-review.json` : sc.2, 4, 5, 7 et SC-007

### Implémentation

- [x] T039 [US3] Dans `src/main/delivery/delivery-service.ts` : état `reviewing`, `decide` (verrou par demande, tête attendue, `merging` avant l'appel), refus avec motif, `review.refusedOnce`, PR sans verdict, reprise de PR (research R22)
- [x] T040 [US3] Dans `src/shared/todo.ts`, `src/renderer/todo/TodoItem.tsx`, `src/renderer/store/app-store.ts`, `src/main/notifications.ts` et `src/main/ipc/delivery-handlers.ts` : élément `delivery-review`, `delivery:decide`, `NOTIFIED`

**Checkpoint** : US3 livrée ; PR « 008 Phase 6 US3 ».

---

## Phase 7: User Story 4 — CI absente, muette ou rouge (P2)

**But** : chaque état de CI a sa suite ; recalage après la PR ; journal de CI pour le dev.

**Test indépendant** : faux dépôts et faux `gh` pour chaque cas.

### Tests (rouges d'abord)

- [x] T041 [P] [US4] Tests dans `tests/integration/delivery/delivery-ci-states.test.ts` : sc.1 (sans workflow ni requis : Auto fusionne après le verdict, sinon relecture) ; sc.2 et 7 (CI configurée muette : alerte à 10 min, « Attendre encore » repousse, « Relire » ouvre la PR, Valider refusé, fusion faite sur la forge constatée) ; sc.3 et 4 (rouge → nom du check borné au dev, tour compté ; au plafond, escalade sans nouveau tour) ; sc.5 (`mergeStateStatus` `BEHIND` ou `DIRTY` → recalage, nouvelle CI ; 3 de suite → alerte) ; sc.6 (PR fermée ou fusionnée à la main → demande close, dit) ; protection illisible → CI réputée configurée (research R10)
- [x] T042 [P] [US4] Tests dans `tests/integration/orchestrator/agent-tools-ci-log.test.ts` : `get_ci_log` sc.8 (rendu borné avec la note pour une PR suivie ; refus sans lecture pour PR non suivie, fork, demande tombée, autre agent)
- [x] T043 [P] [US4] E2E dans `tests/e2e/us53-ci-states.spec.ts` avec `tests/fixtures/fake-cli/scenarios/delivery-ci.json` : sc.1, 2, 3 et 5

### Implémentation

- [x] T044 [US4] Dans `src/main/delivery/ci-watcher.ts` et `src/main/delivery/delivery-service.ts` : CI configurée (R10), `emptySince`, élément `delivery-silent-ci` et ses décisions `wait` et `review`, CI rouge vers le dev, recalage après la PR et compteur `rebases`, PR close sur la forge
- [x] T045 [US4] Dans `src/main/orchestrator/agent-tools.ts` : outil `get_ci_log` (research R15) ; dans `src/shared/todo.ts` et `src/renderer/todo/TodoItem.tsx` : `delivery-silent-ci`, `delivery-alert`

**Checkpoint** : US4 livrée ; PR « 008 Phase 7 US4 ».

---

## Phase 8: User Story 6 — Rien ne se perd, rien ne se confond (P2)

**But** : reprise après redémarrage, conflits locaux persistés, boucle libérée à la fermeture d'un agent, suivi par demande.

**Test indépendant** : redémarrage du service sur un état enregistré.

### Tests (rouges d'abord)

- [x] T046 [P] [US6] Tests dans `tests/integration/delivery/delivery-restart.test.ts` : nouveau `DeliveryService` sur un état enregistré à chaque étape (`pushing`, `opening`, `watching`, `merging`) → aucune PR ni fusion doublée (sc.1, SC-005)
- [x] T047 [P] [US6] Tests dans `tests/integration/review/integration-restore.test.ts` : conflit à moitié résolu, nouveau `IntegrationService` → conflits et résolutions restaurés (sc.2) ; la demande locale reste jusqu'à l'issue
- [x] T048 [P] [US6] Tests dans `tests/integration/orchestrator/loop-agent-closed.test.ts` : agent fermé → boucle hors `running`, message `loop` à l'orchestrateur, `start_loop` accepté ensuite (sc.3, 4, SC-006) ; en livraison, fermeture par l'utilisateur → `dropped`, boucle `closed`, PR ouverte, réveil (sc.6)
- [x] T049 [P] [US6] Tests dans `tests/integration/review/integration-followed.test.ts` : intégration manuelle d'un agent qui a une demande locale → jamais rapportée comme celle de la demande (sc.5)
- [x] T050 [P] [US6] Tests dans `tests/unit/renderer/tiles/CloseAgentDialog.test.tsx` : avertissement de livraison en cours ; E2E dans `tests/e2e/us55-restart.spec.ts` : sc.1 et 3

### Implémentation

- [x] T051 [US6] Dans `src/main/review/integration-service.ts` : écriture de `Pending` dans `<integrationsDir>/<id>.json`, `restore()` au démarrage, retrait à la fin seulement (research R19)
- [x] T052 [US6] Dans `src/main/orchestrator/loop-service.ts` et `src/main/agents/agent-manager.ts` : `agentClosed` (research R12), branché sur `agent:state` `closed` ; dans `src/main/delivery/delivery-service.ts` : chute à la fermeture par l'utilisateur ; reprise de chaque état au démarrage
- [x] T053 [US6] Dans `src/renderer/tiles/CloseAgentDialog.tsx` : avertissement de `contracts/ui.md`

**Checkpoint** : US6 livrée ; PR « 008 Phase 8 US6 ».

---

## Phase 9: User Story 5 — Peaufiner sans ajouter (P2)

**But** : passes de peaufinage, plafond configurable partout, dialogue des réglages.

**Test indépendant** : 1 passe avec de faux agents ; ordre, compteur séparé, refus de la demande avant la fin.

### Tests (rouges d'abord)

- [x] T054 [P] [US5] Tests dans `tests/unit/main/orchestrator/loop-polish.test.ts` : sc.1 à 6 (0 passe → livraison possible ; 2 passes → refus avec « passe k sur N » ; fin de passe : testeur, preuve sur le commit de fin, compteur de passes sans toucher aux tours ; consigne avec `polishBrief`, `notes` et l'interdiction de toute nouvelle fonctionnalité ; `defects` → même passe sans aller-retour ; second `defects` sur la même passe → escalade, jamais de fusion, research P2)
- [x] T055 [P] [US5] Tests dans `tests/unit/main/orchestrator/loop-service.test.ts` et `tests/integration/orchestrator/tools-loop.test.ts` : plafond 5 → arrêt au tour 5, escalade de modèle au tour 5 ; plafond baissé sous le tour courant → escalade au prochain `defects` ; descriptions de `start_loop` et `next_round` sans « 3 tours » ; `polish_pass` selon `contracts/mcp-tools.md`
- [x] T056 [P] [US5] Tests dans `tests/unit/renderer/delivery/DeliverySettingsDialog.test.tsx` : champs et bornes de `contracts/ui.md`, valeurs gardées (sc.7) ; dans `tests/unit/shared/todo.test.ts` : titre de `loop-escalated` et « Relancer » avec le plafond du projet
- [x] T057 [P] [US5] Test dans `tests/unit/main/orchestrator/skills-content.test.ts` : `pact-contract.md` ne dit plus « 3 tours » mais le plafond du projet ; E2E dans `tests/e2e/us54-polish.spec.ts` avec `tests/fixtures/fake-cli/scenarios/delivery-polish.json` : sc.2, 3 et 7

### Implémentation

- [x] T058 [US5] Dans `src/main/orchestrator/loop-service.ts` : plafond lu dans `workspace.delivery.maxRounds`, retrait de `MAX_ROUNDS`, état `polishing`, `polish_pass`, reprise d'une passe (research R23)
- [x] T059 [US5] Dans `src/main/orchestrator/tools.ts` : outil `polish_pass`, textes de `start_loop` et `next_round` ; dans `src/shared/todo.ts` et `src/renderer/todo/TodoItem.tsx` : plafond du projet dans les titres et actions
- [x] T060 [US5] Créer `src/renderer/delivery/DeliverySettingsDialog.tsx`, ouvert depuis `DeliveryBar`
- [x] T061 [US5] Dans `resources/skills/pact-contract.md` et `resources/skills/pact-orchestrator/SKILL.md` : plafond du projet, passes, `request_delivery`, `polish_pass`, plus de `request_integration` ; dans `resources/skills/pact-dev/SKILL.md` : `get_ci_log` et la récupération des tests du testeur ; dans `resources/skills/pact-test/SKILL.md` : tests committés avant le verdict

**Checkpoint** : US5 livrée ; PR « 008 Phase 9 US5 ».

---

## Phase 10: User Story 8 — Les worktrees ne s'accumulent plus (P2)

**But** : suppression automatique sûre après la fusion, explication et « Supprimer quand même » sinon.

**Test indépendant** : dépôt temporaire, fusion avec chaque condition vraie puis fausse.

### Tests (rouges d'abord)

- [ ] T062 [P] [US8] Tests dans `tests/integration/delivery/cleanup.test.ts` : sc.1, 2, 4, 5, 6, 7, 8, 9, 10, 11 et 13 (dev propre sur la tête avec `node_modules` → worktree et branche supprimés ; non suivi, modifié ou commit en plus → rien, `worktree-kept` ; squash : décision par la PR, jamais `branch --merged` ; testeur contenu par le contenu de ses tests ; orchestrateur jamais ; PR fermée, agent ou boucle fermés, PR sans verdict, autre auteur, `close_agent` → rien ; `.env` ignoré → rien et dit ; dev amené sur R → supprimé ; agent rouvert ou fichier modifié avant la suppression → rien) ; SC-010 sur chaque cas ; suppression en échec → `worktree-kept` avec l'erreur ; redémarrage avec `cleanup: pending` → rejoué, dossier absent sans erreur
- [ ] T063 [P] [US8] Tests dans `tests/unit/renderer/todo/TodoItem.test.tsx` et `tests/unit/main/ipc/delivery-handlers.test.ts` : `worktree-kept`, confirmation qui liste ce qui serait perdu avant de supprimer (sc.3), `delivery:cleanup`
- [ ] T064 [P] [US8] E2E dans `tests/e2e/us57-cleanup.spec.ts` avec `tests/fixtures/fake-cli/scenarios/delivery-cleanup.json` : sc.1, 2, 3 et SC-011

### Implémentation

- [ ] T065 [US8] Créer `src/main/delivery/cleanup.ts` (research R17) : conditions relues juste avant, `worktree remove` sans `--force`, branche du dev seulement, `lost()` pour « Supprimer quand même » ; branché sur `onMerged` de `DeliveryService`
- [ ] T066 [US8] Dans `src/shared/todo.ts`, `src/renderer/todo/TodoItem.tsx`, `src/main/ipc/delivery-handlers.ts` : élément `worktree-kept` et `delivery:cleanup`

**Checkpoint** : US8 livrée ; PR « 008 Phase 10 US8 ».

---

## Phase 11: Branche distante (FR-043, US8 sc.12)

**But** : supprimer la branche distante d'une PR suivie fusionnée si sa tête est encore le commit fusionné. Phase isolée : research P1.

- [ ] T067 [P] Tests dans `tests/integration/delivery/remote-branch.test.ts` : tête égale → supprimée par bail ; tête changée → gardée, `delivery-alert` qui le dit ; PR d'un autre auteur → rien ; PR sans verdict fusionnée → même règle (US3 sc.11)
- [ ] T068 Dans `src/main/delivery/delivery-service.ts` : appel de `GitService.deleteRemoteBranch` dans `onMerged`, après la lecture de la PR

**Checkpoint** : PR « 008 Phase 11 ».

---

## Phase 12: Polish

- [ ] T069 [P] Test dans `tests/contract/gh-client.contract.test.ts` qui parcourt tout `src/main` à la recherche de `'--auto'` et de `pr list` (SC-002)
- [ ] T070 [P] Mettre à jour `README.md` : livraison, Auto, réglages, `gh` requis ; retirer `request_integration`
- [ ] T071 Dérouler `specs/008-delivery-auto/quickstart.md` ; vérifier la couverture des fichiers modifiés (80 % hors UI, 70 % UI)
- [ ] T072 Ajuster `version` dans `package.json` selon la règle 0.x seulement si l'orchestrateur le demande

---

## Dépendances

```text
Phase 1 → Phase 2 → Phase 3 (US1) → Phase 4 (US2) → { Phase 5 US7, Phase 6 US3, Phase 7 US4 } → Phase 8 (US6)
Phase 3 → Phase 9 (US5) ; Phase 4 → Phase 10 (US8) → Phase 11 ; tout → Phase 12
```

- US1 est le MVP : `DeliveryService` y naît. US2 apporte `CiWatcher`, dont US3, US4 et US7 dépendent.
- Dans une phase, les tests précèdent l'implémentation ; les tâches [P] de test ne partagent pas de fichier.
- Implémentation séquentielle dans une phase : plusieurs tâches partagent `delivery-service.ts` ou `loop-service.ts`.

## Parallélisation sans chevauchement

| Lot | Fichiers de production | Recouvrement |
|---|---|---|
| US7 | `gh-client.ts`, `ci-watcher.ts`, `shared/delivery.ts` | `ci-watcher.ts` avec US4 |
| US3 | `delivery-service.ts`, `todo.ts`, `TodoItem.tsx`, `app-store.ts`, `notifications.ts`, `delivery-handlers.ts` | `delivery-service.ts`, `todo.ts`, `TodoItem.tsx` avec US4 |
| US4 | `ci-watcher.ts`, `delivery-service.ts`, `agent-tools.ts`, `todo.ts`, `TodoItem.tsx` | voir ci-dessus |
| US5 | `loop-service.ts`, `tools.ts`, `DeliverySettingsDialog.tsx`, `resources/skills/*` | `todo.ts`, `TodoItem.tsx` avec US3 et US4 |
| US8 | `cleanup.ts`, `delivery-handlers.ts` | `todo.ts`, `TodoItem.tsx` |

US3 et US4 se suivent (même service). US5 peut tourner en parallèle de US3 ou US4 si `todo.ts` et `TodoItem.tsx` sont
fusionnés dans l'ordre. US7 est surtout des tests : à lancer dès la fin de la Phase 4.

## Stratégie

MVP = Phases 1 à 3 : la PR s'ouvre seule, l'utilisateur la fusionne sur la forge, et `main` protégée reçoit enfin le
travail. Puis US2 et US7 avant d'activer Auto sur un vrai dépôt : Auto ne doit pas exister sans la preuve de US7.
