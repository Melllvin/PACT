# Contrat : interface et IPC

Libellés selon `docs/maquettes/CONSIGNES-UI.md`.

## Barre de livraison (P4)

Barre fine en bas de la vue du workspace. À droite : interrupteur `Auto` (`role="switch"`, `aria-checked`), libellé
« Auto : fusionne quand la CI est verte » au survol, et bouton « Réglages de livraison ». Sans remote : interrupteur
désactivé, info-bulle « Sans remote, la fusion reste confirmée par toi ».

## Réglages de livraison (dialogue)

| Champ | Contrôle | Bornes |
|---|---|---|
| Mode de fusion | radio : Squash (défaut), Merge commit, Rebase | |
| Plafond d'allers-retours | nombre | 1–10, défaut 3 |
| Passes de peaufinage | nombre | 0–5, défaut 0 |
| Consigne de peaufinage | zone de texte | ≤ 2000 caractères |

Enregistrement explicite (« Enregistrer »), valeurs hors bornes refusées avec le message du champ.

## Actions d'agent (`TileActions`, ligne de la colonne Agents)

| Dépôt | Agent | Actions |
|---|---|---|
| Avec remote | boucle `accepted` | « Livrer » |
| Avec remote | sans boucle | « Livrer » (désactivé, « demande une boucle acceptée »), « Créer la PR sans verdict » |
| Sans remote | boucle `accepted` | « Intégrer » |
| Sans remote | sans boucle | « Intégrer » (désactivé), « Fusionner sans verdict » (confirmé) |

« Livrer » et « Créer la PR sans verdict » ouvrent un dialogue court : titre (pré-rempli par le titre de l'issue, ou le
nom de la branche) et message, puis `delivery:request`. Aucun autre geste jusqu'à la PR.

« Intégrer » vers la vue de revue reste pour un dépôt sans remote ; avec remote, il est remplacé par « Livrer ».

## Éléments À faire

Voir data-model `TodoKind`. Règles :

- `delivery-review` montre le lien de la PR, le commit court, le verdict (ou « sans verdict »), Valider et Refuser.
  Valider se désactive au clic et le reste jusqu'à la réponse. Refuser ouvre un champ de motif ; vide → bouton inactif.
- `worktree-kept` : « Supprimer quand même » ouvre une confirmation qui liste ce qui serait perdu, puis supprime.
- Fermer soi-même un agent en livraison : `CloseAgentDialog` ajoute « Une livraison est en cours (PR #n) : elle sera
  abandonnée, la PR restera ouverte. »

## IPC

| Canal | Sens | Charge |
|---|---|---|
| `delivery:request` | renderer → main | `{ agentId, title, message, unverified?: boolean }` |
| `delivery:decide` | renderer → main | `{ deliveryId, decision: 'validate' \| 'refuse' \| 'wait' \| 'review', head, reason? }` |
| `delivery:settings` | renderer → main | `{ workspaceId, settings: Partial<DeliverySettings> }` |
| `delivery:cleanup` | renderer → main | `{ deliveryId, agentId, decision: 'force' \| 'keep' }` → `{ lost: string[] }` avant suppression |
| `workspace:deliveries` | main → renderer | `{ workspaceId, deliveries, settings }` |

`workspace:integrationRequests` et `integrationRequest:*` sont retirés.
