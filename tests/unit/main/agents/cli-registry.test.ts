import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter, DetectionResult } from '../../../../src/main/agents/adapters/types';
import { CliRegistry } from '../../../../src/main/agents/cli-registry';
import { openStores, type Stores } from '../../../../src/main/persistence/store';
import type { AdapterId, CliDefinition } from '../../../../src/shared/model';

// US2 — « Agents détectés » : Claude Code and Codex found through the login shell's PATH (T028).

const adapter = (
  id: AdapterId,
  detect: CliAdapter['detect'],
  models: string[] = [],
): CliAdapter => ({
  id,
  detect,
  listModels: () => Promise.resolve(models),
  buildLaunch: vi.fn(),
  buildResume: vi.fn(),
  mapHookEvent: () => null,
  mapOutput: () => null,
  answerKeys: () => '',
  parseRateLimitReset: () => null,
});

const found = (path: string, version: string): DetectionResult => ({
  resolvedPath: path,
  version,
  status: 'installed',
});
const missing: DetectionResult = { resolvedPath: null, version: null, status: 'missing' };

let dir: string;
let stores: Stores;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pact-registry-'));
  stores = openStores(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CliRegistry', () => {
  it('detects each CLI with the environment of the login shell', async () => {
    const env = { PATH: '/Users/me/.local/bin:/opt/homebrew/bin' };
    const detect = vi.fn(() => Promise.resolve(found('/Users/me/.local/bin/claude', '2.1.281')));
    const resolveEnv = vi.fn(() => Promise.resolve(env));
    await new CliRegistry({
      adapters: [adapter('claude-code', detect)],
      resolveEnv,
      stores,
    }).detect();
    expect(resolveEnv).toHaveBeenCalledOnce();
    expect(detect).toHaveBeenCalledWith(env);
  });

  it('describes installed, missing and too old CLIs, without any login state', async () => {
    const registry = new CliRegistry({
      adapters: [
        adapter(
          'claude-code',
          () => Promise.resolve(found('/opt/homebrew/bin/claude', '2.1.281')),
          ['opus'],
        ),
        adapter('codex', () =>
          Promise.resolve({
            ...found('/opt/homebrew/bin/codex', '0.40.0'),
            status: 'unsupported-version',
          }),
        ),
      ],
      resolveEnv: () => Promise.resolve({}),
      stores,
    });
    expect(await registry.detect()).toEqual<CliDefinition[]>([
      {
        id: 'claude-code',
        name: 'Claude Code',
        adapter: 'claude-code',
        command: 'claude',
        resolvedPath: '/opt/homebrew/bin/claude',
        version: '2.1.281',
        origin: 'detected',
        status: 'installed',
        models: ['opus'],
      },
      {
        id: 'codex',
        name: 'Codex',
        adapter: 'codex',
        command: 'codex',
        resolvedPath: '/opt/homebrew/bin/codex',
        version: '0.40.0',
        origin: 'detected',
        status: 'unsupported-version',
        models: [],
      },
    ]);
  });

  it('lists a CLI whose detection fails as missing, without failing the others', async () => {
    const registry = new CliRegistry({
      adapters: [
        adapter('claude-code', () => Promise.reject(new Error('spawn EACCES'))),
        adapter('codex', () => Promise.resolve(missing)),
      ],
      resolveEnv: () => Promise.resolve({}),
      stores,
    });
    const statuses = (await registry.detect()).map(({ id, status }) => ({ id, status }));
    expect(statuses).toEqual([
      { id: 'claude-code', status: 'missing' },
      { id: 'codex', status: 'missing' },
    ]);
  });

  it('keeps the CLIs added by the user after the detected ones', async () => {
    const custom: CliDefinition = {
      id: 'custom-aider',
      name: 'Aider',
      adapter: 'generic',
      command: 'aider',
      resolvedPath: '/usr/local/bin/aider',
      version: null,
      origin: 'custom',
      status: 'installed',
      models: [],
    };
    await stores.state.write({ ...(await stores.state.read()), customClis: [custom] });
    const registry = new CliRegistry({
      adapters: [adapter('codex', () => Promise.resolve(missing))],
      resolveEnv: () => Promise.resolve({}),
      stores,
    });
    expect((await registry.detect()).map((cli) => cli.id)).toEqual(['codex', 'custom-aider']);
  });

  it('serves the last detection and detects again on request (cli:redetect)', async () => {
    let result = missing;
    const codex = adapter('codex', () => Promise.resolve(result));
    const registry = new CliRegistry({
      adapters: [codex],
      resolveEnv: () => Promise.resolve({}),
      stores,
    });
    expect(registry.list()).toEqual([]);
    await registry.detect();
    result = found('/opt/homebrew/bin/codex', '0.156.1');
    expect(registry.list()[0]?.status).toBe('missing');
    expect((await registry.detect())[0]?.status).toBe('installed');
    expect(registry.list()[0]?.status).toBe('installed');
  });

  it('gives the adapter and definition of a known CLI', async () => {
    const codex = adapter('codex', () => Promise.resolve(found('/bin/codex', '0.156.1')));
    const registry = new CliRegistry({
      adapters: [codex],
      resolveEnv: () => Promise.resolve({}),
      stores,
    });
    await registry.detect();
    expect(registry.get('codex')?.adapter).toBe(codex);
    expect(registry.get('codex')?.definition.resolvedPath).toBe('/bin/codex');
    expect(registry.get('claude-code')).toBeUndefined();
  });

  it('names the fake test CLI', async () => {
    const registry = new CliRegistry({
      adapters: [adapter('fake', () => Promise.resolve(found('/node', 'v22')))],
      resolveEnv: () => Promise.resolve({}),
      stores,
    });
    expect((await registry.detect())[0]).toMatchObject({ id: 'fake', name: 'Faux CLI' });
  });
});
