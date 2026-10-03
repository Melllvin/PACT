import { describe, expect, it, vi } from 'vitest';
import { createReviewServices } from '../../../../src/main/ipc/review-handlers';

// 002 T021 — the US1 review channels, served by ReviewService (contracts/ipc.md).

const agentId = '00000000-0000-4000-8000-000000000001';

describe('review handlers', () => {
  it('pass each request to the review service', async () => {
    const review = {
      open: vi.fn(() => Promise.resolve('snapshot')),
      close: vi.fn(),
      fileDiff: vi.fn(() => Promise.resolve('diff')),
      setSeen: vi.fn(() => Promise.resolve()),
    };
    const services = createReviewServices({ review: review as never });
    expect(await services['review:open']({ agentId })).toBe('snapshot');
    services['review:close']({ agentId });
    expect(review.close).toHaveBeenCalledWith(agentId);
    expect(await services['review:fileDiff']({ agentId, path: 'a.ts' })).toBe('diff');
    expect(review.fileDiff).toHaveBeenCalledWith(agentId, 'a.ts');
    await services['review:setSeen']({ agentId, path: 'a.ts', seen: true });
    expect(review.setSeen).toHaveBeenCalledWith(agentId, 'a.ts', true);
  });
});
