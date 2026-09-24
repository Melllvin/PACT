import { contextBridge } from 'electron';

// Typed IPC channels are added with contracts/ipc.md (T035).
const api = {};

export type PactApi = typeof api;

contextBridge.exposeInMainWorld('pact', api);
