# PACT

Parallel Agents Control Terminal — an Electron workspace to run several coding-agent CLIs in
parallel, each in its own Git worktree, while keeping direct access to their terminals.

## Requirements

- macOS 13+ or Windows 10 (1809+) / 11
- Node.js 22.12+ and npm 10+, Git 2.40+
- Native build tools for `node-pty`: Xcode Command Line Tools (macOS) or Visual Studio Build
  Tools with the "Desktop development with C++" workload (Windows)

## Development

```sh
npm ci             # installs dependencies and rebuilds node-pty for Electron
npm run dev        # starts the app with hot reload
npm run check      # typecheck, lint, format check, unit/integration tests and coverage
npm run test:e2e   # builds the app and runs the Playwright end-to-end suite
```

Specifications live in `specs/`, and the project rules in `.specify/memory/constitution.md`.
