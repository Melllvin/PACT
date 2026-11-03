import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { IpcFailure } from '../../shared/ipc';
import type { Agent, Workspace } from '../../shared/model';
import { previewKind, type PreviewFile } from '../../shared/preview';
import type { Notice } from '../orchestrator/orchestrator-service';
import type { Watch } from '../review/review-service';

// 004 US4 — what the Aperçu of an agent lists, its refreshes, and the user's decision on a mockup
// told to the orchestrator (FR-025, FR-027, FR-028).

type Options = {
  workspaces: { list(): Workspace[] };
  watch: Watch;
  /** `preview:changed`: a listed file of the agent changed. */
  onChanged: (agentId: string, path: string) => void;
  /** The orchestrators of the workspace hear of the decision (`mockup`). */
  notify: (workspaceId: string, notice: Notice) => void;
  debounceMs?: number;
};

type Followed = { stop: () => void; timers: Map<string, ReturnType<typeof setTimeout>> };

/** The recap first (US5), then the mockups, then the issues. */
const ORDER: PreviewFile['kind'][] = ['recap', 'mockup', 'issue', 'other'];

const names = async (dir: string) => {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
};

export class PreviewService {
  private readonly followed = new Map<string, Followed>();

  constructor(private readonly options: Options) {}

  /** The worktree of an open agent, for the `pact-preview:` protocol. */
  worktreeOf(agentId: string): string | null {
    return this.find(agentId)?.agent.worktreePath ?? null;
  }

  /** Lists the files of the Aperçu and follows the worktree until the agent is gone. */
  async list(agentId: string): Promise<PreviewFile[]> {
    const found = this.find(agentId);
    if (!found) throw new IpcFailure('NOT_FOUND', 'Cet agent n’est plus ouvert.');
    const root = found.agent.worktreePath;
    const candidates = [
      ...(await names(join(root, '.pact'))).map((n) => `.pact/${n}`),
      ...(await names(join(root, 'design', 'mockups'))).map((n) => `design/mockups/${n}`),
      ...(await names(join(root, '.pact', 'issues'))).map((n) => `.pact/issues/${n}`),
    ];
    const files = candidates.flatMap((path): PreviewFile[] => {
      const kind = previewKind(path);
      return kind === null ? [] : [{ path, kind }];
    });
    this.follow(found.agent);
    return files.sort(
      (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.path.localeCompare(b.path),
    );
  }

  /** « ✓ Valider » / « ✕ Refuser » on a mockup, told to the orchestrator (FR-028, SC-004). */
  decide(agentId: string, path: string, decision: 'validated' | 'refused', comment?: string): void {
    const found = this.find(agentId);
    if (!found) throw new IpcFailure('NOT_FOUND', 'Cet agent n’est plus ouvert.');
    if (previewKind(path) !== 'mockup') {
      throw new IpcFailure('INVALID_INPUT', `« ${path} » n’est pas une maquette.`);
    }
    const said = comment?.trim() ? ` Commentaire : ${comment.trim()}` : '';
    const verdict = decision === 'validated' ? 'validée' : 'refusée';
    this.options.notify(found.workspace.id, {
      agentId,
      kind: 'mockup',
      summary: `maquette ${path} ${verdict} par l’utilisateur.${said}`,
    });
  }

  dispose(): void {
    for (const agentId of [...this.followed.keys()]) this.unfollow(agentId);
  }

  private follow(agent: Agent) {
    if (this.followed.has(agent.id)) return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const stop = this.options.watch(agent.worktreePath, (file) => {
      if (file === null || previewKind(file) === null) return;
      if (!this.find(agent.id)) {
        this.unfollow(agent.id);
        return;
      }
      clearTimeout(timers.get(file));
      timers.set(
        file,
        setTimeout(() => {
          timers.delete(file);
          this.options.onChanged(agent.id, file);
        }, this.options.debounceMs ?? 100),
      );
    });
    this.followed.set(agent.id, { stop, timers });
  }

  private unfollow(agentId: string) {
    const followed = this.followed.get(agentId);
    if (!followed) return;
    followed.stop();
    for (const timer of followed.timers.values()) clearTimeout(timer);
    this.followed.delete(agentId);
  }

  private find(agentId: string) {
    for (const workspace of this.options.workspaces.list()) {
      const agent = workspace.agents.find((a) => a.id === agentId);
      if (agent) return { workspace, agent };
    }
    return null;
  }
}
