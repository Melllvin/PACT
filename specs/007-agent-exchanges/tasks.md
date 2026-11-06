# Tasks: Échanges entre agents et réveil

**Input**: Design documents from `/specs/007-agent-exchanges/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: obligatoires (constitution I) : chaque phase commence par ses tests rouges, commités avant le code.

**Livraison**: une PR par phase (Phases 1 et 2 ensemble), branche `007-phase-N-…` depuis `007-agent-exchanges` ; chaque commit dans une chaîne `&&` gardée par `npm run check` et `npm run test:e2e`. Fusion quand converge et CI verte, sans `gh --auto`.

**Interdits**: aucun vrai CLI d'agent avec des touches simulées ; aucune commande brew ; aucune modification de la configuration de l'utilisateur ; aucun contenu écrit par un tiers lu, récupéré ou transmis.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [x] T001 Créer `007-agent-exchanges` depuis `origin/006-agents-view` (ou `origin/main` si 006 y est fusionnée) avec `specs/007-agent-exchanges/` et `.specify/feature.json`, puis lancer `npm ci`
- [ ] T002 Étendre `tests/fixtures/fake-cli/fake-cli.mjs` (R16) : ligne reconnue comme pointeur → avec `PACT_AGENT_MCP_URL` ou `PACT_ORCHESTRATOR_URL`, appel de `get_events`, puis `get_events({ id })` sur la première `instruction`, et tour joué avec ce texte ; sans MCP, lecture de `.pact/events.md` ; champ `agentMcp` (outils d'un agent de rôle, imprime `MCP <tool> : <texte>`) ; champ `toolHook` (poste `{ type: 'post-tool' }`, imprime `Contexte : <additionalContext>`) ; une réponse `{ decision: 'block', reason }` à son signal de fin imprime `Prolongé : <reason>` et joue un tour de plus

---

## Phase 2: Foundational (bloque toutes les stories)

**But** : le journal unique, sa lecture partagée, les rapports qui l'alimentent. `EventQueue` disparaît. Aucun réveil encore : l'orchestrateur lit par `get_events` et `wait_for_agents`.

### Tests (rouges d'abord)

- [ ] T003 [P] Tests dans `tests/unit/shared/exchanges.test.ts` : `exchangeMessageSchema` (bornes de data-model : « `message` 500, `instruction` 8000, autres 2000 »), `exchangesSchema` vide par défaut, `typeOf` pour chaque kind de R3 dont `overlap`, `canSend` pour chaque case de `contracts/mcp-tools.md` avec sa raison, `pointerText(1)`, `pointerText(3)`, `pointerText(2, '.pact/events.md')`, `isPointer`
- [ ] T004 [P] Tests dans `tests/unit/main/orchestrator/exchange-service.test.ts` : `record` persiste et émet ; `read` rend les 20 plus récents non lus, `summary` ≤ 200 caractères, `remaining`, et retire le lecteur de `unreadBy` ; second `read` sans le déjà-lu ; `detail(id)` selon le lecteur ; éviction à 500 (le plus ancien lu par tous d'abord) ; `wait` rend aussitôt ou au prochain message, 60 s au plus, une attente à la fois ; `decide` `resume` retire l'escalade, `cut` la garde ; un agent fermé sort de tous les `unreadBy` ; `cancelWait` rend `replaced: true` à l'attente en cours quand l'orchestrateur redémarre, comme `EventQueue.close`
- [ ] T005 [P] Tests dans `tests/unit/main/orchestrator/loop-service.test.ts` : rapport hors boucle notifié ; rapport `blocked` avec `questions`, en boucle ou hors boucle, notifié avec le kind `question` et le texte des questions ; `testRun` sans `outputTail` ni liste de fichiers dans le résumé (FR-025)
- [ ] T006 [P] Migrer `tests/unit/main/orchestrator/events.test.ts` et `tests/integration/orchestrator/orchestrator-service.test.ts` vers le journal : `push` écrit pour l'orchestrateur du workspace, jamais sur lui-même sauf `publish`, et le type vient de `typeOf` ; supprimer `events.test.ts` avec `events.ts`, sa couverture passant à `exchange-service.test.ts`, en écrivant cette justification dans la PR (constitution II)
- [ ] T007 [P] Tests dans `tests/integration/orchestrator/tools-read.test.ts` : `get_events` (format de `contracts/mcp-tools.md`, note sur les données rapportées) ; `wait_for_agents` plafonné à 60 s, 20 événements de 200 caractères, `remaining`, lecture partagée avec `get_events` (US5 sc.1 à 3, SC-008) ; `list_agents` rend `questions`
- [ ] T008 [P] Tests dans `tests/integration/agents/agent-manager.test.ts` et `tests/integration/orchestrator/tools-agents.test.ts` : `fetchOrigin` à `false` ou hors délai → départ du dernier `origin/<main>` et avertissement dans la réponse de `launch_agent` ; `fetch` réussi, sans remote, `baseBranch` explicite : aucun avertissement (US4 sc.5 à 7)
- [ ] T009 [P] Tests dans `tests/unit/shared/ipc.test.ts`, `tests/unit/main/ipc/orchestrator-handlers.test.ts` et `tests/contract/claude-code.contract.test.ts` : canaux de `contracts/ui.md`, handler `exchange:decide`, règle `allow` des outils PACT pour tout agent avec l'accès MCP (R15) ; dans `tests/unit/renderer/store/exchanges-store.test.ts`, le store suit `workspace:exchanges`

### Implémentation

- [x] T010 Créer `src/shared/exchanges.ts` selon data-model (constantes, schémas, `typeOf`, `canSend`, `pointerText`, `isPointer`) ; ajouter `exchanges` à `workspaceSchema`, `wakeNotice` à `agentSchema`, `exchange-escalated` et `wake-held` à `TodoKind` dans `src/shared/model.ts` ; les insérer dans `ORDER` de `src/shared/todo.ts` ; ajouter les canaux à `src/shared/ipc.ts` ; étendre le schéma d'événement dans `src/shared/orchestrator.ts`
- [x] T011 Créer `src/main/orchestrator/exchange-service.ts` : `record`, `read`, `detail`, `wait`, `decide`, éviction, émission `workspace:exchanges`, listener `onRecorded`, `cancelWait`, retrait d'un agent fermé
- [x] T012 Dans `src/main/orchestrator/orchestrator-service.ts` : `push`, `notice` et `wait` passent par `ExchangeService` ; retirer `Session.events` et supprimer `src/main/orchestrator/events.ts`
- [x] T013 Dans `src/main/orchestrator/loop-service.ts` : `report` notifie aussi hors boucle, `reportNotice` choisit `question` ou `report` ; ajouter `message` aux deps ; retirer `outputTail` de `testRun`
- [x] T014 Dans `src/main/orchestrator/agent-tools.ts` et `src/main/orchestrator/tools.ts` : outil `get_events` pour tous ; `wait_for_agents` branché sur le journal, `DEFAULT_WAIT_S` et `MAX_WAIT_S` à 60 ; `describe` lit les nouveaux kinds ; `list_agents` rend `questions` ; descriptions de `request_integration` et `publish_issues` sans `wait_for_agents` comme suite normale ; `launch_agent` rend l'avertissement du `fetch`
- [x] T015 Dans `src/main/agents/agent-manager.ts` : garder le résultat de `within(fetchOrigin)` et exposer `launchWarnings(agentId)`, lu une fois (R13)
- [x] T016 Dans `src/main/agents/adapters/claude-code.ts` : `permissions()` autorise `PACT_TOOLS` dès que l'agent a l'accès MCP ; mettre à jour le commentaire de `MCP_TOOL_TIMEOUT_MS`, ici et dans `src/main/agents/adapters/codex.ts`
- [x] T017 Dans `src/main/ipc/orchestrator-handlers.ts`, `src/main/index.ts` et `src/renderer/store/app-store.ts` : handler `exchange:decide`, instanciation de `ExchangeService` passée à `tools`, `agentTools`, `LoopService` et aux handlers ; le store suit `workspace:exchanges`

**Checkpoint** : `npm run check` et e2e verts, comportement du réveil inchangé ; PR « 007 Phase 1-2 ».

---

## Phase 3: User Story 1 — L'orchestrateur travaille sans attendre (P1) 🎯 MVP

**But** : un agent inactif reçoit un pointeur d'une ligne ; les consignes passent par `get_events`.

**Test indépendant** : faux orchestrateur et faux agent ; un rapport → pointeur tapé une fois, contenu rendu par `get_events`, aucun `wait_for_agents`.

### Tests (rouges d'abord)

- [ ] T018 [P] [US1] Tests dans `tests/unit/main/orchestrator/wake-service.test.ts`, avec horloge factice : un pointeur pour 3 `action` en 5 s, 5 s sans prolongation ; `info` rien ; `awaiting-answer`, `error`, `closed` rien, repris au changement d'état ; invite occupée → rien, `wakeNotice: 'input'` à 2 min, pointeur à l'invite vide ; 20 réveils par heure → retenu, un seul `wakeNotice: 'cap'`, reprise après l'heure ; niveau `critical` → retenu, reprise sous le seuil ; `urgent` passe outre (FR-017) ; `announced` vide après redémarrage → pointeur pour les non-lus ; événements lus par `get_events` avant la fin de la fenêtre → aucun pointeur ; passage de `awaiting-prompt` à `working` pendant la fenêtre → rien de tapé
- [ ] T019 [P] [US1] Tests dans `tests/integration/agents/send-prompt-submit.test.ts` et `tests/unit/main/agents/agent-state.test.ts` : `draft` (caractères, effacement, collage et séquences → inconnu, `\r`, `prompt-submitted`, frappes ignorées en `awaiting-answer`) ; `flushPrompt` retenu pour toute origine si l'invite est occupée ; pointeur non soumis → Entrée seule au réveil suivant ; `isPointer` ne remplit pas `initialPrompt`, la première `instruction` le fait
- [ ] T020 [P] [US1] Tests dans `tests/integration/orchestrator/tools-prompt.test.ts` : `send_prompt` et `prompt` de `launch_agent` enregistrent une `instruction` multi-ligne, restituée à l'identique par `get_events({ id })` sans emballage, et rien de son texte n'atteint le PTY (FR-015, FR-024, SC-004) ; agent sans MCP → `.pact/events.md` écrit et exclu de git
- [ ] T021 [P] [US1] Tests dans `tests/unit/shared/todo.test.ts` et `tests/unit/shared/agents-view.test.ts` : `wake-held` selon `wakeNotice`, titres de `contracts/ui.md`, sur la ligne de l'agent
- [ ] T022 [P] [US1] E2E dans `tests/e2e/us30-wake.spec.ts` avec `tests/fixtures/fake-cli/scenarios/orchestra-wake.json` : US1 sc.1 à 5, 7 et 9, SC-002 (moins de 10 s), journal présent et non-lus annoncés après redémarrage

### Implémentation

- [ ] T023 [US1] Créer `src/main/orchestrator/wake-service.ts` (R4 sans les hooks, R7) : `onRecorded`, fenêtre de 5 s, voies invite et fin de tour, `heldSince`, fenêtre glissante, coupure, minuterie de 30 s active seulement si un réveil est retenu, `urgent`
- [ ] T024 [US1] Dans `src/main/agents/agent-manager.ts` : suivi `draft` dans `typed` ; garde dans `flushPrompt` ; origine `wake` dans `sendPrompt`, Entrée seule si pointeur bloqué (R6) ; `promptState(id)` ; `setWakeNotice` et événement `agent:wakeNotice`
- [ ] T025 [US1] Dans `src/main/agents/agent-state.ts` : `isPointer` n'alimente pas `initialPrompt`
- [ ] T026 [US1] Dans `src/main/orchestrator/tools.ts` : `send_prompt` et `launch_agent` enregistrent une `instruction` et remplissent `initialPrompt` si vide ; origine `orchestrator` retirée de `sendPrompt`
- [ ] T027 [US1] Dans `src/main/orchestrator/wake-service.ts` et `src/main/agents/agent-manager.ts` : fichier `.pact/events.md` pour agent sans rôle ou CLI `generic`, `git.exclude`, marqué lu à l'écriture du pointeur (R11)
- [ ] T028 [US1] Dans `src/shared/todo.ts`, `src/shared/agents-view.ts`, `src/renderer/todo/TodoItem.tsx` et `src/renderer/store/app-store.ts` : élément `wake-held`, `ROW_KINDS`, suivi de `agent:wakeNotice`
- [ ] T029 [US1] Dans `src/main/index.ts` : créer `WakeService`, le brancher sur `ExchangeService.onRecorded`, l'état des agents, `UsageService` et `AgentManager` ; `AgentManager.setWake` donne au handler de hooks la référence dont T039 a besoin, pour que la Phase 4 ne touche pas `src/main/index.ts`
- [ ] T030 [US1] Adapter les tests et scénarios e2e existants qui attendaient le texte dans l'invite (`tests/e2e/us13` à `us19`, `tests/integration/orchestrator/tools-prompt.test.ts`) : même attendu par la lecture du pointeur du faux CLI, sans `skip` ni suppression

**Checkpoint** : US1 utilisable seule ; PR « 007 Phase 3 US1 ».

---

## Phase 4: User Story 2 — Un agent en plein tour reçoit l'événement (P1)

**But** : pointeur par PostToolUse et Stop chez Claude Code, à la fin du tour ailleurs.

**Test indépendant** : faux CLI à hooks → pointeur dans la réponse du hook ; `FAKE_CLI_NO_WAKE_HOOK=1` → pointeur tapé en fin de tour.

### Tests (rouges d'abord)

- [ ] T031 [P] [US2] Tests dans `tests/contract/cli-adapter.contract.ts`, `tests/contract/claude-code.contract.test.ts`, `tests/contract/codex.contract.test.ts`, `tests/contract/generic.contract.test.ts` et `tests/contract/fake.contract.test.ts` : `midTurnWake`, `isWakePoint` (`null` si `agent_id`, US2 sc.4), `wakeReply` aux formats exacts de `contracts/hooks.md`, `PostToolUse` présent dans `settings`, et `mapHookEvent` rend `null` pour lui
- [ ] T032 [P] [US2] Tests dans `tests/unit/main/orchestrator/wake-hooks.test.ts` : `takeForHook('tool')` respecte la fenêtre, `takeForHook('stop')` la vide ; plafond et coupure ; rien si tout est annoncé (second Stop) ; un nouvel événement redonne un pointeur ; tour sans outil : Stop seul suffit
- [ ] T033 [P] [US2] Tests dans `tests/integration/agents/wake-hook.test.ts` : Stop avec pointeur → réponse `block`, état `working`, ni `turn-finished` ni `report-missing` (FR-018) ; Stop sans pointeur → comportement actuel ; aucune écriture dans le PTY sur la voie hook
- [ ] T034 [P] [US2] E2E dans `tests/e2e/us31-mid-turn-wake.spec.ts` avec `tests/fixtures/fake-cli/scenarios/orchestra-mid-turn.json` : US2 sc.1 à 3

### Implémentation

- [ ] T035 [US2] Dans `src/main/agents/adapters/types.ts`, `src/main/agents/adapters/codex.ts` et `src/main/agents/adapters/generic.ts` : `midTurnWake`, `isWakePoint`, `wakeReply` ; faux pour Codex et generic
- [ ] T036 [US2] Dans `src/main/agents/adapters/claude-code.ts` : hook `PostToolUse`, `isWakePoint`, `wakeReply` selon `research.md` R1
- [ ] T037 [US2] Dans `src/main/agents/adapters/fake.ts` : `post-tool`, `wakeReply`, `FAKE_CLI_NO_WAKE_HOOK`
- [ ] T038 [US2] Dans `src/main/orchestrator/wake-service.ts` : `takeForHook` ; la voie plein tour attend un hook si `midTurnWake`
- [ ] T039 [US2] Dans `src/main/agents/agent-manager.ts`, handler de `start` : réveil décidé avant `apply`, selon `contracts/hooks.md`

**Checkpoint** : US2 livrée ; PR « 007 Phase 4 US2 ».

---

## Phase 5: User Story 3 — Des échanges courts, typés et visibles (P1)

**But** : `ask_orchestrator`, `send_message`, journal visible, escalade, route des questions.

**Test indépendant** : deux faux agents s'écrivent → copie, journal, refus, escalade ; rapport `blocked` → orchestrateur, sans `◆ Décider`.

### Tests (rouges d'abord)

- [ ] T040 [P] [US3] Tests dans `tests/unit/main/orchestrator/exchange-rules.test.ts` : `send` applique `canSend` ; plus de 500 caractères refusé ; 6ᵉ message du tour refusé, compteur remis au tour suivant ; copie dans `unreadBy` sans réveil de l'orchestrateur ; 3 allers-retours sans commit → escalade nommant les agents et le dernier échange, messages de la paire refusés, autres échanges libres ; nouveau commit → compteur à zéro ; `resume` et `cut` ; destinataire fermé ou en erreur → journal et avertissement
- [ ] T041 [P] [US3] Tests dans `tests/unit/main/orchestrator/agent-tools.test.ts` et `tests/integration/orchestrator/agent-token.test.ts` : `ask_orchestrator` et `send_message` rendent aussitôt ; sans orchestrateur → refus ; testeur et dev selon la matrice (US3 sc.5, sc.11) ; aucun outil, orchestrateur compris, n'accorde une autorisation (FR-008, US3 sc.7)
- [ ] T042 [P] [US3] Tests dans `tests/unit/shared/todo.test.ts` : avec orchestrateur, `blocked` avec `questions` → pas de `decide` (FR-029, sc.13) ; orchestrateur en erreur → `decide` ; sans orchestrateur → `decide` identique à aujourd'hui (FR-030, sc.14) ; l'orchestrateur garde le sien ; `awaiting-answer` → `◆ Répondre` dans tous les cas (FR-031, sc.15) ; `exchange-escalated` selon data-model
- [ ] T043 [P] [US3] Tests dans `tests/unit/renderer/todo/TodoItem.test.tsx`, `tests/unit/renderer/focus/FocusView.test.tsx` et `tests/unit/main/notifications.test.ts` : boutons de l'escalade, texte d'agent rendu comme texte, journal fusionné et trié, notification de l'escalade ; dans `tests/unit/renderer/store/agent-actions.test.ts`, `decideExchange` appelle `exchange:decide`
- [ ] T044 [P] [US3] E2E dans `tests/e2e/us32-exchanges.spec.ts` avec `tests/fixtures/fake-cli/scenarios/exchanges-agents.json` : US3 sc.1 à 6, 11 à 15, décision « Couper » et « Laisser reprendre », SC-005, SC-010, journal lisible dans « ◎ Actions »

### Implémentation

- [ ] T045 [US3] Dans `src/main/orchestrator/exchange-service.ts` : `send`, plafond par tour, allers-retours par paire avec résolution de `HEAD`, création de l'escalade et messages `exchange-escalated`, `exchange-decided`
- [ ] T046 [US3] Dans `src/main/orchestrator/agent-tools.ts` : `ask_orchestrator` et `send_message` selon `contracts/mcp-tools.md` ; `send_message` pour l'orchestrateur dans `src/main/orchestrator/tools.ts`
- [ ] T047 [US3] Dans `src/shared/todo.ts` : remonter `lead`, passer `routed` à `agentTodo`, créer `exchange-escalated` ; dans `src/main/notifications.ts` : `NOTIFIED` et `GENERIC_TITLE`
- [ ] T048 [US3] Dans `src/renderer/todo/TodoItem.tsx`, `src/renderer/app/App.tsx` et `src/renderer/store/app-store.ts` : élément d'escalade et action `decideExchange`, sur le modèle de `decideLoop`
- [ ] T049 [US3] Dans `src/renderer/focus/FocusView.tsx` : `ActionsJournal` fusionne les messages selon `contracts/ui.md`

**Checkpoint** : US3 livrée ; PR « 007 Phase 5 US3 ».

---

## Phase 6: User Story 4 — Une boucle qui démarre pour de vrai (P2)

**But** : `start_loop` envoie les consignes et le dit ; le contrôle du testeur part de la base réelle ; le dev reçoit le verdict.

**Test indépendant** : boucle sur faux CLI, réponse lue ; dépôt Git temporaire, testeur recalé, verdict accepté.

### Tests (rouges d'abord)

- [ ] T050 [P] [US4] Tests dans `tests/integration/orchestrator/loops.test.ts`, dépôts Git temporaires : testeur recalé sur `main` puis sur `origin/main` avancé → verdict accepté (SC-006) ; fichier de production → rejet avec la liste et le moyen d'en sortir ; merge de la branche du dev → rejet ; redémarrage (nouveau `LoopService`) → contrôle maintenu ; `baseBranch` explicite respectée
- [ ] T051 [P] [US4] Tests dans `tests/unit/main/orchestrator/loop-service.test.ts` : `start` envoie une `instruction` au testeur et rend `sent` ; premier rapport du testeur → `instruction` au dev, une seule fois ; verdict `defects` accepté → `verdict` au dev, type `action`, borné ; verdict rejeté → rien au dev (FR-007, FR-021)
- [ ] T052 [P] [US4] Tests dans `tests/integration/orchestrator/start-loop.test.ts` : réponse de `start_loop` nommant le testeur et le dev, sans titre ni texte d'issue
- [ ] T053 [P] [US4] E2E dans `tests/e2e/us33-loop-start.spec.ts` avec `tests/fixtures/fake-cli/scenarios/loop-start.json` : US4 sc.1 et 2

### Implémentation

- [ ] T054 [US4] Dans `src/main/orchestrator/loop-service.ts` : retirer `testerStart` et `markTesterStart`, contrôle par intersection des bases (R12), `git` élargi à `mergeBase` ; message de rejet avec la sortie
- [ ] T055 [US4] Dans `src/main/orchestrator/loop-service.ts` : consignes et verdict par `deps.message` (R14), `sent` dans le retour de `start`
- [ ] T056 [US4] Dans `src/main/orchestrator/tools.ts` : `start_loop` met `sent` en mots

**Checkpoint** : US4 livrée ; PR « 007 Phase 6 US4 ».

---

## Phase 7: User Story 5 — `wait_for_agents` en secours, skills réécrits (P3)

**But** : la méthode normale est de finir son tour. Le code de `wait_for_agents` est livré en Phase 2 ; reste le texte, avec la route des questions.

**Test indépendant** : lecture des skills livrés par le test de contenu.

### Tests (rouges d'abord)

- [ ] T057 [US5] Dans `tests/unit/main/orchestrator/skills-content.test.ts` : remplacer « Les questions sont à l'utilisateur » ; exiger la nouvelle règle dans `pact-contract.md` et `pact-orchestrator/SKILL.md` (FR-032) : questions d'abord à l'orchestrateur, autorisations à l'utilisateur ; exiger `get_events`, `ask_orchestrator`, finir son tour, `wait_for_agents` en secours (US5 sc.4), et l'interdiction de lire le contenu d'un tiers (FR-027, US3 sc.10) ; interdire la phrase « Les questions et autorisations des agents sont à l'utilisateur »

### Implémentation

- [ ] T058 [P] [US5] Réécrire `resources/skills/pact-orchestrator/SKILL.md` : méthode (lignes 15, 27-28), règle des lignes 45-46 ; une question reçue se traite ou se transmet par `AskUserQuestion` si la décision revient à l'utilisateur ; réponse par `send_message`
- [ ] T059 [P] [US5] Corriger `resources/skills/pact-contract.md`, lignes 48-50 : `ask_orchestrator` ou `questions` avec un orchestrateur, ◆ Décider sans lui ; `get_events` au réveil ; autorisations à l'utilisateur ; interdiction du contenu de tiers
- [ ] T060 [P] [US5] Adapter `resources/skills/pact-spec/SKILL.md` (lignes 8, 28-29), `resources/skills/pact-dev/SKILL.md` et `resources/skills/pact-test/SKILL.md` (écrit seulement par `ask_orchestrator`, jamais au dev)

**Checkpoint** : US5 livrée ; PR « 007 Phase 7 US5 ».

---

## Phase 8: Polish

- [ ] T061 [P] Test témoin dans `tests/integration/orchestrator/third-party.test.ts` : `tests/fixtures/fake-cli/fake-gh.mjs` imprime une chaîne d'injection ; elle n'apparaît ni dans `get_events`, ni `wait_for_agents`, ni le journal, ni un pointeur (FR-026, US3 sc.8 et 9, SC-009) ; corriger si besoin le motif de `src/main/orchestrator/issues.ts`
- [ ] T062 [P] Tests dans `tests/contract/claude-code.contract.test.ts`, puis `SENSITIVE_RULES` dans `src/main/agents/adapters/claude-code.ts` selon R15 : lectures `gh` et `refs/pull` en `ask`, `gh pr create` libre (FR-027)
- [ ] T063 [P] Test dans `tests/unit/renderer/launch/PermissionsDialog.test.tsx`, puis phrase de garantie partielle dans `src/renderer/launch/PermissionsDialog.tsx`
- [ ] T064 Dérouler `specs/007-agent-exchanges/quickstart.md` ; vérifier une boucle complète sans `wait_for_agents` (SC-001) dans `tests/e2e/us33-loop-start.spec.ts` et la couverture des fichiers modifiés (80 % hors UI, 70 % UI)
- [ ] T065 Mettre à jour `README.md` (ligne 94 : `wait_for_agents` n'y est plus la méthode normale ; citer `get_events` et le réveil) ; ajuster `version` dans `package.json` selon la règle 0.x seulement si l'orchestrateur le demande : elle vaut 1.0.0 sur cette base

---

## Dépendances

```text
Phase 1 → Phase 2 → Phase 3 (US1) → { Phase 4 US2, Phase 5 US3, Phase 6 US4, Phase 7 US5 } → Phase 8
```

- US1 est le MVP : ses successeurs en dépendent, car `WakeService` et l'`instruction` y naissent.
- Dans une phase, les tests précèdent l'implémentation ; les tâches [P] de test ne partagent pas de fichier.
- Implémentation séquentielle dans une phase, car plusieurs tâches partagent `agent-manager.ts`, `exchange-service.ts` ou `loop-service.ts`.

## Parallélisation sans chevauchement

Après la fusion de la Phase 3, quatre lots disjoints :

| Lot | Fichiers de production | Tests et fixtures |
|---|---|---|
| US2 | `agents/adapters/*` (`types`, `claude-code`, `codex`, `generic`, `fake`), `agents/agent-manager.ts`, `orchestrator/wake-service.ts` | `tests/contract/*`, `wake-hooks`, `wake-hook`, `us31`, `orchestra-mid-turn.json` |
| US3 | `orchestrator/exchange-service.ts`, `orchestrator/agent-tools.ts`, `orchestrator/tools.ts` (ajout de `send_message`), `shared/todo.ts`, `main/notifications.ts`, `renderer/todo/TodoItem.tsx`, `renderer/app/App.tsx`, `renderer/store/app-store.ts`, `renderer/focus/FocusView.tsx` | `exchange-rules`, `agent-tools`, `agent-token`, `todo`, `TodoItem`, `FocusView`, `notifications`, `us32`, `exchanges-agents.json` |
| US4 | `orchestrator/loop-service.ts`, `orchestrator/tools.ts` (`start_loop`) | `loops`, `loop-service`, `start-loop`, `us33`, `loop-start.json` |
| US5 | `resources/skills/*` | `skills-content` |

**Seul recouvrement** : `orchestrator/tools.ts` entre US3 (T046) et US4 (T056), dans deux outils distincts. Pour un parallélisme strict, faire T046 ou T056 après la fusion de l'autre lot, ou laisser US3 et US4 l'une après l'autre. US2 et US5 sont entièrement disjoints de tout.

En Phase 8 : T061, T062 et T063 sont disjoints entre eux.

## Stratégie

MVP = Phases 1 à 3 : l'orchestrateur est réveillé à l'inactivité et les consignes multi-lignes arrivent nues. Puis US2 pour le plein tour, requis par 009. US3 ajoute les échanges et la route des questions : tant qu'elle n'est pas fusionnée, `◆ Décider` reste affiché en plus de la notification à l'orchestrateur, sans perte.
