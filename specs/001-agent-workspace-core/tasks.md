---

description: "Tâches d'implémentation du socle 001 — workspaces, agents et terminaux"
---

# Tasks: Socle — workspaces, agents et terminaux

**Input**: Design documents from `/specs/001-agent-workspace-core/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: OBLIGATOIRES (Constitution I — tests d'abord, non négociable). Dans chaque phase, les
tâches de test précèdent l'implémentation ; elles DOIVENT être exécutées et échouer (Red) avant
d'écrire le code qui les fait passer (Green), puis refactor. `npm run check` DOIT être vert à la
fin de chaque phase (Constitution II, III).

**Organization**: tâches groupées par user story (spec.md US1…US7) pour livrer et tester chaque
story indépendamment.

## Format: `[ID] [P?] [Story] Description`

- **[P]** : parallélisable (fichiers différents, aucune dépendance sur une tâche non terminée)
- **[Story]** : user story concernée (US1…US7)
- Chemins relatifs à la racine du dépôt, structure de plan.md (Electron : `src/main`,
  `src/preload`, `src/shared`, `src/renderer`, `tests/`)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: initialiser le projet Electron + outillage imposé par la constitution 1.1.0

- [x] T001 Créer `package.json` (nom `pact`, `"private": true`, `"type": "module"`, `engines.node >=22`, `main: out/main/index.js`) avec les scripts `dev` (electron-vite dev), `build` (electron-vite build), `typecheck` (tsc -b), `lint` (eslint .), `format` / `format:check` (prettier), `test` (vitest run), `coverage` (vitest run --coverage), `check` (typecheck && lint && format:check && coverage), `test:e2e` (build puis playwright test), `dist` (electron-builder), `postinstall` (electron-rebuild -f -w node-pty)
- [x] T002 Installer les dépendances épinglées de research.md : runtime `electron@44`, `react@19`, `react-dom@19`, `zustand@5`, `zod`, `node-pty@1.1`, `@xterm/xterm@6`, `@xterm/addon-fit`, `@xterm/addon-webgl`, `@xterm/addon-serialize`, `@xterm/addon-unicode11`, `@xterm/addon-web-links` ; dev `typescript@5.9`, `electron-vite@5`, `vite@7`, `@vitejs/plugin-react`, `vitest@5`, `@vitest/coverage-v8@5`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@playwright/test@1.63`, `eslint@10`, `typescript-eslint`, `eslint-plugin-react-hooks`, `prettier@3`, `electron-builder@26`, `@electron/rebuild` ; vérifier que `npm ci` recompile node-pty sur la machine (package.json, package-lock.json)
- [x] T003 Configurer TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) avec références de projet : `tsconfig.json`, `tsconfig.node.json` (main, preload, shared, tests node), `tsconfig.web.json` (renderer, shared, jsx react-jsx)
- [x] T004 Configurer electron-vite avec les entrées `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `node-pty` en externe, alias `@shared` → `src/shared` dans `electron.vite.config.ts`
- [x] T005 [P] Configurer ESLint flat config (typescript-eslint strict-type-checked, react-hooks, interdiction de `any` explicite) et Prettier (largeur 100) dans `eslint.config.js`, `.prettierrc.json`, `.prettierignore`
- [x] T006 [P] Configurer Vitest avec deux projets (`main` : environnement node, fichiers `tests/unit/main/**`, `tests/unit/shared/**`, `tests/integration/**`, `tests/contract/**` ; `renderer` : jsdom, `tests/unit/renderer/**`) et la couverture v8 avec seuils constitutionnels : 80 % lignes/branches sur `src/main/**`, `src/shared/**`, `src/preload/**` ; 70 % sur `src/renderer/**` dans `vitest.config.ts`
- [x] T007 [P] Configurer Playwright pour Electron (`_electron.launch` sur `out/main/index.js`, variable `PACT_TEST_MODE=1`, dossier `userData` temporaire par test, 1 worker, traces en échec) dans `playwright.config.ts` et `tests/e2e/helpers/launch-app.ts`
- [x] T008 [P] Ajouter `.gitattributes` (`* text=auto eol=lf`, `*.png binary`) et compléter `.gitignore` (`node_modules/`, `out/`, `dist/`, `coverage/`, `test-results/`, `playwright-report/`)
- [x] T009 [P] Configurer electron-builder : `.dmg` universel (arm64 + x64) pour macOS, NSIS x64 + arm64 pour Windows, `asarUnpack` pour `node_modules/node-pty/**`, signature désactivée dans `electron-builder.yml`
- [x] T010 Créer la CI GitHub Actions : matrice `macos-latest` × `windows-latest`, Node 22, cache npm, job `check` (`npm ci && npm run check`) et job `e2e` (`npm run test:e2e`, `xvfb` inutile sur ces OS), upload des rapports en échec dans `.github/workflows/ci.yml`
- [x] T011 Écrire les tests de fumée (échouent) — répartis par processus : `tests/unit/main/window.test.ts`, `tests/unit/main/test-mode.test.ts`, `tests/unit/preload/preload.test.ts`, `tests/unit/renderer/app/App.test.tsx` (un test dans `tests/unit/shared/` ne peut pas couvrir le squelette main/preload/renderer), puis créer le squelette minimal qui le fait passer : `src/main/index.ts` (BrowserWindow 1440×900, `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, titre « PACT »), `src/preload/index.ts` (expose `window.pact = {}`), `src/renderer/index.html` (CSP stricte `default-src 'self'`), `src/renderer/main.tsx`, `src/renderer/app/App.tsx` ; `npm run check` vert
- [x] T012 Écrire le test e2e `tests/e2e/smoke.spec.ts` (l'app démarre, une fenêtre titrée « PACT » s'affiche, aucune erreur console) et le faire passer ; `npm run test:e2e` vert en local

**Checkpoint**: projet qui démarre, `check` et `test:e2e` verts, CI prête

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: briques partagées par toutes les stories (modèle, persistance, environnement, Git,
ports, PTY, hooks, adaptateurs, IPC, thème). **Aucune story ne commence avant la fin de cette
phase.**

### Doublure de test (prérequis du TDD)

- [x] T013 Créer le faux CLI `tests/fixtures/fake-cli/fake-cli.mjs` piloté par `FAKE_CLI_SCENARIO` (chemin d'un JSON) : affiche une invite `> `, lit la consigne sur stdin, émet des lignes de travail, pose une question d'autorisation (`? Exécuter : <cmd>` puis attend `allow`/`deny` selon les touches de `answerKeys`), appelle les hooks via HTTP POST sur `PACT_HOOK_URL` avec l'en-tête `x-pact-token: $PACT_AGENT_TOKEN`, sort avec un code donné, imprime un message de limite de débit avec heure de levée, renomme sa branche (`git branch -m`), accepte `--session-id <uuid>` et `--resume <uuid>` ; test d'auto-validation `tests/unit/fixtures/fake-cli.test.ts`
- [x] T014 [P] Écrire les scénarios `tests/fixtures/fake-cli/scenarios/prompt-then-done.json`, `ask-permission.json`, `crash-exit-1.json`, `rate-limit.json` (processus terminé, heure de levée), `rate-limit-alive.json` (processus vivant, attend « continue »), `rate-limit-native-resume.json` (émet la notification `quota_auto_resume_fired`), `rename-branch.json`, `burst-output.json` (sortie rapide continue, pour la performance)

### Tests des fondations (écrire d'abord, doivent échouer)

- [x] T015 [P] Tests des schémas du modèle : `Agent.position` 1..6 ; `color` ∈ `purple | cyan | green | magenta | yellow | slate` ; `permissionLevel` ∈ `always-allow | ask-sensitive | always-ask` ; `PermissionPreference.autoResume` booléen défaut `true`, `scope` ∈ `project | global` ; `CliDefinition.status` ∈ `installed | missing | unsupported-version` ; `RecentProject` « 20 entrées max » ; `Workspace.agents` « 0 à 6 » dans `tests/unit/shared/model.test.ts`
- [x] T016 [P] Tests des schémas IPC (chaque canal de contracts/ipc.md accepte les entrées valides, rejette les invalides, erreurs au format `{ code, message }`) dans `tests/unit/shared/ipc.test.ts`
- [x] T017 [P] Tests de persistance : écriture atomique (fichier temporaire + renommage), relecture validée par zod, fichier corrompu ou `schemaVersion` inconnu → valeurs par défaut sans crash, séparation `state.json` / `workspaces/<hash>.json` dans `tests/unit/main/persistence/store.test.ts`
- [x] T018 [P] Tests de l'environnement shell : parse la sortie de `$SHELL -ilc env`, délai max 3 s puis repli sur `process.env`, résultat mis en cache, sous Windows retourne `process.env` sans lancer de shell dans `tests/unit/main/env/shell-env.test.ts`
- [x] T019 [P] Tests de résolution de commande : `which` / `where.exe` ; `.cmd` / `.bat` lancés via `cmd.exe /d /s /c "<chemin>" <args>` ; `.exe` direct ; échappement des arguments avec espaces, guillemets et caractères accentués (« Développement ») dans `tests/unit/main/env/resolve-command.test.ts`
- [x] T020 [P] Tests d'intégration Git sur dépôts temporaires réels : `isRepo`, `currentBranch`, `initRepo`, `addWorktree` (`git worktree add -b agent/<cli>-<n> .worktrees/<cli>-<n> <base>`), suffixe ajouté si la branche existe déjà sans l'écraser, ajout idempotent de `/.worktrees/` dans `.git/info/exclude` (jamais dans `.gitignore`), `git status` du dépôt principal propre après création, branche actuelle d'un worktree, `removeWorktree` + `git branch -D`, `clone` depuis un dépôt bare local avec progression, avertissement si modifications non commitées, chemins avec espaces et accents dans `tests/integration/git/git-service.test.ts`
- [x] T021 [P] Tests de l'allocateur de ports : position N → 3000 + N ; port occupé (serveur ouvert en test sur `127.0.0.1` ou `::1`) → premier port libre suivant au-delà de 3006 ; pas de doublon dans un workspace dans `tests/unit/main/ports/port-allocator.test.ts`
- [x] T022 [P] Tests d'intégration PTY avec le faux CLI : lancement dans un `cwd` donné, écriture, regroupement de la sortie par trame (~16 ms), tampon circulaire ≈ 1 Mo, `resize`, code de sortie, arrêt propre, fonctionne via le wrapper `cmd.exe` sous Windows dans `tests/integration/pty/pty-manager.test.ts`
- [x] T023 [P] Tests du serveur de hooks : écoute sur `127.0.0.1` port aléatoire, rejet 401 sans jeton valide, routage du corps JSON vers l'agent du jeton, réponse synchrone possible (décision `PermissionRequest`), arrêt propre dans `tests/integration/hooks/hook-server.test.ts`
- [x] T024 [P] Écrire la suite de contrat réutilisable `tests/contract/cli-adapter.contract.ts` (fonction `runCliAdapterContract(adapterFactory)`) couvrant les 6 obligations de `contracts/cli-adapter.md`, et l'appliquer à l'adaptateur `fake` dans `tests/contract/fake.contract.test.ts`

### Implémentation des fondations

- [x] T025 [P] Implémenter les types et schémas zod de data-model.md (Workspace, RecentProject, CliDefinition, Agent, AgentState, FreeTerminal, TodoItem, PermissionPreference, ScheduledResume) et la palette ordonnée `AGENT_COLORS = ['purple','cyan','green','magenta','yellow','slate']` dans `src/shared/model.ts`
- [x] T026 [P] Implémenter les schémas des canaux de contracts/ipc.md (requêtes et événements) et le type d'erreur `{ code, message }` dans `src/shared/ipc.ts`
- [x] T027 [P] Implémenter la persistance JSON atomique validée (`state.json`, `workspaces/<hash>.json`, `schemaVersion`) dans `src/main/persistence/store.ts`
- [x] T028 [P] Implémenter la résolution de l'environnement du shell de connexion dans `src/main/env/shell-env.ts`
- [x] T029 [P] Implémenter la résolution et l'encapsulation des commandes (wrapper `cmd.exe` pour `.cmd`/`.bat`, échappement) dans `src/main/env/resolve-command.ts`
- [x] T030 [P] Implémenter `GitService` via `execFile('git', …)` (aucun shell) dans `src/main/git/git-service.ts`
- [x] T031 [P] Implémenter l'allocateur de ports dans `src/main/ports/port-allocator.ts`
- [x] T032 Implémenter `PtyManager` (node-pty, tampon circulaire, regroupement par trame, `write`, `resize`, `kill`, événements `data`/`exit`) dans `src/main/pty/pty-manager.ts`
- [x] T033 [P] Implémenter le serveur HTTP local des hooks (jeton par agent, réponses de décision) dans `src/main/agents/hook-server.ts`, et le script de relais pour les CLI sans hooks HTTP (lit stdin, POST vers `PACT_HOOK_URL`, exécuté avec `ELECTRON_RUN_AS_NODE=1`) dans `src/main/agents/hook-bridge.ts`
- [x] T034 [P] Définir l'interface `CliAdapter`, `AgentSignal`, `LaunchInput`, `LaunchSpec` exactement comme `contracts/cli-adapter.md`, et l'adaptateur `fake` (enregistré seulement si `PACT_TEST_MODE=1`) dans `src/main/agents/adapters/types.ts` et `src/main/agents/adapters/fake.ts`
- [x] T035 Implémenter l'enregistrement typé des handlers IPC (validation zod entrée/sortie, erreurs normalisées) dans `src/main/ipc/handlers.ts` et l'API `window.pact` typée (invoke + on/off par canal) dans `src/preload/index.ts` ; test `tests/unit/main/ipc/handlers.test.ts` (entrée invalide rejetée sans appel du service)
- [x] T036 [P] Créer les tokens de la direction 1c (fond `#0d1117`, surface `#131820`, texte `#dfe4eb`, texte secondaire `#8b94a4`, bordure `#27303c`, agents Purple `#a07fdc` Cyan `#6cc5e0` Green `#45c664` Magenta `#d466a8` Yellow `#c9c85a` Slate `#5a6890`, attend `#d6934f`, erreur/refuser `#c94646`, accepter `#45c664`, action `#6cc5e0`, rayon 6 px) et embarquer Instrument Sans + JetBrains Mono dans `src/renderer/theme/tokens.css` et `src/renderer/theme/fonts/`
- [x] T037 Créer le store Zustand racine (workspaces, agents, onglet actif, vue active) alimenté par `window.pact` et ses événements dans `src/renderer/store/app-store.ts` ; test `tests/unit/renderer/store/app-store.test.ts`
- [x] T038 Créer la coquille de l'app : barre d'onglets (onglets workspaces + « + » + ⚙ inactif), barre d'outils (Tuiles, Comparer, Revue, À faire, + Agents) et légende des icônes (◆ attend, ✓ prêt, ✕ erreur, ⎇ branche — FR-041) dans `src/renderer/app/TabBar.tsx`, `src/renderer/app/Toolbar.tsx`, `src/renderer/app/Legend.tsx` ; test `tests/unit/renderer/app/shell.test.tsx`

> Note d'implémentation : pour que la coquille démarre sans erreur, le main sert déjà `app:getState` (état global persisté, `src/main/app-services.ts`) et n'accepte l'IPC que depuis la page du renderer ; la restauration des workspaces et la détection des CLI s'y ajoutent en US1/US2 (T043, T045, T060).

**Checkpoint**: fondations testées, couverture ≥ seuils, `check` vert sur macOS et Windows

---

## Phase 3: User Story 1 - Ouvrir un dépôt comme workspace (Priority: P1) 🎯 MVP

**Goal**: accueil (1a), ouverture par glisser-déposer / sélecteur / clonage, onglets, workspace
vide (1b), récents persistés.

**Independent Test**: déposer un dossier Git → onglet ouvert à l'état vide ; cloner une URL →
dépôt ouvert ; redémarrer → dépôt dans les récents.

### Tests for User Story 1 ⚠️

- [x] T039 [P] [US1] Tests d'intégration de `WorkspaceService` : ouverture d'un dépôt (id = hash du `realpath`), `NOT_A_REPO`, `ALREADY_OPEN(id)` (FR-004), `initRepo`, récents triés par date décroissante et limités à 20, `keptWorktrees` compté depuis `.worktrees/`, statut `unavailable` quand le dossier est supprimé, persistance des workspaces ouverts dans `tests/integration/workspace/workspace-service.test.ts`
- [x] T040 [P] [US1] Tests de l'accueil : sections « Déjà ouverts » (chemin, branche, n worktrees, pastilles, compteur ◆), « Récents » (worktrees conservés, « ouvert il y a N j »), recherche, zone de dépôt, « Choisir un dépôt Git… », « Cloner depuis une URL… » avec progression et erreur, message + proposition d'initialisation pour un dossier non Git dans `tests/unit/renderer/home/Home.test.tsx`
- [x] T041 [P] [US1] Tests du workspace vide : une seule action « + Ajouter des agents », pas de colonne À faire, Comparer et Revue visibles mais inactifs (FR-006) dans `tests/unit/renderer/workspace/EmptyWorkspace.test.tsx`
- [x] T042 [P] [US1] Test e2e : glisser-déposer simulé d'un dépôt temporaire → onglet actif ; réouverture → bascule sur l'onglet existant ; « + » ouvre l'accueil ; clonage d'un dépôt bare local ; redémarrage → récents présents dans `tests/e2e/us1-workspaces.spec.ts`

### Implementation for User Story 1

- [x] T043 [US1] Implémenter `WorkspaceService` (open, initRepo, close, récents, surveillance du dossier par `fs.watch` + vérification périodique) dans `src/main/workspace/workspace-service.ts`
- [x] T044 [US1] Implémenter les jobs de clonage (progression `git clone --progress` → événement `clone:progress`, nettoyage du dossier en cas d'échec, aucun onglet créé) dans `src/main/workspace/clone-job.ts`
- [x] T045 [US1] Brancher les handlers `app:getState`, `workspace:open`, `workspace:initRepo`, `workspace:clone`, `workspace:close` et l'événement `workspace:status`, plus le sélecteur de dossier natif (`dialog.showOpenDialog`) dans `src/main/ipc/workspace-handlers.ts`
- [x] T046 [P] [US1] Implémenter l'accueil (1a) avec recherche, zone de dépôt (`webUtils.getPathForFile` via preload), boîte de clonage dans `src/renderer/home/Home.tsx`, `src/renderer/home/CloneDialog.tsx`, `src/renderer/home/DropZone.tsx`
- [x] T047 [P] [US1] Implémenter le workspace vide (1b) et l'affichage « indisponible » dans `src/renderer/workspace/EmptyWorkspace.tsx` et `src/renderer/workspace/WorkspaceView.tsx`
- [x] T048 [US1] Relier onglets, accueil et workspaces dans le store et `App.tsx` (onglet d'accueil ouvert par « + », fermeture d'onglet) dans `src/renderer/app/App.tsx`

> Notes d'implémentation : le test e2e T042 a été écrit après l'implémentation (chaque comportement avait son test Red aux niveaux unitaire et intégration). Le glisser-déposer est couvert au niveau composant (un `File` synthétique n'a pas de chemin réel en e2e) ; l'e2e passe par le sélecteur natif simulé dans le processus main. Deux ajouts au contrat IPC : `dialog:pickFolder` et la variante `{ jobId, workspace }` de `clone:progress`.

**Checkpoint**: US1 fonctionnelle et testée seule

---

## Phase 4: User Story 2 - Lancer des agents en mode rapide (Priority: P1)

**Goal**: détection de Claude Code et Codex, menu rapide (1c), écran d'autorisations (1m),
création des agents (worktree, branche, port, couleur), terminal libre, restauration.

**Independent Test**: lancer 3 agents → 3 worktrees, 3 branches, 3 ports (3001–3003), couleurs
Purple, Cyan, Green, états `awaiting-prompt` ; redémarrer → agents restaurés.

### Tests for User Story 2 ⚠️

- [X] T049 [US2] Caractériser à la main Claude Code 2.1.x et Codex 0.156.x sur la machine de dev et consigner les résultats dans `specs/001-agent-workspace-core/research.md` (R4, R5, R6) : séquences de touches des boîtes d'autorisation, charges réelles des hooks (`SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, `StopFailure`), disponibilité de `--permission-mode auto`, injection des hooks Codex via `-c` et mécanisme d'approbation des hooks (sans `--dangerously-bypass-hook-trust`), `git commit` possible dans un worktree avec `writable_roots`
- [X] T050 [P] [US2] Tests de l'adaptateur Claude Code : suite de contrat + arguments exacts par niveau (`always-allow` → `--permission-mode auto`, repli `acceptEdits` ; `ask-sensitive` → `--permission-mode acceptEdits` + règles `permissions.ask` via `--settings` ; `always-ask` → `--permission-mode manual`), `--session-id <uuid>`, `--resume <uuid>`, hooks HTTP injectés via `--settings`, `mapHookEvent` pour chaque événement de R4, `answerKeys` issues de T049, jamais `bypassPermissions` dans `tests/contract/claude-code.contract.test.ts`
- [X] T051 [P] [US2] Tests de l'adaptateur Codex : suite de contrat + arguments par niveau (`always-allow` → `-a never -s workspace-write` ; `ask-sensitive` → `-a on-request -s workspace-write` ; `always-ask` → `-a on-request -s read-only` ; tous avec `-c sandbox_workspace_write.writable_roots=["<repo>/.git"]`), `codex resume <SESSION_ID>`, hooks par `-c` sans écrire `~/.codex/config.toml`, jamais `--dangerously-bypass-hook-trust` ni `danger-full-access`, statut `unsupported-version` si `hooks` absent de `codex features list`, mode dégradé `notify` + heuristique si hooks non approuvés dans `tests/contract/codex.contract.test.ts`
- [X] T052 [P] [US2] Tests du registre de CLI : détection via l'environnement du shell (T028), version, statuts, CLI « installé » (pas d'état de connexion) dans `tests/unit/main/agents/cli-registry.test.ts`
- [X] T053 [P] [US2] Tests de la préférence d'autorisation : résolution projet > global > « demander » (écran 1m), mémorisation, `autoResume` défaut `true` dans `tests/unit/main/agents/permission-service.test.ts`
- [X] T054 [US2] Tests d'intégration de `AgentManager` avec le faux CLI : validation (`LIMIT` au-delà de 6, `BRANCH_CONFLICT`, `PORT_CONFLICT`), couleurs dans l'ordre `AGENT_COLORS` jamais réattribuées, ports 3000 + position, worktree `<repo>/.worktrees/<cli>-<n>`, variables `PORT`, `PACT_PORT`, `PACT_HOOK_URL`, `PACT_AGENT_TOKEN`, `PACT_AGENT_ID`, transitions `starting → awaiting-prompt → working → done` du data-model, capture de la consigne initiale, aucune consigne envoyée à la place de l'utilisateur (FR-018), branche principale jamais modifiée (FR-039), persistance et restauration après redémarrage (FR-038) dans `tests/integration/agents/agent-manager.test.ts`
- [X] T055 [P] [US2] Tests du menu rapide (1c) : compteurs « − n + » par CLI détecté, « Autre CLI », « Terminal libre », sélecteur de workflow limité à « Libre », bouton « Lancer N agents », compteurs pré-remplis avec les derniers utilisés dans le workspace (FR-010), désactivé si aucun CLI dans `tests/unit/renderer/launch/QuickLaunch.test.tsx`
- [X] T056 [P] [US2] Tests de l'écran d'autorisations (1m) : trois niveaux avec libellés fidèles aux garanties réelles (FR-012), « Toujours autoriser » présélectionné, portée « Ce projet » / « Tous les projets », option « Reprendre automatiquement après une limite de débit » activée (FR-035), Entrée valide et lance dans `tests/unit/renderer/launch/PermissionsDialog.test.tsx`
- [X] T057 [P] [US2] Test e2e : lancer 2 agents `fake` + 1 terminal libre → écran 1m au premier lancement, `git worktree list` montre 2 worktrees, `git status` principal propre, ports 3001/3002, redémarrage de l'app → agents restaurés avec mêmes couleurs, branches et ports dans `tests/e2e/us2-quick-launch.spec.ts`

### Implementation for User Story 2

- [X] T058 [P] [US2] Implémenter l'adaptateur Claude Code dans `src/main/agents/adapters/claude-code.ts`
- [X] T059 [P] [US2] Implémenter l'adaptateur Codex dans `src/main/agents/adapters/codex.ts`
- [X] T060 [US2] Implémenter le registre de CLI (détection, CLI ajoutés persistés, `cli:redetect`) dans `src/main/agents/cli-registry.ts`
- [X] T061 [P] [US2] Implémenter la préférence d'autorisation dans `src/main/agents/permission-service.ts`
- [X] T062 [US2] Implémenter `AgentManager` (validation, création de worktree via `GitService`, ports, couleurs, lancement PTY via adaptateur, machine à états, jetons de hooks, persistance, restauration au démarrage avec état `error` « à reprendre » pour les agents dont le processus n'existe plus) dans `src/main/agents/agent-manager.ts`
- [X] T063 [US2] Implémenter les terminaux libres (shell `$SHELL` sous macOS, `pwsh` sinon `powershell.exe` sous Windows, `cwd` = racine du dépôt) dans `src/main/agents/free-terminals.ts`
- [X] T064 [US2] Brancher `agents:launch`, `permission:set`, `cli:redetect`, `app:getState` (CLI) et l'événement `agent:state` dans `src/main/ipc/agent-handlers.ts`
- [X] T065 [P] [US2] Implémenter le menu rapide (1c) dans `src/renderer/launch/QuickLaunch.tsx`
- [X] T066 [P] [US2] Implémenter l'écran d'autorisations (1m) dans `src/renderer/launch/PermissionsDialog.tsx`
- [X] T067 [P] [US2] Afficher « Agents détectés » (✓ installé, ○ absent, version trop ancienne avec invitation à mettre à jour, invitation à approuver les hooks PACT pour Codex) sur l'accueil dans `src/renderer/home/DetectedClis.tsx`
- [X] T068 [US2] Afficher provisoirement chaque agent lancé dans une tuile minimale (terminal xterm brut, sans actions) pour permettre la saisie de la consigne en attendant US3, dans `src/renderer/tiles/TerminalView.tsx` et `src/renderer/tiles/terminal-registry.ts` (une instance xterm par terminal, addons fit / webgl avec repli / unicode11 / web-links)

**Checkpoint**: US1 + US2 : on ouvre un dépôt, on lance des agents isolés, on tape une consigne

---

## Phase 5: User Story 3 - Piloter les agents depuis la vue Tuiles (Priority: P1)

**Goal**: grille 2×2 / 3×2 (1e, 1f, 1l, 1n), bordure couleur, pulse, halo, ⎇, actions,
terminal libre, fermeture d'agent.

**Independent Test**: 4 agents en 2×2 ; question d'autorisation → Autoriser ; crash → halo rouge
→ Reprendre ; renommage de branche → ⎇ à jour.

### Tests for User Story 3 ⚠️

- [ ] T069 [P] [US3] Tests de la grille : 1–4 agents → 2×2 avec « + » dans les emplacements libres, 5–6 → 3×2, ordre = `position`, couleurs inchangées au passage à 5 agents dans `tests/unit/renderer/tiles/TileGrid.test.tsx`
- [ ] T070 [P] [US3] Tests de la tuile : bordure à la couleur de l'agent, ni numéro ni titre ni libellé d'état (FR-020), ⎇ au survol → branche actuelle + port, pulse à chaque changement d'état (FR-023), halo rouge fixe en `error`, actions selon l'état (Autoriser / Refuser en `awaiting-answer` ; Journal / Relancer / Reprendre en `error`) dans `tests/unit/renderer/tiles/Tile.test.tsx`
- [ ] T071 [P] [US3] Test du terminal : l'instance xterm d'un agent est réutilisée (même objet) quand la tuile est démontée puis remontée, aucune perte de sortie dans `tests/unit/renderer/tiles/terminal-registry.test.ts`
- [ ] T072 [US3] Tests d'intégration des actions avec le faux CLI : `agent:answer` écrit `answerKeys` et le scénario `ask-permission` reprend ; `crash-exit-1` → état `error` avec `lastError.code = 1` ; « Reprendre » relance avec `buildResume` (même `sessionId`) ; « Relancer » démarre une nouvelle session et retape la consigne initiale ; `agent:log` renvoie le tampon ; `rename-branch` → événement `agent:branch` ; `agent:close` avec et sans suppression du worktree (FR-037) dans `tests/integration/agents/agent-actions.test.ts`
- [ ] T073 [P] [US3] Test e2e : 4 agents fake en 2×2, puis 6 en 3×2 ; autorisation via la tuile ; crash → halo + Reprendre ; terminal libre exécute `git status` à la racine du dépôt principal dans `tests/e2e/us3-tiles.spec.ts`

### Implementation for User Story 3

- [ ] T074 [US3] Implémenter les actions agent (`answer`, `resume`, `restart`, `log`, `close`) dans `src/main/agents/agent-manager.ts` et les handlers `agent:answer`, `agent:resume`, `agent:restart`, `agent:close`, `agent:log`, `term:write`, `term:resize` dans `src/main/ipc/agent-handlers.ts`
- [ ] T075 [P] [US3] Implémenter la surveillance de branche (`git branch --show-current` à chaque `Stop` et toutes les 5 s tant que l'agent tourne, événement `agent:branch`) dans `src/main/agents/branch-watcher.ts`
- [ ] T076 [P] [US3] Implémenter la grille réactive avec emplacements « + » dans `src/renderer/tiles/TileGrid.tsx`
- [ ] T077 [US3] Implémenter la tuile (bordure, ⎇ + infobulle, ⤢, actions en bas à droite, pulse CSS ponctuel, halo rouge fixe) en réutilisant `TerminalView` de T068 dans `src/renderer/tiles/Tile.tsx`, `src/renderer/tiles/TileActions.tsx`, `src/renderer/tiles/BranchTooltip.tsx`, `src/renderer/tiles/tile.module.css`
- [ ] T078 [P] [US3] Implémenter le dialogue de fermeture d'agent (conserver / supprimer worktree et branche) et le panneau « Journal » dans `src/renderer/tiles/CloseAgentDialog.tsx` et `src/renderer/tiles/LogPanel.tsx`
- [ ] T079 [US3] Afficher le terminal libre dans la grille et le brancher sur `FreeTerminal` dans `src/renderer/tiles/FreeTerminalTile.tsx`

**Checkpoint**: MVP complet (US1 + US2 + US3) — démo possible

---

## Phase 6: User Story 4 - Traiter les demandes depuis la colonne À faire (Priority: P2)

**Goal**: colonne À faire triée, mêmes boutons que les tuiles, badge, ◆ / ✕ sur onglets inactifs.

**Independent Test**: 2 agents en attente → ordre correct ; réponse depuis la colonne → disparition
des deux côtés ; colonne fermée → badge ; onglet inactif → ◆ puis ✕.

### Tests for User Story 4 ⚠️

- [ ] T080 [P] [US4] Tests de la dérivation pure `deriveTodos` : tri « answer, rate-limit, prompt, info » (data-model TodoItem), id `<agentId>:<kind>`, actions identiques à la tuile, élément « Donner une consigne · <CLI> · tapez dans le terminal » pour chaque agent en `awaiting-prompt`, « En cours ▸ <shell> — <branche> » pour le terminal libre dans `tests/unit/shared/todo.test.ts`
- [ ] T081 [P] [US4] Tests de l'indicateur d'onglet : ◆ si au moins un agent `awaiting-answer`, sinon ✕ si au moins un agent `error`, sinon rien (FR-030) dans `tests/unit/shared/tab-indicator.test.ts`
- [ ] T082 [P] [US4] Tests de la colonne : couleur d'agent sur chaque élément, boutons fonctionnels, fermeture → bouton en clair avec badge du nombre d'éléments, « Rien à faire · vous serez prévenu » si vide, absente sans agent dans `tests/unit/renderer/todo/TodoColumn.test.tsx`
- [ ] T083 [P] [US4] Test e2e : deux agents fake `ask-permission` → deux « ◆ Répondre » avant les « Donner une consigne » ; réponse depuis la colonne → disparition sur la tuile en < 1 s ; second workspace actif → ◆ sur l'onglet du premier ; crash → ✕ dans `tests/e2e/us4-todo.spec.ts`

### Implementation for User Story 4

- [ ] T084 [P] [US4] Implémenter `deriveTodos` dans `src/shared/todo.ts` et l'indicateur d'onglet dans `src/shared/tab-indicator.ts`
- [ ] T085 [US4] Implémenter la colonne À faire (entrée des éléments en se dépliant) en réutilisant `TileActions` de T077 dans `src/renderer/todo/TodoColumn.tsx` et `src/renderer/todo/TodoItem.tsx`
- [ ] T086 [US4] Ajouter le badge du bouton À faire dans `src/renderer/app/Toolbar.tsx` et les indicateurs ◆ / ✕ et le compteur ◆ de l'accueil dans `src/renderer/app/TabBar.tsx` et `src/renderer/home/Home.tsx`

**Checkpoint**: US4 fonctionnelle, US1–US3 toujours vertes

---

## Phase 7: User Story 5 - Focus sur un agent (Priority: P2)

**Goal**: Focus (1p) via ⤢, pastilles, sortie par « ‹ Tuiles » / Échap, « Toujours pour ce
worktree ».

**Independent Test**: Focus sur un agent, changement via pastilles, Échap → grille intacte ;
« Toujours pour ce worktree » → demandes suivantes du même type autorisées automatiquement.

### Tests for User Story 5 ⚠️

- [ ] T087 [P] [US5] Tests du Focus : ouverture par ⤢, en-tête branche + port, onglets Terminal (actif), Aperçu et Changements (inactifs), pastilles aux couleurs des agents, « ‹ Tuiles » et Échap hors du terminal ramènent à la grille, Échap dans le terminal est transmis au CLI dans `tests/unit/renderer/focus/FocusView.test.tsx`
- [ ] T088 [US5] Tests d'intégration « Toujours pour ce worktree » : `agent:answer` avec `always: true` ajoute la règle à `alwaysAllowRules` ; pour Claude Code, la demande suivante de même `ruleKey` reçoit `allow` via la réponse du hook `PermissionRequest` ; pour les autres adaptateurs, `answerKeys('allow')` est envoyé automatiquement ; règles effacées à la fermeture de l'agent dans `tests/integration/agents/always-allow.test.ts`
- [ ] T089 [P] [US5] Test e2e : ⤢ → Focus, saisie, pastille d'un autre agent → historique complet, Échap → grille, sorties intactes dans `tests/e2e/us5-focus.spec.ts`

### Implementation for User Story 5

- [ ] T090 [US5] Implémenter `alwaysAllowRules` et la décision automatique (réponse `PermissionRequest` ou `answerKeys`) dans `src/main/agents/agent-manager.ts` et `src/main/agents/hook-server.ts`
- [ ] T091 [US5] Implémenter le Focus et le sélecteur de pastilles en réutilisant `Tile` et `TerminalView` dans `src/renderer/focus/FocusView.tsx` et `src/renderer/focus/AgentPills.tsx`
- [ ] T092 [US5] Ajouter l'action « Toujours pour ce worktree » à côté de Refuser / Autoriser en Focus dans `src/renderer/tiles/TileActions.tsx`

**Checkpoint**: US5 fonctionnelle, US1–US4 toujours vertes

---

## Phase 8: User Story 6 - Lancement détaillé et gestion des CLI (Priority: P3)

**Goal**: mode détaillé maître-détail (1d), surcharges ≠, réordonnancement, CLI personnalisés,
adaptateur générique.

**Independent Test**: 2 agents avec modèles et branches différents et un port personnalisé →
réglages appliqués ; CLI ajouté → proposé au lancement.

### Tests for User Story 6 ⚠️

- [ ] T093 [P] [US6] Tests du brouillon de lancement (logique pure) : « Commun à tous » hérité par défaut, surcharge marquée ≠ et comptée par agent, la surcharge prime au lancement, réordonnancement → positions, ports et couleurs recalculés, dupliquer / retirer, détection des conflits de branche et de port, bascule mode rapide ↔ détaillé sans perte dans `tests/unit/shared/launch-draft.test.ts`
- [ ] T094 [P] [US6] Tests de l'adaptateur générique : suite de contrat ; heuristique « attend une réponse » après 3 s d'inactivité si la dernière sortie finit par `?` ou `(y/n)` ; fin de processus → `turn-finished` ou `failed` selon le code dans `tests/contract/generic.contract.test.ts`
- [ ] T095 [P] [US6] Tests de `cli:add` : CLI enregistré avec `origin: custom`, id `custom-<slug>`, avertissement si la commande est introuvable, proposé dans les compteurs du mode rapide dans `tests/unit/main/agents/cli-registry-custom.test.ts`
- [ ] T096 [P] [US6] Tests du panneau détaillé (1d) : liste à gauche identifiée par couleur, glisser-déposer, inspecteur (CLI, modèle, permissions Demander / Auto · worktree / Tout auto, branche de base, branche « auto — choisie par l'agent », port · commande), pointillés pour l'hérité, ≠ pour le surchargé dans `tests/unit/renderer/launch/DetailedLaunch.test.tsx`
- [ ] T097 [P] [US6] Test e2e : mode détaillé, 2 agents fake avec branches et port personnalisés → réglages appliqués ; conflit de port → lancement bloqué ; ajout d'un CLI personnalisé depuis l'accueil dans `tests/e2e/us6-detailed-launch.spec.ts`

### Implementation for User Story 6

- [ ] T098 [P] [US6] Implémenter la logique du brouillon de lancement dans `src/shared/launch-draft.ts` et l'utiliser aussi dans `QuickLaunch` (T065) pour ne pas dupliquer la validation
- [ ] T099 [P] [US6] Implémenter l'adaptateur générique dans `src/main/agents/adapters/generic.ts`
- [ ] T100 [US6] Implémenter `cli:add` et `agents:reorder` dans `src/main/agents/cli-registry.ts`, `src/main/agents/agent-manager.ts` et `src/main/ipc/agent-handlers.ts`
- [ ] T101 [US6] Implémenter le panneau maître-détail (1d) dans `src/renderer/launch/DetailedLaunch.tsx`, `src/renderer/launch/AgentInspector.tsx`, `src/renderer/launch/AgentList.tsx`
- [ ] T102 [US6] Implémenter « Autre CLI — ajouter » sur l'accueil dans `src/renderer/home/AddCliDialog.tsx`

**Checkpoint**: US6 fonctionnelle, US1–US5 toujours vertes

---

## Phase 9: User Story 7 - Reprise automatique après limite de débit (Priority: P3)

**Goal**: reprise programmée sans question si activée en amont (1m), annulable, sans double
reprise.

**Independent Test**: reprise auto activée ; scénario `rate-limit` → « reprise auto à HH:MM ·
Annuler » → reprise à l'heure sans action ; désactivée → actions manuelles seules.

### Tests for User Story 7 ⚠️

- [ ] T103 [P] [US7] Tests de la planification (horloge simulée) : heure de levée connue → reprise à cette heure ; inconnue → backoff « 1, 2, 4, 8, 15, 15… min » ; annulation par Annuler / Reprendre / Relancer / fermeture, par `UserPromptSubmit` ou par la notification `quota_auto_resume_fired` ; `autoResume` désactivé → aucune programmation dans `tests/unit/main/agents/auto-resume.test.ts`
- [ ] T104 [P] [US7] Tests de `parseRateLimitReset` pour Claude Code et Codex (formats relevés en T049, fuseau local) dans `tests/unit/main/agents/rate-limit-parse.test.ts`
- [ ] T105 [US7] Tests d'intégration avec le faux CLI : `rate-limit` (processus terminé → `buildResume`), `rate-limit-alive` (processus vivant → « continue » + Entrée), `rate-limit-native-resume` (aucune seconde reprise) dans `tests/integration/agents/auto-resume.test.ts`
- [ ] T106 [P] [US7] Test e2e avec horloge simulée : tuile et À faire affichent « reprise auto à HH:MM · Annuler », reprise sans action, Annuler supprime la programmation dans `tests/e2e/us7-auto-resume.spec.ts`

### Implementation for User Story 7

- [ ] T107 [US7] Implémenter `parseRateLimitReset` dans `src/main/agents/adapters/claude-code.ts` et `src/main/agents/adapters/codex.ts`
- [ ] T108 [US7] Implémenter le planificateur de reprise (horloge injectable, persistance de `ScheduledResume`, reprise au redémarrage de l'app) dans `src/main/agents/auto-resume.ts` et le brancher dans `AgentManager`
- [ ] T109 [US7] Brancher `agent:cancelAutoResume` dans `src/main/ipc/agent-handlers.ts` et afficher « reprise auto à HH:MM · Annuler » dans `src/renderer/tiles/TileActions.tsx` et `src/renderer/todo/TodoItem.tsx` (élément `rate-limit`)

**Checkpoint**: toutes les stories fonctionnelles

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: exigences transverses, performance, sécurité, validation finale

- [ ] T110 [P] Tests puis implémentation de la confirmation de fermeture de l'app quand des agents sont actifs, et arrêt propre de tous les PTY dans `tests/unit/main/app-lifecycle.test.ts` et `src/main/app-lifecycle.ts`
- [ ] T111 [P] Tests puis implémentation des animations 1c (grille de points réactive autour du curseur, transition particules → tuiles → bordures, entrée dépliée des éléments À faire), désactivées si `prefers-reduced-motion` (FR-042), aucun effet dans les terminaux, dans `tests/unit/renderer/effects/effects.test.tsx`, `src/renderer/effects/DotGrid.tsx`, `src/renderer/effects/ViewTransition.tsx`
- [ ] T112 Test e2e de performance SC-002 : 6 agents fake `burst-output` → latence d'écho d'une frappe < 100 ms (p95) et passage d'état visible dans À faire < 2 s (SC-003) dans `tests/e2e/perf.spec.ts`
- [ ] T113 [P] Test e2e des chemins avec espaces et accents (dépôt dans « Mes Projets/Développement ») sur macOS et Windows dans `tests/e2e/paths.spec.ts`
- [ ] T114 [P] Revue de sécurité : CSP, `sandbox`, aucune commande shell construite depuis le renderer, jeton de hooks non journalisé, serveur de hooks lié à `127.0.0.1` uniquement ; corriger les écarts et ajouter un test par écart trouvé dans `tests/unit/main/security.test.ts`
- [ ] T115 [P] Mettre à jour `README.md` (présentation, prérequis, `npm ci`, `npm run dev`, `npm run check`, `npm run test:e2e`, approbation des hooks Codex)
- [ ] T116 Dérouler `specs/001-agent-workspace-core/quickstart.md` (scénarios automatisés + validation manuelle avec vrais CLI) sur macOS et Windows et consigner les résultats dans la PR
- [ ] T117 Proposer à l'utilisateur (sans l'appliquer sans son accord) la protection de la branche `main` exigeant les jobs CI `check` et `e2e` (Constitution II)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** : aucune dépendance.
- **Foundational (Phase 2)** : après Setup. **Bloque toutes les stories.** T013–T014 (faux CLI)
  avant T022, T023, T024.
- **US1 (Phase 3)** : après Foundational.
- **US2 (Phase 4)** : après Foundational ; son test e2e ouvre un workspace, donc réutilise US1
  (T043–T048). T049 (caractérisation) avant T050, T051.
- **US3 (Phase 5)** : après US2 (agents à afficher ; réutilise `TerminalView` T068).
- **US4 (Phase 6)** : après US3 (réutilise `TileActions` T077).
- **US5 (Phase 7)** : après US3 (réutilise `Tile`, `TerminalView`).
- **US6 (Phase 8)** : après US2 (étend le lancement) ; indépendante de US3–US5.
- **US7 (Phase 9)** : après US3 (actions de tuile) ; T104 dépend de T049.
- **Polish (Phase 10)** : après les stories visées.

### User Story Dependencies

- US1 → US2 → US3 forment le MVP (les trois P1).
- US4 et US5 peuvent avancer en parallèle après US3.
- US6 peut avancer en parallèle de US3–US5 dès US2 terminée.
- US7 après US3.

### Within Each User Story

- Tests écrits et **en échec** avant l'implémentation (Constitution I).
- Modèle / logique pure → services main → handlers IPC → UI.
- `npm run check` vert avant de passer à la story suivante ; aucun test existant désactivé.

### Parallel Opportunities

- Setup : T005–T009 en parallèle.
- Foundational : tests T015–T024 en parallèle ; implémentations T025–T031, T033, T034, T036 en
  parallèle.
- Chaque story : toutes les tâches de test marquées [P] en parallèle, puis les tâches
  d'implémentation [P].
- Après US3 : US4, US5 et US6 en parallèle (fichiers distincts, sauf `TileActions.tsx` et
  `agent-handlers.ts` partagés → à séquencer).

---

## Parallel Example: User Story 2

```bash
# Tests en parallèle (après T049) :
Task: "Tests de l'adaptateur Claude Code dans tests/contract/claude-code.contract.test.ts"
Task: "Tests de l'adaptateur Codex dans tests/contract/codex.contract.test.ts"
Task: "Tests du registre de CLI dans tests/unit/main/agents/cli-registry.test.ts"
Task: "Tests de la préférence d'autorisation dans tests/unit/main/agents/permission-service.test.ts"
Task: "Tests du menu rapide dans tests/unit/renderer/launch/QuickLaunch.test.tsx"
Task: "Tests de l'écran d'autorisations dans tests/unit/renderer/launch/PermissionsDialog.test.tsx"

# Implémentations en parallèle :
Task: "Adaptateur Claude Code dans src/main/agents/adapters/claude-code.ts"
Task: "Adaptateur Codex dans src/main/agents/adapters/codex.ts"
Task: "Menu rapide dans src/renderer/launch/QuickLaunch.tsx"
Task: "Écran d'autorisations dans src/renderer/launch/PermissionsDialog.tsx"
```

---

## Implementation Strategy

### MVP First (US1 + US2 + US3)

1. Phase 1 Setup → Phase 2 Foundational (critique).
2. US1 → valider seule (workspace ouvert, récents).
3. US2 → valider (agents isolés, restauration).
4. US3 → valider (grille, actions) → **démo MVP**.

### Incremental Delivery

1. MVP (US1–US3) → PR → merge.
2. US4 (À faire) → PR → merge.
3. US5 (Focus) → PR → merge.
4. US6 (détaillé, CLI perso) → PR → merge.
5. US7 (reprise auto) → PR → merge.
6. Polish → PR → merge.

Chaque PR : `check` + `e2e` verts sur macOS et Windows (Constitution II).

---

## Notes

- [P] = fichiers différents, aucune dépendance sur une tâche non terminée.
- Vérifier que chaque test échoue avant d'implémenter ; commit après chaque tâche ou groupe logique.
- Réutiliser avant de créer (Constitution IV) : `TerminalView`, `TileActions`, `launch-draft`,
  `GitService` et la suite de contrat des adaptateurs sont conçus pour être réutilisés ; ne pas les
  dupliquer.
- Hors socle : Aperçus, Revue, Workflows, Skills, Notifications, Réglages complets, « Copier la
  consigne ».

---

## Phase 11: Convergence

- [x] T118 CRITICAL — Protéger la branche `main` dès maintenant (la CI existe depuis T010) en exigeant les jobs `check` et `e2e` sur macOS et Windows, après accord explicite de l'utilisateur ; T117 reste la trace de validation finale per Constitution II (contradicts)
- [x] T119 CRITICAL — Ajouter en CI un contrôle de non-régression de couverture : comparer `coverage/coverage-summary.json` de la PR à celui de `main` et échouer si la couverture lignes/branches baisse sur les fichiers modifiés, en plus des seuils fixes de `vitest.config.ts`, dans `.github/workflows/ci.yml` et `scripts/coverage-guard.mjs` (test dans `tests/unit/scripts/coverage-guard.test.ts`) per Constitution III (missing)
- [x] T120 CRITICAL — Justifier la dépendance `globals` (utilisée par `eslint.config.js`) dans `specs/001-agent-workspace-core/research.md` R12, ou la retirer si typescript-eslint suffit per Constitution, contraintes techniques (contradicts)
- [ ] T121 Tests puis implémentation : quand le dossier d'un workspace est supprimé ou déplacé, le workspace passe `unavailable` **et ses agents sont arrêtés proprement** (PTY tués, état persisté) dans `tests/integration/workspace/workspace-service.test.ts` et `src/main/workspace/workspace-service.ts` per spec Edge Cases (dossier supprimé) (missing)
- [ ] T122 Tests puis implémentation de l'avertissement « modifications locales non incluses » affiché avant le lancement d'agents quand le dépôt a des modifications non commitées (réutilise `GitService.hasChanges`), dans `tests/unit/renderer/launch/QuickLaunch.test.tsx` et `src/renderer/launch/QuickLaunch.tsx` per spec Edge Cases (modifications non commitées) (partial)
- [ ] T123 Tests puis implémentation du message d'accueil « aucun CLI détecté » expliquant comment installer Claude Code / Codex ou ajouter un CLI dans `tests/unit/renderer/home/Home.test.tsx` et `src/renderer/home/DetectedClis.tsx` per spec Edge Cases (aucun CLI détecté) (partial)
- [ ] T124 Test e2e : un agent fake `burst-output` continue à produire pendant qu'un autre onglet workspace est actif ; au retour, aucune sortie perdue et l'état est à jour dans `tests/e2e/us3-background-tab.spec.ts` per FR-026 (partial)
- [ ] T125 Exécuter la suite e2e smoke sur l'app packagée (`electron-builder --dir`) en CI macOS et Windows, en vérifiant le chargement de node-pty hors asar, via `tests/e2e/helpers/launch-app.ts` (option `PACT_E2E_PACKAGED=1`) et `.github/workflows/ci.yml` per plan R12 / R14 (partial)
- [x] T126 Aligner `contracts/cli-adapter.md` et les types de T034 : ajouter `agentId` à `LaunchInput` (requis pour `PACT_AGENT_ID`) et `cwd` à `LaunchSpec` (obligation 1), et harmoniser le chemin de la suite de contrat (`tests/contract/cli-adapter.contract.ts`) avant d'implémenter T024 / T034 per contracts/cli-adapter.md (contradicts)
- [x] T127 Vérifier si `style-src 'unsafe-inline'` est nécessaire hors mode dev ; le cas échéant, le limiter au serveur de développement (CSP de production `default-src 'self'` stricte), avec assertion e2e sur la CSP servie, dans `src/renderer/index.html` et `electron.vite.config.ts` per T011 (partial)
- [ ] T128 Justifier dans la revue de sécurité (T114) le blocage de `window.open` et de la navigation (`src/main/window.ts`), ajouté sans tâche dédiée, ou le retirer per T114 (unrequested)

---

## Phase 12: Convergence

- [x] T129 Consigner dans `specs/001-agent-workspace-core/research.md` R3 que la résolution des commandes cherche directement dans le PATH (avec PATHEXT sous Windows) au lieu de lancer `which` / `where.exe` : même résultat, aucun processus lancé, testable sur les deux OS, vérifié sur la CI Windows per research R3 / T019 (contradicts)
- [ ] T130 Justifier dans la revue de sécurité (T114) le contrôle d'origine IPC (`trustedSenderCheck`), l'ignorance d'`ELECTRON_RENDERER_URL` dans une app packagée et le service `app:getState` câblé dès la phase 2 (`src/main/app-services.ts`) per T114 (unrequested)

---

## Phase 13: Convergence

- [x] T131 Surveiller le dossier de chaque workspace ouvert avec `fs.watch` (dossier parent) pour signaler une disparition aussitôt, en gardant la vérification toutes les 3 s en filet de sécurité, dans `src/main/workspace/workspace-service.ts` (test dans `tests/integration/workspace/workspace-service.test.ts`) per T043 (partial)
- [x] T132 Aligner l’onglet d’accueil sur la maquette 1a : libellé « Nouvel onglet » et bouton ✕ pour le fermer quand un workspace est ouvert (retour à ce workspace), dans `src/renderer/app/TabBar.tsx` et `src/renderer/store/app-store.ts` (tests dans `tests/unit/renderer/app/shell.test.tsx`) per FR-002 / maquette 1a (partial)

---

## Phase 14: Convergence

- [X] T133 Tests puis implémentation : mémoriser un compteur (0 compris) pour chaque CLI installé à chaque lancement, pour qu'un lancement « Terminal libre » seul ne repropose pas 1 agent ensuite, dans `tests/unit/renderer/store/launch.test.ts` et `src/renderer/store/app-store.ts` per US2/AC7, FR-010 (partial)
- [X] T134 Tests puis implémentation : à `term:exit` d'un terminal libre, retirer sa tuile du workspace et libérer son xterm (`registry.dispose`), dans `tests/unit/renderer/store/app-store.test.ts`, `tests/unit/renderer/app/App.test.tsx`, `src/renderer/store/app-store.ts` et `src/renderer/app/App.tsx` per T063, US2/AC5 (partial)
- [X] T135 Consigner dans `specs/001-agent-workspace-core/research.md` R2 que xterm utilise le rendu DOM par défaut (texte lisible par les technologies d'assistance et l'e2e, plus d'addon canvas dans xterm 6), WebGL restant disponible via `createXterm({ webgl: true })` per plan R2 / T068 (contradicts)
- [X] T136 Consigner dans `specs/001-agent-workspace-core/data-model.md` (transitions) qu'un processus terminé sans demande de PACT passe en `error` « à reprendre » même avec le code 0 per data-model AgentState (partial)

---

## Phase 15: Convergence

- [X] T137 Tests puis implémentation : décrire dans l'écran 1m ce que chaque niveau permet réellement **pour chaque CLI lancé** (Claude Code : règles `ask` rm / curl / wget / git push / WebFetch ; Codex : sandbox `workspace-write`, approbation `on-request` décidée par le modèle, réseau coupé par le sandbox), sans promettre à Codex ce que seules les règles de Claude Code garantissent, dans `tests/unit/renderer/launch/PermissionsDialog.test.tsx` et `src/renderer/launch/PermissionsDialog.tsx` per FR-012 / research R5 (contradicts)
- [X] T138 Tests puis implémentation : en niveau « Demander pour les actions sensibles », faire demander Claude Code avant toute écriture hors du worktree (vérifier le comportement réel d'`acceptEdits` hors du `cwd`, sinon ajouter des règles `permissions.ask` `Edit` / `Write` hors worktree), dans `tests/contract/claude-code.contract.test.ts` et `src/main/agents/adapters/claude-code.ts` per FR-012 / research R5 (partial)
