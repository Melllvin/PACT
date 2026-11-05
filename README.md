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

## Install

Download the installer of the latest version from
[GitHub Releases](https://github.com/Melllvin/PACT/releases): `PACT-<version>-mac-universal.dmg`
for macOS 13+ (Intel and Apple Silicon), `PACT-<version>-win-x64.exe` or `-win-arm64.exe` for
Windows 10 (1809+) / 11. PACT needs Git 2.40+ on the machine, and the agent CLIs you want to run.

The V1 installers are not signed with an Apple or Microsoft certificate, so the system warns once:

- **macOS**: drag PACT to Applications, then open it with right click → Ouvrir (or System
  Settings → Privacy & Security → « Open Anyway »). If macOS says the app is damaged, run
  `xattr -dr com.apple.quarantine /Applications/PACT.app` once.
- **Windows**: SmartScreen shows « Windows protected your PC »: More info → Run anyway. The
  installer installs for the current user, without administrator rights.

## Requirements (development)

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

## Orchestrator

Tick « Orchestrateur » when launching a Claude Code or Codex agent and it leads the others of the
workspace. Its tile is always the largest, so its reports stay easy to read. PACT gives it a `pact`
MCP server and the `pact-orchestrator` skill, for this session only; your own Claude Code and Codex
configurations are never touched.

- **Tools.** `list_agents`, `get_changes`, `get_file_diff`, `run_tests`, `send_prompt` (a prompt
  waits in a queue while the agent works or waits for an answer, and is marked « ◎ » in its
  terminal), `wait_for_agents` (ends of turns, questions, errors, test results), `launch_agent`
  and `close_agent` (the worktree and the branch are kept), and `request_integration`.
- **Integrations are yours.** `request_integration` only puts « ◎ Intégrer <agent> → main ? » in
  « À faire », with the commit message the orchestrator proposed; you edit it, integrate or refuse,
  and the orchestrator hears the outcome (the commit, the conflicting files, or why it failed).
  Nothing is integrated, pushed or opened as a PR without you.
- **Access.** The server listens on `127.0.0.1` only, with a token per orchestrator session,
  separate from the hooks' token and compared in constant time. Requests with another `Host` or any
  `Origin` are refused, so a web page cannot reach it. Tools take agent names and repository
  paths, never absolute paths or commands, and only act on the agents of the same workspace.
- **Control.** The orchestrator's Focus has a « ◎ Actions » tab: what it did (prompts, launches,
  closings, integration requests), the latest first, with what PACT refused and why. « Retirer le
  rôle d’orchestrateur » revokes its token at once, cancels the prompts it queued, and leaves the
  agent open as an ordinary one.

## Delivery chain

The orchestrator can carry a feature from the idea to a reviewed branch: it frames it with you,
then hands it to agents with a role, each started with the skills of its role.

- **Roles and profiles.** `spec`, `design`, `dev`, `test` and `recap`. Each role has a profile in
  the settings (CLI, model, effort, and a model ceiling the orchestrator cannot exceed), so the
  cheaper models can do the development while a stronger one leads. Choose a role in the detailed
  launcher, or let the orchestrator launch the agent with `launch_agent`.
- **Issues.** `register_issue` writes an issue in `.pact/issues/`, with its acceptance criteria;
  `publish_issues` only asks « ◎ Créer N issues ? » in « À faire »: nothing reaches GitHub without
  you.
- **Test and dev loop.** `start_loop` on a ready issue: the test agent writes the acceptance tests,
  the dev agent makes them pass, and PACT runs the tests itself between rounds (`next_round`,
  `submit_report`, `get_loop`). Three rounds at most; then the decision is yours (« ✕ Boucle
  arrêtée »).
- **Aperçu.** The Focus of an agent shows its mockups (`design/mockups/`), issues and recap,
  rendered in isolation with no network access, and refreshed within 2 s. « ✓ Valider » or a
  comment on a mockup goes back to the orchestrator.
