# Quickstart: Revue et intégration

Validation guide for 002. The setup and commands are the same as in
`specs/001-agent-workspace-core/quickstart.md`.

## Prerequisites

- Node 22, git ≥ 2.40, `npm ci`.
- macOS and Windows: every scenario below runs on both (SC-007).

## Automated

```bash
npm run check      # types, lint, format, unit + integration (real git repositories), coverage
npm run test:e2e   # Playwright Electron, with the fake CLI
```

Integration suites to expect (they run on temporary repositories, R11):

| Area | What it proves |
|------|----------------|
| Snapshot (R1) | committed, uncommitted, untracked and renamed files are all in the review; ignored files are not; the agent's index and files are untouched |
| Diff (R2) | binary and large files are flagged; CRLF/LF alone changes nothing; accented paths and paths with spaces work |
| Conflicts (R4) | the check leaves `main`, its folder and the worktree byte-for-byte unchanged |
| Integration (R5) | squash gives one commit; keep-commits keeps the agent's commits; local changes on touched files block with the list; failure and cancel leave `main` unchanged (SC-003); two integrations run one after the other |
| Resolution (R6) | each choice gives the expected content; markers left mean not resolved; cancel leaves everything as it was |
| Prompts (R7) | nothing is typed while the agent is `awaiting-answer`; it is typed at `awaiting-prompt` |
| Tests (R8) | detection from `package.json`; passed and failed by exit code; the count is read; timeout and cancel work; the result goes stale when the snapshot changes |

The e2e tests follow the user stories with the fake CLI, which writes and commits files:

1. **US1:** « Revue → » opens Changements. The file list and totals are right. « vu » counts, and
   a later edit by the agent shows « Nouveaux changements ».
2. **US2:** « ✓ Intégrer » in squash makes one commit on `main`. The tile closes and the worktree
   is removed. The « ✓ Intégré » notice shows.
3. **US3:** a comment arrives in the fake CLI's prompt with its file and line, as do the
   shortcuts.
4. **US4:** a conflicting `main` opens the conflict screen. Resolving by hand and finishing gives
   the expected commit, and « Annuler » changes nothing.
5. **US5:** the Revue badge counts 2, the pills switch between the two agents, and « Abandonner »
   leaves `main` unchanged.

## Manual (with real CLIs)

1. Open a Node repository that has a `test` script. Launch a Claude Code agent: « ajoute une
   fonction et son test, sans commiter ».
2. When it finishes, click « Revue → ». Expect « Tests : N réussis », and the new files in the
   list.
3. Comment on a line. Claude Code receives « Commentaire sur <fichier>:<ligne> — … » and fixes it.
   The review updates by itself in under 3 s.
4. Commit a change on `main` that touches the same line, then click « Intégrer ». The conflict
   screen opens. Click « Demander à l'agent »; the agent updates its branch and resolves. Click
   « Intégrer » again: one commit on `main`.
5. Repeat with Codex on Windows, in a repository whose path has spaces and accents.

The integration commit runs the repository's `pre-commit` and `commit-msg` hooks (R5). To check
it, add a `pre-commit` hook that exits 1 and click « Intégrer »: the integration fails with the
hook's output, and `main` does not move.
