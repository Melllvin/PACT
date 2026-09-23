import { describe, it, expect } from 'vitest';
import {
  agentSchema,
  permissionPreferenceSchema,
  workspaceSchema,
} from '../../../src/shared/model';
describe('model schemas', () => {
  it('defaults auto resume', () =>
    expect(permissionPreferenceSchema.parse({ scope: 'global' }).autoResume).toBe(true));
  it('limits agents to six', () =>
    expect(workspaceSchema.shape.agents.safeParse(Array(7).fill({})).success).toBe(false));
  it('restricts position', () =>
    expect(agentSchema.shape.position.safeParse(7).success).toBe(false));
});
