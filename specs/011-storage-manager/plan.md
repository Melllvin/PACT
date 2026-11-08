# Implementation Plan: Gestionnaire de stockage

**Branch**: `011-plan` (implémentation sur `011-storage-manager`, depuis `origin/main` ; la Phase 6 après la fusion de 008) | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/011-storage-manager/spec.md`

## Summary

Aujourd'hui, l'accueil compte les dossiers de `.worktrees/` (`countKeptWorktrees`, `workspace-service.ts:41`), et un
worktree ne se supprime qu'à la fermeture de son agent, par un chemin qui force (`GitService.removeWorktree`). 011 ajoute
un onglet « Stockage » dans un nouveau dialogue « Réglages ». Il couvre tous les projets qui ont un fichier dans
`workspaces/`. `StorageInventory` liste aussitôt les éléments, en lectures seules. `Sizer` remplit les tailles sans
bloquer, et s'arrête à la fermeture de la vue. `StorageService` prépare une confirmation qui annonce la perte avec une
empreinte, relit tout juste avant, puis supprime élément par élément. La propriété d'un élément se prouve par son chemin
résolu et par Git, à l'inventaire et de nouveau à la suppression. Après 008, « Nettoyer » préselectionne les worktrees
que `WorktreeCleanup.evaluate` dit sûrs, et un avis discret signale plus de 5 Go supprimables. Aucun outil d'agent ne
touche à tout cela.

| Besoin | Réutilisé | Ajouté |
|---|---|---|
| Projets | `openStores`, `workspaceSchema`, `WorkspaceService.list`, `state.recents` | `JsonFile.peek()` sans renommage (R7) |
| Worktrees, état Git | `GitService` (`run`, `entry`, `worktreeOf`, `revParse`), `EXCLUDE_LINE` | `readOnly` (`GIT_OPTIONAL_LOCKS=0`), `worktreeList`, `statusDetailed`, `unpushed`, `containingRemotes`, `lastChange`, `removeOwnedWorktree`, `prune` (R5, R11) |
| Agents, intégrations | `AgentManager.running`, `IntegrationService.pending`, `OrchestratorService.sessions`, `FreeTerminals` | accesseurs en lecture (`isRunning`, `busyIds`, `sessionIds`, `terminalsUnder`) |
| PR, fusion, sûr | 008 : `GhClient.prView`, `workspace.deliveries`, `WorktreeCleanup`, `deleteRemoteBranch` ; `issue.trace.pr` | `WorktreeCleanup.evaluate` sans effet (R14) |
| Dialogue | `dialog.tsx`, `tabs.tsx`, `checkbox.tsx`, `RoleProfilesDialog` (modèle) | `SettingsDialog`, `StoragePanel`, `RemovalDialog` |
| Accueil | `Home.tsx` (« worktrees conservés ») | bouton vers l'onglet filtré, ligne d'avis |
| Réglages persistés | `appStateSchema` et ses défauts | `storageNotice` |
| Tests | dépôts temporaires, `fake-gh.mjs`, `tests/e2e/helpers/a11y.ts` | fixture de pièges `tests/fixtures/storage/traps.ts` |

## Technical Context

**Language/Version**: inchangé : TypeScript 5.9 strict, Electron 44, Node 22 LTS, React 19.

**Primary Dependencies**: aucune nouvelle.

**Storage**: `state.json` gagne `storageNotice` (défaut). `pending-cleanup.json` sous `<userData>`, écrit par le seul
geste de suppression d'un cache et retiré au démarrage suivant. Tailles et états en mémoire, jamais écrits.

**Testing**: Vitest pour `src/shared/storage.ts` (propriété, totaux, pertes, empreinte, verdicts), `Sizer` (arborescence
temporaire, liens durs et symboliques, abandon), `StorageInventory` et `StorageService` sur dépôts Git temporaires avec
remote nu et pièges, contrat des commandes Git, handlers, renderer. Playwright Electron avec faux CLI et faux `gh` :
us70 à us79. Aucun vrai worktree supprimé.

**Target Platform**: macOS 13+ et Windows 10 1809+ / 11.

**Project Type**: desktop-app (Electron, main + preload + renderer).

**Performance Goals**: vue affichée en moins de 1 s avant la fin des tailles, avec 6 Go de worktrees (SC-001) ; boucle
d'événements jamais bloquée plus de 50 ms par le calcul ; « Nettoyer » en 3 gestes (SC-006).

**Constraints**: aucune écriture, aucun `fetch` pendant le calcul (FR-004) ; jamais `branch --merged` ni l'ascendance
(FR-015) ; aucun champ textuel d'une PR ; aucun chemin hors de ceux de R6 et R8 ; jamais `state.json`, `~/.claude`,
`~/.codex`, le dépôt principal ni `mainBranch` ; aucun outil d'agent ; aucune suppression sans confirmation.

**Scale/Scope**: 3 modules main (`inventory`, `sizer`, `storage-service`), 1 module partagé, 10 canaux IPC, 3 composants,
10 fichiers e2e. Une dizaine de projets, une vingtaine de worktrees de 750 Mo.

Aucun « NEEDS CLARIFICATION » : les points ouverts O1 à O9 de `research.md` ont une recommandation et ne bloquent aucune
phase.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe | Exigence | Comment le plan la satisfait | Statut |
|----------|----------|------------------------------|--------|
| I. Tests d'abord | Tests rouges avant le code | Chaque phase commence par ses tests, rouges et commités ; les pièges de SC-004 sont une fixture partagée posée en Phase 2. | ✅ |
| II. Merge sur tests verts | Suite complète, CI bloquante | Une PR par phase, fusionnée quand converge et CI verte. | ✅ |
| III. Zéro régression | Couverture non décroissante | `GitService.removeWorktree` et `close` restent inchangés ; `countKeptWorktrees` garde son sens ; aucun test existant retiré. | ✅ |
| IV. Réutiliser | Inventaire, justification | Tableau du Summary. Critères « sûr » pris à 008 par `evaluate`, pas recopiés. Abstractions nouvelles : `Sizer` (abandon et lots, testables seuls), `StorageInventory` (règles de propriété isolées, frontière de sécurité de US5). | ✅ |
| V. Qualité | Lint, format, YAGNI | Pas de cache persistant, pas de nettoyage périodique (FR-021), pas de `git gc`, pas de surveillance du disque. | ✅ |

**Re-check post-design (Phase 1)** : aucune dépendance, un champ de `state.json`, aucun champ de workspace. Couverture :
logique pure et services hors UI ≥ 80 %, UI ≥ 70 %. ✅

## Project Structure

### Documentation (this feature)

```text
specs/011-storage-manager/
├── spec.md
├── plan.md
├── research.md          # R1–R20, points ouverts O1–O9
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── ui.md
│   └── git.md
└── tasks.md
```

### Source Code (repository root)

```text
src/shared/
├── storage.ts                        # nouveau : schémas, owned, totals, lossOf, fingerprint, deletability
├── ipc.ts, model.ts
src/main/
├── storage/inventory.ts              # nouveau : projets, worktrees, éléments de <userData>
├── storage/sizer.ts                  # nouveau : parcours interruptible, liens durs
├── storage/storage-service.ts        # nouveau : vue, confirmation, suppression, prune, avis
├── ipc/storage-handlers.ts           # nouveau
├── git/git-service.ts                # readOnly, worktreeList, statusDetailed, unpushed, …, removeOwnedWorktree, prune
├── persistence/store.ts              # peek(), storageNotice
├── agents/agent-manager.ts, agents/free-terminals.ts, review/integration-service.ts, orchestrator/orchestrator-service.ts   # accesseurs en lecture
├── delivery/cleanup.ts               # (008) evaluate, Phase 6
├── index.ts                          # câblage, pending-cleanup.json, calcul à basse priorité
src/renderer/
├── settings/SettingsDialog.tsx, settings/StoragePanel.tsx, settings/RemovalDialog.tsx   # nouveaux
├── home/Home.tsx, app/App.tsx, store/app-store.ts
tests/
├── unit/shared/storage.test.ts, unit/main/storage/, unit/main/ipc/storage-handlers.test.ts, unit/renderer/settings/
├── integration/storage/
├── contract/storage-git.contract.test.ts
├── fixtures/storage/traps.ts
└── e2e/us70–us79
```

**Structure Decision**: un dossier `src/main/storage/`, isolé de `delivery/` : 011 lit 008, 008 ne dépend pas de 011.
Les règles pures vont dans `src/shared/storage.ts`, partagées par le main (décision) et le renderer (affichage).

## Risques

| Risque | Parade |
|---|---|
| Suppression d'un dossier qui n'est pas à PACT | Propriété double (chemin résolu + Git), relue juste avant ; pièges de SC-004 vérifiés dans chaque test d'action |
| Perte non annoncée | Empreinte de l'état confirmé, comparée juste avant ; `changed` sinon (SC-003) |
| Le calcul écrit l'index | `GIT_OPTIONAL_LOCKS=0` + `--no-optional-locks`, test d'empreinte de `.git` (SC-002), contrat des commandes |
| Interface figée sur 6 Go | Inventaire sans tailles d'abord, `setImmediate` par lots, e2e de SC-001 ; O6 en repli |
| Fichier verrouillé sous Windows | Échec rendu tel quel, sans `rm` en boucle ; `removeOwnedWorktree` distinct de `removeWorktree` |
| Texte d'un tiers affiché | Aucun champ textuel de `gh` ; sujet de commit seulement pour les commits locaux, rendu comme texte |
| Cache supprimé à chaud | Suppression au démarrage suivant (R12) |

## Complexity Tracking

Aucune violation.
