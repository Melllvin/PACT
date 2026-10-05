import { IpcFailure, type IpcInput } from '../../shared/ipc';
import type { Workspace } from '../../shared/model';
import type { IntegrationService } from '../review/integration-service';
import type { ReviewService } from '../review/review-service';
import type { TestRunner } from '../review/test-runner';

// 002 — review channels (contracts/ipc.md). T021: US1, reading the changes of an agent.
// T034: US2, the tests of the Décision column and the integration into main.
// T041: US3, comments and instructions sent to the agent.

type Dependencies = {
  review: Pick<
    ReviewService,
    'open' | 'close' | 'fileDiff' | 'setSeen' | 'updatePending' | 'testPlan' | 'comment' | 'send'
  >;
  tests: Pick<TestRunner, 'run' | 'ensure' | 'cancel'>;
  integration: Pick<IntegrationService, 'start'>;
  workspaces: {
    update(id: string, change: (workspace: Workspace) => Workspace): Promise<Workspace>;
  };
};

export function createReviewServices({ review, tests, integration, workspaces }: Dependencies) {
  return {
    'review:open': async ({ agentId }: IpcInput<'review:open'>) => {
      const snapshot = await review.open(agentId);
      if (!snapshot.missing) {
        // FR-016: the tests run on opening, unless a result is already for the tree shown.
        const { target, command } = await review.testPlan(agentId);
        // Started, not awaited: the review opens whatever happens to the tests.
        if (command !== null)
          void tests.ensure(target, command, snapshot.tree).catch(() => undefined);
      }
      return snapshot;
    },
    'review:close': ({ agentId }: IpcInput<'review:close'>) => {
      review.close(agentId);
    },
    'review:listPending': ({ workspaceId }: IpcInput<'review:listPending'>) =>
      review.updatePending(workspaceId),
    'review:fileDiff': ({ agentId, path }: IpcInput<'review:fileDiff'>) =>
      review.fileDiff(agentId, path),
    'review:setSeen': ({ agentId, path, seen }: IpcInput<'review:setSeen'>) =>
      review.setSeen(agentId, path, seen),
    'review:comment': ({ agentId, path, line, text }: IpcInput<'review:comment'>) =>
      review.comment(agentId, path, line, text),
    'review:send': (request: IpcInput<'review:send'>) => review.send(request),
    'review:runTests': async ({ agentId }: IpcInput<'review:runTests'>) => {
      const { target, command, tree } = await review.testPlan(agentId);
      // The column offers « Configurer » instead (FR-017).
      if (command === null) throw new IpcFailure('INVALID_INPUT', 'Tests non configurés.');
      return tests.run(target, command, tree);
    },
    'review:cancelTests': ({ agentId }: IpcInput<'review:cancelTests'>) => {
      tests.cancel(agentId);
    },
    'workspace:setTestCommand': async ({
      workspaceId,
      command,
    }: IpcInput<'workspace:setTestCommand'>) => {
      await workspaces.update(workspaceId, (workspace) => ({ ...workspace, testCommand: command }));
    },
    'integration:start': (request: IpcInput<'integration:start'>) => integration.start(request),
  };
}
