import type { Agent, Loop, Workspace } from '../../shared/model';
import type { HandoffReport, StoredReport } from '../../shared/report';
import type { TestRun } from '../../shared/review';
import type { GitService } from '../git/git-service';
import { MAX_NOTICE } from '../../shared/exchanges';
import type { RecordInput } from './exchange-service';
import type { Notice } from './orchestrator-service';
import type { ReviewService } from '../review/review-service';
import type { TestRunner } from '../review/test-runner';

// 004 R6 — the dev ↔ test loop of an issue: 3 rounds at most (FR-018), done only once PACT's own
// run of the tests passes on the dev's current tree (FR-019), an independent tester (FR-020).

export const MAX_ROUNDS = 3;

export type LoopEvent = Notice;
export type LoopDecision = 'restart' | 'take-over' | 'abandon';

export interface LoopServiceDeps {
  workspaces: {
    get(id: string): Workspace | undefined;
    list(): Workspace[];
    update(id: string, change: (ws: Workspace) => Workspace): Promise<Workspace>;
  };
  git: Pick<GitService, 'snapshot' | 'changedFiles' | 'mergeBase'>;
  review: Pick<ReviewService, 'testPlan'>;
  tests: Pick<TestRunner, 'run'>;
  agents: { escalate(agentId: string, model: string): Promise<void> };
  notify(workspaceId: string, event: LoopEvent): void;
  /** 007 R14 — a message of PACT in the journal: the instructions and the verdict of a loop. */
  message?: (workspaceId: string, draft: RecordInput) => Promise<unknown>;
  /** The loops and issues of a workspace changed (`workspace:loops`). */
  onChange?: (workspaceId: string, change: Pick<Workspace, 'loops' | 'issues'>) => void;
  now?: () => Date;
}

/** `**`, `*` and `?` of a test path, as a regex over the whole repo path. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*' && glob.charAt(i + 1) === '*') {
      const slash = glob.charAt(i + 2) === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export const isTestPath = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => globToRegExp(pattern).test(path));

/** 007 R8 — a report with questions reaches the orchestrator as a question, with the questions. */
function reportNotice(agentId: string, report: HandoffReport): LoopEvent {
  if (report.questions.length === 0) {
    return { agentId, kind: 'report', summary: report.summary };
  }
  const questions = report.questions.map((q, i) => `${String(i + 1)}. ${q}`).join('\n');
  return { agentId, kind: 'question', summary: `${report.summary}\n${questions}` };
}

/** Who got what when a loop started (007 FR-021): the tool says it in words. */
export type Sent = { agentId: string; kind: 'instruction' }[];

export class LoopService {
  /** Agents that gave a report since their last turn ended. */
  private readonly reported = new Set<string>();

  constructor(private readonly deps: LoopServiceDeps) {}

