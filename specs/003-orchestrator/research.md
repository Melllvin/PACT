# Research: Orchestrateur

S'appuie sur `specs/001-agent-workspace-core/research.md` et `specs/002-review-integration/research.md`.
La pile, git via `execFile`, la persistance JSON + zod, les règles IPC, les tests, le faux CLI et
l'apparence ne changent pas. R1 et R2 ont été vérifiés par une sonde sur Claude Code 2.1.314 le
2026-10-31 (plugin de session, serveur MCP HTTP, jeton par variable d'environnement, règle
d'autorisation).

## R1. Comment l'orchestrateur parle à PACT

- **Décision** : un serveur **MCP** en HTTP local (transport « streamable HTTP »), servi par PACT sur
  `127.0.0.1`, que l'orchestrateur utilise comme n'importe quel serveur MCP. Chaque action de la
  spec est un outil MCP (contracts/mcp-tools.md).
  - **Protocole minimal, écrit dans PACT** : JSON-RPC 2.0 sur `POST /mcp`. Méthodes servies :
    `initialize`, `ping`, `tools/list`, `tools/call`. Une notification (sans `id`) reçoit `202`
    sans corps ; `GET /mcp` reçoit `405` (pas de flux serveur) ; une méthode inconnue reçoit
    l'erreur `-32601`. La sonde a relevé l'ordre réel : `server/discover`, `initialize`,
    `notifications/initialized`, `GET`, `tools/list`, puis `tools/call`.
  - **Serveur** : le `HookServer` de 001 (R4), étendu pour router `/mcp` vers le gestionnaire de
    l'orchestrateur et lui laisser choisir le statut HTTP. Une seule écoute locale pour les hooks et
    l'orchestrateur.
- **Rationale** :
  - Des outils typés (schéma d'entrée, résultat texte) que Claude Code sait appeler sans passer par
    un shell : pas de guillemets à échapper, pas de différence macOS / Windows, pas d'autorisation
    `Bash` à demander.
  - Le protocole utile tient en quatre méthodes ; une dépendance (`@modelcontextprotocol/sdk`)
    apporterait surtout des transports et des capacités inutiles ici (Constitution IV et V).
- **Alternatives** :
  - Un script `pact` fourni par le skill et lancé par l'outil `Bash` : demandes d'autorisation à
    chaque appel selon le niveau choisi, quoting `cmd` sous Windows, sortie à analyser.
  - Le SDK MCP officiel : dépendance de plus pour quatre méthodes.
  - Écrire dans un fichier surveillé par PACT : pas de réponse synchrone, pas d'attente propre.

## R2. Livrer le skill et l'accès sans toucher la configuration de l'utilisateur

- **Décision** : à chaque démarrage ou reprise de l'orchestrateur, PACT écrit un **plugin de
  session** dans `userData/orchestrator/<agentId>/plugin/` et le passe à Claude Code par
  `--plugin-dir`.
  - `.claude-plugin/plugin.json` : `{ "name": "pact" }`.
  - `skills/orchestrateur/SKILL.md` : la méthode (lister, répartir, attendre, lire, corriger, demander
    l'intégration) et les règles (une consigne précise par agent, ne jamais demander d'intégration
    sans avoir lu les changements et l'état des tests, les questions des agents sont à
    l'utilisateur). Visible comme `pact:orchestrateur`.
  - `.mcp.json` : le serveur `pact` en `http`, l'URL du `HookServer`, et l'en-tête
    `X-Pact-Token: ${PACT_ORCHESTRATOR_TOKEN}`. Le jeton n'est ni dans les arguments ni dans le
    fichier : Claude Code le lit dans l'environnement de l'agent, comme le jeton des hooks.
  - Les paramètres de session (`--settings`, déjà utilisés pour les hooks) ajoutent
    `permissions.allow: ["mcp__plugin_pact_pact__*"]` : les outils PACT ne demandent pas
    d'autorisation, quel que soit le niveau choisi (la sonde a vérifié le nom et la règle).
  - `--append-system-prompt` rappelle le rôle en une phrase et nomme le skill.
- **Rationale** : rien n'est écrit dans `~/.claude` ni dans le dépôt (spec, Assumptions) ; le
  plugin suit l'URL du serveur, qui change à chaque lancement de PACT.
- **Alternatives** : `--mcp-config` seul (pas de skill) ; un skill dans `.claude/skills` du worktree
  (il serait intégré dans `main` avec le travail de l'orchestrateur) ; `~/.claude/skills` (modifie la
  configuration de l'utilisateur, visible par toutes ses sessions).

## R3. Sécurité de l'accès

- **Décision** :
  - Un jeton de 32 octets par session d'orchestrateur, distinct du jeton des hooks, comparé en temps
    constant, régénéré à chaque démarrage et révoqué au retrait du rôle ou à la fermeture (FR-007).
  - Requêtes refusées si l'en-tête `Host` n'est pas `127.0.0.1:<port>` ou si un en-tête `Origin` est
    présent : une page web ne peut pas atteindre le serveur (rebinding DNS).
  - Les outils ne prennent que des identifiants d'agents et des textes ; aucun chemin absolu, aucune
    commande. Un chemin de fichier est relatif au dépôt, validé comme en 002 (`repoPathSchema`).
  - Chaque outil vérifie que l'agent visé est du même workspace, n'est pas l'orchestrateur et n'est
    pas un terminal libre (FR-008).
- **Rationale** : même modèle que les hooks (001 R4), plus la défense navigateur, car un outil MCP
  agit sur d'autres agents.

## R4. Consignes et marque « ◎ de l'orchestrateur »

- **Décision** : `send_prompt` passe par la file de `AgentManager.sendPrompt` (002 R7), sans
  changement de son comportement (une consigne par tour, jamais pendant une question). Les éléments
  de la file gagnent une origine (`review` ou `orchestrator`). Quand une consigne de l'orchestrateur
  est tapée, PACT émet `orchestrator:prompted` ; le renderer affiche la marque jusqu'au retour de
  l'agent à un état prêt, comme « correction en cours » en 002.
- **Rationale** : une seule file (Constitution IV) ; le retrait du rôle retire les éléments
  d'origine `orchestrator` encore en attente (US5/AC2).

## R5. Attendre sans interroger en boucle

- **Décision** : `wait_for_agents` est un appel long tenu par PACT. Il se termine au premier
  événement qui concerne les agents demandés (ou tous) : fin de tour, question en attente, erreur,
  fermeture, issue d'une demande d'intégration. Sinon il se termine au délai choisi (1 à 600 s,
  300 par défaut), avec « aucun changement ».
  - Les événements survenus entre deux attentes sont gardés dans une file par orchestrateur (au plus
    100) et rendus par l'attente suivante, sans délai : rien n'est perdu entre deux appels.
  - L'environnement de l'orchestrateur porte `MCP_TOOL_TIMEOUT` au-dessus du délai maximal, pour
    que Claude Code n'abandonne pas l'appel.
- **Rationale** : SC-002 (réveil en moins de 2 s) sans boucle d'interrogation qui consommerait le
  contexte de l'orchestrateur.
- **À caractériser** : la prise en compte de `MCP_TOOL_TIMEOUT` pour un serveur `http` sur une vraie
  session (tâche de caractérisation, comme T049 de 001).

## R6. Demandes d'intégration

- **Décision** : `request_integration` enregistre une demande sur le workspace (une par agent, la
  dernière remplace la précédente, FR-020) et rend aussitôt « en attente de l'utilisateur ». À faire
  affiche « ◎ Intégrer <agent> → <main> ? » avec le message, « Revue → », « ✓ Intégrer » et
  « Refuser ».
  - « ✓ Intégrer » appelle `integration:start` de 002 avec la demande (mode, message, après :
    fermer la tuile et garder le worktree, la suppression restant à l'utilisateur) ; un agent qui
    travaille demande la confirmation de 002 FR-025.
  - L'issue (intégré avec le commit, refusé, conflit avec les fichiers, échoué avec l'erreur) devient
    un événement de R5 et une entrée du journal.
  - Les demandes en attente sont persistées avec le workspace (zod, valeur par défaut `[]`) et
    reproposées après un redémarrage (US5/AC3).
- **Rationale** : SC-003 : `IntegrationService` n'est appelé que par une action de l'utilisateur.

## R7. Lancer et fermer

- **Décision** : `launch_agent` construit un `AgentDraft` (002 `agentDraftSchema`) et appelle
  `AgentManager.launch`, donc les mêmes validations (limite, branche, port, CLI) et les mêmes
  messages. Le niveau d'autorisation est celui que `PermissionService.resolve` donne pour le
  workspace ; sans niveau choisi, la demande est refusée (« Choisissez d'abord les autorisations dans
  PACT »). `close_agent` appelle `AgentManager.close(id, { removeWorktree: false })` (FR-016).
- **Rationale** : réutilisation complète du lanceur (Constitution IV).

## R8. Rôle, persistance et adaptateurs

- **Décision** :
  - `Agent.role: 'orchestrator' | null`, valeur par défaut `null` : les fichiers de 001/002 se
    chargent sans migration.
  - Le brouillon de lancement gagne `orchestrator: boolean` ; la validation refuse un second
    orchestrateur dans le workspace et un CLI qui ne le permet pas.
  - Les adaptateurs déclarent `supportsOrchestrator`. `ClaudeCodeAdapter` l'implémente par R2 ; le
    faux CLI aussi, en recevant l'URL et le jeton dans son environnement, pour les tests de bout en
    bout. Codex et les CLI génériques ne le proposent pas (spec, hors périmètre).
- **Rationale** : seul l'adaptateur sait comment donner un skill à son CLI.

## R9. Journal des actions

- **Décision** : `OrchestratorService` garde en mémoire les 200 dernières actions de chaque
  orchestrateur (heure, outil, agent visé, résultat, sans le texte des lectures). Le renderer les
  charge par `orchestrator:actions` et suit `orchestrator:action`. Le Focus de l'orchestrateur ajoute
  un onglet « ◎ Actions ».
- **Rationale** : FR-021 limite le journal à la session ; rien n'est écrit sur disque.

## R10. Disposition « chef au centre »

- **Décision** : `TileGrid` reçoit une tuile principale optionnelle. Avec un orchestrateur : la
  rangée du haut, pleine largeur, à environ 60 % de la hauteur, contient sa tuile au centre ; les
  autres tuiles se répartissent dessous sur une rangée (deux au-delà de 4 tuiles). Le reste du socle
  (Focus, pastilles, À faire, Revue) est inchangé.
- **Rationale** : FR-003, sans nouvelle vue à apprendre.

## R11. Tests

- **Décision** :
  - **Unitaires** : protocole MCP (méthodes, notifications, erreurs, `Host`/`Origin`), schémas des
    outils, file d'événements de R5, génération du plugin, arguments de `ClaudeCodeAdapter`
    (`--plugin-dir`, règle d'autorisation, jeton absent des arguments).
  - **Intégration** : `OrchestratorService` contre de vrais agents du faux CLI et de vrais dépôts,
    les outils appelés en HTTP comme le ferait Claude Code.
  - **Bout en bout** : une nouvelle étape `mcp` du faux CLI appelle les outils avec le jeton de son
    environnement ; un faux orchestrateur répartit deux consignes, attend, lit et demande une
    intégration que le test confirme dans PACT.
  - **Caractérisation** : une session réelle de Claude Code orchestrateur (R5 et la découverte du
    skill en interactif), consignée dans la PR.
