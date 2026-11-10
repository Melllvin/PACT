import type { Agent, Loop, Workspace } from '../../shared/model';
import type { HandoffReport, StoredReport } from '../../shared/report';
import type { TestRun } from '../../shared/review';
import type { GitService } from '../git/git-service';
import { MAX_NOTICE } from '../../shared/exchanges';
import type { RecordInput } from './exchange-service';
import type { Notice } from './orchestrator-service';
import type { ReviewService } from '../review/review-service';
import type { TestRunner } from '../review/test-runner';

// 004 R6 — the dev ↔ test loop of an issue: the project's ceiling of rounds (008 R11, FR-018), an
// accepted loop only once PACT's own run of the tests passes on the dev's clean HEAD (FR-019,
// 008 R3), an independent tester (FR-020). The issue is done at the merge, not at the proof (FR-007).

export type LoopEvent = Notice;
export type LoopDecision = 'restart' | 'take-over' | 'abandon';

export interface LoopServiceDeps {
  workspaces: {
    get(id: string): Workspace | undefined;
    list(): Workspace[];
    update(id: string, change: (ws: Workspace) => Workspace): Promise<Workspace>;
  };
  git: Pick<GitService, 'snapshot' | 'changedFiles' | 'mergeBase' | 'revParse' | 'treeOf'>;
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

/** 008 R23, P2 — the fixed sentence of every polish instruction. */
const POLISH_BAN = 'Aucune nouvelle fonctionnalité : corrige seulement ce qui est demandé';

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

