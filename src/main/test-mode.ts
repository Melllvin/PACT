type PathSetter = { setPath(name: 'userData', path: string): void };

/** In e2e runs (PACT_TEST_MODE=1), isolates app data in the directory chosen by the harness. */
export function applyTestMode(app: PathSetter, env: NodeJS.ProcessEnv): void {
  if (env.PACT_TEST_MODE !== '1' || !env.PACT_USER_DATA_DIR) return;
  app.setPath('userData', env.PACT_USER_DATA_DIR);
}