  private async update(workspaceId: string, change: (ws: Workspace) => Workspace) {
    const ws = await this.deps.workspaces.update(workspaceId, change);
    this.deps.onChange?.(workspaceId, { loops: ws.loops, issues: ws.issues });
    return ws;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private workspace(id: string): Workspace {
    const ws = this.deps.workspaces.get(id);
    if (!ws) throw new Error(`Workspace inconnu : ${id}`);
    return ws;
  }

  get(workspaceId: string, issueId: string): Loop | null {
    return this.workspace(workspaceId).loops.find((l) => l.issueId === issueId) ?? null;
  }

  private find(agentId: string): { ws: Workspace; loop: Loop; agent: Agent } | null {
    for (const ws of this.deps.workspaces.list()) {
      const loop = ws.loops.find(
        (l) => l.state === 'running' && (l.devAgentId === agentId || l.testAgentId === agentId),
      );
      const agent = ws.agents.find((a) => a.id === agentId);
      if (loop && agent) return { ws, loop, agent };
    }
    return null;
  }

  private async save(workspaceId: string, issueId: string, change: (loop: Loop) => Loop) {
    let saved: Loop | null = null;
    await this.update(workspaceId, (ws) => ({
      ...ws,
      loops: ws.loops.map((l) => (l.issueId === issueId ? (saved = change(l)) : l)),
    }));
    return saved as unknown as Loop;
  }

  private async setIssue(
    workspaceId: string,
    issueId: string,
    state: Workspace['issues'][number]['state'],
  ) {
    await this.update(workspaceId, (ws) => ({
      ...ws,
      issues: ws.issues.map((i) => (i.id === issueId ? { ...i, state } : i)),
    }));
  }

  async start(
    workspaceId: string,
    { issue: issueId, dev, test }: { issue: string; dev: string; test: string },
  ): Promise<Loop & { sent: Sent }> {
    const ws = this.workspace(workspaceId);
    const issue = ws.issues.find((i) => i.id === issueId);
    if (!issue) throw new Error(`Issue inconnue : ${issueId}.`);
    if (ws.loops.some((l) => l.issueId === issueId && l.state === 'running')) {
      throw new Error(`Une boucle tourne déjà pour ${issueId}.`);
    }
    if (issue.state !== 'ready') {
      throw new Error(`L’issue ${issueId} n’est pas prête (${issue.state}).`);
    }
    const devAgent = ws.agents.find((a) => a.id === dev);
    const testAgent = ws.agents.find((a) => a.id === test);
    if (devAgent?.role !== 'dev' || testAgent?.role !== 'test') {
      throw new Error('Il faut un agent dev et un agent test.');
    }
    const loop: Loop = {
      issueId,
      devAgentId: dev,
      testAgentId: test,
      round: 1,
      rounds: [{ n: 1, startedAt: this.now(), reports: [], proof: null, testerTouched: [] }],
      state: 'running',
      escalatedModel: null,
    };
    await this.update(workspaceId, (current) => ({
      ...current,
      loops: [...current.loops.filter((l) => l.issueId !== issueId), loop],
      issues: current.issues.map((i) =>
        i.id === issueId
          ? {
              ...i,
              state: 'in-progress',
              trace: { ...i.trace, branch: devAgent.branch, agents: [dev, test] },
            }
          : i,
      ),
    }));
    // 007 FR-021 — the tester writes the tests first; the dev's own instruction waits for its report.
    const sent: Sent = [];
    const delivered = await this.send(workspaceId, {
      to: test,
      kind: 'instruction',
      text: `Écris les tests d’acceptation de l’issue ${issueId} (lis .pact/issues/${issueId}.md dans ton worktree), sans toucher au code de production. Rends ton rapport avec submit_report.`,
    });
    if (delivered) sent.push({ agentId: test, kind: 'instruction' });
    return { ...loop, sent };
  }

  /** A message of PACT; a journal that fails must not lose the loop or the verdict. */
  private async send(
    workspaceId: string,
    draft: Pick<RecordInput, 'to' | 'kind' | 'text'>,
  ): Promise<boolean> {
    if (!this.deps.message) return false;
    try {
      await this.deps.message(workspaceId, { from: 'pact', unreadBy: [draft.to], ...draft });
      return true;
    } catch {
      return false;
    }
  }

  /** The files outside the tests that the tester changed since its real base (007 R12, FR-023). */
  private async outsideTests(ws: Workspace, agent: Agent): Promise<string[]> {
    const { tree } = await this.deps.git.snapshot(agent.worktreePath);
    const main = ws.mainBranch;
    const bases = [
      main,
      `origin/${main}`,
      ...(agent.baseBranch === main ? [] : [agent.baseBranch]),
    ];
    let outside: string[] | null = null;
    for (const base of bases) {
      // A base unknown here (no origin, a branch gone) is not one.
      const from = await this.deps.git
        .mergeBase(agent.worktreePath, 'HEAD', base)
        .catch(() => null);
      if (from === null) continue;
      const changed = await this.deps.git.changedFiles(agent.worktreePath, from, tree);
      const files = changed.map((f) => f.path).filter((p) => !isTestPath(p, ws.testPaths));
      outside = outside === null ? files : outside.filter((p) => files.includes(p));
    }
    if (outside === null) throw new Error(`Aucune base connue pour contrôler ${agent.branch}.`);
    return outside;
  }

  async next(workspaceId: string, issueId: string): Promise<Loop> {
    const ws = this.workspace(workspaceId);
    const loop = this.get(workspaceId, issueId);
    if (!loop) throw new Error(`Aucune boucle pour ${issueId}.`);
    if (loop.state === 'escalated') {
      throw new Error('Plafond de 3 tours atteint : l’utilisateur décide');
    }
    if (loop.state !== 'running') throw new Error(`La boucle de ${issueId} est terminée.`);
    const last = loop.rounds.at(-1);
    const verdict = last?.reports.filter((r) => r.role === 'test').at(-1)?.verdict;
    if (verdict?.result !== 'defects') {
      throw new Error(`Le tour ${String(loop.round)} attend le verdict « defects » du test.`);
    }
    const n = loop.round + 1;
    let escalatedModel = loop.escalatedModel;
    if (n === MAX_ROUNDS) {
      const devAgent = ws.agents.find((a) => a.id === loop.devAgentId);
      const profile = ws.roleProfiles.dev;
      if (
        devAgent &&
        profile?.escalate &&
        profile.maxModel &&
        profile.maxModel !== devAgent.model
      ) {
        await this.deps.agents.escalate(devAgent.id, profile.maxModel);
        escalatedModel = profile.maxModel;
      }
    }
    return this.save(workspaceId, issueId, (l) => ({
      ...l,
      round: n,
      escalatedModel,
      rounds: [
        ...l.rounds,
        { n, startedAt: this.now(), reports: [], proof: null, testerTouched: [] },
      ],
    }));
  }

  /** A hand-off report of an agent; the reason it is refused, or `null`. */
  async report(agentId: string, report: HandoffReport): Promise<string | null> {
    this.reported.add(agentId);
    const found = this.find(agentId);
    if (!found) {
      // 007 FR-010 — out of a loop, the orchestrator hears of the report too.
      const ws = this.deps.workspaces.list().find((w) => w.agents.some((a) => a.id === agentId));
      if (ws) this.deps.notify(ws.id, reportNotice(agentId, report));
      return null;
    }
    const { ws, loop, agent } = found;
    const role = agent.role === 'test' ? 'test' : 'dev';
    const stored: StoredReport = { ...report, agentId, role, round: loop.round, at: this.now() };

    if (role === 'test' && report.verdict) {
      const outside = await this.outsideTests(ws, agent);
      if (outside.length > 0) {
        await this.saveRound(ws.id, loop.issueId, (r) => ({ ...r, testerTouched: outside }));
        return `Verdict rejeté : le test a modifié des fichiers hors tests (${outside.join(', ')}). Retire ces fichiers de ta branche (remets-les comme sur la branche principale, ou supprime-les), commite, puis rends à nouveau ton verdict.`;
      }
    }

    const firstOfTester =
      role === 'test' && !loop.rounds.some((r) => r.reports.some((x) => x.role === 'test'));
    await this.saveRound(ws.id, loop.issueId, (r) => ({ ...r, reports: [...r.reports, stored] }));
    this.deps.notify(ws.id, reportNotice(agentId, report));
    if (firstOfTester) {
      await this.send(ws.id, {
        to: loop.devAgentId,
        kind: 'instruction',
        text: `Fais passer les tests d’acceptation de l’issue ${loop.issueId} (lis .pact/issues/${loop.issueId}.md dans ton worktree) sans les modifier, puis rends ton rapport avec submit_report.`,
      });
    }
    if (role === 'test' && report.verdict?.result === 'defects') {
      const defects = report.verdict.defects.map((d) => `- ${d}`).join('\n');
      const head = `Verdict du test sur ${loop.issueId} (tour ${String(loop.round)}/${String(MAX_ROUNDS)}) : défauts.\n`;
      await this.send(ws.id, {
        to: loop.devAgentId,
        kind: 'verdict',
        text: `${head}${defects}`.slice(0, MAX_NOTICE),
      });
    }

    if (role === 'test' && report.verdict?.result === 'accepted') {
      const { target, command } = await this.deps.review.testPlan(loop.devAgentId);
      if (command === null) {
        this.deps.notify(ws.id, {
          agentId: loop.devAgentId,
          kind: 'loop',
          summary: `${loop.issueId} : aucune commande de tests, PACT ne peut pas faire la preuve.`,
        });
        return null;
      }
      // The dev's worktree as it is now: the proof is on this tree (FR-019).
      const { tree } = await this.deps.git.snapshot(target.cwd);
      await this.deps.tests.run(target, command, tree);
    } else if (
      role === 'test' &&
      report.verdict?.result === 'defects' &&
      loop.round === MAX_ROUNDS
    ) {
      await this.escalate(ws.id, loop.issueId, agentId);
    }
    return null;
  }

  private async saveRound(
    workspaceId: string,
    issueId: string,
    change: (round: Loop['rounds'][number]) => Loop['rounds'][number],
  ) {
    await this.save(workspaceId, issueId, (l) => ({
      ...l,
      rounds: l.rounds.map((r, i) => (i === l.rounds.length - 1 ? change(r) : r)),
    }));
  }

  private async escalate(workspaceId: string, issueId: string, agentId: string) {
    await this.save(workspaceId, issueId, (l) => ({ ...l, state: 'escalated' }));
    await this.setIssue(workspaceId, issueId, 'escalated');
    this.deps.notify(workspaceId, {
      agentId,
      kind: 'loop',
      summary: `Boucle arrêtée · ${issueId} · ${String(MAX_ROUNDS)} tours : l’utilisateur décide.`,
    });
  }

  /** A run of the tests finished: the proof of a loop when it passed on the dev's current tree. */
  async testRun(run: TestRun): Promise<void> {
    if (run.status === 'running') return;
    const found = this.find(run.agentId);
    if (!found || found.loop.devAgentId !== run.agentId) return;
    const { ws, loop, agent } = found;
    const { tree } = await this.deps.git.snapshot(agent.worktreePath);
    if (run.status === 'passed' && run.tree === tree) {
      await this.saveRound(ws.id, loop.issueId, (r) => ({
        ...r,
        proof: { tree, exitCode: 0, at: this.now() },
      }));
      await this.save(ws.id, loop.issueId, (l) => ({ ...l, state: 'passed' }));
      await this.setIssue(ws.id, loop.issueId, 'done');
      this.deps.notify(ws.id, {
        agentId: run.agentId,
        kind: 'loop',
        summary: `${loop.issueId} : tests passés par PACT au tour ${String(loop.round)}.`,
      });
      return;
    }
    const why =
      run.tree !== tree
        ? 'le code a changé depuis ce passage des tests'
        : `les tests ont échoué (${run.status})`;
    this.deps.notify(ws.id, {
      agentId: run.agentId,
      kind: 'loop',
      summary: `${loop.issueId} : pas encore fini, ${why}.`,
    });
  }

  /** The turn of an agent ended: the orchestrator hears of a missing report (R5). */
  turnFinished(agentId: string): void {
    const found = this.find(agentId);
    const reported = this.reported.delete(agentId);
    if (!found || reported) return;
    this.deps.notify(found.ws.id, {
      agentId,
      kind: 'report-missing',
      summary: 'Tour fini sans rapport : demande-le avec submit_report.',
    });
  }

  async decide(workspaceId: string, issueId: string, decision: LoopDecision): Promise<void> {
    const loop = this.get(workspaceId, issueId);
    if (loop?.state !== 'escalated') {
      throw new Error(`La boucle de ${issueId} n’attend pas de décision.`);
    }
    if (decision === 'restart') {
      await this.save(workspaceId, issueId, (l) => ({
        ...l,
        state: 'running',
        round: 1,
        rounds: [{ n: 1, startedAt: this.now(), reports: [], proof: null, testerTouched: [] }],
      }));
      await this.setIssue(workspaceId, issueId, 'in-progress');
      return;
    }
    await this.save(workspaceId, issueId, (l) => ({ ...l, state: 'closed' }));
    if (decision === 'abandon') await this.setIssue(workspaceId, issueId, 'abandoned');
  }

  /** The orchestrator's role withdrawn: its loops close, the agents stay open. */
  async closeAll(workspaceId: string): Promise<void> {
    await this.update(workspaceId, (ws) => ({
      ...ws,
      loops: ws.loops.map((l) => (l.state === 'running' ? { ...l, state: 'closed' } : l)),
    }));
  }
}
