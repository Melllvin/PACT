import { describe, expect, it } from 'vitest';
import {
  beyondCeiling,
  defaultProfile,
  profileWarnings,
  profilesOf,
  tierOf,
  type TieredCli,
} from '../../../src/shared/roles';
import type { RoleProfile } from '../../../src/shared/model';

const TIERS = [['haiku'], ['sonnet'], ['opus']];
const claude: TieredCli = { id: 'claude-code', status: 'installed', modelTiers: TIERS };
const codex: TieredCli = { id: 'codex', status: 'installed', modelTiers: [] };
const profile = (over: Partial<RoleProfile> = {}): RoleProfile => ({
  cliId: 'claude-code',
  model: 'sonnet',
  effort: null,
  maxModel: 'opus',
  escalate: false,
  ...over,
});

describe('role profiles (004 T008)', () => {
  it('gives the strong tier to orchestrator, spec and design, medium to dev and test, small to recap', () => {
    const model = (role: Parameters<typeof defaultProfile>[0]) =>
      defaultProfile(role, [codex, claude])?.model;
    expect(model('orchestrator')).toBe('opus');
    expect(model('spec')).toBe('opus');
    expect(model('design')).toBe('opus');
    expect(model('dev')).toBe('sonnet');
    expect(model('test')).toBe('sonnet');
    expect(model('recap')).toBe('haiku');
  });

  it('takes the first installed CLI with tiers, with the top tier as ceiling', () => {
    const missing: TieredCli = { ...claude, id: 'other', status: 'missing' };
    expect(defaultProfile('dev', [missing, codex, claude])).toEqual({
      cliId: 'claude-code',
      model: 'sonnet',
      effort: null,
      maxModel: 'opus',
      escalate: false,
    });
  });

  it('falls back on the first installed CLI with null models, and on nothing without any', () => {
    expect(defaultProfile('dev', [codex])).toEqual({
      cliId: 'codex',
      model: null,
      effort: null,
      maxModel: null,
      escalate: false,
    });
    expect(defaultProfile('dev', [{ ...codex, status: 'missing' }])).toBeNull();
  });

  it('keeps the user’s profiles and fills the others with defaults', () => {
    const mine = profile({ model: 'opus' });
    const profiles = profilesOf({ dev: mine }, [claude]);
    expect(profiles.dev).toBe(mine);
    expect(profiles.recap?.model).toBe('haiku');
    expect(Object.keys(profiles)).toHaveLength(6);
  });

  it('applies the ceiling to known names only', () => {
    expect(tierOf('sonnet', TIERS)).toBe(1);
    expect(tierOf('my-model', TIERS)).toBe(-1);
    expect(beyondCeiling('opus', 'sonnet', TIERS)).toBe(true);
    expect(beyondCeiling('sonnet', 'sonnet', TIERS)).toBe(false);
    expect(beyondCeiling('my-model', 'haiku', TIERS)).toBe(false);
    expect(beyondCeiling('opus', null, TIERS)).toBe(false);
  });

  it('warns, without blocking, when the test is weaker than the dev (FR-004)', () => {
    const weaker = { dev: profile(), test: profile({ model: 'haiku' }) };
    expect(profileWarnings(weaker, [claude])).toEqual([
      'Le profil test (haiku) est plus faible que le profil dev (sonnet).',
    ]);
    expect(profileWarnings({ dev: profile(), test: profile({ model: 'opus' }) }, [claude])).toEqual(
      [],
    );
    expect(profileWarnings({ dev: profile(), test: profile({ model: 'free' }) }, [claude])).toEqual(
      [],
    );
  });
});
