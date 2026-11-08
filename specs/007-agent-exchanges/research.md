# Research: Échanges entre agents et réveil

Toutes les décisions ci-dessous sont vérifiées contre le code de `origin/006-agents-view` (`6395875`).

## R1 — FR-012 : les hooks remettent-ils un texte à l'agent ?

- **Decision** : oui, sur Claude Code **2.1.318**, pour les deux hooks. PostToolUse répond
  `{ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: <pointeur> } }` ; Stop répond
  `{ decision: 'block', reason: <pointeur> }`.
- **Protocole** (2026-11-06) : `claude -p` avec `--settings` en ligne, `--setting-sources ""`,
  `--strict-mcp-config`, `--no-session-persistence`, modèle haiku, dossier temporaire, hooks HTTP vers un
  serveur local, comme l'adapter. Aucune touche simulée, aucune configuration de l'utilisateur modifiée.
- **Résultats observés** :

| Essai | Observé |
|---|---|
| PostToolUse seul | L'agent cite `POINTEUR-ALPHA-7431`, reçu seulement par `additionalContext`. |
| Stop `block` | L'agent cite `POINTEUR-BRAVO-9120`, reçu seulement par `reason` ; 3 tours d'API. |
| Second Stop | Arrive avec `stop_hook_active: true` ; PACT répond `{}` et la session finit, code 0. |

- **Limites** : mode `-p`, pas le mode interactif où vivent les agents ; pas de sous-agent dans l'essai, donc
  le filtre `agent_id` repose sur le comportement déjà caractérisé par `mapEvent`. Si le mode interactif diffère,
  le repli est la voie de fin de tour de FR-012, en passant `midTurnWake` à faux dans l'adapter.
- **Alternatives** : écrire dans le terminal en plein tour, rejeté par la spec ; ne pas valider, rejeté par FR-012.

## R2 — Une seule source : le journal du workspace

- **Decision** : `workspace.exchanges.messages`, 500 au plus, porte les messages d'agent **et** les événements
  de PACT. Chaque message a `unreadBy: string[]`. `get_events` et `wait_for_agents` lisent et retirent le lecteur
  de cette liste. Cela remplace la file `EventQueue` et la session en mémoire.
- **Rationale** : FR-004 et FR-019 exigent une lecture partagée qui survit au redémarrage. `unreadBy` permet de
  rendre les 20 plus récents et de laisser les plus anciens non lus, ce qu'un curseur unique ne sait pas faire
  (US5 sc.2). Le « curseur » de la spec devient cet état de lecture.
- **Éviction** : au-delà de 500, le plus ancien message lu par tous part d'abord ; sinon le plus ancien.
- **Alternatives** : un curseur par agent, qui ne tient pas US5 sc.2 ; garder `EventQueue` à côté d'un journal,
  qui duplique la logique (constitution IV).

## R3 — Type d'un message

- **Decision** : `typeOf(kind)` pure dans `src/shared/exchanges.ts`. `action` : `question`, `message` envoyé
  avec ce type, `instruction`, `report`, `error`, `loop`, `report-missing`, `integration`, `publish`, `mockup`,
  `verdict`, `exchange-escalated`, `exchange-decided`. `info` : `turn-finished`, `closed`, `awaiting-answer`,
  `overlap`.
- **Choix** : une copie à l'orchestrateur d'un message entre agents ne le réveille pas. Il la lit à son prochain
  `get_events`. Sinon chaque échange entre deux agents réveillerait trois sessions et coûterait des tours.
- **Vérification** : `overlap` n'existe pas dans le code de `src/` ; 006 ne le cite que comme élément À faire
  prévu. Le type le range en `info` pour le jour où l'événement sera émis, sans rien ajouter d'autre.

## R4 — Voies du réveil

- **Decision** : `WakeService` regroupe 5 s à partir du premier événement non annoncé, sans prolonger la fenêtre
  (SC-002), puis choisit selon l'état de l'agent :

| État | Voie |
|---|---|
| `awaiting-prompt`, `done`, invite vide | Une ligne tapée (`sendPrompt`, origine `wake`) |
| Idem, invite non vide | Attente, signal après 2 min (R5) |
| `working`, `starting`, adapter `midTurnWake` | Prochaine réponse de hook PostToolUse ou Stop |
| `working`, `starting`, sinon | Tapé à la fin du tour |
| `awaiting-answer`, `error`, `closed` | Rien ; repris au prochain changement d'état |

