import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from '../../../src/main/agents/adapters/fake';
import { AgentManager, type AgentStateEvent } from '../../../src/main/agents/agent-manager';
import { CliRegistry } from '../../../src/main/agents/cli-registry';
import { HookServer } from '../../../src/main/agents/hook-server';
import { GitService } from '../../../src/main/git/git-service';
import { openStores, type Stores } from '../../../src/main/persistence/store';
import { PtyManager } from '../../../src/main/pty/pty-manager';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import type { AgentState, Workspace } from '../../../src/shared/model';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

// fix-send-prompt — a prompt PACT sends must be SUBMITTED, not left typed in the invite.
//
// Real Claude Code swallows an Enter that arrives in the same chunk as the end of a paste. So:
//   - the text and its Enter are two distinct PTY writes, the Enter after `submitDelayMs`;
//   - no passage to « working » within `submitTimeoutMs` of the Enter ⇒ PACT sends Enter ONCE more;
//   - still nothing within another `submitTimeoutMs` ⇒ the prompt is « non livré »:
//     `AgentManager.undeliveredPrompts(id, origin): number` counts it, `list_agents` exposes it as
//     `undeliveredPrompts` (see tools-prompt.test.ts), `promptTyped` is lifted and the queue goes on.
//   - a prompt submitted in time (state leaves ready) gets no second Enter, no resend.
// Options of AgentManager the dev must add: `submitDelayMs` and `submitTimeoutMs` (ms; any
// positive values, production defaults are the dev's choice). Real timers, small values: the
// agent is a real PTY child, which fake timers cannot drive.

const DELAY = 150;
const TIMEOUT = 400;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

let root: string;
let stores: Stores;
let workspaces: WorkspaceService;
let workspace: Workspace;
let pty: PtyManager;
let hooks: HookServer;
let manager: AgentManager;
let events: AgentStateEvent[];
let writes: { data: string; at: number }[];
/** How many Enter writes the fake « terminal » swallows before letting one through. */
let dropEnters: number;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const current = (id: string) => workspaces.get(workspace.id)?.agents.find((a) => a.id === id);
const waitFor = async (check: () => boolean, what: string, timeoutMs = 10_000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(what);
    await sleep(20);
  }
};
const enters = () => writes.filter((w) => w.data === '\r').length;
const texts = () => writes.filter((w) => w.data !== '\r').map((w) => w.data);

const setup = async (opts: { strict: boolean; scenario: string; timeoutMs?: number }) => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-submit-')));
  const repo = join(root, 'Développement');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  stores = openStores(join(root, 'userData'));
  workspaces = new WorkspaceService({ git: new GitService({ env: gitEnv }), stores });
  workspace = await workspaces.open(repo);
  pty = new PtyManager();
  hooks = new HookServer();
  events = [];
  writes = [];
  const write = pty.write.bind(pty);
  vi.spyOn(pty, 'write').mockImplementation((id, data) => {
    writes.push({ data, at: Date.now() });
    if (data === '\r' && dropEnters > 0) {
      dropEnters -= 1;
      return;
    }
    write(id, data);
  });
  const registry = new CliRegistry({
    adapters: [new FakeAdapter({ cliPath: FAKE_CLI, platform: process.platform })],
    resolveEnv: () => Promise.resolve({}),
    stores,
  });
  await registry.detect();
  const hookUrl = await hooks.start();
  manager = new AgentManager({
    workspaces,
    registry,
    git: new GitService({ env: gitEnv }),
    pty,
    hooks,
    hookUrl: () => hookUrl,
    resolveEnv: () =>
      Promise.resolve({
        ...gitEnv,
        FAKE_CLI_SCENARIO: scenarioPath(opts.scenario),
        ...(opts.strict ? { FAKE_CLI_STRICT_PASTE: '1' } : {}),
      }),
    isPortInUse: () => Promise.resolve(false),
    onState: (event) => events.push(event),
    submitDelayMs: DELAY,
    submitTimeoutMs: opts.timeoutMs ?? TIMEOUT,
  });
  const [agent] = await manager.launch({
    workspaceId: workspace.id,
    agents: [
      {
        cliId: 'fake',
        model: null,
        permissionLevel: 'always-allow',
        baseBranch: null,
        branch: null,
        port: null,
        startCommand: null,
      },
    ],
    counters: { freeTerminal: 0 },
  });
  if (!agent) throw new Error('no agent launched');
  await waitFor(() => current(agent.id)?.state === 'awaiting-prompt', 'never ready');
  writes.length = 0;
  return agent;
};

