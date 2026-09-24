import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { createPactApi } from './api';

contextBridge.exposeInMainWorld('pact', createPactApi(ipcRenderer, webUtils));
