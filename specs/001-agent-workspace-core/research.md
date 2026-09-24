# Research — 001 Socle (workspaces, agents et terminaux)

Date : 2026-09-23. Versions relevées via `npm view` et `--help` le même jour.

## R1. Coquille desktop

- **Decision** : Electron 44.x (dernière stable : 44.4.5), outillage electron-vite 5.
- **Rationale** : une seule base TypeScript pour macOS et Windows ; écosystème de terminal éprouvé
  (VS Code) ; vues web multiples et émulation d'appareil utiles aux specs Aperçus/Comparaison ;
  notifications avec actions et badge d'icône (spec Notifications).
- **Alternatives** : Tauri 2 (léger, mais PTY Windows et multi-webview moins mûrs, Rust en plus) ;
  Wails (Go, mêmes limites webview) ; natif Swift + WinUI (deux bases de code, contraire à FR-001).

## R2. Terminaux (PTY) et rendu

- **Decision** : `node-pty` 1.1.x dans le processus principal ; `@xterm/xterm` 6.x dans le
  renderer, avec les addons `fit`, `webgl` (repli canvas), `serialize`, `unicode11`, `web-links`.
- **Rationale** : node-pty utilise ConPTY sous Windows 10+ et forkpty sous macOS ; xterm.js restitue
  fidèlement les TUI de Claude Code et Codex (couleurs 24 bits, curseur, souris, bracketed paste).
- **Gestion de l'historique** : le processus principal garde un tampon circulaire par terminal
  (≈ 1 Mo). Au passage Tuiles ↔ Focus, le renderer ne recrée pas le terminal : une seule instance
  xterm par agent, déplacée dans le DOM (reparenting). Au redémarrage de l'app, pas de restitution
  de sortie : la session CLI est reprise (R6).
- **Rendu (révisé en phase 4)** : xterm utilise son rendu DOM par défaut. Le texte reste dans la
  page, où les technologies d'assistance et la suite e2e le lisent. xterm 6 n'a plus d'addon canvas,
  donc le « repli canvas » est en fait le rendu DOM. WebGL reste disponible via
  `createXterm({ webgl: true })` (`src/renderer/tiles/xterm-factory.ts`), avec retour au DOM si le
  contexte manque, au cas où une mesure SC-002 l'exigerait.
- **Débit** : la sortie PTY est regroupée par trame (~16 ms) avant envoi IPC, pour tenir SC-002
  avec 6 agents.
- **Alternatives** : `@homebridge/node-pty-prebuilt-multiarch` (binaires précompilés, mais fork
  moins suivi) ; gardé en solution de secours si la recompilation native pose problème en CI.

## R3. Lancement des CLI : PATH et shims Windows

- **Problème macOS** : une app lancée depuis le Finder reçoit un PATH minimal
  (`/usr/bin:/bin:/usr/sbin:/sbin`) ; `claude` (~/.local/bin) ou `codex` (npm global) sont alors
  introuvables.
- **Decision** : au démarrage, résoudre l'environnement du shell de connexion (`$SHELL -ilc env`
  avec délai max 3 s, résultat mis en cache) et l'utiliser pour la détection et le lancement.
  Équivalent de la bibliothèque `shell-env`, réimplémenté en ~30 lignes testées.
- **Problème Windows** : les CLI installés par npm sont des shims `codex.cmd` / `codex.ps1`
  (constaté sur la machine de dev : `%APPDATA%\npm\codex.cmd`). node-pty ne peut pas lancer un
  `.cmd` directement.
- **Decision** : la détection résout le chemin complet via `where.exe` ; si l'extension est `.cmd`
  ou `.bat`, le lancement passe par `cmd.exe /d /s /c "<chemin>" <args>` ; les `.exe` sont lancés
  directement. Les arguments sont échappés par une fonction dédiée, testée unitairement.
