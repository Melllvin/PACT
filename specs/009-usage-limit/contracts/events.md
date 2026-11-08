# Contrat : journal, consigne, hooks, outils

## Messages du journal (007)

Tous sont écrits par `pact`, dans le journal du workspace de l'agent destinataire. Les gabarits ci-dessous sont exacts. `<fenêtre>` est le `label` de la fenêtre (« 5 h », « semaine », « semaine · Opus »). `<N>` est le pourcentage arrondi. `<HH:MM>` est l'heure locale (`clockTime`).

### `usage-save` (action)

```text
Limite <fenêtre> à <N> % (arrêt à <S> %). Committe maintenant ton travail en cours, en local : git add puis git commit. Ne pousse rien : le push reste à la livraison. PACT arrêtera les agents de ce compte au seuil et les reprendra après la réinitialisation.
```

Saut de bande ou accord par prudence : la deuxième phrase devient « Committe maintenant ton travail en cours, en local, dans la minute : … ».

### `usage-paused` (info)

```text
PACT t'a mis en pause : limite <fenêtre> à <N> %. Reprise prévue à <HH:MM>.
```

- Plusieurs fenêtres : « limites 5 h à 91 % et semaine à 90 % ».
- Heure inconnue : « Reprise après la réinitialisation, heure inconnue. »
- Reprise auto coupée : « Reprise à la main par l'utilisateur. »
- Par prudence : « PACT t'a mis en pause par prudence : dernière lecture de la limite <fenêtre> à <N> %, il y a <M> min. »

### `usage-resumed`

- Agent `midTurn` (action) : `Reprise après la limite <fenêtre> (<N> %), en pause de <HH:MM> à <HH:MM>. Reprends ton travail là où tu t'es arrêté.`
- Agent inactif (info) : la première phrase seule.
- Orchestrateur (action) : `Reprise après la limite <fenêtre> (<N> %), en pause de <HH:MM> à <HH:MM>. Agents repris : <liste>. La pause n'a compté aucun tour ni rapport manquant.`
- Suffixes possibles : ` Non sauvegardé à l'arrêt : <liste>.` et ` Verrou Git trouvé dans <worktree> : vérifie-le avant de committer, PACT ne l'a pas effacé.`

Les textes ne contiennent aucun contenu d'agent ni de tiers : seulement des labels de fenêtre, des nombres, des heures et des noms d'agents (« Claude 2 · dev »).

## Réveil (`WakeService`, 007)

| Règle | Avant 009 | Avec 009 |
|---|---|---|
| Coupure de consommation | `usageCritical(cliId)` : niveau `critical` de 005 | `usageHeld(cliId)` : compte en pause, ou fenêtre en `stop` sans dérogation |
| Pointeur avec un `usage-save` en attente, invite vide | plafond et coupure appliqués sauf `urgent` | toujours urgent : plafond et coupure ignorés |
| Même cas, en plein tour (`takeForHook`, `tool` ou `stop`) | plafond et coupure appliqués | plafond et coupure ignorés ; la fenêtre de 5 s s'applique encore à `tool` |
| Invite occupée, `awaiting-answer` | retenu | inchangé : retenu, jamais écrit |

Les réponses de hook restent celles de `specs/007-agent-exchanges/contracts/hooks.md`. Le pointeur reste `pointerText(n)`.

## `launch_agent` (outil de l'orchestrateur)

Pendant une pause d'un compte du CLI demandé, sans dérogation de compte :

```json
{ "isError": true, "content": [{ "type": "text", "text": "Refusé : PACT est en pause sur la limite <fenêtre> de <CLI> jusqu'à <HH:MM>. Aucun agent de ce CLI ne peut être lancé avant la reprise." }] }
```

Heure inconnue : « jusqu'à sa réinitialisation ». Les autres CLI se lancent normalement.

## Lanceur de l'utilisateur

`launchWarning` garde son texte de 005, et la pause passe avant lui :

```text
PACT est en pause sur la limite <fenêtre> jusqu'à <HH:MM> : ces agents ne seront pas arrêtés avant la réinitialisation.
```

Le lancement n'est jamais bloqué. Un agent lancé ainsi reçoit une dérogation propre, jusqu'au reset (point ouvert O1).

## Faux CLI (`tests/fixtures/fake-cli/fake-cli.mjs`)

| Champ de scénario | Effet |
|---|---|
| `usage` (existant) | lectures par palier, avec `resets_at` |
| `onPointer: 'commit'` | à un pointeur : `get_events` ; si un `usage-save` est lu, `git add -A && git commit -m "pact: sauvegarde"`, puis imprime `Sauvegardé` ; jamais de push |
| `onPointer: 'ignore'` | lit le pointeur et ne fait rien (agent muet, US1 sc.6) |
