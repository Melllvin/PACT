# Research: Revue et intégration

S'appuie sur `specs/001-agent-workspace-core/research.md`. La pile, git ≥ 2.40 via `execFile`
(R7), la persistance JSON + zod (R9), les règles IPC (R11), les tests et la CI (R12), le faux CLI
(R13) et l'apparence (R17) ne changent pas. R1 et R4 ont été vérifiés par une sonde sur git 2.43 ;
les autres étapes git sont des commandes standard, que les tests d'intégration figeront.

## R1. Instantané des changements d'un agent

- **Décision** : une revue compare deux arbres git.
  - **Base** : `git merge-base <main> HEAD`, lancé dans le worktree de l'agent.
  - **Instantané** : un arbre du worktree tel qu'il est sur le disque. Pour le construire, copier
    l'index du worktree dans un fichier temporaire, puis lancer `GIT_INDEX_FILE=<tmp> git add -A`
    et `git write-tree`. Son id identifie « l'état actuel des changements » (FR-017) et sert de clé
    aux résultats de tests.
  - **Commit d'instantané** : `git commit-tree <tree> -p HEAD` enveloppe l'instantané dans un
    commit. Ce commit n'est pas référencé et git le nettoie plus tard ; l'intégration et la
    vérification des conflits s'en servent.
  - **Coût** : copier l'index garde le cache stat de git, donc `add -A` ne hache que les fichiers
    modifiés.
- **Justification** :
  - L'instantané couvre en un seul arbre le travail commité, non commité et non suivi, en
    respectant `.gitignore` (FR-005).
  - L'index et les fichiers réels de l'agent ne sont jamais touchés ; la sonde a montré un
    `git status` inchangé après un instantané.
  - Tout ce qui suit travaille sur des objets immuables, si bien que la branche principale ne
    bouge qu'à la toute fin.
- **Alternatives** :
  - `git diff <base>` plus `git ls-files --others` : deux sources à fusionner, et pas d'id unique
    pour l'état.
  - `git stash create` : laisse de côté les fichiers non suivis sauf avec `-u`, et `-u` touche le
    worktree.

## R2. Liste des fichiers et diff

- **Décision** :
  - **Liste** : `git diff --numstat -z -M <base> <tree>` pour les comptes et les renommages.
  - **Types** : `git diff --name-status -z -M` pour les types de changement, et `git diff --raw`
    pour les ids de blob de chaque côté. « Vu » est enregistré par rapport au nouvel id de blob,
    donc un fichier dont le contenu change redevient non vu (FR-009).
  - **Un fichier** : `git diff --no-color -U3 <base> <tree> -- <path>`, découpé en zones par une
    fonction pure de `src/shared/diff.ts`, testée seule.
  - **Fichiers binaires** : `-\t-` dans numstat ; affichés avec un type et une taille
    (`git cat-file -s`), sans diff.
  - **Gros fichiers** : un fichier de plus de 1 Mo ou de 5 000 lignes de diff est affiché de la
    même façon, sans diff (FR-008).
  - **Fins de ligne** :
    - le diff utilise `--ignore-cr-at-eol`, pour que les différences CRLF/LF entre macOS et
      Windows ne fassent pas apparaître un fichier entier comme modifié (FR-033) ;
    - la liste ne l'utilise pas : un fichier qui ne diffère que par ses fins de ligne reste listé,
      avec 0 ligne ajoutée et retirée et la mention « fins de ligne seulement ». La revue ne cache
      rien de ce que l'intégration porterait dans `main` ;
    - un test d'intégration vérifie un changement CRLF seul.
    Le contenu intégré est l'instantané, octet pour octet.
  - **Encodage** : chaque appel git tourne avec `LC_ALL=C` et `core.quotePath=false`, pour que
    les messages ne soient pas traduits (la sonde en a montré en français) et que les chemins
    accentués reviennent en UTF-8.
- **Justification** : git calcule déjà les renommages, les binaires et les statistiques. Le
  découpage du diff unifié est la seule logique nouvelle, et elle est pure.
- **Alternatives** : le paquet npm `diff` (une dépendance de plus, et git calcule la même chose) ;
  le diff côté renderer (ce processus ne peut pas lire les fichiers).

## R3. Suivi du worktree

- **Décision** :
  - **Surveillance** : `fs.watch(worktree, { recursive: true })`, pris en charge sous macOS et
    Windows, en ignorant `.git/`. Les rafales d'événements sont regroupées en un seul instantané
    après 300 ms.
  - **Filet de sécurité** : un nouvel instantané toutes les 5 s tant qu'une revue est ouverte,
    même schéma que la surveillance du dossier dans `WorkspaceService` (T121).
  - **Événements** : un nouvel id d'arbre envoie `review:changed` au renderer.
  - **Portée** : les worktrees ne sont surveillés que lorsque leur revue est ouverte, ou lorsque
    leur agent travaille et a le bouton « Revue → » en attente.
