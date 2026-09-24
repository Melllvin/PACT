import { contextBridge, ipcRenderer } from 'electron';
import { createPactApi } from './api';

contextBridge.exposeInMainWorld('pact', createPactApi(ipcRenderer));
