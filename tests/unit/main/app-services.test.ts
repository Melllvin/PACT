import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAppServices,
  devServerUrl,
  trustedSenderCheck,
} from '../../../src/main/app-services';
import { openStores } from '../../../src/main/persistence/store';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pact-services-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('app:getState', () => {
  it('returns an empty state on first launch', async () => {
    const services = createAppServices({ stores: openStores(dir) });
    expect(await services['app:getState']()).toEqual({
      workspaces: [],
      recents: [],
      clis: [],
      permission: null,
    });
  });

  it('returns the persisted recents, custom CLIs and global permission', async () => {
    const stores = openStores(dir);
    const recent = {
      path: '/repo',
      name: 'repo',
      branch: 'main',
      keptWorktrees: 1,
      lastOpenedAt: '2026-09-24T10:00:00.000Z',
    };
    await stores.state.write({
      openWorkspaces: [],
      recents: [recent],
      customClis: [],
      permission: { level: 'ask-sensitive', autoResume: false, scope: 'global' },
    });
    expect(await createAppServices({ stores })['app:getState']()).toMatchObject({
      recents: [recent],
      permission: { level: 'ask-sensitive', autoResume: false, scope: 'global' },
    });
  });
});

describe('devServerUrl', () => {
  it('uses the electron-vite dev server only in an unpackaged app', () => {
    const env = { ELECTRON_RENDERER_URL: 'http://localhost:5173/' };
    expect(devServerUrl({ isPackaged: false }, env)).toBe('http://localhost:5173/');
    // A packaged app must never let an environment variable swap its UI for a remote page.
    expect(devServerUrl({ isPackaged: true }, env)).toBeUndefined();
    expect(devServerUrl({ isPackaged: false }, {})).toBeUndefined();
  });
});

describe('trustedSenderCheck', () => {
  const rendererHtml = join(dir || tmpdir(), 'out', 'renderer', 'index.html');

  it('trusts the built renderer page', () => {
    const trusted = trustedSenderCheck({ rendererHtml, devServerUrl: undefined });
    expect(trusted(pathToFileURL(rendererHtml).href)).toBe(true);
  });

  it('refuses other files and remote pages', () => {
    const trusted = trustedSenderCheck({ rendererHtml, devServerUrl: undefined });
    expect(trusted(pathToFileURL(join(tmpdir(), 'evil.html')).href)).toBe(false);
    expect(trusted('https://example.com/')).toBe(false);
    expect(trusted('not a url')).toBe(false);
  });

  it('trusts the dev server origin only when electron-vite provides it', () => {
    const dev = trustedSenderCheck({ rendererHtml, devServerUrl: 'http://localhost:5173/' });
    expect(dev('http://localhost:5173/')).toBe(true);
    expect(dev('http://localhost:5173/index.html')).toBe(true);
    expect(dev('http://localhost:5174/')).toBe(false);
    const prod = trustedSenderCheck({ rendererHtml, devServerUrl: undefined });
    expect(prod('http://localhost:5173/')).toBe(false);
  });
});
