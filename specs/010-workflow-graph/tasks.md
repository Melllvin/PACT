# Tasks: Workflow configurable en graphe

**Input**: Design documents from `/specs/010-workflow-graph/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: obligatoires (constitution I) : chaque phase commence par ses tests rouges, commités avant le code.

**Livraison**: une PR par phase (Phases 1 et 2 ensemble), branche `010-phase-N-…` depuis `010-workflow-graph` ; chaque
commit dans une chaîne `&&` gardée par `npm run check` et `npm run test:e2e`. Fusion quand converge et CI verte, sans
`gh --auto`.

**Interdits**: aucun vrai CLI d'agent ni vrai `gh` ; aucune commande brew ; aucune modification de la configuration de
l'utilisateur ; aucun contenu écrit par un tiers lu, récupéré ou transmis ; aucun `skip` ni test supprimé.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T001 Créer `010-workflow-graph` depuis `origin/main` une fois 008 fusionnée (research R1), avec `specs/010-workflow-graph/` et `.specify/feature.json`, puis lancer `npm ci`
- [X] T002 Ajouter `yaml` (2.x, version exacte épinglée) aux `dependencies` de `package.json` et `package-lock.json`, avec la justification de research R3 dans la description de la PR (constitution, contraintes techniques)
- [X] T003 [P] Créer les jeux de fichiers de `contracts/workflow-file.md` : `tests/fixtures/workflows/valid/` (défaut, peaufinage inséré, recap en arrivée, commentaires et ordre libres, positions, seconde phase avec `parallel` et `when` objet) et `tests/fixtures/workflows/invalid/` (un fichier par code d'erreur de data-model, chacun avec son `.expected.json`)
- [X] T004 [P] Étendre `tests/fixtures/fake-cli/fake-cli.mjs` : le faux orchestrateur appelle `get_workflow` au réveil, imprime `MCP get_workflow : <stage>`, et joue l'étape rendue selon un champ de scénario `workflowSteps` (`launch_agent`, `start_loop`, `polish_pass`, `request_delivery`, `advance_stage`)

---

## Phase 2: Foundational (bloque toutes les stories)

**But** : schémas, parse et écriture sans perte, validation, défaut, résultats typés, nouveaux champs. Aucun
comportement visible.

### Tests (rouges d'abord)

- [X] T005 [P] Tests dans `tests/unit/shared/workflow.test.ts` : `workflowSchema` (champs, bornes et défauts de data-model) ; `outcomesOf` et `terminalOutcome` par type ; `validateWorkflow` sur chaque fichier de `tests/fixtures/workflows/invalid/` rend le `code`, la ligne ou l'étape de son `.expected.json` (SC-004), et aucun code sur `valid/` ; boucle `test ⇄ dev` plafonnée valide, sans plafond `uncapped-cycle` ; deux plafonds différents vers `dev` → `caps-differ` ; même clé pour dev et test → `same-agent-loop` ; 7 clés → `too-many-agents` ; `parallel` ou `when` objet → `phase2` seulement ; `when` chaîne → `free-expression` ; `version: 2` → `version-newer`
- [X] T006 [P] Tests dans `tests/unit/shared/workflow.test.ts` (bloc `machineCheck`) : modèle hors paliers → `model-unavailable`, au-dessus de `maxModel` → `model-above-ceiling`, CLI non installé → `cli-missing`, modèle absent → profil du rôle sans erreur (FR-017) ; `defaultWorkflow(delivery)` rend le graphe de research R11 avec `maxRounds`, `passes`, consigne et `mergeMode` de `workspace.delivery`, et passe `validateWorkflow` ; `ignoredLocal` liste les réglages différents ; `equalWorkflows` ignore l'ordre des clés et non celui des étapes ; `nextStages(workflow, stage)`
- [X] T007 [P] Tests dans `tests/unit/shared/workflow-yaml.test.ts` : `parseWorkflow` rend les lignes de chaque nœud ; ancres, alias, étiquettes, clés en double, plus de 64 Kio, marqueurs de conflit → erreur avec ligne ; pour chaque fichier de `valid/`, `writeWorkflow(t, parseWorkflow(t))` égale `t` octet pour octet (SC-003) ; un changement de consigne ne change que ses lignes, commentaires et nœuds `parallel` / `when` intacts (SC-005) ; `position` écrite seulement pour les étapes de `moved` ; création sans texte d'origine dans l'ordre de data-model
- [X] T008 [P] Tests dans `tests/unit/shared/workflow.test.ts` (bloc `outcomeOf`) : chaque ligne du tableau de research R5 depuis un message du journal de 007 ou un changement d'issue ; `refused`, `dropped`, `usage-save`, `usage-paused`, `usage-resumed`, `info` → aucun résultat
- [X] T009 [P] Tests dans `tests/unit/shared/model.test.ts`, `tests/unit/shared/exchanges.test.ts` et `tests/unit/shared/delivery.test.ts` : `workspace.workflow` et `workspace.runs` par défaut sur un ancien fichier ; `runSchema` (statuts, `history` ≤ 50) ; kind `stage` de type `action` avec son champ structuré ; `Delivery.agentId` nullable et `source` par défaut `agent`

### Implémentation

- [X] T010 Créer `src/shared/workflow.ts` selon data-model et research R4 à R7, R11, R18 : constantes, schémas, `outcomesOf`, `terminalOutcome`, `outcomeOf`, `validateWorkflow`, `machineCheck` (sur `tierOf` et `beyondCeiling` de `src/shared/roles.ts`), `defaultWorkflow`, `ignoredLocal`, `equalWorkflows`, `nextStages`
- [X] T011 Créer `src/shared/workflow-yaml.ts` sur `yaml` : `parseWorkflow` (`LineCounter`, options de research R3), `writeWorkflow` (édition du `Document` en place, research R13)
- [X] T012 Dans `src/shared/model.ts` : `workspace.workflow`, `workspace.runs`, `TodoKind` `workflow-invalid` et `workflow-refused` (rangés dans `ORDER` de `src/shared/todo.ts`) ; dans `src/shared/exchanges.ts` : kind `stage` ; dans `src/shared/delivery.ts` : `agentId` nullable, `source`

**Checkpoint** : `npm run check` et e2e verts, aucun comportement changé ; PR « 010 Phase 1-2 ».

---

## Phase 3: User Story 1 — Lancer le workflow par défaut (P1) 🎯 MVP

**But** : sans fichier, la chaîne de 004 et 008 tourne comme avant, et PACT sait à quelle étape est chaque issue.

**Test indépendant** : projet sans fichier ; une issue déroulée par de faux agents ; l'étape lue à chaque événement.

### Tests (rouges d'abord)

- [ ] T013 [P] [US1] Tests dans `tests/unit/main/workflow/workflow-service.test.ts`, journal factice : `register_issue` crée l'exécution sur `start` avec la version copiée ; issue `ready` → `test` ; chaque résultat de R5 suit sa transition, écrit l'état avant le message `stage` (`action`, résumé de `contracts/mcp-tools.md`) ; résultat sans transition → rien ; `merged` sur l'arrivée → `finished` ; même message rejoué → aucun effet (`lastMessageId`) ; nouveau service sur le même état → messages après `lastMessageId` rejoués (SC-006) ; `usage-paused` puis `usage-resumed` → étape inchangée (edge case 009) ; retour `pr → dev` sur `ci-red` → même exécution, pas de nouvelle (edge case)
- [ ] T014 [P] [US1] Tests dans `tests/unit/main/workflow/workflow-service.test.ts` (bloc consignes) : entrée dans une étape avec consigne → une `instruction` par agent lié, texte = consigne fixe de PACT puis `Consigne du workflow : …` (US1 sc.5, research R9) ; étape sans consigne → consigne fixe seule, comme 007 FR-021 ; `launch_agent({ role: 'spec' })` reçoit une fois la consigne de l'étape `spec` du workflow courant (research O2) ; agent lié après l'entrée → consigne envoyée à la liaison ; `polish` → consigne de l'étape à la place de `polishBrief`, `notes` ajoutées
- [ ] T015 [P] [US1] Tests dans `tests/unit/main/orchestrator/loop-service.test.ts` : le plafond vient de `deps.maxRounds(ws, issue)` ; escalade au plafond de l'exécution (US4 sc.2) ; exécution `waiting-user` à l'escalade, `active` à « restart » ; le compteur de `dev` reste `loop.round`, aucun second compteur (research R7) ; dans `tests/unit/main/delivery/delivery-service.test.ts` : en étape `pr`, `request_delivery` exécute la livraison de 008 sans changement de ses barrières ni de son déroulé (FR-015, US1 sc.3, research O7), avec le `mergeMode` de l'étape
- [ ] T016 [P] [US1] Tests dans `tests/integration/workflow/workflow-source.test.ts`, dépôt temporaire : sans fichier sur `main` → `defaultWorkflow(workspace.delivery)`, `source: 'default'`, aucun fichier écrit ni `git status` changé (US1 sc.1, sc.4, FR-011) ; réglages de 008 non défauts → repris dans le défaut (FR-020)
- [ ] T017 [P] [US1] Tests dans `tests/unit/shared/todo.test.ts` et `tests/unit/shared/agents-view.test.ts` : la ligne d'issue montre `Étape <id>` ; `workflow-refused` pour une exécution `refused`
- [ ] T018 [P] [US1] E2E dans `tests/e2e/us60-workflow-default.spec.ts` avec `tests/fixtures/fake-cli/scenarios/workflow-default.json` : US1 sc.1 à 5, étape affichée à chaque événement, dépôt sans fichier après la livraison
- [ ] T019 [P] [US1] E2E dans `tests/e2e/us61-workflow-restart.spec.ts` : redémarrage en étape `dev`, reprise à la même étape et même version (SC-006) ; pause de 009 pendant `test` sans changement d'étape

### Implémentation

- [ ] T020 [US1] Créer `src/main/workflow/workflow-source.ts` (cas sans fichier et fichier valide) : `current(workspaceId)` lit le blob de `origin/<main>` après `fetchRefs`, sinon `<main>`, par `GitService.entry` et `readBlob` ; `defaultWorkflow` sans fichier
- [ ] T021 [US1] Créer `src/main/workflow/workflow-service.ts` : `onRecorded` de `ExchangeService` et changements d'issue, `outcomeOf`, transitions, écriture avant effet, message `stage`, consignes d'étape (R9), `bindings`, `entries`, `history`, `lastMessageId`, reprise au démarrage, création paresseuse pour une issue sans exécution (R8)
- [ ] T022 [US1] Dans `src/main/orchestrator/loop-service.ts` : dépendances `maxRounds` et `polish` à la place de `workspace.delivery` ; dans `src/main/delivery/delivery-service.ts` : `mergeModeOf(ws, issue)`
- [ ] T023 [US1] Dans `src/main/orchestrator/issues.ts` et `src/main/orchestrator/tools.ts` : `register_issue` crée l'exécution et rend `stage` ; `start_loop` lie les clés et cite le plafond de l'exécution ; `launch_agent({ role: 'spec' })` reçoit la consigne de l'étape `spec` (research O2)
- [ ] T024 [US1] Dans `src/shared/todo.ts`, `src/shared/agents-view.ts`, `src/renderer/todo/TodoItem.tsx` et `src/renderer/store/app-store.ts` : étape de l'issue, `workflow-refused`, suivi de `workspace:workflow`
- [ ] T025 [US1] Dans `src/main/index.ts` : créer `WorkflowSource` et `WorkflowService`, les brancher sur `ExchangeService`, `IssueService`, `LoopService`, `DeliveryService` et l'émission `workspace:workflow`
- [ ] T026 [US1] Lancer toute la suite e2e de 004 à 009 sans changement de scénario : SC-001 (aucun projet sans fichier ne change) ; corriger le code, jamais les attendus

**Checkpoint** : US1 utilisable seule ; PR « 010 Phase 3 US1 ».

---

## Phase 4: User Story 3 — Le workflow se versionne avec le code (P1)

**But** : le fichier de la branche principale fait foi ; invalide, il ne casse rien ; seconde phase lue et gardée.

**Test indépendant** : fichier écrit dans un dépôt Git temporaire ; chargement, aller-retour, refus d'un invalide.

### Tests (rouges d'abord)

- [ ] T027 [P] [US3] Tests dans `tests/integration/workflow/workflow-source.test.ts` : fichier valide sur `origin/main` → utilisé ; même fichier modifié dans le worktree d'un agent ou une autre branche → ignoré (FR-007) ; invalide → `lastValid` gardé, `error` avec ligne, fichier jamais réécrit (FR-010, US3 sc.3) ; marqueurs de conflit → erreur de syntaxe avec ligne ; `version: 2` → refus sans écriture ; un nouveau blob après `fetchRefs` → version courante changée, exécutions en cours inchangées (US3 sc.4) ; fichier et réglage local de 008 différents → fichier gagnant et `ignoredLocal` (US3 sc.6)
- [ ] T028 [P] [US3] Tests dans `tests/unit/main/workflow/workflow-service.test.ts` : workflow `phase2` ou invalide sur cette machine → exécution `refused` avec raison, aucune étape lancée (SC-005, FR-006) ; étape retirée par une nouvelle version pendant qu'une issue y est → l'exécution continue sur sa copie (edge case)
- [ ] T029 [P] [US3] Tests dans `tests/unit/shared/todo.test.ts` : `workflow-invalid` une fois par `oid`, titre avec la ligne ; dans `tests/unit/shared/workflow-layout.test.ts` : couches par plus long chemin sans les retours plafonnés, ordre du fichier dans la couche, retours en arc, `position` gardée ; dans `tests/unit/renderer/workflow/WorkflowView.test.tsx` (lecture) : en-tête (source, état, erreur avec ligne, réglage local ignoré), nœuds nommés selon `contracts/ui.md`, texte affiché ; dans `tests/unit/main/ipc/workflow-handlers.test.ts` : `workflow:get` ; dans `tests/unit/renderer/app/Toolbar.test.tsx` : choix « Workflow », jamais nommé « Graphe »
- [ ] T030 [P] [US3] E2E dans `tests/e2e/us62-workflow-file.spec.ts` : fichier committé sur le remote nu, `fetch`, vue « Workflow » fidèle au fichier (US3 sc.1) ; changement poussé par un « collègue » (second clone) suivi après le `fetch` suivant ; issue en cours gardant sa version
- [ ] T031 [P] [US3] E2E dans `tests/e2e/us63-workflow-invalid.spec.ts` : fichier invalide → erreur avec ligne dans l'en-tête et À faire, dernière version valide utilisée ; fichier de seconde phase → « non exécutable », rien d'exécuté ; réglage local ignoré affiché

### Implémentation

- [ ] T032 [US3] Dans `src/main/workflow/workflow-source.ts` : `lastValid`, `error`, `readAt`, relecture après chaque `fetchRefs` de 008, `ignoredLocal`, `machineCheck` avec les CLI et profils de la machine
- [ ] T033 [US3] Dans `src/main/workflow/workflow-service.ts` : statut `refused` et `workflow-refused` ; dans `src/shared/todo.ts` : `workflow-invalid`
- [ ] T034 [US3] Créer `src/main/ipc/workflow-handlers.ts` (`workflow:get`) et l'émission `workspace:workflow` ; canaux dans `src/shared/ipc.ts` ; vue « Workflow » en lecture (en-tête, graphe et texte) dans `src/renderer/workflow/WorkflowView.tsx`, `WorkflowGraph.tsx` et `src/shared/workflow-layout.ts`, entrée « Workflow » dans `src/renderer/app/Toolbar.tsx`

**Checkpoint** : US3 livrée ; PR « 010 Phase 4 US3 ».

---

## Phase 5: User Story 2a — Composer son workflow à la souris et au clavier (P1)

**But** : l'éditeur crée, relie, règle et retire des étapes, avec la forme texte et la validation en direct. Pas
encore d'enregistrement.

**Test indépendant** : test de composant de l'éditeur ; graphe et texte comparés ; parcours au clavier seul.

### Tests (rouges d'abord)

- [ ] T035 [P] [US2] Tests dans `tests/unit/shared/workflow-layout.test.ts` (bloc brouillon) : étape ajoutée ou retirée replacée sans bouger les étapes à `position`, 20 étapes sous 50 ms
- [ ] T036 [P] [US2] Tests dans `tests/unit/renderer/workflow/WorkflowView.test.tsx` et `StagePanel.test.tsx` : ajouter une étape et la relier change le graphe et le texte aux mêmes lignes (US2 sc.1) ; rôles et modèles proposés limités au plafond du profil (US2 sc.2) ; graphe invalide → « Enregistrer » inactif et erreur nommant l'étape (US2 sc.4) ; plafond demandé seulement pour une transition qui ferme une boucle ; retirer une étape reliée demande confirmation ; glisser un nœud l'ajoute à `moved`
- [ ] T037 [P] [US2] Tests dans `tests/unit/renderer/workflow/keyboard.test.tsx` : flèches entre nœuds, `Alt` + flèches déplace de 8 px, `Entrée`, `Suppr` ; région `aria-live` annonce chaque changement (US2 sc.5)
- [ ] T038 [P] [US2] Tests dans `tests/unit/main/ipc/workflow-handlers.test.ts` : `workflow:validate` rend le texte de `writeWorkflow`, la validation et `machineCheck`
- [ ] T039 [P] [US2] E2E dans `tests/e2e/us64-workflow-compose.spec.ts` : insérer « Peaufinage » entre la boucle et la PR à la souris, choisir agents et modèle, régler le plafond ; texte affiché conforme
- [ ] T040 [P] [US2] E2E dans `tests/e2e/us65-workflow-keyboard.spec.ts` : même parcours au clavier seul, annonces lues dans la région `aria-live`, audit axe sans violation (FR-008)

### Implémentation

- [ ] T041 [US2] Dans `src/renderer/workflow/WorkflowView.tsx`, `WorkflowGraph.tsx` et `StagePanel.tsx` : brouillon, liste, panneau de `contracts/ui.md`, glisser sur grille, clavier, `aria-live`, texte en lecture avec ligne surlignée
- [ ] T042 [US2] Dans `src/main/ipc/workflow-handlers.ts` : `workflow:validate` ; dans `src/renderer/store/app-store.ts` : brouillon par workspace, perdu à la fermeture

**Checkpoint** : éditeur utilisable sans enregistrement ; PR « 010 Phase 5 US2a ».

---

## Phase 6: User Story 2b — Enregistrer par une PR relue (P1)

**But** : « Enregistrer » crée une branche et une PR sans verdict, ou passe par la fusion locale, ou refuse avec sa
raison ; les réglages de livraison passent par le même chemin.

**Test indépendant** : dépôt temporaire avec remote nu et faux `gh` ; enregistrer, relire le fichier de la branche,
le comparer au brouillon.

### Tests (rouges d'abord)

- [ ] T043 [P] [US2] Tests dans `tests/integration/workflow/workflow-saver.test.ts` : brouillon identique → aucune écriture ni branche (SC-003, US3 sc.2) ; changé → branche `pact/workflow-…` partant de `origin/<main>`, un commit qui ne touche que `.pact/workflow.yaml`, aucun worktree créé, worktrees des agents intacts ; demande 008 `source: 'workflow'`, `unverified`, sans boucle ; projet sans fichier → la PR crée le fichier avec les réglages de 008 (US2 sc.7) ; sans remote → élément `delivery-local` « Fusionner sans verdict » (US2 sc.8) ; remote non GitHub ou `gh` absent → refus avant tout commit, raison et « Modifie `.pact/workflow.yaml` avec Git » (US2 sc.9) ; seconde demande pendant une PR ouverte → refus avec son numéro
- [ ] T044 [P] [US2] Tests dans `tests/unit/main/delivery/delivery-service.test.ts` : une demande `workflow` n'est jamais fusionnée par Auto, toujours `delivery-review` (US2 sc.6) ; ni compteur ni nettoyage ; à la fusion constatée, `WorkflowSource` relit la version courante
- [ ] T045 [P] [US2] Tests dans `tests/unit/renderer/delivery/DeliverySettingsDialog.test.tsx` : « Enregistrer (PR) » appelle `workflow:save` avec le plafond, les passes, la consigne et le mode ; Auto reste local (FR-016) ; réglage local ignoré affiché
- [ ] T046 [P] [US2] E2E dans `tests/e2e/us66-workflow-save.spec.ts` avec `tests/fixtures/fake-cli/scenarios/workflow-save.json` : enregistrer → PR sur le faux `gh`, relecture demandée même Auto activé ; issue lancée avant la fusion → ancienne version ; fusion par Valider ; issue suivante → nouvelle étape et nouveau plafond (US2 sc.3, sc.6, sc.7)
- [ ] T047 [P] [US2] E2E dans `tests/e2e/us67-workflow-save-local.spec.ts` : dépôt sans remote → « Fusionner sans verdict » confirmé ; remote non GitHub → refus lisible, éditeur toujours lisible (US2 sc.8, sc.9)

### Implémentation

- [ ] T048 [US2] Créer `src/main/workflow/workflow-saver.ts` (research R12) sur `writeBlob`, `replaceInTree`, `commitWithHooks`, `GhClient.availability` et `DeliveryService.requestUnverified`
- [ ] T049 [US2] Dans `src/main/delivery/delivery-service.ts` et `src/main/review/integration-service.ts` : `source: 'workflow'`, `agentId` nul, branche sans agent pour la voie locale, relecture de la source à la fusion
- [ ] T050 [US2] Dans `src/main/ipc/workflow-handlers.ts`, `src/renderer/workflow/WorkflowView.tsx` et `src/renderer/delivery/DeliverySettingsDialog.tsx` : `workflow:save`, libellés « Enregistrer (PR) » et « Enregistrer (fusion locale) », état « PR #n en relecture »

**Checkpoint** : US2 livrée ; PR « 010 Phase 6 US2b ».

---

## Phase 7: User Story 4 — PACT tient les transitions (P2)

**But** : l'orchestrateur lit le workflow et ne peut prendre que ses transitions ; le skill n'a plus d'ordre écrit.

**Test indépendant** : faux orchestrateur qui tente une transition absente ; refus et raison vérifiés.

### Tests (rouges d'abord)

- [ ] T051 [P] [US4] Tests dans `tests/integration/orchestrator/tools-workflow.test.ts` : `get_workflow` au format de `contracts/mcp-tools.md`, avec et sans `issue` ; `advance_stage` permis sur `done` d'une étape sans agent, refusé dans chaque cas du contrat ; `request_delivery` en étape `polish` → « Étape en cours : polish. Étapes possibles : pr (sur done). » (US4 sc.1) ; `start_loop` et `polish_pass` hors étape → refus ; `launch_agent({ role, issue })` lie la clé et prend son modèle, plafond du profil appliqué ; `list_agents` rend `stage`
- [ ] T052 [P] [US4] Tests dans `tests/unit/main/workflow/workflow-service.test.ts` : chaque changement d'étape réveille l'orchestrateur par un message `action` (US4 sc.3) ; aucun résultat de PACT ne peut venir d'un outil de l'orchestrateur
- [ ] T053 [P] [US4] Test dans `tests/unit/main/orchestrator/skills-content.test.ts` : `pact-orchestrator/SKILL.md` exige `get_workflow` et les messages `stage`, et ne contient plus « Chaîne : cadrage → design → boucle → recap » ni d'ordre de chaîne écrit (US4 sc.5, FR-018)
- [ ] T054 [P] [US4] E2E dans `tests/e2e/us68-workflow-gate.spec.ts` avec `tests/fixtures/fake-cli/scenarios/workflow-skip.json` : US4 sc.1 à 3 ; au plafond, escalade de 008 (US4 sc.2)

### Implémentation

- [ ] T055 [US4] Dans `src/main/orchestrator/tools.ts` : `get_workflow`, `advance_stage`, barrières de `start_loop`, `polish_pass`, `request_delivery`, paramètre `issue` de `launch_agent`, `stage` dans `list_agents`
- [ ] T056 [US4] Réécrire la section « Chaîne » de `resources/skills/pact-orchestrator/SKILL.md` en section « Workflow » (research R16), et la ligne « 3 tours » de `resources/skills/pact-contract.md` pour citer le plafond du workflow

**Checkpoint** : US4 livrée ; PR « 010 Phase 7 US4 ».

---

## Phase 8: Polish

- [ ] T057 [P] Test dans `tests/unit/shared/delivery.test.ts`, puis `deliveryGate` dans `src/shared/delivery.ts` : une livraison d'agent qui touche `.pact/workflow.yaml` n'est jamais fusionnée par Auto, raison « modifie le workflow » (research R17)
- [ ] T058 [P] E2E dans `tests/e2e/us69-workflow-custom.spec.ts` avec `tests/fixtures/fake-cli/scenarios/workflow-custom.json` : workflow avec peaufinage à 1 passe, consigne d'étape et recap en arrivée, déroulé de bout en bout ; consigne du workflow lue par les faux agents ; aucun texte d'agent tapé (007)
- [ ] T059 Dérouler `specs/010-workflow-graph/quickstart.md`, dont le chronométrage de SC-002 ; vérifier la couverture des fichiers modifiés (80 % hors UI, 70 % UI)
- [ ] T060 Mettre à jour `README.md` (section orchestrateur : `.pact/workflow.yaml`, vue « Workflow », enregistrement par PR) ; ajuster `version` dans `package.json` selon la règle 0.x seulement si l'orchestrateur le demande

---

## Dépendances

```text
Phase 1 → Phase 2 → Phase 3 (US1) → Phase 4 (US3) → { Phase 5 (US2a) → Phase 6 (US2b), Phase 7 (US4) } → Phase 8
```

- US1 est le MVP : `WorkflowService` et `WorkflowSource` y naissent.
- US3 avant US2 : l'éditeur affiche et enregistre ce que la source lit ; la vue en lecture naît en Phase 4.
- US2a et US4 sont disjointes après la Phase 4 ; US2b suit US2a.
- Dans une phase, les tests précèdent l'implémentation ; les tâches [P] de test ne partagent pas de fichier.
- Implémentation séquentielle dans une phase, car plusieurs tâches partagent `workflow-service.ts`, `tools.ts` ou
  `WorkflowView.tsx`.

## Parallélisation sans chevauchement

Après la fusion de la Phase 4, deux lots disjoints :

| Lot | Fichiers de production | Tests et fixtures |
|---|---|---|
| US2a puis US2b | `renderer/workflow/*`, `shared/workflow-layout.ts`, `ipc/workflow-handlers.ts`, `workflow/workflow-saver.ts`, `delivery/delivery-service.ts`, `review/integration-service.ts`, `renderer/delivery/DeliverySettingsDialog.tsx`, `renderer/store/app-store.ts` | `workflow-layout`, `WorkflowView`, `StagePanel`, `keyboard`, `workflow-handlers`, `workflow-saver`, `delivery-service`, `DeliverySettingsDialog`, `us64`–`us67` |
| US4 | `orchestrator/tools.ts`, `resources/skills/*` | `tools-workflow`, `workflow-service` (bloc US4), `skills-content`, `us68`, `workflow-skip.json` |

**Seul recouvrement** : `tests/unit/main/workflow/workflow-service.test.ts` (T052), dans un bloc séparé ; le faire
après la fusion de l'autre lot si besoin. En Phase 8, T057 et T058 sont disjoints.

## Stratégie

MVP = Phases 1 à 3 : sans fichier, rien ne change pour l'utilisateur, et PACT suit l'étape de chaque issue. Puis US3
fait du fichier la source ; US2 donne l'éditeur et l'enregistrement relu ; US4 ferme les transitions et retire l'ordre
du skill. Tant que US4 n'est pas fusionnée, l'orchestrateur suit encore l'ordre du skill, que le défaut reproduit.
