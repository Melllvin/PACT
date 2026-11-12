import { describe, expect, it, vi } from 'vitest';
import { createDeliveryServices } from '../../../../src/main/ipc/delivery-handlers';

// 008 US3 — « Ouvrir la PR »: the main process opens the address that the delivery rebuilt
// (`DeliveryService.prUrl`), nothing the renderer or the state file said (setWindowOpenHandler denies
// every window of the renderer).

const ID = '00000000-0000-4000-8000-000000000090';
const wire = (url: string | null) => {
  const openExternal = vi.fn(() => Promise.resolve());
  const prUrl = vi.fn(() => Promise.resolve(url));
  const handlers = createDeliveryServices({
    workspaces: { get: vi.fn(), update: vi.fn() },
    delivery: { settingsChanged: vi.fn() },
    openExternal,
    prUrl,
  });
  return { handlers, openExternal, prUrl };
};

describe('delivery:openPr', () => {
  it('Given a delivery with its PR, When the user opens it, Then the address rebuilt is opened by the main process', async () => {
    const { handlers, openExternal, prUrl } = wire('https://github.com/pact/test/pull/7');
    await handlers['delivery:openPr']({ deliveryId: ID });
    expect(prUrl).toHaveBeenCalledExactlyOnceWith(ID);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/pact/test/pull/7');
  });

  it('Given a delivery that has nothing to open, When the user opens it, Then nothing is opened', async () => {
    const { handlers, openExternal } = wire(null);
    await expect(handlers['delivery:openPr']({ deliveryId: ID })).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('Given no way to rebuild the address, When the user opens it, Then nothing is opened', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const handlers = createDeliveryServices({
      workspaces: { get: vi.fn(), update: vi.fn() },
      delivery: { settingsChanged: vi.fn() },
      openExternal,
    });
    await expect(handlers['delivery:openPr']({ deliveryId: ID })).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
  });
});
