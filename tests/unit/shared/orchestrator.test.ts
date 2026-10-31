import { describe, expect, it } from 'vitest';
import {
  integrationRequestSchema,
  orchestratorActionSchema,
  orchestratorEventSchema,
} from '../../../src/shared/orchestrator';

// 003 T001 — what the orchestrator asks, what it hears back, what it did (data-model.md).

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-10-31T10:00:00.000Z';

describe('integrationRequestSchema', () => {
  const request = { id: uuid(1), agentId: uuid(2), message: 'Ajoute le total', requestedAt: now };

  it('squashes by default', () => {
    expect(integrationRequestSchema.parse(request).mode).toBe('squash');
    expect(integrationRequestSchema.parse({ ...request, mode: 'keep-commits' }).mode).toBe(
      'keep-commits',
    );
  });

  it('needs a message of 1 to 4 000 characters', () => {
    expect(integrationRequestSchema.safeParse({ ...request, message: '' }).success).toBe(false);
    expect(
      integrationRequestSchema.safeParse({ ...request, message: 'x'.repeat(4000) }).success,
    ).toBe(true);
    expect(
      integrationRequestSchema.safeParse({ ...request, message: 'x'.repeat(4001) }).success,
    ).toBe(false);
  });
});

describe('orchestratorEventSchema', () => {
  it('knows the five kinds, an integration carrying its outcome', () => {
    for (const kind of ['turn-finished', 'awaiting-answer', 'error', 'closed'] as const) {
      expect(
        orchestratorEventSchema.safeParse({
          at: now,
          agentId: uuid(2),
          kind,
          state: 'done',
          summary: '',
        }).success,
      ).toBe(true);
    }
    expect(
      orchestratorEventSchema.parse({
        at: now,
        agentId: uuid(2),
        kind: 'integration',
        state: 'done',
        summary: 'Intégré',
        integration: { outcome: 'integrated', commit: 'a'.repeat(40) },
      }).integration,
    ).toEqual({ outcome: 'integrated', commit: 'a'.repeat(40) });
    expect(
      orchestratorEventSchema.safeParse({
        at: now,
        agentId: uuid(2),
        kind: 'integration',
        state: 'done',
        summary: '',
        integration: { outcome: 'merged' },
      }).success,
    ).toBe(false);
  });
});

describe('orchestratorActionSchema', () => {
  const action = {
    id: uuid(3),
    at: now,
    tool: 'send_prompt',
    agentId: uuid(2),
    summary: 'Refactore l’auth',
    outcome: 'ok',
    reason: null,
  };

  it('logs the five action tools, never the reads', () => {
    for (const tool of [
      'send_prompt',
      'launch_agent',
      'close_agent',
      'request_integration',
      'run_tests',
    ]) {
      expect(orchestratorActionSchema.safeParse({ ...action, tool }).success).toBe(true);
    }
    for (const tool of ['list_agents', 'get_changes', 'wait_for_agents']) {
      expect(orchestratorActionSchema.safeParse({ ...action, tool }).success).toBe(false);
    }
  });

  it('keeps a summary of 200 characters at most, and the reason of a refusal', () => {
    expect(
      orchestratorActionSchema.safeParse({ ...action, summary: 'x'.repeat(201) }).success,
    ).toBe(false);
    expect(
      orchestratorActionSchema.parse({
        ...action,
        agentId: null,
        outcome: 'refused',
        reason: 'Six agents au plus',
      }),
    ).toMatchObject({ outcome: 'refused', reason: 'Six agents au plus' });
  });
});
