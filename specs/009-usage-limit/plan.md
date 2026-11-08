# Implementation Plan: Arrêt à une limite de consommation

**Branch**: `009-plan` (implémentation sur `009-usage-limit`, depuis `origin/main` une fois 007 fusionnée, sinon depuis `origin/007-agent-exchanges`) | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/009-usage-limit/spec.md`

## Summary

PACT lit déjà la consommation de chaque compte (005) et sait reprendre une session après une erreur de limite (001 US7). 009 ajoute la décision. Un seuil par CLI et par fenêtre, à 90 % par défaut, est évalué à chaque lecture. À seuil − 3 points, chaque agent du compte reçoit une consigne `usage-save` dans le journal de 007 : committer localement, sans push. Le pointeur part en urgence, malgré le plafond de réveils et la coupure de consommation, et par les hooks si l'agent est en plein tour. Au seuil, PACT arrête les agents du compte, dans tous les workspaces ouverts. Ils passent dans un nouvel état `paused`, distinct de `error`, avec la fenêtre en cause, l'heure de reprise et le constat de sauvegarde. La reprise réutilise `scheduledResume`, `AutoResume` et `startAgain(…, sessionId)`. Elle relance l'orchestrateur d'abord. Un agent arrêté en plein tour reçoit ensuite un pointeur `usage-resumed`. Une lecture de plus de 15 minutes, proche du seuil, donne une proposition d'arrêt dans À faire. PACT n'arrête jamais seul sur une telle lecture.

| Besoin | Réutilisé | Ajouté |
|---|---|---|
| Lectures, fenêtres, reset | `UsageService.record`, `onState`, `currentWindow`, `readingAge`, `STALE_MINUTES`, `clockTime` | `limitBands` pur, par fenêtre (R3) ; `AgentManager.accountAgents(cliId, account)` (R7) |
| Seuils enregistrés | `appStateSchema.usageThresholds`, `settings:usageThresholds`, `UsageThresholds.tsx` | `usageStops` dans `state.json`, `settings:usageStops`, section « Arrêt » (R2) |
| Consigne en plein tour | `ExchangeService.record`, `WakeService.deliver({ urgent })`, `takeForHook`, `pointerText` | kinds `usage-save`, `usage-paused`, `usage-resumed` ; urgence portée par le message (R5) |
| Arrêt sans crash | `AgentManager.stop`, `running`, `Running.usage.source`, `git.hasUncommittedChanges` | `AgentManager.pause`, état `paused`, champ `Agent.pause` (R1, R6) |
| Reprise | `scheduledResume`, `AutoResume`, `nextResume`, `BACKOFF_MINUTES`, `resumeDue`, `startAgain`, `restore`, `permissions.resolve().autoResume` | `resumeDue` accepte `paused` ; reprise du compte, orchestrateur d'abord (R8) |
| Redémarrage | `markStale`, `restore` | `paused` exclu de `markStale` (R9) |
| Coupure des réveils (007 FR-016) | `WakeOptions.usageCritical` | remplacé par `usageHeld` : seuil d'arrêt ou pause (R13) |
| À faire, tuile | `deriveTodos`, `ORDER`, `TodoKind`, `agentStateLabel`, `STATE_LABELS` | `usage-paused`, `usage-stale`, label « en pause » (R15) |
| `launch_agent` | `Refusal`, `usageWarning`, `launchWarning` | refus pendant la pause, avertissement du lanceur (R12) |
| Faux CLI | `fake-cli.mjs` (`usage`, `toolHook`, pointeur de 007) | champ `onPointer: 'commit'`, remote nu dans les tests (R16) |

## Technical Context

**Language/Version**: inchangé : TypeScript 5.9 strict, Electron 44, Node 22 LTS, React 19.

**Primary Dependencies**: aucune nouvelle.

**Storage**: `state.json` gagne `usageStops` et `usageLimit` (consignes envoyées, dérogations, propositions refusées), avec défauts. Le fichier de workspace gagne `Agent.pause`, à `null` par défaut. L'état `paused` s'ajoute à `agentStateSchema`. Aucune migration : un fichier antérieur se lit avec les défauts.

**Testing**: Vitest pour `limitBands`, `UsageLimitService` (horloge pilotée), `AgentManager.pause` et la reprise sur dépôts Git temporaires avec remote nu, `WakeService` urgent, `deriveTodos`, les handlers, le renderer. Playwright Electron avec le faux CLI : us40 à us42. Aucun vrai CLI.

**Target Platform**: macOS 13+ et Windows 10 1809+ / 11.

**Project Type**: desktop-app (Electron, main + preload + renderer).

**Performance Goals**: arrêt moins de 5 s après la lecture du seuil (SC-001) ; reprise moins d'une minute après le reset (SC-004) ; évaluation sans I/O, sur l'état en mémoire de `UsageService`.

**Constraints**: aucun push ni branche distante à la sauvegarde (SC-007) ; aucun commit de PACT à la place d'un agent ; aucun arrêt sur une lecture trop ancienne sans accord (SC-006) ; un CLI sans lecture n'est jamais arrêté (FR-011) ; jamais de texte d'agent tapé (007).

**Scale/Scope**: 1 service, 1 module partagé, 1 état d'agent, 1 champ d'agent, 3 kinds de journal, 2 `TodoKind`, 5 canaux IPC, 3 fichiers e2e. 6 agents par workspace, quelques comptes.

Aucun « NEEDS CLARIFICATION ». Les points laissés à la relecture sont dans [research.md](research.md#points-ouverts), chacun avec une recommandation.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe | Exigence | Comment le plan la satisfait | Statut |
|----------|----------|------------------------------|--------|
| I. Tests d'abord | Tests rouges avant le code | Chaque phase commence par ses tests, rouges et commités. | ✅ |
| II. Merge sur tests verts | Suite complète, CI bloquante | Une PR par phase, depuis `009-usage-limit`. | ✅ |
| III. Zéro régression | Couverture non décroissante, changements documentés | Trois changements documentés : 005 FR-012 amendé (`launch_agent` refusé en pause) ; 007 FR-016 passe du niveau `critical` au seuil d'arrêt ; `markStale` ne touche plus un agent `paused`. Les tests existants de `usageCritical` migrent vers `usageHeld`. | ✅ |
| IV. Réutiliser | Inventaire, justification | Tableau du Summary. Seule abstraction nouvelle : `UsageLimitService`. `UsageService` lit et compte, et y ajouter les décisions, les minuteries et les appels à `AgentManager` mélangerait lecture et action. `AgentManager` a plus de 1 100 lignes. La reprise garde `AutoResume`, sans second minuteur. | ✅ |
| V. Qualité | Lint, format, YAGNI | Pas de seuil par workspace, pas de bande réglable, pas d'historique des pauses. Le prédicat `commitFrozen` reste à faux jusqu'à 008 (R18). | ✅ |

**Re-check post-design (Phase 1)** : aucune dépendance. Un service et un module pur. Deux champs dans `state.json`, un champ et un état d'agent. Logique pure et service couverts hors UI au-dessus du seuil de 80 %. ✅

## Project Structure

### Documentation (this feature)

```text
specs/009-usage-limit/
├── spec.md
├── plan.md
├── research.md          # R1–R18, points ouverts
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── events.md        # journal, consigne, hooks, launch_agent
│   └── ui.md            # IPC, réglages, tuile, À faire
└── tasks.md
```

### Source Code (repository root)

```text
src/shared/
├── usage-limit.ts                    # nouveau : schémas, constantes, limitBands, staleProposal, pauseText
├── usage.ts                          # launchWarning reçoit la pause
├── model.ts                          # état paused, Agent.pause, TodoKind
├── exchanges.ts                      # kinds usage-save, usage-paused, usage-resumed
├── ipc.ts, todo.ts, agents-view.ts
src/main/
├── usage/usage-limit-service.ts      # nouveau : évaluation, consigne, arrêt, reprise, lecture ancienne
├── usage/usage-service.ts            # reading(cliId, account) pour le service d'arrêt
├── agents/agent-manager.ts           # pause, resumeDue, markStale, sources des agents
├── agents/agent-state.ts             # transitions de paused
├── orchestrator/wake-service.ts      # urgence par message, usageHeld
├── orchestrator/tools.ts             # refus de launch_agent
├── persistence/store.ts              # usageStops, usageLimit
├── ipc/usage-handlers.ts, index.ts
src/renderer/
├── settings/UsageThresholds.tsx, todo/TodoItem.tsx, store/app-store.ts, tiles (label)
tests/
├── unit/shared/, unit/main/usage/, unit/main/agents/, unit/main/orchestrator/, unit/renderer/
├── integration/usage/, integration/agents/
├── fixtures/fake-cli/
└── e2e/us40–us42
```

**Structure Decision**: mêmes dossiers que 005 et 007. La logique pure va dans `src/shared/usage-limit.ts`, partagée par le service et `deriveTodos`.

## Risques

| Risque | Parade |
|---|---|
| 007 non fusionnée au début de 009 | Base `origin/007-agent-exchanges` ; les phases 1 et 2 n'en dépendent que par les kinds du journal |
| Hooks en mode interactif différents de `-p` (007 R1) | Repli de 007 : la consigne part en fin de tour, et le seuil arrête quand même (spec, cas limites) |
| Lecture sans heure de reset : boucle reprise → arrêt | Reprise par attente croissante, puis arrêt seulement sur une lecture plus récente que la reprise (R8) |
| Arrêt pendant un `git commit` : `index.lock` | Constaté à la reprise, signalé, jamais effacé (R8) |
| Compte d'un agent mal attribué | Le compte vient de `Running.usage.source`, déjà utilisé par la jauge ; sans source, aucun arrêt (FR-011) |

## Complexity Tracking

Aucune violation.
