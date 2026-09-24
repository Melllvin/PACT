import { fileURLToPath } from 'node:url';

/** Absolute paths of the fake CLI and its scenarios, independent of the current directory. */
export const FAKE_CLI = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));

export const scenarioPath = (name: string) =>
  fileURLToPath(new URL(`./scenarios/${name}.json`, import.meta.url));
