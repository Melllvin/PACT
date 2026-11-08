# Contrat : commandes Git et système

Liste fermée. Un test de contrat (`tests/contract/storage-git.contract.test.ts`) énumère les arguments produits par
`src/main/storage/` et refuse `fetch`, `pull`, `remote show`, `gc`, `maintenance`, `branch --merged`,
`merge-base --is-ancestor`, `pr list`, `search`, et tout `status` sans `--no-optional-locks`.

## Lecture (FR-004 : rien n'est écrit)

Toutes avec `GIT_OPTIONAL_LOCKS=0`, `--no-optional-locks`, `core.quotePath=false`, `LC_ALL=C` (comme `GitService`).

| But | Commande | Où |
|---|---|---|
| Worktrees du dépôt | `git worktree list --porcelain -z` | dépôt principal |
| État d'un worktree | `git status --porcelain=v2 -z --branch --untracked-files=all --ignored=matching` | worktree |
| Commits non poussés | `git rev-list --reverse --max-count=51 HEAD --not --remotes` | worktree |
| Leurs sujets | `git log --no-walk=unsorted --format=%H%x00%s%x00%cI <sha>…` | worktree |
| Récupérable ? | `git branch -r --format=%(refname:short) --contains <sha>` | worktree |
| Dernier commit | `git log -1 --format=%cI HEAD` | worktree |
| Fichiers non ignorés | `git ls-files -z --cached --others --exclude-standard` | worktree |
| Objet présent ? | `git cat-file -e <sha>^{commit}` | dépôt principal |
| Blob d'un fichier | `GitService.entry(headRefOid, path)` (existant) | dépôt principal |
| Branche principale | `workspace.mainBranch` (aucune commande) | — |

## Écriture (seulement sur geste confirmé, après R10)

| But | Commande |
|---|---|
| Worktree | `git worktree remove --force <chemin résolu>` depuis le dépôt principal |
| Branche locale | `git branch -D <branche réelle>` si ni `mainBranch`, ni rattachée ailleurs |
| Entrées mortes | `git worktree prune --expire=now` dans le dépôt |
| Branche distante (008) | `git push --quiet origin --force-with-lease=refs/heads/<b>:<tête fusionnée> :refs/heads/<b>` |

Aucun `rm` récursif sur un worktree : si `git worktree remove` échoue, l'échec est rendu tel quel.

## `gh` (Phase 6, par `GhClient` de 008)

| But | Commande |
|---|---|
| Login | `gh api user --jq .login` |
| État d'une PR notée | `gh pr view <n> --json number,state,headRefOid,headRefName,author,isCrossRepository,baseRefName,mergeStateStatus` |

Rien d'autre : ni titre, ni corps, ni commentaires, ni liste.

## Système de fichiers

| But | Appel |
|---|---|
| Parcours de taille | `opendir`, `lstat` (jamais `stat` sur un lien) |
| Propriété | `lstat`, `realpath.native` du chemin et de son parent attendu |
| Élément de `<userData>` | `rm(path, { recursive: true })` après propriété relue ; jamais sur un lien |
| Caches | `pending-cleanup.json` écrit au geste, lu et supprimé au démarrage (R12) |
| Données d'un workspace | `rm(<userData>/workspaces/<hash>.json)` après relecture ouvert/récent |
