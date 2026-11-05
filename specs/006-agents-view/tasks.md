# Tasks: Vue des agents

**Input**: Design documents from `/specs/006-agents-view/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ui.md, quickstart.md

**Tests**: obligatoires (constitution I) : chaque story commence par ses tests rouges, commités avant le code.

**Livraison**: une PR par phase (Phases 1 et 2 ensemble), branche `006-phase-N-…` depuis `006-agents-view` ;
chaque commit dans une chaîne `&&` gardée par `npm run check` et `npm run test:e2e`.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T001 Fusionner le correctif orchestrateur de `005-phase-7-polish` (événement `workspace:agentsLaunched`, attente MCP 240 s) dans `006-agents-view` ; vérifier que `src/shared/ipc.ts` déclare `workspace:agentsLaunched`
- [X] T002 Ajouter `@axe-core/playwright` en devDependency (version exacte, `npm i -D -E`) dans `package.json` et `package-lock.json` ; helper `expectNoSeriousA11yViolations(page)` (échoue sur toute violation `serious` ou `critical`) dans `tests/e2e/helpers/a11y.ts`

---

## Phase 2: Foundational (bloque toutes les stories)

**But** : le champ « lancé par » et les fonctions pures partagées par la colonne et le graphe.

### Tests (rouges d'abord)

- [X] T003 [P] Tests du schéma : `launchedBy` vaut `null` par défaut à la lecture d'un agent sans le champ, accepte un uuid, refuse un nombre, dans `tests/unit/shared/model.test.ts`
- [X] T004 [P] Tests de `agentStateLabel(agent, now)` : un libellé par état (`démarre`, `travaille`, `attend une consigne`, `attend une réponse`, `fini`, `erreur`, `limite de débit`, `reprise à HH:MM` quand une reprise est programmée, `fermé`) dans `tests/unit/shared/agents-view.test.ts`
- [X] T005 [P] Tests de `agentPhase(agent, loops)` selon data-model « Phase » : boucle `running` → `{ label: 'dev ↔ test', issueId, round: { n, max: 3 } }` ; `passed` → `boucle terminée` ; `escalated` → `boucle arrêtée` ; `closed` ignorée ; plusieurs boucles → la `running` la plus récente, sinon la dernière du tableau ; hors boucle, rôle `spec`/`design`/`recap` → le rôle, sans issue ; sinon aucune phase, dans `tests/unit/shared/agents-view.test.ts`
- [X] T006 [P] Test d'intégration : `launch_agent` appelé par l'orchestrateur crée des agents dont `launchedBy` = id de l'orchestrateur ; un lancement depuis l'interface laisse `launchedBy: null` ; la valeur survit à un rechargement de l'état, dans `tests/integration/orchestrator/tools-agents.test.ts`

### Implémentation

- [X] T007 Ajouter `launchedBy: z.string().nullable().default(null)` à `agentSchema` (« id (uuid) de l'orchestrateur qui l'a lancé ; `null` = lancé par l'utilisateur … Posé une fois, au lancement ; jamais modifié ensuite ») dans `src/shared/model.ts` ; corriger les fabriques d'agents des tests si le typage l'exige
- [X] T008 `LaunchRequest.launchedBy?: string` recopié dans chaque `Agent` créé (défaut `null`) dans `src/main/agents/agent-manager.ts` ; `launch_agent` passe l'id de l'agent appelant dans `src/main/orchestrator/tools.ts`
- [X] T009 Créer `src/shared/agents-view.ts` avec `agentStateLabel()` et `agentPhase()` (purs, sans DOM) ; faire passer T003–T006

**Checkpoint** : `npm run check` vert ; PR « 006 Phase 1-2 ».

---

## Phase 3: User Story 1 — Colonne « Agents » (P1) 🎯 MVP

**But** : une ligne par agent (rôle, état, issue) ; bouton d'action seulement quand une action est due ;
éléments sans agent en tête ; clic = Focus.

**Test indépendant** : faux CLI orchestrateur qui lance trois agents → quatre lignes ; une question fait
apparaître « ◆ Répondre » sur la seule ligne concernée, en tête.

### Tests (rouges d'abord)

- [x] T010 [P] [US1] Tests de `agentRows(workspace, todos)` (data-model « AgentsView ») : `answer`, `rate-limit`, `review`, `prompt` vont sur la ligne de leur agent, `todo` = premier selon `ORDER`, `pending` = leur nombre ; `integration-request`, `publish-issues`, `loop-escalated`, `overlap`, `usage-limit`, `info` vont dans `head` ; ordre des lignes : avec action (ordre `ORDER` puis `position`), puis rôle `orchestrator`, puis `position` ; terminaux libres exclus ; `pendingCount` = éléments non `info` ; aucun élément de `deriveTodos` perdu (SC-005), dans `tests/unit/shared/agents-view.test.ts`
- [x] T011 [P] [US1] Tests composant `AgentRow` : bouton principal nommé `<Nom>, <rôle>, <état>[, issue <id>]` (contracts/ui.md) ; bouton d'action présent seulement si `todo` ; clic et Entrée sur le bouton principal ouvrent le Focus ; aucun bouton imbriqué, dans `tests/unit/renderer/agents/AgentRow.test.tsx`
- [x] T012 [P] [US1] Tests composant `AgentsColumn` : `complementary` « Agents », titre niveau 2 `Agents <N>` + `<M> à traiter`, `list "À traiter"` puis `list "Agents du workspace"` ; les actions existantes (Répondre, Revue →, Intégrer ?, Reprendre, Créer les issues…) restent cliquables ; adapter les cas utiles de `tests/unit/renderer/todo/TodoColumn.test.tsx` puis supprimer ce fichier, dans `tests/unit/renderer/agents/AgentsColumn.test.tsx`
- [x] T013 [P] [US1] Test Toolbar : bouton bascule nommé `Agents <M>` (plus « À faire ») dans `tests/unit/renderer/app/Toolbar.test.tsx`
- [x] T014 [US1] E2E : orchestrateur (scénario faux CLI `orchestra-agents`) lance trois agents → quatre lignes avec rôles ; un agent pose une question → sa ligne passe en tête avec « ◆ Répondre », les autres sans bouton d'action ; clic sur une ligne → Focus ; demande d'intégration visible dans « À traiter » ; audit axe sans violation sérieuse, dans `tests/e2e/us28-agents-column.spec.ts` ; adapter les sélecteurs « À faire » de `tests/e2e/us4-todo.spec.ts` et autres specs touchées

### Implémentation

- [x] T015 [US1] `agentRows()` dans `src/shared/agents-view.ts` (regroupe `deriveTodos` sans recalculer d'action)
- [x] T016 [P] [US1] `src/renderer/agents/AgentRow.tsx` : bouton principal + actions réutilisées de `src/renderer/todo/TodoItem.tsx` (extraire le rendu des actions en composant exporté si besoin, sans changer leurs libellés)
- [x] T017 [US1] `src/renderer/agents/AgentsColumn.tsx` (en-tête collant, `head` rendus par `TodoItem`, lignes par `AgentRow`) ; remplacer `TodoColumn` dans `src/renderer/workspace/WorkspaceView.tsx` ; supprimer `src/renderer/todo/TodoColumn.tsx`
- [x] T018 [US1] Libellé `Agents <M>` du bouton de la barre dans `src/renderer/app/Toolbar.tsx`

**Checkpoint** : US1 utilisable seule ; PR « 006 Phase 3 US1 ».

---

## Phase 4: User Story 2 — Tuiles sous l'orchestrateur (P1)

**But** : chaque agent lancé par l'orchestrateur a sa tuile dès son lancement ; l'orchestrateur occupe
2×2 cases, les agents la colonne de droite puis des rangées de 3 qu'on fait défiler (#41, #47).

**Test indépendant** : orchestrateur + cinq sous-agents à 1024 × 768 → orchestrateur 2×2, deux agents à
droite, trois sur la rangée suivante atteinte par défilement vertical.

### Tests (rouges d'abord)

- [x] T019 [P] [US2] Test `TileGrid` disposition `lead` avec 0, 1, 2, 3 et 5 agents : grille de 3 colonnes, orchestrateur en premier en `col-span-2 row-span-2`, agents 1–2 dans la colonne de droite, suivants par rangées de 3 ; conteneur `overflow-y-auto` ; case « + » unique seulement si la dernière rangée a une place libre (FR-010, FR-010b), dans `tests/unit/renderer/tiles/TileGrid.test.tsx`
- [x] T020 [P] [US2] E2E : l'orchestrateur lance deux agents → leurs tuiles apparaissent sous la sienne sans action de l'utilisateur, en moins d'une seconde après l'événement, dans `tests/e2e/us29-lead-tiles.spec.ts`
- [x] T021 [P] [US2] E2E layout : orchestrateur + cinq agents à 1024 × 768 → orchestrateur la plus grande tuile sur les deux colonnes de gauche, deux agents à droite visibles sans défilement, la rangée des trois suivants atteinte en faisant défiler la grille verticalement, hauteur de tuile ≥ 120 px, pas de défilement horizontal, dans `tests/e2e/layout.spec.ts`

- [x] T022a [P] [US2] Test : le terminal est ouvert dans un conteneur sans marge, la hauteur proposée par le fit = zone libre (pas la hauteur avec padding) ; boutons d'action rendus seulement au survol / `focus-within`, dans `tests/unit/renderer/tiles/Tile.test.tsx` ; e2e : la dernière ligne écrite par le faux CLI est visible et non recouverte, dans `tests/e2e/us29-lead-tiles.spec.ts`

### Implémentation

- [x] T022b [US2] Ouvrir xterm dans un div interne sans padding (le fit d'xterm compte le padding du parent comme hauteur utile) dans `src/renderer/tiles/TerminalView.tsx` ; retirer `pb-14` conditionnel ; boutons d'action visibles au survol de la tuile et au focus des boutons eux-mêmes (le focus de la tuile appartient à xterm), action due signalée par le contour, dans `src/renderer/tiles/Tile.tsx`
- [x] T022 [US2] Disposition `lead` en une grille de 3 colonnes (orchestrateur `col-span-2 row-span-2`, rangées de la moitié de la hauteur visible, `overflow-y-auto`) au lieu des deux sections superposées, dans `src/renderer/tiles/TileGrid.tsx`

### Issues rattachées (#40, #47) — grille sans orchestrateur

- [x] T051 [P] [US2] Test (#40, #47) : `TileGrid` sans orchestrateur avec 1, 2, 3, 4, 6 et 7 tuiles → colonnes 1, 2, 3, 2, 3, 3 ; rangées qui partagent la hauteur jusqu'à 6 tuiles ; la septième sur une rangée atteinte par défilement vertical ; aucune case vide sauf une case « + » quand la dernière rangée a une place libre (FR-010a, FR-010b), dans `tests/unit/renderer/tiles/TileGrid.test.tsx`
- [x] T052 [P] [US2] E2E (#40, #47) : un terminal occupe toute la grille ; sept terminaux → 3×2 visibles, le septième atteint par défilement ; ouvrir la colonne « Agents » garde 3 colonnes ; pas de défilement horizontal, dans `tests/e2e/layout.spec.ts` ; adapter les specs e2e qui cliquent une case « + » vide (`rg "Ajouter un agent" tests/e2e`)
- [x] T053 [US2] Disposition sans orchestrateur (colonnes selon le nombre de tuiles, rangées de la moitié de la hauteur visible, défilement vertical, case « + » unique) dans `src/renderer/tiles/TileGrid.tsx` ; conteneur de la grille qui se réduit avec la colonne « Agents » dans `src/renderer/workspace/WorkspaceView.tsx`

**Checkpoint** : PR « 006 Phase 4 US2 ».

---

## Phase 5: User Story 3 — Vue « Graphe » (P2)

**But** : orchestrateur relié à ses agents, groupes de boucles avec tour, état en direct, clic = Focus.

**Test indépendant** : vue « Graphe » avec une boucle au tour 2 → « dev ↔ test 2/3 » sous son issue ;
un changement d'état met le nœud à jour.

### Tests (rouges d'abord)

- [ ] T023 [P] [US3] Tests de `graphLayout(agents, loops)` (data-model « Graph ») : orchestrateur en haut ; un groupe par boucle non `closed` (dev et test côte à côte, `group` = issueId) ; puis agents lancés par l'orchestrateur, puis ceux lancés par l'utilisateur ; liens `launched` seulement si l'orchestrateur existe encore ; liens `loop` dev ↔ test ; sans orchestrateur ou orchestrateur fermé : aucun lien `launched`, nœuds à plat ; terminaux libres exclus, dans `tests/unit/renderer/graph/graph-layout.test.ts`
- [ ] T024 [P] [US3] Tests `GraphView` : `region` « Graphe des agents », `list "Agents"` de boutons nommés `<Nom>, <rôle>, <état>[, <phase>][, issue <id>], lancé par <orchestrateur | vous>`, `group` « Issue <id> · dev ↔ test <n>/3 », `svg` `aria-hidden="true"` ; Entrée/Espace et clic → Focus ; ordre de tabulation = ordre de lecture, dans `tests/unit/renderer/graph/GraphView.test.tsx`
- [ ] T025 [P] [US3] Tests Toolbar et store : `radio` « Graphe » dans `radiogroup "Vue"`, actif dès qu'un agent existe ; `View` accepte `'graph'`, dans `tests/unit/renderer/app/Toolbar.test.tsx` et `tests/unit/renderer/store/app-store.test.ts`
- [ ] T026 [US3] E2E : orchestrateur, deux agents et une boucle (scénario faux CLI de `us19-loop`) → graphe relié, groupe « dev ↔ test 2/3 » au tour 2 ; un changement d'état modifie le nœud en < 1 s ; clic sur un nœud → Focus ; audit axe sans violation sérieuse, dans `tests/e2e/us30-graph.spec.ts`

### Implémentation

- [ ] T027 [P] [US3] `src/renderer/graph/graph-layout.ts` (pur, positions en grille, liens)
- [ ] T028 [US3] `src/renderer/graph/GraphView.tsx` (nœuds boutons en CSS grid, couleurs d'agent et d'état existantes, liens en `svg` décoratif)
- [ ] T029 [US3] `View = 'tiles' | 'focus' | 'graph'` dans `src/renderer/store/app-store.ts` ; option « Graphe » dans `src/renderer/app/Toolbar.tsx` ; rendu de `GraphView` pour `view === 'graph'` dans `src/renderer/workspace/WorkspaceView.tsx`

**Checkpoint** : PR « 006 Phase 5 US3 ».

---

## Phase 6: User Story 4 — Fermeture et relance liées (P1)

**Test indépendant** : orchestrateur + deux agents ; fermer l'orchestrateur ferme les trois ; relancer
avec « Reprendre le travail » relance les trois et envoie la consigne au seul agent qui travaillait.

- [x] T033 [P] [US4] Tests : `agentsLaunchedBy(workspace, orchestratorId)` ; fermeture de l'orchestrateur ferme ses agents (choix du worktree appliqué à tous) ; fermeture d'un sous-agent ne ferme que lui ; l'état à la fermeture est mémorisé (`closedWhileWorking: boolean`) ; relance → agents relancés, consigne de reprise aux seuls `closedWhileWorking`, dans `tests/integration/agents/agent-group.test.ts`
- [x] T034 [P] [US4] Test `CloseAgentDialog` : liste les sous-agents de l'orchestrateur, garder par défaut, dans `tests/unit/renderer/tiles/CloseAgentDialog.test.tsx` ; test de la case « Reprendre le travail » (cochée par défaut) à la relance
- [x] T035 [US4] E2E : fermer puis relancer un orchestrateur et deux agents (faux CLI), consigne de reprise reçue par le seul agent qui travaillait, dans `tests/e2e/us31-orchestrator-group.spec.ts`
- [x] T036 [US4] Fermeture et relance en groupe dans `src/main/agents/agent-manager.ts` (champ persisté `closedWhileWorking`, défaut `false`) ; option `resumeWork` sur `agent:restart` dans `src/shared/ipc.ts`
- [x] T037 [US4] Liste des sous-agents dans `src/renderer/tiles/CloseAgentDialog.tsx` ; case « Reprendre le travail » à la relance de l'orchestrateur

---

## Phase 7: User Story 5 — Faire d'un agent l'orchestrateur (P2)

**Test indépendant** : un agent sans rôle → « Faire orchestrateur » → il redémarre sur sa session avec
l'accès orchestrateur, sa tuile passe en haut, il lance un agent lié à lui.

- [ ] T038 [P] [US5] Tests : `promoteToOrchestrator(agentId)` refuse s'il existe déjà un orchestrateur ou si le CLI ne peut pas l'être (raison renvoyée) ; sinon pose `role: 'orchestrator'`, prépare l'accès orchestrateur (plugin + jeton, comme au lancement) et redémarre en reprenant `sessionId`, dans `tests/integration/orchestrator/promote.test.ts`
- [ ] T039 [P] [US5] Tests composant : « Faire orchestrateur » dans le menu ⋮ de la tuile et du Focus, indisponible avec sa raison ; confirmation qui prévient de l'interruption si l'agent travaille, dans `tests/unit/renderer/tiles/TileActions.test.tsx`
- [ ] T040 [US5] E2E : faux CLI, un agent devient orchestrateur, sa tuile passe en haut, `launch_agent` crée un agent `launchedBy` = lui, dans `tests/e2e/us32-promote-orchestrator.spec.ts`
- [ ] T041 [US5] Canal `orchestrator:promote` `{ agentId }` dans `src/shared/ipc.ts` ; implémentation dans `src/main/agents/agent-manager.ts` en réutilisant la préparation orchestrateur du lancement (003 R2) et `restart` avec reprise de session
- [ ] T042 [US5] Option de menu et confirmation dans `src/renderer/tiles/TileActions.tsx` et `src/renderer/focus/FocusView.tsx`

---

## Phase 7b: Issues rattachées (#42, #43, #45, #46)

**Goal**: corrections d'UX remontées à l'usage, sur les mêmes fichiers que la vue des agents.

### Tests (rouges d'abord)

- [ ] T043 [P] Test (#42) : dans le Focus, un onglet autre que Terminal (Aperçu, Changements, Actions, Rapports) occupe toute la tuile et le terminal n'est pas visible (ni sortie, ni prompt), pour un orchestrateur comme pour un agent simple, dans `tests/unit/renderer/focus/FocusView.test.tsx` ; e2e : onglet Actions ouvert, la dernière ligne du faux CLI n'est pas visible, dans `tests/e2e/us29-lead-tiles.spec.ts`
- [ ] T044 [P] Test (#43) : `visibleTabs(agent)` renvoie Terminal toujours ; Aperçu seulement si l'agent a un port servi ; Changements seulement si le diff n'est pas vide ; Actions et Rapports seulement s'ils ont au moins une entrée ; un onglet apparaît dès que son contenu arrive, dans `tests/unit/renderer/focus/visible-tabs.test.ts`
- [ ] T045 [P] Test (#45) : `renameAgent(agentId, name)` refuse un nom vide ou déjà pris (raison renvoyée), persiste le nom, et le nom est utilisé par la tuile, l'en-tête du Focus, la colonne « Agents », le graphe et les outils MCP de l'orchestrateur (`wait_for_agents` accepte le nouveau nom), dans `tests/integration/agents/rename.test.ts` et `tests/unit/renderer/tiles/TileActions.test.tsx`
- [ ] T046 [P] Test (#46) : `agentColor(agent, agents)` donne aux sous-agents une nuance proche de la couleur de leur orchestrateur (même famille de teinte, distinctes entre elles) ; deux orchestrateurs ont des familles éloignées ; un agent sans orchestrateur garde sa couleur actuelle, dans `tests/unit/shared/agent-color.test.ts`

### Implementation

- [ ] T047 (#42) Panneau d'onglet en pleine hauteur, terminal masqué hors onglet Terminal (sans le détruire) dans `src/renderer/focus/FocusView.tsx`
- [ ] T048 (#43) `visibleTabs` dans `src/renderer/focus/visible-tabs.ts` ; barre d'onglets filtrée dans `src/renderer/focus/FocusView.tsx` ; si l'onglet actif disparaît, retour à Terminal
- [ ] T049 (#45) Canal `agent:rename` `{ agentId, name }` dans `src/shared/ipc.ts` ; implémentation persistée dans `src/main/agents/agent-manager.ts` ; résolution par nom dans les outils MCP ; option « Renommer » (menu ⋮ de la tuile et du Focus) dans `src/renderer/tiles/TileActions.tsx`
- [ ] T050 (#46) `agentColor` dans `src/shared/agent-color.ts` ; utilisé par la tuile, la colonne « Agents » et le graphe à la place de la couleur fixe

---

## Phase 8: Polish

- [ ] T030 [P] Documenter colonne « Agents » et vue « Graphe » dans `README.md` (section d'utilisation)
- [ ] T031 [P] Vérifier la couverture (non décroissante) et l'absence de code mort lié à l'ancienne colonne (`rg "À faire|TodoColumn" src tests`)
- [ ] T032 Dérouler `specs/006-agents-view/quickstart.md` (vérifs automatiques) et noter pour l'utilisateur la vérification à la main avec de vrais CLI

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → stories. US1, US2, US3 indépendantes entre elles après Phase 2 ; US3 réutilise
  `agentStateLabel`/`agentPhase` (Phase 2), pas `agentRows`. Toolbar touchée par US1 (T018) et US3 (T029) :
  faire US1 avant US3.
- Phase 7b après US1 et US2 (mêmes fichiers : `FocusView`, `Tile`, colonne « Agents ») ; T050 avant T028 si US3
  n'est pas encore faite, pour que le graphe utilise `agentColor`.
- Dans chaque story : tests rouges commités, puis implémentation jusqu'au vert.

## Parallel Example

```text
Phase 2 : T003, T004, T005, T006 ensemble (fichiers distincts sauf T004/T005 même fichier → à la suite).
US1 : T010, T011, T012, T013 ensemble ; puis T015 et T016 ensemble.
US3 : T023, T024, T025 ensemble ; T027 avant T028.
```

## Implementation Strategy

MVP = Phases 1-2 + US1 (colonne « Agents ») : répond au défaut principal (agents invisibles,
actions dispersées). Puis US2 (tuiles à 1024 × 768), puis US3 (graphe). Une PR par phase, fusionnée
quand la CI est verte.
