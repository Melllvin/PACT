import type { AdapterId, CliDefinition } from '../../shared/model';
import type { Stores } from '../persistence/store';
import { GenericAdapter } from './adapters/generic';
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
  platform?: NodeJS.Platform;
};

export type RegisteredCli = { adapter: CliAdapter; definition: CliDefinition };

export class CliRegistry {
  private readonly adapters: CliAdapter[];
  private readonly resolveEnv: () => Promise<ResolvedEnv>;
  private readonly stores: Stores;
  private readonly platform: NodeJS.Platform;
  private detected: RegisteredCli[] = [];
  /** « Autre CLI »: added by the user, each run through its own generic adapter (FR-008). */
  private custom: RegisteredCli[] = [];

  constructor({ adapters, resolveEnv, stores, platform = process.platform }: Options) {
    this.adapters = adapters;
    this.resolveEnv = resolveEnv;
    this.stores = stores;
    this.platform = platform;
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
    const saved = (await this.stores.state.read()).customClis;
    this.custom = await Promise.all(saved.map((cli) => this.customCli(cli, env)));
    return this.list();
  }

  /**
   * « Autre CLI — ajouter »: saved even when its command is not found, `missing` being the
   * warning the home screen shows (US6 scenario 6).
   */
  async add({ name, command }: { name: string; command: string }): Promise<CliDefinition> {
    const taken = new Set(this.list().map((cli) => cli.id));
    const base = `custom-${slug(name) || 'cli'}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${String(n)}`;
    const definition: CliDefinition = {
      id,
      name,
      adapter: 'generic',
      command,
      resolvedPath: null,
      version: null,
      origin: 'custom',
      status: 'missing',
      models: [],
    };
    const cli = await this.customCli(definition, await this.resolveEnv());
    this.custom = [...this.custom, cli];
    const state = await this.stores.state.read();
    await this.stores.state.write({
      ...state,
      customClis: this.custom.map((custom) => custom.definition),
    });
    return cli.definition;
  }

  /** Result of the last detection, empty before the first one. */
  list(): CliDefinition[] {
    return [...this.detected, ...this.custom].map((cli) => cli.definition);
  }

  get(id: string): RegisteredCli | undefined {
    return [...this.detected, ...this.custom].find((cli) => cli.definition.id === id);
  }

  private async customCli(definition: CliDefinition, env: ResolvedEnv): Promise<RegisteredCli> {
    const adapter = new GenericAdapter({ command: definition.command, platform: this.platform });
    const { resolvedPath, status } = await adapter.detect(env).catch(() => MISSING);
    return { adapter, definition: { ...definition, resolvedPath, status } };
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

/** `Mon Agent é` → `mon-agent-e`, as `custom-<slug>` ids allow. */
const slug = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