- **Justification** : SC-006 (un changement visible en moins de 3 s) sans interroger git chaque
  seconde.
- **Alternatives** : `chokidar` (une dépendance, et `fs.watch` récursif couvre les deux
  plateformes) ; interrogation périodique seule (ne tient SC-006 qu'au prix d'un coût CPU élevé).

## R4. Vérification des conflits sans rien modifier

- **Décision** :
  - **Vérification** : `git merge-tree --write-tree -z <main> <snapshot commit>`, disponible
    depuis git 2.38. Le code de sortie 0 signifie propre. Le code 1 signifie des conflits, listés
    sous forme de lignes d'étape (mode, oid, étape 1/2/3, chemin) et renvoyés avec un arbre dont
    les fichiers en conflit contiennent les marqueurs.
  - **Quand elle tourne** : à l'ouverture de la revue, quand l'instantané change et quand `main`
    bouge. `main` est surveillée par sa référence (`git rev-parse <main>`), vérifiée au même
    rythme.
  - **Commit qui a introduit un conflit** : affiché comme « main · « Ajout SSO » a41f2 », tiré de
    `git log -1 --format=%h%x00%s <base>..<main> -- <path>`.
- **Justification** : FR-018 et FR-027. La branche principale, son dossier de travail et le
  worktree de l'agent ne sont jamais touchés, car merge-tree n'écrit que des objets.
- **Alternatives** : `git merge --no-commit` dans un worktree temporaire (plus lent, et il faut
  nettoyer ensuite) ; `git apply --check` (rate les fusions à trois voies).

## R5. Intégration

- **Décision** : calculer le résultat à partir d'objets, faire le commit final avec un vrai
  `git commit` pour que les crochets du dépôt passent (décision de l'utilisateur du 2026-10-03),
  et déplacer la branche une seule fois.
  - **Arbre résultat** : l'arbre merge-tree de R4 (ou l'arbre résolu de R6). Quand `main` n'a pas
    bougé depuis la base de l'agent, c'est simplement l'arbre de l'instantané.
  - **Commit avec crochets** : dans un worktree temporaire détaché sur `main`
    (`git worktree add --detach <userData>/integrations/<id> <main>`), lancer `git read-tree -m -u
    <result tree>`, puis `git commit -F <message file>`. `pre-commit` et `commit-msg` passent
    normalement, donc un crochet qui refuse (ou réécrit le message) est respecté. Le worktree
    temporaire est supprimé quoi qu'il arrive.
  - **Squash** (par défaut) : le commit ci-dessus a pour seul parent `main`.
  - **Garder les commits** : si l'agent a des changements non commités, ils deviennent d'abord un
    commit au-dessus de son `HEAD`, fait de la même façon dans un worktree temporaire pour que les
    crochets passent. Ensuite :
    - quand `main` est un ancêtre du résultat, `main` avance en fast-forward jusqu'à lui ;
    - sinon le worktree temporaire lance `git merge --no-ff <that commit>` (les crochets passent
      ici aussi), avec les résolutions de R6 s'il y a eu des conflits.

    Les commits existants de l'agent gardent leurs messages et ne sont pas revérifiés par les
    crochets (FR-019).
  - **Déplacer `main`** : dépend de son extraction ou non (`git worktree list --porcelain`).
    - **Extraite quelque part** : `git merge --ff-only <commit>` tourne dans ce dossier. Git met à
      jour les fichiers et refuse, avant d'écrire quoi que ce soit, si des changements locaux
      seraient écrasés. Ce refus, c'est FR-021 ; la liste des fichiers vient de l'erreur, lue avec
      `LC_ALL=C`.
    - **Non extraite** : `git update-ref refs/heads/<main> <new> <old>`, une comparaison atomique :
      si `main` a bougé entre-temps, rien n'est écrit et la vérification est refaite (FR-022).
  - **Échec** : un crochet qui refuse, un disque plein ou une erreur git surviennent tous avant
    que la branche bouge. Rien n'est annulé puisque rien n'a été écrit dans `main` ; le worktree
    temporaire est supprimé et la sortie de git est affichée (FR-023).
  - **File** : une par workspace, la même chaîne de promesses que `AgentManager.queue` (FR-026).
  - **Agent fermé après l'intégration** (les deux cases cochées) : `GitService.removeWorktree` est
    appelé avec `force: true`. Ses changements non commités sont déjà dans `main`, et sans `force`
    git refuse (FR-024).
  - **Agent gardé** (« Conserver le worktree », US2/AC4) : le worktree passe sur la nouvelle
    `main` avec `git reset --hard <new>`, quand son arbre n'a pas changé depuis l'instantané. Rien
    n'est perdu : l'instantané est dans le nouveau commit, et `--keep` refuserait justement les
    fichiers qui viennent d'être intégrés.
    - Si l'agent a écrit depuis, ses modifications ultérieures sont reportées par une fusion à
      trois voies (base l'instantané, ours la nouvelle `main`, theirs l'arbre actuel, via
      `merge-tree --merge-base`), appliquée avec `read-tree -m -u`.
    - Si cette fusion est en conflit, le worktree est laissé tel quel et la revue l'indique.
