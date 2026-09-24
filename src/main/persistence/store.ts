import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  cliDefinitionSchema,
  permissionPreferenceSchema,
  recentProjectsSchema,
  workspaceSchema,
} from '../../shared/model';

// research.md R9 — JSON files in userData, validated by zod, written atomically.

export const SCHEMA_VERSION = 1;

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

let tmpCounter = 0;

/**
 * One JSON document on disk, wrapped as `{ schemaVersion, data }`.
 * Reads and writes are serialized per instance, so reuse one instance per file.
 */
export class JsonFile<T> {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly schema: z.ZodType<T>,
    private readonly defaults: () => T,
  ) {}

  read(): Promise<T> {
    return this.enqueue(() => this.readNow());
  }

  async write(value: T): Promise<void> {
    const data = this.schema.parse(value);
    await this.enqueue(() => this.writeNow(data));
  }

  private enqueue<R>(task: () => Promise<R>): Promise<R> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readNow(): Promise<T> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      // Only a missing file means "nothing saved yet"; anything else must not be masked,
      // or the next write would silently replace data we merely failed to read.
      if (isErrnoException(error) && error.code === 'ENOENT') return this.defaults();
      throw error;
    }
    const parsed = this.parse(raw);
    if (parsed.success) return parsed.data;
    await this.backUpUnreadable();
    return this.defaults();
  }

  private parse(raw: string): { success: true; data: T } | { success: false } {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { success: false };
    }
    const envelope = z.object({ schemaVersion: z.literal(SCHEMA_VERSION), data: this.schema });
    const result = envelope.safeParse(json);
    return result.success ? { success: true, data: result.data.data } : { success: false };
  }

  /** Keeps an unreadable file aside so falling back to defaults never destroys user data. */
  private async backUpUnreadable() {
    await rename(
      this.path,
      `${this.path}.corrupt-${new Date().toISOString().replaceAll(':', '-')}`,
    );
  }

  private async writeNow(data: T) {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${String(process.pid)}.${String(++tmpCounter)}.tmp`;
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify({ schemaVersion: SCHEMA_VERSION, data }, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.path);
  }
}

export const appStateSchema = z.object({
  /** Absolute paths of the workspaces open when the app was last closed (FR-005). */
  openWorkspaces: z.array(z.string()),
  recents: recentProjectsSchema,
  customClis: z.array(cliDefinitionSchema),
  /** Permission preference with the « Tous les projets » scope (FR-012, FR-035). */
  permission: permissionPreferenceSchema.nullable(),
});
export type AppState = z.infer<typeof appStateSchema>;

const emptyAppState = (): AppState => ({
  openWorkspaces: [],
  recents: [],
  customClis: [],
  permission: null,
});

/** Workspace ids are hashes of the repository path: anything else could escape the folder. */
const workspaceIdSchema = z.string().regex(/^[a-z0-9]+$/);

export function openStores(root: string) {
  const workspaces = new Map<string, JsonFile<z.infer<typeof workspaceSchema> | null>>();
  return {
    state: new JsonFile(join(root, 'state.json'), appStateSchema, emptyAppState),
    workspace(id: string) {
      const validId = workspaceIdSchema.parse(id);
      let file = workspaces.get(validId);
      if (!file) {
        file = new JsonFile(
          join(root, 'workspaces', `${validId}.json`),
          workspaceSchema.nullable(),
          () => null,
        );
        workspaces.set(validId, file);
      }
      return file;
    },
  };
}
export type Stores = ReturnType<typeof openStores>;
