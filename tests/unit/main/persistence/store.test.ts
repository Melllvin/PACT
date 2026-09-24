import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonFile, openStores, SCHEMA_VERSION } from '../../../../src/main/persistence/store';

const schema = z.object({ count: z.int(), label: z.string() });
const defaults = () => ({ count: 0, label: 'default' });

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pact-store-'));
  path = join(dir, 'data.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = () => new JsonFile(path, schema, defaults);
const writeRaw = (content: string) => writeFile(path, content, 'utf8');

describe('JsonFile', () => {
  it('returns the defaults when the file does not exist, without creating it', async () => {
    expect(await file().read()).toEqual(defaults());
    expect(await readdir(dir)).toEqual([]);
  });

  it('round-trips a value and stamps the schema version', async () => {
    await file().write({ count: 3, label: 'x' });
    expect(await file().read()).toEqual({ count: 3, label: 'x' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      schemaVersion: SCHEMA_VERSION,
      data: { count: 3, label: 'x' },
    });
  });

  it('creates missing parent directories', async () => {
    path = join(dir, 'nested', 'deeper', 'data.json');
    await file().write({ count: 1, label: 'x' });
    expect(await file().read()).toEqual({ count: 1, label: 'x' });
  });

  it('refuses to write an invalid value', async () => {
    await expect(file().write({ count: 1.5, label: 'x' })).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps the last value and leaves no temporary file under concurrent writes', async () => {
    const store = file();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.write({ count: i, label: `v${String(i)}` })),
    );
    expect(await store.read()).toEqual({ count: 24, label: 'v24' });
    expect(await readdir(dir)).toEqual(['data.json']);
  });

  it.each([
    ['corrupted JSON', '{"schemaVersion": 1, "data": {'],
    ['a value that fails the schema', JSON.stringify({ schemaVersion: 1, data: { count: 'x' } })],
    ['an unknown schema version', JSON.stringify({ schemaVersion: 99, data: defaults() })],
    ['a legacy unversioned file', JSON.stringify({ count: 2, label: 'old' })],
  ])('falls back to the defaults on %s and keeps a backup of the file', async (_case, content) => {
    await writeRaw(content);
    expect(await file().read()).toEqual(defaults());

    const backups = (await readdir(dir)).filter((name) => name.startsWith('data.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dir, backups[0] ?? ''), 'utf8')).toBe(content);
  });

  it('never overwrites a backup when the file is written again', async () => {
    await writeRaw('not json');
    const store = file();
    await store.read();
    await store.write({ count: 1, label: 'fresh' });
    const names = await readdir(dir);
    expect(names.filter((name) => name.startsWith('data.json.corrupt-'))).toHaveLength(1);
    expect(await store.read()).toEqual({ count: 1, label: 'fresh' });
  });

  it('surfaces read errors other than a missing file instead of masking them', async () => {
    await mkdir(path); // reading a directory fails with EISDIR on every platform
    await expect(file().read()).rejects.toThrow();
  });
});

describe('openStores', () => {
  it('keeps global state in state.json and each workspace in workspaces/<id>.json', () => {
    const stores = openStores(dir);
    expect(stores.state.path).toBe(join(dir, 'state.json'));
    expect(stores.workspace('a1b2c3').path).toBe(join(dir, 'workspaces', 'a1b2c3.json'));
  });

  it('starts with an empty global state', async () => {
    expect(await openStores(dir).state.read()).toEqual({
      openWorkspaces: [],
      recents: [],
      customClis: [],
      permission: null,
    });
  });

  it.each(['../escape', 'a/b', '', 'UPPER'])('rejects the workspace id %j', (id) => {
    expect(() => openStores(dir).workspace(id)).toThrow();
  });

  it('returns the same store for the same workspace so writes are serialized', () => {
    const stores = openStores(dir);
    expect(stores.workspace('abc')).toBe(stores.workspace('abc'));
  });
});
