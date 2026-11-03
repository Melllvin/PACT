# Implementation Plan: Chaîne de livraison

**Branch**: `004-delivery-chain` | **Date**: 2026-11-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-delivery-chain/spec.md`

## Summary

004 étend l'orchestrateur de 003 en chaîne de livraison : rôles et profils de modèles, skills par
rôle livrés à chaque agent selon son CLI, rapport de relais, boucle dev ↔ test plafonnée et prouvée par
les tests que PACT lance, issues locales publiées sur confirmation, onglet Aperçu isolé pour les
maquettes et le recap, et une tuile d'orchestrateur toujours la plus grande.

Tout passe par ce que 003 a posé :

| Besoin | Réutilisé | Ajouté |
|---|---|---|
| Rôles | `Agent.role` (003) | valeurs `spec`, `design`, `dev`, `test`, `recap` (R1) |
| Profils | lanceur 001, `CliAdapter.listModels` | `Workspace.roleProfiles`, `modelTiers()` (R2) |
| Skills | plugin de session de 003 (`--plugin-dir`) | suite `resources/skills/`, voies Codex et générique (R3) |
| Orchestrateur Codex | serveur MCP et jetons de 003 | arguments `-c mcp_servers.pact…` (R4) |
| Rapport | serveur MCP, `EventQueue` (003) | jeton d'agent, outil `submit_report` (R5) |
| Boucle et preuve | `TestRunner`, `GitService.snapshot` (002) | `LoopService`, outils `start_loop`, `next_round` (R6) |
| Fichiers communs | `ReviewService.readChanges` (002) | comparaison des chemins, événement `overlap` (R7) |
| Issues | demande confirmée de 003 R6, À faire | `.pact/issues/`, `register_issue`, `publish_issues` (R8) |
| Aperçu | onglet grisé du Focus (001), suivi du worktree (002 R3) | protocole `pact-preview:`, iframe isolée (R9) |
| Recap | Aperçu | skill `pact-recap`, `.pact/recap.md` (R10) |
| Tuile du chef | `TileGrid` « chef au centre » (003 R10) | règle de grille, bande « Rapports » (R11) |

## Technical Context

**Language/Version**: inchangé : TypeScript 5.9 strict, Electron 44, Node 22 LTS.

**Primary Dependencies**: inchangées, sauf `marked` (rendu Markdown du recap et des issues dans
l'Aperçu, sans dépendance transitive ; voir Complexity Tracking).

**Storage**: JSON par workspace, nouveaux champs avec valeurs par défaut, sans migration :
`Workspace.roleProfiles`, `Workspace.issues`, `Workspace.loops`, `Workspace.testPaths`,
`Workspace.publishRequests`. Skills de session dans `userData/roles/<agentId>/`. Fichiers de la chaîne
dans le worktree : `.pact/issues/*.md`, `.pact/recap.md`, `design/` (contracts/files.md).

**Testing**: Vitest (schémas, profils, paliers, validation du rapport, boucle, voies de skills,
protocole d'Aperçu), intégration avec le faux CLI et de vrais dépôts, Playwright Electron (nouvelles
étapes du faux CLI : `report`, écriture de tests, maquette), contrat des adaptateurs (arguments Claude
Code et Codex), caractérisation sur vrais CLI.

**Target Platform**: macOS 13+ et Windows 10 1809+ / 11 ; Claude Code 2.1+, Codex 0.163+.

**Project Type**: desktop-app (Electron, main + preload + renderer).

**Performance Goals**: décision sur maquette à l'orchestrateur < 1 s, Aperçu rafraîchi < 2 s
(SC-004) ; rapport validé et transmis < 1 s.

**Constraints**:
- aucun fichier de configuration personnelle des CLI créé ou modifié (SC-007) ;
- aucune requête réseau depuis l'Aperçu (SC-005) ;
- aucun 4ᵉ tour sans décision de l'utilisateur (SC-001) ;
- « faite » seulement après un run de tests PACT à 0 sur le tree courant (SC-002) ;
- rien n'est publié (issues, push, PR) sans confirmation.

**Scale/Scope**: 6 rôles, 6 agents au plus, 3 tours par boucle, 7 skills + 1 contrat, 6 outils MCP
ajoutés (contracts/mcp-tools.md), 5 canaux IPC de requête et 3 d'événements (contracts/ipc.md).

Aucun « NEEDS CLARIFICATION » : tout est tranché dans [research.md](research.md). Restent à
caractériser sur de vrais CLI : orchestrateur et `developer_instructions` sous Codex (R3, R4),
`--effort` de Claude Code (R2).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe | Exigence | Comment le plan la satisfait | Statut |
|----------|----------|------------------------------|--------|
| I. Tests d'abord | Tests rouges avant le code | Chaque story commence par ses tests : schémas et profils, validation du rapport, boucle (faux CLI qui échoue toujours, qui réussit au 2ᵉ tour), voies de skills, isolement de l'Aperçu, grille. Les étapes du faux CLI rendent chaque story testable de bout en bout. | ✅ |
| II. Merge sur tests verts | Suite complète, CI bloquante | Inchangé : `check`, `e2e` macOS et Windows, `coverage-guard` ; une PR par phase. | ✅ |
| III. Zéro régression | Couverture non décroissante | Nouveaux champs à valeurs par défaut testés sur des fichiers de 003 ; `orchestrator: true` du brouillon de 003 reste accepté ; les tests de `TileGrid` de 003 restent, la règle FR-006a s'y ajoute. | ✅ |
| IV. Réutiliser | Inventaire, justification | Voir le tableau du Summary. **Nouveaux** sans équivalent : `LoopService` (boucles, tours, preuve), `RoleSkills` (copie et voies des skills), protocole `pact-preview:` ; tous injectés comme les services de 002 et 003. | ✅ |
| V. Qualité | Lint, format, YAGNI | Une dépendance (`marked`), justifiée. Le recap et les issues sont rédigés par les skills, pas par du code. Pas de moteur de workflow, pas d'API GitHub (on passe par `gh`). | ✅ |

**Re-check post-design (Phase 1)** : data-model, contrats et quickstart n'ajoutent ni couche ni
dépendance au-delà de `marked`. Les outils MCP suivent la forme de 003 (refus avec raison, texte puis
JSON). ✅

## Project Structure

### Documentation (this feature)

```text
specs/004-delivery-chain/
├── plan.md              # Ce fichier
├── research.md          # Phase 0 (R1–R12)
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── mcp-tools.md     # Outils ajoutés ou étendus du serveur « pact »
│   ├── ipc.md           # Canaux ajoutés à src/shared/ipc.ts
│   ├── handoff-report.md# Rapport de relais (submit_report)
│   ├── skills.md        # Suite de skills, contrat commun, voies par CLI
│   └── files.md         # .pact/issues, .pact/recap.md, design/
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
resources/skills/                       # pact-orchestrator, pact-spec, pact-design-system, pact-mockup,
│                                       # pact-dev, pact-test, pact-recap (SKILL.md) + pact-contract.md
src/
├── main/
│   ├── agents/
│   │   ├── agent-manager.ts            # + rôle et profil au lancement, escalade au tour 3 (R1, R2)
│   │   └── adapters/
│   │       ├── types.ts                # + modelTiers, effort, LaunchInput.role (skills, MCP d'agent)
│   │       ├── claude-code.ts          # + --effort, plugin de rôle (R3)
│   │       ├── codex.ts                # + supportsOrchestrator, -c mcp_servers / developer_instructions / model_reasoning_effort (R3, R4)
│   │       ├── generic.ts              # + .pact/ROLE.md et première consigne (R3)
│   │       └── fake.ts                 # + rôle et URL MCP d'agent dans l'environnement
│   ├── orchestrator/
│   │   ├── plugin.ts                   # généralisé : plugin de rôle (R3)
│   │   ├── role-skills.ts              # copie des skills par agent, voies par CLI, nettoyage (R3)
│   │   ├── tools.ts                    # + submit_report, start_loop, next_round, get_loop, register_issue, publish_issues ; launch_agent + role/model (contracts/mcp-tools.md)
│   │   ├── loop-service.ts             # boucles, tours, rapports, preuve, testeur indépendant (R5, R6)
│   │   └── orchestrator-service.ts     # + jetons d'agent, événements report / report-missing / overlap / mockup / loop
│   ├── review/review-service.ts        # + recoupement des chemins entre agents (R7)
│   ├── preview/preview-protocol.ts     # protocole pact-preview:, CSP, blocage réseau (R9)
│   └── ipc/orchestrator-handlers.ts    # + profils, boucles, publication, décisions d'Aperçu
├── shared/
│   ├── model.ts                        # rôles, RoleProfile, Issue, Loop, testPaths, publishRequests
│   ├── roles.ts                        # profils par défaut, paliers, plafond (pur)
│   ├── report.ts                       # schéma du rapport de relais (zod)
│   ├── todo.ts                         # + loop-escalated, overlap, publish-issues
│   └── ipc.ts
└── renderer/
    ├── launch/                         # choix du rôle, pré-remplissage par profil
    ├── settings/RoleProfiles.tsx       # réglage des profils, avertissement test < dev
    ├── tiles/TileGrid.tsx, Tile.tsx    # chef toujours le plus grand, rôle, « tour N/3 », bande Rapports
    ├── focus/FocusView.tsx, PreviewTab.tsx, ReportsTab.tsx
    ├── todo/TodoItem.tsx               # boucle escaladée, fichiers communs, publication d'issues
    └── store/app-store.ts

tests/
├── unit/shared/roles.test.ts, report.test.ts
├── unit/main/orchestrator/role-skills.test.ts, loop-service.test.ts
├── contract/claude-code…, codex…       # arguments de rôle, d'effort, d'orchestrateur
├── integration/orchestrator/loops.test.ts, reports.test.ts, issues.test.ts, skills-delivery.test.ts
├── integration/preview/preview-protocol.test.ts
├── unit/renderer/…                     # grille, lanceur, profils, Aperçu, À faire
├── e2e/us18-…us23-*.spec.ts            # US1–US6 de 004
└── fixtures/fake-cli/                  # + étapes report, writeTests, writeProd, scénarios de boucle
```

**Structure Decision**: même projet Electron. Les services de la chaîne restent dans
`main/orchestrator/` (ils servent l'orchestrateur) ; l'Aperçu a son dossier `main/preview/` car il sert
aussi hors orchestration. Les skills sont des ressources livrées avec l'application, comme le pont de
hooks de 001.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Dépendance `marked` | Rendu Markdown du recap et des issues dans l'Aperçu (FR-025) | Écrire un parseur Markdown : plus de code et de bugs ; afficher le texte brut : ne répond pas à FR-025 |
| Protocole Electron `pact-preview:` | Servir les seuls fichiers du worktree avec une CSP stricte (FR-026) | `file://` ouvre tout le disque ; un serveur HTTP local ouvrirait un port de plus |
