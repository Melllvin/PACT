# Contrat : interface

Pas de maquette dédiée. Mêmes composants et libellés que les éléments existants (`docs/maquettes/CONSIGNES-UI.md`).

## Tuile et ligne d'agent

| Cas | Label d'état (`agentStateLabel`) | Badge |
|---|---|---|
| `paused`, reprise prévue | `en pause · reprise à HH:MM` | — |
| `paused`, reprise auto coupée ou annulée | `en pause · <fenêtre>` | — |
| `paused`, heure inconnue | `en pause · reprise après réinitialisation` | — |
| `paused`, `blocked: 'session'` | `en pause · session inconnue` | — |
| `pause.saved === false` | (en plus) | `non sauvegardé` |

La couleur est celle de l'état « attend une consigne », jamais celle de `error`. Actions de la tuile en pause : `resume` (« Reprendre » cet agent, avec dérogation pour lui seul), `cancel-resume` si `scheduledResume`, `restart` (« Relancer »). La fermeture reste celle de 006.

## À faire

| Kind | Titre | Corps | Actions |
|---|---|---|---|
| `usage-paused` | `◆ En pause · <CLI> · limite <fenêtre> à <N> % · reprise <HH:MM>` | agents en pause de ce workspace ; « Question fermée : <résumé> » ; « Non sauvegardé : <liste> » ; verrou Git | `Reprendre`, `Annuler la reprise` |
| `usage-stale` | `◆ Limite <CLI> inconnue depuis <M> min · dernière lecture <fenêtre> à <N> %` | « PACT ne sait plus où en est la limite. Arrêter par prudence ? » | `Arrêter par prudence`, `Pas maintenant` |

Un seul élément `usage-paused` par compte et par workspace. `usage-limit` (005) n'est pas affiché pour un compte en pause.

## Réglages (`UsageThresholds.tsx`)

Une section « Arrêt » sous les seuils d'alerte.

- Une ligne par CLI, puis un champ numérique par fenêtre (`windowsOf`), de 10 à 100, par défaut 90. Libellé : « <fenêtre> : arrêt à [ 90 ] % ».
- Note fixe : « Sauvegarde demandée 3 points avant. »
- Valeur 100 : « À 100 %, PACT n'arrête plus avant une erreur de limite. »
- Valeur sous le seuil critique de 005 (95 % par défaut, donc dès 90) : « PACT arrête avant le niveau critique (95 %) : la jauge ne passera plus au rouge pour ses agents. » (point ouvert O3)
- Hors bornes : le bouton « Enregistrer » est désactivé, avec « Entre 10 et 100 % ».

## IPC

| Canal | Sens | Charge | Réponse |
|---|---|---|---|
| `settings:usageStops` | requête | `UsageStops` | `UsageStops` enregistré |
| `usage:stops` | requête | — | `UsageStops` courant |
| `usage:resume` | requête | `{ cliId, account }` | `void` ; reprend le compte et écrit la dérogation de compte |
| `usage:cancelResume` | requête | `{ cliId, account }` | `void` |
| `usage:stale` | requête | `{ cliId, account, decision: 'stop' \| 'later' }` | `void` |
| `usage:limit` | événement | `{ now, stops, declined }` | l'horloge du main et ce dont dépendent les propositions d'arrêt par prudence (`deriveTodos`, `useUsageClock`) |

`agent:state` porte déjà l'agent entier : `state: 'paused'` et `pause` y passent sans canal nouveau. Les éléments À faire suivent le flux existant de `deriveTodos`.

Accessibilité : les boutons reprennent les styles de `rate-limit` et `usage-limit`, atteignables au clavier. Les champs de seuil ont un `label` associé. L'audit axe de 006 couvre la colonne et les réglages.
