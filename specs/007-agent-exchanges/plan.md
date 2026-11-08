# Implementation Plan: Échanges entre agents et réveil

**Branch**: `007-plan` (base `origin/006-agents-view`) | **Date**: 2026-11-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-agent-exchanges/spec.md`

## Summary

Les agents ne s'attendent plus : tout passe par un journal du workspace, lu par `get_events`. PACT annonce les messages `action` par un pointeur d'une ligne : tapé dans l'invite d'un agent inactif, remis par les hooks PostToolUse et Stop d'un agent Claude Code en plein tour (validé en `-p` sur 2.1.318, R1), ou tapé à la fin du tour ailleurs. Les questions d'agent vont d'abord à l'orchestrateur ; « ◆ Décider » ne reste que sans orchestrateur disponible. Le plan corrige aussi `start_loop`, le contrôle du testeur et les résumés trop longs.

**Écart avec la spec d'origine** : `launchNow` part déjà de `origin/<main>` sur 006 (R13). FR-022 se réduit à l'avertissement. Le tableau du contexte est corrigé.

| Besoin | Réutilisé | Ajouté |
|---|---|---|
| Outils MCP | `handleMcp`, `createAgentTools`, `Refusal`, `prepareAgent` | `ask_orchestrator`, `send_message`, `get_events` |
| Événements | `eventOf`, `notice`, `push`, kinds de `orchestratorEventSchema` | `ExchangeService`, journal persisté (R2) ; remplace `EventQueue` |
| Pointeur tapé | `sendPrompt`, `flushPrompt`, `submitEnter`, `undeliveredPrompts`, `isReady` | origine `wake`, suivi `draft` (R5), Entrée seule si bloqué (R6) |
| Pointeur par hook | `HookServer.respond`, handler de `start`, `mapEvent` | `isWakePoint`, `wakeReply`, hook `PostToolUse` |
| Regroupement, plafond | `usageAlert`, `UsageService` | `WakeService` (R4, R7) |
| Fichier sans MCP | `git.exclude`, modèle `.pact/ROLE.md` | `.pact/events.md` (R11) |
| Questions | `agentTodo`, `lead`, `lastReport`, `list_agents` | condition `routed` (R9), `report()` notifie partout (R8) |
| Escalade | `loop-escalated`, `TodoItem.tsx`, `NOTIFIED`, `ORDER` | `exchange-escalated`, `exchange:decide` |
| Journal visible | `ActionsJournal` (`FocusView.tsx`) | fusion avec les messages |
| Testeur | `git.mergeBase`, `changedFiles`, `snapshot`, `isTestPath` | intersection des bases (R12) ; retire `testerStart` |
| `fetch` | `fetchOrigin`, `within`, `remoteBranchExists` | lecture du résultat, avertissement (R13) |
| Skills | `resources/skills/*`, `skills-content.test.ts` | règles et méthode réécrites |
| Faux CLI | `fake-cli.mjs`, `FakeAdapter`, `fake-gh.mjs` | lecture du pointeur, `agentMcp`, `toolHook`, `block` (R16) |

## Technical Context

**Language/Version**: inchangé : TypeScript 5.9 strict, Electron 44, Node 22 LTS, React 19.

**Primary Dependencies**: aucune nouvelle.

**Storage**: `workspace.exchanges` et `agent.wakeNotice` dans l'état JSON, avec défauts (aucune migration). Compteurs de réveil et de messages en mémoire.

**Testing**: Vitest (schémas, `canSend`, `typeOf`, `ExchangeService`, `WakeService` avec horloge factice, `deriveTodos`, `LoopService` sur dépôts Git temporaires, handlers, renderer), Playwright Electron avec faux CLI (us30 à us33). Aucun vrai CLI dans les tests.

**Target Platform**: macOS 13+ et Windows 10 1809+ / 11.

**Project Type**: desktop-app (Electron, main + preload + renderer).

**Performance Goals**: pointeur à un agent inactif en moins de 10 s (SC-002) ; réponse d'un hook sans I/O : lecture en mémoire.

**Constraints**: jamais d'écriture dans une invite non vide ; jamais de texte d'agent tapé ; aucune touche simulée sur un vrai CLI ; aucun contenu de tiers ; aucune nouvelle voie d'autorisation.

**Scale/Scope**: 2 services, 1 module partagé, 3 outils, 2 `TodoKind`, 3 canaux IPC, 4 fichiers e2e. 6 agents au plus, 500 messages par workspace.

Aucun « NEEDS CLARIFICATION ».

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe | Exigence | Comment le plan la satisfait | Statut |
|----------|----------|------------------------------|--------|
| I. Tests d'abord | Tests rouges avant le code | Chaque phase commence par ses tests, rouges et commités. | ✅ |
| II. Merge sur tests verts | Suite complète, CI bloquante | Inchangé ; une PR par phase, depuis `007-agent-exchanges`. | ✅ |
| III. Zéro régression | Couverture non décroissante, changements documentés | Trois changements documentés : `send_prompt` passe par pointeur (le faux CLI joue le texte lu, R16), `testerStart` remplacé, `◆ Décider` conditionnel. Les tests de `EventQueue` migrent vers le journal. | ✅ |
| IV. Réutiliser | Inventaire, justification | Tableau du Summary. Abstractions justifiées : `ExchangeService` (journal, règles, plafonds : aucun équivalent, et `EventQueue` part) ; `WakeService` (minuteries et voies : `AgentManager` a 1000 lignes, y ajouter cela le rendrait illisible). | ✅ |
| V. Qualité | Lint, format, YAGNI | Pas de file par destinataire, pas de canal de fichiers, pas de configuration des plafonds. `urgent` n'existe que pour FR-017. | ✅ |

**Re-check post-design (Phase 1)** : aucune dépendance, 2 services, un champ de workspace, un champ d'agent. Couverture : logique pure et services hors UI sous le seuil de 80 %. ✅

## Project Structure

### Documentation (this feature)

```text
specs/007-agent-exchanges/
├── spec.md
├── plan.md
├── research.md          # R1–R17, dont le résultat de FR-012
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── mcp-tools.md
│   ├── hooks.md
│   └── ui.md
└── tasks.md
```

### Source Code (repository root)

```text
src/shared/
├── exchanges.ts                    # nouveau : schémas, constantes, typeOf, canSend, pointerText, isPointer
├── model.ts                        # exchanges, wakeNotice, TodoKind
├── ipc.ts, todo.ts, agents-view.ts
src/main/
├── orchestrator/exchange-service.ts # nouveau : journal, lecture, règles, plafonds, escalade
├── orchestrator/wake-service.ts     # nouveau : regroupement, voies, plafond, retenues
├── orchestrator/orchestrator-service.ts, events.ts (retiré), loop-service.ts, tools.ts, agent-tools.ts
├── agents/agent-manager.ts, agent-state.ts
├── agents/adapters/types.ts, claude-code.ts, fake.ts
├── ipc/orchestrator-handlers.ts, notifications.ts, index.ts
src/renderer/
├── todo/TodoItem.tsx, focus/FocusView.tsx, launch/PermissionsDialog.tsx, store/app-store.ts
resources/skills/                    # pact-contract.md et les skills de rôle
tests/
├── unit/shared/, unit/main/orchestrator/, unit/renderer/
├── integration/orchestrator/, integration/agents/
├── fixtures/fake-cli/
└── e2e/us30–us33
```

**Structure Decision**: mêmes dossiers que 003 et 004. La logique pure va dans `src/shared/`, partagée par les services et `deriveTodos`.

## Risques

| Risque | Parade |
|---|---|
| Mode interactif différent de `-p` pour les hooks | `midTurnWake` faux dans l'adapter : voie de fin de tour (FR-012) |
| Suivi des frappes trop prudent : invite vide vue comme occupée | Signal à 2 min ; Entrée sur l'invite remet à zéro |
| Une question trop longue tronquée au journal | `list_agents` rend `questions` en entier (R8) |
| Migration e2e de `send_prompt` | Le faux CLI lit le pointeur, les scénarios gardent leur sens (R16) |
| Agents de Codex en mode manuel : approbation des outils MCP, non vérifiable sans vrai CLI | Au pire, chaque `get_events` demande un accord à l'utilisateur ; rien n'est perdu |

## Complexity Tracking

Aucune violation.
