import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GenericAdapter } from '../../../../src/main/agents/adapters/generic';
import { CliRegistry } from '../../../../src/main/agents/cli-registry';
import { openStores, type Stores } from '../../../../src/main/persistence/store';

// T095 — « Autre CLI — ajouter » (FR-008, US6 scenario 6): a name and a command typed by the user.

let dir: string;
let bin: string;
let stores: Stores;
let path: string;

const registry = () =>
  new CliRegistry({
    adapters: [],
    resolveEnv: () => Promise.resolve({ PATH: path }),
    stores,
    platform: 'darwin',
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pact-custom-cli-'));
  bin = join(dir, 'bin');
  await mkdir(bin);
  stores = openStores(join(dir, 'userData'));
  const aider = join(bin, 'aider');
  await writeFile(aider, '#!/bin/sh\n');
  await chmod(aider, 0o755);
  path = bin;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('CliRegistry.add', () => {
  it('registers the CLI as custom, with a generic adapter, and saves it', async () => {
    const clis = registry();
    await clis.detect();
    expect(await clis.add({ name: 'Aider', command: 'aider --no-git' })).toEqual({
      id: 'custom-aider',
      name: 'Aider',
      adapter: 'generic',
      command: 'aider --no-git',
      resolvedPath: join(bin, 'aider'),
      version: null,
      origin: 'custom',
      status: 'installed',
      models: [],
    });
    expect((await stores.state.read()).customClis.map((cli) => cli.id)).toEqual(['custom-aider']);
  });

  it('warns through its status when the command is not found, and keeps it', async () => {
    const clis = registry();
    await clis.detect();
    const added = await clis.add({ name: 'Goose', command: 'goose' });
    expect(added).toMatchObject({ id: 'custom-goose', status: 'missing', resolvedPath: null });
    expect(clis.list().map((cli) => cli.id)).toEqual(['custom-goose']);
  });

  it('makes an id from the name, unique among the CLIs already added', async () => {
    const clis = registry();
    await clis.detect();
    expect((await clis.add({ name: 'Mon Agent é', command: 'aider' })).id).toBe(
      'custom-mon-agent-e',
    );
    expect((await clis.add({ name: 'Mon agent É', command: 'aider' })).id).toBe(
      'custom-mon-agent-e-2',
    );
    expect((await clis.add({ name: '???', command: 'aider' })).id).toBe('custom-cli');
  });

  it('offers it to launch: an adapter and its definition, found again after a restart', async () => {
    const clis = registry();
    await clis.detect();
    await clis.add({ name: 'Aider', command: 'aider' });
    expect(clis.get('custom-aider')?.adapter).toBeInstanceOf(GenericAdapter);

    const restarted = registry();
    await restarted.detect();
    expect(restarted.get('custom-aider')?.definition).toMatchObject({
      status: 'installed',
      resolvedPath: join(bin, 'aider'),
    });
  });

  it('detects the CLIs added by hand again, like the others (cli:redetect)', async () => {
    const clis = registry();
    await clis.detect();
    await clis.add({ name: 'Goose', command: 'goose' });
    const goose = join(bin, 'goose');
    await writeFile(goose, '#!/bin/sh\n');
    await chmod(goose, 0o755);
    expect((await clis.detect()).find((cli) => cli.id === 'custom-goose')?.status).toBe(
      'installed',
    );
  });
});
