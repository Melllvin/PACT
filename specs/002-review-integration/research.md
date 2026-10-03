# Research: Revue et intégration

Builds on `specs/001-agent-workspace-core/research.md`. The stack, git ≥ 2.40 through `execFile`
(R7), JSON + zod persistence (R9), the IPC rules (R11), the tests and CI (R12), the fake CLI (R13)
and the appearance (R17) do not change. R1 and R4 were checked with a probe on git 2.43; the
other git steps are standard commands, to be pinned by the integration tests.

## R1. Snapshot of an agent's changes

- **Decision**: a review compares two git trees.
  - **Base**: `git merge-base <main> HEAD`, run in the agent's worktree.
  - **Snapshot**: a tree of the worktree as it is on disk. To build it, copy the worktree's index
    into a temporary file, then run `GIT_INDEX_FILE=<tmp> git add -A` and `git write-tree`. Its id
    identifies « l'état actuel des changements » (FR-017) and keys test results.
  - **Snapshot commit**: `git commit-tree <tree> -p HEAD` wraps the snapshot in a commit. The
    commit is unreferenced and later pruned by git; integration and the conflict check use it.
  - **Cost**: copying the index keeps git's stat cache, so `add -A` only hashes changed files.
- **Rationale**:
  - The snapshot covers committed, uncommitted and untracked work while honouring `.gitignore`
    (FR-005), in one tree.
  - The agent's real index and files are never touched; the probe showed `git status` unchanged
    after a snapshot.
  - Everything later works on immutable objects, so the main branch moves only at the very end.
- **Alternatives**:
  - `git diff <base>` plus `git ls-files --others`: two sources to merge, and no single id for the
    state.
  - `git stash create`: leaves out untracked files unless `-u`, and `-u` touches the worktree.

## R2. File list and diff

- **Decision**:
  - **List**: `git diff --numstat -z -M <base> <tree>` for counts and renames.
  - **Types**: `git diff --name-status -z -M` for the change types, and `git diff --raw` for the
    blob ids of each side. « Vu » is stored against the new blob id, so a file whose content
    changes becomes unseen again (FR-009).
  - **One file**: `git diff --no-color -U3 <base> <tree> -- <path>`, parsed into hunks by a pure
    function in `src/shared/diff.ts`, which is tested on its own.
  - **Binary files**: `-\t-` in numstat; shown with a type and a size (`git cat-file -s`), no diff.
  - **Large files**: a file over 1 MB or 5 000 diff lines is shown the same way, without a diff
    (FR-008).
  - **Line endings**:
    - the diff uses `--ignore-cr-at-eol`, so CRLF/LF differences between macOS and Windows do not
      show a whole file as changed (FR-033);
    - the list does not use it: a file that differs only by its line endings stays listed, with
      0 lines added and removed and the note « fins de ligne seulement ». The review hides nothing
      that integration would carry into `main`;
    - an integration test checks a CRLF-only change.
    The content that gets integrated is the snapshot, byte for byte.
  - **Encoding**: every git call runs with `LC_ALL=C` and `core.quotePath=false`, so messages are
    not translated (the probe showed French ones) and accented paths come back as UTF-8.
- **Rationale**: git already computes renames, binaries and stats. Parsing the unified diff is the
  only new logic, and it is pure.
- **Alternatives**: the `diff` npm package (a new dependency, and git computes the same thing);
  diffing on the renderer side (that process cannot read files).

## R3. Following the worktree

- **Decision**:
  - **Watching**: `fs.watch(worktree, { recursive: true })`, supported on macOS and Windows,
    ignoring `.git/`. Event bursts are grouped into one snapshot after 300 ms.
  - **Safety net**: a fresh snapshot every 5 s while a review is open, the same pattern as the
    folder watch in `WorkspaceService` (T121).
  - **Events**: a new tree id sends `review:changed` to the renderer.
  - **Scope**: worktrees are watched only while their review is open, or while their agent works
    and has the « Revue → » button pending.
- **Rationale**: SC-006 (a change visible in under 3 s) without polling git every second.
- **Alternatives**: `chokidar` (a dependency, and `fs.watch` recursive covers both platforms);
  polling only (meets SC-006 only at a high CPU cost).

## R4. Conflict check without changing anything

- **Decision**:
  - **Check**: `git merge-tree --write-tree -z <main> <snapshot commit>`, available since git 2.38.
    Exit 0 means clean. Exit 1 means conflicts, which are listed as stage lines (mode, oid,
    stage 1/2/3, path) and returned with a tree whose conflicted files hold the markers.
  - **When it runs**: when the review opens, when the snapshot changes, and when `main` moves.
    `main` is watched through its ref (`git rev-parse <main>`), checked on the same timer.
  - **Commit that introduced a conflict**: shown as « main · « Ajout SSO » a41f2 », taken from
    `git log -1 --format=%h%x00%s <base>..<main> -- <path>`.
- **Rationale**: FR-018 and FR-027. The main branch, its working folder and the agent's worktree
  are never touched, because merge-tree writes objects only.
