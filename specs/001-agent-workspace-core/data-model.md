# Data Model — 001 Socle

Types partagés dans `src/shared/model.ts`, validés par des schémas zod. Persistance : voir
research.md R9.

## Workspace

| Champ | Type | Règles |
|-------|------|--------|
| id | string | hash stable du chemin réel (`realpath`) du dépôt |
| path | string | chemin absolu, dépôt Git valide (FR-003) |
| name | string | nom du dossier |
| mainBranch | string | branche courante du dépôt principal à l'ouverture |
| agents | Agent[] | ordonnés par `position`, 0 à 6 (FR-017) |
| freeTerminals | FreeTerminal[] | 0 à n |
| quickLaunchCounters | Record<cliId, number> & { freeTerminal: number } | mémorisés (FR-010) |
| permissionOverride | PermissionPreference \| null | portée « Ce projet » (FR-012) |
| lastOpenedAt | ISO date | |
| status | `available` \| `unavailable` | `unavailable` si le dossier disparaît |

Unicité : un seul Workspace ouvert par `id` (FR-004).

## RecentProject

| Champ | Type | Règles |
|-------|------|--------|
| path, name | string | |
| branch | string | dernière branche connue |
| keptWorktrees | number | worktrees conservés sous `.worktrees/` |
| lastOpenedAt | ISO date | tri décroissant, 20 entrées max |

## CliDefinition

| Champ | Type | Règles |
|-------|------|--------|
| id | string | `claude-code`, `codex`, ou `custom-<slug>` |
| name | string | |
| adapter | `claude-code` \| `codex` \| `generic` | voir contracts/cli-adapter.md |
| command | string | commande saisie ou détectée |
| resolvedPath | string \| null | chemin complet ; `null` = introuvable |
| version | string \| null | |
| origin | `detected` \| `custom` | |
| status | `installed` \| `missing` \| `unsupported-version` | |
| models | string[] | proposés par l'adaptateur si connus |

## Agent

| Champ | Type | Règles |
|-------|------|--------|
| id | uuid | |
| workspaceId | string | |
| position | 1..6 | unique dans le workspace ; fixe l'ordre des tuiles |
| color | `purple` \| `cyan` \| `green` \| `magenta` \| `yellow` \| `slate` | attribuée à la création dans cet ordre, jamais réattribuée (FR-016) |
| cliId | string | CliDefinition existante |
| model | string \| null | null = défaut du CLI |
| permissionLevel | `always-allow` \| `ask-sensitive` \| `always-ask` | |
| baseBranch | string | défaut : `mainBranch` |
| branch | string | provisoire `agent/<cli>-<n>`, mis à jour si renommée |
| worktreePath | string | `<repo>/.worktrees/<cli>-<n>` |
| port | number | 3000 + position ou suivant libre (FR-015) ; unique |
| startCommand | string \| null | commande de l'aperçu (utilisée par les specs suivantes) |
| sessionId | string \| null | identifiant de session CLI (R6) |
| initialPrompt | string \| null | première consigne, pour « Relancer » |
| alwaysAllowRules | string[] | « Toujours pour ce worktree » (FR-034) |
| state | AgentState | voir ci-dessous |
| lastError | { code: number \| null; kind: `crash` \| `rate-limit`; message: string } \| null | |
| scheduledResume | ScheduledResume \| null | |

Validation au lancement (FR-011 scénario 5) : branches et ports uniques parmi les agents du
workspace ; nombre total ≤ 6.

### AgentState — transitions

```text
starting ──(SessionStart / invite affichée)──▶ awaiting-prompt
awaiting-prompt ──(UserPromptSubmit)──▶ working
working ──(Notification permission_prompt)──▶ awaiting-answer
awaiting-answer ──(Autoriser / Refuser / réponse clavier)──▶ working
working ──(Stop)──▶ done            (tour terminé, prêt pour une consigne)
done ──(UserPromptSubmit)──▶ working
* ──(processus terminé, code ≠ 0 ou StopFailure)──▶ error
working ──(StopFailure rate_limit, processus vivant)──▶ error (kind rate-limit)
error ──(Reprendre / reprise auto)──▶ starting (même session) ou working (processus vivant : « continue » tapé dans l'invite)
error ──(Relancer)──▶ starting (nouvelle session, consigne retapée)
* ──(fermeture)──▶ closed
```

Un processus terminé sans que PACT l'ait demandé passe en `error` (kind `crash`, « à reprendre »)
même avec le code 0 : une sortie d'un CLI interactif (`/exit`, Ctrl+D) laisse un agent sans
terminal qu'il faut reprendre ou relancer. Seule une fermeture demandée par PACT mène à `closed`.

Chaque transition émet `agent:state` et déclenche un pulse (FR-023) ; `error` active le halo.

## FreeTerminal

| Champ | Type | Règles |
|-------|------|--------|
| id | uuid | |
| workspaceId | string | |
| cwd | string | racine du dépôt principal (FR-025) |
| shell | string | `$SHELL` (macOS), `pwsh`/`powershell.exe` (Windows) |

## TodoItem (dérivé, non persisté)

| Champ | Type | Règles |
|-------|------|--------|
| id | string | `<agentId>:<kind>` |
| agentId | string | |
| kind | `answer` \| `prompt` \| `info` \| `rate-limit` | tri : answer, rate-limit, prompt, info (FR-027) |
| title | string | court, avec icône (FR-041) |
| actions | TileAction[] | mêmes que la tuile (FR-028) |

Calculé à partir de l'état des agents : une seule source, donc une réponse d'un côté disparaît de
l'autre par construction.

## PermissionPreference

| Champ | Type | Règles |
|-------|------|--------|
| level | `always-allow` \| `ask-sensitive` \| `always-ask` | défaut proposé : `always-allow` |
| autoResume | boolean | reprise auto après limite de débit, défaut `true` (FR-035) |
| scope | `project` \| `global` | `global` stocké dans state.json, `project` dans le workspace |

Résolution : préférence du projet, sinon globale, sinon affichage de l'écran 1m.

## ScheduledResume

| Champ | Type | Règles |
|-------|------|--------|
| agentId | string | |
| at | ISO date | heure de levée connue ou prochaine tentative |
| attempt | number | backoff 1, 2, 4, 8, 15, 15… min |

Créée sans question si `autoResume` est vrai. Annulée par toute action manuelle sur l'agent, ou
quand le CLI signale qu'il a repris seul (FR-036).
