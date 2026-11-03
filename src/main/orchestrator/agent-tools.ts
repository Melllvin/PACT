import { handoffReportSchema, missingFields, type HandoffReport } from '../../shared/report';
import type { McpTool } from './mcp';

// 004 R5 — what an agent with a role other than orchestrator reaches PACT for: its hand-off report.

export type AgentToolDependencies = {
  /** A valid report, for the loop of its issue and the orchestrator (US2): why it is refused, or `null`. */
  onReport?: (agentId: string, report: HandoffReport) => Promise<string | null>;
};

export function createAgentTools(deps: AgentToolDependencies, agentId: string): McpTool[] {
  return [
    {
      name: 'submit_report',
      description:
        'Rend le rapport de relais de ton travail sur une issue (contrat pact-contract.md).',
      inputSchema: {
        type: 'object',
        properties: {
          issue: { type: 'string' },
          status: { type: 'string', enum: ['done', 'blocked', 'defects'] },
          summary: { type: 'string', minLength: 1, maxLength: 2000 },
          files: { type: 'array', items: { type: 'string' } },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { command: { type: 'string' }, exitCode: { type: 'integer' } },
              required: ['command', 'exitCode'],
            },
          },
          questions: { type: 'array', items: { type: 'string' } },
          verdict: {
            type: 'object',
            properties: {
              result: { type: 'string', enum: ['accepted', 'defects'] },
              defects: { type: 'array', items: { type: 'string' } },
            },
            required: ['result', 'defects'],
          },
        },
        required: ['issue', 'status', 'summary', 'files', 'checks'],
      },
      call: async (args) => {
        const parsed = handoffReportSchema.safeParse(args);
        if (!parsed.success) {
          const fields = missingFields(args).join(', ');
          return {
            content: [{ type: 'text', text: `Rapport incomplet ou invalide : ${fields}.` }],
            isError: true,
          };
        }
        const refusal = (await deps.onReport?.(agentId, parsed.data)) ?? null;
        if (refusal !== null) return { content: [{ type: 'text', text: refusal }], isError: true };
        return {
          content: [
            { type: 'text', text: 'Rapport reçu.' },
            { type: 'text', text: JSON.stringify({ received: true }) },
          ],
        };
      },
    },
  ];
}
