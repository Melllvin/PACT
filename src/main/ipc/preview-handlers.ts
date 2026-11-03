import type { IpcInput } from '../../shared/ipc';
import type { PreviewService } from '../preview/preview-service';

// 004 US4 — the Aperçu channels (contracts/ipc.md).

type Dependencies = { preview: Pick<PreviewService, 'list' | 'decide'> };

export function createPreviewServices({ preview }: Dependencies) {
  return {
    'preview:list': async ({ agentId }: IpcInput<'preview:list'>) => ({
      files: await preview.list(agentId),
    }),
    'preview:decide': ({ agentId, path, decision, comment }: IpcInput<'preview:decide'>) => {
      preview.decide(agentId, path, decision, comment);
      return Promise.resolve();
    },
  };
}
