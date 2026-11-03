# Research: Chaîne de livraison

Décisions de la phase 0. Chaque point dit ce qui est réutilisé de 001 à 003 avant ce qui est ajouté
(constitution IV). Sondes du 2026-11-03 : Claude Code 2.1.316, Codex 0.163.0.

## R1. Rôles : une extension de `Agent.role`

- **Decision**: `Agent.role` (003, `'orchestrator' | null`) devient
  `'orchestrator' | 'spec' | 'design' | 'dev' | 'test' | 'recap' | null`, défaut `null`, sans
  migration (zod `default`). Le brouillon de lancement gagne `role` ; `orchestrator: true` de 003 reste
  accepté et vaut `role: 'orchestrator'`.
- **Rationale**: un seul champ, déjà persisté, déjà lu par la tuile, la grille et le service de
  l'orchestrateur. L'unicité de l'orchestrateur (003 R8) ne change pas ; les autres rôles peuvent être
  portés par plusieurs agents.
- **Alternatives considered**: un champ `roles[]` (un agent n'a qu'un rôle, FR-001) ; un objet
  « équipe » séparé (duplique l'état des agents).

## R2. Profils de rôle et plafond de modèle

- **Decision**: `Workspace.roleProfiles` : un `RoleProfile` par rôle (`cliId`, `model`, `effort`,
  `maxModel`, `escalate`), défaut calculé et non écrit tant que l'utilisateur n'a rien réglé. Les
  modèles sont ordonnés par **paliers** par adaptateur (`modelTiers(): string[][]`, du plus petit au
  plus fort ; Claude Code : `haiku` < `sonnet` < `opus` ; Codex : vide tant que le CLI ne les liste
  pas). Un modèle hors paliers (nom libre tapé par l'utilisateur) est accepté mais ne peut jamais
  dépasser le plafond : le plafond s'applique seulement aux noms connus, et l'orchestrateur ne peut
  demander que des noms connus.
- **Rationale**: le plafond est une règle d'ordre ; sans ordre connu, refuser serait arbitraire. Les
  noms libres restent possibles pour l'utilisateur (Assumptions de la spec).
- **Effort**: Claude Code `--effort low|medium|high|xhigh|max` (sonde) ; Codex
  `-c model_reasoning_effort=<low|medium|high>` ; les autres CLI l'ignorent.
- **Escalade (FR-007)**: au tour 3 d'une boucle, le palier suivant, borné par `maxModel`. Elle ne
  change pas le profil, seulement le lancement du dev du tour 3 (le dev est relancé avec
  `--resume` de sa session, modèle changé ; 001 a déjà `buildResume`).
- **Alternatives considered**: liste de modèles en dur dans le renderer (non universelle) ; un prix
  par modèle (hors périmètre, 005).

## R3. Livrer les skills de rôle sans toucher la configuration de l'utilisateur

- **Decision**: les skills sont des fichiers source de PACT (`resources/skills/<nom>/SKILL.md` +
  `resources/skills/pact-contract.md`), au format Agent Skills (front matter `name`, `description`).
  À chaque lancement, PACT copie dans `userData/roles/<agentId>/` le skill du rôle et le contrat
  (et, pour l'orchestrateur, la liste des autres rôles) puis les fournit selon le CLI :

  | CLI | Voie native | Sonde |
  |---|---|---|
  | Claude Code | plugin de session `--plugin-dir` (celui de 003, généralisé : `pact:<rôle>`) | 003 R2 |
  | Codex | `-c developer_instructions="…"` : rôle, chemin du skill et du contrat à lire | `developer_instructions` présent dans le binaire 0.163 |
  | Générique | fichier `.pact/ROLE.md` du worktree + première consigne « Lis .pact/ROLE.md » | — |

- **Rationale**: Claude Code charge les plugins de session sans écrire dans `~/.claude` (003). Codex
  lit `.agents/skills` du dépôt et `~/.codex/skills`, deux emplacements à éviter (le dépôt de
  l'utilisateur, sa configuration) ; `developer_instructions` est par session. Le contenu reste le
  même (FR-013) : la consigne renvoie aux mêmes fichiers. Codex lit hors du worktree en
  `workspace-write` (lecture non restreinte).
- **Repli générique**: PACT n'écrit jamais dans un `AGENTS.md` existant (spec, edge case) ; il écrit
  son propre `.pact/ROLE.md`, ajoute `/.pact/ROLE.md` à `.git/info/exclude` (le reste de `.pact/`, issues et recap, est versionné) (commun aux worktrees, sans effet
  sur le contenu suivi), et le retire à la fermeture. Les changements à relire et à intégrer partent
  de `git status`, qui respecte cette exclusion : rien à filtrer dans `ReviewService`.
- **Alternatives considered**: `CODEX_HOME` temporaire (perd l'authentification de l'utilisateur) ;
  écrire `.agents/skills/pact-*` dans le worktree (visible dans la revue, et Codex le lirait dans tous
  les worktrees) ; `AGENTS.md` (fichier de l'utilisateur).
- **À caractériser** (tâche dédiée, comme 003 T047) : que Codex suive la consigne de lecture sans
  demande d'autorisation ; la longueur de `developer_instructions` sous Windows (limite de ligne de
  commande de 32 767 caractères : la consigne reste courte, le contenu est dans les fichiers).

## R4. Orchestrateur sous Codex (FR-031)

- **Decision**: `CodexAdapter.supportsOrchestrator = true`, avec
  `-c mcp_servers.pact.url="<url>"` et
  `-c mcp_servers.pact.env_http_headers={ "X-Pact-Token" = "PACT_ORCHESTRATOR_TOKEN" }` ; le jeton
  reste dans l'environnement de l'agent comme sous Claude Code (003 R3), jamais dans les arguments.
  Le skill orchestrateur passe par R3.
- **Rationale**: `mcp add --url` et `env_http_headers` existent en 0.163 (sonde). Le serveur MCP de
  PACT ne change pas.
- **À caractériser**: autorisation des outils MCP sous Codex (approbation par appel ou non), délai
  d'un appel long (`wait_for_agents`, `tool_timeout_sec`).
- **Alternatives considered**: `bearer_token_env_var` (impose d'accepter aussi `Authorization` dans
  `HookServer` ; gardé en repli si `env_http_headers` échoue).

## R5. Rapport de relais : un outil MCP pour tous les rôles

- **Decision**: chaque agent avec un rôle reçoit aussi le serveur MCP `pact`, mais avec un jeton
  **d'agent** qui n'ouvre qu'un outil : `submit_report`. Le rapport (contracts/handoff-report.md) est
  validé par zod ; refusé avec la raison s'il est incomplet (FR-015). Valide, il devient un événement
  `report` de l'attente de l'orchestrateur (003 R5, FR-016) et est rangé dans la boucle de l'issue.
- **Rationale**: le serveur, l'authentification par jeton et la file d'événements existent (003) ;
  un fichier de rapport dans le worktree serait visible dans la revue et sans validation immédiate.
- **Fin de tour sans rapport**: au `turn-finished` d'un agent avec un rôle engagé dans une boucle, sans
  rapport depuis le début du tour, l'orchestrateur reçoit `report-missing` ; le tour compte.
- **Alternatives considered**: parser la sortie du terminal (fragile) ; rapport en fichier JSON.

## R6. Boucle dev ↔ test et preuve par les codes de sortie

- **Decision**: `LoopService` (main) tient les boucles en mémoire et dans `Workspace.loops` (reprise
  après redémarrage). Outils orchestrateur : `start_loop { issue, dev, test }`, `next_round { issue }`.
  Le tour avance quand le test rend un verdict `defects` ; au 3ᵉ verdict `defects`, `next_round` est
  refusé, et l'issue passe `escalated` (élément À faire `loop-escalated`, FR-018).
- **Preuve (FR-019)**: un verdict `accepted` déclenche `TestRunner.run` (002) sur le worktree du dev,
  au tree courant. L'issue n'est `done` que si ce run, postérieur au dernier changement (même tree),
  rend 0. Sinon l'orchestrateur reçoit le code et la fin de sortie (`outputTail`, 002).
- **Testeur indépendant (FR-020)**: le verdict est rejeté si les fichiers changés par le test pendant
  son tour (diff des snapshots `GitService.snapshot` de début et fin de tour) sortent des motifs de
  tests du workspace (`Workspace.testPaths`, défaut `**/*.test.*`, `**/*.spec.*`, `tests/**`,
  `test/**`, `__tests__/**`).
- **Rationale**: tout réutilise `TestRunner`, `GitService.snapshot` et la file d'événements ; les
  compteurs vivent côté PACT, pas côté agent (SC-001).
- **Alternatives considered**: laisser l'orchestrateur compter (non garanti) ; lancer la CI distante
  (hors périmètre : push).

## R7. Fichiers communs entre agents (FR-021)

- **Decision**: à chaque `review:pending` recalculé (002 FR-002), comparer les chemins changés des
  agents non intégrés du workspace (`ReviewService.readChanges`, déjà en cache). Un recoupement
  nouveau → événement `overlap { agents, files }` pour l'orchestrateur et élément À faire `overlap`.
- **Rationale**: les changements sont déjà lus pour « Revue → » ; aucune surveillance de plus.

## R8. Issues : fichiers locaux d'abord, publication confirmée

- **Decision**: les issues sont des fichiers Markdown du worktree de l'orchestrateur,
  `.pact/issues/<id>.md`, au format Markdown à rubriques fixes (contracts/files.md), sans en-tête
  YAML (aucune dépendance de plus) ; versionnées comme le
  reste. Outil `register_issue { path }` : PACT lit le fichier, vérifie « prête » (critères Given/When/
  Then présents, aucune question ouverte : FR-022) et l'ajoute à `Workspace.issues`.
  `publish_issues { ids }` crée une demande dans À faire (« ◎ Créer N issues ? ») ; à la
  confirmation, PACT lance `gh issue create` dans le dépôt, avec l'environnement de l'utilisateur ;
  sans `gh` connecté ou sans dépôt distant, la demande est refusée avec la raison et les issues
  restent locales (FR-023).
- **spec-kit (FR-010)**: si le dépôt a `.specify/`, le skill `pact-spec` renvoie aux skills spec-kit
  (`speckit-specify`, `-clarify`, `-plan`, `-tasks`, `-analyze`, `-taskstoissues`), `pact-dev` à
  `speckit-implement`, `pact-test` à `speckit-converge`. Une tâche spec-kit devient une issue locale
  par `register_issue` (même format).
- **Rationale**: le même schéma de demande confirmée que 003 R6 ; `gh` est l'outil déjà utilisé par
  l'utilisateur ; aucune API GitHub dans PACT.
- **Alternatives considered**: API REST GitHub avec jeton dans PACT (gestion de secrets) ; issues
  seulement distantes (pas de dépôt distant = pas de chaîne).

## R9. Onglet Aperçu : rendu isolé, sans réseau

- **Decision**: l'onglet « Aperçu » du Focus (001 FR-033) affiche un `<iframe sandbox>` (sans
  `allow-same-origin`, scripts autorisés seulement pour la page elle-même) dont le contenu vient d'un
  protocole Electron dédié `pact-preview://<agentId>/<chemin>` servi par le main : il ne sert que des
  fichiers du worktree de l'agent (chemin normalisé, `repoPathSchema`), avec
  `Content-Security-Policy: default-src 'none'; img-src pact-preview: data:; style-src pact-preview:
  'unsafe-inline'; font-src pact-preview: data:; script-src pact-preview: 'unsafe-inline'`. Toute
  autre requête de la session de l'Aperçu est bloquée par `session.webRequest` et comptée ; l'onglet
  affiche « ressource externe bloquée » (FR-026). Markdown : rendu par le renderer en HTML statique
  (aucun script), avec la bibliothèque Markdown déjà présente si elle existe, sinon `marked` (seule
  dépendance nouvelle, justifiée en Complexity Tracking).
- **Liste**: fichiers `*.html` de `design/mockups/` et `.pact/recap.md` (contracts/files.md).
- **Rafraîchissement (FR-027)**: `ReviewService` suit déjà le worktree (002 R3) ; un changement du
  fichier affiché recharge l'iframe ; la position de défilement est relevée avant
  (`postMessage` du script injecté par PACT) et rétablie après.
- **Décision sur une maquette (FR-028)**: « ✓ Valider » / « ✕ Refuser » + commentaire →
  `preview:decide` → événement `mockup` de l'orchestrateur (< 1 s, SC-004).
- **Alternatives considered**: `webview` (déconseillé par Electron) ; `file://` (accès disque
  complet) ; `BrowserView` (fenêtre séparée, plus lourd).

## R10. Recap

- **Decision**: `.pact/recap.md` dans le worktree de l'orchestrateur, tenu par le skill `pact-recap`
  (ou l'orchestrateur), à partir de `get_loop` / `list_issues`, au format de contracts/files.md. PACT ne
  l'écrit pas : il l'affiche (R9) et fournit les données (issues, boucles, rapports). Il est intégré
  comme tout changement (002).
- **Rationale**: le recap versionné est une pratique retenue ; la logique de rédaction est un skill,
  pas du code (YAGNI).

## R11. La tuile de l'orchestrateur reste la plus grande (FR-006a)

- **Decision**: `TileGrid` en disposition « chef » (003 R10) : la rangée du chef occupe toute la
  largeur (suppression du `max-w-[1100px]`) et 3/5 de la hauteur ; les autres partagent les 2/5 en au
  plus 3 colonnes. Ainsi l'aire du chef (L × 3h/5) dépasse toujours celle d'un autre (≤ L × 2h/5),
  pour 1 à 5 agents et toute taille de fenêtre ; les minimums (240 px contre 180 px) gardent l'ordre.
  Test unitaire sur les styles calculés et e2e à trois tailles de fenêtre.
- **Rapports lisibles (FR-006a)**: la tuile du chef montre, sous son terminal, une bande « Rapports »
  (dernier rapport par agent : agent, issue, statut, tour) ; le Focus du chef a l'onglet
  « ◎ Rapports » à côté de « ◎ Actions » (003), avec le détail.
- **Rationale**: une règle de grille suffit, sans calcul en JS ; la bande réutilise les événements
  `report` (R5).

## R12. Tests

- Faux CLI : étapes `report` (appelle `submit_report`), `writeTests` (écrit dans `tests/`),
  `writeProd`, scénarios `loop-fail-always`, `loop-pass-round-2`, `design-mockup`.
- Faux CLI « sans skills » : l'adaptateur générique avec un exécutable de faux CLI, pour la voie
  `.pact/ROLE.md`.
- SC-007 : chaque suite d'intégration et e2e vérifie l'absence d'écriture sous un `HOME` temporaire
  (`~/.claude`, `~/.codex`) et dans les fichiers suivis du dépôt hors des changements de l'agent.
- SC-005 : e2e de l'Aperçu avec une maquette qui référence une police et un script distants : zéro
  requête sortie, mention « ressource externe bloquée ».
- Caractérisation manuelle (comme 003 T047) : Codex orchestrateur (R4), Codex + `developer_instructions`
  (R3), `--effort` de Claude Code.
