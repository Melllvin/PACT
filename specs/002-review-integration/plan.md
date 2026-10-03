# Implementation Plan: Revue et intégration

**Branch**: `002-review-integration` | **Date**: 2026-10-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-review-integration/spec.md`

## Summary

Activer l'onglet Changements du Focus et la vue Revue, laissés inactifs par le socle. La revue
compare la branche principale à un instantané du worktree de l'agent. Cet instantané est un arbre
git construit avec un index temporaire : il contient le commité, le non commité et le non suivi,
sans toucher l'index ni les fichiers de l'agent. La revue est suivie par `fs.watch` et relue par
`git diff`.

Les commentaires et les raccourcis passent par la file de saisie de `AgentManager`, qui n'écrit
dans le CLI qu'en `awaiting-prompt`.

L'intégration se calcule entièrement en objets git :
- `merge-tree --write-tree` sert à vérifier les conflits et à fusionner ;
- `commit-tree` crée le commit ;
- la branche principale ne bouge qu'à la toute fin : `merge --ff-only` là où elle est extraite,
  `update-ref` atomique sinon.

Une intégration annulée ou échouée ne laisse donc aucune trace. Les conflits se résolvent sur ces
objets (choix par zone, édition, éditeur externe) avant le même dernier pas. Les tests du dépôt
tournent dans le worktree de l'agent, à l'ouverture de la revue et à la demande.

## Technical Context

**Language/Version**: inchangé depuis 001 : TypeScript 5.9 strict, Electron 44, Node 22 LTS pour
l'outillage.

**Primary Dependencies**: inchangées. Seule addition : le composant shadcn `dropdown-menu`, une
primitive `radix-ui` déjà installée, ajouté par le CLI shadcn comme en R16 de 001.

**Storage**: JSON par workspace, champs ajoutés avec valeurs par défaut (research R9). Objets git
temporaires dans le dépôt, sans référence, que git nettoie lui-même. Copies de conflits dans
`userData/conflicts/<id>/`.

**Testing**: Vitest (unitaires purs : diff, conflits, consignes, résumé de tests), intégration sur
de vrais dépôts git temporaires, Playwright Electron avec le faux CLI étendu (R11).

**Target Platform**: macOS 13+ et Windows 10 1809+ / 11, git ≥ 2.40.

**Project Type**: desktop-app (Electron, main + preload + renderer).

**Performance Goals**:
- liste et premier diff en moins de 2 s pour 50 fichiers (SC-001) ;
- changement du worktree visible en moins de 3 s (SC-006) ;
- consigne dans l'invite en moins de 1 s (SC-004) ;
- diff de 5 000 lignes fluide, grâce à la virtualisation.

**Constraints**:
- la branche principale n'est modifiée qu'au dernier pas d'une intégration validée (SC-003) ;
- aucun push ;
- git appelé via `execFile` avec `LC_ALL=C`, jamais par un shell ;
- chemins relatifs validés côté IPC.

**Scale/Scope**: 6 agents au plus par workspace, revues de quelques dizaines à quelques centaines
de fichiers, 2 écrans (1h, 1q) et la vue Revue.

Aucun point « NEEDS CLARIFICATION » : tout est tranché dans [research.md](research.md) (R1 à R11)
et dans les clarifications de la spec.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe | Exigence | Comment le plan la satisfait | Statut |
|----------|----------|------------------------------|--------|
| I. Tests d'abord | Tests écrits et en échec avant le code | Chaque décision git (R1, R2, R4–R6) a sa suite d'intégration sur dépôts temporaires, écrite avant `ReviewService` / `IntegrationService`. Les fonctions pures (diff, conflits, consignes, résumé de tests) sont testées seules. Le faux CLI étendu (R11) rend chaque story testable en e2e. `tasks.md` mettra les tests en tête de chaque phase. | ✅ |
| II. Merge sur tests verts | Suite complète verte, CI bloquante | Inchangé : `check` + `e2e` sur macOS et Windows, coverage-guard | ✅ |
| III. Zéro régression | Couverture non décroissante, bug ⇒ test | Les canaux et schémas de 001 gardent leurs tests. Les nouveaux champs ont des valeurs par défaut testées sur un fichier JSON de 001. | ✅ |
| IV. Réutiliser | Inventaire, justification du nouveau | Réutilisés : `GitService` (étendu, pas doublé), file `retype` de `AgentManager` (généralisée en FIFO), surveillance de `WorkspaceService` (même schéma rafale + filet), `terminal-registry` (même xterm que la tuile), `FocusView` et `AgentPills`, `TodoColumn` (remplacée en place), `agent:close` pour l'abandon, shell de connexion de 001 R3 pour les tests, primitives shadcn existantes. Nouveaux : `ReviewService`, `IntegrationService`, `TestRunner` (aucun équivalent) et `src/shared/diff.ts` (aucun parseur existant). | ✅ |
| V. Qualité | Lint, format, simplicité | Aucune dépendance nouvelle hors `dropdown-menu` (primitive déjà présente). Pas de coloration syntaxique, pas d'éditeur de code (YAGNI, R6, R10). | ✅ |

**Re-check post-design (Phase 1)** : data-model, contrats et quickstart n'ajoutent ni dépendance ni
couche. Les trois services du main suivent le schéma des services de 001 (injection de `git`,
`stores`, `workspaces`). ✅ Aucun écart, Complexity Tracking vide.

## Project Structure

### Documentation (this feature)

```text
specs/002-review-integration/
├── plan.md              # Ce fichier
├── research.md          # Phase 0 (R1–R11)
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   └── ipc.md           # Canaux ajoutés à src/shared/ipc.ts
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── main/
│   ├── git/git-service.ts            # + snapshot, diff, merge-tree, commit-tree, ff/update-ref (R1, R2, R4, R5)
│   ├── review/
│   │   ├── review-service.ts         # Instantanés, suivi du worktree, vus, commentaires, badge (R1–R3, R9)
│   │   ├── integration-service.ts    # File par workspace, états, conflits, dernier pas (R4–R6)
│   │   └── test-runner.ts            # Détection et exécution des tests (R8)
│   ├── agents/agent-manager.ts       # retype → file FIFO de consignes, collage entre crochets (R7)
│   └── ipc/review-handlers.ts        # Canaux de contracts/ipc.md
├── shared/
│   ├── model.ts                      # Agent.review, Workspace.testCommand
│   ├── review.ts                     # ReviewSnapshot, FileDiff, TestRun, Integration (zod)
│   ├── diff.ts                       # parseUnifiedDiff (pur)
│   ├── conflicts.ts                  # Zones de conflit, application des choix (pur)
│   ├── review-prompts.ts             # Textes des consignes (pur)
│   └── ipc.ts                        # + canaux et événements
└── renderer/
    ├── review/
    │   ├── ChangesTab.tsx            # Liste + diff + terminal (1h)
    │   ├── FileList.tsx
    │   ├── DiffView.tsx              # Virtualisé, commentaires sur ligne
    │   ├── DecisionColumn.tsx        # Tests, conflits, non vus, Intégrer ▾, Renvoyer, Abandonner
    │   ├── ConflictsTab.tsx          # Écran 1q
    │   └── review-store.ts           # État zustand de la revue
    ├── components/ui/dropdown-menu.tsx
    ├── focus/FocusView.tsx           # Onglet Changements actif
    ├── app/Toolbar.tsx               # Vue Revue active + badge
    └── tiles/TileActions.tsx, todo/TodoItem.tsx   # « Revue → »

tests/
├── unit/shared/                      # diff, conflicts, review-prompts
├── unit/main/review/                 # services avec git simulé (cas d'erreur)
├── integration/review/               # vrais dépôts : snapshot, diff, merge-tree, intégration, résolution, tests
├── unit/renderer/review/             # composants (rôles, clavier, états)
├── e2e/us8-…us12-*.spec.ts           # US1–US5 de 002
└── fixtures/fake-cli/                # + étapes write / delete / rename / commit
```

**Structure Decision**: même projet Electron que 001. Un dossier `review/` dans `main` et dans
`renderer` regroupe le nouveau domaine. `GitService` reste l'unique point d'appel à git
(Constitution IV).

## Complexity Tracking

Aucun écart à justifier.
