import type { Agent } from './model';

/** The name shown for an agent (006 #45): the one the user gave, else « <CLI> <position> ». */
export const agentName = (
  agent: Pick<Agent, 'name' | 'cliId' | 'position'>,
  cliName: (cliId: string) => string,
): string => agent.name ?? `${cliName(agent.cliId)} ${String(agent.position)}`;
