import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';
import { IpcFailure } from '../../shared/ipc';
import type { Issue, PublishRequest, Workspace } from '../../shared/model';
import type { Notice } from './orchestrator-service';

// 004 US3 — the issues of a workspace: local Markdown files of the orchestrator's worktree first,
// published on the remote only once the user confirms (FR-022…FR-024, research R8).

export const ISSUES_DIR = '.pact/issues';

/** What a file of `.pact/issues/` says (contracts/files.md). */
export type ParsedIssue = { title: string; missing: string[] };

const GIVEN_WHEN_THEN = /\bGiven\b.+\bWhen\b.+\bThen\b/i;

/** The title, and what keeps the issue from being ready (FR-022): none when it is. */
export function parseIssue(text: string): ParsedIssue {
  const sections = new Map<string, string[]>();
  let title = '';
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{1,2})\s+(.*)$/.exec(line);
    if (heading?.[1] === '#' && title === '') title = (heading[2] ?? '').trim();
    if (heading?.[1] === '##') {
      current = [];
      sections.set((heading[2] ?? '').trim().toLowerCase().replaceAll('’', "'"), current);
    } else if (heading === null && current) current.push(line);
  }
  const items = (name: string) =>
    (sections.get(name) ?? [])
      .map((line) => /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim() ?? '')
      .filter((item) => item !== '');
  const missing: string[] = [];
  if (!items("critères d'acceptation").some((item) => GIVEN_WHEN_THEN.test(item))) {
    missing.push('Aucun critère d’acceptation « Given … When … Then … ».');
  }
  const questions = items('questions ouvertes');
  if (questions.length > 0) missing.push(`Questions ouvertes : ${questions.join(' ; ')}`);
  return { title, missing };
}

/**
 * The `gh` PACT runs: the user's, or in test mode the fake one of the tests (`PACT_FAKE_GH`, run
 * with `PACT_FAKE_NODE`), never GitHub; `null` when a test gives none.
 */
export function ghCommand(
  env: Record<string, string | undefined>,
): { file: string; args: string[] } | null {
  if (env.PACT_TEST_MODE !== '1') return { file: 'gh', args: [] };
  const { PACT_FAKE_GH: script, PACT_FAKE_NODE: runtime } = env;
  return script ? { file: runtime ?? process.execPath, args: [script] } : null;
}

type Options = {
  workspaces: {
    list(): Workspace[];
    update(id: string, change: (workspace: Workspace) => Workspace): Promise<Workspace>;
  };
  /** `gh` in the repository, with the user's environment: its standard output. */
  gh: (args: string[], cwd: string) => Promise<string>;
  /** The orchestrators of the workspace hear of the outcome (`publish`). */
  notify: (workspaceId: string, notice: Notice) => void;
  /** The À faire column follows the issues and the request (`workspace:issues`). */
  onChange?: (workspaceId: string, change: Pick<Workspace, 'issues' | 'publishRequests'>) => void;
};

export class IssueService {
  constructor(private readonly options: Options) {}

  /** Reads `.pact/issues/<path>` of the orchestrator's worktree and keeps the issue (R8). */
  async register(
    orchestratorId: string,
    path: string,
  ): Promise<{ issue: Issue; missing: string[] }> {
    const { workspace, orchestrator } = this.orchestrator(orchestratorId);
    const relative = normalize(path);
    if (isAbsolute(relative) || relative.split(sep).includes('..') || !relative.endsWith('.md')) {
      throw new IpcFailure(
        'INVALID_INPUT',
        `« ${path} » n’est pas un fichier .md de ${ISSUES_DIR}/.`,
      );
    }
    const repoPath = `${ISSUES_DIR}/${relative.split(sep).join('/')}`;
    let text: string;
    try {
      text = await readFile(join(orchestrator.worktreePath, repoPath), 'utf8');
    } catch {
      throw new IpcFailure('INVALID_INPUT', `Fichier introuvable : ${repoPath}.`);
    }
    const { title, missing } = parseIssue(text);
    const id = basename(relative, '.md');
    const known = workspace.issues.find((i) => i.id === id);
    // An issue a loop works on keeps its state: only proposed and ready are read again.
    const settled = known && known.state !== 'proposed' && known.state !== 'ready';
    const issue: Issue = {
      id,
      title: title || id,
      path: repoPath,
      state: settled ? known.state : missing.length === 0 ? 'ready' : 'proposed',
      remote: known?.remote ?? null,
      trace: known?.trace ?? { branch: null, agents: [], pr: null },
    };
    await this.change(workspace.id, (ws) => ({
      ...ws,
      issues: known ? ws.issues.map((i) => (i.id === id ? issue : i)) : [...ws.issues, issue],
    }));
    return { issue, missing };
  }

  list(orchestratorId: string): Issue[] {
    return this.orchestrator(orchestratorId).workspace.issues;
  }

