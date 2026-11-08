# Research: Livraison automatique

Décisions vérifiées contre le code de `origin/007-agent-exchanges` (`967dc90`) et de `origin/007-phase-6` pour
`LoopService` (contrôle du testeur par intersection des bases, 007 R12). La spec fait foi : chaque point ci-dessous
l'applique, et les points encore ouverts sont rassemblés en fin de document, avec une recommandation.

## R1 — Base et découpage

- **Decision** : implémentation sur `008-delivery-auto`, depuis `origin/main` une fois 007 fusionnée, sinon depuis
  `origin/007-agent-exchanges`. Une PR par phase, branche `008-phase-N-…` depuis `008-delivery-auto`.
- **Rationale** : 008 consomme le journal (`ExchangeService.record`), le réveil (`WakeService`) et
  `LoopService.outsideTests` de 007. Sans 007, FR-006 et SC-008 n'ont pas de voie.
- **Alternatives** : partir de `main` aujourd'hui, ce qui obligerait à refaire `EventQueue` ; rejeté.

## R2 — Un service de livraison, persisté

- **Decision** : `DeliveryService` (`src/main/delivery/delivery-service.ts`) porte la demande de bout en bout : barrières,
  `fetch`, recalage, tests, push, PR, suivi de CI, fusion. Son état vit dans `workspace.deliveries` (data-model), écrit à
  chaque transition avant l'effet externe suivant. `IntegrationRequests` est retiré, `IntegrationService` reste pour la
  fusion locale d'un dépôt sans remote.
- **Rationale** : FR-025 et SC-005 exigent que chaque étape survive à un redémarrage. Écrire l'état avant l'effet rend
  chaque reprise idempotente : `pushing` relit la tête distante avant de pousser, `opening` relit le numéro de PR noté,
  `merging` relit l'état de la PR avant de refusionner.
- **Constitution IV** : aucun service existant ne suit un état externe dans la durée. `IntegrationService` est un calcul
  local et synchrone ; y greffer la forge le rendrait illisible (618 lignes).

## R3 — Verdict et preuve liés à un commit (FR-003)

- **Decision** : `StoredReport` gagne `commit` (HEAD du dev quand le testeur rend son verdict) et `dirty` (le worktree du
  dev diffère de ce commit). `round.proof` gagne `commit`. PACT ne lance la preuve que si `snapshot.tree` égale
  `treeOf(HEAD)` : sinon, le résumé de `testRun` dit « changements non commités » et aucune preuve n'est posée.
- **Rationale** : aujourd'hui la preuve porte sur `tree`, qui inclut le non-commité. Un commit est ce que PACT pousse.
- **Ancien état** : `proof.commit` absent sur un fichier ancien = pas de preuve pour la livraison (défaut `null`).

## R4 — Les tests du testeur dans la branche du dev (FR-002, Q13)

- **Decision** : la liste des fichiers du testeur est celle de 007 R12, prise sur son commit HEAD (pas son worktree) :
  fichiers de test changés depuis l'intersection de ses bases. Pour chacun, `git.entry(F, path)` doit égaler
  `git.entry(testerHead, path)` (même blob, ou absent des deux pour une suppression). La raison du refus liste les
  fichiers et donne la consigne envoyée au dev : `git checkout <branche du testeur> -- <fichiers>` puis un commit.
- **Pourquoi le HEAD** : un test non commité du testeur ne peut pas être récupéré par git ; la consigne du testeur
  (skill `pact-test`) lui demande déjà de committer ses tests. Le refus le dit si son worktree a du non-commité.

## R5 — Recalage par PACT (FR-004, Q1, Q2, Q24)

- **Decision** : `fetch` limité (R13), puis rejeu de `mergeBase(F, origin/<cible>)..F` sur `origin/<cible>` dans un
  worktree temporaire détaché sous `<userData>/deliveries/<id>` (`git rebase --onto`, `core.hooksPath` vide, sans
  signature), comme le fait déjà `IntegrationService` sous `integrationsDir`. Sans conflit : R, noté dans la demande ;
  le verdict passe de F à R (`verdictCommit = R`, `frozenCommit = F` gardé). Conflit : `rebase --abort`, la demande tombe
  avec la liste des fichiers, la boucle repart en `running` sur un nouveau tour (compté), le dev reçoit la consigne de
  recaler lui-même sur `origin/<cible>`, puis le testeur rend un nouveau verdict.
- **Si `origin/<cible>` contient déjà F** : R = F, aucun rejeu.
- **Compteur** : `rebases` compte les recalages sans conflit de suite ; il revient à 0 à la fusion ou à une nouvelle
  demande. À 3, élément `delivery-alert` et réveil, sans arrêter le suivi.
