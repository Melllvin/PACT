# Implementation Plan: Socle — workspaces, agents et terminaux

**Branch**: `001-agent-workspace-core` | **Date**: 2026-09-23 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-agent-workspace-core/spec.md`

## Summary

Application de bureau Electron (macOS + Windows) qui ouvre des dépôts Git en onglets et y lance
jusqu'à 6 agents CLI (Claude Code, Codex, autres), chacun dans son worktree `.worktrees/<nom>`,
sur sa branche, avec son port (3000 + position) et sa couleur. Les CLI tournent dans de vrais PTY
(node-pty) affichés bruts dans des tuiles xterm.js. L'état des agents (attend, en cours, erreur…)
vient des hooks natifs des CLI relayés vers un serveur HTTP local, avec un repli heuristique ; il
alimente les bordures, la colonne À faire et les indicateurs d'onglet. Tout le comportement risqué
(PTY, états, reprise) est développé en TDD contre un faux CLI scriptable.

## Technical Context

**Language/Version**: TypeScript 5.9 (strict ; TS 7 incompatible avec typescript-eslint, R12) ; Node 22 LTS pour l'outillage ; runtime Electron 44.x

**Primary Dependencies**: Electron 44, electron-vite 5, React 19, Zustand 5, node-pty 1.1,
@xterm/xterm 6 (+ addons fit, webgl, serialize, unicode11, web-links), zod, electron-builder 26 ;
interface : shadcn/ui (primitives `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`,
`lucide-react`) sur Tailwind CSS 4.3 (`@tailwindcss/vite`, `tw-animate-css`) (research.md R16) ;
effets 1c : `DotGrid` de React Bits (variante TS + Tailwind) et `gsap` 3.15 (research.md R15)

**Storage**: fichiers JSON validés par zod dans `userData` (research.md R9) ; état Git dans le
dépôt lui-même (`.worktrees/`, `.git/info/exclude`)

**Testing**: Vitest 5 (+ @vitest/coverage-v8, Testing Library, jsdom), Playwright 1.63 pour
Electron, faux CLI `tests/fixtures/fake-cli`

**Target Platform**: macOS 13+ (arm64, x64) et Windows 10 1809+ / 11 (x64, arm64)

**Project Type**: desktop-app (Electron : processus main + preload + renderer)

**Performance Goals**: saisie terminal < 100 ms perçus avec 6 agents actifs (SC-002) ; changement
d'état visible dans À faire < 2 s (SC-003) ; UI à 60 fps pendant les animations

**Constraints**: CLI affichés bruts (aucune surcouche dans les terminaux) ; fonctionnement hors
ligne hormis les CLI eux-mêmes ; aucune modification de la branche principale (FR-039) ; sécurité
Electron (contextIsolation, sandbox, IPC validé)

**Scale/Scope**: 1 utilisateur, ~5 workspaces ouverts, ≤ 6 agents + terminaux libres par
workspace ; ~10 écrans (1a, 1b, 1c, 1d, 1m, 1e, 1f, 1l, 1n, 1p)

Aucun point « NEEDS CLARIFICATION » restant : tous résolus dans [research.md](research.md).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principe | Exigence | Comment le plan la satisfait | Statut |
|----------|----------|------------------------------|--------|
| I. Tests d'abord | Tests écrits et en échec avant le code | Faux CLI (R13) et dépôts Git temporaires rendent chaque story testable avant implémentation ; `tasks.md` placera les tests en premier dans chaque phase | ✅ |
| II. Merge sur tests verts | Suite complète verte, CI bloquante | GitHub Actions macOS + Windows (`check`, `e2e`), protection de branche sur `main` (R12) | ✅ |
| III. Zéro régression | Test de reproduction par bug, couverture non décroissante | Seuils de couverture chiffrés (80 % main/shared, 70 % renderer) appliqués en CI ; suite de contrat commune aux adaptateurs | ✅ |
| IV. Réutiliser | Inventaire du réutilisé, justification du nouveau | Projet vierge : aucun code interne à réutiliser. Réutilisé : node-pty, xterm.js, CLI `git`, hooks natifs des CLI, zod pour IPC et persistance (un seul schéma pour les deux). Aucune abstraction interne créée sans deuxième usage, sauf `CliAdapter` (3 implémentations dès le socle) | ✅ |
| V. Qualité | Lint, format, simplicité | ESLint 10 + Prettier 3 + TS strict dans `npm run check` ; pas de SQLite, pas de framework d'état lourd, pas de routeur (YAGNI) | ✅ |

**Outillage à inscrire dans la constitution** (amendement 1.1.0, via `/speckit-constitution`) :
Vitest + Playwright, ESLint + Prettier, seuils de couverture ci-dessus, CI macOS + Windows.

**Re-check amendements R15 et R16 (2026-09-24, React Bits, shadcn/ui + Tailwind)** : la stack de
référence de la constitution (Electron + TypeScript strict + React) est inchangée ; Tailwind et
shadcn sont des dépendances d'interface, justifiées ci-dessous, pas un changement de stack.

| Principe | Effet de l'amendement | Statut |
|----------|-----------------------|--------|
| I. Tests d'abord | Enrobages d'effets testés avant écriture (mouvement réduit, tokens, absence dans les tuiles), `gsap` simulé ; rendu vérifié par captures Playwright | ✅ |
| I. Tests d'abord (R16) | Chaque composant shadcn entre par un test du comportement attendu (rôle, clavier, focus) ; risques CSP et preflight couverts par un test en échec avant installation | ✅ |
| II. Merge sur tests verts | Inchangé ; les captures entrent dans `npm run test:e2e` | ✅ |
| III. Zéro régression | Couverture : le code React Bits copié tel quel ne se teste pas sous jsdom (canvas). Exclusion proposée, **soumise à l'accord de l'utilisateur** (Complexity Tracking) | ⚠️ |
| IV. Réutiliser | Reprend un effet existant (`DotGrid`) et des composants accessibles existants (shadcn/Radix) au lieu de les réécrire ; tokens R10 conservés comme thème ; `use-dialog-keys` et les dialogues faits main disparaissent à la migration (pas de double implémentation durable) | ✅ |
| V. Qualité (R16) | Huit dépendances d'interface, toutes MIT / Apache-2.0 / ISC, maintenues, sans équivalent dans le projet (R16) ; le code shadcn copié suit notre lint et nos tests | ✅ |
| V. Qualité | Une dépendance (`gsap`), justifiée : aucun équivalent dans le projet, maintenue (3.15, 2026), licence gratuite y compris commerciale (non OSI, R15). React Bits : MIT + Commons Clause, usage dans l'app permis | ✅ |

**Re-check post-design (Phase 1)** : data-model, contrats et quickstart n'introduisent ni nouvelle
dépendance ni nouvelle couche. ✅ Aucun écart. Depuis l'amendement R15, Complexity Tracking
contient trois lignes, dont une soumise à l'accord de l'utilisateur ; data-model et contrats sont
inchangés.

## Project Structure

### Documentation (this feature)

```text
specs/001-agent-workspace-core/
├── plan.md              # Ce fichier
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── cli-adapter.md   # Contrat des adaptateurs de CLI
│   └── ipc.md           # Canaux IPC main ↔ renderer
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── main/                         # Processus principal Electron (Node)
│   ├── index.ts                  # Création fenêtre, cycle de vie
│   ├── env/shell-env.ts          # Environnement du shell de connexion (R3)
│   ├── git/git-service.ts        # Worktrees, branches, clone, exclude (R7)
│   ├── agents/
│   │   ├── adapters/             # types.ts, claude-code.ts, codex.ts, generic.ts
│   │   ├── agent-manager.ts      # Cycle de vie, machine à états (data-model)
│   │   ├── hook-server.ts        # Serveur HTTP local des hooks (R4)
│   │   └── auto-resume.ts        # Reprise après limite de débit (R6)
│   ├── pty/pty-manager.ts        # node-pty, tampons, regroupement de sortie (R2)
│   ├── ports/port-allocator.ts   # R8
│   ├── persistence/store.ts      # JSON + zod, écriture atomique (R9)
│   └── ipc/handlers.ts           # Implémente contracts/ipc.md
├── preload/index.ts              # window.pact typé
├── shared/
│   ├── model.ts                  # Types + schémas zod (data-model)
│   ├── ipc.ts                    # Schémas des canaux
│   └── todo.ts                   # Dérivation des éléments À faire (pure)
└── renderer/
    ├── app/                      # Barre d'onglets, barre d'outils, légende
    ├── home/                     # Accueil (1a)
    ├── workspace/                # État vide (1b), grille de tuiles (1e/1f/1l/1n)
    ├── launch/                   # Mode rapide (1c), détaillé (1d), autorisations (1m)
    ├── tiles/                    # Tuile, bordure, actions, terminal xterm
    ├── todo/                     # Colonne À faire
    ├── focus/                    # Focus (1p), pastilles
    ├── components/ui/            # Composants shadcn/ui copiés (R16), testés et lintés comme le reste
    ├── lib/utils.ts              # cn() : clsx + tailwind-merge (R16)
    ├── effects/                  # Grille de points, particules, pulse (R15)
    │   └── vendor/react-bits/    # Composants React Bits copiés (DotGrid), en-tête origine + licence
    ├── store/                    # Zustand
    └── theme/globals.css         # Tailwind v4 + @theme : tokens 1c (R10, R16), remplace tokens.css

