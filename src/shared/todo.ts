import type { Agent, TodoItem } from './model.js';
const rank = { answer: 0, 'rate-limit': 1, prompt: 2, info: 3 } as const;
export function deriveTodos(agents: Agent[]): TodoItem[] {
  return agents
    .flatMap((agent): TodoItem[] => {
      if (agent.state === 'awaiting-answer')
        return [
          {
            id: `${agent.id}:answer`,
            agentId: agent.id,
            kind: 'answer',
            title: '◆ Répondre',
            actions: ['deny', 'allow'],
            color: agent.color,
          },
        ];
      if (agent.scheduledResume)
        return [
          {
            id: `${agent.id}:rate-limit`,
            agentId: agent.id,
            kind: 'rate-limit',
            title: `Reprise auto à ${new Date(agent.scheduledResume.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
            actions: ['cancel-resume'],
            color: agent.color,
          },
        ];
      if (agent.state === 'awaiting-prompt' || agent.state === 'done')
        return [
          {
            id: `${agent.id}:prompt`,
            agentId: agent.id,
            kind: 'prompt',
            title: `Donner une consigne · ${agent.cliId} · tapez dans le terminal`,
            actions: [],
            color: agent.color,
          },
        ];
      if (agent.state === 'error')
        return [
          {
            id: `${agent.id}:info`,
            agentId: agent.id,
            kind: 'info',
            title: `✕ ${agent.lastError?.message ?? 'Agent arrêté'}`,
            actions: ['log', 'restart', 'resume'],
            color: agent.color,
          },
        ];
      return [];
    })
    .sort((a, b) => rank[a.kind] - rank[b.kind]);
}
