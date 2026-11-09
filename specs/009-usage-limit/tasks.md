# Tasks: Arrêt à une limite de consommation

**Input**: Design documents from `/specs/009-usage-limit/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: obligatoires (constitution I) : chaque phase commence par ses tests rouges, commités avant le code.

**Livraison**: une PR par phase (Phases 1 et 2 ensemble), branche `009-phase-N-…` depuis `009-usage-limit`. Chaque commit passe par une chaîne `&&` gardée par `npm run check` et `npm run test:e2e`. Fusion quand converge et CI verte, sans `gh --auto`.

**Interdits**: aucun vrai CLI d'agent avec des touches simulées ; aucune commande brew ; aucune modification de la configuration de l'utilisateur ; aucun push dans les tests hors du remote nu temporaire ; aucun contenu écrit par un tiers lu, récupéré ou transmis.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [ ] T001 Créer `009-usage-limit` depuis `origin/main` si 007 y est fusionnée, sinon depuis `origin/007-agent-exchanges`, avec `specs/009-usage-limit/` et `.specify/feature.json`, puis lancer `npm ci`
- [ ] T002 Étendre `tests/fixtures/fake-cli/fake-cli.mjs` selon `contracts/events.md` (R16) : champ `onPointer: 'commit' | 'ignore'` ; avec `commit`, à la lecture d'un pointeur, appel de `get_events`, et si un `usage-save` est lu, `git add -A && git commit -m "pact: sauvegarde"` dans son dossier, puis impression de `Sauvegardé`, jamais de push ; avec `ignore`, lecture sans effet ; documenter les champs dans l'en-tête du fichier

---

## Phase 2: Foundational (bloque toutes les stories)

**But** : l'état `paused`, les schémas, l'évaluation pure par fenêtre, la persistance. Aucun arrêt encore.

### Tests (rouges d'abord)

- [ ] T003 [P] Tests dans `tests/unit/shared/usage-limit.test.ts` : `usageStopsSchema` (« z.int().min(10).max(100) », défaut `{}`), `stopOf` rend 90 pour une fenêtre absente ; `limitBands` classe `ok`, `save` (≥ seuil − 3), `stop` (≥ seuil) pour chaque fenêtre, fenêtres par modèle comprises, et une fenêtre dont le reset est passé vaut `ok` (FR-002) ; seuil 10 → bande à 7, seuil 100 → bande à 97 ; `windowsOf('claude-code', [])` rend `five-hour` et `week` ; `usagePauseSchema` (`windows` « .min(1) », `closedQuestion` « .max(200).nullable() », `blocked` « z.enum(['session']).nullable() ») ; `usageLimitStateSchema` vide par défaut
- [ ] T004 [P] Tests dans `tests/unit/main/agents/agent-state.test.ts` : `applySignal` rend l'agent `paused` inchangé pour chaque signal ; `applyExit` sur `paused` le laisse `paused`
- [ ] T005 [P] Tests dans `tests/unit/shared/agents-view.test.ts` : `agentStateLabel` rend les quatre labels de `contracts/ui.md` (reprise à HH:MM, fenêtre, après réinitialisation, session inconnue) et jamais « erreur » pour `paused` (SC-003)
- [ ] T006 [P] Tests dans `tests/unit/shared/exchanges.test.ts` : `typeOf('usage-save')` → `action`, `typeOf('usage-paused')` → `info`, `typeOf('usage-resumed', 'info')` → `info`, `typeOf('usage-resumed')` → `action` ; textes au plus `MAX_NOTICE`
- [ ] T007 [P] Tests dans `tests/unit/main/persistence/store.test.ts` : un `state.json` sans `usageStops` ni `usageLimit` se lit avec les défauts ; un fichier de workspace sans `pause` se lit avec `pause: null`
- [ ] T008 [P] Tests dans `tests/integration/agents/agent-manager.test.ts` : `restore` laisse un agent `paused` en `paused`, sans « à reprendre » (FR-006, US2 sc.4) ; `accountAgents(cliId, account)` rend les agents de tous les workspaces de ce compte, y compris en `error` `rate-limit`, et aucun agent sans source d'usage (FR-011)

### Implémentation

- [ ] T009 Créer `src/shared/usage-limit.ts` selon data-model (constantes, `usageStopsSchema`, `stopOf`, `windowsOf`, `limitBands`, `usagePauseSchema`, `usageSaveSchema`, `usageOverrideSchema`, `usageDeclinedSchema`, `usageLimitStateSchema`)
- [ ] T010 Dans `src/shared/model.ts` : `paused` dans `agentStateSchema`, `pause: usagePauseSchema.nullable().default(null)` dans `agentSchema`, `usage-paused` et `usage-stale` dans `TodoKind`, `usageLimit` dans `TodoItem` ; dans `src/shared/todo.ts`, les placer dans `ORDER` après `loop-escalated` et avant `rate-limit`
- [ ] T011 Dans `src/shared/exchanges.ts` : kinds `usage-save`, `usage-paused`, `usage-resumed` ; `typeOf` traite `usage-resumed` comme `message` (type choisi)
- [ ] T012 Dans `src/main/agents/agent-state.ts` : `paused` ignore tout signal et toute sortie ; dans `src/shared/agents-view.ts` : `STATE_LABELS.paused` et les labels de pause dans `agentStateLabel`
- [ ] T013 Dans `src/main/persistence/store.ts` : `usageStops` et `usageLimit` dans `appStateSchema` et `emptyAppState`
- [ ] T014 Dans `src/main/agents/agent-manager.ts` : `markStale` ignore `paused` ; `accountAgents(cliId, account)` lit `Running.usage.source`, et une table en mémoire garde la source d'un agent après la fin de son processus, jusqu'à sa fermeture (R7)

**Checkpoint** : `npm run check` et e2e verts, aucun comportement visible changé ; PR « 009 Phase 1-2 ».

---

## Phase 3: User Story 1 — PACT s'arrête au seuil, sans perte (P1) 🎯 MVP

**But** : consigne à seuil − 3, arrêt au seuil, état « en pause », journal, refus de `launch_agent`.

**Test indépendant** : faux CLI et lectures injectées dans `UsageService` ; consigne à 87, arrêt à 90, état `paused`, aucune erreur, remote nu inchangé.

### Tests (rouges d'abord)

- [ ] T015 [P] [US1] Tests dans `tests/unit/main/usage/usage-limit-service.test.ts`, avec horloge pilotée et dépendances factices : à 87 sur `five-hour` (seuil 90), un `usage-save` par agent du compte, dans tous les workspaces, puis `wake.deliver(id, { urgent: true })` ; une seconde lecture à 88 ne renvoie rien ; une lecture qui revient en arrière ne la renvoie pas avant le reset ; après le reset, une nouvelle consigne (US1 sc.1) ; à 90, `agents.pause` pour chaque agent en moins de 5 s (SC-001) ; la semaine au seuil avant la fenêtre de 5 h → pause qui nomme `semaine` (US1 sc.5) ; de 85 à 92 → consigne aussitôt, chaque agent arrêté à sa fin de tour ou à 60 s au plus (US1 sc.7, O5) ; compte Codex et compte Claude séparés (US1 sc.8) ; `commitFrozen` vrai → aucune consigne (US1 sc.9) ; un CLI sans lecture n'est jamais arrêté (US1 sc.10) ; chaque consigne et chaque arrêt écrits au journal avec la fenêtre et le pourcentage (US1 sc.11) ; `usageHeld` vrai au seuil et en pause ; un agent lancé par l'utilisateur pendant la pause reçoit une dérogation pour lui seul, jusqu'au reset (O1)
- [ ] T016 [P] [US1] Tests dans `tests/unit/main/orchestrator/wake-service.test.ts` et `tests/unit/main/orchestrator/wake-hooks.test.ts` : un `usage-save` en attente passe le plafond de 20 réveils et la coupure, par `attempt` comme par `takeForHook('tool')` et `takeForHook('stop')` (FR-004, 007 FR-017) ; la fenêtre de 5 s tient encore pour `tool` ; invite occupée et `awaiting-answer` retiennent toujours ; `usageHeld` remplace `usageCritical`, et les tests existants de la coupure migrent sans `skip`
- [ ] T017 [P] [US1] Tests dans `tests/integration/usage/usage-stop.test.ts`, sur dépôt Git temporaire avec remote nu : `AgentManager.pause` tue le processus sans crash, `state: 'paused'`, `pause.midTurn` selon `WORKING_STATES`, `pause.saved` vrai après un commit et faux avec un fichier modifié (US1 sc.6) ; PACT ne crée aucun commit ; `git ls-remote` identique avant et après (US1 sc.12, SC-007) ; une question ouverte est gardée dans `pause.closedQuestion` ; un agent en `error` `rate-limit` du compte passe en `paused` avec un seul `scheduledResume`
- [ ] T018 [P] [US1] Tests dans `tests/integration/orchestrator/tools-agents.test.ts` : `launch_agent` refusé pendant la pause du compte (US2 sc.9, FR-010), au texte exact de `contracts/events.md` ; un autre CLI se lance ; dans `tests/unit/shared/usage.test.ts`, `launchWarning` rend le texte de pause avant celui de 005
- [ ] T019 [P] [US1] Tests dans `tests/unit/shared/todo.test.ts` et `tests/unit/renderer/todo/TodoItem.test.tsx` : `usage-paused`, un par compte et par workspace, au titre et au corps de `contracts/ui.md` (questions fermées, non sauvegardés) ; `usage-limit` absent pour un compte en pause ; dans `tests/unit/renderer/tiles/Tile.test.tsx`, badge `non sauvegardé` et couleur hors erreur
- [ ] T020 [P] [US1] E2E dans `tests/e2e/us40-usage-stop.spec.ts` avec `tests/fixtures/fake-cli/scenarios/usage-stop.json` (paliers 80, 87, 90 sur `five_hour`, un agent `onPointer: 'commit'`, un agent `onPointer: 'ignore'`, un en plein tour avec `toolHook`) : US1 sc.1 à 4, 6, 11 et 12

### Implémentation

- [ ] T021 [US1] Dans `src/main/orchestrator/wake-service.ts` : un `usage-save` parmi les messages en attente rend le réveil urgent dans `attempt` et `takeForHook` ; `usageCritical` devient `usageHeld` dans `WakeOptions` (R13)
- [ ] T022 [US1] Dans `src/main/agents/agent-manager.ts` : `pause(id, pause)` (R6) lit `midTurn`, garde la question ouverte (200 caractères au plus), appelle `stop`, mesure `saved` par `git.hasUncommittedChanges(worktreePath)`, enregistre `state: 'paused'`, `pause`, `lastError: null`, et émet `agent:state` ; `restart(id)` accepte `paused` et vide `pause`
- [ ] T023 [US1] Créer `src/main/usage/usage-limit-service.ts` (R4 à R7) : abonnement aux états de `UsageService`, `limitBands`, consignes au texte exact de `contracts/events.md` avec `usageLimit.saves` persisté, arrêt immédiat ou à la fin de tour ou à 60 s après un saut, message `usage-paused`, `usageHeld(cliId)`, `pausedFor(cliId)`, dérogation par agent au lancement de l'utilisateur (O1, `usageLimit.overrides` avec `agentId`), prédicat `commitFrozen` injecté à faux (R18)
- [ ] T024 [US1] Dans `src/main/usage/usage-service.ts` : `reading(cliId, account)` pour le service d'arrêt ; retirer `critical` s'il n'a plus d'appelant
- [ ] T025 [US1] Dans `src/main/orchestrator/tools.ts` : refus de `launch_agent` pendant `pausedFor(cliId)` ; dans `src/shared/usage.ts`, `pauseWarning` passé à `launchWarning` (R12)
- [ ] T026 [US1] Dans `src/shared/todo.ts`, `src/renderer/todo/TodoItem.tsx` et `src/renderer/tiles/Tile.tsx` : élément `usage-paused`, badge `non sauvegardé`, actions de la tuile en pause (`contracts/ui.md`)
- [ ] T027 [US1] Dans `src/main/index.ts` : créer `UsageLimitService`, le brancher sur `UsageService`, `AgentManager`, `ExchangeService`, `WakeService` (`usageHeld`), `stores.state` et `tools` ; transmettre `turn-finished` au service pour l'arrêt après un saut

**Checkpoint** : US1 utilisable seule ; un agent en pause se relance à la main par « Relancer » ; PR « 009 Phase 3 US1 ».

---

## Phase 4: User Story 2 — La reprise au reset (P1)

**But** : reprise avec `--resume` au reset de la dernière fenêtre en cause, l'orchestrateur d'abord, pointeur aux agents interrompus.

**Test indépendant** : horloge pilotée et faux CLI ; `--resume`, ordre, pointeur, deux fenêtres, redémarrage.

### Tests (rouges d'abord)

- [ ] T028 [P] [US2] Tests dans `tests/unit/main/usage/usage-limit-service.test.ts` : `scheduledResume` au plus tardif des `resetsAt` en cause si `autoResume` ; deux fenêtres au-dessus du seuil → attente de la seconde (US2 sc.2) ; heure inconnue → `BACKOFF_MINUTES`, puis aucun nouvel arrêt sans lecture plus récente que la reprise (O2) ; reprise auto coupée → aucun `scheduledResume` (US2 sc.6) ; « Reprendre » d'À faire → reprise du compte et dérogation de compte jusqu'au reset ; « Reprendre » de la tuile → cet agent seul, dérogation pour lui seul ; aucun arrêt ni consigne couverts par une dérogation (US2 sc.8, R10) ; « Annuler la reprise » → `scheduledResume: null` ; `usage-resumed` en `action` pour l'orchestrateur et les agents `midTurn`, en `info` pour les autres, au texte exact de `contracts/events.md` (FR-008, FR-012, FR-013)
- [ ] T029 [P] [US2] Tests dans `tests/integration/usage/usage-resume.test.ts`, avec `Clock` pilotée : au reset, chaque agent repart par `startAgain` avec son `sessionId` (`--resume`), l'orchestrateur d'abord (US2 sc.1, sc.7) ; l'agent `midTurn` reçoit un pointeur une fois prêt, l'agent inactif aucun (US2 sc.3) ; PACT redémarré pendant la pause → agents `paused`, reprise réarmée, échéance passée exécutée aussitôt (US2 sc.4, FR-006) ; `sessionId` nul → reste en pause, `blocked: 'session'`, « Relancer » possible (US2 sc.5) ; `index.lock` présent → signalé, jamais effacé ; aucun tour ni `report-missing` compté par la pause (US2 sc.10)
- [ ] T030 [P] [US2] Tests dans `tests/unit/main/ipc/usage-handlers.test.ts` et `tests/unit/shared/ipc.test.ts` : canaux `usage:resume` et `usage:cancelResume` de `contracts/ui.md`
- [ ] T031 [P] [US2] E2E dans `tests/e2e/us41-usage-resume.spec.ts` avec `tests/fixtures/fake-cli/scenarios/usage-resume.json` : US2 sc.1, 3, 4, 7 et 8, SC-004 (reprise en moins d'une minute après le reset)

### Implémentation

- [ ] T032 [US2] Dans `src/main/agents/agent-manager.ts` : `resumeDue` accepte `paused` et délègue à `onPausedDue` ; `resumePaused(id)` passe par `startAgain(workspace, agent, agent.sessionId)` et vide `pause` ; `resume(id)` accepte `paused` et écrit la dérogation de l'agent ; `cancelAutoResume` vaut aussi en pause
- [ ] T033 [US2] Dans `src/main/usage/usage-limit-service.ts` (R8 à R10) : planification de `scheduledResume` par `nextResume` ; `resumeAccount(cliId, account)` relit `limitBands`, replanifie ou reprend, orchestrateurs d'abord ; contrôle du verrou par `git rev-parse --git-path index.lock` ; messages `usage-resumed` ; dérogations de compte et `resumed` dans `usageLimit`
- [ ] T034 [US2] Dans `src/main/git/git-service.ts` : `indexLock(worktree)` rend le chemin du verrou s'il existe, sans jamais l'effacer
- [ ] T035 [US2] Dans `src/shared/ipc.ts`, `src/main/ipc/usage-handlers.ts`, `src/renderer/store/app-store.ts` et `src/renderer/app/App.tsx` : `usage:resume`, `usage:cancelResume`, actions « Reprendre » et « Annuler la reprise » de l'élément `usage-paused` et de la tuile

**Checkpoint** : US1 et US2 couvrent la nuit sans perte ; PR « 009 Phase 4 US2 ».

---

## Phase 5: User Story 3 — Une lecture trop ancienne (P2)

**But** : proposition d'arrêt par prudence, jamais d'arrêt seul.

**Test indépendant** : lectures vieillies par l'horloge pilotée, agents actifs ou non.

### Tests (rouges d'abord)

- [ ] T036 [P] [US3] Tests dans `tests/unit/shared/usage-limit.test.ts` : `staleProposal` vraie à plus de 15 minutes, un agent `working` et une fenêtre à 10 points du seuil ou moins ; fausse sans agent actif (US3 sc.4), à 14 minutes, ou à 11 points ; palier `floor(âge / 15)`
- [ ] T037 [P] [US3] Tests dans `tests/unit/main/usage/usage-limit-service.test.ts` : vérification chaque minute, seulement s'il existe une lecture ; aucune pause sans décision (SC-006) ; `later` → retirée, revient au palier suivant (US3 sc.2) ; lecture fraîche → refus effacé ; `stop` → consigne puis arrêt en 60 s au plus, `pause.cause: 'stale'`, texte « par prudence » (US3 sc.3)
- [ ] T038 [P] [US3] Tests dans `tests/unit/shared/todo.test.ts` et `tests/unit/renderer/todo/TodoItem.test.tsx` : élément `usage-stale` au titre de `contracts/ui.md`, actions « Arrêter par prudence » et « Pas maintenant » ; canal `usage:stale` dans `tests/unit/main/ipc/usage-handlers.test.ts`
- [ ] T039 [P] [US3] E2E dans `tests/e2e/us42-usage-stale.spec.ts` (partie US3) avec `tests/fixtures/fake-cli/scenarios/usage-stale.json` : US3 sc.1 à 3

### Implémentation

- [ ] T040 [US3] Dans `src/shared/usage-limit.ts` : `staleProposal` ; dans `src/shared/todo.ts`, élément `usage-stale`
- [ ] T041 [US3] Dans `src/main/usage/usage-limit-service.ts` (R11) : minuterie de 60 s active seulement avec une lecture, `declined` persisté, `decideStale(cliId, account, decision)`
- [ ] T042 [US3] Dans `src/shared/ipc.ts`, `src/main/ipc/usage-handlers.ts`, `src/renderer/todo/TodoItem.tsx` et `src/renderer/store/app-store.ts` : canal `usage:stale` et ses deux boutons

**Checkpoint** : PR « 009 Phase 5 US3 ».

---

## Phase 6: User Story 4 — Régler le seuil (P3)

**But** : un seuil par CLI et par fenêtre, appliqué aussitôt.

**Test indépendant** : test de composant et test de service sur le changement de seuil.

### Tests (rouges d'abord)

- [ ] T043 [P] [US4] Tests dans `tests/unit/renderer/settings/UsageThresholds.test.tsx` : section « Arrêt », un champ par fenêtre de `windowsOf`, 90 par défaut (US4 sc.1) ; bornes 10 à 100, « Enregistrer » désactivé hors bornes ; notes à 100 % et sous le seuil critique (FR-001, O3) ; `label` associé à chaque champ
- [ ] T044 [P] [US4] Tests dans `tests/unit/main/usage/usage-limit-service.test.ts` et `tests/unit/main/ipc/usage-handlers.test.ts` : `settings:usageStops` enregistre dans `state.json` et appelle `setStops` ; seuil baissé sous la consommation → consigne puis arrêt en 60 s au plus (US4 sc.2) ; seuil relevé au-dessus de toutes les fenêtres d'un compte en pause → `resumeAccount` (US4 sc.3) ; `usage:stops` rend le courant
- [ ] T045 [P] [US4] E2E dans `tests/e2e/us42-usage-stale.spec.ts` (partie US4) : US4 sc.1 et 2

### Implémentation

- [ ] T046 [US4] Dans `src/main/usage/usage-limit-service.ts` : `setStops(stops)` réévalue chaque compte
- [ ] T047 [US4] Dans `src/shared/ipc.ts` et `src/main/ipc/usage-handlers.ts` : `settings:usageStops` et `usage:stops`
- [ ] T048 [US4] Dans `src/renderer/settings/UsageThresholds.tsx` et `src/renderer/store/app-store.ts` : section « Arrêt » selon `contracts/ui.md`

**Checkpoint** : PR « 009 Phase 6 US4 ».

---

## Phase 7: Polish

- [x] T049 [P] Test dans `tests/integration/usage/usage-edge.test.ts` : un terminal libre ne s'arrête pas ; un test lancé par PACT continue pendant la pause, et son événement attend la reprise de l'orchestrateur dans le journal ; le plafond de réveils atteint ne retient pas la consigne (spec, cas limites)
- [x] T050 Dérouler `specs/009-usage-limit/quickstart.md` ; vérifier la couverture des fichiers modifiés (80 % hors UI, 70 % UI)
- [x] T051 [P] Mettre à jour `README.md` (arrêt à la limite, reprise) et la note d'amendement de 005 FR-012 dans `specs/005-usage-gauge/spec.md` : `launch_agent` est refusé pendant une pause ; ajuster `version` dans `package.json` selon la règle 0.x seulement si l'orchestrateur le demande

---

## Dépendances

```text
Phase 1 → Phase 2 → Phase 3 (US1) → Phase 4 (US2) → { Phase 5 US3, Phase 6 US4 } → Phase 7
```

- US1 est le MVP : `UsageLimitService`, `AgentManager.pause` et la consigne urgente y naissent.
- US2 dépend de US1 : elle reprend ce que US1 arrête. US3 et US4 réutilisent l'arrêt après un saut de US1 et la reprise de US2.
- Dans une phase, les tests précèdent l'implémentation ; les tâches [P] de test ne partagent pas de fichier, sauf mention de partie.
- Implémentation séquentielle dans une phase : plusieurs tâches partagent `agent-manager.ts` et `usage-limit-service.ts`.

## Parallélisation sans chevauchement

Après la fusion de la Phase 4, deux lots :

| Lot | Fichiers de production | Tests et fixtures |
|---|---|---|
| US3 | `shared/usage-limit.ts` (`staleProposal`), `shared/todo.ts`, `usage/usage-limit-service.ts` (minuterie, `decideStale`), `renderer/todo/TodoItem.tsx`, `ipc` (`usage:stale`) | `usage-limit`, `usage-limit-service`, `todo`, `TodoItem`, `us42` (US3), `usage-stale.json` |
| US4 | `usage/usage-limit-service.ts` (`setStops`), `renderer/settings/UsageThresholds.tsx`, `ipc` (`settings:usageStops`, `usage:stops`) | `UsageThresholds`, `usage-limit-service`, `usage-handlers`, `us42` (US4) |

**Recouvrement** : `usage-limit-service.ts`, `src/shared/ipc.ts`, `src/main/ipc/usage-handlers.ts` et `us42-usage-stale.spec.ts`, dans des fonctions distinctes. Pour un parallélisme strict, fusionner US3 puis US4, ou faire T046 à T048 après la fusion de US3.

En Phase 7 : T049 et T051 sont disjoints.

## Stratégie

MVP = Phases 1 à 3 : PACT ne dépasse plus le seuil, et le travail est commité avant l'arrêt. Jusqu'à la Phase 4, la reprise est manuelle par « Relancer ». US2 rend la nuit autonome. US3 couvre la jauge aveugle. US4 rend le seuil réglable : avant elle, le seuil vaut 90 % partout.
