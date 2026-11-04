# Implementation Plan: Vue des agents

**Branch**: `006-agents-view` | **Date**: 2026-11-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/006-agents-view/spec.md`

## Summary

La colonne « À faire » devient « Agents » : les éléments À faire existants restent calculés par
`deriveTodos` et sont regroupés en une ligne par agent, plus les éléments qui ne visent pas un agent
seul. Les tuiles des sous-agents apparaissent dès leur lancement (événement `workspace:agentsLaunched`,
correctif de PR #39) dans une grille qui tient à 1024 × 768. Une vue « Graphe » en lecture seule montre
l'orchestrateur, ses agents et les boucles dev ↔ test de 004, dessinée sans dépendance.

| Besoin | Réutilisé | Ajouté |
|---|---|---|
| Éléments à traiter | `deriveTodos`, `TodoItem`, ordre `ORDER` (`src/shared/todo.ts`) | `agentRows()` : regroupe par agent (R1) |
| Colonne | `TodoColumn`, `TodoItem.tsx` (actions, styles), bouton « À faire » de la barre | `AgentsColumn`, `AgentRow` (R2) |
| Tuiles | `TileGrid` disposition `lead` (004 FR-006a) | grille 3 colonnes, orchestrateur 2×2, 3×2 cases visibles, défilement vertical, « + » si place libre (R3, #40 #41 #47) |
| Apparition des tuiles | `workspace:agentsLaunched` (PR #39) | — |
| Lien de lancement | `launch_agent` (003), `agentSchema` | champ `launchedBy` (R4) |
| Issue, phase, tour | `Loop` (004 : `issueId`, `devAgentId`, `testAgentId`, `round`, `state`), `Agent.role` | `agentPhase()` (R5) |
| Graphe | barre « Vues » (`Toolbar`, `View`), Focus, couleurs d'agent et d'état | `GraphView`, `graphLayout()` (R6) |
| Accessibilité | rôles ARIA des tuiles | audit `@axe-core/playwright` en e2e (R7) |

## Technical Context

**Language/Version**: inchangé : TypeScript 5.9 strict, Electron 44, Node 22 LTS, React 19.

**Primary Dependencies**: aucune en production. En développement : `@axe-core/playwright` (SC-006, R7).

**Storage**: `Agent.launchedBy: string | null` dans l'état JSON des workspaces, défaut `null` (aucune
migration). Lignes, nœuds, liens et phases : dérivés, jamais stockés.

**Testing**: Vitest (`agentRows`, `agentPhase`, `graphLayout`, schéma, `launch_agent` qui pose
`launchedBy`), tests renderer (colonne, ligne, graphe, clavier), Playwright Electron avec le faux CLI
(orchestrateur qui lance des agents, boucle, états), `layout.spec` à 1024 × 768, audit axe.

**Target Platform**: macOS 13+ et Windows 10 1809+ / 11.

**Project Type**: desktop-app (Electron, main + preload + renderer).

**Performance Goals**: ligne, tuile et nœud à jour < 1 s après l'événement (SC-002, SC-003) ; les
données sont déjà dans le store, le calcul est en O(agents) (≤ 6).

**Constraints**: aucune nouvelle action sur les agents ; graphe en lecture seule ; pas de défilement
horizontal à 1024 px ; les terminaux libres ne sont ni des lignes ni des nœuds.

**Scale/Scope**: 1 champ persisté, 3 fonctions pures, 3 composants, 1 vue, 0 canal IPC nouveau.

Aucun « NEEDS CLARIFICATION ».

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe | Exigence | Comment le plan la satisfait | Statut |
|----------|----------|------------------------------|--------|
| I. Tests d'abord | Tests rouges avant le code | Chaque story commence par ses tests : fonctions pures, composants, puis e2e faux CLI. | ✅ |
| II. Merge sur tests verts | Suite complète, CI bloquante | Inchangé ; une PR par phase. | ✅ |
| III. Zéro régression | Couverture non décroissante | Les tests de « À faire » restent (actions, ordre) et sont adaptés au nouveau nom ; `launchedBy` a un défaut, aucun état existant ne casse. | ✅ |
| IV. Réutiliser | Inventaire, justification | Tableau du Summary. `deriveTodos` reste la seule source des actions dues ; `agentRows` ne fait que regrouper. Nouveau sans équivalent : `graphLayout`, `GraphView`. | ✅ |
| V. Qualité | Lint, format, YAGNI | Pas de bibliothèque de graphes (≤ 6 nœuds, disposition fixe) ; pas d'édition, pas de zoom. Seule dépendance : axe en dev, exigée par SC-006. | ✅ |

**Re-check post-design (Phase 1)** : un champ, aucun canal IPC, une vue. ✅

## Project Structure

### Documentation (this feature)

```text
specs/006-agents-view/
├── plan.md
├── research.md          # R1–R7
├── data-model.md
├── quickstart.md
├── contracts/
│   └── ui.md            # colonne, ligne, graphe : rôles, noms accessibles, libellés
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── shared/
│   ├── model.ts                     # + Agent.launchedBy
│   ├── todo.ts                      # inchangé (source des actions dues)
│   └── agents-view.ts               # agentRows(), agentPhase(), agentStateLabel() (purs)
├── main/
│   ├── agents/agent-manager.ts      # + LaunchRequest.launchedBy → Agent
│   └── orchestrator/tools.ts        # launch_agent : launchedBy = orchestrateur
└── renderer/
    ├── agents/AgentsColumn.tsx      # remplace todo/TodoColumn.tsx
    ├── agents/AgentRow.tsx          # ligne d'agent, actions de ses TodoItem
    ├── todo/TodoItem.tsx            # réutilisé pour les éléments sans agent
    ├── tiles/TileGrid.tsx           # grille 3×2 visible, orchestrateur 2×2, défilement (R3)
    ├── graph/graph-layout.ts        # positions des nœuds et liens (pur)
    ├── graph/GraphView.tsx          # nœuds (boutons), liens (SVG décoratif)
    ├── app/Toolbar.tsx              # + « Graphe » ; « À faire » → « Agents »
    └── store/app-store.ts           # View + 'graph'

tests/
├── unit/shared/agents-view.test.ts
├── unit/renderer/agents/AgentsColumn.test.tsx, AgentRow.test.tsx
├── unit/renderer/graph/graph-layout.test.ts, GraphView.test.tsx
├── integration/orchestrator/tools-launch.test.ts   # launchedBy
├── e2e/us28-agents-column.spec.ts, us29-lead-tiles.spec.ts, us30-graph.spec.ts
└── e2e/layout.spec.ts                               # + orchestrateur et 5 agents à 1024 × 768
```

**Structure Decision**: même projet ; la logique de regroupement et de phase est pure dans `shared/`
pour être testée sans DOM et partagée entre colonne et graphe.

## Complexity Tracking

Aucune violation.
