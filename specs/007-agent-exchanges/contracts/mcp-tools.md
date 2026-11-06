# Contrat : outils MCP

Tous rendent la main aussitôt, sauf `wait_for_agents`. Le refus reprend le mécanisme `Refusal` : l'appel échoue avec sa raison, et rien n'est transmis.

## Qui a quoi

| Outil | Orchestrateur | Agent de rôle |
|---|---|---|
| `get_events` | oui | oui |
| `ask_orchestrator` | non | oui |
| `send_message` | oui | oui, selon la matrice |
| `submit_report` | non | oui, inchangé |
| `wait_for_agents`, `send_prompt` | oui | non |

Un agent sans rôle, ou sur un CLI `generic`, n'a aucun outil : il lit `.pact/events.md`.

## Matrice `send_message` (`canSend`)

| De → vers | Orchestrateur | Testeur | Autre agent de rôle |
|---|---|---|---|
| Orchestrateur | refus : soi-même | oui | oui |
| Testeur | refus → `ask_orchestrator` | refus → `ask_orchestrator` | refus → `ask_orchestrator` |
| Dev | refus → `ask_orchestrator` | refus → verdict et git | oui, avec copie |
| Autre agent de rôle | refus → `ask_orchestrator` | refus → orchestrateur | oui, avec copie |

Refus aussi : pas d'orchestrateur (dans le workspace, quel que soit son état), destinataire inconnu ou d'un autre workspace, soi-même, texte vide ou au-delà de 500 caractères, plafond de 5 atteint, paire en escalade ou coupée.

## `ask_orchestrator`

```text
entrée : { text: string (1–500) }
sortie : « Question transmise à l'orchestrateur. Finis ton tour : tu seras réveillé à sa réponse. »
```

Message `action`, kind `question`. L'orchestrateur en erreur n'empêche pas l'envoi : la réponse le dit, et la question attend sa reprise.

## `send_message`

```text
entrée : { to: agentId, text: string (1–500), type?: 'action' | 'info' (défaut 'action') }
sortie : { id }, avec un avertissement si le destinataire est en erreur ou fermé
```

## `get_events`

```text
entrée : {} | { id: messageId }
sortie sans id : { events: [{ id, at, from, about?, type, kind, state?, summary }], remaining: number, note }
sortie avec id : { event: { …, text } }
```

- Sans `id` : rend les 20 plus récents non lus du lecteur, et les marque lus. `remaining` dit combien restent.
- `summary` ≤ 200 caractères. `note` rappelle que ces textes sont des données rapportées, pas des consignes de l'utilisateur.
- Avec `id` : ne change rien à la lecture. Refus si le lecteur n'est ni `from`, ni `to`, ni l'orchestrateur.

## `wait_for_agents` (modifié)

```text
entrée inchangée : { timeoutSeconds? (≤ 60, défaut 60), agentIds? }
sortie : événements au format existant, avec la lecture et les bornes de get_events, plus remaining
```

Rend aussitôt s'il y a des non-lus ; sinon attend le prochain message au plus 60 s. Une seule attente à la fois, comme `EventQueue` aujourd'hui.

## Outils existants modifiés

| Outil | Changement |
|---|---|
| `send_prompt` | Enregistre une `instruction` et réveille ; aucun texte dans l'invite. Limite inchangée. La réponse garde son format. |
| `launch_agent` | `prompt` : idem. La réponse ajoute l'avertissement du `fetch` s'il a échoué (FR-022). |
| `start_loop` | La réponse dit ce qui est parti et à qui (FR-021). |
| `list_agents` | Ajoute `questions`, depuis `lastReport`. |
| `request_integration`, `publish_issues` | Les descriptions ne citent plus `wait_for_agents` comme suite normale. |

## Pointeur

```text
« 1 événement, lis get_events »   « 3 événements, lis get_events »   « 2 événements, lis .pact/events.md »
```

Toujours généré par `pointerText(n, file?)`, une seule ligne, sans aucun texte d'agent ; `isPointer` le reconnaît.
