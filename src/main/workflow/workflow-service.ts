import type { ExchangeMessage } from '../../shared/exchanges';
import type { MergeMode } from '../../shared/delivery';
import type { Loop, Workspace } from '../../shared/model';
import {
  MAX_RUN_HISTORY,
  defaultWorkflow,
  equalWorkflows,
  outcomeOf,
  terminalOutcome,
  type OutcomeSource,
  type Run,
  type Stage,
  type Workflow,
  type WorkflowIssue,
} from '../../shared/workflow';
import type { CurrentWorkflow } from './workflow-source';
import { ceilingReached, devInstruction, testerInstruction } from '../orchestrator/loop-service';
import type { RecordInput } from '../orchestrator/exchange-service';

// 010 R5 to R9 — the engine of the workflows: one run per issue, on the version of the workflow it
// started with. It advances on the messages of the journal of 007 (PACT’s own proof included), writes its
// state BEFORE it says anything (so a restart finds the stage and replays what it missed, SC-006), and
// never moves on a pause of 009.

export interface WorkflowServiceDeps {
  workspaces: {
    get(id: string): Workspace | undefined;
    list(): Workspace[];
    update(id: string, change: (ws: Workspace) => Workspace): Promise<Workspace>;
  };
  source: {
    current(workspaceId: string): Promise<
      Pick<CurrentWorkflow, 'source' | 'oid' | 'workflow' | 'ignoredLocal'> & {
        phase2: WorkflowIssue[];
      }
    >;
  };
  exchanges: { record(workspaceId: string, draft: RecordInput): Promise<ExchangeMessage> };
  /** `workspace:runs`. */
  onChange?: (workspaceId: string, runs: Run[]) => void;
  now?: () => Date;
}

/** Kinds of the journal that can give an outcome to a stage. */
const RELEVANT = new Set<ExchangeMessage['kind']>(['report', 'loop', 'delivery', 'mockup']);
/** A chain of stages that need no event (polish without pass) never goes past this. */
const MAX_CHAIN = 20;

type Move = { from: string; to: string; outcome: string };

const stageOf = (workflow: Workflow, id: string): Stage | undefined =>
  workflow.stages.find((stage) => stage.id === id);