- **Implémentation (phase 2)** : plutôt que de lancer `which` / `where.exe`, la résolution parcourt
  directement le PATH (avec PATHEXT et des noms de variables insensibles à la casse sous Windows) :
  même résultat, aucun processus lancé, et un comportement testable à l'identique sur les deux OS.
  L'aller-retour d'arguments (espaces, guillemets, `&`, `%`, accents) à travers un vrai shim npm
  `.cmd` est vérifié sur la CI Windows.
- **Alternatives** : `cross-spawn` (ne couvre pas node-pty) ; lancer tout via un shell interactif
  (casse la détection de fin de processus et les codes de sortie).

## R4. Détection de l'état des agents

- **Decision** : un **adaptateur par CLI** (contrat `contracts/cli-adapter.md`) qui fournit les
  signaux d'état. Deux sources, par ordre de priorité :
  1. **Hooks natifs du CLI** relayés vers PACT :
     - Claude Code (2.1.x) accepte `--settings '<json>'` avec des hooks, dont des hooks HTTP
       (POST). Événements utilisés : `SessionStart`, `UserPromptSubmit` (→ en cours), `Stop`
       (→ attend une consigne / terminé), `StopFailure` (→ erreur), `Notification` avec
       `notification_type` = `permission_prompt` (→ attend une réponse), `idle_prompt`,
       `agent_needs_input`. `PermissionRequest` peut répondre `allow`/`deny` : utilisé
       uniquement pour « Toujours pour ce worktree » (FR-034).
     - Codex (≥ versions récentes, dernière 0.156.1) supporte des hooks (`features.hooks = true`,
       événements `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Stop`…) et `notify`.
       Injectés **par session** via `-c key=value` : PACT ne modifie jamais
       `~/.codex/config.toml`. Si une version n'accepte pas les hooks en `-c`, l'adaptateur se
       rabat sur `-c notify=[...]` et sur l'heuristique.
       Version : Codex 0.155.1 puis 0.156.1 (caractérisé le 2026-09-24) expose `hooks` comme
       fonctionnalité stable, activée par défaut (`codex features list`). La détection vérifie la
       présence de ce flag ; sinon le CLI est marqué `unsupported-version` et l'accueil invite à le
       mettre à jour.
       **Confiance des hooks** : Codex n'exécute que des hooks dont la confiance a été enregistrée ;
       `--dangerously-bypass-hook-trust` lèverait cette protection pour *tous* les hooks actifs,
       y compris ceux d'un dépôt cloné non vérifié. PACT **n'utilise pas** ce flag. Stratégie : au
       premier lancement d'un agent Codex, si les hooks PACT ne sont pas approuvés, l'adaptateur
       fonctionne en mode dégradé (`notify` + heuristique) et l'accueil propose d'approuver les
       hooks PACT une fois. Mécanisme d'approbation : voir « Caractérisation T049 » ci-dessous.
  2. **Repli heuristique** : fin de processus (code de sortie), inactivité de sortie, motifs
     texte propres au CLI (ex. `? ` en début de ligne de confirmation, « rate limit »). Utilisé
     pour « Autre CLI » et en complément.
- **Relais des hooks** : le processus principal écoute sur `127.0.0.1:<port aléatoire>` (serveur
  HTTP local). Chaque agent reçoit `PACT_HOOK_URL` et un jeton unique `PACT_AGENT_TOKEN` ; toute
  requête sans jeton valide est rejetée. Pour les CLI sans hooks HTTP, la commande de hook est
  `"<exécutable Electron>" <bridge.js>` avec `ELECTRON_RUN_AS_NODE=1` (pas de dépendance à
  `curl` ou à Node sur la machine).
