---
description: "Task list for 005 — Jauge de limite d'usage"
---

# Tasks: Jauge de limite d'usage

**Input**: Design documents from `/specs/005-usage-gauge/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R9), data-model.md, contracts/sources.md,
contracts/ipc.md, quickstart.md. Indépendante de 004, sauf l'affichage du rôle (US3), qui lit
`Agent.role` (003, étendu par 004) et vaut `null` sans 004.

**Tests**: obligatoires (constitution I) : rouges et commités avant le code, dans chaque story. Une PR
par phase.

**Format**: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T001 [P] Fixtures `tests/fixtures/usage/` : `claude-statusline.json` (charge réelle de Claude Code 2.1.316 sans `session_id` réel, avec `rate_limits.five_hour` et `seven_day`), `claude-statusline-apikey.json` (sans `rate_limits`), `codex-rollout.jsonl` (lignes réelles de Codex 0.163.0 dont un `token_count` avec `rate_limits.primary` 300 min et `secondary` 10080 min, une ligne illisible).
- [X] T002 [P] Faux CLI `tests/fixtures/fake-cli/fake-cli.mjs` : étape `usage { five_hour, seven_day, tokens }` qui exécute la commande `statusLine` reçue dans `--settings` avec la charge construite ; étape `rollout { primary, secondary, tokens }` qui écrit un `token_count` dans `$CODEX_HOME/sessions/AAAA/MM/JJ/rollout-<horodatage>-<session>.jsonl` (R9).

## Phase 2: Foundational

- [X] T003 Tests rouges `tests/unit/shared/usage.test.ts` : schémas `UsageWindow`, `UsageReading`, `AgentShare`, `UsageState` (data-model.md) ; fenêtre affichée = plus grand `usedPercent`, la plus courte à égalité ; niveau `ok | warn | critical` selon `{ warn, critical }` ; âge `stale` > 15 min, masquée > 60 min ; `resetsAt` passée → « réinitialisée » et 0 % ; pourcentage > 100 accepté.
- [X] T004 Implémenter `src/shared/usage.ts` (pur).
- [X] T005 Tests rouges puis `AppState.usageThresholds` (défaut `{ warn: 80, critical: 95 }`, entiers 1…100, `warn < critical`, lu sans migration) dans `src/main/persistence/store.ts` et `tests/unit/main/persistence/store.test.ts`.

---

## Phase 3: User Story 1 — Voir où j'en suis de mes limites (P1) 🎯 MVP

**Goal**: lecture des deux sources, jauge par CLI dans la barre du workspace, détail, âge (FR-001…FR-009).

**Independent Test**: faux CLI qui pousse des limites → jauge, détail et mise à jour ; faux CLI sans
limites → aucune jauge.

### Tests (rouges d'abord)

- [ ] T006 [P] [US1] `tests/unit/main/usage/claude-statusline.test.ts` : fixture → lecture `five-hour` « 5 h » et `week` « semaine » (`resets_at` epoch s → ISO), toute autre clé de `rate_limits` avec `used_percentage` = fenêtre par modèle ; sans `rate_limits` → pas de lecture, jetons quand même relevés (`total_input_tokens + total_output_tokens`) ; charge invalide → rien, sans exception.
- [ ] T007 [P] [US1] `tests/unit/main/usage/codex-rollout.test.ts` : dernière ligne avec `rate_limits` ; `window_minutes` 300 → « 5 h », 10080 → « semaine », autre → « N h » ; `rate_limits` nul → pas de lecture ; ligne illisible ignorée ; jetons de `info.total_token_usage`.
- [ ] T008 [P] [US1] `tests/integration/usage/statusline-route.test.ts` : `POST /statusline` avec jeton d'agent → 200 et une ligne de texte ; jeton inconnu → 401 corps vide ; pont `hook-bridge.js --statusline` poste l'entrée et imprime la réponse ; avec une `statusLine` utilisateur `command` (HOME temporaire), le pont l'exécute avec la même entrée (délai 2 s) et imprime sa sortie, la charge étant postée quand même ; `~/.claude/settings.json` inchangé.
- [ ] T009 [P] [US1] `tests/integration/usage/rollout-follow.test.ts` : `CodexRollout` retrouve le fichier par l'identifiant de session sous un `CODEX_HOME` temporaire, suit les ajouts (au plus toutes les 10 s), en lecture seule.
- [ ] T010 [P] [US1] `tests/unit/main/usage/usage-service.test.ts` (horloge factice) : une lecture par compte (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` ou `default`), la plus récente remplace ; événement `usage:state` ; échec silencieux, dernière valeur gardée.
- [ ] T011 [P] [US1] Contrat `tests/contract/claude-code.contract.test.ts` : `--settings` contient `statusLine: { type: 'command', command: '<pont> --statusline' }`.
- [ ] T012 [P] [US1] `tests/unit/renderer/workspace/UsageGauge.test.tsx` : « Claude Code 62 % · 5 h », détail au survol, clic et focus clavier (chaque fenêtre, pourcentage, réinitialisation dans le fuseau du système, heure de lecture) ; grisée « lu il y a 20 min » ; absente > 60 min ou sans lecture ; `role="meter"` avec nom, valeur et état (FR-009) ; forme réduite en fenêtre étroite.
- [ ] T013 [US1] e2e `tests/e2e/us24-usage-gauge.spec.ts` : faux CLI avec `usage` puis nouvelle valeur → jauge mise à jour ; faux CLI sans limites → aucune jauge.

### Implementation