- **Après le push** : PACT amène le worktree du dev sur R (`GitService.moveWorktree`) seulement si son HEAD est encore F,
  qu'il est propre et que l'agent n'est pas en `working`. Sinon il ne le touche pas, et FR-037 décidera à la fusion.
- **Alternatives** : `merge` de `origin/<cible>` dans la branche : PR plus bruyante et contrôle « même contenu rejoué »
  impossible ; rebase dans le worktree du dev : casse le travail en cours (edge case de la spec).

## R6 — Commit qui ne vient pas de PACT (FR-004)

- **Decision** : la demande garde `pactCommits` (F et chaque R). Une tête de branche locale du dev ≠ F avant le push, ou
  une tête de PR ∉ `pactCommits` après, fait tomber la demande (`dropped`, raison `foreign-commit`). Aucun test ni fusion
  n'est lancé sur ce commit.
- **Boucle** : la chute ramène la boucle de `delivering` à `running`, sur le même tour, sans compteur : le verdict ne
  vaut plus pour la tête, et l'orchestrateur demande un nouveau verdict au testeur. Une chute pour fermeture d'agent la
  passe à `closed` (R12).
- **Vérification locale** : `LoopService` et `DeliveryService` relisent la tête du dev à chaque étape et à chaque
  `agent:state` du dev ; la lecture de la PR se fait à chaque passage du suivi (R9).

## R7 — Push

- **Decision** : `git push origin <commit>:refs/heads/<branche> --force-with-lease=refs/heads/<branche>:<attendu>`, avec
  `GIT_TERMINAL_PROMPT=0` et le délai `REMOTE_TIMEOUT_MS`. `attendu` est la dernière tête poussée par la demande, ou
  vide pour une branche absente du remote. Le push part du dépôt principal, jamais du worktree d'un agent.
- **Rationale** : un recalage réécrit l'historique ; le bail empêche d'écraser un commit qu'un tiers aurait poussé, qui
  ferait tomber la demande (R6) au lieu d'être perdu.

## R8 — `gh` : les seules commandes permises (FR-029 à FR-033)

- **Decision** : `GhClient` (`src/main/delivery/gh-client.ts`) n'expose que les appels de `contracts/gh.md`, construits à
  partir de constantes ; aucun argument libre. Il réutilise `ghCommand` de `issues.ts` (faux `gh` en mode test).
- **Champs lus** : `gh pr view <n> --json number,state,headRefOid,headRefName,author,isCrossRepository,baseRefName,mergeStateStatus`
  et les `check-runs` / `status` du commit, réduits à `{ name, status, conclusion }`. Jamais `title`, `body`, `comments`,
  `reviews`, `labels` ni un journal hors de `get_ci_log` (R15).
- **Login** : `gh api user --jq .login`, noté à la création de la PR (`expectedAuthor`) ; relu avant toute fusion.
- **Fusion** : `gh pr merge <n> --squash|--merge|--rebase --match-head-commit <sha>`, jamais `--auto` ni
  `--delete-branch`. Un test de contrat interdit `--auto` dans tout argument construit (SC-002).
- **Repli refusé** : remote non GitHub (`gh repo view --json url` échoue ou URL hors `github.com`), `gh` absent ou
  `gh auth status` en échec → refus avec la raison et le remède (« installe `gh` », « lance `gh auth login` »), jamais
  la fusion locale (Q4).

## R9 — Suivi de CI

- **Decision** : `CiWatcher` (`src/main/delivery/ci-watcher.ts`) relit chaque PR suivie toutes les 30 s, sans agent
  (indépendant de 009). Chaque lecture : `pr view` (structure), puis checks du `headRefOid`. La fonction pure
  `ciVerdict` (`src/shared/delivery.ts`) décide : `green`, `red`, `pending`, `silent`, `stalled`, `unknown`.
- **Vert** (Q6) : au moins un check, tous terminés en `success` / `neutral` / `skipped`, et chaque check requis présent
  et vert. **Rouge** : un `failure`. **Bloqué** : `cancelled`, `timed_out`, `stale`, `action_required` → une relance par
  job (`gh api -X POST …/actions/jobs/<id>/rerun`), puis `delivery-alert`, sans aller-retour.
- **Sans CI configurée** (FR-015) : vert dès la PR ouverte, la preuve de PACT sur R en tient lieu (constitution II).
- **Forge injoignable** : la lecture échoue → `unknown`, jamais vert ; alerte après 10 min d'échecs de suite.
- **Lecture d'Auto** : au passage à `green`, `workspace.delivery.auto` est lu à cet instant (FR-011, SC-004).
- **Relecture du vert juste avant la fusion** : FR-031 relit l'auteur, `isCrossRepository`, `headRefOid` et le login.

