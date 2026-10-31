import { z } from 'zod';
import { agentStateSchema, gitIdSchema, integrationRequestSchema } from './model';

export { integrationRequestSchema };

// 003 data-model.md — what the orchestrator asks, what it hears back, and what it did.

const isoDate = z.iso.datetime();

/** What wakes `wait_for_agents` (research R5). */
export const orchestratorEventSchema = z.object({
  at: isoDate,
  agentId: z.uuid(),
  kind: z.enum(['turn-finished', 'awaiting-answer', 'error', 'closed', 'integration']),
  state: agentStateSchema,
  summary: z.string(),
  integration: z
    .object({
      outcome: z.enum(['integrated', 'refused', 'conflicted', 'failed']),
      commit: gitIdSchema.optional(),
      files: z.array(z.string()).optional(),
    })
    .optional(),
});

/** The tools that act; reads and waits are not logged (FR-021). */
export const ORCHESTRATOR_ACTION_TOOLS = [
  'send_prompt',
  'launch_agent',
  'close_agent',
  'request_integration',
  'run_tests',
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
