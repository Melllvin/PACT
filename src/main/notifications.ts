import type { TodoItem, TodoKind } from '../shared/model';

// fix-todo-diff-notifications — a system notification once per new item that needs the user, while
// PACT is in the background. Only the title of the item travels, never the text of an agent:
// an item whose title holds some (issue titles, an issue id) is notified under a fixed title.

export type Notification = {
  title: string;
  workspaceId: string;
  agentId: string;
  onClick: () => void;
};
export type Notify = (notification: Notification) => void;

/** The kinds that call the user away from what they do: the rest stays in À faire. */
const NOTIFIED: ReadonlySet<TodoKind> = new Set([
  'answer',
  'decide',
  'delivery-local',
  'publish-issues',
  'loop-escalated',
  'exchange-escalated',
  'rate-limit',
  'usage-limit',
]);

/** Fixed titles of the items whose own title holds text an agent wrote (issue titles, issue id). */
const GENERIC_TITLE: Partial<Record<TodoKind, string>> = {
  'publish-issues': '◎ Issues à publier',
  'loop-escalated': '✕ Boucle arrêtée',
  'exchange-escalated': '✕ Échanges en boucle',
};

export class NotificationService {
  /** The ids of the notified items still listed, per workspace: gone and back, it notifies again. */
  private readonly shown = new Map<string, Set<string>>();

  constructor(
    private readonly options: {
      notify: Notify;
      activate: (target: { workspaceId: string; agentId: string }) => void;
      isForeground: () => boolean;
      /** « Claude Code 2 »: the name of an agent, from PACT's own data. */
      agentLabel?: (target: { workspaceId: string; agentId: string }) => string | null;
    },
  ) {}

  /** The À faire items of a workspace as they are now. */
  update(workspaceId: string, todos: readonly TodoItem[]): void {
    const wanted = todos.filter((todo) => NOTIFIED.has(todo.kind));
    const known = this.shown.get(workspaceId) ?? new Set<string>();
    this.shown.set(workspaceId, new Set(wanted.map((todo) => todo.id)));
    if (this.options.isForeground()) return;
    for (const todo of wanted) {
      if (known.has(todo.id)) continue;
      this.options.notify({
        title: this.titleOf(workspaceId, todo),
        workspaceId,
        agentId: todo.agentId,
        onClick: () => {
          this.options.activate({ workspaceId, agentId: todo.agentId });
        },
      });
    }
  }

  private titleOf(workspaceId: string, todo: TodoItem): string {
    const generic = GENERIC_TITLE[todo.kind];
    if (generic === undefined) return todo.title;
    const label = this.options.agentLabel?.({ workspaceId, agentId: todo.agentId });
    return label ? `${generic} · ${label}` : generic;
  }
}

/**
 * In test mode nothing real is shown: what would have been sent is recorded in `sent`, for the
 * test to read. Otherwise `real` shows it.
 */
export function chooseNotify(
  env: Record<string, string | undefined>,
  real: Notify,
): { notify: Notify; sent: Notification[] } {
  const sent: Notification[] = [];
  if (env.PACT_TEST_MODE !== '1') return { notify: real, sent };
  return {
    notify: (notification) => {
      sent.push(notification);
    },
    sent,
  };
}
