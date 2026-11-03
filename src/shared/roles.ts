import type { CliDefinition, Role, RoleProfile } from './model';
import { ROLES } from './primitives';

// 004 R2 — the role profiles: defaults, model tiers, ceiling and the test < dev warning (pure).

/** What the roles need to know of a CLI. */
export type TieredCli = Pick<CliDefinition, 'id' | 'status'> & { modelTiers: string[][] };

type Level = 'strong' | 'medium' | 'small';

/** FR-002: strong for those who decide, medium for the dev, the dev's for the test, small for the recap. */
const LEVEL: Record<Role, Level> = {
  orchestrator: 'strong',
  spec: 'strong',
  design: 'strong',
  dev: 'medium',
  test: 'medium',
  recap: 'small',
};

const levelIndex = (level: Level, count: number): number => {
  if (level === 'small') return 0;
  if (level === 'strong') return count - 1;
  return Math.ceil((count - 1) / 2);
};

/** The tier of a model, from 0 (smallest); -1 for `null` or a free name outside the tiers. */
export const tierOf = (model: string | null, tiers: string[][]): number =>
  model === null ? -1 : tiers.findIndex((tier) => tier.includes(model));

/** FR-005: only known names can exceed the ceiling (R2). */
export const beyondCeiling = (
  model: string | null,
  maxModel: string | null,
  tiers: string[][],
): boolean => {
  const wanted = tierOf(model, tiers);
  const ceiling = tierOf(maxModel, tiers);
  return wanted >= 0 && ceiling >= 0 && wanted > ceiling;
};

/** The first installed CLI with tiers, else the first installed one; `null` without any. */
const defaultCli = (clis: readonly TieredCli[]): TieredCli | null => {
  const installed = clis.filter((cli) => cli.status === 'installed');
  return installed.find((cli) => cli.modelTiers.length > 0) ?? installed[0] ?? null;
};

export function defaultProfile(role: Role, clis: readonly TieredCli[]): RoleProfile | null {
  const cli = defaultCli(clis);
  if (!cli) return null;
  const tiers = cli.modelTiers;
  const pick = (index: number) => tiers[index]?.[0] ?? null;
  return {
    cliId: cli.id,
    model: tiers.length > 0 ? pick(levelIndex(LEVEL[role], tiers.length)) : null,
    effort: null,
    maxModel: tiers.length > 0 ? pick(tiers.length - 1) : null,
    escalate: false,
  };
}

/** The profile of every role: the user's, else the default (never written, R2). */
export function profilesOf(
  stored: Partial<Record<Role, RoleProfile>>,
  clis: readonly TieredCli[],
): Partial<Record<Role, RoleProfile>> {
  const profiles: Partial<Record<Role, RoleProfile>> = {};
  for (const role of ROLES) {
    const profile = stored[role] ?? defaultProfile(role, clis);
    if (profile) profiles[role] = profile;
  }
  return profiles;
}

/** FR-004: a non-blocking warning when the test profile is weaker than the dev's. */
export function profileWarnings(
  profiles: Partial<Record<Role, RoleProfile>>,
  clis: readonly TieredCli[],
): string[] {
  const { dev, test } = profiles;
  if (!dev || !test || dev.cliId !== test.cliId) return [];
  const tiers = clis.find((cli) => cli.id === dev.cliId)?.modelTiers ?? [];
  const devTier = tierOf(dev.model, tiers);
  const testTier = tierOf(test.model, tiers);
  if (devTier < 0 || testTier < 0 || testTier >= devTier) return [];
  return [
    `Le profil test (${test.model ?? ''}) est plus faible que le profil dev (${dev.model ?? ''}).`,
  ];
}

/** How the tiles, the launcher and the profiles name each role. */
export const ROLE_LABELS: Record<Role, string> = {
  orchestrator: 'Orchestrateur',
  spec: 'Spec',
  design: 'Design',
  dev: 'Dev',
  test: 'Test',
  recap: 'Recap',
};
