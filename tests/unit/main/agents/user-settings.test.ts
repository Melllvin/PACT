import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userStatusLineInterval } from '../../../../src/main/agents/adapters/user-settings';

// fix-todo-diff-notifications — the refresh interval of the user's own statusLine, read only.

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'pact-claude-config-'));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const read = () => userStatusLineInterval({ CLAUDE_CONFIG_DIR: folder });
const write = (settings: unknown) =>
  writeFile(join(folder, 'settings.json'), JSON.stringify(settings));

describe('userStatusLineInterval', () => {
  it('reads statusLine.refreshInterval', async () => {
    await write({ statusLine: { type: 'command', command: 'x', refreshInterval: 120 } });
    expect(read()).toBe(120);
  });

  it.each([
    ['no statusLine', {}],
    ['no interval', { statusLine: { type: 'command' } }],
    ['a null file', null],
    ['an interval of 0', { statusLine: { refreshInterval: 0 } }],
    ['a text interval', { statusLine: { refreshInterval: '60' } }],
  ])('is null with %s', async (_what, settings) => {
    await write(settings);
    expect(read()).toBeNull();
  });

  it('is null without a settings file or with an unreadable one', async () => {
    expect(read()).toBeNull();
    await mkdir(join(folder, 'sub'));
    await writeFile(join(folder, 'settings.json'), '{ pas du json');
    expect(read()).toBeNull();
  });

  it('looks in ~/.claude without CLAUDE_CONFIG_DIR', async () => {
    await mkdir(join(folder, '.claude'));
    await writeFile(
      join(folder, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { refreshInterval: 45 } }),
    );
    expect(userStatusLineInterval({ HOME: folder })).toBe(45);
  });
});
