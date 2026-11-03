import { describe, expect, it, vi } from 'vitest';
import { createAgentTools } from '../../../../src/main/orchestrator/agent-tools';

// 004 T020 — submit_report gives the loop's refusal back to the agent (FR-020).

const report = {
  issue: '0012-connexion',
  status: 'done',
  summary: 'Fait',
  files: [],
  checks: [{ command: 'npm test', exitCode: 0 }],
  verdict: { result: 'accepted', defects: [] },
};

const submit = (onReport?: () => Promise<string | null>) => {
  const [tool] = createAgentTools(onReport ? { onReport } : {}, 'a1');
  if (!tool) throw new Error('no tool');
  return tool.call(report);
};

describe('submit_report', () => {
  it('tells the agent why its verdict is rejected', async () => {
    const onReport = vi.fn(() => Promise.resolve('Verdict rejeté : le test a modifié src/a.ts.'));
    await expect(submit(onReport)).resolves.toEqual({
      content: [{ type: 'text', text: 'Verdict rejeté : le test a modifié src/a.ts.' }],
      isError: true,
    });
  });

  it('receives the report when the loop takes it, or without a loop', async () => {
    for (const result of [await submit(() => Promise.resolve(null)), await submit()]) {
      expect(result.isError).toBeUndefined();
      expect(result.content[0]).toEqual({ type: 'text', text: 'Rapport reçu.' });
    }
  });
});
