import type { PactApi } from '../shared/ipc';

declare global {
  interface Window {
    /** Exposed by the preload (src/preload/api.ts). */
    pact: PactApi;
  }
}

export {};