- **Stop** vide la fenêtre de regroupement : sinon l'agent finirait son tour pour être aussitôt relancé.
- **Non-boucle** : chaque message n'est annoncé qu'une fois (`announced`, en mémoire) ; le Stop suivant sans
  nouvel événement répond `{}`. `stop_hook_active` n'a pas à être lu. Après un redémarrage, `announced` est vide,
  donc les non-lus repartent par un pointeur (FR-004).
- **FR-018** : dans le handler de `AgentManager.start`, le réveil se décide **avant** `apply`. Un Stop prolongé
  n'applique pas `turn-finished` ; aucun `report-missing` ne peut donc partir.
- **Sous-agents** : tout événement avec `agent_id` ne reçoit aucun pointeur (US2 sc.4).
- **Par CLI** : Claude Code `midTurnWake` vrai. Codex faux : il n'a pas de PostToolUse (`HOOK_EVENTS`), et Stop n'a
  pas été validé pour prolonger un tour. Generic faux, sans hook.
- **Hook ajouté** : `PostToolUse` manque aujourd'hui dans `ClaudeCodeAdapter.settings` (`Stop` y est déjà).
  `mapEvent` rend `null` pour ce hook : l'état de l'agent ne bouge pas.

## R5 — Invite vide ou non

- **Decision** : suivi des frappes de `typed(id, data)`, qui ne regarde aujourd'hui que `\r`. Le compteur `draft`
  monte aux caractères imprimables et descend à l'effacement. Un collage ou une séquence de déplacement met
  `draft` à « inconnu », donc non vide, jusqu'à `\r`. `prompt-submitted` et un redémarrage le remettent à zéro.
  Les frappes pendant `awaiting-answer` sont ignorées : elles répondent à une question, pas à l'invite.
- **Rationale** : PACT n'a pas de lecture fiable de l'écran. En cas de doute, il considère l'invite occupée et
  ne tape rien (SC-003). Le prix d'une erreur est un réveil retardé et signalé, jamais une saisie écrasée.
- **Portée** : la garde vit dans `flushPrompt`, donc elle couvre toutes les origines, commentaires de revue compris.
- **Signal à 2 min** : `Agent.wakeNotice = 'input'` donne l'élément À faire « ◆ Réveil en attente ». Le message dit
  de vider l'invite ou d'envoyer la saisie.
- **Alternative** : lire l'écran du terminal (`terminal-text`), rejetée car propre à chaque CLI et fragile.

## R6 — Pointeur tapé mais non soumis

- **Decision** : `flushPrompt` et `submitEnter` restent ; l'échec compte dans `undeliveredPrompts`, et `draft` passe à
  « pointeur en attente ». Le réveil suivant ne tape pas de nouveau texte : il renvoie seulement Entrée. Le compte du
  pointeur peut être en retard, sans conséquence : `get_events` rend tout ce qui reste.
- **Rationale** : tient « le remplace, sans doubler » sans `Ctrl-U`, qui viderait une éventuelle saisie.

## R7 — Plafond et consommation

- **Decision** : fenêtre glissante de 20 réveils par heure et par agent, en mémoire (un redémarrage la vide : le
  plafond protège d'une boucle, pas d'un quota précis). Coupure si `usageAlert(...).level === 'critical'` pour un compte
  du CLI de l'agent, via `UsageService` (005). Une minuterie de 30 s, active seulement s'il reste des réveils retenus,
  les reprend.
- **Avertissement** : un seul par blocage, `Agent.wakeNotice = 'cap'`, effacé à la reprise.
- **FR-017** : `deliver({ urgent: true })` ignore plafond et coupure. Le premier appelant réel est 009 ; un test le couvre ici.

## R8 — Route des questions

- **Decision** : pas de nouvel outil pour transmettre à l'utilisateur : l'orchestrateur pose la question dans son propre
  terminal (`AskUserQuestion`), et « ◆ Répondre » apparaît déjà sur sa ligne. Sa réponse à l'agent passe par `send_message`.
