import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceView,
  type ReviewBinding,
} from '../../../../src/renderer/workspace/WorkspaceView';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// fix-todo-diff-notifications — « ◆ Décider » in the Agents column, the size of a review, a clicked notification.

const workspaceOf = (agents: Workspace['agents']): Workspace => ({
  id: 'w1',
  path: '/w',
  name: 'w',
  mainBranch: 'main',
  agents,
  freeTerminals: [],
  quickLaunchCounters: { freeTerminal: 0 },
  permissionOverride: null,
  testCommand: null,
  integrationRequests: [],
  delivery: { auto: false, mergeMode: 'squash', maxRounds: 3, polishPasses: 0, polishBrief: '' },
  deliveries: [],
  roleProfiles: {},
  issues: [],
  loops: [],
  testPaths: [...DEFAULT_TEST_PATHS],
  publishRequests: [],
  exchanges: { messages: [], escalations: [] },
  lastOpenedAt: '2026-09-24T10:00:00.000Z',
  status: 'available',
});

const binding = (overrides: Partial<ReviewBinding> = {}): ReviewBinding => ({
  pending: [],
  snapshot: null,
  selected: null,
  diff: null,
  error: null,
  open: vi.fn(),
  close: vi.fn(),
  select: vi.fn(),
  markSeen: vi.fn(),
  tests: {},
  decisions: {},
  notice: null,
  runTests: vi.fn(),
  cancelTests: vi.fn(),
  setTestCommand: vi.fn(),
  integrate: vi.fn(),
  dismissNotice: vi.fn(),
  comment: vi.fn(),
  send: vi.fn(),
  correcting: {},
  integrations: {},
  resolveConflict: vi.fn(),
  openInEditor: vi.fn(),
  askAgent: vi.fn(),
  finishIntegration: vi.fn(),
  cancelIntegration: vi.fn(),
  ...overrides,
});

const terminals = { attach: vi.fn(() => () => undefined) };
const blocked = agent(1, {
  state: 'done',
  role: 'spec',
  lastReport: { status: 'blocked', questions: ['Quelle base ?', 'Quel nom ?'] },
});

describe('« ◆ Décider » in the Agents column', () => {
  it('shows the questions and sends the answer to the agent as a prompt', async () => {
    const user = userEvent.setup();
    const review = binding();
    render(
      <WorkspaceView workspace={workspaceOf([blocked])} terminals={terminals} review={review} />,
    );
    const item = screen.getByRole('complementary', { name: 'Agents' });
    expect(within(item).getByText('Quelle base ?')).toBeDefined();
    expect(within(item).getByText('Quel nom ?')).toBeDefined();
    const send = within(item).getByRole('button', { name: 'Envoyer' });
    expect(send.hasAttribute('disabled')).toBe(true);
    await user.type(within(item).getByRole('textbox', { name: 'Réponse à l’agent' }), 'main, PACT');
    await user.click(send);
    expect(review.send).toHaveBeenCalledWith(blocked.id, 'request', 'main, PACT');
  });

  it('sends nothing without a review binding', async () => {
    const user = userEvent.setup();
    render(<WorkspaceView workspace={workspaceOf([blocked])} terminals={terminals} />);
    await user.type(screen.getByRole('textbox', { name: 'Réponse à l’agent' }), 'oui');
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    expect(screen.getByRole('textbox', { name: 'Réponse à l’agent' })).toHaveProperty('value', '');
  });
});

describe('« Changements à relire » names its agent and its size', () => {
  it('reads the number of files of the review binding', () => {
    const done = agent(2, { state: 'done', role: 'dev' });
    render(
      <WorkspaceView
        workspace={workspaceOf([done])}
        terminals={terminals}
        review={binding({ pending: [done.id], files: { [done.id]: 3 } })}
      />,
    );
    expect(screen.getByText('Changements à relire')).toBeDefined();
    expect(screen.getByText('claude-code 2')).toBeDefined();
    expect(screen.getByText('dev · 3 fichiers')).toBeDefined();
  });

  it('names no size when the payload carries none', () => {
    const done = agent(2, { state: 'done' });
    render(
      <WorkspaceView
        workspace={workspaceOf([done])}
        terminals={terminals}
        review={binding({ pending: [done.id] })}
      />,
    );
    expect(screen.getByText('claude-code 2')).toBeDefined();
  });
});

describe('a clicked notification', () => {
  const view = (request: { workspaceId: string; agentId: string } | null, team = [agent(1)]) => (
    <WorkspaceView workspace={workspaceOf(team)} terminals={terminals} focusRequest={request} />
  );

  it('puts the view on the terminal of its agent', () => {
    const team = [agent(1), agent(2)];
    const { rerender } = render(view(null, team));
    expect(screen.queryByRole('region', { name: 'Focus : claude-code 2' })).toBeNull();
    rerender(view({ workspaceId: 'w1', agentId: agent(2).id }, team));
    expect(screen.getByRole('region', { name: 'Focus : claude-code 2' })).toBeDefined();
  });

  it('ignores a request for another workspace or an unknown agent', () => {
    const { rerender } = render(view(null));
    rerender(view({ workspaceId: 'w2', agentId: agent(1).id }));
    rerender(view({ workspaceId: 'w1', agentId: agent(9).id }));
    expect(screen.queryByRole('region', { name: /Focus/ })).toBeNull();
  });
});
