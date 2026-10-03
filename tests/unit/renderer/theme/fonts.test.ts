import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_FONT, terminalFontReady } from '../../../../src/renderer/theme/fonts';

describe('terminalFontReady (T149)', () => {
  it('waits for JetBrains Mono, which xterm measures its cells with', async () => {
    const load = vi.fn(() => Promise.resolve([]));
    await terminalFontReady({ load });
    expect(load).toHaveBeenCalledWith(TERMINAL_FONT);
    expect(TERMINAL_FONT).toMatch(/'JetBrains Mono'/);
  });

  it('lets the terminals open with the fallback font if loading fails', async () => {
    const load = vi.fn(() => Promise.reject(new Error('no font')));
    await expect(terminalFontReady({ load })).resolves.toBeUndefined();
  });
});
