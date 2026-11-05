import { describe, expect, it, vi } from 'vitest';
import { chooseNotify, NotificationService } from '../../../src/main/notifications';
import type { TodoItem, TodoKind } from '../../../src/shared/model';

// fix-todo-diff-notifications — a system notification once per new item that needs the user, only
// while PACT is in the background. Hypotheses of interface, to follow (see the report):
// `new NotificationService({ notify, isForeground, activate })`, `update(workspaceId, todos)`,
// `notify({ title, workspaceId, agentId, onClick })`, and `chooseNotify(env, real)` returning
// `{ notify, sent }`: in test mode, `sent` records what would have been shown and `real` is never called.

const item = (kind: TodoKind, id = 'a1', extra: Partial<TodoItem> = {}): TodoItem => ({
  id: `${id}:${kind}`,
  agentId: id,
  kind,
  title: `Titre ${kind}`,
  actions: [],
  ...extra,
});

const setup = (foreground = false) => {
  const notify = vi.fn();
  const activate = vi.fn();
  const state = { foreground };
  const service = new NotificationService({
    notify,
    activate,
    isForeground: () => state.foreground,
  });
  return { service, notify, activate, state };
};

const NOTIFIED: TodoKind[] = [
  'answer',
  'decide',
  'integration-request',
  'publish-issues',
  'loop-escalated',
  'rate-limit',
  'usage-limit',
];

describe('NotificationService', () => {
  it.each(NOTIFIED)('notifies a new « %s » item once, with its title', (kind) => {
    const { service, notify } = setup();
    service.update('w1', [item(kind)]);
    service.update('w1', [item(kind)]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: `Titre ${kind}`, workspaceId: 'w1', agentId: 'a1' }),
    );
  });

  it.each(['review', 'prompt', 'info'] as const)('never notifies a « %s » item', (kind) => {
    const { service, notify } = setup();
    service.update('w1', [item(kind)]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies nothing while PACT is in the foreground', () => {
    const { service, notify } = setup(true);
    service.update('w1', [item('answer')]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies again when an item disappears and comes back', () => {
    const { service, notify } = setup();
    service.update('w1', [item('answer')]);
    service.update('w1', []);
    service.update('w1', [item('answer')]);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('notifies for any open workspace, each item of each workspace once', () => {
    const { service, notify } = setup();
    service.update('w1', [item('answer')]);
    service.update('w2', [item('answer')]);
    service.update('w2', [item('answer'), item('rate-limit', 'a2')]);
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls.map(([n]) => (n as { workspaceId: string }).workspaceId)).toEqual([
      'w1',
      'w2',
      'w2',
    ]);
  });

  it('never carries the text of an agent: only the title of the item', () => {
    const { service, notify } = setup();
    service.update('w1', [
      item('integration-request', 'a1', {
        request: { id: 'r1', message: 'SECRET du message de l’agent' },
      }),
    ]);
    expect(JSON.stringify(notify.mock.calls)).not.toContain('SECRET');
  });

  it('brings PACT to the workspace and the agent of the item when it is clicked', () => {
    const { service, notify, activate } = setup();
    service.update('w1', [item('answer', 'a7')]);
    (notify.mock.calls[0]?.[0] as { onClick: () => void }).onClick();
    expect(activate).toHaveBeenCalledWith({ workspaceId: 'w1', agentId: 'a7' });
  });
});

describe('chooseNotify', () => {
  const note = { title: 'T', workspaceId: 'w1', agentId: 'a1', onClick: () => undefined };

  it('shows no real notification in test mode, and lets the test see what was sent', () => {
    const real = vi.fn();
    const { notify, sent } = chooseNotify({ PACT_TEST_MODE: '1' }, real);
    notify(note);
    expect(real).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: 'T', workspaceId: 'w1', agentId: 'a1' });
  });

  it('shows the real notification outside test mode', () => {
    const real = vi.fn();
    chooseNotify({}, real).notify(note);
    expect(real).toHaveBeenCalledWith(note);
  });
});
