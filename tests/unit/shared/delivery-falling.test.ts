import { describe, expect, it } from 'vitest';
import { fallingDelivery, type Delivery } from '../../../src/shared/delivery';

// 008 US6 sc.6 — which request falls when the user closes an agent (CloseAgentDialog warns of it).
const d = (over: Partial<Pick<Delivery, 'state' | 'pr'>> = {}) => ({
  agentId: 'dev',
  testAgentId: 'test',
  state: 'watching' as Delivery['state'],
  pr: { number: 12, url: 'https://github.com/o/r/pull/12', expectedAuthor: 'me' },
  ...over,
});

describe('fallingDelivery', () => {
  it('finds the request of the dev or of the tester, with its PR number', () => {
    expect(fallingDelivery([d()], 'dev')).toEqual({ prNumber: 12 });
    expect(fallingDelivery([d()], 'test')).toEqual({ prNumber: 12 });
  });

  it('says null before the PR exists', () => {
    expect(fallingDelivery([d({ state: 'pushing', pr: null })], 'dev')).toEqual({ prNumber: null });
  });

  it('ignores an agent of no request, a request that is over, and a merge that was asked', () => {
    expect(fallingDelivery([d()], 'other')).toBeUndefined();
    expect(fallingDelivery([d({ state: 'dropped' })], 'dev')).toBeUndefined();
    expect(fallingDelivery([d({ state: 'merged' })], 'dev')).toBeUndefined();
    expect(fallingDelivery([d({ state: 'merging' })], 'dev')).toBeUndefined();
  });
});