- **Constat qui bloquerait sans correction** : `LoopService.report` fait `if (!found) return null` sans notifier
  (`loop-service.ts:207`), et sa notification ne porte que `report.summary` (l.226). Retirer « ◆ Décider » seul perdrait
  donc toute question d'un agent hors boucle, et toute question d'un agent en boucle. `report()` notifie désormais dans
  les deux cas, avec le kind `question` si `questions` n'est pas vide.
- **Lecture complète** : `list_agents` ajoute `questions`, lu de `agent.lastReport` (le texte du journal est borné à 2000).
- **Autorisations** : `permissions`, `alwaysAllowRules` et `agent:answer` ne changent pas. Aucun outil d'orchestrateur n'y
  touche (FR-008, US3 sc.7), et un test le vérifie sur la liste de ses outils.

## R9 — « Workspace avec orchestrateur »

- **Decision** : un agent de rôle `orchestrator` dans `workspace.agents` et `state !== 'error'`, calculé dans `deriveTodos`
  (`lead`, remonté avant `agentTodo`). Un agent fermé quitte déjà `workspace.agents`. L'orchestrateur lui-même garde son
  propre « ◆ Décider ».
- **Rationale** : un orchestrateur planté ne lit rien ; sans la condition sur `error`, la question disparaîtrait de l'écran de
  l'utilisateur. Une clause, et aucun état nouveau.
- **Alternative** : présence seule, plus simple mais avec une perte silencieuse.

## R10 — Qui écrit à qui

- **Decision** : `canSend(from, to, lead)` pure, un seul endroit pour la matrice de `contracts/mcp-tools.md`.
- **Plafond de 5 par tour** : `ask_orchestrator` et `send_message`, orchestrateur compris. `send_prompt` n'y entre pas : une
  consigne n'est pas une conversation. Le compteur repart à tout passage vers ou depuis `working` ; Codex sans hooks fiables
  n'a que la fin de tour, d'où les deux sens.
- **Allers-retours** : compteur par paire triée, +1 quand le sens repart dans l'autre direction après un aller. Il repart à
  zéro si le `HEAD` d'un des deux worktrees a changé depuis le dernier message (`git-service.ts:341`, résolution d'un commit).
- **Choix** : l'orchestrateur compte dans une paire. FR-006 dit « les deux mêmes agents » sans l'exclure, et il peut boucler
  autant qu'un autre. « Laisser reprendre » remet le compteur à zéro. « Couper » garde la paire refusée tant que les deux agents
  existent, et les prévient.
- **Persistance** : `escalations` dans le workspace, compteurs en mémoire.

## R11 — Consignes par pointeur

- **Decision** : `send_prompt` et `prompt` de `launch_agent` enregistrent un message `instruction` et réveillent ; rien du texte
  n'est tapé (FR-015, FR-024). Une consigne garde sa limite de 8000 caractères (`MAX_PROMPT`, contrat existant). Le texte complet se
  lit par `get_events({ id })` ; la liste reste à 200 caractères par entrée (FR-009).
- **Choix** : les commentaires de revue (origine `review`) gardent le collage. Ils viennent de l'utilisateur, pas de l'orchestrateur
  (FR-015), et sortent de ce périmètre.
- **`initialPrompt`** : `applySignal` le prendrait du pointeur, et `DecisionColumn.tsx:276` l'afficherait. Un pointeur est ignoré là
  (`isPointer`), et la première `instruction` remplit `initialPrompt`.
- **CLI sans MCP** : agent sans rôle, ou CLI `generic`. Le pointeur nomme `.pact/events.md`, exclu par `git.exclude` comme `ROLE.md`.
  Le fichier reçoit les non-lus en texte complet, en bloc de données rapportées, et ils comptent comme lus à l'écriture du pointeur.

## R12 — FR-023 : base du contrôle du testeur

- **Decision** : à chaque verdict, `outside` est l'intersection des fichiers hors tests changés depuis `mergeBase(HEAD, X)`, pour X dans
  `main`, `origin/main` s'il existe, et `agent.baseBranch` s'il est différent. `testerStart` et `markTesterStart` disparaissent.
  `git.mergeBase` et `changedFiles` existent déjà.
- **Rationale** : un recalage sur `origin/main` rend `main` local en retard, et inversement ; une seule base compterait les fichiers de
  l'autre. `baseBranch` couvre un testeur lancé exprès depuis une autre branche, accepté aujourd'hui, pour éviter une régression. Un merge de la
  branche du dev reste rejeté, puisque ses fichiers sont hors tests pour toutes les bases.
