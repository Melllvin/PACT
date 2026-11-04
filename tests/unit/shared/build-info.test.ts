import { describe, expect, it } from 'vitest';
import { BUILD_INFO, formatBuildInfo } from '../../../src/shared/build-info';

describe('formatBuildInfo', () => {
  it('gives the version, the commit and the day of the build', () => {
    expect(
      formatBuildInfo({ version: '1.0.0', commit: '928bb75', builtAt: '2026-11-03T20:03:00.000Z' }),
    ).toBe('PACT 1.0.0 · 928bb75 · 3 nov. 2026');
  });

  it('leaves out a day it does not know', () => {
    expect(formatBuildInfo({ version: '1.0.0', commit: 'dev', builtAt: '' })).toBe(
      'PACT 1.0.0 · dev',
    );
    expect(formatBuildInfo({ version: '1.0.0', commit: 'dev', builtAt: 'never' })).toBe(
      'PACT 1.0.0 · dev',
    );
  });

  it('is a dev build outside the bundler', () => {
    expect(BUILD_INFO.commit).toBe('dev');
  });
});
