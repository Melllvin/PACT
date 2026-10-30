# Data Model: Revue et intégration

S'appuie sur `specs/001-agent-workspace-core/data-model.md`. Les schémas sont dans
`src/shared/model.ts` (zod) et dans `src/shared/review.ts` pour les types propres à la revue. Les
noms de champs sont en anglais, comme dans 001.

## Persisté (JSON par workspace, research R9)

### Agent (étendu)

| Champ | Type | Règle |
|-------|------|------|
| `review` | `AgentReview` | vaut `{ seen: {}, comments: [] }` par défaut, pour que les fichiers de 001 se chargent encore |

### AgentReview

| Champ | Type | Règle |
|-------|------|------|
| `seen` | `Record<string, string>` | chemin → id du blob du contenu marqué « vu ». Un fichier ne compte comme vu que tant que l'id de son blob actuel est égal à celui-ci (FR-009, FR-011) |
| `comments` | `ReviewComment[]` | dans l'ordre de création |

### ReviewComment

| Champ | Type | Règle |
|-------|------|------|
| `id` | uuid | |
| `path` | string | chemin dans le dépôt, séparé par des `/` |
| `line` | int ≥ 1 | numéro de ligne côté agent du diff |
| `text` | string, 1–4000 caractères | |
| `createdAt` | ISO date | |
| `treated` | boolean | vaut `false` par défaut ; passe à `true` dès qu'il est repris par « Corriger les commentaires » (R7) |

### Workspace (étendu)

| Champ | Type | Règle |
|-------|------|------|
| `testCommand` | `string \| null` | `null` signifie la détecter depuis le dépôt (R8). Une chaîne vide est refusée |

## En mémoire (processus main), envoyé par IPC

### ReviewSnapshot

L'état actuel des changements d'un agent, reconstruit à chaque changement dans le worktree (R1, R3).

| Champ | Type | Règle |
|-------|------|------|
| `agentId` | uuid | |
| `base` | commit id | `merge-base(main, HEAD)` |
| `tree` | tree id | l'instantané. Il identifie « l'état actuel » et sert de clé aux résultats de tests |
| `branch` | string | la branche actuelle de l'agent |
| `files` | `ChangedFile[]` | triés par chemin |
| `added`, `removed` | int ≥ 0 | sommes sur `files` (FR-006) |
| `conflicts` | `'none' \| 'checking' \| string[]` | les chemins en conflit avec `main` (R4) |
| `mainHead` | commit id | la `main` contre laquelle la vérification des conflits a tourné |
| `newSinceSeen` | `{ added, removed } \| null` | changements sur des fichiers déjà vus, pour « Nouveaux changements : +N −M » |
| `missing` | boolean | le worktree ou la branche a disparu : la revue ne propose que « Abandonner » |
| `testCommand` | `string \| null` | la commande du workspace, sinon celle détectée dans le worktree ; `null` affiche « Tests : non configurés » sans demande (FR-016) |

### ChangedFile

| Champ | Type | Règle |
|-------|------|------|
| `path` | string | |
| `oldPath` | `string \| null` | renseigné seulement quand le fichier a été renommé |
| `status` | `'added' \| 'modified' \| 'deleted' \| 'renamed'` | |
| `added`, `removed` | `int \| null` | `null` pour les fichiers binaires |
| `binary` | boolean | |
| `tooLarge` | boolean | plus de 1 Mo ou de 5 000 lignes de diff (R2) |
| `eolOnly` | boolean | ne diffère que par les fins de ligne : « fins de ligne seulement » (R2) |
| `blob` | blob id \| null | le côté agent, `null` si supprimé. Comparé à `review.seen[path]` |

### FileDiff

| Champ | Type | Règle |
|-------|------|------|
| `path` | string | |
| `hunks` | `DiffHunk[]` | vide quand `binary` ou `tooLarge` |
| `size` | int | en octets, affichée quand il n'y a pas de diff ligne à ligne |

`DiffHunk` vaut `{ oldStart, newStart, lines: { kind: 'context' \| 'add' \| 'del', oldNo, newNo,
text }[] }`. Il est produit par `parseUnifiedDiff` dans `src/shared/diff.ts`, une fonction pure.