## R10 — CI configurée (FR-016)

- **Decision** : CI configurée si `git ls-tree origin/<cible> .github/workflows/` liste un `.yml` ou `.yaml`, ou si les
  checks requis lus (`branches/<cible>/protection/required_status_checks` puis `rules/branches/<cible>`) ne sont pas vides.
- **Protection illisible** (403 sans droit d'administration, 5xx) : CI réputée **configurée**, sans liste de requis.
  Auto ne peut alors fusionner qu'avec au moins un check lu et vert. C'est le choix sûr ; voir point ouvert P5.

## R11 — Réglages du projet

- **Decision** : `workspace.delivery` (data-model) : `auto: false`, `mergeMode: 'squash'`, `maxRounds: 3` (1 à 10),
  `polishPasses: 0` (0 à 5), `polishBrief: ''` (≤ 2000). Enregistré dans le workspace jusqu'à 010 FR-020.
- **Plafond** : lu en direct par `LoopService` (pas de copie dans la boucle) : un plafond baissé sous le tour courant
  escalade au prochain `defects` (edge case). L'escalade de modèle de 004 FR-007 se fait au tour `maxRounds`.
- **Schémas** : `roundNumber` passe à `max(10)` (`MAX_ROUNDS_LIMIT`), `rounds` à `max(10)`, `storedReportSchema.round`
  aussi. Les textes « 3 tours » (`tools.ts`, `TodoItem.tsx`, `todo.ts`, `pact-contract.md`) citent le plafond du projet.

## R12 — États de la boucle (FR-007, FR-024, FR-026)

- **Decision** : `loop.state` devient `running` | `polishing` | `accepted` | `delivering` | `merged` | `escalated` |
  `closed`. La preuve passe la boucle à `polishing` (passes > 0) ou `accepted`, et l'issue reste `in-progress`. L'issue
  passe à `done` à `merged` seulement.
- **Ancien `passed`** : chargé comme `closed` (`z.preprocess`) ; l'issue garde son état `done`. Ces boucles n'ont jamais
  été livrées par PACT et leurs agents sont souvent partis : les rouvrir créerait des livraisons fantômes.
- **Agent fermé** (FR-026) : `LoopService.agentClosed` passe `running`, `polishing`, `accepted` à `closed`, réveille
  l'orchestrateur (`loop`, action) et libère l'issue (`ready`) pour `start_loop`. En `delivering`, `DeliveryService`
  fait tomber la demande d'abord (Q10), PR gardée.

## R13 — `fetch` limité (FR-033, US7 sc.8)

- **Decision** : `GitService.fetchRefs(cwd, branches)` : un refspec explicite par branche,
  `+refs/heads/<b>:refs/remotes/origin/<b>`, pour la cible et les branches des demandes. Jamais `refs/pull/*`, jamais
  `--all`. `fetchOrigin` existant en est le cas à une branche et reste tel quel.

## R14 — Valider, Refuser, un seul geste (FR-013, FR-014, FR-027)

- **Decision** : IPC `delivery:decide({ deliveryId, decision: 'validate' | 'refuse', reason? , head })`. Le service
  garde un verrou en mémoire par demande et passe l'état à `merging` **avant** l'appel à `gh` : un second clic trouve
  `merging` et rend le même résultat (idempotent). `head` est la tête affichée : différente de la tête relue → refus,
  l'élément se recharge.
- **Refuser** : motif de 1 à 2000 caractères ; il part au dev comme un verdict `defects` d'une ligne, par
  `ExchangeService.record` (kind `verdict`, type action), et ouvre un nouveau tour par `LoopService.reopen`, qui compte l'aller-retour et escalade au plafond (FR-018). CI rouge, tests rouges après recalage et conflit passent par la même méthode. L'élément revient une fois après la
  nouvelle CI verte, même Auto activé (`reviewRequired: true` jusqu'à la décision suivante).
- **Une seule place** : l'élément de relecture vit dans À faire (et en tête de la colonne Agents en 006) ; « Livrer »,
  « Valider » ne demandent jamais de dialogue « l'agent travaille encore » : la livraison ne regarde que le commit figé.

## R15 — Journal de CI pour le dev (FR-032, Q16, Q30)

- **Decision** : outil d'agent `get_ci_log({ check })`, réservé au dev d'une demande non tombée. PACT vérifie que la PR
  est suivie, non issue d'un fork, et que le check appartient à la tête courante, puis rend
  `gh run view --job <id> --log-failed` borné à 20 000 caractères (fin du journal), précédé de la note de 007 sur les
  données rapportées. Sinon refus, sans rien lire.

## R16 — Contenu de tiers (FR-029 à FR-033, SC-009)

- **Decision** : les protections tiennent dans la construction des appels (R8, R13) : PACT ne demande jamais un champ
  textuel, ne liste jamais les PR, ne cherche jamais par nom de branche. Le nom d'un check est borné à 100 caractères,
  débarrassé des caractères de contrôle, et présenté entre guillemets comme une donnée rapportée.
- **Test témoin** : le faux `gh` sert une chaîne `PACT-INJECTION-WITNESS` dans tout champ textuel d'une PR, d'un fork,
  d'un commentaire et d'un journal de fork, et journalise chaque appel. Le test vérifie l'absence de la chaîne dans le
  journal de 007, les éléments À faire, l'état JSON, les PTY des faux agents, et qu'aucun appel ne vise ces PR.

## R17 — Nettoyage des worktrees (FR-034 à FR-043)

- **Decision** : `WorktreeCleanup` (`src/main/delivery/cleanup.ts`), appelé à la fusion constatée d'une PR suivie avec
  verdict. Juste avant chaque suppression (FR-042) :

| Agent | Conditions (toutes) |
|---|---|
| Dev | fermé ; `HEAD` = tête fusionnée de la PR ; `status --porcelain` vide ; aucun ignoré `.env*` |
| Testeur | fermé ; `status --porcelain` vide ; aucun ignoré `.env*` ; chaque fichier de test de R4 a le même blob dans la tête fusionnée |
| Orchestrateur | jamais |

- **Suppression** : `git worktree remove` **sans** `--force` (les ignorés comme `node_modules` partent avec le dossier ;
  un fichier modifié le fait échouer, double garde), puis `git branch -D` pour le dev seulement si sa tête est encore la
  tête fusionnée. Le chemin `close({ removeWorktree: true })`, qui force, n'est jamais utilisé ici.
- **Doute** : élément `worktree-kept` avec la raison et « Supprimer quand même », qui liste d'abord ce qui serait perdu
  (fichiers modifiés et non suivis, `.env*`, commits absents de la tête fusionnée) puis supprime avec `force`.
- **Jamais automatique** : PR fermée sans fusion, boucle ou agent fermé, PR sans verdict, PR d'un autre auteur,
  `close_agent`. Échec de suppression (fichier verrouillé) : `worktree-kept` avec l'erreur. Redémarrage entre fusion et
  nettoyage : `cleanup` reste noté `pending` dans la demande et se rejoue ; un dossier déjà absent n'est pas une erreur.
- **Squash** : la détection de fusion lit `state: MERGED` et `headRefOid` de la PR ; jamais `branch --merged` (FR-036).

## R18 — Branche distante (FR-043, Q26)

- **Decision** : à la fusion constatée, `git push origin --force-with-lease=refs/heads/<b>:<tête fusionnée> :refs/heads/<b>`.
  Le bail fait la vérification « tête encore égale » de façon atomique. Échec du bail : la branche reste, et PACT le dit
  (`delivery-alert` info). Phase isolée (tasks), pour pouvoir la retirer sans toucher au reste : voir P1.

## R19 — Dépôt sans remote (FR-008, Q29)

- **Decision** : `request_delivery` applique les mêmes barrières, puis crée un élément `delivery-local` (« ◎ Fusionner
  <agent> → <main> ? ») qui appelle `IntegrationService.start` avec `after: { closeTile: true, removeWorktree: false }`.
  Auto est sans effet. « Fusionner sans verdict » : même élément, `verdict: null`, confirmé.
- **Conflits persistés** (FR-025, US6 sc.2) : `Pending` (sans les fonctions de suivi) est écrit dans
  `<integrationsDir>/<id>.json` à chaque changement, relu au démarrage par `IntegrationService.restore()`. La demande
  n'est retirée du workspace qu'à `integrated`, `failed` ou `cancelled`, plus au premier état.

## R20 — Suivi indexé par demande (FR-028)

- **Decision** : `IntegrationService.start` reçoit `requestId` optionnel, repris dans `Integration` ; le suivi de
  `DeliveryService` filtre sur `requestId`, plus sur `agentId`. Une intégration manuelle (sans `requestId`) n'est jamais
  rapportée à l'orchestrateur comme celle d'une demande.

## R21 — Réveil de l'orchestrateur (FR-006, SC-008)

- **Decision** : nouveau kind `delivery` dans le journal de 007, type `action` (`typeOf`), avec un champ structuré
  `delivery: { id, outcome, pr?, commit?, checks? }`. `outcome` : `refused`, `dropped`, `conflicted`, `tests-failed`,
  `pr-opened`, `ci-green`, `ci-red`, `review-requested`, `user-refused`, `merged`, `merge-failed`, `alert`. Le résumé est
  construit par PACT, sans aucun texte de la forge hors noms de checks bornés.

## R22 — PR sans verdict et reprise de PR (FR-001, FR-030, Q27, Q31, Q32)

- **Decision** : `Delivery.verdict` nullable ; `unverified: true` pour le geste « Créer la PR sans verdict ». Ces
  demandes passent toujours par `delivery-review`, jamais par Auto, sans compteur ni nettoyage automatique.
- **Reprise** : une nouvelle demande du même agent (même branche) reprend `pr.number` de la dernière demande tombée de
  cette branche. Avant le push : `pr view` doit dire `OPEN`, `author.login = expectedAuthor`, `isCrossRepository: false`.
  Après le push : `headRefOid` doit égaler la tête poussée. Échec sur une PR ouverte : ni reprise ni création,
  `delivery-alert`. PR fermée, fusionnée ou introuvable : nouvelle PR.

## R23 — Peaufinage (FR-022 à FR-024)

- **Decision** : après la preuve, si `polishPasses > 0`, la boucle passe à `polishing` avec `polish: { done: 0, total }`.
  L'orchestrateur est réveillé ; il lance chaque passe par `polish_pass({ issue, notes? })`. PACT compose la consigne :
  `polishBrief` du projet, `notes` de l'orchestrateur (≤ 2000), et la phrase fixe « Aucune nouvelle fonctionnalité :
  corrige seulement ce qui est demandé ». Le dev la reçoit en `instruction`, puis le testeur vérifie ; `accepted` + preuve
  sur le commit de fin → `done + 1`. `defects` : la même passe reprend (P2), sans aller-retour.
- **`request_delivery`** refusée tant que `done < total`, avec « passe k sur N à finir ».

## R24 — Nettoyage des anciennes demandes

- **Decision** : au chargement, `integrationRequests` non vide → vidé, et un élément `info` « N demandes d'intégration
  retirées : redemande-les par Livrer » une fois. Le champ reste dans le schéma (défaut `[]`) pour lire les fichiers.

## R25 — Constantes

| Nom | Valeur | Source |
|---|---|---|
| `CI_POLL_MS` | 30 000 | R9 |
| `SILENT_CI_MS` | 600 000 | FR-016, Q5 |
| `FORGE_DOWN_MS` | 600 000 | edge case |
| `MAX_REBASES_IN_A_ROW` | 3 | FR-017 |
| `MAX_CHECK_NAME` | 100 | edge case, R16 |
| `MAX_CI_LOG` | 20 000 | R15 |
| `MAX_REASON` | 2 000 | FR-014 |
| `MAX_ROUNDS_LIMIT`, `MAX_POLISH` | 10, 5 | FR-020 |

## Points ouverts (non bloquants, recommandation donnée)

- **P1 — Branche distante** : la consigne de l'agent la donne comme non décidée, alors que la spec la tranche (Q26,
  FR-043, US8 sc.12). La spec fait foi : planifiée, mais seule dans sa phase (Phase 11) avec un bail atomique (R18).
  **Recommandation** : confirmer Q26 ; si l'utilisateur la retire, supprimer la Phase 11 et FR-043, sans autre impact.
- **P2 — `defects` répétés en passe** : la spec dit « la même passe reprend » et « passes épuisées avec des défauts :
  l'utilisateur décide », sans dire quand une passe est épuisée. **Recommandation** : une passe reprend une fois ; un
  second `defects` sur la même passe l'épuise et escalade à l'utilisateur (`loop-escalated`, sans fusion).
- **P3 — Branche locale du testeur** : FR-035 ne parle que de son worktree. **Recommandation** : garder la branche (coût
  nul, réversible) ; 011 pourra la proposer au nettoyage.
- **P4 — Place du toggle Auto** : PACT n'a pas de barre en bas aujourd'hui. **Recommandation** : une barre d'état fine en
  bas de la vue du workspace, avec Auto à droite et l'accès aux réglages de livraison (contracts/ui.md).
- **P5 — Protection illisible** : sans droit d'administration, `gh` ne lit pas les checks requis. **Recommandation** :
  CI réputée configurée (R10) ; Auto exige au moins un check lu et vert.
- **P6 — Relance d'un check hors GitHub Actions** : `rerun` n'existe que pour un job d'Actions. **Recommandation** :
  pour un autre check, aucune relance, alerte directe.
