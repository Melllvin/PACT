import { z } from 'zod';
import { agentStateSchema, gitIdSchema, isoDate } from './primitives';

// 007 data-model.md — the journal of the exchanges between the agents and of the events of PACT, and
// the rules that say who may write to whom.

export const MAX_MESSAGE = 500;
export const MAX_NOTICE = 2000;
export const MAX_INSTRUCTION = 8000;
export const MAX_EVENTS = 20;
export const MAX_EVENT_SUMMARY = 200;
export const MAX_TURN_MESSAGES = 5;
export const MAX_ROUND_TRIPS = 3;
export const MAX_JOURNAL = 500;
export const WAKE_GROUP_MS = 5000;
export const MAX_WAKES_PER_HOUR = 20;
export const HELD_INPUT_NOTICE_MS = 120_000;

export const EXCHANGE_KINDS = [
  'question',
  'message',
  'instruction',
  'report',
  'error',
  'loop',
  'report-missing',
  'integration',
  'delivery',
  'publish',
  'mockup',
  'verdict',
  'exchange-escalated',
  'exchange-decided',
  'turn-finished',
  'closed',
  'awaiting-answer',
  'overlap',
] as const;
export type ExchangeKind = (typeof EXCHANGE_KINDS)[number];

export const exchangeTypeSchema = z.enum(['action', 'info']);
export type ExchangeType = z.infer<typeof exchangeTypeSchema>;

const INFO_KINDS: readonly ExchangeKind[] = [
  'turn-finished',
  'closed',
  'awaiting-answer',
  'overlap',
];

/** R3 — `info` for the states, `action` for the rest; the sender of a message chooses. */
export function typeOf(kind: ExchangeKind, chosen?: ExchangeType): ExchangeType {
  if (kind === 'message') return chosen ?? 'action';
  return INFO_KINDS.includes(kind) ? 'info' : 'action';
}

/** The longest text a message of this kind may hold. */
export const maxText = (kind: ExchangeKind): number =>
  kind === 'message' ? MAX_MESSAGE : kind === 'instruction' ? MAX_INSTRUCTION : MAX_NOTICE;

export const integrationOutcomeSchema = z.object({
  outcome: z.enum(['integrated', 'refused', 'conflicted', 'failed']),
  commit: gitIdSchema.optional(),
  files: z.array(z.string()).optional(),
});

/** 008 R21 — what a delivery tells the orchestrator: the outcome, and the PR and commit it concerns. */
export const DELIVERY_OUTCOMES = [
  'refused',
  'dropped',
  'conflicted',
  'tests-failed',
  'pr-opened',
  'ci-green',
  'ci-red',
  'review-requested',
  'user-refused',
  'merged',
  'merge-failed',
  'alert',
] as const;
export const deliveryOutcomeSchema = z.object({
  id: z.uuid(),
  outcome: z.enum(DELIVERY_OUTCOMES),
  pr: z.object({ number: z.int().positive(), url: z.string() }).optional(),
  commit: gitIdSchema.optional(),
  checks: z.array(z.string()).optional(),
});

export const exchangeMessageSchema = z
  .object({
    id: z.uuid(),
    at: isoDate,
    /** An agent, or PACT itself. */
    from: z.union([z.uuid(), z.literal('pact')]),
    to: z.uuid(),
    about: z.uuid().optional(),
    state: agentStateSchema.optional(),
    type: exchangeTypeSchema,
    kind: z.enum(EXCHANGE_KINDS),
    text: z.string(),
    integration: integrationOutcomeSchema.optional(),
    delivery: deliveryOutcomeSchema.optional(),
    unreadBy: z.array(z.uuid()),
  })
  .superRefine((message, ctx) => {
    if (message.text.length > maxText(message.kind)) {
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'text too long for its kind' });
    }
  });

export const exchangeEscalationSchema = z.object({
  id: z.uuid(),
  agents: z.tuple([z.uuid(), z.uuid()]),
  lastMessageId: z.uuid(),
  state: z.enum(['pending', 'cut']),
  at: isoDate,
});

/** The journal as it travels (`workspace:exchanges`): always whole. */
export const exchangesPayloadSchema = z.object({
  messages: z.array(exchangeMessageSchema).default([]),
  escalations: z.array(exchangeEscalationSchema).default([]),
});

/** In a workspace file: absent in the ones saved before 007. */
export const exchangesSchema = exchangesPayloadSchema.default(() => ({
  messages: [],
  escalations: [],
}));

export type ExchangeMessage = z.infer<typeof exchangeMessageSchema>;
export type ExchangeEscalation = z.infer<typeof exchangeEscalationSchema>;
export type Exchanges = z.infer<typeof exchangesSchema>;

type Party = { id: string; role: string | null | undefined };
export type CanSend = { ok: true; copy: boolean } | { ok: false; reason: string };

const refuse = (reason: string): CanSend => ({ ok: false, reason });

/** contracts/mcp-tools.md — the matrix of `send_message`, one place (R10). */
export function canSend(from: Party, to: Party, leadId: string | null): CanSend {
  if (leadId === null) return refuse('Aucun orchestrateur dans ce workspace.');
  if (from.id === to.id) return refuse('Tu ne peux pas t’écrire à toi-même (soi-même).');
  const ask = 'Passe par ask_orchestrator.';
  if (from.id === leadId) return { ok: true, copy: false };
  if (from.role === 'test') return refuse(`Le testeur n’écrit à personne. ${ask}`);
  if (to.id === leadId) return refuse(`Tu n’écris pas directement à l’orchestrateur. ${ask}`);
  if (to.role === 'test') {
    return from.role === 'dev'
      ? refuse('Le dev ne parle pas au testeur : seuls le verdict et git passent.')
      : refuse('Passe par l’orchestrateur pour joindre le testeur.');
  }
  return { ok: true, copy: true };
}

const POINTER = /^(\d+) événements?, lis (get_events|\.pact\/events\.md)$/;

/** One line, without any text of an agent (R11). */
export function pointerText(count: number, file?: string): string {
  return `${String(count)} événement${count > 1 ? 's' : ''}, lis ${file ?? 'get_events'}`;
}

export function isPointer(text: string): boolean {
  return POINTER.test(text);
}