- **Réponse Autoriser / Refuser** : l'adaptateur envoie au PTY la séquence de touches attendue par
  la boîte de dialogue du CLI (par ex. `Entrée` sur l'option sélectionnée, `Échap` pour refuser).
  Le terminal reste la source de vérité : l'utilisateur peut aussi répondre au clavier.
- **Rationale** : les hooks donnent des transitions fiables et rapides (SC-003) ; le repli garde
  les CLI inconnus utilisables.
- **Alternatives** : parsing pur de la sortie (fragile aux mises à jour des TUI) ; mode SDK
  `--print` (perd le CLI brut, contraire à FR-020).

### Caractérisation T049 (2026-09-24, macOS, Claude Code 2.1.281, Codex 0.156.1)

Méthode : TUI interactif piloté par node-pty (120×40) dans un dépôt jetable, écran rendu par
`@xterm/headless`, hooks reçus par un serveur HTTP local. Variables `CLAUDECODE` et
`CLAUDE_CODE_*` retirées de l'environnement du CLI lancé.

**Claude Code**

- **Hooks HTTP** : `{"type":"http","url":…,"headers":{"Authorization":"Bearer $PACT_AGENT_TOKEN"},
  "allowedEnvVars":["PACT_AGENT_TOKEN"]}` fonctionne. Le jeton est interpolé depuis
  l'environnement de l'agent et arrive dans l'en-tête `authorization`. Le jeton n'apparaît donc
  jamais dans les arguments du processus. L'URL, elle, est écrite en clair dans `--settings`, à
  chaque lancement. Corps POST JSON.
- **`SessionStart` n'accepte pas les hooks HTTP** (journal de debug : « HTTP hooks are not supported
  for SessionStart »). Il faut un hook `command` : le pont `hook-bridge` (Electron en mode Node).
  Tous les autres événements passent en HTTP.
