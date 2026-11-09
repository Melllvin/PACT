import { describe, expect, it, vi } from 'vitest';
import { createDeliveryServices } from '../../../../src/main/ipc/delivery-handlers';
import type { Workspace } from '../../../../src/shared/model';

// 008 US3 — « Ouvrir la PR »: the main process opens the PR of a delivery, and only an https address
// of a pull request on GitHub (setWindowOpenHandler denies every window of the renderer).

const ID = '00000000-0000-4000-8000-000000000090';
const wire = (url: string | null) => {
  const workspace = {
    id: 'w1',
    deliveries: [{ id: ID, pr: url === null ? null : { number: 7, url, expectedAuthor: 'me' } }],
  } as unknown as Workspace;
  const openExternal = vi.fn(() => Promise.resolve());
  const handlers = createDeliveryServices({
    workspaces: { get: () => workspace, list: () => [workspace], update: vi.fn() },
    delivery: { settingsChanged: vi.fn() },
    openExternal,
  });
  return { handlers, openExternal };
};

describe('delivery:openPr', () => {
  it('Given a delivery with its PR, When the user opens it, Then the address is opened by the main process', async () => {
    const { handlers, openExternal } = wire('https://github.com/pact/test/pull/7');
    await handlers['delivery:openPr']({ deliveryId: ID });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/pact/test/pull/7');
  });

  it.each([
    ['no PR', null],
    ['an address that is not a PR of GitHub', 'https://evil.example/pact/test/pull/7'],
    ['a scheme that is not https', 'http://github.com/pact/test/pull/7'],
    ['an address with something after the number', 'https://github.com/pact/test/pull/7?x=1'],
  ])('Given %s, When the user opens it, Then nothing is opened', async (_what, url) => {
    const { handlers, openExternal } = wire(url);
    await expect(handlers['delivery:openPr']({ deliveryId: ID })).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('Given a delivery that does not exist, When the user opens it, Then it is refused', async () => {
    const { handlers, openExternal } = wire('https://github.com/pact/test/pull/7');
    await expect(
      handlers['delivery:openPr']({ deliveryId: '00000000-0000-4000-8000-000000000091' }),
    ).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
  });
});
