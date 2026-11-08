# Implementation Plan: Livraison automatique

**Branch**: `008-plan` (implémentation sur `008-delivery-auto`, depuis `origin/main` une fois 007 fusionnée, sinon depuis `origin/007-agent-exchanges`) | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/008-delivery-auto/spec.md`

## Summary

`request_integration` fusionne dans le `main` local, sans `fetch`, ni push, ni PR, ni CI. 008 le remplace par une
demande de livraison. `request_delivery` (orchestrateur) ou « Livrer » (utilisateur) exige un verdict `accepted` et la
preuve de PACT sur le commit exact du dev, propre, avec les tests du testeur. Puis `DeliveryService` enchaîne `fetch`
limité, recalage dans un worktree temporaire, tests, push avec bail et PR par `gh`. Il suit ensuite la CI sans agent.
La fusion se fait avec `--match-head-commit`, par Auto ou par Valider, jamais avec `--auto`. Chaque résultat réveille
l'orchestrateur par le journal de 007. L'état est persisté à chaque étape. Après la fusion, PACT ferme les agents, passe
l'issue à `done` et retire les worktrees sans contenu unique. Il ne lit de la forge que des données de structure.

| Besoin | Réutilisé | Ajouté |
|---|---|---|
| Barrières | `LoopService.outsideTests` (007 R12), `git.entry`, `snapshot`, `treeOf` | `verdict.commit`, `proof.commit`, `deliveryGate` pur |
| Recalage | worktree temporaire de `IntegrationService`, `mergeBase`, `moveWorktree` | `GitService.rebaseOnto`, `fetchRefs` |
| Tests | `ReviewService.testPlan`, `TestRunner.run` | preuve sur commit |
| Push, PR, CI, fusion | `ghCommand` (`issues.ts`), `fake-gh.mjs` | `GhClient`, `CiWatcher`, `ciVerdict` |
| Persistance | `workspaces.update`, défauts Zod | `workspace.deliveries`, `workspace.delivery` |
| Réveil | `ExchangeService.record`, `typeOf`, `WakeService` | kind `delivery` |
| Défauts au dev | message `verdict` de 007 R14, `LoopService.next` | tour ouvert par la CI, le refus, le recalage |
| À faire | `deriveTodos`, `TodoItem.tsx`, `NOTIFIED` | 5 `TodoKind` (data-model) |
| Fusion locale | `IntegrationService` | `requestId`, `restore()` des conflits |
| Nettoyage | `GitService.removeWorktree`, `close` | `WorktreeCleanup`, statut `--ignored` |
| Réglages | `RoleProfilesDialog` (modèle de dialogue) | `DeliverySettingsDialog`, `DeliveryBar` |

## Technical Context

**Language/Version**: inchangé : TypeScript 5.9 strict, Electron 44, Node 22 LTS, React 19.

**Primary Dependencies**: aucune nouvelle. `gh` de l'utilisateur, déjà requis par 004 pour publier les issues.

**Storage**: `workspace.deliveries` et `workspace.delivery` dans l'état JSON, avec défauts. Conflits locaux en
`<userData>/integrations/<id>.json` (R19). Worktrees de recalage sous `<userData>/deliveries/<id>`, retirés après.

**Testing**: Vitest (schémas, `ciVerdict`, `deliveryGate`, `DeliveryService` sur dépôts Git temporaires avec un remote
nu et le faux `gh`, `CiWatcher` avec horloge factice, `WorktreeCleanup`, handlers, renderer). Playwright Electron avec
faux CLI et faux `gh` (us50 à us57). Aucun vrai `gh` ni accès réseau dans les tests.

**Target Platform**: macOS 13+ et Windows 10 1809+ / 11.

**Project Type**: desktop-app (Electron, main + preload + renderer).

**Performance Goals**: de la demande acceptée à la PR, aucun geste (SC-003) ; un changement d'Auto pris à la lecture
suivante, 30 s au plus (SC-004).

**Constraints**: jamais `--auto` ; jamais de champ textuel de la forge ; jamais `pr list` ni recherche par branche ;
`fetch` limité ; aucun agent ne pousse ni ne fusionne ; aucune suppression forcée sans geste ; rien de 009 requis.

**Scale/Scope**: 3 services (`DeliveryService`, `CiWatcher`, `WorktreeCleanup`), 1 client (`GhClient`), 1 module
partagé, 3 outils MCP (dont 1 d'agent), 5 `TodoKind`, 5 canaux IPC, 8 fichiers e2e. 6 agents, une livraison par dev.

Aucun « NEEDS CLARIFICATION » : les points ouverts de `research.md` ont une recommandation et ne bloquent aucune phase.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe | Exigence | Comment le plan la satisfait | Statut |
|----------|----------|------------------------------|--------|
| I. Tests d'abord | Tests rouges avant le code | Chaque phase commence par ses tests, rouges et commités. | ✅ |
| II. Merge sur tests verts | Suite complète, CI bloquante | Une PR par phase. Sans CI dans un projet, la preuve de PACT sur R tient lieu de suite verte. | ✅ |
| III. Zéro régression | Couverture non décroissante, changements documentés | Changements documentés : `request_integration` retiré (ses tests migrent vers `request_delivery`), `passed` → `accepted` puis `merged`, issue `done` à la fusion, plafond configurable. `us15-orchestrator-integrate` migre sans `skip`. | ✅ |
| IV. Réutiliser | Inventaire, justification | Tableau du Summary. Abstractions justifiées : `DeliveryService` (état externe dans la durée, R2), `CiWatcher` (minuterie sans agent, isolée pour l'horloge factice), `GhClient` (liste fermée d'appels, frontière de sécurité de US7), `WorktreeCleanup` (règles de suppression, reprises par 011). | ✅ |
| V. Qualité | Lint, format, YAGNI | Pas de webhook, pas de support d'autre forge, pas de file de PR, pas de création de CI. | ✅ |

**Re-check post-design (Phase 1)** : aucune dépendance, deux champs de workspace, `Loop` étendue. Couverture : logique
pure et services hors UI ≥ 80 %, UI ≥ 70 %. ✅

## Project Structure

### Documentation (this feature)

```text
specs/008-delivery-auto/
├── spec.md
├── plan.md
├── research.md          # R1–R25, points ouverts P1–P6
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── mcp-tools.md
│   ├── gh.md
│   └── ui.md
└── tasks.md
```

### Source Code (repository root)

```text
src/shared/
├── delivery.ts                       # nouveau : schémas, constantes, ciVerdict, deliveryGate, prBody
├── model.ts, report.ts, exchanges.ts, orchestrator.ts, ipc.ts, todo.ts, agents-view.ts
src/main/
├── delivery/delivery-service.ts      # nouveau : cycle de la demande
├── delivery/gh-client.ts             # nouveau : appels fermés de contracts/gh.md
├── delivery/ci-watcher.ts            # nouveau : lecture périodique
├── delivery/cleanup.ts               # nouveau : WorktreeCleanup
├── orchestrator/loop-service.ts, tools.ts, agent-tools.ts, integration-requests.ts (retiré)
├── review/integration-service.ts     # requestId, persistance des conflits
├── git/git-service.ts                # fetchRefs, rebaseOnto, pushBranch, deleteRemoteBranch, statusIgnored
├── agents/agent-manager.ts           # fermeture : boucle et livraison
├── ipc/delivery-handlers.ts          # nouveau
├── notifications.ts, index.ts
src/renderer/
├── delivery/DeliveryBar.tsx, DeliverySettingsDialog.tsx   # nouveaux
├── todo/TodoItem.tsx, tiles/TileActions.tsx, tiles/CloseAgentDialog.tsx, store/app-store.ts
resources/skills/                     # pact-contract.md, pact-orchestrator, pact-dev, pact-test
tests/
├── unit/shared/, unit/main/delivery/, unit/main/orchestrator/, unit/renderer/
├── integration/delivery/, integration/orchestrator/, integration/review/
├── contract/gh-client.contract.test.ts
├── fixtures/fake-cli/fake-gh.mjs, scenarios/
└── e2e/us50–us57
```

**Structure Decision**: un dossier `src/main/delivery/` pour ce qui parle à la forge, isolé de `orchestrator/` et
`review/`. La logique pure va dans `src/shared/delivery.ts`, partagée par les services et `deriveTodos`.

## Risques

| Risque | Parade |
|---|---|
| Fusion à tort sur `main` | `--match-head-commit`, relecture de l'auteur, du fork, de la tête et du login juste avant (FR-031), table de vérité de `ciVerdict` testée en entier |
| Une option `gh` change de sens selon la version | Contrat de `GhClient` testé ; `gh --version` noté dans l'alerte en cas d'échec de parsing |
| Recalage qui perd un commit | Rejeu dans un worktree temporaire, jamais dans celui du dev ; R gardé dans `pactCommits` ; push avec bail |
| Suppression à tort d'un worktree | Conditions relues juste avant, `worktree remove` sans `--force`, `.env*` gardé, SC-010 testé |
| Redémarrage pendant `merging` | État écrit avant l'appel ; à la reprise, `pr view` dit `MERGED` ou non avant tout nouvel appel |
| Contenu de tiers via un nom de check | borné, nettoyé, présenté comme donnée ; test témoin |

## Complexity Tracking

Aucune violation.