- **Sortie** : le motif de rejet dit de retirer ces fichiers de la branche.

## R13 — FR-022 : déjà fait à 90 %

- **Constat** : `launchNow` (`agent-manager.ts:631-649`) fait déjà `within(fetchOrigin, 5 s)` et part de `origin/<main>`, lanceur compris. `fetchOrigin` ne vise
  que la branche principale, sans référence de PR.
- **Reste** : `launch` rend les agents sans le résultat du `fetch`. `launchWarnings` lit un résultat `false` ou `undefined` (`within`) et le note dans une
  carte par agent, lue une fois par `launch_agent`.

## R14 — FR-021 et FR-007

- **Decision** : `LoopServiceDeps` gagne `message(workspaceId, draft)`. `start` envoie une `instruction` au testeur. Le premier rapport du testeur de la boucle
  (aucun rapport `test` avant lui) envoie une `instruction` au dev. Un verdict `defects` accepté envoie `verdict` au dev, avec les défauts bornés. Le texte
  ne nomme que l'id de l'issue.
- **Réponse de `start_loop`** : `start` rend aussi `sent`, que l'outil met en mots.

## R15 — FR-027 et autorisation des outils

- **Constat** : `permissions()` (`claude-code.ts:260`) n'autorise les outils `mcp__plugin_pact_pact__*` que pour l'orchestrateur. En mode manuel, `get_events` d'un agent
  de rôle demanderait donc une autorisation à chaque réveil. La règle `allow` passe à tout agent qui a l'accès MCP.
- **`SENSITIVE_RULES`** gagne, en lecture seule : `gh pr view|diff|list|checkout`, `gh issue view|list`, `gh run view`, `gh api`, `git fetch origin refs/pull/*`.
  `gh pr create` reste libre, il sert aux agents.
  Tour 2 : chaque verbe de lecture existe en deux formes, nue et avec `*` (la règle `Bash(gh pr view *)` ne couvre pas `gh pr view` seul), et la liste gagne `gh pr status`,
  `gh issue status`, `gh run list` et `gh search`. Le motif `git fetch` couvre aussi les refspecs préfixés par `+` (`+refs/pull/*`).
- **Limite des enveloppes** : les règles Claude Code comparent la commande telle qu'écrite. `command gh pr view 12`, `env gh pr view 12`, `gh  pr view` (espaces doubles) ou un
  alias de shell passent à côté. Aucune règle ne règle cela sans bloquer des commandes légitimes ; c'est une limite assumée, pas un défaut à corriger par d'autres règles. La
  garantie reste partielle : elle vaut pour la forme usuelle des commandes, pas contre un agent qui contourne.
- **Choix pour « dire à l'utilisateur »** : une phrase dans `PermissionsDialog` et le lanceur. Les règles n'existent qu'au niveau `ask-sensitive` de Claude Code ; Codex et les autres
  gardent une garantie partielle.

## R16 — Faux CLI

- **Decision** : `fake-cli.mjs` reconnaît un pointeur : avec accès MCP, il appelle `get_events`, puis `get_events({ id })`, et joue le texte comme une consigne ; sans MCP, il lit
  `.pact/events.md`. Les scénarios existants gardent donc `{{prompt}}`, et les e2e de 003/004 ne changent pas de sens. Nouveaux champs : `agentMcp` (outils d'un agent de rôle),
  `toolHook` (poste un PostToolUse et affiche `additionalContext`), réponse `block` à son signal de fin (`Prolongé : <reason>`, puis un tour de plus).
- `FakeAdapter` gagne `wakeReply` ; `FAKE_CLI_NO_WAKE_HOOK=1` lui rend `midTurnWake` faux.

## R17 — FR-026 : contenu de tiers

- **Decision** : `record` n'accepte que des `kind` de la liste fermée, et aucune source de 007 ne lit la forge. `issues.ts:241` propage la première ligne de `stderr` de `gh` dans
  l'événement `publish` : elle passe par un test témoin (faux `gh` qui imprime la chaîne d'injection) et devient un motif générique si elle atteint le journal. Les événements de PR suivie
  arrivent avec 008, qui devra n'y mettre que des données de structure.
