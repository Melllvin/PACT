import { describe, expect, it } from 'vitest';
import { createAppServices } from '../../../../src/main/app-services';
import { createAgentServices } from '../../../../src/main/ipc/agent-handlers';
import { ipcRequests } from '../../../../src/shared/ipc';

// contracts/ipc.md — a channel the renderer may call is served by the main process.

/** Declared ahead of the story that serves it. */
const pending = new Set([
  // T109: « reprise auto à HH:MM · Annuler » (US7).
  'agent:cancelAutoResume',
]);

describe('IPC channels', () => {
  it('serves every request channel of the contract', () => {
    // Building the services only keeps their dependencies: nothing is called.
    const served = new Set([
      ...Object.keys(createAppServices({} as never)),
      ...Object.keys(createAgentServices({} as never)),
    ]);
    const channels = Object.keys(ipcRequests);
    expect(channels.filter((channel) => !served.has(channel) && !pending.has(channel))).toEqual([]);
    expect([...served].filter((channel) => !channels.includes(channel))).toEqual([]);
  });
});
