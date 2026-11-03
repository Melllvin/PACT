# Contrat UI : colonne « Agents » et vue « Graphe »

Aucun canal IPC ajouté : les données viennent de `app:getState`, `agent:state`, `agent:branch`,
`workspace:agentsLaunched` (003, PR #39), `workspace:loops`, `workspace:issues`,
`workspace:integrationRequests`, `review:pending`, `usage:state`.

## Barre « Vues »

| Élément | Rôle | Nom accessible |
|---|---|---|
| Vue graphe | `radio` dans `radiogroup "Vue"` | `Graphe` (actif dès qu'un agent existe) |
| Bascule de la colonne | `button` (pressé/non) | `Agents <M>` (M = éléments à traiter) |

## Colonne

| Élément | Rôle | Nom accessible / texte |
|---|---|---|
| Colonne | `complementary` | `Agents` |
| En-tête | `heading` niveau 2 | `Agents <N>` + `<M> à traiter` (si M > 0) |
| Éléments en tête | `list "À traiter"` → `listitem` | titres et actions actuels d'À faire |
| Lignes | `list "Agents du workspace"` → `listitem` | — |
| Ouvrir l'agent | `button` | `<Nom>, <rôle>, <état>[, issue <id>]` |
| Action | `button` | libellés actuels (« ◆ Répondre », « Revue → », « Reprendre »…) |

Libellés d'état : `démarre`, `travaille`, `attend une consigne`, `attend une réponse`, `fini`,
`erreur`, `limite de débit`, `reprise à HH:MM`.

## Graphe

| Élément | Rôle | Nom accessible |
|---|---|---|
| Vue | `region` | `Graphe des agents` |
| Nœuds | `list "Agents"` → `listitem` → `button` | `<Nom>, <rôle>, <état>[, <phase>][, issue <id>], lancé par <orchestrateur \| vous>` |
| Groupe de boucle | `group` | `Issue <id> · dev ↔ test <n>/3` |
| Liens | `svg` `aria-hidden="true"` | — |

Clic ou Entrée/Espace sur un nœud ou une ligne : ouvre le Focus de l'agent (`view: 'focus'`).
