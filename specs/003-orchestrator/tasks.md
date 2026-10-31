---

description: "Tâches d'implémentation de 003 — orchestrateur"
---

# Tasks: Orchestrateur

**Input**: Design documents from `/specs/003-orchestrator/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/mcp-tools.md,
contracts/ipc.md, quickstart.md

**Tests**: OBLIGATOIRES (Constitution I — tests d'abord, non négociable).
- Dans chaque phase, les tâches de test précèdent l'implémentation. Elles DOIVENT être exécutées et
  échouer (Red) avant le code qui les fait passer (Green).
- Les outils MCP sont testés en HTTP, comme Claude Code les appelle ; les agents dirigés sont des
  faux CLI ; les dépôts sont de vrais dépôts temporaires.
- `npm run check` DOIT être vert à la fin de chaque phase (Constitution II, III), sans baisse de
  couverture sur aucun fichier (`scripts/coverage-guard.ts`).

**Organization**: tâches groupées par user story (spec.md US1…US5).

## Format: `[ID] [P?] [Story] Description`

- **[P]** : parallélisable (fichiers différents, aucune dépendance sur une tâche non terminée).
- **[Story]** : user story concernée (US1…US5).
- Chemins relatifs à la racine du dépôt, structure de plan.md.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: schémas partagés et outillage de test.

- [X] T001 [P] Tests puis schémas zod de 003 dans `tests/unit/shared/orchestrator.test.ts` et `src/shared/orchestrator.ts` :
  - `IntegrationRequest` (`id` uuid, `agentId` uuid, `mode` `'squash' | 'keep-commits'` défaut `squash`, `message` « string, 1 à 4 000 caractères », `requestedAt` date ISO) ;
  - `OrchestratorEvent` (`kind` `'turn-finished' | 'awaiting-answer' | 'error' | 'closed' | 'integration'`, `integration.outcome` `'integrated' | 'refused' | 'conflicted' | 'failed'`) ;
  - `OrchestratorAction` (`tool` parmi `send_prompt`, `launch_agent`, `close_agent`, `request_integration`, `run_tests` ; `summary` « 200 caractères au plus » ; `outcome` `'ok' | 'refused'`).
- [X] T002 [P] Tests puis extension des schémas persistés dans `tests/unit/shared/model.test.ts` et `src/shared/model.ts` :
  - `Agent.role: 'orchestrator' | null`, défaut `null` ;
  - `Workspace.integrationRequests`, défaut `[]` ;
  - au plus un agent `orchestrator` par workspace (`superRefine`) ;
  - un fichier de workspace de 002 se charge sans changement.
- [X] T003 [P] Tests puis étape `mcp` du faux CLI dans `tests/unit/fixtures/fake-cli.test.ts`, `tests/fixtures/fake-cli/fake-cli.mjs` et de nouveaux scénarios sous `tests/fixtures/fake-cli/scenarios/` :
  - `{ mcp: { tool, arguments } }` appelle `tools/call` sur `PACT_ORCHESTRATOR_URL` avec l'en-tête `X-Pact-Token: $PACT_ORCHESTRATOR_TOKEN` ;
  - la réponse texte est imprimée (`MCP <tool> : <texte>`) ;
  - les arguments acceptent `{{prompt}}`, remplacé par la consigne tapée, pour qu'un test pilote le faux orchestrateur depuis son terminal.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: protocole, serveur, sessions, plugin et lancement d'un orchestrateur — nécessaires à
toutes les stories.

### Tests (Red)

- [X] T004 [P] Tests du protocole MCP pur dans `tests/unit/main/orchestrator/mcp.test.ts` (research R1) :
  - `initialize` répond `protocolVersion` (celle du client), `capabilities.tools`, `serverInfo` ;
  - `ping` répond `{}` ;
  - une notification (sans `id`) donne `202` sans corps ;
  - `tools/list` liste les outils fournis avec leur `inputSchema` ;
  - `tools/call` d'un outil inconnu donne `-32602` ;
  - une méthode inconnue donne `-32601` ;
  - `server/discover` donne `-32601` sans casser la session ;
  - un corps qui n'est pas du JSON-RPC donne `-32600`.
- [X] T005 [P] Tests de `HookServer` étendu dans `tests/integration/hooks/hook-server.test.ts` (R1, R3) :
  - `POST /mcp` avec le jeton d'un gestionnaire MCP atteint ce gestionnaire, qui choisit le statut (`200`, `202`) ;
  - `GET /mcp` donne `405` ;
  - sans jeton ou avec un jeton révoqué : `401` ;
  - `Host` autre que `127.0.0.1:<port>` : `403` ;
  - en-tête `Origin` présent : `403` ;
  - les hooks de 001 répondent comme avant (tests existants inchangés) ;
  - un jeton de hook ne donne pas accès à `/mcp`, et inversement.
- [X] T006 [P] Tests de l'écriture du plugin dans `tests/unit/main/orchestrator/plugin.test.ts` (R2) :
  - `.claude-plugin/plugin.json` a `name: "pact"` ;
  - `skills/orchestrateur/SKILL.md` a un en-tête `name` et `description` et rappelle les règles du skill ;
  - `.mcp.json` décrit le serveur `pact` en `http` sur l'URL donnée, avec `X-Pact-Token: ${PACT_ORCHESTRATOR_TOKEN}` ;
  - le jeton n'apparaît dans aucun fichier ;
  - un second appel réécrit l'URL ;
  - chemins avec espaces et accents.
- [X] T007 [P] Tests de contrat de l'orchestrateur Claude Code dans `tests/contract/claude-code.contract.test.ts` (R2) :
  - avec `orchestrator` dans l'entrée : `--plugin-dir <dossier>`, `permissions.allow` contient `mcp__plugin_pact_pact__*` (avec les règles `ask` du niveau « actions sensibles »), `--append-system-prompt` nomme le skill ;
  - `PACT_ORCHESTRATOR_TOKEN` et `MCP_TOOL_TIMEOUT` sont dans l'environnement, jamais dans les arguments ;
  - sans `orchestrator`, rien de tout cela ;
  - `supportsOrchestrator` vaut vrai.
- [X] T008 [P] Tests de contrat des autres adaptateurs dans `tests/contract/fake.contract.test.ts`, `tests/contract/codex.contract.test.ts` et `tests/contract/generic.contract.test.ts` :
  - le faux CLI reçoit `PACT_ORCHESTRATOR_URL` et `PACT_ORCHESTRATOR_TOKEN` dans son environnement ;
  - Codex et les CLI génériques : `supportsOrchestrator` faux.
- [ ] T009 [P] Tests de `OrchestratorService` (sessions) dans `tests/integration/orchestrator/orchestrator-service.test.ts` :
  - un agent lancé avec `orchestrator: true` a `role: 'orchestrator'`, une session, un jeton de 64 caractères hexadécimaux et un plugin écrit ;
  - un second orchestrateur dans le workspace est refusé (`INVALID_INPUT`) ;
  - un CLI sans `supportsOrchestrator` est refusé ;
  - après un redémarrage (`restore` puis reprise), le rôle reste et le jeton change ;
  - la fermeture de l'orchestrateur révoque son jeton.
- [ ] T010 [P] Tests du lanceur dans `tests/unit/renderer/launch/QuickLaunch.test.tsx`, `tests/unit/renderer/launch/DetailedLaunch.test.tsx` et `tests/unit/shared/launch-draft.test.ts` :
  - option « Orchestrateur » sur un agent Claude Code seulement, et sur un seul agent ;
  - inactive quand le workspace a déjà un orchestrateur ;
  - le brouillon porte `orchestrator: true`.

### Implementation (Green)

- [X] T011 Implémenter le protocole MCP pur dans `src/main/orchestrator/mcp.ts`.
- [X] T012 Étendre `src/main/agents/hook-server.ts` : routes `/mcp`, statut choisi par le gestionnaire, contrôle de `Host` et `Origin`, jetons MCP distincts des jetons de hook.
- [X] T013 [P] Implémenter l'écriture du plugin et le texte du skill dans `src/main/orchestrator/plugin.ts`.
- [X] T014 Ajouter `supportsOrchestrator` et l'entrée `orchestrator: { pluginDir, url, token } | null` de `LaunchInput` dans `src/main/agents/adapters/types.ts`, puis les implémenter dans `claude-code.ts`, `fake.ts`, `codex.ts` et `generic.ts` sous `src/main/agents/adapters/`.
- [ ] T015 Créer `src/main/orchestrator/orchestrator-service.ts` (sessions, jetons, plugin, révocation), appelé par `AgentManager` au lancement et à la reprise d'un agent `role: 'orchestrator'` dans `src/main/agents/agent-manager.ts`, et branché dans `src/main/index.ts`.
- [ ] T016 Ajouter l'option « Orchestrateur » dans `src/shared/launch-draft.ts`, `src/shared/ipc.ts` (brouillon, `CliDefinition.orchestrator`), `src/renderer/launch/QuickLaunch.tsx` et `src/renderer/launch/DetailedLaunch.tsx`.

**Checkpoint**: un orchestrateur se lance avec son plugin et son accès ; `npm run check` vert.

---

## Phase 3: User Story 1 - Lancer un orchestrateur qui dirige les autres agents (Priority: P1) 🎯 MVP

**Goal**: disposition « chef au centre », `list_agents` et `send_prompt`, marque sur les tuiles.

**Independent Test**: un faux orchestrateur et deux agents ; deux consignes envoyées par
l'orchestrateur arrivent dans les deux invites, seulement quand les agents sont prêts, avec la marque.

### Tests for User Story 1 ⚠️

- [ ] T017 [P] [US1] Tests des outils `list_agents` et `send_prompt` dans `tests/integration/orchestrator/tools-prompt.test.ts` :
  - liste sans l'orchestrateur ni les terminaux libres, avec `question` et `toReview` ;
  - un agent désigné par son nom (« Codex 2 », casse ignorée) ou son identifiant ; un nom ambigu ou inconnu est refusé (`isError`) ;
  - une consigne attend la fin d'une question (`awaiting-answer`) et passe une par tour ;
  - un agent fermé, en erreur, l'orchestrateur lui-même ou un agent d'un autre workspace est refusé avec sa raison ;
  - `text` de 1 à 8 000 caractères ;
  - `orchestrator:prompted` est émis à la frappe.
- [ ] T018 [P] [US1] Tests de la file à origine dans `tests/integration/agents/agent-actions.test.ts` : une consigne d'origine `orchestrator` et une de `review` passent dans l'ordre ; `cancelPrompts(id, 'orchestrator')` ne retire que les premières.
- [ ] T019 [P] [US1] Tests de la grille dans `tests/unit/renderer/tiles/TileGrid.test.tsx` et `tests/unit/renderer/tiles/Tile.test.tsx` :
  - tuile principale en haut au centre, marquée « ◎ Orchestrateur » ;
  - les autres en dessous dans l'ordre des positions ;
  - sans orchestrateur, la grille du socle ;
  - marque « ◎ de l'orchestrateur » sur une tuile, retirée au retour à un état prêt.
- [ ] T020 [US1] Test e2e « chef au centre » et deux consignes reçues par le faux CLI, dans `tests/e2e/us13-orchestrator.spec.ts`.

### Implementation for User Story 1

- [ ] T021 [P] [US1] Ajouter l'origine des consignes et `cancelPrompts` dans `src/main/agents/agent-manager.ts`, avec un rappel `onPromptTyped`.
- [ ] T022 [US1] Implémenter `list_agents` et `send_prompt` dans `src/main/orchestrator/tools.ts`, servis par `OrchestratorService` via `HookServer`.
- [ ] T023 [US1] Ajouter l'événement `orchestrator:prompted` dans `src/shared/ipc.ts` et `src/main/index.ts`, puis la marque dans `src/renderer/store/app-store.ts` et `src/renderer/tiles/Tile.tsx`.
- [ ] T024 [US1] Ajouter la tuile principale à `src/renderer/tiles/TileGrid.tsx` et la placer depuis `src/renderer/workspace/WorkspaceView.tsx`.

**Checkpoint**: MVP — un orchestrateur répartit des consignes ; `npm run check` vert.

---

## Phase 4: User Story 2 - Suivre le travail des agents sans intervenir (Priority: P1)

**Goal**: `get_changes`, `get_file_diff`, `run_tests`, `wait_for_agents`.

**Independent Test**: un agent fait des changements ; l'orchestrateur en attente est réveillé à la
fin de son tour et lit les mêmes fichiers, diff, tests et conflits que la revue.

### Tests for User Story 2 ⚠️

- [ ] T025 [P] [US2] Tests de la file d'événements et de l'attente dans `tests/unit/main/orchestrator/events.test.ts` :
  - au plus 100 événements, les plus anciens oubliés ;
  - une attente se termine au premier événement des agents demandés ;
  - délai écoulé : `timedOut: true` ;
  - `timeoutSeconds` de 1 à 600, défaut 300 ;
  - une seconde attente remplace la première, qui rend « remplacée » ;
  - les événements arrivés entre deux attentes sont rendus tout de suite.
- [ ] T026 [P] [US2] Tests des outils de lecture dans `tests/integration/orchestrator/tools-read.test.ts` :
  - `get_changes` donne les mêmes fichiers, totaux, tests et conflits que `ReviewService` ;
  - `get_file_diff` donne le diff unifié, ou `binary` / `tooLarge` avec la taille ;
  - un chemin hors du dépôt est refusé ;
  - `run_tests` lance la commande du workspace ou refuse « Tests non configurés » ;
  - `wait_for_agents` est réveillé en moins de 2 s après une fin de tour (SC-002).
- [ ] T027 [US2] Test e2e : attente réveillée par la fin de tour d'un agent, puis lecture de ses changements par le faux orchestrateur, dans `tests/e2e/us14-orchestrator-follow.spec.ts`.

### Implementation for User Story 2

- [ ] T028 [P] [US2] Implémenter la file d'événements et l'attente dans `src/main/orchestrator/events.ts`.
- [ ] T029 [US2] Implémenter `get_changes`, `get_file_diff`, `run_tests` et `wait_for_agents` dans `src/main/orchestrator/tools.ts`, avec les événements des états d'agents transmis par `src/main/index.ts`.

**Checkpoint**: US1 + US2, la boucle consigne → attente → lecture.

---

## Phase 5: User Story 3 - Faire intégrer le travail d'un agent, avec l'accord de l'utilisateur (Priority: P2)

**Goal**: `request_integration`, demandes dans À faire, confirmation, issue rendue à l'orchestrateur.

**Independent Test**: la demande ne change pas la branche principale ; après confirmation, le
commit y est et l'orchestrateur reçoit l'événement `integrated`.

### Tests for User Story 3 ⚠️

- [ ] T030 [P] [US3] Tests des demandes dans `tests/integration/orchestrator/integration-requests.test.ts` :
  - `request_integration` enregistre une demande persistée, branche principale inchangée ;
  - une nouvelle demande pour le même agent remplace l'ancienne ;
  - `integrationRequest:confirm` intègre via `IntegrationService` et produit l'événement `integrated` avec le commit ;
  - `refuse` produit `refused` sans rien intégrer ;
  - un conflit produit `conflicted` avec les fichiers ;
  - un échec produit `failed` avec l'erreur ;
  - la fermeture de l'agent retire sa demande ;
  - les demandes reviennent après un redémarrage.
- [ ] T031 [P] [US3] Tests d'À faire dans `tests/unit/shared/todo.test.ts` et `tests/unit/renderer/todo/TodoItem.test.tsx` :
  - élément « ◎ Intégrer <agent> → <main> ? » avec le message, placé après les réponses et avant les revues ;
  - « ✓ Intégrer » (message modifiable), « Refuser », « Revue → ».
- [ ] T032 [P] [US3] Tests des canaux `integrationRequest:confirm` et `integrationRequest:refuse` dans `tests/unit/main/ipc/orchestrator-handlers.test.ts`.
- [ ] T033 [US3] Test e2e : demande dans À faire, branche principale inchangée, confirmation, commit, puis événement `integrated` reçu par l'attente du faux orchestrateur, dans `tests/e2e/us15-orchestrator-integrate.spec.ts`.

### Implementation for User Story 3

- [ ] T034 [US3] Implémenter `request_integration`, les demandes persistées et leur issue dans `src/main/orchestrator/orchestrator-service.ts` et `src/main/orchestrator/tools.ts`.
- [ ] T035 [US3] Brancher `integrationRequest:confirm` et `integrationRequest:refuse`, et émettre `workspace:integrationRequests`, dans `src/main/ipc/orchestrator-handlers.ts`, `src/shared/ipc.ts` et `src/main/index.ts`.
- [ ] T036 [US3] Ajouter l'élément `integration-request` dans `src/shared/todo.ts` et `src/renderer/todo/TodoItem.tsx`, et ses actions dans `src/renderer/store/app-store.ts` et `src/renderer/app/App.tsx`.

**Checkpoint**: US1–US3.

---

## Phase 6: User Story 4 - Lancer et fermer des agents depuis l'orchestrateur (Priority: P3)

**Goal**: `launch_agent`, `close_agent`.

**Independent Test**: un agent lancé par l'orchestrateur a sa tuile, son worktree et sa branche ;
fermé, la tuile disparaît et le worktree et la branche restent.

### Tests for User Story 4 ⚠️

- [ ] T037 [P] [US4] Tests de `launch_agent` et `close_agent` dans `tests/integration/orchestrator/tools-agents.test.ts` :
  - même refus que le lanceur (limite de 6, CLI absent, branche existante) ;
  - niveau d'autorisation de `PermissionService.resolve`, refus « Choisissez d'abord les autorisations dans PACT » sans niveau ;
  - consigne initiale ;
  - fermeture sans suppression du worktree ni de la branche ;
  - l'orchestrateur ne peut pas se fermer lui-même.
- [ ] T038 [US4] Test e2e : lancement et fermeture d'un agent par le faux orchestrateur, worktree conservé, dans `tests/e2e/us16-orchestrator-agents.spec.ts`.

### Implementation for User Story 4

- [ ] T039 [US4] Implémenter `launch_agent` et `close_agent` dans `src/main/orchestrator/tools.ts`.

**Checkpoint**: US1–US4.

---

## Phase 7: User Story 5 - Garder la main sur l'orchestrateur (Priority: P3)

**Goal**: journal « ◎ Actions », « Retirer le rôle d'orchestrateur ».

**Independent Test**: le journal liste les actions ; après retrait, toute demande est refusée et la
grille du socle revient.

### Tests for User Story 5 ⚠️

- [ ] T040 [P] [US5] Tests du journal et du retrait dans `tests/integration/orchestrator/orchestrator-service.test.ts` :
  - chaque outil d'action ajoute une entrée, la plus récente en premier, au plus 200 ;
  - lectures et attentes absentes ;
  - après `orchestrator:revoke` : jeton refusé (`401`), consignes d'origine `orchestrator` retirées, attente en cours terminée, `role: null`.
- [ ] T041 [P] [US5] Tests du Focus dans `tests/unit/renderer/focus/FocusView.test.tsx` : onglet « ◎ Actions » pour l'orchestrateur seulement ; « Retirer le rôle d'orchestrateur » demande confirmation.
- [ ] T042 [US5] Test e2e : journal, retrait du rôle, retour à la grille, refus suivant reçu par le faux orchestrateur, dans `tests/e2e/us17-orchestrator-control.spec.ts`.

### Implementation for User Story 5

- [ ] T043 [US5] Implémenter le journal et `revoke` dans `src/main/orchestrator/orchestrator-service.ts`, et les canaux `orchestrator:actions`, `orchestrator:revoke` et `orchestrator:action` dans `src/main/ipc/orchestrator-handlers.ts` et `src/shared/ipc.ts`.
- [ ] T044 [US5] Ajouter l'onglet « ◎ Actions » et « Retirer le rôle » dans `src/renderer/focus/FocusView.tsx`, avec l'état dans `src/renderer/store/app-store.ts`.

**Checkpoint**: toutes les stories testées séparément.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T045 [P] Test e2e chemins avec espaces et accents pour les outils de lecture et l'intégration demandée (FR-023), dans `tests/e2e/paths.spec.ts`.
- [ ] T046 [P] Mettre à jour `README.md` : orchestrateur, outils, sécurité de l'accès, confirmation des intégrations.
- [ ] T047 Caractériser sur un vrai Claude Code (comme T049 de 001) :
  - découverte du skill en session interactive ;
  - `MCP_TOOL_TIMEOUT` pour une attente de plus de 60 s (R5) ;
  - absence de demande d'autorisation pour les outils PACT.
  Aligner `ClaudeCodeAdapter` sur le résultat et consigner dans la PR.
- [ ] T048 Dérouler `specs/003-orchestrator/quickstart.md` (automatisé + validation manuelle) sur macOS et Windows, et consigner les résultats dans la PR.

---

## Dependencies & Execution Order

- **Setup (Phase 1)** : aucune dépendance.
- **Foundational (Phase 2)** : après Setup ; bloque toutes les stories.
- **US1 (Phase 3)** : après Foundational ; c'est le MVP.
- **US2 (Phase 4)** : après Foundational ; `wait_for_agents` utilise les événements, indépendants de US1 (l'e2e utilise `send_prompt` de US1).
- **US3 (Phase 5)** : après US2 (l'issue d'une intégration arrive comme événement).
- **US4 (Phase 6)** : après Foundational.
- **US5 (Phase 7)** : après US1 (le retrait annule les consignes d'origine `orchestrator`).
- **Polish (Phase 8)** : après les stories voulues.

Dans chaque story : tests (Red) → services du main → outils → IPC → renderer → e2e vert.

## Parallel Opportunities

- Phase 1 : T001, T002 et T003 en parallèle.
- Phase 2 : T004 à T010 en parallèle, puis T011, T013 en parallèle ; T012 après T011 ; T014 et T015 après T012 et T013 ; T016 après T015.
- US1 : T017, T018 et T019 en parallèle ; T021 dès T018.
- US2 : T025 et T026 en parallèle ; T028 dès T025.
- US3 : T030, T031 et T032 en parallèle.
- US4 et US5 en parallèle une fois US1 faite.

## Implementation Strategy

- **MVP** : Phases 1–3 (un orchestrateur répartit des consignes, chef au centre).
- **Ensuite** : US2 (boucle complète consigne → attente → lecture), puis US3 (intégration
  confirmée), puis US4 et US5.
- Une PR par phase ou par story, comme pour 002, chacune verte en CI sur macOS et Windows.
