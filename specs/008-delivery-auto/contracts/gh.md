# Contrat : appels à `gh` et à `git` distant

Liste fermée. `GhClient` et `GitService` ne construisent rien d'autre ; un test de contrat
(`tests/contract/gh-client.contract.test.ts`) énumère chaque argument produit et refuse `--auto`, `--delete-branch`,
`pr list`, `search`, `refs/pull`, et tout champ `--json` hors de cette page.

## `gh`

| But | Commande | Lu |
|---|---|---|
| Disponible, connecté | `gh auth status --hostname github.com` | code de sortie |
| Login | `gh api user --jq .login` | une ligne |
| Remote GitHub | `gh repo view --json url,nameWithOwner` | `url`, `nameWithOwner` |
| Créer la PR | `gh pr create --head <branche> --base <cible> --title <titre> --body-file -` | URL → numéro |
| Lire la PR | `gh pr view <n> --json number,state,headRefOid,headRefName,author,isCrossRepository,baseRefName,mergeStateStatus` | ces champs |
| Checks | `gh api repos/<owner>/<repo>/commits/<sha>/check-runs --jq '[.check_runs[]\|{id,name,status,conclusion}]'` | ces champs |
| Statuts | `gh api repos/<owner>/<repo>/commits/<sha>/status --jq '[.statuses[]\|{context,state}]'` | ces champs |
| Requis | `gh api repos/<owner>/<repo>/branches/<cible>/protection/required_status_checks --jq .contexts`, puis `gh api repos/<owner>/<repo>/rules/branches/<cible>` réduit aux `required_status_checks` | noms |
| Relancer un job | `gh api -X POST repos/<owner>/<repo>/actions/jobs/<id>/rerun` | code |
| Journal (R15) | `gh run view --job <id> --log-failed` | fin bornée |
| Fusionner | `gh pr merge <n> --squash\|--merge\|--rebase --match-head-commit <sha>` | code, stderr borné |

Le corps de la PR (stdin) : identifiant de l'issue, `Closes #<n>` si elle est publiée, son texte sinon, verdict
(`accepted`, commit, testeur), message de la demande. Une PR sans verdict le dit en tête.

Le `stderr` de `gh` n'est rendu qu'à l'utilisateur et à l'orchestrateur, borné à 500 caractères, pour `pr create` et
`pr merge` (raison de la protection) ; c'est un texte de la forge, pas d'un tiers.

## `git` distant

| But | Commande |
|---|---|
| `fetch` limité | `git -c gc.auto=0 fetch --no-tags --no-recurse-submodules --quiet origin +refs/heads/<b>:refs/remotes/origin/<b> …` |
| Push | `git push --quiet origin <sha>:refs/heads/<b> --force-with-lease=refs/heads/<b>:<attendu>` |
| Branche distante | `git push --quiet origin --force-with-lease=refs/heads/<b>:<tête fusionnée> :refs/heads/<b>` |

Toutes avec `GIT_TERMINAL_PROMPT=0` et `REMOTE_TIMEOUT_MS`. Aucun agent ne lance ces commandes : PACT les lance
depuis le dépôt principal.

## Faux `gh` des tests (`tests/fixtures/fake-cli/fake-gh.mjs`)

État dans `FAKE_GH_STATE` (JSON) : PR, checks par commit, requis, login, protection, échecs programmés. Chaque appel est
journalisé dans `FAKE_GH_LOG`. Le scénario `third-party` ajoute une PR de fork et une PR d'un autre auteur dont tout champ
textuel vaut `PACT-INJECTION-WITNESS …`, servis seulement si on les demande.
