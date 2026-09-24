import { describe, expect, it } from 'vitest';
import { createAdapters, runCommand } from '../../src/main/agents/adapters';
import { FakeAdapter } from '../../src/main/agents/adapters/fake';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { runCliAdapterContract } from './cli-adapter.contract';

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

describe('adapter registry', () => {
  const bridge = { executable: '/Applications/PACT.app/Contents/MacOS/PACT', script: '/b.js' };
  const ids = (env: Record<string, string>) =>
    createAdapters({ env, platform: 'darwin', bridge }).map((a) => a.id);

  it('offers Claude Code and Codex', () => {
    expect(ids({})).toEqual(['claude-code', 'codex']);
  });

  it('only offers the fake adapter in test mode, so e2e runs never depend on installed CLIs', () => {
    expect(ids({ PACT_TEST_MODE: '1', PACT_FAKE_CLI: FAKE_CLI })).toEqual(['fake']);
  });
});

describe('default command runner', () => {
  it('returns the standard output of a short command', async () => {
    const out = await runCommand(process.execPath, ['--version'], process.env, process.platform);
    expect(out.trim()).toBe(process.version);
  });

  it('rejects when the command fails', async () => {
    await expect(
      runCommand(process.execPath, ['-e', 'process.exit(3)'], process.env, process.platform),
    ).rejects.toThrow();
  });
});
