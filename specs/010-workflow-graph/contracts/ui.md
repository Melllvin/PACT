# Contrat : interface et IPC

Libellés selon `docs/maquettes/CONSIGNES-UI.md`. Pas de maquette dédiée (spec, Références UI) : la disposition
ci-dessous en tient lieu, à valider à la relecture de la Phase 5.

## Vue « Workflow »

Choix de la barre « Vues » (`Toolbar`, `WorkspaceViewMode` gagne `workflow`), après « Revue ». Jamais nommée « Graphe »
(la vue de 006 garde ce nom).

```text
┌ En-tête : « Workflow · <nom> » · source (fichier de <main> @<sha court> | par défaut) · état · [Enregistrer]
├──────────────┬─────────────────────────────────────────┬──────────────────────────┐
│ Étapes       │ Graphe                                  │ Étape choisie            │
│ (liste)      │  [Spec]→[Test]⇄[Dev]→[Peaufinage]→[PR]  │  type, agents, modèle,   │
│ + Ajouter    │  retours en arc, plafond sur le lien    │  consigne, passes, mode, │
│              │                                         │  Relier à…, Retirer      │
│              │                                         ├──────────────────────────┤
│              │                                         │ Forme texte (lecture)    │
└──────────────┴─────────────────────────────────────────┴──────────────────────────┘
```

- **En-tête** : source et état (« valide », « invalide sur cette machine : <raison> », « invalide ligne <n> : … —
  la version @<sha> s'applique », « seconde phase : non exécutable »). `ignoredLocal` : « Réglage local ignoré :
  plafond 5 (le fichier dit 3) ». Une PR d'enregistrement ouverte : « PR #<n> en relecture · la version courante
  s'applique jusqu'à sa fusion ».
- **Graphe** : nœuds = `button` (nom accessible « Étape <id>, <type>, <n> agents »), liens = `svg aria-hidden`. Le nœud
  de l'étape en cours d'une issue choisie est entouré (sélecteur « Issue » dans l'en-tête).
- **Liste** : même ordre que le fichier ; c'est la voie clavier principale.
- **Panneau** : `select` du type ; pour chaque agent, `select` du rôle (rôles requis seulement) et du modèle (paliers
  jusqu'au plafond du profil, US2 sc.2) ; zone de texte de la consigne (compteur, 2000) ; `passes` (0–5) pour
  peaufinage ; mode de fusion pour PR ; « Relier à… » : étape cible + cases des résultats possibles + plafond si la
  transition ferme une boucle ; « Retirer l'étape » (confirmation si des transitions y mènent).
- **Forme texte** : `<pre>` en lecture, ligne changée surlignée, numéros de ligne. Une erreur de validation renvoie à
  sa ligne.
- **Enregistrer** : actif seulement si le brouillon diffère et qu'il n'y a aucune erreur bloquante ; libellé selon la
  voie : « Enregistrer (PR) », « Enregistrer (fusion locale) », inactif avec la raison si `gh` manque ou remote non
  GitHub.

## Clavier et lecteur d'écran (FR-008, US2 sc.5)

| Touche | Effet |
|---|---|
| `Tab` | liste → graphe → panneau → texte |
| Flèches (graphe) | nœud voisin selon la disposition |
| `Alt` + flèches | déplace le nœud de 8 px (écrit sa position) |
| `Entrée` | ouvre l'étape dans le panneau |
| `Suppr` | « Retirer l'étape » (avec confirmation) |

Région `aria-live="polite"` : « Étape <id> ajoutée », « Transition <a> → <b> sur <résultats> », « Plafond <n> »,
« Erreur : <message> ». Audit axe dans l'e2e, comme 006.

## Réglages de livraison (008), avec 010

`DeliverySettingsDialog` garde ses champs ; avec un fichier ou au premier enregistrement, « Enregistrer » devient
« Enregistrer (PR) » et appelle `workflow:save` avec le brouillon modifié (FR-016, FR-019). Le toggle Auto n'est pas
dans le fichier et s'enregistre localement, comme dans 008.

## Suivi de l'issue (US1 sc.2)

La ligne d'issue (À faire et colonne Agents de 006) montre `Étape <id>` ; l'élément d'une issue `waiting-user` est
l'escalade de 008. Un `run.status: refused` crée `workflow-refused`.

## IPC

| Canal | Sens | Charge |
|---|---|---|
| `workflow:get` | renderer → main | `{ workspaceId }` → `{ text: string \| null, validation, machine, source, oid, ignoredLocal, pendingPr }` |
| `workflow:validate` | renderer → main | `{ workspaceId, draft: Workflow }` → `{ text, validation, machine }` (texte produit par `writeWorkflow`) |
| `workflow:save` | renderer → main | `{ workspaceId, draft: Workflow, moved: string[] }` → `{ channel: 'github' \| 'local', deliveryId }` ou refus `{ reason }` |
| `workspace:workflow` | main → renderer | `{ workspaceId, workflow: Workspace['workflow'], runs }` |