- **Alternatives**: `git merge --no-commit` in a temporary worktree (slower, and it needs cleaning
  up); `git apply --check` (misses three-way merges).

## R5. Integration

- **Decision**: compute the result from objects, make the final commit with a real `git commit`
  so the repository's hooks run (user decision of 2026-10-03), and move the branch once.
  - **Result tree**: the merge-tree tree of R4 (or the resolved tree of R6). When `main` has not
    moved since the agent's base, this is simply the snapshot tree.
  - **Commit with hooks**: in a temporary detached worktree on `main`
    (`git worktree add --detach <userData>/integrations/<id> <main>`), run `git read-tree -m -u
    <result tree>`, then `git commit -F <message file>`. `pre-commit` and `commit-msg` run as
    usual, so a hook that refuses (or rewrites the message) is honoured. The temporary worktree is
    removed whatever happens.
  - **Squash** (default): the commit above has the single parent `main`.
  - **Keep commits**: if the agent has uncommitted changes, they become a commit on top of its
    `HEAD` first, made the same way in a temporary worktree so hooks run. Then:
    - when `main` is an ancestor of the result, `main` fast-forwards to it;
    - otherwise the temporary worktree runs `git merge --no-ff <that commit>` (hooks run here
      too), using the resolutions of R6 when there were conflicts.

    The agent's existing commits keep their messages and are not re-checked by the hooks (FR-019).
  - **Moving `main`**: depends on whether it is checked out (`git worktree list --porcelain`).
    - **Checked out somewhere**: `git merge --ff-only <commit>` runs in that folder. Git updates
      the files and refuses, before writing anything, if local changes would be overwritten. That
      refusal is FR-021; the file list comes from the error, read with `LC_ALL=C`.
    - **Not checked out**: `git update-ref refs/heads/<main> <new> <old>`, an atomic compare: if
      `main` moved in between, nothing is written and the check is redone (FR-022).
  - **Failure**: a refusing hook, a full disk or a git error all happen before the branch moves.
    Nothing is rolled back because nothing was written to `main`; the temporary worktree is
    removed and git's output is shown (FR-023).
  - **Queue**: one per workspace, the same promise chain as `AgentManager.queue` (FR-026).
  - **Agent closed after integration** (both boxes ticked): `GitService.removeWorktree` is called
    with `force: true`. Its uncommitted changes are already in `main`, and without `force` git
    refuses (FR-024).
  - **Agent kept** (« Conserver le worktree », US2/AC4): the worktree moves onto the new `main`
    with `git reset --hard <new>`, when its tree is unchanged since the snapshot. Nothing is lost:
    the snapshot is inside the new commit, and `--keep` would refuse the very files just
    integrated.
    - If the agent wrote since then, its later edits are carried over with a three-way merge
      (base snapshot, ours new `main`, theirs current tree, via `merge-tree --merge-base`),
      applied with `read-tree -m -u`.
    - If that merge conflicts, the worktree is left as it is and the review says so.
- **Rationale**:
  - SC-003 (100 % of failed or cancelled integrations leave `main` and its folder as they were):
    no step before the last one touches a ref or a file.
  - Git's own `--ff-only` refusal provides the « changements locaux » check exactly, instead of
    re-implementing it.
- **Alternatives**:
  - `git merge --squash` in the main repository: touches the user's index and files before the
    result is known.
  - `commit-tree` alone: faster, but skips `pre-commit` / `commit-msg`, which the user rejected.
  - Cherry-picking commit by commit: conflicts would happen commit by commit.

## R6. Resolving conflicts in PACT

- **Decision**:
  - **Content**: each conflicted file is read from the merge-tree result tree, and its markers
    are parsed into hunks by a pure function. Each hunk keeps the main side and the agent side.
  - **Resolving a hunk**: « Garder main », « Garder cette version » or « Les deux » rewrites that
    hunk.
  - **« Modifier… »**: edits the whole file in a monospace `<textarea>`.
  - **« Ouvrir dans l'éditeur ▾ »**: writes a copy to `userData/conflicts/<integrationId>/<path>`,
    opens it with `shell.openPath` or the editor set in git's `core.editor`, and watches it.
  - **Resolved**: a file counts as resolved once it has no `<<<<<<<` / `>>>>>>>` markers left.
  - **Applying the resolutions**: `git hash-object -w` for each resolved file, then a temporary
    index (`read-tree <merged tree>`, `update-index --cacheinfo`, `write-tree`) gives the final
    tree, and integration continues as in R5.
  - **Delete/modify and add/add conflicts**: offer only « Garder main » or « Garder cette version ».
- **Rationale**: FR-029 to FR-031. Cancelling means discarding objects and the `conflicts/`
  folder: the agent's worktree was never modified.
- **Alternatives**: CodeMirror or Monaco for « Modifier… » (heavy dependencies for an occasional
  fallback, and the editor button already covers advanced cases).

## R7. Instructions sent to the agent

