# Implementation Plan: Orchestrateur

**Branch**: `003-orchestrator` | **Date**: 2026-10-31 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-orchestrator/spec.md`

## Summary

Un agent Claude Code lancé avec l'option « Orchestrateur » reçoit, pour sa seule session, un plugin
Claude Code écrit par PACT (`--plugin-dir`). Ce plugin apporte :
- le skill `pact:orchestrateur`, qui décrit la méthode ;
- un serveur MCP `pact` en HTTP local, protégé par un jeton propre à la session (research R1 à R3).

Les outils MCP de ce serveur couvrent la spec. Chacun réutilise un service existant :

| Outil | Service réutilisé |
|---|---|
| Consignes | file de `AgentManager.sendPrompt` (002 R7) |
| État et changements | `ReviewService` et `TestRunner` (002) |
| Lancer, fermer | `AgentManager.launch` et `close` (001) |
| Intégration | demande persistée, que seule la confirmation de l'utilisateur transmet à `IntegrationService` (002) |

Une attente longue tenue par PACT réveille l'orchestrateur au premier changement d'état (R5).

Côté interface :
- disposition « chef au centre » ;
- marque « ◎ de l'orchestrateur » sur les tuiles qui reçoivent une consigne ;
- demandes d'intégration dans À faire ;
- onglet « ◎ Actions » et « Retirer le rôle » dans le Focus de l'orchestrateur.

## Technical Context

**Language/Version**: inchangé depuis 001 : TypeScript 5.9 strict, Electron 44, Node 22 LTS.

**Primary Dependencies**: inchangées. Le protocole MCP (quatre méthodes JSON-RPC) est écrit dans
PACT plutôt que d'ajouter le SDK MCP (R1).

**Storage**: JSON par workspace :
- `Agent.role` et `Workspace.integrationRequests` sont ajoutés avec des valeurs par défaut, sans
  migration ;
- le plugin de session est écrit dans `userData/orchestrator/<agentId>/plugin/`.

**Testing**: Vitest (protocole, outils, plugin, adaptateur), intégration avec le faux CLI et de vrais
dépôts, Playwright Electron avec un faux orchestrateur (nouvelle étape `mcp` du faux CLI),
caractérisation sur un vrai Claude Code.

**Target Platform**: macOS 13+ et Windows 10 1809+ / 11 ; Claude Code 2.1+ pour l'orchestrateur.

**Project Type**: desktop-app (Electron, main + preload + renderer).

**Performance Goals**:
- consigne de l'orchestrateur dans l'invite d'un agent prêt en moins de 1 s (SC-001) ;
- réveil de l'attente en moins de 2 s après une fin de tour (SC-002).

**Constraints**:
- la branche principale ne bouge jamais sans confirmation de l'utilisateur (SC-003) ;
- l'accès est local, réservé à l'orchestrateur, révocable (SC-004) ;
- rien n'est écrit dans `~/.claude` ni dans le dépôt ;
- l'orchestrateur ne supprime jamais de worktree ni de branche.

**Scale/Scope**: un orchestrateur par workspace, au plus 5 agents dirigés, 9 outils MCP, 3 canaux IPC
de requête et 3 d'événements.

Aucun point « NEEDS CLARIFICATION » : tout est tranché dans [research.md](research.md) et les
clarifications de la spec. Un seul comportement reste à caractériser sur une vraie session :
`MCP_TOOL_TIMEOUT` pour un serveur HTTP (R5).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe | Exigence | Comment le plan la satisfait | Statut |
|----------|----------|------------------------------|--------|
| I. Tests d'abord | Tests écrits et en échec avant le code | Chaque décision a ses tests rouges avant le code : protocole, sécurité, outils, plugin, attente et demandes d'intégration. Le faux CLI gagne l'étape `mcp`, qui rend chaque story testable de bout en bout. `tasks.md` met les tests en tête de chaque phase. | ✅ |
| II. Merge sur tests verts | Suite complète verte, CI bloquante | Inchangé : `check` et `e2e` sur macOS et Windows, `coverage-guard` | ✅ |
| III. Zéro régression | Couverture non décroissante, bug ⇒ test | Les nouveaux champs ont des valeurs par défaut, testées sur des fichiers de 002. Le `HookServer` est étendu sans changer ses réponses aux hooks : ses tests restent. | ✅ |
| IV. Réutiliser | Inventaire, justification du nouveau | **Réutilisés** : `HookServer` (étendu à `/mcp`), file de consignes d'`AgentManager` (ajout d'une origine), `AgentManager.launch` et `close`, `PermissionService.resolve`, `ReviewService`, `TestRunner`, `IntegrationService`, `deriveTodos` (nouveau type d'élément), `TileGrid`, `FocusView`, paramètres de session de `ClaudeCodeAdapter`. **Nouveaux** : `OrchestratorService` (rôle, sessions, événements, journal), `src/main/orchestrator/mcp.ts` (protocole, pur), `src/main/orchestrator/plugin.ts` (écriture du plugin) ; aucun équivalent existant. | ✅ |
| V. Qualité | Lint, format, simplicité | Aucune dépendance nouvelle. Pas de SDK MCP, pas de flux serveur (pas de `GET`/SSE). Le journal reste en mémoire. | ✅ |

**Re-check post-design (Phase 1)** : le data-model, les deux contrats et le quickstart n'ajoutent ni
dépendance ni couche. `OrchestratorService` suit le schéma des services de 002 : injection de
`agents`, `review`, `tests`, `workspaces` et `hooks`. ✅ Aucun écart, Complexity Tracking vide.

## Project Structure

### Documentation (this feature)

```text
specs/003-orchestrator/
├── plan.md              # Ce fichier
├── research.md          # Phase 0 (R1–R11)
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── mcp-tools.md     # Outils du serveur MCP « pact »
│   └── ipc.md           # Canaux ajoutés à src/shared/ipc.ts
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── main/
│   ├── agents/
│   │   ├── hook-server.ts            # + route /mcp, statut choisi par le gestionnaire, Host/Origin (R1, R3)
│   │   ├── agent-manager.ts          # + origine des consignes, retrait par origine, rôle au lancement (R4, R8)
│   │   └── adapters/
│   │       ├── types.ts              # + supportsOrchestrator, entrée orchestrateur de LaunchInput
│   │       ├── claude-code.ts        # + --plugin-dir, règle mcp__plugin_pact_pact__*, --append-system-prompt (R2)
│   │       └── fake.ts               # + URL et jeton de l'orchestrateur dans l'environnement (R8, R11)
│   ├── orchestrator/
│   │   ├── mcp.ts                    # JSON-RPC MCP minimal (pur) (R1)
│   │   ├── tools.ts                  # Schémas et exécution des 9 outils (contracts/mcp-tools.md)
│   │   ├── plugin.ts                 # plugin.json, SKILL.md, .mcp.json (R2)
│   │   └── orchestrator-service.ts   # Sessions, jetons, événements, attente, demandes, journal (R3–R9)
│   └── ipc/orchestrator-handlers.ts  # Canaux de contracts/ipc.md
├── shared/
│   ├── model.ts                      # Agent.role, Workspace.integrationRequests, brouillon orchestrator
│   ├── orchestrator.ts               # OrchestratorEvent, OrchestratorAction, IntegrationRequest (zod)
│   ├── todo.ts                       # + élément integration-request
│   └── ipc.ts                        # + canaux et événements
└── renderer/
    ├── launch/QuickLaunch.tsx, DetailedLaunch.tsx   # Option « Orchestrateur »
    ├── tiles/TileGrid.tsx, Tile.tsx                # Chef au centre, marque ◎ (R10, R4)
    ├── todo/TodoItem.tsx                           # Demande d'intégration
    ├── focus/FocusView.tsx                         # Onglet « ◎ Actions », Retirer le rôle
    └── store/app-store.ts                          # Rôle, demandes, marques, journal

tests/
├── unit/main/orchestrator/          # mcp, tools, plugin
├── contract/claude-code…            # arguments et paramètres de l'orchestrateur
├── integration/orchestrator/        # OrchestratorService contre le faux CLI et de vrais dépôts
├── unit/renderer/…                  # lanceur, grille, À faire, Focus
├── e2e/us13-…us17-*.spec.ts         # US1–US5 de 003
└── fixtures/fake-cli/               # + étape mcp
```

**Structure Decision**: même projet Electron. Un dossier `orchestrator/` dans `main` regroupe le
nouveau domaine. `HookServer` reste l'unique serveur local (Constitution IV).

## Complexity Tracking

Aucun écart à justifier.