const states = (id: string): AgentState[] =>
  events.filter((e) => e.agentId === id).map((e) => e.state);
const undelivered = (id: string) =>
  (
    manager as unknown as { undeliveredPrompts(id: string, origin: string): number }
  ).undeliveredPrompts(id, 'orchestrator');

beforeEach(() => {
  dropEnters = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await manager.dispose();
  await pty.dispose();
  await hooks.stop();
  workspaces.dispose();
  // The writes still queued (the exit of the agent) land before the folder goes.
  await stores.workspace(workspace.id).read();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 30_000);

describe('a prompt sent to an agent is submitted (fix-send-prompt)', { timeout: 30_000 }, () => {
  it('Given a CLI that swallows an Enter glued to a paste, When a multi-line prompt is sent, Then it is submitted by a separate Enter', async () => {
    const agent = await setup({ strict: true, scenario: 'echo-prompt' });
    await manager.sendPrompt(agent.id, 'ligne un\nligne deux', 'orchestrator');
    // Submitted: the CLI turns to « working » and answers. Only its first line is checked: each
    // platform's terminal renders the line break of the echo its own way (CRLF, ConPTY).
    await waitFor(
      () =>
        states(agent.id).includes('working') && pty.history(agent.id).includes('Reçu : ligne un'),
      'not submitted',
    );
    expect(writes.map((w) => w.data).slice(0, 2)).toEqual([
      '\x1b[200~ligne un\nligne deux\x1b[201~',
      '\r',
    ]);
    // The Enter comes after a delay, not in the same breath.
    expect((writes[1]?.at ?? 0) - (writes[0]?.at ?? 0)).toBeGreaterThanOrEqual(DELAY - 30);
    expect(states(agent.id)).toContain('working');
  });

  it('Given the same CLI, When a one-line prompt is sent, Then the text and the Enter are two writes and it is submitted', async () => {
    const agent = await setup({ strict: true, scenario: 'echo-prompt' });
    await manager.sendPrompt(agent.id, 'Corrige a.ts', 'orchestrator');
    await waitFor(() => pty.history(agent.id).includes('Reçu : Corrige a.ts'), 'not submitted');
    expect(writes.map((w) => w.data).slice(0, 2)).toEqual(['Corrige a.ts', '\r']);
    expect((writes[1]?.at ?? 0) - (writes[0]?.at ?? 0)).toBeGreaterThanOrEqual(DELAY - 30);
  });

  it('Given an Enter that is lost, When nothing starts working in time, Then PACT sends Enter once more and the prompt is submitted', async () => {
    const agent = await setup({ strict: false, scenario: 'echo-prompt' });
    dropEnters = 1;
    await manager.sendPrompt(agent.id, 'Perdu puis renvoyé', 'orchestrator');
    await waitFor(() => pty.history(agent.id).includes('Reçu : Perdu puis renvoyé'), 'not resent');
    expect(enters()).toBe(2);
    await sleep(TIMEOUT * 3);
    expect(enters()).toBe(2);
    expect(undelivered(agent.id)).toBe(0);
  });

  it('Given an agent that never submits, When two Enters stay unanswered, Then the prompt is marked undelivered, no third Enter, and the queue is no longer blocked', async () => {
    const agent = await setup({ strict: false, scenario: 'echo-prompt' });
    dropEnters = 2;
    await manager.sendPrompt(agent.id, 'Jamais soumis', 'orchestrator');
    await manager.sendPrompt(agent.id, 'Le suivant', 'orchestrator');
    // Both Enters are lost: after the second wait the first prompt is given up…
    await waitFor(() => undelivered(agent.id) === 1, 'not marked undelivered', 5_000);
    expect(manager.waitingPrompts(agent.id, 'orchestrator')).toBeLessThanOrEqual(1);
    // …and the next one is typed, then submitted (the third Enter goes through).
    await waitFor(() => texts().includes('Le suivant'), 'queue still blocked', 5_000);
    await waitFor(() => pty.history(agent.id).includes('Reçu : '), 'nothing submitted');
    // Only the two Enters of the lost prompt, plus those of the next one: never a third for it.
    expect(
      writes
        .slice(
          0,
          writes.findIndex((w) => w.data === 'Le suivant'),
        )
        .filter((w) => w.data === '\r'),
    ).toHaveLength(2);
    // Its turn ends before the teardown removes the folder its state is saved in.
    await waitFor(() => current(agent.id)?.state === 'done', 'never done');
  });

  it('Given a prompt submitted in time, When the agent works, Then there is no second Enter and nothing is resent', async () => {
    // A budget far above the 400 ms of the other tests: a slow machine must not look like an agent
    // that never started working. The wait below still outlasts it, so a second Enter would show.
    const budget = 3_000;
    const agent = await setup({ strict: false, scenario: 'echo-prompt', timeoutMs: budget });
    await manager.sendPrompt(agent.id, 'Une seule fois', 'orchestrator');
    await waitFor(() => pty.history(agent.id).includes('Reçu : Une seule fois'), 'not typed');
    await waitFor(() => states(agent.id).includes('working'), 'never working');
    await sleep(budget + DELAY * 4);
    expect(states(agent.id)).toContain('working');
    expect(enters()).toBe(1);
    expect(texts()).toEqual(['Une seule fois']);
    expect(undelivered(agent.id)).toBe(0);
  });
});

// 007 T019 — the guard on the prompt (R5, R6): PACT never types into a prompt that holds something,
// whatever the origin of the text, and a pointer typed but never submitted is not typed twice.
//
// API fixed for the dev:
//   - `PromptOrigin` gains 'wake' (the pointer of the wake), counted like the others by
//     `undeliveredPrompts(id, 'wake')` and `waitingPrompts(id, 'wake')`;
//   - `AgentManager.typed(id, data)` follows the draft (agent-state.ts `applyTyped`), and the prompts
//     held are released when the draft becomes empty (erased) and the agent is ready, or at the next
//     ready state; `prompt-submitted` empties the draft;
//   - a pointer given up after two Enters marks the draft `stuck`: the next wake sends Enter alone.
const send = (id: string, text: string, origin: string) =>
  manager.sendPrompt(id, text, origin as never);
const undeliveredFor = (id: string, origin: string) =>
  (
    manager as unknown as { undeliveredPrompts(id: string, origin: string): number }
  ).undeliveredPrompts(id, origin);

describe('PACT does not write into a prompt that holds something (007 FR-014, SC-003)', () => {
  it.each(['review', 'orchestrator', 'wake', 'resume'])(
    'Given a draft typed by the user, When a prompt of origin « %s » is sent, Then nothing is written until the user empties the prompt',
    async (origin) => {
      const agent = await setup({ strict: false, scenario: 'echo-prompt' });
      manager.typed(agent.id, 'abc');
      await send(agent.id, 'Retenu', origin);
      await sleep(DELAY * 4);
      expect(writes).toEqual([]);
      expect(pty.history(agent.id)).not.toContain('Reçu : Retenu');
      manager.typed(agent.id, '\x7f\x7f\x7f');
      await waitFor(() => pty.history(agent.id).includes('Reçu : Retenu'), 'never released');
      expect(texts()).toEqual(['Retenu']);
    },
  );

  it('Given a pasted draft (unknown content), When a prompt is sent, Then nothing is written, even after erasing', async () => {
    const agent = await setup({ strict: false, scenario: 'echo-prompt' });
    manager.typed(agent.id, '\x1b[200~collé\x1b[201~');
    await send(agent.id, 'Retenu', 'orchestrator');
    manager.typed(agent.id, '\x7f\x7f\x7f\x7f\x7f');
    await sleep(DELAY * 4);
    expect(writes).toEqual([]);
  });

  it('Given a held prompt, When the user submits his draft, Then the draft is played first and the held prompt comes after it, whole', async () => {
    const agent = await setup({ strict: false, scenario: 'echo-prompt' });
    manager.typed(agent.id, 'abc');
    await send(agent.id, 'Retenu', 'review');
    await sleep(DELAY * 2);
    expect(writes).toEqual([]);
    pty.write(agent.id, 'go\r');
    await waitFor(() => pty.history(agent.id).includes('Reçu : Retenu'), 'never released', 15_000);
    const history = pty.history(agent.id);
    expect(history.indexOf('Reçu : go')).toBeGreaterThanOrEqual(0);
    expect(history.indexOf('Reçu : go')).toBeLessThan(history.indexOf('Reçu : Retenu'));
    expect(history).not.toContain('goRetenu');
  });

  it('Given keys typed while the agent awaits an answer, When it has been answered, Then they do not count as a draft', async () => {
    const agent = await setup({ strict: false, scenario: 'ask-then-echo' });
    pty.write(agent.id, 'Supprime le fichier\r');
    await waitFor(() => current(agent.id)?.state === 'awaiting-answer', 'no question');
    manager.typed(agent.id, 'oui');
    await manager.answer(agent.id, 'allow');
    await waitFor(() => current(agent.id)?.state === 'done', 'never done');
    writes.length = 0;
    await send(agent.id, 'Après', 'orchestrator');
    await waitFor(() => texts().includes('Après'), 'held by keys that answered a question');
  });

  it('Given an empty prompt, When the terminal answers by itself (position, focus), Then the draft stays empty and the wake types its pointer', async () => {
    const agent = await setup({ strict: false, scenario: 'echo-prompt' });
    // ConPTY asks for the cursor position as it starts; xterm answers through `onData`.
    manager.typed(agent.id, '\x1b[1;1R');
    manager.typed(agent.id, '\x1b[I\x1b[O');
    expect(manager.promptState(agent.id)).toBe('empty');
    writes.length = 0;
    await send(agent.id, '1 événement, lis get_events', 'wake');
    await waitFor(() => texts().includes('1 événement, lis get_events'), 'pointer never typed');
  });
});

describe('a pointer typed but never submitted (007 R6)', () => {
  it('Given a wake pointer whose two Enters are lost, When the next wake comes, Then only Enter is sent: no second pointer is typed', async () => {
    const agent = await setup({ strict: false, scenario: 'echo-prompt' });
    dropEnters = 2;
    await send(agent.id, '1 événement, lis get_events', 'wake');
    await waitFor(() => undeliveredFor(agent.id, 'wake') === 1, 'not given up', 5_000);
    writes.length = 0;
    dropEnters = 0;

    await send(agent.id, '2 événements, lis get_events', 'wake');
    await waitFor(
      () => pty.history(agent.id).includes('Reçu : 1 événement, lis get_events'),
      'the first pointer was not submitted',
    );
    expect(texts()).toEqual([]);
    expect(enters()).toBeGreaterThanOrEqual(1);
    expect(pty.history(agent.id)).not.toContain('2 événements, lis get_events');
  });

  it('Given a stuck pointer, When another origin sends a prompt, Then it is held: the prompt is not empty', async () => {
    const agent = await setup({ strict: false, scenario: 'echo-prompt' });
    dropEnters = 2;
    await send(agent.id, '1 événement, lis get_events', 'wake');
    await waitFor(() => undeliveredFor(agent.id, 'wake') === 1, 'not given up', 5_000);
    writes.length = 0;
    await send(agent.id, 'Commentaire de revue', 'review');
    await sleep(DELAY * 4);
    expect(texts()).toEqual([]);
  });

  it('Given a pointer submitted in time, When the next wake comes, Then its text is typed normally', async () => {
    const agent = await setup({ strict: false, scenario: 'echo-prompt', timeoutMs: 3_000 });
    await send(agent.id, '1 événement, lis get_events', 'wake');
    await waitFor(() => current(agent.id)?.state === 'done', 'first pointer never played');
    writes.length = 0;
    await send(agent.id, '2 événements, lis get_events', 'wake');
    await waitFor(() => texts().includes('2 événements, lis get_events'), 'second never typed');
    expect(undeliveredFor(agent.id, 'wake')).toBe(0);
  });
});
