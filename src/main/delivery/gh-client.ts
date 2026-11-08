import { MAX_CI_LOG, type MergeMode } from '../../shared/delivery';

// 008 contracts/gh.md — the closed list of `gh` calls. Nothing else is built here: no free argument,
// no `--auto`, no `--delete-branch`, no listing, no search, no textual field of the forge (FR-029 to
// FR-033, SC-002, SC-009). What comes back is reduced to the fields of the contract.

/** `gh`, run in `cwd` with `input` on stdin: its stdout, or an error carrying `stderr` and `code`. */
export type GhRun = (args: string[], options: { cwd: string; input?: string }) => Promise<string>;

/** The stderr of the forge shown to the user and the orchestrator: bounded (contracts/gh.md). */
const MAX_STDERR = 500;

/** `gh` refused: `reason` is its stderr, 500 characters at most. */
export class GhFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export type GhAvailability =
  | { ok: true; login: string; repo: { url: string; nameWithOwner: string } }
  | { ok: false; reason: string; remedy: string };

export type PrState = {
  number: number;
  state: string;
  headRefOid: string;
  headRefName: string;
  author: { login: string };
  isCrossRepository: boolean;
  baseRefName: string;
  mergeStateStatus: string;
};
export type CheckRun = { id: number; name: string; status: string; conclusion: string | null };
export type CommitStatus = { context: string; state: string };

const PR_FIELDS =
  'number,state,headRefOid,headRefName,author,isCrossRepository,baseRefName,mergeStateStatus';

const stderrOf = (error: unknown): string => {
  const failure = error as { stderr?: unknown; message?: unknown };
  const text = typeof failure.stderr === 'string' ? failure.stderr : '';
  return (text.trim() || (typeof failure.message === 'string' ? failure.message : '')).slice(
    0,
    MAX_STDERR,
  );
};