export class WorkflowService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: WorkflowServiceDeps) {}

  // ---------------------------------------------------------------------------- plumbing

  /** One thing at a time: the messages arrive from listeners that do not wait for one another. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private workspace(id: string): Workspace {
    const ws = this.deps.workspaces.get(id);
    if (!ws) throw new Error(`Workspace inconnu : ${id}`);
    return ws;
  }

  private async save(workspaceId: string, issueId: string, change: (run: Run) => Run) {
    const ws = await this.deps.workspaces.update(workspaceId, (current) => ({
      ...current,
      runs: current.runs.map((run) => (run.issueId === issueId ? change(run) : run)),
    }));
    this.deps.onChange?.(workspaceId, ws.runs);
    return ws.runs.find((run) => run.issueId === issueId) as Run;
  }

  // ---------------------------------------------------------------------------- reading

  /** The run of an issue, if it has one. */
  run(workspaceId: string, issueId: string): Run | undefined {
    return this.deps.workspaces.get(workspaceId)?.runs.find((run) => run.issueId === issueId);
  }

  private stageOfRun(workspaceId: string, issueId: string): Stage | undefined {
    const run = this.run(workspaceId, issueId);
    return run ? stageOf(run.workflow, run.stage) : undefined;
  }

  /** R7 — the ceiling of rounds of the version of the run; the settings of 008 without a run. */
  maxRounds(workspaceId: string, issueId: string): number {
    const run = this.run(workspaceId, issueId);
    const capped = run?.workflow.transitions.filter((t) => t.maxRounds !== undefined) ?? [];
    const here = capped.find((t) => t.from === run?.stage) ?? capped[0];
    return here?.maxRounds ?? this.workspace(workspaceId).delivery.maxRounds;
  }

  /** R9 — the passes and the brief of the polish stage of the run; the settings of 008 without one. */
  polish(workspaceId: string, issueId: string): { passes: number; brief: string } {
    const run = this.run(workspaceId, issueId);
    const stage = run?.workflow.stages.find((s) => s.type === 'polish');
    if (stage) return { passes: stage.passes ?? 0, brief: stage.instruction ?? '' };
    const { delivery } = this.workspace(workspaceId);
    return { passes: delivery.polishPasses, brief: delivery.polishBrief };
  }

  /** R9 — the merge mode of the PR stage of the run; the settings of 008 without one. */
  mergeModeOf(workspaceId: string, issueId: string | null): MergeMode {
    const run = issueId === null ? undefined : this.run(workspaceId, issueId);
    const stage = run?.workflow.stages.find((s) => s.type === 'pr');
    return stage?.mergeMode ?? this.workspace(workspaceId).delivery.mergeMode;
  }

  /** O2 — what the workflow asks of the agent launched with the role `spec`, once. */
  async specInstruction(workspaceId: string): Promise<string | null> {
    const { workflow } = await this.deps.source.current(workspaceId);
    const spec = workflow.stages.find((stage) => stage.type === 'spec');
    return spec?.instruction ? `Consigne du workflow : ${spec.instruction}` : null;
  }

  // ---------------------------------------------------------------------------- creating

  /** R8 — the issue has a run (created on the start stage), and moves on if its state says so. */
  register(workspaceId: string, issueId: string): Promise<Run> {
    return this.serial(async () => {
      const existing = this.run(workspaceId, issueId) ?? (await this.create(workspaceId, issueId));
      return this.fromIssue(workspaceId, existing);
    });
  }

  /** R8 — the run of an issue that began before 010: on the stage its loop is in, silently. */
  ensure(workspaceId: string, issueId: string): Promise<Run> {
    return this.serial(() => this.ensureNow(workspaceId, issueId));
  }

  private async ensureNow(workspaceId: string, issueId: string): Promise<Run> {
    const existing = this.run(workspaceId, issueId);
    if (existing) return existing;
    const created = await this.create(workspaceId, issueId);
    const ws = this.workspace(workspaceId);
    const loop = ws.loops.find((l) => l.issueId === issueId && l.state !== 'closed');
    const issue = ws.issues.find((i) => i.id === issueId);
    const target = loop
      ? this.stageForLoop(created.workflow, loop)
      : issue && issue.state !== 'proposed'
        ? this.stageForIssue(created.workflow)
        : undefined;
    if (!target || target === created.stage) return created;
    return this.save(workspaceId, issueId, (run) => ({
      ...run,
      stage: target,
      status:
        loop?.state === 'merged'
          ? 'finished'
          : loop?.state === 'escalated'
            ? 'waiting-user'
            : run.status,
      entries: { ...run.entries, [target]: (run.entries[target] ?? 0) + 1 },
      updatedAt: this.now(),
    }));
  }

  private firstOfType(workflow: Workflow, type: Stage['type']): string | undefined {
    return workflow.stages.find((stage) => stage.type === type)?.id;
  }

  private stageForIssue(workflow: Workflow): string | undefined {
    return this.firstOfType(workflow, 'test') ?? workflow.start;
  }

  private stageForLoop(workflow: Workflow, loop: Loop): string {
    const pick = (type: Stage['type']) => this.firstOfType(workflow, type) ?? workflow.start;
    if (loop.state === 'polishing') return pick('polish');
    if (loop.state === 'delivering' || loop.state === 'accepted' || loop.state === 'merged') {
      return pick('pr');
    }
    const reports = loop.rounds.at(-1)?.reports ?? [];
    const last = reports.at(-1);
    if (!last || last.role === 'dev') return pick('test');
    return pick('dev');
  }

  private async create(workspaceId: string, issueId: string): Promise<Run> {
    const current = await this.deps.source.current(workspaceId);
    const again = this.run(workspaceId, issueId);
    if (again) return again;
    const now = this.now();
    const journal = this.workspace(workspaceId).exchanges.messages;
    const refused = current.phase2.length > 0;
    const run: Run = {
      issueId,
      oid: current.oid,
      workflow: current.workflow,
      stage: current.workflow.start,
      status: refused ? 'refused' : 'active',
      bindings: {},
      entries: { [current.workflow.start]: 1 },
      lastMessageId: journal.at(-1)?.id ?? null,
      history: [],
      reason: refused
        ? `Fonction de deuxième phase non exécutée : ${current.phase2[0]?.message ?? 'workflow'}`
        : null,
      startedAt: now,
      updatedAt: now,
    };
    const ws = await this.deps.workspaces.update(workspaceId, (w) => ({
      ...w,
      runs: [...w.runs.filter((r) => r.issueId !== issueId), run],
    }));
    this.deps.onChange?.(workspaceId, ws.runs);
    return run;
  }

  /** The run at the stage `spec` leaves it when the issue is ready. */
  private async fromIssue(workspaceId: string, run: Run): Promise<Run> {
    if (run.status !== 'active') return run;
    const stage = stageOf(run.workflow, run.stage);
    const issue = this.workspace(workspaceId).issues.find((i) => i.id === run.issueId);
    if (!stage || !issue) return run;
    const outcome = outcomeOf(stage.type, { kind: 'issue', issueState: issue.state });
    if (!outcome) return run;
    return (await this.advance(workspaceId, run, outcome, null)) ?? run;
  }

  // ---------------------------------------------------------------------------- the journal

  /** A message of the journal: it may be the outcome of the stage of the run of its issue. */
  handle(workspaceId: string, message: ExchangeMessage): Promise<void> {
    return this.serial(() => this.handleNow(workspaceId, message));
  }

  /** At the start: what the journal said after the last message each run saw (SC-006). */
  resume(): Promise<void> {
    return this.serial(async () => {
      for (const ws of this.deps.workspaces.list()) {
        for (const run of ws.runs) {
          if (run.status !== 'active') continue;
          const messages = this.workspace(ws.id).exchanges.messages;
          const at =
            run.lastMessageId === null ? -1 : messages.findIndex((m) => m.id === run.lastMessageId);
          for (const message of at < 0 && run.lastMessageId !== null
            ? []
            : messages.slice(at + 1)) {
            await this.handleNow(ws.id, message);
          }
        }
      }
    });
  }

  private issueOf(ws: Workspace, message: ExchangeMessage): string | undefined {
    if (message.delivery) {
      const found = ws.deliveries.find((d) => d.id === message.delivery?.id)?.issueId;
      if (found) return found;
    }
    const ids = [message.about, message.from, message.to];
    const loops = ws.loops.filter(
      (l) => l.state !== 'closed' && ids.some((id) => id === l.devAgentId || id === l.testAgentId),
    );
    return loops.at(-1)?.issueId;
  }

  /** What the message says, in the words of R5, from the state PACT saved before it wrote the message. */
  private sourcesOf(ws: Workspace, message: ExchangeMessage, issueId: string): OutcomeSource[] {
    const loop = ws.loops.find((l) => l.issueId === issueId && l.state !== 'closed');
    switch (message.kind) {
      case 'report': {
        const id = message.about ?? message.from;
        const report = (loop?.rounds ?? [])
          .flatMap((round) => round.reports)
          .filter((r) => r.agentId === id)
          .at(-1);
        if (!report) return [];
        if (report.verdict?.result === 'defects') {
          return [{ kind: 'verdict', verdict: 'defects' }];
        }
        // A verdict `accepted` is no outcome by itself: only the proof of PACT is (the loop says it).
        if (report.verdict) return [];
        return [{ kind: 'report', role: report.role, status: report.status }];
      }
      case 'loop':
        return loop ? [{ kind: 'loop', loop: loop.state }] : [];
      case 'delivery':
        return message.delivery
          ? [{ kind: 'delivery', delivery: { outcome: message.delivery.outcome } }]
          : [];
      case 'mockup':
        return [{ kind: 'mockup' }];
      default:
        return [];
    }
  }

  private async handleNow(workspaceId: string, message: ExchangeMessage): Promise<void> {
    if (!RELEVANT.has(message.kind)) return;
    const ws = this.deps.workspaces.get(workspaceId);
    if (!ws) return;
    const issueId = this.issueOf(ws, message);
    if (issueId === undefined) return;
    const run = this.run(workspaceId, issueId) ?? (await this.ensureNow(workspaceId, issueId));
    if (run.status !== 'active') return;
    const messages = ws.exchanges.messages;
    const seen =
      run.lastMessageId === null ? -1 : messages.findIndex((m) => m.id === run.lastMessageId);
    if (seen >= 0 && messages.findIndex((m) => m.id === message.id) <= seen) return;
    const stage = stageOf(run.workflow, run.stage);
    const outcome = stage
      ? this.sourcesOf(ws, message, issueId)
          .map((source) => outcomeOf(stage.type, source))
          .find((found) => found !== null)
      : undefined;
    if (!outcome) {
      await this.save(workspaceId, issueId, (r) => ({ ...r, lastMessageId: message.id }));
      return;
    }
    await this.advance(workspaceId, run, outcome, message.id);
  }

  // ---------------------------------------------------------------------------- moving on

  /**
   * The transition of the run on an outcome: the state is written first, then the orchestrator is told.
   * A stage that needs no event (a polish of no pass) leaves at once, in the same move.
   */
  private async advance(
    workspaceId: string,
    run: Run,
    first: string,
    messageId: string | null,
  ): Promise<Run | undefined> {
    const ws = this.workspace(workspaceId);
    const loop = ws.loops.find((l) => l.issueId === run.issueId && l.state !== 'closed');
    const moves: Move[] = [];
    let stageId = run.stage;
    let outcome: string | null = first;
    let finished = false;
    let capped: number | null = null;
    for (let i = 0; i < MAX_CHAIN && outcome !== null; i += 1) {
      const stage = stageOf(run.workflow, stageId);
      if (!stage) break;
      const transition = run.workflow.transitions.find(
        (t) => t.from === stageId && t.on.includes(outcome as string),
      );
      if (!transition) {
        if (run.workflow.ends.includes(stageId) && outcome === terminalOutcome(stage.type)) {
          finished = true;
        }
        break;
      }
      if (
        transition.maxRounds !== undefined &&
        loop &&
        (loop.state === 'escalated' ||
          (outcome === 'defects' && ceilingReached(loop.round, transition.maxRounds)))
      ) {
        capped = transition.maxRounds;
        break;
      }
      moves.push({ from: stageId, to: transition.to, outcome });
      stageId = transition.to;
      const entered = stageOf(run.workflow, stageId);
      outcome = entered?.type === 'polish' && (entered.passes ?? 0) === 0 ? 'done' : null;
    }
    const issueId = run.issueId;
    const lead = ws.agents.find((a) => a.role === 'orchestrator');
    if (capped !== null) {
      await this.save(workspaceId, issueId, (r) => ({
        ...r,
        status: 'waiting-user',
        lastMessageId: messageId ?? r.lastMessageId,
        updatedAt: this.now(),
      }));
      await this.tell(workspaceId, lead?.id, {
        issue: issueId,
        from: run.stage,
        to: run.stage,
        outcome: first,
        text: `Étape ${run.stage} · ${issueId} : plafond de ${String(capped)} tours atteint, l’utilisateur décide`,
      });
      return this.run(workspaceId, issueId);
    }
    if (moves.length === 0 && !finished) {
      await this.save(workspaceId, issueId, (r) => ({
        ...r,
        lastMessageId: messageId ?? r.lastMessageId,
      }));
      return this.run(workspaceId, issueId);
    }
    const at = this.now();
    const saved = await this.save(workspaceId, issueId, (r) => {
      const entries = { ...r.entries };
      for (const move of moves) entries[move.to] = (entries[move.to] ?? 0) + 1;
      return {
        ...r,
        stage: stageId,
        status: finished ? 'finished' : r.status,
        entries,
        history: [...r.history, ...moves.map((m) => ({ at, ...m }))].slice(-MAX_RUN_HISTORY),
        lastMessageId: messageId ?? r.lastMessageId,
        updatedAt: at,
      };
    });
    if (finished) {
      await this.tell(workspaceId, lead?.id, {
        issue: issueId,
        from: run.stage,
        to: run.stage,
        outcome: first,
        text: `Workflow terminé · ${issueId}`,
      });
      return saved;
    }
    const entered = stageOf(saved.workflow, saved.stage);
    const root = moves[0] as Move;
    await this.tell(workspaceId, lead?.id, {
      issue: issueId,
      from: root.from,
      to: saved.stage,
      outcome: root.outcome,
      text: this.stageText(saved, entered, root),
    });
    if (entered) await this.instruct(workspaceId, saved, entered, Object.keys(saved.bindings));
    return saved;
  }

  private stageText(run: Run, stage: Stage | undefined, move: Move): string {
    const head = `Étape ${run.stage} · ${run.issueId} (après ${move.from} : ${move.outcome})`;
    if (!stage) return head;
    if (stage.type === 'pr') return `${head}\nPACT livre l’issue : rien à lancer.`;
    const roles = stage.agents.map((key) => run.workflow.agents[key]?.role ?? key);
    return roles.length === 0 ? head : `${head}\nPour toi : lance ${roles.join(' et ')}.`;
  }

  private async tell(
    workspaceId: string,
    leadId: string | undefined,
    change: Move & { issue: string; text: string },
  ) {
    if (leadId === undefined) return;
    await this.deps.exchanges.record(workspaceId, {
      from: 'pact',
      to: leadId,
      kind: 'stage',
      text: change.text,
      stage: {
        issue: change.issue,
        from: change.from,
        to: change.to,
        outcome: change.outcome,
      },
    });
  }

  // ---------------------------------------------------------------------------- the instruction

  private fixedText(stage: Stage, issueId: string): string {
    if (stage.type === 'dev') return devInstruction(issueId);
    if (stage.type === 'test') return testerInstruction(issueId);
    return `Étape ${stage.id} de l’issue ${issueId} (lis .pact/issues/${issueId}.md dans ton worktree) : fais ce qui est demandé, puis rends ton rapport avec submit_report.`;
  }

  /** R9 — the instruction of a stage to the bound agents (keys) of that stage; nothing without one. */
  private async instruct(workspaceId: string, run: Run, stage: Stage, keys: readonly string[]) {
    // The polish and the PR have their own words (008): the settings of the stage are read there.
    if (!stage.instruction || stage.type === 'polish' || stage.type === 'pr') return;
    for (const key of stage.agents) {
      const to = run.bindings[key];
      if (!keys.includes(key) || to === undefined) continue;
      await this.deps.exchanges.record(workspaceId, {
        from: 'pact',
        to,
        kind: 'instruction',
        text: `${this.fixedText(stage, run.issueId)}\n\nConsigne du workflow : ${stage.instruction}`,
      });
    }
  }

  /** The agents of the loop are bound to the keys of the workflow by role; new ones hear the stage. */
  bind(workspaceId: string, issueId: string, ids: { test?: string; dev?: string }): Promise<void> {
    return this.serial(async () => {
      const run = await this.ensureNow(workspaceId, issueId);
      const bindings = { ...run.bindings };
      const changed: string[] = [];
      for (const [key, agent] of Object.entries(run.workflow.agents)) {
        const id = agent.role === 'test' ? ids.test : agent.role === 'dev' ? ids.dev : undefined;
        if (id !== undefined && bindings[key] !== id) {
          bindings[key] = id;
          changed.push(key);
        }
      }
      if (changed.length === 0) return;
      const saved = await this.save(workspaceId, issueId, (r) => ({
        ...r,
        bindings,
        updatedAt: this.now(),
      }));
      const stage = stageOf(saved.workflow, saved.stage);
      if (stage && saved.status === 'active')
        await this.instruct(workspaceId, saved, stage, changed);
    });
  }

  /**
   * FR-020 — a project without file lives by the settings of 008, read live: when they change, the runs
   * on the default workflow take the new one (a run on a file keeps the version it started with).
   */
  settingsChanged(workspaceId: string): Promise<void> {
    return this.serial(async () => {
      const ws = this.workspace(workspaceId);
      const fresh = defaultWorkflow(ws.delivery);
      for (const run of ws.runs) {
        if (run.oid !== 'default' || run.status === 'finished' || run.status === 'refused')
          continue;
        if (equalWorkflows(run.workflow, fresh) || !stageOf(fresh, run.stage)) continue;
        await this.save(workspaceId, run.issueId, (r) => ({
          ...r,
          workflow: fresh,
          updatedAt: this.now(),
        }));
      }
    });
  }

  /** The loop stops for the user, or starts again: the run waits for them, or is active. */
  setWaiting(workspaceId: string, issueId: string, waiting: boolean): Promise<void> {
    return this.serial(async () => {
      const run = this.run(workspaceId, issueId);
      if (!run) return;
      if (waiting && run.status === 'active') {
        await this.save(workspaceId, issueId, (r) => ({
          ...r,
          status: 'waiting-user',
          updatedAt: this.now(),
        }));
      } else if (!waiting && run.status === 'waiting-user') {
        await this.save(workspaceId, issueId, (r) => ({
          ...r,
          status: 'active',
          updatedAt: this.now(),
        }));
      }
    });
  }
}
