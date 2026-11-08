import { z } from 'zod';
import { integrationOutcomeSchema } from './exchanges';
import { agentStateSchema, integrationRequestSchema } from './model';

export { integrationRequestSchema };

// 003 data-model.md — what the orchestrator asks, what it hears back, and what it did.

const isoDate = z.iso.datetime();

/** What wakes `wait_for_agents` (research R5). */
export const orchestratorEventSchema = z.object({
  at: isoDate,
  agentId: z.uuid(),
  kind: z.enum([
    'turn-finished',
    'awaiting-answer',
    'error',
    'closed',
    'integration',
    // 007 — a question of a report.
    'question',
    // 004 US2 — reports and loops.
    'report',
    'report-missing',
    'loop',
    // 004 US3 — the issues published, or not.
    'publish',
    // 004 US4 — the user's decision on a mockup.
    'mockup',
  ]),
  state: agentStateSchema,
  summary: z.string(),
  integration: integrationOutcomeSchema.optional(),
});

/** The tools that act; reads and waits are not logged (FR-021). */
export const ORCHESTRATOR_ACTION_TOOLS = [
  'send_prompt',
  'launch_agent',
  'close_agent',
  'request_integration',
  'run_tests',
  'start_loop',
  'next_round',
  'publish_issues',
] as const;

export const orchestratorActionSchema = z.object({
  id: z.uuid(),
  at: isoDate,
  tool: z.enum(ORCHESTRATOR_ACTION_TOOLS),
  agentId: z.uuid().nullable(),
  summary: z.string().max(200),
  outcome: z.enum(['ok', 'refused']),
  reason: z.string().nullable(),
});

export type IntegrationRequest = z.infer<typeof integrationRequestSchema>;
export type OrchestratorEvent = z.infer<typeof orchestratorEventSchema>;
export type OrchestratorAction = z.infer<typeof orchestratorActionSchema>;
