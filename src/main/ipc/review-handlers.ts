import type { IpcInput } from '../../shared/ipc';
import type { ReviewService } from '../review/review-service';

// 002 — review channels (contracts/ipc.md). T021: US1, reading the changes of an agent.

type Dependencies = {
  review: Pick<ReviewService, 'open' | 'close' | 'fileDiff' | 'setSeen'>;
};

export function createReviewServices({ review }: Dependencies) {
  return {
    'review:open': ({ agentId }: IpcInput<'review:open'>) => review.open(agentId),
    'review:close': ({ agentId }: IpcInput<'review:close'>) => {
      review.close(agentId);
    },
    'review:fileDiff': ({ agentId, path }: IpcInput<'review:fileDiff'>) =>
      review.fileDiff(agentId, path),
    'review:setSeen': ({ agentId, path, seen }: IpcInput<'review:setSeen'>) =>
      review.setSeen(agentId, path, seen),
  };
}