tests/
├── unit/                         # Vitest (main, shared, renderer)
├── integration/                  # Git réel + PTY avec faux CLI
├── contract/                     # Suite commune CliAdapter
├── e2e/                          # Playwright Electron
└── fixtures/fake-cli/            # Faux CLI + scénarios JSON

docs/maquettes/                   # Maquettes de référence
components.json                   # Configuration du CLI shadcn (R16)
.github/workflows/ci.yml          # Matrice macOS + Windows
```

**Structure Decision**: projet unique Electron découpé par processus (`main`, `preload`,
`renderer`, `shared`), convention electron-vite. Pas de monorepo ni de paquets séparés tant
qu'une seule application existe (Constitution V).

## Complexity Tracking

| Écart | Pourquoi | Alternative plus simple écartée parce que |
|-------|----------|-------------------------------------------|
| Exclure `src/renderer/effects/vendor/**` de la couverture et du lint (**proposé, à valider par l'utilisateur avant toute modification de configuration**) | Code tiers copié tel quel : canvas + `gsap` non exécutables sous jsdom, style non conforme à nos règles strictes (`exactOptionalPropertyTypes`, lint) ; le réécrire à nos règles en ferait du code maison | Le tester sous jsdom exigerait de simuler tout le canvas pour une couverture sans valeur ; le réécrire annule l'intérêt de la bibliothèque. Les enrobages dans `effects/` restent couverts et soumis au seuil de 70 % |
| CSS Modules et Tailwind coexistent pendant la migration (R16) | Migration écran par écran, sous tests, plutôt qu'une réécriture d'un bloc | Tout migrer d'un coup casserait tous les écrans en même temps ; la coexistence prend fin avec les tâches de migration (T141), aucun nouvel écran n'utilise de CSS Module |
| Dépendance `gsap` pour un seul effet | Exigée par `DotGrid` (inertie au survol) | La grille en canvas maison (R10) reste le repli si l'utilisateur refuse l'exclusion ci-dessus ou la licence `gsap` |
