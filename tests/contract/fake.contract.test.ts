import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandRunner, createAdapters, runCommand } from '../../src/main/agents/adapters';
import { FakeAdapter } from '../../src/main/agents/adapters/fake';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { runCliAdapterContract, type WakeCapable } from './cli-adapter.contract';

const baseEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined) baseEnv[key] = value;

runCliAdapterContract('fake', ({ platform }) => new FakeAdapter({ cliPath: FAKE_CLI, platform }), {
  executablePath: process.execPath,
  drivesFakeCli: { env: { ...baseEnv, FAKE_CLI_SCENARIO: scenarioPath('ask-permission') } },
});

describe('fake adapter specifics', () => {
  const adapter = new FakeAdapter({ cliPath: FAKE_CLI, platform: 'darwin' });

  it('maps the fake CLI hook payloads to agent signals', () => {
    expect(adapter.mapHookEvent({ type: 'session-started', sessionId: 's1' })).toEqual({
      type: 'session-started',
      sessionId: 's1',
    });
    expect(adapter.mapHookEvent({ type: 'awaiting-answer', summary: 'rm x' })).toEqual({
      type: 'awaiting-answer',
      summary: 'rm x',
    });
    expect(
      adapter.mapHookEvent({
        type: 'failed',
        kind: 'rate-limit',
        message: 'Rate limited',
        resetAt: '2030-01-01T09:30:00.000Z',
      }),
    ).toEqual({
      type: 'failed',
      kind: 'rate-limit',
      message: 'Rate limited',
      resetAt: new Date('2030-01-01T09:30:00.000Z'),
    });
  });

  it('rejects signals missing required fields', () => {
    expect(adapter.mapHookEvent({ type: 'awaiting-answer' })).toBeNull();
    expect(adapter.mapHookEvent({ type: 'failed', kind: 'boom', message: 'x' })).toBeNull();
  });

  it('parses the fake rate-limit reset time', () => {
    expect(
      adapter.parseRateLimitReset('Rate limit reached. Resets at 2030-01-01T09:30:00.000Z'),
    ).toEqual(new Date('2030-01-01T09:30:00.000Z'));
    expect(adapter.parseRateLimitReset('Rate limit reached.')).toBeNull();
    expect(adapter.parseRateLimitReset('Resets at someday')).toBeNull();
  });

  it('is detected as installed and offers a single model', async () => {
    expect(await adapter.detect({})).toEqual({
      resolvedPath: process.execPath,
      version: process.version,
      status: 'installed',
    });
    expect(await adapter.listModels()).toEqual(['fake']);
  });

  it('runs the fake CLI script with Electron in Node mode', () => {
    const spec = adapter.buildLaunch({
      agentId: '00000000-0000-4000-8000-000000000001',
      executablePath: '/Applications/PACT.app/Contents/MacOS/PACT',
      repoPath: '/r',
      cwd: '/w',
      model: null,
      permissionLevel: 'always-allow',
      sessionId: 'sess',
      port: 3001,
      hook: { url: 'http://127.0.0.1:1', token: 't' },
    });
    expect(spec.args.slice(0, 3)).toEqual([FAKE_CLI, '--session-id', 'sess']);
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

describe('fake adapter usage (005 T011)', () => {
  const launch = (adapter: FakeAdapter) =>
    adapter.buildLaunch({
      agentId: '00000000-0000-4000-8000-000000000001',
      executablePath: process.execPath,
      repoPath: '/r',
      cwd: '/w',
      model: null,
      permissionLevel: 'always-allow',
      sessionId: 'sess',
      port: 3001,
      hook: { url: 'http://127.0.0.1:1', token: 't' },
    }).args;

  it('reports its usage like Claude Code, through the statusLine of its --settings', () => {
    const bridge = { executable: '/Applications/PACT.app/Contents/MacOS/PACT', script: '/b.js' };
    const adapter = new FakeAdapter({ cliPath: FAKE_CLI, platform: 'darwin', bridge });
    expect(adapter.usageSource).toBe('claude-statusline');
    const args = launch(adapter);
    expect(JSON.parse(args[args.indexOf('--settings') + 1] ?? '')).toEqual({
      statusLine: {
        type: 'command',
        command: `ELECTRON_RUN_AS_NODE=1 '${bridge.executable}' '${bridge.script}' '--statusline'`,
      },
    });
  });

  it('has no statusLine without a bridge', () => {
    expect(launch(new FakeAdapter({ cliPath: FAKE_CLI, platform: 'darwin' }))).not.toContain(
      '--settings',
    );
  });
});

describe('adapter registry', () => {
  const bridge = { executable: '/Applications/PACT.app/Contents/MacOS/PACT', script: '/b.js' };
  const ids = (env: Record<string, string>) =>
    createAdapters({ env, platform: 'darwin', bridge }).map((a) => a.id);

  it('offers Claude Code and Codex', () => {
    expect(ids({})).toEqual(['claude-code', 'codex']);
  });

  it('offers nothing in test mode without a fake CLI', () => {
    expect(ids({ PACT_TEST_MODE: '1' })).toEqual([]);
  });

  it('only offers the fake adapter in test mode, so e2e runs never depend on installed CLIs', () => {
    expect(ids({ PACT_TEST_MODE: '1', PACT_FAKE_CLI: FAKE_CLI })).toEqual(['fake']);
  });

  it('runs the fake CLI with the Node given by the e2e harness (Electron has no console on Windows)', async () => {
    const [fake] = createAdapters({
      env: { PACT_TEST_MODE: '1', PACT_FAKE_CLI: FAKE_CLI, PACT_FAKE_NODE: '/usr/bin/node' },
      platform: 'darwin',
      bridge,
    });
    expect((await fake?.detect({}))?.resolvedPath).toBe('/usr/bin/node');
  });
});

describe('default command runner', () => {
  it('returns the standard output of a short command', async () => {
    const out = await runCommand(process.execPath, ['--version'], process.env, process.platform);
    expect(out.trim()).toBe(process.version);
  });

  it('is bound to the platform for the adapters', async () => {
    const out = await commandRunner(process.platform)(process.execPath, ['--version'], process.env);
    expect(out.trim()).toBe(process.version);
  });

  it('rejects when the command fails', async () => {
    await expect(
      runCommand(process.execPath, ['-e', 'process.exit(3)'], process.env, process.platform),
    ).rejects.toThrow();
  });
});

describe('fake adapter as an orchestrator (003 T008)', () => {
  it('can be one, and finds the MCP URL and its token in its environment', () => {
    const adapter = new FakeAdapter({ cliPath: FAKE_CLI, platform: 'darwin' });
    expect(adapter.supportsOrchestrator).toBe(true);
    const spec = adapter.buildLaunch({
      agentId: '00000000-0000-4000-8000-000000000001',
      executablePath: process.execPath,
      repoPath: '/repo',
      cwd: '/repo/.worktrees/fake-1',
      model: null,
      permissionLevel: 'always-allow',
      port: 3001,
      hook: { url: 'http://127.0.0.1:4567', token: 'f'.repeat(64) },
      orchestrator: {
        pluginDir: '/p',
        url: 'http://127.0.0.1:4567/mcp',
        token: 'e'.repeat(64),
        skills: { role: 'orchestrator', pluginDir: '/p', skills: [], contract: '/p/c.md' },
      },
    });
    expect(spec.env).toMatchObject({
      PACT_ORCHESTRATOR_URL: 'http://127.0.0.1:4567/mcp',
      PACT_ORCHESTRATOR_TOKEN: 'e'.repeat(64),
    });
    expect(spec.args.join(' ')).not.toContain('e'.repeat(64));
  });
});

// 007 US2, contracts/hooks.md — the fake CLI plays Claude Code: `post-tool` is its PostToolUse,
// `turn-finished` its Stop. FAKE_CLI_NO_WAKE_HOOK=1 turns the hook off, as a CLI that has none.
//
// API fixed here (see the report): the replies are the ones of Claude Code, so that the fake CLI
// reads `hookSpecificOutput.additionalContext` and `{ decision: 'block', reason }` as the real one.
describe('fake adapter wake points (007 T031)', () => {
  const POINTER = '2 événements, lis get_events';
  const make = () =>
    new FakeAdapter({ cliPath: FAKE_CLI, platform: 'darwin' }) as unknown as WakeCapable & {
      mapHookEvent(payload: unknown): unknown;
    };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('can carry a pointer in the middle of a turn by default', () => {
    vi.stubEnv('FAKE_CLI_NO_WAKE_HOOK', '');
    expect(make().midTurnWake).toBe(true);
  });

  it('cannot with FAKE_CLI_NO_WAKE_HOOK=1, and then has no wake point nor reply', () => {
    vi.stubEnv('FAKE_CLI_NO_WAKE_HOOK', '1');
    const adapter = make();
    expect(adapter.midTurnWake).toBe(false);
    for (const payload of [{ type: 'post-tool' }, { type: 'turn-finished' }]) {
      expect(adapter.isWakePoint?.(payload) ?? null).toBeNull();
      expect(adapter.wakeReply?.(payload, POINTER) ?? null).toBeNull();
    }
  });

  it('post-tool is a wake point « tool », turn-finished a wake point « stop »', () => {
    vi.stubEnv('FAKE_CLI_NO_WAKE_HOOK', '');
    const adapter = make();
    expect(adapter.isWakePoint?.({ type: 'post-tool' })).toBe('tool');
    expect(adapter.isWakePoint?.({ type: 'turn-finished' })).toBe('stop');
  });

  it.each(['session-started', 'prompt-submitted', 'awaiting-answer', 'failed'])(
    '%s is no wake point',
    (type) => {
      vi.stubEnv('FAKE_CLI_NO_WAKE_HOOK', '');
      const adapter = make();
      expect(adapter.midTurnWake).toBe(true);
      expect(adapter.isWakePoint?.({ type })).toBeNull();
    },
  );

  it('a subagent (agent_id) is no wake point (US2 sc.4)', () => {
    vi.stubEnv('FAKE_CLI_NO_WAKE_HOOK', '');
    const adapter = make();
    expect(adapter.midTurnWake).toBe(true);
    expect(adapter.isWakePoint?.({ type: 'post-tool', agent_id: 'sub-1' })).toBeNull();
    expect(adapter.isWakePoint?.({ type: 'turn-finished', agent_id: 'sub-1' })).toBeNull();
  });

  it('answers post-tool with additionalContext and turn-finished with a block', () => {
    vi.stubEnv('FAKE_CLI_NO_WAKE_HOOK', '');
    const adapter = make();
    expect(adapter.wakeReply?.({ type: 'post-tool' }, POINTER)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: POINTER },
    });
    expect(adapter.wakeReply?.({ type: 'turn-finished' }, POINTER)).toEqual({
      decision: 'block',
      reason: POINTER,
    });
  });

  it('post-tool changes no state, turn-finished is still the end of the turn', () => {
    const adapter = make();
    expect(adapter.mapHookEvent({ type: 'post-tool' })).toBeNull();
    expect(adapter.mapHookEvent({ type: 'turn-finished' })).toEqual({ type: 'turn-finished' });
  });
});
