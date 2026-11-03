import type { PactApi } from '../../shared/ipc';
import type { PreviewApi } from './PreviewTab';

/** The Aperçu's channels (004 US4, contracts/ipc.md). */
export const createPreviewApi = (api: PactApi): PreviewApi => ({
  list: async (agentId) => (await api.invoke('preview:list', { agentId })).files,
  decide: (input) => api.invoke('preview:decide', input),
  onChanged: (listener) => api.on('preview:changed', listener),
});
