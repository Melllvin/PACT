# Contrat : outils MCP et messages

Le refus reprend `Refusal` : l'appel échoue avec sa raison, rien n'est fait. Tous rendent la main aussitôt.

## Nouveaux outils (orchestrateur)

### `get_workflow`

```text
entrée : { issue?: string }
sortie : {
  source: 'file' | 'default', oid, name,
  stages: [{ id, type, agents: [{ key, role, cli?, model? }], instruction?, passes?, mergeMode? }],
  transitions: [{ from, to, on, maxRounds? }], start, ends,
  invalid?: string,                  // erreur de la version courante, la dernière valide est rendue
  ignoredLocal?: string[],           // réglages locaux de 008 ignorés (US3 sc.6)
  run?: { stage, status, next: [{ to, on }], rounds: { [stageId]: { n, max } }, bindings, reason? }
}
```

Sans `issue` : la version courante. Avec `issue` : la version figée de son exécution, et `run`.

### `advance_stage`

```text
entrée : { issue: string, to: string }
sortie : { stage: to, sent: [{ agentId, kind: 'instruction' }] }
```

Permis seulement le long d'une transition `on: [done]` (ou `[ready]`) depuis une étape `spec`, `design` ou `recap`
**sans agent lié** : l'orchestrateur a fait l'étape lui-même. Refus :

| Cas | Raison |
|---|---|
| Pas de transition de l'étape en cours vers `to` | `Étape en cours : <x>. Étapes possibles : <y> (sur <résultats>), …` |
| Résultat porté par PACT (`accepted`, `defects`, `merged`, CI…) | `<x> → <to> se fait sur <résultat>, constaté par PACT` |
| Étape avec un agent lié | `L'agent <nom> tient l'étape <x> : attends son rapport` |
| Exécution `finished`, `refused`, `waiting-user` | `Exécution <état> : <raison>` |

## Outils modifiés

| Outil | Changement |
|---|---|
| `start_loop` | Refus si l'étape en cours n'est pas `test` ni une étape qui mène à `test` sur `ready` (message de `advance_stage`). Lie les clés `test` et `dev`. Le plafond cité vient du workflow de l'exécution. |
| `polish_pass` | Refus hors étape `polish`. Consigne = consigne de l'étape + `notes` (research R9). |
| `request_delivery` | Refus hors étape `pr` : « Étape en cours : polish. Étapes possibles : pr (sur done). » (US4 sc.1). `mergeMode` de l'étape. |
| `launch_agent` | Paramètre `issue` optionnel : lie la clé du rôle dans l'étape en cours, prend `cli` et `model` de la clé, plafond du profil toujours appliqué (FR-017). Sans `issue` : inchangé. |
| `next_round` | Plafond lu dans le workflow de l'exécution. |
| `register_issue` | Crée l'exécution (research R8). La réponse ajoute `stage` et, si refusée, la raison. |
| `list_agents` | Ajoute `stage: { issue, id }` par agent lié. |

## Message de PACT : kind `stage` (type `action`)

Écrit par `ExchangeService.record` avec `from: 'pact'`, `to: <orchestrateur>`, champ structuré `stage: { issue, from,
to, outcome }`. Résumé construit par PACT, sans texte d'agent :

```text
Étape <to> · <issue> (après <from> : <outcome>) · lance <rôles> ou attends <agent>
Workflow terminé · <issue>
Étape <x> · <issue> : plafond de <n> tours atteint, l'utilisateur décide
```

La consigne de l'étape part aux agents liés comme `instruction` (007), jamais tapée.

## Faux CLI

Le scénario `workflow-*` du faux orchestrateur (`tests/fixtures/fake-cli/scenarios/`) appelle `get_workflow` au réveil
et joue l'étape rendue (`launch_agent` / `start_loop` / `polish_pass` / `request_delivery`), et imprime
`MCP get_workflow : <stage>` pour les assertions e2e.
