import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

const shared = { '@shared': resolve('src/shared') };

// Vite's dev server injects CSS as inline <style> tags, which the strict CSP of index.html
// blocks. Relax style-src for the dev server only; production builds keep the strict policy.
const devServerCsp = (): Plugin => ({
  name: 'pact-dev-server-csp',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html.replace("default-src 'self';", "default-src 'self'; style-src 'self' 'unsafe-inline';"),
});

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      rollupOptions: { input: resolve('src/main/index.ts'), external: ['node-pty'] },
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
    resolve: { alias: shared },
    plugins: [react(), devServerCsp()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