- **Recap.** `.pact/recap.md` lists each issue with its agents and models, branch and PR, rounds,
  the PACT test run, and what is left to test by hand; it opens first in the orchestrator's Aperçu.
- **Skills on every CLI.** The `pact-*` skills and their common contract are copied per agent
  under PACT's data folder: a session plugin for Claude Code, `developer_instructions` and the
  `pact` MCP server for Codex, and for any other CLI a `.pact/ROLE.md` in its worktree, kept out of
  Git, which PACT asks it to read first.

## Usage limits

The bar of each workspace shows a gauge per CLI account its agents use: « Claude Code 62 % · 5 h »,
the window used the most, with every window, its reset time and the time of the reading on hover
or click. Nothing extra is asked of the CLI and you never log in again:

- **Claude Code** reports its limits through the `statusLine` PACT hands each agent in its session
  settings; your own `statusLine`, if you have one, still runs and shows under PACT's line.
- **Codex** writes them in the rollout of its session, which PACT reads.
- **Other CLIs**, and Claude Code with an API key, report none: no gauge.

A reading older than 15 minutes is greyed out with its age, and hidden after an hour.

- **Alerts.** At 80 % the gauge turns orange, at 95 % red (« Seuils d’alerte… » in its detail), and
  « À faire » holds one « ◆ Limite … » per account, with « Détail ». Launching agents of a CLI near
  its limit warns in the launcher, and `launch_agent` tells the orchestrator, without refusing.
- **Who consumes.** The detail gives the part of each agent of the workspace in the tokens PACT
  counted since the window began, the largest first, with its role; a closed agent keeps its part,
  marked « fermé », until the window resets; the agents of other workspaces are « autres ».
- **Resume.** A rate limit whose message gives no time resumes at the reset the gauge knows.

## Agent teams in Claude Code

PACT starts every Claude Code agent with
[agent teams](https://code.claude.com/docs/en/agent-teams) enabled
(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, passed in its session settings), so you can ask an
agent to work as a team lead. Teammates run in-process, in the agent's own terminal: select one
with ↑/↓ in the agents panel under the prompt, Enter to view it, `x` to stop it, Ctrl+T for the
task list. They share the agent's worktree, so its review and integration hold the whole team's
work. The tile follows the lead: a teammate finishing does not mark the agent done, but a
question a teammate asks shows in « À faire » like any other.

## Project docs

Specifications live in `specs/` (the security review is in
`specs/001-agent-workspace-core/security-review.md`), and the project rules in
`.specify/memory/constitution.md`.

## Publishing a release

1. Set the version in `package.json` (`npm version 1.0.1 --no-git-tag-version`), merge it into
   `main`, then tag it: `git tag v1.0.1 && git push origin v1.0.1`.
2. That is all. The tag runs `.github/workflows/release.yml`, which refuses a tag that is not
   `v` + the version of `package.json` or whose commit is not on `main`, builds the universal macOS `.dmg` and the Windows
   installers on their own runners, adds them to a draft release named after the tag, and
   publishes it as soon as the `.dmg` is there. If the Windows build fails, the run turns red and
   the release is published without the Windows installers; if the macOS build fails, the draft
   stays unpublished, with what was built. Nothing visible is ever published without the `.dmg`.
3. Edit the notes on the release afterwards if you want to; they are generated from the commits.

The `.dmg` is signed ad hoc and not notarized: macOS blocks the first launch of the downloaded
app. Open it with right click, then Open, or run `xattr -dr com.apple.quarantine /Applications/PACT.app`.

- **Build without publishing**: `npm run dist` builds the same installers into `dist/` for the
  current OS. In Actions, "Run workflow" on `release.yml` does the same and keeps the installers as
  run artifacts (7 days): no release, not even a draft.
- **Pull requests**: a change to `package.json`, the lockfile, `electron-builder.json` or the
  workflows also builds the universal macOS app in CI (`mac-build`) and checks that node-pty is
  universal and opens a pty, so a packaging break shows before the tag. The release workflow
  never runs on a pull request.
