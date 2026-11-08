import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_GH, INJECTION } from '../../fixtures/fake-cli/paths';
import { callTool, createHarness, type Harness } from './harness';

// 007 T061 — witness test: text a third party wrote never reaches PACT's own messages (FR-026,
// US3 scenarios 8 and 9, SC-009). The fake gh fails `issue create` with INJECTION on its first
// stderr line, as a forge error quoting a hostile PR would. Only the fake script runs: no real gh,
// no network.

const run = promisify(execFile);

let h: Harness;
let token: string;
let orchestrator: string;

const READY = `# Connexion

## Critères d’acceptation
- Given un compte, When il se connecte, Then il est connecté.

## Questions ouvertes
`;

beforeEach(async () => {
  h = await createHarness();
  const register = h.hooks.registerMcp.bind(h.hooks);
  vi.spyOn(h.hooks, 'registerMcp').mockImplementation((id, handler) => {
    token ||= register(id, handler);
    return token;
  });
  token = '';
  const [lead] = await h.launch([h.draft({ orchestrator: true })]);
  orchestrator = lead?.id ?? '';
  const dir = join(lead?.worktreePath ?? '', '.pact', 'issues');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '0001-connexion.md'), READY);
  // The fake gh is the only `gh`: it answers `repo view`, then fails `issue create` with the text.
  h.gh.answer = async (args) => {
    try {
      const { stdout } = await run(process.execPath, [FAKE_GH, ...args], {
        env: {
          PATH: process.env.PATH,
          FAKE_GH_REMOTE: 'https://github.com/pact/test',
          FAKE_GH_INJECT: INJECTION,
        },
      });
      return stdout;
    } catch (error) {
      throw Object.assign(new Error('exit 1'), error);
    }
  };
}, 30_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await h.dispose();
});

const tool = (name: string, args: Record<string, unknown> = {}) =>
  callTool(h.hooks.mcpUrl(), token, name, args);

/** The user confirms a publication that the forge refuses with third-party text. */
const failPublication = async () => {
  await tool('register_issue', { path: '0001-connexion.md' });
  const { requestId } = (await tool('publish_issues', { ids: ['0001-connexion'] })).json as {
    requestId: string;
  };
  await h.issues.confirm(requestId);
};

describe('third-party content (FR-026, SC-009)', () => {
  it('Given a forge error quoting a third party, When the orchestrator reads get_events, Then the text is not there (US3 sc.8)', async () => {
    await failPublication();
    const events = await tool('get_events');
    expect(events.text + JSON.stringify(events.json)).not.toContain(INJECTION);
    expect(JSON.stringify(events.json)).toContain('Publication arrêtée');
  });

  it('Given the same error, When the orchestrator waits with wait_for_agents, Then the text is not there (US3 sc.8)', async () => {
    await failPublication();
    const waited = await tool('wait_for_agents', { timeoutSeconds: 1 });
    expect(waited.text + JSON.stringify(waited.json)).not.toContain(INJECTION);
  });

  it('Given the same error, When the journal and the notices are read, Then the text is in none (FR-026)', async () => {
    await failPublication();
    expect(JSON.stringify(h.journal())).not.toContain(INJECTION);
    expect(JSON.stringify(h.reports)).not.toContain(INJECTION);
  });

  it('Given the same error, When the wake types its pointer, Then the line carries no third-party text (US3 sc.8)', async () => {
    await failPublication();
    h.wake?.deliver(orchestrator);
    expect(h.pty.history(orchestrator)).not.toContain(INJECTION);
    expect(JSON.stringify(h.typed)).not.toContain(INJECTION);
  });
});