const isMissing = (error: unknown): boolean => {
  const failure = error as { code?: unknown; stderr?: unknown; message?: unknown };
  const text = [failure.stderr, failure.message].filter((x) => typeof x === 'string').join('\n');
  return failure.code === 'ENOENT' || text.includes('ENOENT');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const records = (text: string): Record<string, unknown>[] => {
  const parsed: unknown = JSON.parse(text || '[]');
  return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export class GhClient {
  private readonly run: GhRun;
  private readonly cwd: string;

  constructor({ run, cwd }: { run: GhRun; cwd: string }) {
    this.run = run;
    this.cwd = cwd;
  }

  private gh(args: string[], input?: string): Promise<string> {
    return this.run(args, input === undefined ? { cwd: this.cwd } : { cwd: this.cwd, input });
  }

  /** FR-005 — `gh` there, connected, and a remote on GitHub; else the reason and the remedy. */
  async availability(): Promise<GhAvailability> {
    try {
      await this.gh(['auth', 'status', '--hostname', 'github.com']);
    } catch (error) {
      return isMissing(error)
        ? {
            ok: false,
            reason: 'gh est absent de cette machine (introuvable).',
            remedy: 'Installe gh (https://cli.github.com), puis relance la livraison.',
          }
        : {
            ok: false,
            reason: 'gh n’est pas connecté à GitHub.',
            remedy: 'Lance « gh auth login » dans un terminal, puis relance la livraison.',
          };
    }
    let login: string;
    let repo: { url: string; nameWithOwner: string };
    try {
      login = (await this.gh(['api', 'user', '--jq', '.login'])).trim();
      const view = records(
        `[${await this.gh(['repo', 'view', '--json', 'url,nameWithOwner'])}]`,
      )[0];
      repo = { url: str(view?.url), nameWithOwner: str(view?.nameWithOwner) };
    } catch {
      return {
        ok: false,
        reason: 'Le dépôt n’a pas de remote GitHub lisible par gh.',
        remedy: 'Ajoute un remote GitHub (git remote add origin …) ou fusionne à la main.',
      };
    }
    if (!/^https:\/\/github\.com\//.test(repo.url) || login === '') {
      return {
        ok: false,
        reason: 'Le remote du dépôt n’est pas sur GitHub : PACT ne sait livrer que par GitHub.',
        remedy: 'Pointe origin vers un dépôt GitHub, ou fusionne à la main.',
      };
    }
    return { ok: true, login, repo };
  }

  /** The URL printed by `gh pr create`, then the number in it. */
  async prCreate(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }> {
    let out: string;
    try {
      out = await this.gh(
        [
          'pr',
          'create',
          '--head',
          input.head,
          '--base',
          input.base,
          '--title',
          input.title,
          '--body-file',
          '-',
        ],
        input.body,
      );
    } catch (error) {
      throw new GhFailure(stderrOf(error));
    }
    const url = out.trim().split(/\s+/).at(-1) ?? '';
    const number = Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
    if (!Number.isInteger(number) || number < 1) {
      throw new GhFailure('gh n’a pas rendu l’adresse de la PR.');
    }
    return { number, url };
  }

  /** The eight fields of the contract, and nothing the forge sent besides. */
  async prView(number: number): Promise<PrState> {
    const raw = records(
      `[${await this.gh(['pr', 'view', String(number), '--json', PR_FIELDS])}]`,
    )[0];
    const author = isRecord(raw?.author) ? raw.author : {};
    return {
      number: Number(raw?.number),
      state: str(raw?.state),
      headRefOid: str(raw?.headRefOid),
      headRefName: str(raw?.headRefName),
      author: { login: str(author.login) },
      isCrossRepository: raw?.isCrossRepository === true,
      baseRefName: str(raw?.baseRefName),
      mergeStateStatus: str(raw?.mergeStateStatus),
    };
  }

  async checkRuns(repo: string, sha: string): Promise<CheckRun[]> {
    const out = await this.gh([
      'api',
      `repos/${repo}/commits/${sha}/check-runs`,
      '--jq',
      '[.check_runs[]|{id,name,status,conclusion}]',
    ]);
    return records(out).map((run) => ({
      id: Number(run.id),
      name: str(run.name),
      status: str(run.status),
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
    }));
  }

  async statuses(repo: string, sha: string): Promise<CommitStatus[]> {
    const out = await this.gh([
      'api',
      `repos/${repo}/commits/${sha}/status`,
      '--jq',
      '[.statuses[]|{context,state}]',
    ]);
    return records(out).map((status) => ({
      context: str(status.context),
      state: str(status.state),
    }));
  }

  /**
   * The checks the target branch requires (R10): the protection, then the rules. `null`: neither can
   * be read (no right of administration, forge down): not « none ».
   */
  async requiredChecks(repo: string, target: string): Promise<string[] | null> {
    try {
      const out = await this.gh([
        'api',
        `repos/${repo}/branches/${target}/protection/required_status_checks`,
        '--jq',
        '.contexts',
      ]);
      const parsed: unknown = JSON.parse(out || '[]');
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      // A protection that refuses or does not exist: the rules say it too.
    }
    try {
      const rules = records(await this.gh(['api', `repos/${repo}/rules/branches/${target}`]));
      const names = new Set<string>();
      for (const rule of rules) {
        if (rule.type !== 'required_status_checks' || !isRecord(rule.parameters)) continue;
        const required = rule.parameters.required_status_checks;
        if (!Array.isArray(required)) continue;
        for (const check of required) {
          if (isRecord(check) && typeof check.context === 'string') names.add(check.context);
        }
      }
      return [...names];
    } catch {
      return null;
    }
  }

  async rerunJob(repo: string, job: number): Promise<void> {
    await this.gh(['api', '-X', 'POST', `repos/${repo}/actions/jobs/${String(job)}/rerun`]);
  }

  /** R15 — the end of the log of the failed steps of a job. */
  async jobLog(job: number): Promise<string> {
    const log = await this.gh(['run', 'view', '--job', String(job), '--log-failed']);
    return log.length > MAX_CI_LOG ? log.slice(-MAX_CI_LOG) : log;
  }

  /** FR-031 — only if the head of the PR is still `sha`; never `--auto`. */
  async prMerge(number: number, mode: MergeMode, sha: string): Promise<void> {
    try {
      await this.gh(['pr', 'merge', String(number), `--${mode}`, '--match-head-commit', sha]);
    } catch (error) {
      throw new GhFailure(stderrOf(error));
    }
  }
}