- **Justification** :
  - SC-003 (100 % des intégrations échouées ou annulées laissent `main` et son dossier comme ils
    étaient) : aucune étape avant la dernière ne touche une référence ou un fichier.
  - Le refus `--ff-only` de git lui-même fournit exactement la vérification « changements
    locaux », au lieu de la réimplémenter.
- **Alternatives** :
  - `git merge --squash` dans le dépôt principal : touche l'index et les fichiers de
    l'utilisateur avant que le résultat soit connu.
  - `commit-tree` seul : plus rapide, mais saute `pre-commit` / `commit-msg`, ce que
    l'utilisateur a refusé.
  - Cherry-pick commit par commit : les conflits arriveraient commit par commit.

## R6. Résolution des conflits dans PACT

- **Décision** :
  - **Contenu** : chaque fichier en conflit est lu depuis l'arbre résultat de merge-tree, et ses
    marqueurs sont découpés en zones par une fonction pure. Chaque zone garde le côté main et le
    côté agent.
  - **Résoudre une zone** : « Garder main », « Garder cette version » ou « Les deux » réécrit
    cette zone.
  - **« Modifier… »** : édite le fichier entier dans un `<textarea>` à chasse fixe.
  - **« Ouvrir dans l'éditeur ▾ »** : écrit une copie dans
    `userData/conflicts/<integrationId>/<path>`, l'ouvre avec `shell.openPath` ou l'éditeur réglé
    dans `core.editor` de git, et la surveille.
  - **Résolu** : un fichier compte comme résolu dès qu'il ne contient plus de marqueurs
    `<<<<<<<` / `>>>>>>>`.
  - **Appliquer les résolutions** : `git hash-object -w` pour chaque fichier résolu, puis un index
    temporaire (`read-tree <merged tree>`, `update-index --cacheinfo`, `write-tree`) donne l'arbre
    final, et l'intégration continue comme en R5.
  - **Conflits suppression/modification et ajout/ajout** : ne proposent que « Garder main » ou
    « Garder cette version ».
- **Justification** : FR-029 à FR-031. Annuler revient à jeter des objets et le dossier
  `conflicts/` : le worktree de l'agent n'a jamais été modifié.
- **Alternatives** : CodeMirror ou Monaco pour « Modifier… » (dépendances lourdes pour un recours
  occasionnel, et le bouton éditeur couvre déjà les cas avancés).

## R7. Consignes envoyées à l'agent

- **Décision** :
  - **Quand** : commentaires, raccourcis, « Renvoyer à l'agent » et « Demander à l'agent »
    réutilisent le mécanisme `retype` de `AgentManager`. L'agent est « prêt » en
    `awaiting-prompt` ou `done`. Un tour terminé (`turn-finished`) mène à `done`, et c'est
    justement là que les revues ont lieu.
    - Le texte est écrit tout de suite quand l'agent est prêt.
    - Sinon il attend la prochaine transition vers un état prêt.
    - Il n'est jamais écrit pendant `awaiting-answer`, `working` ou `starting`, pour qu'il ne
      puisse pas répondre à une question (FR-014).
  - **File** : devient une FIFO par agent, à la place de l'entrée unique de « Relancer ».
    - Un élément est écrit par transition vers prêt. L'élément suivant attend que l'agent soit de
      nouveau prêt après le tour que le précédent a lancé.
    - Les premiers tests rouges couvrent : écriture immédiate quand l'agent est déjà prêt, rien
      d'écrit pendant `awaiting-answer`, et N éléments écrits un par tour, jamais tous d'un coup.
  - **Comment** : un texte sur plusieurs lignes est envoyé en collage entre crochets
    (`ESC[200~ … ESC[201~`) suivi de `\r`. Claude Code et Codex l'acceptent ; le faux CLI reçoit
    un scénario pour le vérifier.
  - **Formats**, construits par une fonction pure de `src/shared/review-prompts.ts` :
    - commentaire : `Commentaire sur <path>:<line> — <text>` ;
    - « Corriger les commentaires · N » : une seule liste de tous les commentaires non traités ;
    - « Tests en échec » : la commande et les 40 dernières lignes de sortie ;
    - « Conflit avec main » : les fichiers en conflit et une demande de mise à jour depuis
      `main`, de résolution et de relance des tests.
  - **Commentaires traités** : un commentaire est marqué traité dès qu'il a été envoyé dans
    « Corriger les commentaires ».
