# PACT

PACT is a focused Electron workspace for running several coding-agent CLIs in isolated Git worktrees while retaining direct access to their terminals.

## Requirements

Node.js 22+, npm 10+, Git 2.40+, and native build tools for `node-pty` (Xcode Command Line Tools on macOS or Visual Studio Desktop C++ tools on Windows).

```sh
npm ci
npm run dev
npm run check
npm run test:e2e
```

PACT detects Claude Code and Codex from the login-shell environment. Codex users must approve the local PACT hook commands when prompted; PACT never bypasses hook trust or grants danger-full-access.