  /** « ◎ Créer N issues ? » in À faire; refused without a remote or `gh` (FR-023). */
  async requestPublish(orchestratorId: string, ids: string[]): Promise<PublishRequest> {
    const { workspace } = this.orchestrator(orchestratorId);
    const unique = [...new Set(ids)];
    if (unique.length === 0 || unique.length > 20) {
      throw new IpcFailure('INVALID_INPUT', 'Donne de 1 à 20 issues à publier.');
    }
    for (const id of unique) {
      const issue = workspace.issues.find((i) => i.id === id);
      if (!issue) throw new IpcFailure('INVALID_INPUT', `Issue inconnue : ${id}.`);
      if (issue.state !== 'ready')
        throw new IpcFailure('INVALID_INPUT', `L’issue ${id} n’est pas prête.`);
      if (issue.remote) throw new IpcFailure('INVALID_INPUT', `L’issue ${id} est déjà publiée.`);
    }
    try {
      await this.options.gh(['repo', 'view', '--json', 'url'], workspace.path);
    } catch (error) {
      throw new IpcFailure(
        'INVALID_INPUT',
        `Publication impossible (dépôt distant ou gh connecté requis) : ${reason(error)}`,
      );
    }
    const request: PublishRequest = {
      id: randomUUID(),
      issueIds: unique,
      requestedAt: new Date().toISOString(),
    };
    // At most one per workspace: the new one replaces the old one.
    await this.change(workspace.id, (ws) => ({ ...ws, publishRequests: [request] }));
    return request;
  }

  /** Creates the issues with `gh issue create`, then tells the orchestrator. */
  async confirm(requestId: string): Promise<{ issues: { id: string; url: string }[] }> {
    const { workspace, request } = this.request(requestId);
    const orchestrator = workspace.agents.find((a) => a.role === 'orchestrator');
    const published: { id: string; url: string; number: number }[] = [];
    let failure: string | null = null;
    for (const id of request.issueIds) {
      const issue = workspace.issues.find((i) => i.id === id);
      if (!issue || !orchestrator) continue;
      try {
        const out = await this.options.gh(
          [
            'issue',
            'create',
            '--title',
            issue.title,
            '--body-file',
            join(orchestrator.worktreePath, issue.path),
          ],
          workspace.path,
        );
        const url = out.trim().split(/\s+/).pop() ?? '';
        const number = Number(/\/(\d+)$/.exec(url)?.[1] ?? 0);
        published.push({ id, url, number });
      } catch (error) {
        failure = reason(error);
        break;
      }
    }
    await this.change(workspace.id, (ws) => ({
      ...ws,
      publishRequests: [],
      issues: ws.issues.map((i) => {
        const done = published.find((p) => p.id === i.id);
        return done && done.number > 0
          ? { ...i, remote: { number: done.number, url: done.url } }
          : i;
      }),
    }));
    const issues = published.map(({ id, url }) => ({ id, url }));
    if (orchestrator) {
      const list = issues.map((i) => `${i.id} → ${i.url}`).join(', ');
      this.options.notify(workspace.id, {
        agentId: orchestrator.id,
        kind: 'publish',
        summary:
          failure === null
            ? `Issues publiées : ${list}.`
            : `Publication arrêtée : ${failure}${list ? ` (déjà publiées : ${list})` : ''}.`,
      });
    }
    return { issues };
  }

  async refuse(requestId: string): Promise<void> {
    const { workspace } = this.request(requestId);
    await this.change(workspace.id, (ws) => ({ ...ws, publishRequests: [] }));
    const orchestrator = workspace.agents.find((a) => a.role === 'orchestrator');
    if (orchestrator) {
      this.options.notify(workspace.id, {
        agentId: orchestrator.id,
        kind: 'publish',
        summary: 'Publication refusée par l’utilisateur : les issues restent locales.',
      });
    }
  }

  private orchestrator(orchestratorId: string) {
    for (const workspace of this.options.workspaces.list()) {
      const orchestrator = workspace.agents.find((a) => a.id === orchestratorId);
      if (orchestrator) return { workspace, orchestrator };
    }
    throw new IpcFailure('INVALID_INPUT', 'L’orchestrateur n’est plus dans un workspace ouvert.');
  }

  private request(requestId: string) {
    for (const workspace of this.options.workspaces.list()) {
      const request = workspace.publishRequests.find((r) => r.id === requestId);
      if (request) return { workspace, request };
    }
    throw new IpcFailure('NOT_FOUND', 'Cette demande de publication n’existe plus.');
  }

  private async change(workspaceId: string, change: (ws: Workspace) => Workspace) {
    const ws = await this.options.workspaces.update(workspaceId, change);
    this.options.onChange?.(workspaceId, {
      issues: ws.issues,
      publishRequests: ws.publishRequests,
    });
  }
}

/** Categories of `gh` failures PACT knows: only their fixed wording is ever reported. */
const KNOWN_FAILURES: [RegExp, (match: RegExpExecArray) => string][] = [
  [/no git remotes found/i, () => 'no git remotes found'],
  [/\bHTTP (\d{3})\b/, (match) => `HTTP ${match[1] ?? ''}`],
];

/**
 * A generic motive, never the text of `gh` (FR-026): its stderr can quote what a third party wrote
 * (a title, a comment). Only a known category, with its own wording, or the exit status is kept.
 */
const reason = (error: unknown) => {
  const { code, stderr, message } = error as {
    code?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  const text = [stderr, message].filter((part) => typeof part === 'string').join('\n');
  for (const [pattern, wording] of KNOWN_FAILURES) {
    const match = pattern.exec(text);
    if (match) return wording(match);
  }
  if (code === 'ENOENT') return 'gh est introuvable';
  if (typeof code === 'number') return `gh a échoué (code de sortie ${String(code)})`;
  return 'gh a échoué';
};