- [ ] T014 [US1] `src/main/usage/claude-statusline.ts` et `src/main/usage/codex-rollout.ts`.
- [ ] T015 [US1] Route `/statusline` dans `src/main/agents/hook-server.ts` ; mode `--statusline` (relais de la `statusLine` utilisateur, lecture seule) dans `src/main/agents/hook-bridge.ts`.
- [ ] T016 [US1] `statusLine` de session dans `src/main/agents/adapters/claude-code.ts` ; `usageSource` dans `src/main/agents/adapters/types.ts` ; suivi du rollout au `session-started` de Codex.
- [ ] T017 [US1] `src/main/usage/usage-service.ts`, câblé dans `src/main/index.ts` ; IPC `usage:get` et événement `usage:state` (`src/shared/ipc.ts`).
- [ ] T018 [US1] `src/renderer/workspace/UsageGauge.tsx` dans la barre de `src/renderer/workspace/WorkspaceView.tsx` ; store `src/renderer/store/app-store.ts`.

**Checkpoint**: US1 livrable seule.

---

## Phase 4: User Story 2 — Être prévenu avant d'atteindre la limite (P1)

**Goal**: couleurs, alerte À faire, avertissement du lanceur et de `launch_agent`, seuils réglables
(FR-010…FR-012).

- [ ] T019 [P] [US2] Tests rouges `tests/unit/shared/todo.test.ts` et `TodoItem.test.tsx` : `usage-limit` « ◆ Limite <CLI> à <N> % · <fenêtre> · réinitialisation <heure> », un par compte (clé `usage:<cliId>:<account>`), mis à jour sans doublon de 80 à 95 %, retiré sous `warn` ; « Détail » ouvre le détail de la jauge.
- [ ] T020 [P] [US2] Tests rouges du lanceur `tests/unit/renderer/launch/*.test.tsx` : « Limite 5 h à 85 % : ces agents risquent de s'arrêter avant 16:40 », bouton toujours actif ; `tests/integration/orchestrator/tools-agents.test.ts` : `launch_agent` ajoute la même phrase à sa réponse sans refuser.
- [ ] T021 [P] [US2] Tests rouges `tests/unit/renderer/settings/UsageThresholds.test.tsx` et IPC `settings:usageThresholds` (`{ warn: int 1–99, critical: int 2–100 }`, `warn < critical`) dans `tests/unit/shared/ipc.test.ts`.
- [ ] T022 [US2] e2e `tests/e2e/us25-usage-alerts.spec.ts` : 80 % orange + alerte, 95 % rouge, une seule alerte, avertissement au lancement puis lancement.
- [ ] T023 [US2] Implémenter : niveau dans `UsageService`, `usage-limit` dans `src/shared/todo.ts` et `src/renderer/todo/TodoItem.tsx`, couleurs de `UsageGauge.tsx`, avertissement dans `src/renderer/launch/` et `src/main/orchestrator/tools.ts`, `src/renderer/settings/UsageThresholds.tsx`, handler `settings:usageThresholds`.

---

## Phase 5: User Story 3 — Savoir qui consomme (P2)

**Goal**: part de chaque agent (jetons), rôle, agents fermés, autres workspaces (FR-013, FR-014).

- [ ] T024 [P] [US3] Tests rouges `tests/unit/main/usage/usage-service.test.ts` : delta par agent depuis son premier relevé dans la fenêtre, remise à zéro au changement de `resetsAt`, agent fermé gardé et marqué `closed` ; `tests/unit/renderer/workspace/UsageGauge.test.tsx` : tri décroissant, rôle affiché, « autres » pour les autres workspaces, texte « des agents PACT ».
- [ ] T025 [US3] e2e `tests/e2e/us26-usage-shares.spec.ts` : trois faux agents aux jetons connus.
- [ ] T026 [US3] Implémenter les parts dans `src/main/usage/usage-service.ts` et le détail dans `UsageGauge.tsx`.

---

## Phase 6: User Story 4 — Reprise à la bonne heure (P3)

**Goal**: heure de réinitialisation connue → reprise automatique à cette heure (FR-015).

- [ ] T027 [P] [US4] Tests rouges `tests/integration/agents/auto-resume.test.ts` : limite sans heure dans le message + heure connue par `UsageService.resetAt(cliId, account)` (fenêtre ≥ 100 %, sinon la plus haute) → reprise à cette heure ; heure passée ou inconnue → intervalles de 001 FR-036 ; `nextResume` inchangé.
- [ ] T028 [US4] e2e `tests/e2e/us27-usage-resume.spec.ts` (horloge de test de 001).
- [ ] T029 [US4] Passer le `resetAt` de repli dans `src/main/agents/agent-manager.ts`.

---

## Phase 7: Polish

- [ ] T030 [P] Garde de test : aucun test n'écrit dans `~/.claude` ni `~/.codex` (FR-005).
- [ ] T031 [P] Mettre à jour `README.md` et quickstart.md.
- [ ] T032 Caractérisation sur vrais CLI (utilisateur) : écart avec `/usage` et `/status` ≤ 2 points (SC-002), clé d'API sans jauge, `statusLine` personnelle conservée ; consigner dans research.md.

## Dependencies & Execution Order

- Setup → Foundational → US1 → US2 ; US3 et US4 après US1, indépendantes entre elles.
- Dans chaque story : tests rouges commités, implémentation, commit vert conditionné par
  `npm run check && npm run test:e2e`.

## Parallel Opportunities

- T001, T002 ; US1 : T006 à T012 ; US2 : T019 à T021 ; US3 et US4 en parallèle.

## Implementation Strategy

MVP = Setup + Foundational + US1 (jauge visible). Puis US2 (alertes), US3, US4, Polish. T032 reste à
l'utilisateur.
