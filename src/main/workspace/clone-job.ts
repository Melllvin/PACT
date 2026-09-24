import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { toIpcError, type IpcEvent } from '../../shared/ipc';
import type { GitService } from '../git/git-service';
import type { WorkspaceService } from './workspace-service';

// US1 scenario 2 — clone with visible progress, then open the repository as a workspace.

type Options = {
  git: GitService;
  workspaces: WorkspaceService;
  emit: (event: IpcEvent<'clone:progress'>) => void;
};

/** null when the folder does not exist, false when it exists with content. */
async function isEmptyOrMissing(path: string): Promise<boolean | null> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return null;
  }
}

export class CloneJobs {
  private readonly git: GitService;
  private readonly workspaces: WorkspaceService;
  private readonly emit: Options['emit'];

  constructor({ git, workspaces, emit }: Options) {
    this.git = git;
    this.workspaces = workspaces;
    this.emit = emit;
  }

  /** Starts a clone in the background; progress, failure and completion arrive as events. */
  start({ url, destination }: { url: string; destination: string }): { jobId: string } {
    const jobId = randomUUID();
    void this.run(jobId, url, destination);
    return { jobId };
  }

  private async run(jobId: string, url: string, destination: string) {
    const state = await isEmptyOrMissing(destination);
    if (state === false) {
      this.fail(jobId, `Le dossier « ${destination} » existe déjà et n'est pas vide.`);
      return;
    }
    try {
      await this.git.clone(url, destination, ({ percent, phase }) => {
        this.emit({ jobId, percent, phase });
      });
    } catch (error) {
      // Only remove what the clone created: never a folder that existed before.
      if (state === null) await rm(destination, { recursive: true, force: true });
      this.fail(jobId, toIpcError(error).message);
      return;
    }
    try {
      this.emit({ jobId, workspace: await this.workspaces.open(destination) });
    } catch (error) {
      this.emit({ jobId, error: toIpcError(error) });
    }
  }

  private fail(jobId: string, message: string) {
    this.emit({ jobId, error: { code: 'CLONE_FAILED', message } });
  }
}