- **Justification** : une seule façon de taper dans un CLI, déjà testée, qui couvre aussi
  « Relancer ».
- **Alternatives** : écrire tout de suite (répondrait à une question en attente) ; taper caractère
  par caractère (lent, et ne protège pas les sauts de ligne).

## R8. Tests dans le worktree de l'agent

- **Décision** :
  - **Commande** : `testCommand` du workspace, `null` signifiant « détecter ». La détection lit
    `package.json` : un script `test` qui n'est pas le substitut de npm donne `npm test`, ou
    `pnpm test` / `yarn test` selon le fichier de verrouillage. Les autres écosystèmes sont saisis
    par l'utilisateur.
  - **Exécution** : le shell de connexion de R3 de 001 (`sh -lc` / `cmd /d /s /c`), dans le
    worktree, avec le `PORT` de l'agent. Pas de PTY : la sortie est capturée, les 200 dernières
    lignes gardées, délai max 10 min, annulable.
  - **Quand** : à l'ouverture de la revue si aucun résultat ne correspond à l'id d'arbre de
    l'instantané, et à la demande. Une exécution à la fois par agent ; un nouvel instantané pendant
    une exécution marque son résultat comme « ancien ».
  - **État** : le code de sortie décide réussi ou en échec. Le nombre (« 24 réussis ») est lu dans
    les résumés courants (Vitest/Jest `Tests N passed`, pytest `N passed`, `cargo test`
    `test result: ok. N passed`), sinon omis.
- **Justification** : réponse de l'utilisateur (clarification du 2026-10-03), et FR-016 / FR-017.
- **Alternatives** : lancer les tests dans une tuile PTY (encombre la grille) ; lire les tests
  dans la sortie de l'agent (fragile, refusé par l'utilisateur).

## R9. Persistance

- **Décision** : aucun nouveau fichier. Le JSON par workspace (R9 de 001) reçoit ces champs, tous
  avec des valeurs par défaut zod pour que les fichiers de 001 se chargent encore sans migration
  (`SCHEMA_VERSION` reste à 1) :
  - sur chaque agent, `review: { seen: Record<path, blobId>, comments: Comment[] }` ;
  - sur le workspace, `testCommand: string | null`.

  Les résultats de tests et les intégrations en cours ne sont pas enregistrés : un redémarrage
  relance les tests et annule toute intégration inachevée, ce qui est sûr puisque rien n'a été
  écrit (R5).
- **Justification** : FR-011, YAGNI.

## R10. Écrans

- **Décision** :
  - **Onglet Changements** dans `FocusView` (`src/renderer/review/`) : liste des fichiers à
    gauche, diff au centre, le terminal de l'agent en dessous. Le terminal réutilise le xterm
    existant de l'agent via `terminal-registry` (la même instance que la tuile).
  - **Colonne Décision** remplace `TodoColumn` au même endroit tant que l'onglet est ouvert
    (FR-004).
  - **Vue Revue** : le bouton de la Toolbar est activé avec un badge. Il ouvre le Focus sur le
    premier agent qui a des changements, avec les pastilles existantes.
  - **Composants** : primitives shadcn existantes (Tabs, Checkbox, Button, Dialog, Badge, Tooltip,
    ToggleGroup) plus un DropdownMenu pour « Squash en 1 commit ▾ » et « Ouvrir dans l'éditeur ▾ »,
    ajouté par le CLI shadcn comme en R16 de 001.
  - **Vue du diff** : virtualisée à la main (hauteur de ligne fixe, seules les lignes visibles
    sont rendues), car un fichier de 5 000 lignes doit rester fluide. Aucune nouvelle dépendance.
- **Justification** : écrans 1h et 1q ; réutilisation (Constitution IV).
- **Alternatives** : `react-diff-view` ou `diff2html` (une dépendance plus un thème à surcharger,
  pour une simple vue en deux couleurs).

## R11. Faux CLI et dépôts de test

- **Décision** :
  - **Faux CLI** : de nouvelles étapes de scénario écrivent, suppriment et renomment des fichiers
    dans son cwd (le worktree) et commitent, pour que les tests e2e produisent de vrais
    changements.
  - **Tests d'intégration** : tournent sur des dépôts git temporaires, comme pour 001, y compris
    une branche qui a bougé, des changements en conflit et des chemins avec espaces et accents sur
    les deux plateformes.
- **Justification** : Constitution I (chaque story testable avant d'être implémentée).
