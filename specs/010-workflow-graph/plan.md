# Implementation Plan: Workflow configurable en graphe

**Branch**: `010-plan` (implémentation sur `010-workflow-graph`, depuis `origin/main` une fois 008 fusionnée) | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/010-workflow-graph/spec.md`

## Summary

La chaîne de 004 est écrite dans le skill orchestrateur, et PACT ne sait pas où en est une issue. 010 la décrit dans
`.pact/workflow.yaml`, fichier déclaratif versionné, lu sur la branche principale à jour, jamais dans un worktree. Le
fichier liste les agents (rôle, CLI, modèle), les étapes typées (`spec`, `design`, `test`, `dev`, `polish`, `pr`,
`recap`) avec une consigne libre, et les transitions. Chaque transition réagit à un résultat typé, et un plafond de
tours ferme chaque boucle. `WorkflowService` tient une exécution par issue, avec la version figée au démarrage et
l'étape en cours. Il avance sur les messages du journal de 007 et réveille l'orchestrateur par un message `stage`. Il
envoie aussi la consigne de l'étape. L'étape PR est la livraison de 008. Le plafond, les passes et le mode de fusion
viennent du workflow, et non plus de `workspace.delivery`. Sans fichier, un défaut tiré des réglages de 008 se comporte
comme aujourd'hui. Une vue « Workflow » édite le graphe à la souris et au clavier, sans bibliothèque de graphes, et
montre la forme texte. Un enregistrement crée une branche et une PR sans verdict de 008, toujours relue. Parallèle et
conditions sont lus et conservés, jamais exécutés.

| Besoin | Réutilisé | Ajouté |
|---|---|---|
| Lecture du fichier sur `main` | `GitService.entry`, `readBlob`, `fetchRefs` (008) | `WorkflowSource` (R10) |
| Parse, lignes, édition sans perte | — | dépendance `yaml` ; `parseWorkflow`, `writeWorkflow` (R3, R13) |
| Validation | `MAX_AGENTS`, `beyondCeiling`, `tierOf`, `profilesOf` (`roles.ts`), `MAX_ROUNDS_LIMIT`, `MAX_POLISH` (008) | `validateWorkflow`, `machineCheck` purs (R6) |
| Défaut équivalent | `workspace.delivery` (008) | `defaultWorkflow`, `ignoredLocal` (R11) |
| État par issue | `workspaces.update`, défauts Zod, `IssueService.register` | `workspace.runs`, `workspace.workflow` |
| Avance sur les événements | `ExchangeService.onRecorded`, `typeOf`, `WakeService` (007) | `outcomeOf` pur, kind `stage` (R5, R8) |
| Consigne d'étape | `instruction` de 007, consignes fixes de 007 FR-021 et 008 R23 | composition (R9) |
| Boucles et plafond | `LoopService` (`round`, `reopen`, escalade de 008) | dépendance `maxRounds(ws, issue)` (R7) |
| Étape PR | `request_delivery`, `DeliveryService`, PR sans verdict, `delivery-local` (008) | `source: 'workflow'`, `agentId` nullable (R12) |
| Commit sans worktree | `writeBlob`, `replaceInTree`, `commitWithHooks` (`IntegrationService`) | `WorkflowSaver` (R12) |
| Barrières des outils | `Refusal`, `start_loop`, `polish_pass`, `request_delivery`, `launch_agent` | `get_workflow`, `advance_stage` (R15) |
| Éditeur | rendu de 006 R6 (boutons + `svg`), `Toolbar`, `RoleProfiles` (selects), axe | `WorkflowView`, `workflowLayout` pur (R14) |
| Skill | `pact-orchestrator/SKILL.md`, `skills-content.test.ts` | section « Workflow » (R16) |

## Technical Context

**Language/Version**: inchangé : TypeScript 5.9 strict, Electron 44, Node 22 LTS, React 19.

**Primary Dependencies**: une nouvelle, `yaml` (2.x, ISC, sans dépendance), justifiée en research R3. Aucune
bibliothèque de graphes.

**Storage**: `workspace.workflow` et `workspace.runs` dans l'état JSON, avec défauts. Le workflow lui-même vit dans le
dépôt (`.pact/workflow.yaml`), écrit seulement par une PR.

**Testing**: Vitest (parse, écriture sans perte sur jeux de fichiers, validation par code d'erreur, `machineCheck`,
`defaultWorkflow`, `outcomeOf`, `workflowLayout`, `WorkflowService` sur journal factice, `WorkflowSaver` sur dépôts Git
temporaires avec remote nu et faux `gh`, handlers, renderer). Playwright Electron avec faux CLI et faux `gh` : us60 à
us69. Aucun vrai CLI ni `gh`.

**Target Platform**: macOS 13+ et Windows 10 1809+ / 11.

**Project Type**: desktop-app (Electron, main + preload + renderer).

**Performance Goals**: validation et disposition sous 50 ms pour 20 étapes (à chaque frappe de l'éditeur) ; transition
d'étape écrite et message `stage` enregistré sous 1 s après le message source ; SC-002 (2 minutes) vérifié à la main
(quickstart).

**Constraints**: aucun code exécutable dans le fichier ; aucune lecture d'un worktree pour la version qui fait foi ;
aucune écriture du fichier hors PR ; aucune écriture sans changement ; seconde phase jamais exécutée, jamais perdue ;
aucun résultat de PACT (`accepted`, CI, `merged`) déclarable par l'orchestrateur ; 009 sans effet sur l'étape.

**Scale/Scope**: 2 services (`WorkflowService`, `WorkflowSaver`), 1 source (`WorkflowSource`), 2 modules partagés, 2
outils MCP, 5 outils modifiés, 1 kind de journal, 2 `TodoKind`, 4 canaux IPC, 1 vue, 10 fichiers e2e. Au plus 20
étapes, 6 agents, une exécution par issue.

Aucun « NEEDS CLARIFICATION ». Les points laissés à la relecture sont dans
[research.md](research.md#points-ouverts-non-bloquants-recommandation-donnée), chacun avec une recommandation.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe | Exigence | Comment le plan la satisfait | Statut |
|----------|----------|------------------------------|--------|
| I. Tests d'abord | Tests rouges avant le code | Chaque phase commence par ses tests, rouges et commités ; jeux de fichiers valides et invalides écrits avant le parseur. | ✅ |
| II. Merge sur tests verts | Suite complète, CI bloquante | Une PR par phase, depuis `010-workflow-graph`. | ✅ |
| III. Zéro régression | Couverture non décroissante, changements documentés | Changements documentés : `workspace.delivery` (hors `auto`) n'est plus lu avec un fichier ; « Enregistrer » des réglages de livraison crée une PR ; `start_loop`, `polish_pass`, `request_delivery` refusent hors étape ; le skill perd son ordre écrit. Sans fichier, tous les e2e de 004 à 009 passent sans changement (SC-001, Phase 3). | ✅ |
| IV. Réutiliser | Inventaire, justification | Tableau du Summary. Abstractions justifiées : `WorkflowService` (état par issue dans la durée, aucun équivalent : `LoopService` ne connaît que la boucle) ; `WorkflowSaver` (commit sans worktree et voie de PR : réutilise les primitives de `IntegrationService` et `DeliveryService`, sans les dupliquer) ; `WorkflowSource` (lecture du blob de `main`, partagée par le service, l'éditeur et les outils). Dépendance `yaml` justifiée (R3). | ✅ |
| V. Qualité | Lint, format, YAGNI | Pas d'éditeur de texte embarqué, pas de glisser pour relier, pas de bibliothèque de graphes, pas d'exécution de la seconde phase, pas de plusieurs workflows. | ✅ |

**Re-check post-design (Phase 1)** : une dépendance justifiée, deux champs de workspace, un kind, deux champs de
`Delivery`. Logique pure et services hors UI couverts à 80 % au moins, UI à 70 %. ✅

## Project Structure

### Documentation (this feature)

```text
specs/010-workflow-graph/
├── spec.md
├── plan.md
├── research.md          # R1–R18, points ouverts O1–O7
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── workflow-file.md # format, erreurs, écriture sans perte
│   ├── mcp-tools.md     # get_workflow, advance_stage, outils modifiés, kind stage
│   └── ui.md            # vue Workflow, clavier, IPC
└── tasks.md
```

### Source Code (repository root)

```text
src/shared/
├── workflow.ts                        # nouveau : schémas, constantes, outcomesOf, outcomeOf, validateWorkflow,
│                                      #   machineCheck, defaultWorkflow, ignoredLocal, equalWorkflows, nextStages
├── workflow-yaml.ts                   # nouveau : parseWorkflow (lignes), writeWorkflow (sans perte)
├── workflow-layout.ts                 # nouveau : workflowLayout (pur)
├── model.ts, exchanges.ts, delivery.ts, ipc.ts, todo.ts, agents-view.ts
src/main/
├── workflow/workflow-source.ts        # nouveau : blob de main, lastValid, error
├── workflow/workflow-service.ts       # nouveau : exécutions, transitions, kind stage, consignes
├── workflow/workflow-saver.ts         # nouveau : commit sans worktree, PR sans verdict ou fusion locale
├── orchestrator/tools.ts, loop-service.ts, issues.ts
├── delivery/delivery-service.ts       # source workflow, mergeMode par exécution, garde du fichier
├── review/integration-service.ts      # branche sans agent (voie locale)
├── ipc/workflow-handlers.ts           # nouveau
├── index.ts
src/renderer/
├── workflow/WorkflowView.tsx          # nouveau : en-tête, liste, graphe, panneau, texte
├── workflow/StagePanel.tsx            # nouveau
├── workflow/WorkflowGraph.tsx         # nouveau : nœuds boutons + svg aria-hidden
├── app/Toolbar.tsx, delivery/DeliverySettingsDialog.tsx, todo/TodoItem.tsx, store/app-store.ts
resources/skills/pact-orchestrator/SKILL.md
tests/
├── unit/shared/, unit/main/workflow/, unit/main/orchestrator/, unit/renderer/workflow/
├── integration/workflow/
├── fixtures/workflows/{valid,invalid}/, fixtures/fake-cli/scenarios/workflow-*.json
└── e2e/us60–us69
```

**Structure Decision**: un dossier `src/main/workflow/` pour ce qui tient l'état d'exécution et écrit le fichier,
séparé de `orchestrator/` (outils) et `delivery/` (forge). La logique pure va dans `src/shared/`, partagée par le
moteur, les outils, l'éditeur et `deriveTodos`.

## Risques

| Risque | Parade |
|---|---|
| Double compteur de tours avec 008 | Le compteur de l'étape `dev` est `loop.round` ; le moteur ne compte que les autres cycles (R7), test de cohérence |
| Écriture qui perd un commentaire ou un nœud de seconde phase | Édition du `Document` en place (R13), test de propriété sur tous les fichiers valides, SC-003 et SC-005 en e2e |
| Orchestrateur qui saute une barrière | `advance_stage` limité aux étapes sans agent sur `done` ; résultats de PACT jamais déclarables (R15) |
| Message traité deux fois après un redémarrage | `lastMessageId`, état écrit avant l'effet (R8) |
| Un agent change le workflow dans sa branche | Version lue sur `main` seulement (R10) ; relecture forcée de sa livraison (R17) |
| 008 pas encore fusionnée | Base `origin/main` après 008 (R1) ; les Phases 1–2 n'en dépendent que par les schémas |
| Éditeur inaccessible au clavier | Tout geste passe aussi par la liste et le panneau ; e2e au clavier seul et audit axe (us65) |

## Complexity Tracking

Aucune violation. La dépendance `yaml` est justifiée en research R3 (constitution, contraintes techniques).
