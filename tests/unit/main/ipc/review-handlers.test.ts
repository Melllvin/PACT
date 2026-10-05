import { describe, expect, it, vi } from 'vitest';
import { createReviewServices } from '../../../../src/main/ipc/review-handlers';

// 002 T021, T034, T041 — the review channels, served by ReviewService, TestRunner and
// IntegrationService (contracts/ipc.md).

const agentId = '00000000-0000-4000-8000-000000000001';
const target = { agentId, cwd: '/wt', port: 3001 };

const setup = (command: string | null = 'npm test') => {
  const review = {
    open: vi.fn(() => Promise.resolve({ tree: 'shown', missing: false })),
    close: vi.fn(),
    fileDiff: vi.fn(() => Promise.resolve('diff')),
    setSeen: vi.fn(() => Promise.resolve()),
    updatePending: vi.fn(() => Promise.resolve([agentId])),
    testPlan: vi.fn(() => Promise.resolve({ target, command, tree: 'current' })),
    comment: vi.fn(() => Promise.resolve('comment')),
    send: vi.fn(() => Promise.resolve()),
  };
  const tests = {
    run: vi.fn(() => Promise.resolve('running')),
    ensure: vi.fn(() => Promise.resolve(undefined)),
    cancel: vi.fn(),
  };
  const integration = { start: vi.fn(() => Promise.resolve('integration')) };
  const workspaces = {
    update: vi.fn((_id: string, change: (ws: object) => object) =>
      Promise.resolve(change({ id: 'w1', testCommand: null })),
    ),
  };
  const services = createReviewServices({
    review: review as never,
    tests: tests as never,
    integration: integration as never,
    workspaces: workspaces as never,
  });
  return { services, review, tests, integration, workspaces };
};

describe('review handlers', () => {
  it('pass each request to the review service', async () => {
    const { services, review } = setup();
    expect(await services['review:open']({ agentId })).toEqual({ tree: 'shown', missing: false });
    services['review:close']({ agentId });
    expect(review.close).toHaveBeenCalledWith(agentId);
    expect(await services['review:fileDiff']({ agentId, path: 'a.ts' })).toBe('diff');
    expect(review.fileDiff).toHaveBeenCalledWith(agentId, 'a.ts');
    await services['review:setSeen']({ agentId, path: 'a.ts', seen: true });
    expect(review.setSeen).toHaveBeenCalledWith(agentId, 'a.ts', true);
    // Asked by the renderer once loaded: the events sent before its window existed are lost.
    expect(await services['review:listPending']({ workspaceId: 'w1' })).toEqual([agentId]);
    expect(review.updatePending).toHaveBeenCalledWith('w1');
  });

  it('runs the tests on opening, unless a result is for the tree shown (FR-016)', async () => {
    const { services, tests } = setup();
    await services['review:open']({ agentId });
    expect(tests.ensure).toHaveBeenCalledWith(target, 'npm test', 'shown');
  });

  it('opens the review even when the tests cannot start', async () => {
    const { services, tests } = setup();
    tests.ensure.mockRejectedValue(new Error('env'));
    expect(await services['review:open']({ agentId })).toEqual({ tree: 'shown', missing: false });
  });

  it('runs nothing on opening without a command, nor for a missing worktree', async () => {
    const none = setup(null);
    await none.services['review:open']({ agentId });
    expect(none.tests.ensure).not.toHaveBeenCalled();
    const gone = setup();
    gone.review.open.mockResolvedValue({ tree: 'x', missing: true });
    await gone.services['review:open']({ agentId });
    expect(gone.review.testPlan).not.toHaveBeenCalled();
  });

  it('runs and cancels the tests on request (FR-017)', async () => {
    const { services, tests } = setup();
    expect(await services['review:runTests']({ agentId })).toBe('running');
    expect(tests.run).toHaveBeenCalledWith(target, 'npm test', 'current');
    services['review:cancelTests']({ agentId });
    expect(tests.cancel).toHaveBeenCalledWith(agentId);
  });

  it('refuses to run tests that are not set up', async () => {
    const { services, tests } = setup(null);
    await expect(services['review:runTests']({ agentId })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(tests.run).not.toHaveBeenCalled();
  });

  it('saves the test command of the workspace, null to detect it again', async () => {
    const { services, workspaces } = setup();
    await services['workspace:setTestCommand']({ workspaceId: 'w1', command: 'make check' });
    expect(workspaces.update).toHaveBeenCalledWith('w1', expect.any(Function));
    expect(await workspaces.update.mock.results[0]?.value).toEqual({
      id: 'w1',
      testCommand: 'make check',
    });
  });

  it('starts an integration (FR-019)', async () => {
    const { services, integration } = setup();
    const request = {
      agentId,
      mode: 'squash' as const,
      message: 'Ajoute le total',
      after: { closeTile: true, removeWorktree: true },
    };
    expect(await services['integration:start'](request)).toBe('integration');
    expect(integration.start).toHaveBeenCalledWith(request);
  });

  it('comments a line and sends instructions to the agent (FR-012, FR-013)', async () => {
    const { services, review } = setup();
    expect(
      await services['review:comment']({ agentId, path: 'a.ts', line: 3, text: 'Renommer.' }),
    ).toBe('comment');
    expect(review.comment).toHaveBeenCalledWith(agentId, 'a.ts', 3, 'Renommer.');
    await services['review:send']({ agentId, kind: 'request', text: 'Ajoute un test.' });
    expect(review.send).toHaveBeenCalledWith({ agentId, kind: 'request', text: 'Ajoute un test.' });
  });
});
