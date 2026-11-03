# Contract: outils MCP ajoutés ou étendus (serveur « pact »)

Même forme que 003 (contracts/mcp-tools.md de 003) : réponse texte lisible puis JSON ; un refus est un
résultat `isError` avec sa raison, jamais une erreur de protocole.

## Orchestrateur

| Outil | Entrée | Sortie | Exigences |
|-------|--------|--------|-----------|
| `launch_agent` (étendu) | `{ cli?, role?, model?, effort?, branch?, baseBranch?, prompt? }` | `{ agent: { id, name, role, model, branch, port } }` | FR-005 : sans `cli`/`model`/`effort`, ceux du profil du rôle ; `model` au-delà de `maxModel` refusé avec « Modèle au-delà du plafond du rôle <rôle> (<maxModel>) » ; CLI absent refusé |
| `list_agents` (étendu) | — | + `role`, `loop: { issueId, round } \| null` par agent | FR-006 |
| `register_issue` | `{ path }` (relatif à `.pact/issues/`) | `{ issue: { id, title, state } }` | FR-022 : `state: 'ready'` si critères Given/When/Then et aucune question ouverte, sinon `proposed` avec la liste de ce qui manque |
| `list_issues` | — | `{ issues: Issue[] }` | FR-024 |
| `publish_issues` | `{ ids: string[] }` | `{ requestId, status: 'waiting-user' }` ; issue par événement `publish` | FR-023 ; refusé sans dépôt distant ou sans `gh` connecté |
| `start_loop` | `{ issue, dev, test }` | `{ loop: { issueId, round: 1 } }` | FR-017, FR-022 : issue `ready`, agents de rôles `dev` et `test` |
| `next_round` | `{ issue }` | `{ loop: { issueId, round } }` | FR-018 : refusé après le 3ᵉ verdict `defects` (« Plafond de 3 tours atteint : l'utilisateur décide ») ; FR-007 : modèle escaladé au tour 3 |
| `get_loop` | `{ issue }` | `{ loop: Loop }` | rapports et preuves, pour le recap |
| `wait_for_agents` (étendu) | inchangé | événements `report`, `report-missing`, `loop`, `overlap`, `mockup`, `publish` en plus | FR-016, FR-021, FR-028 |

## Agent avec un rôle (jeton d'agent)

| Outil | Entrée | Sortie | Exigences |
|-------|--------|--------|-----------|
| `submit_report` | `HandoffReport` sans `agentId`, `role`, `round` (déduits) | `{ accepted: true }` ou refus avec la liste des champs manquants | FR-015, contracts/handoff-report.md |

Un jeton d'agent appelant un autre outil reçoit `isError` « Outil réservé à l'orchestrateur ».
