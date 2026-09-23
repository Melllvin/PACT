import { it, expect } from 'vitest';
import { deriveTodos } from '../../../src/shared/todo';
import type { Agent } from '../../../src/shared/model';
const agent = (state: Agent['state']): Agent => ({
  id: '00000000-0000-4000-8000-000000000000',
  workspaceId: 'w',
  position: 1,
  color: 'purple',
  cliId: 'fake',
  model: null,
  permissionLevel: 'always-ask',
  baseBranch: 'main',
  branch: 'agent/fake-1',
  worktreePath: '/tmp/w',
  port: 3001,
  startCommand: null,
  sessionId: null,
  initialPrompt: null,
  alwaysAllowRules: [],
  state,
  lastError: null,
  scheduledResume: null,
});
it('puts answers before prompts', () =>
  expect(
    deriveTodos([
      agent('awaiting-prompt'),
      { ...agent('awaiting-answer'), id: '10000000-0000-4000-8000-000000000000' },
    ]).map((x) => x.kind),
  ).toEqual(['answer', 'prompt']));
