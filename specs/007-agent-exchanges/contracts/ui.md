# Contrat : interface

Pas de maquette dédiée. Mêmes composants et libellés que les éléments existants (`docs/maquettes/CONSIGNES-UI.md`).

## Colonne Agents

| Élément | Où | Contenu |
|---|---|---|
| `✕ Échanges en boucle · <A> ↔ <B> · 3 allers-retours` | Tête, comme `loop-escalated` | Dernier message en texte brut ; boutons « Laisser reprendre », « Couper » |
| `◆ Réveil en attente · <agent> · saisie en cours` | Ligne de l'agent | « Videz l'invite ou envoyez votre saisie. » ; action `Répondre dans le terminal ↗` |
| `◆ Réveil en attente · <agent> · plafond atteint` | Ligne de l'agent | « 20 réveils cette heure : les événements restent lisibles. » |
| `◆ Décider` | Inchangé | Absent si un orchestrateur disponible reçoit la question (`data-model.md`) |
| `◆ Répondre` | Inchangé | Toujours présent pour un agent qui attend dans son terminal |

Le texte d'un message est du contenu d'agent : rendu en texte React, jamais en HTML.

## Onglet « ◎ Actions » (Focus de l'orchestrateur)

Le journal fusionne par heure, le plus récent d'abord, les actions existantes et `workspace.exchanges.messages`. Une entrée de message montre l'heure, l'expéditeur → le destinataire, le type (`action`, `info`), le sous-type et le texte. Les `info` d'état (`turn-finished`, `closed`) restent affichés avec un style atténué.

## Lanceur

`PermissionsDialog` ajoute une phrase : la lecture du contenu de tiers ne passe par votre décision qu'au niveau « Demander pour les actions sensibles » de Claude Code ; ailleurs, seule la consigne des skills l'interdit.

## IPC

| Canal | Sens | Charge |
|---|---|---|
| `exchange:decide` | requête | `{ workspaceId, escalationId, decision: 'resume' \| 'cut' }` |
| `workspace:exchanges` | événement | `{ workspaceId, exchanges }` |
| `agent:wakeNotice` | événement | `{ agentId, notice: 'input' \| 'cap' \| null }` |

Accessibilité : les boutons reprennent les styles de `loop-escalated`, atteignables au clavier ; l'audit axe de 006 couvre la colonne.
