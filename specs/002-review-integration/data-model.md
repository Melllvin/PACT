# Data Model: Revue et intégration

This builds on `specs/001-agent-workspace-core/data-model.md`. Schemas live in `src/shared/model.ts`
(zod) and in `src/shared/review.ts` for review-only types. The field names are English, as in 001.

## Persisted (per-workspace JSON, research R9)

### Agent (extended)

| Field | Type | Rule |
|-------|------|------|
| `review` | `AgentReview` | defaults to `{ seen: {}, comments: [] }`, so files from 001 still load |

### AgentReview

| Field | Type | Rule |
|-------|------|------|
| `seen` | `Record<string, string>` | path → blob id of the content that was marked « vu ». A file counts as seen only while its current blob id equals this one (FR-009, FR-011) |
| `comments` | `ReviewComment[]` | in creation order |

### ReviewComment

| Field | Type | Rule |
|-------|------|------|
| `id` | uuid | |
| `path` | string | path in the repository, `/`-separated |
| `line` | int ≥ 1 | line number on the agent's side of the diff |
| `text` | string, 1–4000 characters | |
| `createdAt` | ISO date | |
| `treated` | boolean | defaults to `false`; set to `true` once included in « Corriger les commentaires » (R7) |

### Workspace (extended)

| Field | Type | Rule |
|-------|------|------|
| `testCommand` | `string \| null` | `null` means detect it from the repository (R8). An empty string is refused |

## In memory (main process), sent over IPC

### ReviewSnapshot

The current state of an agent's changes, rebuilt on every change in the worktree (R1, R3).

| Field | Type | Rule |
|-------|------|------|
| `agentId` | uuid | |
| `base` | commit id | `merge-base(main, HEAD)` |
| `tree` | tree id | the snapshot. It identifies « l'état actuel » and keys test results |
| `branch` | string | the agent's current branch |
| `files` | `ChangedFile[]` | sorted by path |
| `added`, `removed` | int ≥ 0 | sums over `files` (FR-006) |
| `conflicts` | `'none' \| 'checking' \| string[]` | the conflicting paths against `main` (R4) |
| `mainHead` | commit id | the `main` the conflict check ran against |
| `newSinceSeen` | `{ added, removed } \| null` | changes to files that were seen, for « Nouveaux changements : +N −M » |
| `missing` | boolean | the worktree or branch is gone: the review only offers « Abandonner » |

### ChangedFile

| Field | Type | Rule |
|-------|------|------|
| `path` | string | |
| `oldPath` | `string \| null` | set only when the file was renamed |
| `status` | `'added' \| 'modified' \| 'deleted' \| 'renamed'` | |
| `added`, `removed` | `int \| null` | `null` for binary files |
| `binary` | boolean | |
| `tooLarge` | boolean | over 1 MB or 5 000 diff lines (R2) |
| `eolOnly` | boolean | differs only by line endings: « fins de ligne seulement » (R2) |
| `blob` | blob id \| null | the agent's side, `null` when deleted. Compared with `review.seen[path]` |

### FileDiff

| Field | Type | Rule |
|-------|------|------|
| `path` | string | |
| `hunks` | `DiffHunk[]` | empty when `binary` or `tooLarge` |
| `size` | int | in bytes, shown when there is no line diff |

`DiffHunk` is `{ oldStart, newStart, lines: { kind: 'context' \| 'add' \| 'del', oldNo, newNo,
text }[] }`. It is produced by `parseUnifiedDiff` in `src/shared/diff.ts`, a pure function.

### TestRun

| Field | Type | Rule |
|-------|------|------|
| `agentId` | uuid | |
| `command` | string | |
| `tree` | tree id | the snapshot it ran on; it is `stale` once `tree` differs from the current snapshot |
| `status` | `'running' \| 'passed' \| 'failed' \| 'cancelled' \| 'timeout'` | |
| `passedCount` | `int \| null` | read from the summary when there is one (R8) |
| `outputTail` | string | the last 200 lines |

The Décision column shows one of these: « Tests : non configurés » (no command), « non lancés »,
« en cours », « N réussis » / « réussis », or « en échec ».

### Integration

| Field | Type | Rule |
|-------|------|------|
| `id` | uuid | |
| `agentId` | uuid | |
| `mode` | `'squash' \| 'keep-commits'` | defaults to `squash` (FR-019) |
| `message` | string, at least 1 character | proposed from the agent's prompt, otherwise from its branch |
| `after` | `{ closeTile: boolean, removeWorktree: boolean }` | both `true` by default (FR-024) |
| `snapshot` | commit id | snapshot commit taken on the click (R1) |
| `mainAtStart` | commit id | `main` when the integration started |
| `state` | see below | |
| `conflicts` | `ConflictFile[]` | |
| `error` | `string \| null` | git's message as it came (FR-023) |

**Integration states**:

```text
checking ──clean──────────────▶ committing ──ok──▶ integrated
   │                               │  └─refused (local changes, FR-021)─▶ blocked
   └─conflicts─▶ conflicted ──all resolved + Terminer──▶ committing
                    │  └─Demander à l'agent─▶ waiting-agent ──agent turn ends──▶ checking
                    └─Annuler────────────────────────────────────────────────▶ cancelled
committing ──git error──▶ failed          (main unchanged in every state except integrated)
```

### ConflictFile

| Field | Type | Rule |
|-------|------|------|
| `path` | string | |
| `kind` | `'content' \| 'delete-modify' \| 'add-add'` | the last two offer only « Garder main » or « Garder cette version » |
| `mainCommit` | `{ short, subject }` | the last commit on `main` that touched the file (R4) |
| `hunks` | `ConflictHunk[]` | `{ index, line, main: string[], agent: string[], resolution: null \| 'main' \| 'agent' \| 'both' }` |
| `edited` | `string \| null` | the whole content, set by « Modifier… » or the external editor |
| `resolved` | boolean | true when every hunk has a resolution, or when `edited` has no conflict markers left |

« Terminer l'intégration » is enabled only when every `ConflictFile.resolved` is true (FR-030).

## Derived (never stored)

- **To review (badge and « Revue → »)**: the agent's state is `done` or `awaiting-prompt`, its
  snapshot has at least one file, and it has not been integrated or abandoned since. The badge is
  the number of such agents (FR-002, FR-003).
- **Seen count**: the number of files whose `blob` equals `review.seen[path]` (FR-006).
- **Untreated comments**: the comments with `treated === false`. This is the N in « Corriger les
  commentaires · N » (FR-013).
