import { expect, it, vi } from 'vitest';

const exposeInMainWorld = vi.fn();
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld } }));

it('exposes the window.pact bridge', async () => {
  await import('../../../src/preload/index');
  expect(exposeInMainWorld).toHaveBeenCalledWith('pact', {});
});
