import type { AdapterId, CliDefinition } from '../../shared/model';
import type { Stores } from '../persistence/store';
import type { CliAdapter, DetectionResult, ResolvedEnv } from './adapters/types';

// US2 — « Agents détectés »: the CLIs found through the login shell's PATH (FR-013, T028).

type DetectedId = Exclude<AdapterId, 'generic'>;

const KNOWN: Record<DetectedId, { name: string; command: string }> = {
  'claude-code': { name: 'Claude Code', command: 'claude' },
  codex: { name: 'Codex', command: 'codex' },
  fake: { name: 'Faux CLI', command: 'node' },
};

const MISSING: DetectionResult = { resolvedPath: null, version: null, status: 'missing' };

type Options = {
  adapters: CliAdapter[];
  /** Environment of the user's login shell (R10): GUI apps do not inherit its PATH. */
  resolveEnv: () => Promise<ResolvedEnv>;
  stores: Stores;
};

export type RegisteredCli = { adapter: CliAdapter; definition: CliDefinition };

export class CliRegistry {
  private readonly adapters: CliAdapter[];
  private readonly resolveEnv: () => Promise<ResolvedEnv>;
  private readonly stores: Stores;
  private detected: RegisteredCli[] = [];
  private custom: CliDefinition[] = [];

  constructor({ adapters, resolveEnv, stores }: Options) {
    this.adapters = adapters;
    this.resolveEnv = resolveEnv;
    this.stores = stores;
  }

  /** Detects every CLI again (startup and `cli:redetect`); one failure never hides the others. */
  async detect(): Promise<CliDefinition[]> {
    const env = await this.resolveEnv();
    this.detected = await Promise.all(
      this.adapters.map(async (adapter) => {
        const result = await adapter.detect(env).catch(() => MISSING);
        const models =
          result.status === 'missing' ? [] : await adapter.listModels().catch(() => []);
        return { adapter, definition: this.definition(adapter.id, result, models) };
      }),
    );
    this.custom = (await this.stores.state.read()).customClis;
    return this.list();
  }

  /** Result of the last detection, empty before the first one. */
  list(): CliDefinition[] {
    return [...this.detected.map((cli) => cli.definition), ...this.custom];
  }

  get(id: string): RegisteredCli | undefined {
    return this.detected.find((cli) => cli.definition.id === id);
  }

  private definition(id: AdapterId, result: DetectionResult, models: string[]): CliDefinition {
    if (id === 'generic') throw new Error('Generic CLIs are user-defined, never detected');
    return {
      id,
      ...KNOWN[id],
      adapter: id,
      resolvedPath: result.resolvedPath,
      version: result.version,
      origin: 'detected',
      status: result.status,
      models,
    };
  }
}
