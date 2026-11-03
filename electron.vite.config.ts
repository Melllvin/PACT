import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const shared = { '@shared': resolve('src/shared') };

/** The commit this build comes from; « dev » without git (src/shared/build-info.ts). */
const commit = (): string => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
};
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const define = {
  __PACT_BUILD__: JSON.stringify({ version, commit: commit(), builtAt: new Date().toISOString() }),
};

export default defineConfig({
  main: {
    resolve: { alias: shared },
    define,
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // Standalone hook relay run by agent CLIs (ELECTRON_RUN_AS_NODE=1).
          'hook-bridge': resolve('src/main/agents/hook-bridge.ts'),
        },
        external: ['node-pty'],
      },
    },
  },
  preload: {
    resolve: { alias: shared },
    build: {
      // A sandboxed preload can only require 'electron': bundle every other dependency.
      externalizeDeps: false,
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        // Sandboxed renderers cannot load ESM preload scripts: emit CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    // '@' is the alias the shadcn/ui components import from (components.json, R16).
    resolve: { alias: { ...shared, '@': resolve('src/renderer') } },
    define,
    plugins: [react(), tailwindcss()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