  /** 008 R11 — the ceiling is read live: a lowered one escalates at the next « defects ». */
  private maxRounds(ws: Workspace): number {
    return ws.delivery.maxRounds;
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
        (l) =>
          (l.state === 'running' || l.state === 'polishing') &&
          (l.devAgentId === agentId || l.testAgentId === agentId),
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
      rounds: [this.newRound(1)],
      state: 'running',
      polish: null,
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

  /** 008 R23 — a pass is running: the last round is a polish round that has no proof yet. */
  private passRunning(loop: Loop): boolean {
    const last = loop.rounds.at(-1);
    return loop.state === 'polishing' && last?.kind === 'polish' && last.proof === null;
  }

  /**
   * 008 R23, FR-022 — the orchestrator starts a polish pass: a round of its own (never counted among
   * the rounds), and one instruction to the dev with the brief of the project, the notes of the
   * orchestrator and the fixed ban on any new feature (P2).
   */
  async polish(
    workspaceId: string,
    issueId: string,
    notes?: string,
  ): Promise<{ pass: number; total: number; sent: Sent }> {
    const ws = this.workspace(workspaceId);
    const loop = this.get(workspaceId, issueId);
    if (!loop) throw new Error(`Aucune boucle pour ${issueId}.`);
    if (loop.state !== 'polishing' || !loop.polish) {
      throw new Error(`La boucle de ${issueId} ne peaufine pas (${loop.state}).`);
    }
    if (this.passRunning(loop)) {
      throw new Error(`Une passe de peaufinage tourne déjà pour ${issueId}.`);
    }
    const { done, total } = loop.polish;
    const pass = done + 1;
    await this.save(workspaceId, issueId, (l) => ({
      ...l,
      polish: { done, total, restarted: false },
      rounds: [...l.rounds, this.newRound(l.rounds.length + 1, 'polish')],
    }));
    const brief = ws.delivery.polishBrief.trim();
    const extra = notes?.trim();
    const text = [
      `Peaufinage de l’issue ${issueId} (passe ${String(pass)} sur ${String(total)}).`,
      brief ? `Consigne du projet :\n${brief}` : '',
      extra ? `Précisions de l’orchestrateur :\n${extra}` : '',
      `${POLISH_BAN}. Commite, puis rends ton rapport avec submit_report.`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const sent: Sent = [];
    const delivered = await this.send(workspaceId, {
      to: loop.devAgentId,
      kind: 'instruction',
      text: text.slice(0, MAX_NOTICE),
    });
    if (delivered) sent.push({ agentId: loop.devAgentId, kind: 'instruction' });
    return { pass, total, sent };
  }

  private newRound(n: number, kind: 'round' | 'polish' = 'round'): Loop['rounds'][number] {
    return { n, kind, startedAt: this.now(), reports: [], proof: null, testerTouched: [] };
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
      throw new Error(
        `Plafond de ${String(this.maxRounds(ws))} tours atteint : l’utilisateur décide`,
      );
    }
    if (loop.state !== 'running') throw new Error(`La boucle de ${issueId} est terminée.`);
    const last = loop.rounds.at(-1);
    const verdict = last?.reports.filter((r) => r.role === 'test').at(-1)?.verdict;
    if (verdict?.result !== 'defects') {
      throw new Error(`Le tour ${String(loop.round)} attend le verdict « defects » du test.`);
    }
    return this.openRound(ws, loop);
  }

  /** The next round, with the escalation of the model at the last round of the ceiling (004 FR-007). */
  private async openRound(ws: Workspace, loop: Loop): Promise<Loop> {
    const n = loop.round + 1;
    let escalatedModel = loop.escalatedModel;
    if (n === this.maxRounds(ws)) {
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
    return this.save(ws.id, loop.issueId, (l) => ({
      ...l,
      state: 'running',
      round: n,
      escalatedModel,
      rounds: [...l.rounds, this.newRound(n)],
    }));
  }

  /**
   * 008 FR-017, FR-018 — the delivery sends the dev back: the CI is red, the user refused, the tests
   * failed after a rebase. A counted round opens and the loop runs again; at the ceiling the loop
   * escalates to the user and no round opens. The reason reaches the dev like a « defects ».
   */
  async reopen(workspaceId: string, issueId: string, reason: string): Promise<Loop> {
    const ws = this.workspace(workspaceId);
    const loop = this.get(workspaceId, issueId);
    if (!loop) throw new Error(`Aucune boucle pour ${issueId}.`);
    if (loop.state === 'closed' || loop.state === 'merged' || loop.state === 'escalated') {
      throw new Error(`La boucle de ${issueId} est terminée.`);
    }
    if (loop.round >= this.maxRounds(ws)) {
      await this.escalate(workspaceId, issueId, loop.devAgentId);
      return this.get(workspaceId, issueId) ?? loop;
    }
    const reopened = await this.openRound(ws, loop);
    await this.send(workspaceId, {
      to: loop.devAgentId,
      kind: 'verdict',
      text: `Livraison de ${issueId} (tour ${String(reopened.round)}/${String(this.maxRounds(ws))}) : ${reason}`.slice(
        0,
        MAX_NOTICE,
      ),
    });
    return reopened;
  }

  /**
   * 008 R6, R12, FR-007 — where the delivery leaves the loop: `delivering` while a request runs,
   * `accepted` when it ends without the dev having to work again, `running` (same round, nothing
   * counted) when the verdict no longer holds for the head, `merged` and the issue `done` at the merge.
   */
  async deliveryState(
    workspaceId: string,
    issueId: string,
    state: 'delivering' | 'accepted' | 'running' | 'merged' | 'closed',
  ): Promise<void> {
    const loop = this.get(workspaceId, issueId);
    if (!loop) throw new Error(`Aucune boucle pour ${issueId}.`);
    // 008 R12 — a request that fell because its agent was closed: the loop closes and the issue is free.
    if (state === 'closed') {
      await this.closeLoop(workspaceId, loop, loop.devAgentId);
      return;
    }
    await this.save(workspaceId, issueId, (l) => ({ ...l, state }));
    if (state === 'merged') await this.setIssue(workspaceId, issueId, 'done');
  }

  /**
   * 008 FR-026, R12 — an agent left (closed by the user): its loops that were not finished close, the
   * issue is `ready` again for `start_loop`, and the orchestrator is woken once per loop. A loop that
   * is `delivering` is closed by the delivery, which drops its request first (Q10); the agent may be
   * gone from the workspace already, the loops are found by its id. A second call changes nothing.
   */
  async agentClosed(agentId: string): Promise<void> {
    for (const ws of this.deps.workspaces.list()) {
      const open = ws.loops.filter(
        (l) =>
          (l.devAgentId === agentId || l.testAgentId === agentId) &&
          (l.state === 'running' || l.state === 'polishing' || l.state === 'accepted'),
      );
      for (const loop of open) await this.closeLoop(ws.id, loop, agentId);
    }
  }

  private async closeLoop(workspaceId: string, loop: Loop, agentId: string): Promise<void> {
    if (loop.state === 'closed') return;
    // One write: nobody sees a closed loop with an issue that is still in progress. The orchestrator
    // is woken as the state changes, not after the file is written: it may call `start_loop` at once.
    await this.update(workspaceId, (ws) => {
      this.deps.notify(workspaceId, {
        agentId,
        kind: 'loop',
        summary: `Boucle fermée · ${loop.issueId} : un de ses agents a été fermé, l’issue est de nouveau prête pour start_loop.`,
      });
      return {
        ...ws,
        loops: ws.loops.map((l) => (l.issueId === loop.issueId ? { ...l, state: 'closed' } : l)),
        issues: ws.issues.map((i) => (i.id === loop.issueId ? { ...i, state: 'ready' } : i)),
      };
    });
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
    // 008 R3 — the verdict is tied to the commit it judges: the head of the dev, and whether its
    // worktree differs from it.
    const devAgent = ws.agents.find((a) => a.id === loop.devAgentId);
    const judged =
      role === 'test' && report.verdict && devAgent ? await this.headOf(devAgent) : null;
    const stored: StoredReport = {
      ...report,
      agentId,
      role,
      round: loop.round,
      at: this.now(),
      commit: judged?.commit ?? null,
      dirty: judged?.dirty ?? false,
    };

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
    // The pass the loop is in, if any (008 R23).
    const pass =
      loop.state === 'polishing' && loop.rounds.at(-1)?.kind === 'polish' ? loop.polish : null;
    if (role === 'test' && report.verdict?.result === 'defects') {
      const defects = report.verdict.defects.map((d) => `- ${d}`).join('\n');
      const head = pass
        ? `Verdict du test sur ${loop.issueId} (passe ${String(pass.done + 1)}/${String(pass.total)}) : défauts.\n`
        : `Verdict du test sur ${loop.issueId} (tour ${String(loop.round)}/${String(this.maxRounds(ws))}) : défauts.\n`;
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
    } else if (role === 'test' && report.verdict?.result === 'defects' && pass) {
      // P2 — the same pass resumes once, without a round; a second « defects » on it stops the loop.
      if (pass.restarted) await this.escalate(ws.id, loop.issueId, agentId);
      else {
        await this.save(ws.id, loop.issueId, (l) => ({
          ...l,
          polish: { ...pass, restarted: true },
        }));
      }
    } else if (
      role === 'test' &&
      report.verdict?.result === 'defects' &&
      loop.round >= this.maxRounds(ws)
    ) {
      await this.escalate(ws.id, loop.issueId, agentId);
    }
    return null;
  }

  /** The head of the dev, and whether its worktree is more than that commit. */
  private async headOf(agent: Agent): Promise<{ commit: string; dirty: boolean }> {
    const [commit, headTree, { tree }] = await Promise.all([
      this.deps.git.revParse(agent.worktreePath, 'HEAD'),
      this.deps.git.treeOf(agent.worktreePath, 'HEAD'),
      this.deps.git.snapshot(agent.worktreePath),
    ]);
    return { commit, dirty: tree !== headTree };
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
    const loop = this.get(workspaceId, issueId);
    await this.save(workspaceId, issueId, (l) => ({ ...l, state: 'escalated' }));
    await this.setIssue(workspaceId, issueId, 'escalated');
    this.deps.notify(workspaceId, {
      agentId,
      kind: 'loop',
      summary:
        loop?.state === 'polishing' || loop?.rounds.at(-1)?.kind === 'polish'
          ? `Boucle arrêtée · ${issueId} · peaufinage : défauts répétés sur la même passe, l’utilisateur décide.`
          : `Boucle arrêtée · ${issueId} · ${String(this.maxRounds(this.workspace(workspaceId)))} tours : l’utilisateur décide.`,
    });
  }

  /** A run of the tests finished: the proof of a loop when it passed on the dev's current tree. */
  async testRun(run: TestRun): Promise<void> {
    if (run.status === 'running') return;
    const found = this.find(run.agentId);
    if (!found || found.loop.devAgentId !== run.agentId) return;
    const { ws, loop, agent } = found;
    // 008 R3 — the proof is on a commit: the worktree must be clean, what PACT will push.
    const { commit, dirty } = await this.headOf(agent);
    const { tree } = await this.deps.git.snapshot(agent.worktreePath);
    if (loop.state === 'polishing') {
      // 008 R23 — the end of a pass: accepted by the tester, then PACT's proof on the end commit.
      const pass = loop.rounds.at(-1);
      const accepted = pass?.reports.some(
        (r) => r.role === 'test' && r.verdict?.result === 'accepted',
      );
      if (!this.passRunning(loop) || !accepted || !loop.polish) return;
      const { done, total } = loop.polish;
      if (run.status === 'passed' && run.tree === tree && !dirty) {
        await this.saveRound(ws.id, loop.issueId, (r) => ({
          ...r,
          proof: { tree, commit, exitCode: 0, at: this.now() },
        }));
        await this.save(ws.id, loop.issueId, (l) => ({
          ...l,
          state: done + 1 >= total ? 'accepted' : 'polishing',
          polish: { done: done + 1, total, restarted: false },
        }));
        this.deps.notify(ws.id, {
          agentId: run.agentId,
          kind: 'loop',
          summary: `${loop.issueId} : passe de peaufinage ${String(done + 1)}/${String(total)} finie, tests passés par PACT.`,
        });
      }
      return;
    }
    if (run.status === 'passed' && run.tree === tree && !dirty) {
      const passes = ws.delivery.polishPasses;
      await this.saveRound(ws.id, loop.issueId, (r) => ({
        ...r,
        proof: { tree, commit, exitCode: 0, at: this.now() },
      }));
      await this.save(ws.id, loop.issueId, (l) =>
        passes > 0
          ? { ...l, state: 'polishing', polish: { done: 0, total: passes, restarted: false } }
          : { ...l, state: 'accepted' },
      );
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
        : run.status === 'passed'
          ? 'changements non commités : commite-les, PACT ne fait la preuve que sur un commit'
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
        polish: null,
        rounds: [this.newRound(1)],
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
      loops: ws.loops.map((l) =>
        l.state === 'running' || l.state === 'polishing' || l.state === 'accepted'
          ? { ...l, state: 'closed' }
          : l,
      ),
    }));
  }
}
