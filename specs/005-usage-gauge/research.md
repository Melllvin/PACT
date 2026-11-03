# Research: Jauge de limite d'usage

Sondes du 2026-11-03 sur Claude Code 2.1.316 et Codex 0.163.0.

## R1 — Source Claude Code : `statusLine` de session

**Decision**: chaque agent Claude Code reçoit, dans les `--settings` de session que PACT passe déjà,
`statusLine: { type: 'command', command: '<pont> --statusline' }`. Claude Code envoie sur l'entrée
standard de la commande un JSON qui contient `rate_limits.five_hour` et `rate_limits.seven_day`
(`used_percentage`, `resets_at` en secondes epoch), ainsi que `session_id`, `model` et les compteurs de
jetons de la session. Le pont poste ce JSON sur `/statusline` du `HookServer` avec le jeton de
l'agent ; PACT répond une ligne courte (« PACT · 5 h 62 % ») que Claude Code affiche en bas du
terminal de l'agent.

**Rationale**: zéro coût de quota (aucune requête au modèle) ; mise à jour à chaque message de
l'assistant, donc bien plus souvent qu'une fois par minute pendant le travail (FR-003) ; aucune
écriture dans `~/.claude` (FR-005) ; identité déjà connue du CLI (FR-002).

**Alternatives considered**:
- Appeler l'API d'usage du fournisseur avec le jeton OAuth du CLI : lit un secret du CLI (FR-005),
  point d'entrée non documenté.
- Lancer `claude /usage` en tâche de fond : ouvre une session, consomme, sortie non structurée.
- Écrire la `statusLine` dans `~/.claude/settings.json` : interdit (FR-005).

**Conséquence** : une `statusLine` personnelle de l'utilisateur est remplacée pour les agents PACT,
puisque les réglages de session priment. Le pont relaie alors la commande de l'utilisateur : s'il
trouve une `statusLine` de type `command` dans les réglages utilisateur et projet (lecture seule), il
l'exécute avec la même entrée et imprime sa sortie au lieu de la ligne PACT.

`rate_limits` est absent avant la première réponse, pour une clé d'API et hors abonnement : pas de
lecture, donc pas de jauge (edge case « clé d'API »).

## R2 — Source Codex : `token_count` du rollout

**Decision**: Codex écrit sa session dans `$CODEX_HOME/sessions/AAAA/MM/JJ/rollout-*-<session>.jsonl`
(défaut `~/.codex`). Ses événements `token_count` portent `rate_limits.primary` et
`rate_limits.secondary` (`used_percent`, `window_minutes` 300 et 10080, `resets_at`). PACT connaît
l'identifiant de session de chaque agent Codex (001) : `CodexRollout` retrouve le fichier par son nom,
le suit en lecture seule (relecture de la fin à chaque changement, au plus toutes les 10 s) et
transmet la dernière lecture.

**Rationale**: même source que `/status` ; aucune requête ; lecture seule.

**Alternatives considered**: `codex /status` en tâche de fond (ouvre une session) ; API du fournisseur
(secret du CLI).

## R3 — Modèle : lecture par compte, une par CLI

**Decision**: une lecture = `{ cliId, account, windows[], readAt }`. Le compte est la clé de
regroupement : `CLAUDE_CONFIG_DIR` (ou défaut) pour Claude Code, `CODEX_HOME` (ou défaut) pour Codex,
seules façons d'avoir deux comptes sur une même machine. La lecture la plus récente d'un compte
remplace la précédente, quel que soit l'agent qui l'a apportée.

**Rationale**: le pourcentage est celui du compte, partagé entre workspaces (US3 scénario 3).

## R4 — Fenêtre affichée, âge, cadence

**Decision**:
- la jauge montre la fenêtre de plus grand pourcentage ; à égalité, la plus courte ;
- âge > 15 min : grisée avec « lu il y a N min » ; > 60 min : retirée (FR-008) ;
- une fenêtre dont `resetsAt` est passée affiche « réinitialisée » et 0 % tant qu'aucune nouvelle
  lecture n'arrive (plutôt que la valeur périmée) ;
- cadence : Claude pousse à chaque message ; Codex est relu sur changement du fichier ; quand aucun
  agent d'un CLI ne travaille, rien n'est lu (FR-003 « au plus toutes les 5 minutes sinon » est
  respecté par construction).

## R5 — Part par agent

**Decision**: mesure = jetons (entrée + sortie, hors cache lu) rapportés par le CLI pour la session
de l'agent : `context_window.total_input_tokens + total_output_tokens` de la `statusLine` Claude ;
`info.total_token_usage` de Codex. `UsageService` garde, par compte et par fenêtre courante, le delta
de chaque agent depuis son premier relevé dans la fenêtre. Part = delta de l'agent / somme des deltas
des agents PACT du compte ; dans le détail d'un workspace, les agents des autres workspaces sont
regroupés en « autres ». Un agent fermé garde sa part, marqué « fermé », jusqu'à la réinitialisation
(FR-014). Tout est remis à zéro au changement de `resetsAt` de la fenêtre.

**Rationale**: les jetons répartissent ; ils ne recalculent pas le pourcentage du compte (hypothèse
de la spec). « autres » au sens de la spec (consommation hors PACT) n'est pas mesurable : on montre la
part PACT, et le texte dit « des agents PACT ».

## R6 — Alertes

**Decision**: niveau = `ok` (< warn), `warn`, `critical` (≥ critical), calculé sur la fenêtre affichée.
À faire reçoit un élément `usage-limit` par compte, clé `usage:<cliId>:<account>`, dont le titre suit
le niveau courant (pas de doublon, SC-005), retiré sous `warn`. Élément d'information, sans action,
avec « Détail » qui ouvre le détail de la jauge.

## R7 — Lanceur et orchestrateur

**Decision**: le lanceur lit l'état d'usage du store ; si un CLI choisi est au niveau `warn` ou
`critical`, il affiche « Limite 5 h à 85 % : ces agents risquent de s'arrêter avant 16:40 » au-dessus
du bouton, sans le désactiver. `launch_agent` (003 US4) ajoute la même phrase dans le texte de sa
réponse (`warning`), sans refuser.

## R8 — Reprise automatique

**Decision**: quand un agent passe en `rate-limit` sans heure, `AgentManager` demande à
`UsageService.resetAt(cliId, account)` l'heure de réinitialisation de la fenêtre au-dessus de 100 %
(sinon la plus haute) et la passe à `nextResume`. Une heure passée retombe sur les intervalles de 001.

## R9 — Faux CLI et tests

**Decision**: deux étapes de scénario :
- `usage { five_hour, seven_day, tokens }` : le faux CLI exécute la commande `statusLine` reçue dans
  `--settings` avec une charge construite, comme le ferait Claude Code ;
- `rollout { primary, secondary, tokens }` : écrit un `token_count` dans un rollout sous un
  `CODEX_HOME` de test.

Les fixtures `tests/fixtures/usage/` sont des charges réelles des deux CLI, sans identifiants.
