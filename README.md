# PACT

Parallel Agents Control Terminal — an Electron workspace to run several coding-agent CLIs in
parallel, each in its own Git worktree, while keeping direct access to their terminals.

- Open, create or clone a repository; launch up to 6 agents (Claude Code, Codex, or any other CLI
  you add), each on its own branch, worktree and port.
- Every agent keeps a real terminal. The « À faire » column lists what needs you: a prompt to
  give, a permission to grant, a crash, a rate limit (with optional automatic resume).
- Workspaces and agents come back after a restart; quitting while agents run asks first.
- Review each agent's work (« Revue → » or the Revue view): its changes against `main`, committed
  or not, file by file, with the files you have seen. Comment a line and the comment is typed
  into the agent's prompt; shortcuts send « Corriger les commentaires », « Tests en échec » or
  « Conflit avec main ». Nothing is typed while the agent works or waits for an answer.
- Integrate into the local `main` in one squashed commit (or keeping the agent's commits), then
  close the tile and remove the worktree, or keep them. Nothing is ever pushed.
- On a conflict with `main`, ask the agent to resolve it in its worktree, or resolve each
  conflict in PACT (keep `main`, keep the agent's version, both, or edit the file, in PACT or in
  your editor). `main` only moves once everything is resolved; cancelling leaves it untouched.

## Review and integration

- **Tests.** The Décision column runs the repository's tests in the agent's worktree, with the
  agent's `PORT`, when a review opens and on request. The command is detected from
  `package.json` (`npm test`, `pnpm test` or `yarn test`); otherwise type one in the column, it is
  kept for the workspace. Failing tests do not block an integration: you decide.
- **Git hooks.** The integration commit is a real `git commit`, made in a temporary worktree, so
  the repository's `pre-commit` and `commit-msg` hooks run. A hook that refuses fails the
  integration and `main` stays as it was; its message is shown as git gave it.
- **Local changes.** If the folder where `main` is checked out has uncommitted changes to files
  the integration touches, it is refused before anything changes, with the list of those files.
  If `main` is not checked out anywhere, only the branch moves.
- **Comments** stay in PACT (they are saved with the workspace), never in the repository.
- **The external editor** is the application your system associates with the file. PACT edits a
  copy and reads it back when it is saved; the copies are removed when the integration ends.

## Requirements

- macOS 13+ or Windows 10 (1809+) / 11
- Node.js 22.12+ and npm 10+, Git 2.40+
- Native build tools for `node-pty`: Xcode Command Line Tools (macOS) or Visual Studio Build
  Tools with the "Desktop development with C++" workload (Windows)
- To drive real agents: Claude Code 2.1+ and/or a recent Codex (with the `hooks` feature; 0.39 is
  too old — `npm i -g @openai/codex@latest`), both signed in

## Development

```sh
npm ci             # installs dependencies and rebuilds node-pty for Electron
npm run dev        # starts the app with hot reload
npm run check      # typecheck, lint, format check, unit/integration tests and coverage
npm run test:e2e   # builds the app and runs the Playwright end-to-end suite
```

The e2e suite drives a fake CLI (`tests/fixtures/fake-cli/`) that replays JSON scenarios, so no
real agent or account is needed. CI runs `check` and `e2e` on macOS and Windows.

## Approving the PACT hooks in Codex

PACT follows each Codex agent through hooks that relay its events to a local server bound to
`127.0.0.1`, with a secret token per agent. Codex only runs hooks the user has trusted, and PACT
never bypasses that check. On the first Codex launch, Codex shows « Hooks need review »: PACT
lists it in « À faire », and you answer in the agent's terminal — `2. Trust all and continue`
records the trust in `~/.codex/config.toml`, and it stays until PACT's hook command changes (for
example after PACT moves). Choosing to continue without trusting still works, with less precise
states (process exit and output heuristics).

Claude Code needs no approval: PACT passes its hooks as session settings.

## Project docs

Specifications live in `specs/` (the security review is in
`specs/001-agent-workspace-core/security-review.md`), and the project rules in
`.specify/memory/constitution.md`.
