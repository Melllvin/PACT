/** What a build of PACT is: its version, its commit and when it was built (set by the bundler). */
export type BuildInfo = { version: string; commit: string; builtAt: string };

declare const __PACT_BUILD__: BuildInfo | undefined;

/** Outside a bundled build (unit tests), the build is « dev ». */
export const BUILD_INFO: BuildInfo =
  typeof __PACT_BUILD__ === 'undefined'
    ? { version: '0.0.0', commit: 'dev', builtAt: '' }
    : __PACT_BUILD__;

/** « PACT 1.0.0 · 928bb75 · 3 nov. 2026 » — the date is left out when unknown. */
export const formatBuildInfo = (info: BuildInfo): string => {
  const parts = [`PACT ${info.version}`, info.commit];
  const built = info.builtAt === '' ? null : new Date(info.builtAt);
  if (built !== null && !Number.isNaN(built.getTime())) {
    parts.push(
      built.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }),
    );
  }
  return parts.join(' · ');
};