- **Charges observées** (champs communs : `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, `prompt_id` sauf pour `SessionStart`) :
  - `SessionStart` : `source` (`startup` | `resume`), `model`. `session_id` = l'UUID de
    `--session-id` ou de `--resume`.
  - `UserPromptSubmit` : `prompt` (texte saisi), `permission_mode`.
  - `PermissionRequest` : `tool_name`, `tool_input`, `permission_suggestions`. Il arrive **dès**
    l'ouverture de la boîte, alors que `Notification`/`permission_prompt` arrive ≈ 6 s plus tard.
    Le signal « attend une réponse » est donc `PermissionRequest`.
  - `Notification` : `notification_type` = `permission_prompt` (« Claude needs your permission »)
    ou `idle_prompt` (« Claude is waiting for your input », entre 15 et 60 s après `Stop`).
  - `Stop` : `last_assistant_message`, `stop_hook_active`, `background_tasks`.
  - `SessionEnd` : `reason` = `other` à la fermeture du PTY.
  - `StopFailure` et les notifications `quota_auto_resume_*` n'ont **pas été observés** : les
    provoquer demande une vraie limite de débit. Source : documentation.
- **`permission_mode` dans les charges** : `--permission-mode manual` apparaît comme `default`.
  `auto` et `acceptEdits` apparaissent sous leur nom.
- **Boîte d'autorisation** (« Do you want to proceed? »), options numérotées, flèches et Entrée
  acceptés :
  - `manual`, commande Bash : `1. Yes`, `2. Yes, and always allow access to <dossier>…`,
    `3. Yes, and switch to auto mode`, `4. No`.
  - `acceptEdits` + règle `permissions.ask` : `1. Yes`, `2. No`, avec la mention « Permission rule
    Bash(rm *) requires confirmation ».
  - Touches : `1` approuve immédiatement (sans Entrée). **Échap** refuse, et reste valide quel que
    soit le nombre d'options. `4` (No) refuse aussi. « Toujours pour ce worktree » (FR-034) ne passe
    **pas** par une touche, car la position de l'option varie : il passe par la réponse du hook
    `PermissionRequest`.
  - **Un refus (Échap ou No) interrompt le tour sans `Stop` ni `Notification`**. Après avoir envoyé
    un refus, l'adaptateur fait lui-même passer l'agent à `awaiting-prompt`.
- **Délai d'entrée** : pendant ≈ 2 s après l'affichage, le TUI ignore les touches. Il faut attendre
  l'écran avant d'envoyer une touche.
- **Confiance du dossier** : au premier lancement dans un dossier non approuvé, Claude Code affiche
  « Accessing workspace… Is this a project you created or one you trust? » (`❯ No, exit` présélectionné).
  Aucun hook n'est émis avant la réponse. Un worktree `<repo>/.worktrees/…` **hérite** de la
  confiance déjà accordée au dépôt. PACT n'écrit jamais `~/.claude.json` : l'utilisateur répond
  dans le terminal, et l'heuristique de sortie (« trust this folder ») met l'agent en attente de
  réponse.
- **`--permission-mode auto`** : accepté pour ce compte (Claude Pro). La barre d'état affiche
  « auto mode on », et `touch` s'exécute sans boîte. Le repli `acceptEdits` reste nécessaire pour les
  comptes où `auto` est indisponible.
- **`--resume <uuid>`** : même `session_id`, `SessionStart.source` = `resume`.
- Les réglages et plugins de l'utilisateur (`~/.claude/settings.json`) s'appliquent en plus des
  `--settings` de PACT : les hooks de PACT s'ajoutent sans rien remplacer.

**Codex 0.156.1**

- **Injection** : `-c 'hooks.<Événement>=[{hooks=[{type="command",command="…"}]}]'` fonctionne
  (TOML en ligne, un `-c` par événement). **Pas de hooks HTTP** (types `command` et `mcp_tool`) :
  tout passe par le pont `hook-bridge`, qui lit la charge sur stdin et la relaie avec le jeton. Le
  hook hérite de l'environnement de l'agent (`PACT_HOOK_URL`, `PACT_AGENT_TOKEN` reçus).
- **Confiance des hooks** : au démarrage, s'il y a des hooks nouveaux ou modifiés, Codex affiche
  « Hooks need review — N hooks are new or changed » avec `1. Review hooks`,
  `2. Trust all and continue`, `3. Continue without trusting (hooks won't run)`.
  - « Trust all » écrit dans `~/.codex/config.toml` une entrée
    `[hooks.state."/<session-flags>/config.toml:<événement_snake>:<groupe>:<index>"]
    trusted_hash = "sha256:…"` par hook. Cette confiance **persiste** d'un lancement à l'autre
    tant que la définition du hook ne change pas. Changer le jeton (variable d'environnement) ne
    redemande rien. En revanche, un changement de la commande (chemin de l'exécutable Electron ou
    du pont après une mise à jour de PACT) redemande une revue : la commande doit rester stable, et
    l'URL et le jeton ne passent que par l'environnement.
  - « Continue without trusting » n'écrit rien. Les hooks ne tournent pas, et le TUI affiche
    « Hook failed — hook exited with code 1 » pour les hooks non approuvés. C'est le déclencheur du
    mode dégradé : `SessionStart` n'arrive pas.
  - Les touches numériques ne choisissent pas l'option dans cet écran : il faut les flèches puis
    Entrée. PACT ne répond jamais à cet écran à la place de l'utilisateur.
- **Confiance du dossier** : « Trust this folder? … Your trust decision will be saved » (`1. Trust
  and continue` présélectionné) écrit `[projects."<chemin>"] trust_level = "trusted"`. Un worktree
  sous un dépôt approuvé **hérite** de cette confiance.
- **Invite de mise à jour au démarrage** : elle peut précéder tout le reste, et Entrée lance la mise
  à jour (`brew upgrade codex`). PACT lance donc Codex avec `-c check_for_update_on_startup=false`
  et n'envoie jamais de touche avant d'avoir reconnu l'écran.
- **Charges observées** (champs communs : `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, `model`, `permission_mode`) :
  - `SessionStart` : `source` = `startup`. Le **`session_id` sert pour `codex resume`**.
  - `UserPromptSubmit` : `turn_id`, `prompt`.
  - `PermissionRequest` : `tool_name` (`Bash`), `tool_input.command`, `tool_input.description`.
  - `Stop` : `turn_id`, `last_assistant_message`.
  - `permission_mode` : `-a never` → `bypassPermissions`, `-a on-request` → `default`.
- **`notify`** (`-c notify=["<exe>","<arg>"]`, charge JSON en dernier argument, sans revue) :
  `{"type":"agent-turn-complete","thread-id","turn-id","cwd","client":"codex-tui",
  "input-messages":[…],"last-assistant-message"}`. Codex émet aussi un `notify` pour un fil
  interne de génération de titre, avec un **autre** `thread-id`. L'adaptateur ne garde que le
  `thread-id` de la session (celui de `SessionStart`, ou à défaut celui dont `input-messages`
  contient la consigne saisie).
- **Boîte d'approbation** (« Would you like to run the following command? ») : `1. Yes, proceed (y)`,
  `2. Yes, and don't ask again for commands that start with … (p)`,
  `3. No, and tell Codex what to do differently (esc)`. Touches : `y` approuve, **Échap**
  refuse. Un refus interrompt le tour (« Conversation interrupted ») **sans `Stop`**, comme
  pour Claude Code.
- **`writable_roots`** (vérifié sans modèle via `codex sandbox`, dans un worktree, avec
  `exclude_slash_tmp` et `exclude_tmpdir_env_var` pour que `/tmp` ne fausse pas le test) :
  sans `sandbox_workspace_write.writable_roots=["<repo>/.git"]`, on obtient
  `git commit` → « Impossible de créer '<repo>/.git/worktrees/<nom>/index.lock' : Operation not
  permitted ». Avec la racine `.git`, le commit passe. En `read-only`, `touch` est refusé.

## R5. Niveaux d'autorisation par CLI

Sources : `claude --help` (2.1.281 : modes `acceptEdits`, `auto`, `bypassPermissions`, `manual`,
`dontAsk`, `plan`), documentation Claude Code « Configure permissions », référence de
configuration Codex (`approval_policy` : `on-request`, `never`, `granular` ; `untrusted` non
supporté, `on-failure` déprécié ; `sandbox_mode` : `read-only`, `workspace-write`,
`danger-full-access`).

| Niveau PACT | Claude Code | Codex |
|-------------|-------------|-------|
| Toujours autoriser (« Tout auto », défaut) | `--permission-mode auto` (approbation automatique avec vérifications de sécurité) ; repli `acceptEdits` si le mode `auto` n'est pas disponible pour le compte | `-a never -s workspace-write` + `-c sandbox_workspace_write.writable_roots=["<repo>/.git"]` |
| Actions sensibles (« Auto · worktree ») | `--permission-mode acceptEdits` + règles `permissions.ask` (réseau, suppression, chemins hors worktree) injectées via `--settings` | `-a on-request -s workspace-write` + même `writable_roots` |
| Toujours demander (« Demander ») | `--permission-mode manual` | `-a on-request -s read-only` (toute écriture exige une approbation) |

- **Pas de `bypassPermissions` ni de `danger-full-access` dans le socle** : aucun des deux ne
  confine l'agent, alors que l'écran 1m promet « les agents agissent seuls dans leur worktree ».
  Le libellé de 1m sera ajusté à ce que garantit réellement chaque CLI (FR-012).
- **`writable_roots`** : un worktree Git stocke ses métadonnées dans `<repo>/.git/worktrees/<nom>`,
  hors du dossier du worktree ; sans cette racine en écriture, le sandbox `workspace-write` de
  Codex empêcherait `git commit`. Vérifié par un test d'intégration avec le vrai Codex (optionnel
  en CI, obligatoire avant livraison).
- Les valeurs sont revérifiées à la détection (`--help`) et figées dans les tests de contrat de
  chaque adaptateur.

## R6. Sessions, reprise et relance

- **Claude Code** : PACT génère un UUID et lance avec `--session-id <uuid>` ; « Reprendre » =
  `--resume <uuid>` ; « Relancer » = nouvelle session puis retape la consigne initiale mémorisée.
- **Codex** : l'identifiant est lu dans l'événement `SessionStart` (hooks approuvés), sinon dans le
  `thread-id` du `notify` de la session (T049) ; « Reprendre » = `codex resume <SESSION_ID>`.
- **Consigne initiale** : capturée via `UserPromptSubmit` (premier prompt) ; repli : première ligne
  saisie suivie d'Entrée dans le PTY.
- **Limite de débit — détection** : Claude Code émet `StopFailure` avec le type d'erreur
  `rate_limit` à la fin du tour ; **le processus reste ouvert**. Codex et « Autre CLI » : motif de
  sortie ou code de sortie. L'heure de levée est extraite du message quand il en contient une.
  Non observé en T049 (il faudrait atteindre une vraie limite) : la forme exacte de la charge
  `StopFailure` s'appuie sur la documentation, et le faux CLI la reproduit.
- **Limite de débit — reprise (FR-035/036)** : la décision est prise en amont (écran 1m). Si le
  processus est vivant, reprendre = taper « continue » + Entrée dans l'invite ; s'il est terminé,
  reprendre = `buildResume`. Sans heure connue : backoff 1, 2, 4, 8, 15, 15… minutes.
- **Pas de double reprise** : Claude Code possède sa propre reprise après quota (notifications
  `quota_auto_resume_fired` / `_stale` / `_disabled`, comportement non documenté en détail). PACT
  écoute ces notifications : `quota_auto_resume_fired` ou un `UserPromptSubmit` annule la reprise
  programmée par PACT. Le comportement exact sera caractérisé par un test manuel au début de
  l'implémentation et reproduit dans un scénario du faux CLI.

## R7. Git et worktrees

- **Decision** : CLI `git` (≥ 2.40) appelé via `execFile` depuis le processus principal, derrière
  un service `GitService` testé contre de vrais dépôts temporaires.
  - Création : `git worktree add -b agent/<cli>-<n> .worktrees/<cli>-<n> <base>`.
  - Exclusion : ajout de `/.worktrees/` dans `.git/info/exclude` (jamais dans `.gitignore`).
  - Branche actuelle : `git -C <worktree> branch --show-current`, relue à chaque `Stop` et toutes
    les 5 s tant que l'agent tourne (branche renommée par l'agent).
  - Suppression : `git worktree remove` puis `git branch -D` si l'utilisateur le choisit.
  - Clonage : `git clone --progress` avec lecture de la progression sur stderr.
- **Rationale** : le CLI git gère les worktrees intégralement et réutilise les identifiants
  (credential helper, SSH) de l'utilisateur.
- **Alternatives** : `isomorphic-git` (pas de worktrees) ; `simple-git` (surcouche non nécessaire).

## R8. Ports

- **Decision** : port = 3000 + position ; test de disponibilité par ouverture/fermeture d'un
  serveur TCP sur `127.0.0.1` et `::1` ; si occupé, port libre suivant au-delà de 3006. Transmis à
  l'agent via `PORT` et `PACT_PORT`.

## R9. Persistance

- **Decision** : fichiers JSON dans le dossier `userData` d'Electron, validés par des schémas
  `zod`, écriture atomique (fichier temporaire + renommage), un fichier global (`state.json` :
  workspaces ouverts, récents, CLI ajoutés, préférence d'autorisation globale) et un par workspace
  (`workspaces/<hash>.json` : agents, compteurs, préférences du projet). Champ `schemaVersion` pour
  les migrations.
- **Alternatives** : SQLite (surdimensionné, module natif en plus) ; `electron-store` (utile mais
  masque la validation ; zod déjà nécessaire pour l'IPC).

## R10. UI et état

- **Decision** : React 19 + TypeScript strict, Zustand 5 pour l'état du renderer, CSS Modules avec
  variables CSS pour les tokens de la direction 1c. Polices Instrument Sans et JetBrains Mono
  embarquées (pas de chargement réseau).
- **Tokens** : fond `#0d1117`, surface `#131820`, texte `#dfe4eb`, texte secondaire `#8b94a4`,
  bordure `#27303c` ; agents : Purple `#a07fdc`, Cyan `#6cc5e0`, Green `#45c664`,
  Magenta `#d466a8`, Yellow `#c9c85a`, Slate `#5a6890` ; états : attend (orange) `#d6934f`,
  erreur/refuser (rouge) `#c94646`, accepter (vert) `#45c664`, action (cyan) `#6cc5e0` ;
  rayon 6 px.
- **Animations** : CSS + `requestAnimationFrame` pour la grille de points réactive et les
  particules (canvas 2D), désactivées si `prefers-reduced-motion` (FR-042). Aucun effet à
  l'intérieur des terminaux (FR-020).

## R11. Communication main ↔ renderer

- **Decision** : `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. Le preload
  expose une API typée unique (`window.pact`) ; chaque canal IPC a un schéma zod partagé
  (`src/shared/ipc.ts`) validé des deux côtés. Voir `contracts/ipc.md`.

## R12. Tests, qualité et CI (Constitution I, II, III, V)

- **Unitaires / intégration** : Vitest 5 (`node` pour main, `jsdom` + Testing Library pour le
  renderer). Intégration Git contre des dépôts temporaires réels ; intégration PTY contre un
  **faux CLI** (R13).
- **Bout en bout** : Playwright 1.63 (`_electron.launch`) sur l'app packagée en mode test, avec le
  faux CLI déclaré comme CLI détecté.
- **Couverture** : `@vitest/coverage-v8`, seuil global **80 % lignes / 80 % branches** sur
  `src/main` et `src/shared`, **70 %** sur `src/renderer` ; la CI échoue si le seuil baisse
  (Constitution III).
- **Qualité** : TypeScript **5.9** (`strict`, `noUncheckedIndexedAccess`), ESLint 10 (flat config,
  `typescript-eslint`, `react-hooks`), Prettier 3. TypeScript 7 (compilateur natif) est écarté pour
  l'instant : `typescript-eslint` exige `typescript >=4.8.4 <6.1.0`. À réévaluer quand ce sera
  supporté. `npm run check` = typecheck + lint + format +
  tests.
- **CI** : GitHub Actions, matrice `macos-latest` × `windows-latest`, Node 22 LTS ; jobs `check`,
  `e2e` ; protection de branche sur `main` exigeant les deux jobs verts.
- **Fins de ligne** : `.gitattributes` avec `* text=auto eol=lf`.

## R13. Faux CLI de test (clé du TDD sur la partie la plus risquée)

- **Decision** : `tests/fixtures/fake-cli/` — un script Node piloté par un scénario JSON
  (variable `FAKE_CLI_SCENARIO`) qui imite un CLI d'agent : affiche une invite, lit une consigne,
  émet des lignes de travail, pose une question d'autorisation, appelle les hooks PACT
  (`PACT_HOOK_URL`), s'arrête avec un code d'erreur ou un message de limite de débit, accepte
  `--session-id` / `--resume`. Déclaré via un adaptateur `fake` enregistré uniquement en test.
- **Rationale** : rend testables sans réseau ni compte payant tous les scénarios des US2, US3, US4
  et US7, de façon déterministe sur macOS et Windows.

## R14. Packaging

- **Decision** : electron-builder 26 ; `.dmg` (macOS, universel arm64 + x64) et NSIS (Windows
  x64 / arm64). Recompilation de node-pty via `@electron/rebuild` (`postinstall`). Signature et
  notarisation hors du socle (documentées, non bloquantes).