- **Decision**:
  - **When**: comments, shortcuts, « Renvoyer à l'agent » and « Demander à l'agent » reuse the
    `retype` mechanism of `AgentManager`. The agent is « prêt » in `awaiting-prompt` or `done`.
    A finished turn (`turn-finished`) leads to `done`, and reviews happen precisely then.
    - Text is written at once when the agent is ready.
    - Otherwise it waits for the next transition to a ready state.
    - It is never written during `awaiting-answer`, `working` or `starting`, so it cannot answer a
      question (FR-014).
  - **Queue**: becomes a per-agent FIFO, replacing the single entry of « Relancer ».
    - One item is written per ready transition. The next item waits for the agent to be ready
      again after the turn that one started.
    - The first red tests cover: immediate write when already ready, nothing written during
      `awaiting-answer`, and N items written one per turn, never all at once.
  - **How**: multi-line text is sent as a bracketed paste (`ESC[200~ … ESC[201~`) followed by
    `\r`. Claude Code and Codex accept it; the fake CLI gets a scenario to check it.
  - **Formats**, built by a pure function in `src/shared/review-prompts.ts`:
    - comment: `Commentaire sur <path>:<line> — <text>`;
    - « Corriger les commentaires · N »: one list of every untreated comment;
    - « Tests en échec »: the command plus the last 40 lines of output;
    - « Conflit avec main »: the conflicting files plus a request to update from `main`, resolve
      and run the tests again.
  - **Treated comments**: a comment is marked treated once it has been sent as part of « Corriger
    les commentaires ».
- **Rationale**: one way to type into a CLI, already tested, which also covers « Relancer ».
- **Alternatives**: writing straight away (would answer a pending question); typing character by
  character (slow, and does not protect line breaks).

## R8. Tests in the agent's worktree

- **Decision**:
  - **Command**: `testCommand` of the workspace, `null` meaning « détecter ». Detection reads
    `package.json`: a `test` script that is not npm's placeholder gives `npm test`, or `pnpm test`
    / `yarn test` depending on the lockfile. Other ecosystems are typed by the user.
  - **Run**: the login shell from R3 of 001 (`sh -lc` / `cmd /d /s /c`), in the worktree, with
    the agent's `PORT`. No PTY: output is captured, the last 200 lines kept, timeout 10 min, can
    be cancelled.
  - **When**: when the review opens if no result matches the snapshot tree id, and on request.
    One run at a time per agent; a new snapshot during a run marks its result as « ancien ».
  - **Status**: the exit code decides passed or failed. The count (« 24 réussis ») is read from
    common summaries (Vitest/Jest `Tests N passed`, pytest `N passed`, `cargo test`
    `test result: ok. N passed`), otherwise left out.
- **Rationale**: user's answer (clarification of 2026-10-03), and FR-016 / FR-017.
- **Alternatives**: running the tests in a PTY tile (pollutes the grid); reading tests from the
  agent's output (fragile, rejected by the user).

## R9. Persistence

- **Decision**: no new file. The per-workspace JSON (R9 of 001) gains these fields, all with zod
  defaults so files from 001 still load without a migration (`SCHEMA_VERSION` stays at 1):
  - on each agent, `review: { seen: Record<path, blobId>, comments: Comment[] }`;
  - on the workspace, `testCommand: string | null`.

  Test results and integrations in progress are not saved: a restart runs the tests again and
  cancels any unfinished integration, which is safe because nothing was written (R5).
- **Rationale**: FR-011, YAGNI.

## R10. Screens

- **Decision**:
  - **Onglet Changements** in `FocusView` (`src/renderer/review/`): file list on the left, diff in
    the centre, the agent's terminal underneath. The terminal reuses the agent's existing xterm
    through `terminal-registry` (the same instance as the tile).
  - **Colonne Décision** replaces `TodoColumn` in the same place while the tab is open (FR-004).
  - **Vue Revue**: the Toolbar button is enabled with a badge. It opens the Focus on the first
    agent that has changes, using the existing pills.
  - **Components**: existing shadcn primitives (Tabs, Checkbox, Button, Dialog, Badge, Tooltip,
    ToggleGroup) plus a DropdownMenu for « Squash en 1 commit ▾ » and « Ouvrir dans l'éditeur ▾ »,
    added through the shadcn CLI as in R16 of 001.
  - **Diff view**: virtualised by hand (fixed line height, only visible lines rendered), because a
    5 000-line file must stay smooth. No new dependency.
- **Rationale**: screens 1h and 1q; reuse (Constitution IV).
- **Alternatives**: `react-diff-view` or `diff2html` (a dependency plus a theme to override, for a
  plain two-colour view).

## R11. Fake CLI and test repositories

- **Decision**:
  - **Fake CLI**: new scenario steps write, delete and rename files in its cwd (the worktree) and
    commit, so the e2e tests can produce real changes.
  - **Integration tests**: run on temporary git repositories, as for 001, including a branch that
    has moved, conflicting changes and paths with spaces and accents on both platforms.
- **Rationale**: Constitution I (each story testable before it is implemented).
