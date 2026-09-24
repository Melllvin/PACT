import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const shared = { '@shared': resolve('src/shared') };

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
    plugins: [react()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
