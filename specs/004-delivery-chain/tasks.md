---
description: "Task list for 004 — Chaîne de livraison"
---

# Tasks: Chaîne de livraison

**Input**: Design documents from `/specs/004-delivery-chain/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md ; 003
fusionné (serveur MCP, jetons, `IntegrationRequests`, `launch_agent`/`close_agent`).

**Tests**: obligatoires (constitution I) : dans chaque story, les tests sont écrits et commités rouges
avant le code. Une PR par phase, fusionnée quand `check`, `e2e` (macOS, Windows) et `coverage-guard`
sont verts.

**Format**: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T001 Ajouter la dépendance `marked` (version exacte, sans dépendance transitive) dans `package.json` ; vérifier `npm ls marked`.
- [X] T002 [P] Créer `resources/skills/` (vide sauf `README.md` qui renvoie à contracts/skills.md) et l'ajouter aux `extraResources` du build comme le pont de hooks, dans `electron-builder.config.*` ; test de configuration dans `tests/unit/scripts/release-config.test.ts`.
- [X] T003 [P] Étendre le faux CLI `tests/fixtures/fake-cli/fake-cli.mjs` : étapes `report` (appelle `submit_report` avec `PACT_AGENT_MCP_TOKEN` (jamais le jeton des hooks) et l'URL `PACT_AGENT_MCP_URL`), `writeTests` / `writeProd` (fichiers sous `tests/` ou `src/`), `mockup` (écrit `design/mockups/<nom>.html`) ; documenter dans l'en-tête du fichier.

---

## Phase 2: Foundational (bloque toutes les stories)

- [X] T004 Tests rouges des schémas dans `tests/unit/shared/model.test.ts` : un fichier de workspace de 003 se lit sans migration avec `roleProfiles: {}`, `issues: []`, `loops: []`, `publishRequests: []`, `testPaths` par défaut `['**/*.test.*', '**/*.spec.*', 'tests/**', 'test/**', '**/__tests__/**']` ; `Agent.role` ∈ `'orchestrator' | 'spec' | 'design' | 'dev' | 'test' | 'recap' | null` (défaut `null`) ; `Agent.effort` ∈ `'low' | 'medium' | 'high' | 'xhigh' | 'max' | null` ; brouillon avec `orchestrator: true` vaut `role: 'orchestrator'`.
- [X] T005 Étendre `src/shared/model.ts` et `src/shared/ipc.ts` (brouillon `role`, `effort`) selon data-model.md : `RoleProfile { cliId, model: string | null, effort, maxModel: string | null, escalate: boolean (défaut false) }`, `Issue`, `Loop`, `Round`, `PublishRequest` ; `round` 1…3 ; `issueIds` 1 à 20.
- [X] T006 [P] Tests rouges puis `src/shared/report.ts` : schéma zod du rapport de relais (contracts/handoff-report.md), liste des champs manquants en français ; tests dans `tests/unit/shared/report.test.ts`.
- [X] T007 Jeton d'agent (R5) : tests rouges dans `tests/integration/orchestrator/agent-token.test.ts` (un agent avec rôle autre qu'orchestrateur reçoit un jeton qui n'ouvre que `submit_report` ; tout autre outil → `isError` « Outil réservé à l'orchestrateur » ; jeton révoqué à la fermeture), puis implémentation dans `src/main/orchestrator/orchestrator-service.ts` et `src/main/agents/agent-manager.ts`.

**Checkpoint**: schémas et jeton d'agent prêts ; 001–003 inchangés (suite complète verte).

---

## Phase 3: User Story 1 — Lancer des agents par rôle, avec le bon modèle (P1) 🎯 MVP

**Goal**: rôles, profils de modèles, `--effort`, `launch_agent` par rôle, rôle visible, tuile du chef
toujours la plus grande (FR-001…FR-006a).

**Independent Test**: lancer un dev et un test depuis le lanceur et depuis l'orchestrateur ; vérifier
modèle, effort, rôle affiché, avertissement test < dev, et la grille.

### Tests (rouges d'abord)

- [X] T008 [P] [US1] `tests/unit/shared/roles.test.ts` : profils par défaut (orchestrateur, spec, design = palier fort ; dev = moyen ; test ≥ dev ; recap = petit), premier CLI installé qui a des paliers sinon premier installé avec modèles `null`, plafond `maxModel`, avertissement si `palier(test.model) < palier(dev.model)`.
- [X] T009 [P] [US1] Contrats d'adaptateur `tests/contract/claude-code.contract.test.ts` et `tests/contract/codex.contract.test.ts` : `modelTiers()`, `--effort <e>` pour Claude Code, `-c model_reasoning_effort=<e>` pour Codex, rien pour le générique.
- [X] T010 [P] [US1] `tests/integration/orchestrator/tools-roles.test.ts` : `launch_agent { role }` prend CLI, modèle et effort du profil ; profil vers un CLI désinstallé → refus « Le CLI « X » du rôle <rôle> n’est pas installé. » ; `model` au-delà de `maxModel` refusé avec « Modèle au-delà du plafond du rôle <rôle> (<maxModel>) » ; `list_agents` renvoie `role` et `loop`.
- [X] T011 [P] [US1] Renderer : `tests/unit/renderer/settings/RoleProfiles.test.tsx` (édition, avertissement non bloquant, CLI désinstallé signalé avec « Revenir au profil par défaut »), `tests/unit/renderer/launch/*.test.tsx` (choix du rôle pré-remplit CLI/modèle/effort), `tests/unit/renderer/tiles/TileGrid.test.tsx` (FR-006a : chef sur toute la largeur, 3/5 de la hauteur ; les autres en 2/5 ; sans chef, grille de 001 inchangée), `Tile.test.tsx` (rôle affiché).
- [X] T012 [US1] e2e `tests/e2e/us18-roles.spec.ts` : régler les profils, lancer un orchestrateur, un dev et un test ; rôles sur les tuiles, chef le plus grand.

### Implementation

- [X] T013 [US1] `src/shared/roles.ts` (pur) : profils par défaut, paliers, plafond, avertissement.
- [X] T014 [US1] Adaptateurs : `modelTiers()` et `supportsEffort` dans `src/main/agents/adapters/types.ts`, `claude-code.ts`, `codex.ts`, `generic.ts`, `fake.ts` ; `LaunchInput.role` et `effort`.
- [X] T015 [US1] `AgentManager` : rôle et effort au lancement, profil du rôle quand le brouillon laisse `null`, dans `src/main/agents/agent-manager.ts`.
- [X] T016 [US1] IPC `roles:setProfiles` → `{ warnings }` dans `src/main/ipc/orchestrator-handlers.ts` et `src/shared/ipc.ts` ; `app:getState` expose `modelTiers` et `supportsEffort`.
- [X] T017 [US1] `launch_agent` étendu et `list_agents` (rôle, boucle) dans `src/main/orchestrator/tools.ts`.
- [X] T018 [US1] Renderer : `src/renderer/settings/RoleProfiles.tsx`, choix du rôle dans `src/renderer/launch/`, rôle sur `src/renderer/tiles/Tile.tsx` et dans le Focus, règle de grille dans `src/renderer/tiles/TileGrid.tsx` (suppression du `max-w-[1100px]` du chef), store `src/renderer/store/app-store.ts`.

**Checkpoint**: US1 livrable seule (PR « 004 Phase 3 »).

---

## Phase 4: User Story 2 — Boucle dev ↔ test plafonnée, prouvée par les tests (P1)

**Goal**: rapports de relais, boucle de 3 tours, preuve par un run PACT, testeur indépendant,
fichiers communs, escalade (FR-007, FR-015…FR-022).

**Independent Test**: faux CLI test qui rend `defects` trois fois → pas de 4ᵉ tour, À faire propose
Relancer / Reprendre la main / Abandonner ; faux CLI qui réussit au 2ᵉ tour → issue faite seulement
après un run PACT à 0 sur le tree courant.

### Tests (rouges d'abord)

- [X] T019 [P] [US2] `tests/unit/main/orchestrator/loop-service.test.ts` : transitions `ready → in-progress → done | escalated`, refus d'un 4ᵉ tour (« Plafond de 3 tours atteint : l'utilisateur décide »), `escalated → in-progress` (Relancer 3 tours), `→ abandoned`, « Reprendre la main » clôt la boucle ; preuve `{ tree, exitCode, at }` exigée pour `done` (même tree que le courant) ; verdict rejeté si `testerTouched` non vide (FR-020, motifs `testPaths`) ; escalade au tour 3 vers `maxModel` quand `escalate` (FR-007) ; une question à l'utilisateur pendant le tour ne consomme pas de tour ; retrait du rôle d'orchestrateur → boucles `closed`, agents ouverts ; trace de l'issue (FR-024) : `branch` et `agents` remplis au `start_loop`.
- [X] T020 [P] [US2] (couvert dans `tests/integration/orchestrator/loops.test.ts`) `tests/integration/orchestrator/reports.test.ts` : `submit_report` valide → événement `report` dans `wait_for_agents` et `orchestrator:report` ; invalide → refus avec champs manquants ; fin de tour sans rapport → `report-missing`.
- [X] T021 [P] [US2] `tests/integration/orchestrator/loops.test.ts` (vrais dépôts) : `start_loop` refusé si issue non `ready` ou rôles faux ; `next_round` ; preuve par `TestRunner` ; événement `overlap` quand deux agents modifient le même chemin (`ReviewService.readChanges`) ; rapport validé reçu par l'orchestrateur en moins de 1 s. *(`overlap` : `tests/integration/review/review-service.test.ts`)*
- [X] T022 [P] [US2] Renderer : `tests/unit/shared/todo.test.ts` (`loop-escalated` « ✕ Boucle arrêtée · <issue> · 3 tours », `overlap` « ⚠ Fichiers communs · <agents> », ordre après les demandes d'intégration et avant les revues), `TodoItem.test.tsx`, tuile « tour N/3 », bande « Rapports » du chef.
- [X] T023 [US2] e2e `tests/e2e/us19-loop.spec.ts` : boucle qui échoue 3 fois, puis décision de l'utilisateur ; boucle réussie au 2ᵉ tour.

### Implementation

- [X] T024 [US2] `src/main/orchestrator/loop-service.ts` (boucles, tours, rapports, preuve, testeur indépendant, escalade), injecté dans `src/main/index.ts`.
- [X] T025 [US2] Outils `submit_report`, `start_loop`, `next_round`, `get_loop` dans `src/main/orchestrator/tools.ts` ; événements `report`, `report-missing`, `loop`, `overlap` dans `src/main/orchestrator/orchestrator-service.ts` et `src/shared/orchestrator.ts`.
- [X] T026 [US2] Recoupement des chemins entre agents dans `src/main/review/review-service.ts`.
- [X] T027 [US2] IPC `loop:decide`, événement `orchestrator:report` ; À faire (`src/shared/todo.ts`, `src/renderer/todo/TodoItem.tsx`), tuile et bande « Rapports » (`src/renderer/tiles/`), onglet « ◎ Rapports » du Focus (`src/renderer/focus/ReportsTab.tsx`).

**Checkpoint**: US1 + US2 = MVP de la chaîne.

---

## Phase 5: User Story 3 — Cadrer : de la demande aux issues prêtes (P2)

**Goal**: issues locales `.pact/issues/*.md`, Definition of Ready, publication confirmée (FR-022…FR-024).

**Independent Test**: un faux agent spec écrit deux issues, l'une complète, l'autre avec une question ;
`register_issue` → `ready` et `proposed` ; `publish_issues` → À faire « ◎ Créer N issues ? », rien
publié avant confirmation.

- [ ] T028 [P] [US3] Tests rouges `tests/integration/orchestrator/issues.test.ts` : `register_issue { path }` relatif à `.pact/issues/` (chemin hors du dossier refusé), `id` = nom sans `.md`, `title` = premier `# `, `ready` si critères Given/When/Then et aucune question ouverte sinon `proposed` avec ce qui manque ; `list_issues` ; `publish_issues` refusé sans dépôt distant ou sans `gh` connecté, sinon demande (une seule par workspace, la nouvelle remplace) ; confirmation → `gh issue create` (commande simulée), `remote { number, url }`, événement `publish` ; trace (FR-024) : `pr` renseigné quand l'intégration de la branche ouvre une PR ; refus → `publish` `refused`.
- [ ] T029 [P] [US3] Tests renderer : `publish-issues` « ◎ Créer N issues ? » avec les titres, Créer / Refuser, dans `tests/unit/shared/todo.test.ts` et `TodoItem.test.tsx`.
- [ ] T030 [US3] e2e `tests/e2e/us20-issues.spec.ts`.
- [ ] T031 [US3] Implémenter `register_issue`, `list_issues`, `publish_issues` (`src/main/orchestrator/tools.ts`, service `src/main/orchestrator/issues.ts`), IPC `publishRequest:confirm` / `refuse`, À faire.

---

## Phase 6: User Story 4 — Design system et maquettes validées avant le code (P2)

**Goal**: onglet Aperçu isolé (`pact-preview:`), décision sur maquette transmise à l'orchestrateur
(FR-025…FR-028).

**Independent Test**: un faux agent design écrit `design/mockups/a.html` qui charge une image distante ;
l'Aperçu l'affiche sans requête réseau et signale le blocage ; « ✓ Valider » arrive à l'orchestrateur
en moins de 1 s.

- [ ] T032 [P] [US4] Tests rouges `tests/integration/preview/preview-protocol.test.ts` : ne sert que les fichiers du worktree de l'agent (`..` et liens hors worktree refusés), CSP stricte, toute requête réseau bloquée et signalée (`preview:blocked`), rendu Markdown via `marked` sans HTML brut exécutable.
- [ ] T033 [P] [US4] Tests renderer `tests/unit/renderer/focus/PreviewTab.test.tsx` : liste (`mockup`, `recap`, `issue`, `other`), iframe `sandbox` sans `allow-same-origin`, rafraîchissement sur `preview:changed` en gardant le défilement, Valider / Refuser avec commentaire ; « ressource externe bloquée » sur `preview:blocked` ; fichier trop gros ou invalide → texte brut.
- [ ] T034 [US4] e2e `tests/e2e/us21-preview.spec.ts` : décision sur maquette reçue par l'orchestrateur en moins de 1 s (SC-004), Aperçu rafraîchi en moins de 2 s.
- [ ] T035 [US4] `src/main/preview/preview-protocol.ts`, suivi des fichiers (réutiliser le suivi du worktree de 002), IPC `preview:list`, `preview:decide`, événements `preview:changed`, `preview:blocked`, événement orchestrateur `mockup`.
- [ ] T036 [US4] `src/renderer/focus/PreviewTab.tsx` (l'onglet grisé de 001 devient actif) et store.

---

## Phase 7: User Story 5 — Recap (P2)

**Goal**: `.pact/recap.md` tenu par le skill recap, affiché dans l'Aperçu du chef (FR-029, FR-030).

- [ ] T037 [P] [US5] Tests rouges : l'Aperçu du chef liste `.pact/recap.md` en premier (`tests/unit/renderer/focus/PreviewTab.test.tsx`) ; format de files.md vérifié par `tests/unit/main/orchestrator/recap-format.test.ts` sur un exemple.
- [ ] T038 [US5] e2e `tests/e2e/us22-recap.spec.ts` : un faux agent recap écrit le recap, il s'affiche et se rafraîchit.
- [ ] T039 [US5] Implémenter le classement du recap dans `src/main/preview/` et l'affichage dans le Focus du chef.

---

## Phase 8: User Story 6 — Les mêmes skills, quel que soit le CLI (P3)

**Goal**: suite de skills et livraison par CLI sans toucher à la configuration personnelle
(FR-008…FR-014, FR-031).

- [ ] T040 [US6] Après T041 (rouge), rédiger la suite dans `resources/skills/` : `pact-contract.md`, `pact-orchestrator`, `pact-spec`, `pact-design-system`, `pact-mockup`, `pact-dev`, `pact-test`, `pact-recap` (`SKILL.md` avec front matter `name`, `description`), contenu exigé par contracts/skills.md ; renvois spec-kit quand `.specify/` existe (FR-010).
- [ ] T041 [P] [US6] Tests rouges `tests/unit/main/orchestrator/skills-content.test.ts` : chaque skill contient les règles exigées (contracts/skills.md, colonne « Doit dire »).
- [ ] T042 [P] [US6] Tests rouges `tests/unit/main/orchestrator/role-skills.test.ts` et `tests/integration/orchestrator/skills-delivery.test.ts` : copie dans `userData/roles/<agentId>/`, le rôle `design` reçoit `pact-design-system` et `pact-mockup`, chaque agent ne reçoit que ses skills et le contrat ; Claude Code `--plugin-dir` ; Codex `-c developer_instructions=…`, `-c mcp_servers.pact.url=…`, `env_http_headers` ; générique `.pact/ROLE.md` + `/.pact/ROLE.md` dans `.git/info/exclude`, `git status` propre ; tout retiré à la fermeture ; rien écrit dans `~/.claude` ni `~/.codex` (HOME temporaire comparé avant/après).
- [ ] T043 [P] [US6] Contrat Codex orchestrateur (R4) dans `tests/contract/codex.contract.test.ts` ; option « Orchestrateur » proposée pour Codex (FR-031) dans `tests/unit/renderer/launch/`.
- [ ] T044 [US6] e2e `tests/e2e/us23-skills.spec.ts` : un agent générique reçoit `.pact/ROLE.md` et la consigne de le lire.
- [ ] T045 [US6] `src/main/orchestrator/role-skills.ts`, plugin généralisé dans `src/main/orchestrator/plugin.ts` (le skill d'orchestrateur de 003 devient `pact-orchestrator`), voies dans les adaptateurs, `supportsOrchestrator` de Codex.

---

## Phase 9: Polish & Cross-Cutting

- [ ] T046 [P] Mettre à jour `README.md` et `specs/004-delivery-chain/quickstart.md` avec ce qui a été livré.
- [ ] T047 [P] Test e2e chemins avec espaces et accents (FR-032) pour les skills, les maquettes et le recap dans `tests/e2e/paths.spec.ts` ; vérifier SC-007 sur la suite : aucun test n'écrit dans `~/.claude` ni `~/.codex` (garde globale dans `tests/setup`).
- [ ] T048 Caractérisation sur vrais CLI (utilisateur) : `--effort` de Claude Code, `developer_instructions` et orchestrateur sous Codex (R2–R4) ; consigner dans research.md.

---

## Dependencies & Execution Order

- Setup (T001–T003) → Foundational (T004–T007) → stories.
- US1 (Phase 3) : après Foundational ; MVP.
- US2 (Phase 4) : après US1 (rôles `dev`/`test`, `launch_agent` par rôle).
- US3 (Phase 5) : après Foundational ; `start_loop` (US2) consomme `ready` mais US3 se teste seule.
- US4 (Phase 6) : après Foundational ; indépendante.
- US5 (Phase 7) : après US4 (Aperçu).
- US6 (Phase 8) : après US1 (rôles) ; les skills peuvent être rédigés (T040) dès le Setup.
- Dans chaque story : tests rouges commités, puis implémentation, puis commit vert conditionné par
  `npm run check && npm run test:e2e`.

## Parallel Opportunities

- T002, T003 ; T006 à côté de T004/T005.
- US1 : T008, T009, T010, T011 en parallèle.
- US2 : T019, T020, T021, T022 en parallèle.
- US3 et US4 en parallèle après US1 (fichiers distincts : `issues.ts` / `preview/`).
- T040 (rédaction des skills) en parallèle de toute la Phase 3.

## Implementation Strategy

1. MVP : Setup + Foundational + US1 → PR, merge.
2. US2 → chaîne dev ↔ test prouvée → PR, merge.
3. US3, US4 (parallélisables), puis US5 → PR par phase.
4. US6 (livraison des skills sur tous les CLI) → PR.
5. Polish ; T048 laissé à l'utilisateur.
