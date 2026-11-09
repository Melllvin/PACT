import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from './delivery-harness';

// 008 US6 — the edges of the resume and of the fall of a request: `gh` gone at the restart, a request
// that falls while its steps run, a loop closed already when its request falls. The main cases are in
// delivery-restart.test.ts and loop-agent-closed.test.ts.

let h: DeliveryHarness;

afterEach(async () => {
  await h.dispose();
});

const createCalls = () => h.ghLog().filter(([a, b]) => a === 'pr' && b === 'create');

describe('Given a request stopped before its PR and `gh` that is gone at the restart', () => {
  it('When PACT starts again, Then the request is refused with the reason, and nothing is pushed or created', async () => {
    h = await createDeliveryHarness({ pollMs: 50 });
    const { dev } = await h.team('a');
    h.gitCalls.pushBranch.mockImplementationOnce(() => new Promise(() => undefined));
    const request = await h.request(dev.id);
    await h.until(request.id, ['pushing']);
    h.gh.availability = () =>
      Promise.resolve({
        ok: false,
        reason: 'gh est absent de cette machine (introuvable).',
        remedy: 'Installe gh.',
      });

    await h.restart({ restore: false });

    const refused = await h.until(request.id, ['refused']);
    expect(refused.reason).toContain('gh est absent');
    expect(h.remoteHead('feat/a')).toBeNull();
    expect(createCalls()).toHaveLength(0);
  });
});

describe('Given a request that falls while its steps run (the user closes the dev)', () => {
  it('When the steps go on, Then they stop: nothing is pushed, no PR, and the request stays fallen', async () => {
    h = await createDeliveryHarness({ pollMs: 50 });
    const { dev } = await h.team('a');
    const gate = h.holdTests();
    const request = await h.request(dev.id);
    await h.until(request.id, ['testing']);
    await h.waitFor(() => h.testRuns.length > 0, 'the tests did not start');

    await h.delivery.agentClosed(dev.id);
    expect(h.deliveryOf(request.id).state).toBe('dropped');
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(h.deliveryOf(request.id).state).toBe('dropped');
    expect(h.remoteHead('feat/a')).toBeNull();
    expect(createCalls()).toHaveLength(0);
    expect(h.gitCalls.pushBranch).not.toHaveBeenCalled();
  });
});

describe('Given a loop that is closed already when its request falls', () => {
  it('When the dev is closed, Then the request falls and the orchestrator is not told twice about the loop', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { dev, issue } = await h.team('a');
    const request = await h.request(dev.id);
    await h.until(request.id, ['watching']);
    await h.workspaces.update(h.workspaceId, (ws) => ({
      ...ws,
      loops: ws.loops.map((l) => (l.issueId === issue ? { ...l, state: 'closed' as const } : l)),
    }));

    await h.delivery.agentClosed(dev.id);

    expect(h.deliveryOf(request.id).state).toBe('dropped');
    expect(h.notices.filter((n) => (n as { kind?: string }).kind === 'loop')).toHaveLength(0);
  });
});

describe('Given a request still at its barriers when PACT stopped', () => {
  it('When PACT starts again, Then it is not run again behind the barriers: it stays as it was', async () => {
    h = await createDeliveryHarness({ pollMs: 50 });
    const { dev } = await h.team('a');
    const request = await h.request(dev.id);
    await h.until(request.id, ['watching']);
    await h.workspaces.update(h.workspaceId, (ws) => ({
      ...ws,
      deliveries: ws.deliveries.map((d) =>
        d.id === request.id ? { ...d, state: 'checking' as const, pr: null } : d,
      ),
    }));

    await h.restart({ restore: false });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(h.deliveryOf(request.id).state).toBe('checking');
    expect(createCalls()).toHaveLength(1);
  });
});