### TestRun

| Champ | Type | Règle |
|-------|------|------|
| `agentId` | uuid | |
| `command` | string | |
| `tree` | tree id | l'instantané sur lequel il a tourné ; il est `stale` dès que `tree` diffère de l'instantané actuel |
| `status` | `'running' \| 'passed' \| 'failed' \| 'cancelled' \| 'timeout'` | |
| `passedCount` | `int \| null` | lu dans le résumé quand il y en a un (R8) |
| `outputTail` | string | les 200 dernières lignes |

La colonne Décision affiche l'un de ces états : « Tests : non configurés » (pas de commande),
« non lancés », « en cours », « N réussis » / « réussis », ou « en échec ».

### Integration

| Champ | Type | Règle |
|-------|------|------|
| `id` | uuid | |
| `agentId` | uuid | |
| `mode` | `'squash' \| 'keep-commits'` | vaut `squash` par défaut (FR-019) |
| `message` | string, au moins 1 caractère | proposé à partir de la consigne de l'agent, sinon de sa branche |
| `after` | `{ closeTile: boolean, removeWorktree: boolean }` | les deux à `true` par défaut (FR-024) |
| `snapshot` | commit id | commit d'instantané pris au clic (R1) |
| `mainAtStart` | commit id | `main` au début de l'intégration |
| `state` | voir ci-dessous | |
| `conflicts` | `ConflictFile[]` | |
| `error` | `string \| null` | le message de git tel quel (FR-023) |

**États de l'intégration** :

```text
checking ──propre─────────────▶ committing ──ok──▶ integrated
   │                               │  └─refus (changements locaux, FR-021)─▶ blocked
   └─conflits──▶ conflicted ──tout résolu + Terminer──▶ committing
                    │  └─Demander à l'agent─▶ waiting-agent ──fin du tour de l'agent──▶ checking
                    └─Annuler────────────────────────────────────────────────▶ cancelled
committing ──erreur git──▶ failed         (main inchangée dans tous les états sauf integrated)
```

### ConflictFile

| Champ | Type | Règle |
|-------|------|------|
| `path` | string | |
| `kind` | `'content' \| 'delete-modify' \| 'add-add'` | les deux derniers ne proposent que « Garder main » ou « Garder cette version » |
| `mainCommit` | `{ short, subject }` | le dernier commit de `main` qui a touché le fichier (R4) |
| `hunks` | `ConflictHunk[]` | `{ index, line, main: string[], agent: string[], resolution: null \| 'main' \| 'agent' \| 'both' }` |
| `edited` | `string \| null` | le contenu entier, renseigné par « Modifier… » ou l'éditeur externe |
| `resolved` | boolean | vrai quand chaque zone a une résolution, ou quand `edited` ne contient plus de marqueurs de conflit |
| `merged` | string | le fichier tel que git l'a fusionné, marqueurs compris ; vide pour un fichier choisi en entier |
| `whole` | boolean | le fichier se choisit en entier, d'un côté ou de l'autre : `delete-modify`, `add-add` ou binaire ; une seule zone (index 0) porte les deux côtés |
| `binary` | boolean | git le tient pour binaire (octet NUL) : ni lignes ni « Modifier… » |
| `deleted` | `'main' \| 'agent' \| null` | le côté qui a supprimé le fichier (`delete-modify`) |

« Terminer l'intégration » n'est actif que lorsque chaque `ConflictFile.resolved` est vrai (FR-030).

## Dérivé (jamais stocké)

- **À relire (badge et « Revue → »)** : l'état de l'agent est `done` ou `awaiting-prompt`, son
  instantané a au moins un fichier, et il n'a pas été intégré ni abandonné depuis. Le badge est le
  nombre de ces agents (FR-002, FR-003).
- **Nombre de vus** : le nombre de fichiers dont le `blob` est égal à `review.seen[path]` (FR-006).
- **Commentaires non traités** : les commentaires avec `treated === false`. C'est le N de
  « Corriger les commentaires · N » (FR-013).
