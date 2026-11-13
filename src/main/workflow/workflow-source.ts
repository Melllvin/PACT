import type { Workspace } from '../../shared/model';
import { loadWorkflow } from '../../shared/workflow-yaml';
import {
  WORKFLOW_PATH,
  defaultWorkflow,
  ignoredLocal,
  type IgnoredSetting,
  type Workflow,
  type WorkflowIssue,
} from '../../shared/workflow';
import type { GitService } from '../git/git-service';

// 010 R10 — what the main branch says of the workflow: the blob `.pact/workflow.yaml` of `origin/<main>`
// after a fetch, else of `<main>`; never a worktree (FR-007), never written (FR-011). No file: the default
// workflow of the settings of 008 (R11).

export type WorkflowSourceDeps = {
  git: Pick<GitService, 'entry' | 'readBlob' | 'fetchRefs' | 'hasOrigin' | 'revParse'>;
  workspaces: { get(id: string): Pick<Workspace, 'path' | 'mainBranch' | 'delivery'> | undefined };
  /** The shortest time between two fetches of the same project. */
  fetchEveryMs?: number;
  now?: () => number;
};

export type CurrentWorkflow = {
  /** `file`: the blob of the main branch; `default`: no file (or one that cannot be used). */
  source: 'file' | 'default';
  /** The id of the blob, or `default`. */
  oid: string;
  workflow: Workflow;
  /** The settings of 008 that the file overrides with another value (US3 sc.6). */
  ignoredLocal: IgnoredSetting[];
  /** The second-phase features found in the file (kept, never run). */
  phase2: WorkflowIssue[];
  /** The errors of a file that cannot be used; the default stands in (the handling is for the editor). */
  errors: WorkflowIssue[];
};

export class WorkflowSource {
  private readonly fetchedAt = new Map<string, number>();

  constructor(private readonly deps: WorkflowSourceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The blob of the workflow on the main branch: the reference that exists, `origin/<main>` first. */
  private async blob(
    path: string,
    main: string,
  ): Promise<{ oid: string; text: string } | null | 'none'> {
    for (const ref of [`origin/${main}`, main]) {
      try {
        await this.deps.git.revParse(path, ref);
      } catch {
        continue;
      }
      const entry = await this.deps.git.entry(path, ref, WORKFLOW_PATH);
      if (!entry) return null;
      return { oid: entry.oid, text: await this.deps.git.readBlob(path, entry.oid) };
    }
    return 'none';
  }

  /** The workflow in force for a project, at this time. */
  async current(workspaceId: string): Promise<CurrentWorkflow> {
    const ws = this.deps.workspaces.get(workspaceId);
    if (!ws) throw new Error(`Workspace inconnu : ${workspaceId}`);
    const fallback = (errors: WorkflowIssue[] = []): CurrentWorkflow => ({
      source: 'default',
      oid: 'default',
      workflow: defaultWorkflow(ws.delivery),
      ignoredLocal: [],
      phase2: [],
      errors,
    });
    const last = this.fetchedAt.get(workspaceId);
    if (last === undefined || this.now() - last >= (this.deps.fetchEveryMs ?? 10_000)) {
      this.fetchedAt.set(workspaceId, this.now());
      if (await this.deps.git.hasOrigin(ws.path)) {
        await this.deps.git.fetchRefs(ws.path, [ws.mainBranch]);
      }
    }
    const found = await this.blob(ws.path, ws.mainBranch).catch(() => 'none' as const);
    if (found === null || found === 'none') return fallback();
    const loaded = loadWorkflow(found.text);
    if (!loaded.workflow) return fallback(loaded.errors);
    return {
      source: 'file',
      oid: found.oid,
      workflow: loaded.workflow,
      ignoredLocal: ignoredLocal(ws.delivery, loaded.workflow),
      phase2: loaded.phase2,
      errors: [],
    };
  }
}
