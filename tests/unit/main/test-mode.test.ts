import { describe, expect, it, vi } from 'vitest';
import { applyTestMode } from '../../../src/main/test-mode';

const fakeApp = () => ({ setPath: vi.fn() });

describe('applyTestMode', () => {
  it('redirects userData to the directory given by the e2e harness', () => {
    const app = fakeApp();
    applyTestMode(app, { PACT_TEST_MODE: '1', PACT_USER_DATA_DIR: '/tmp/pact-e2e-x' });
    expect(app.setPath).toHaveBeenCalledWith('userData', '/tmp/pact-e2e-x');
  });

  it('never touches userData outside test mode', () => {
    const app = fakeApp();
    applyTestMode(app, { PACT_USER_DATA_DIR: '/tmp/pact-e2e-x' });
    expect(app.setPath).not.toHaveBeenCalled();
  });

  it('keeps the default userData in test mode without a directory', () => {
    const app = fakeApp();
    applyTestMode(app, { PACT_TEST_MODE: '1' });
    expect(app.setPath).not.toHaveBeenCalled();
  });
});
