import { z } from 'zod';
import { repoPathSchema } from './primitives';

// 004 US4 — the Aperçu tab of the Focus: mockups, recap and issues of an agent's worktree,
// served by the `pact-preview:` protocol (research R9, contracts/files.md).

export const PREVIEW_SCHEME = 'pact-preview';

export const previewKindSchema = z.enum(['mockup', 'recap', 'issue', 'other']);
export type PreviewKind = z.infer<typeof previewKindSchema>;

export const previewFileSchema = z.object({ path: repoPathSchema, kind: previewKindSchema });
export type PreviewFile = z.infer<typeof previewFileSchema>;

/** What the Aperçu lists; `null` for a file it does not (contracts/files.md). */
export function previewKind(path: string): PreviewKind | null {
  if (path === '.pact/recap.md') return 'recap';
  if (/^design\/mockups\/[^/]+\.html$/.test(path)) return 'mockup';
  if (/^\.pact\/issues\/[^/]+\.md$/.test(path)) return 'issue';
  return null;
}

/** `pact-preview://<agentId>/<path>`, each segment encoded. */
export const previewUrl = (agentId: string, path: string) =>
  `${PREVIEW_SCHEME}://${agentId}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** What the script PACT adds to every page tells the Aperçu, through `postMessage`. */
export type PreviewMessage =
  | { pactPreview: true; type: 'ready' }
  | { pactPreview: true; type: 'scroll'; y: number }
  | { pactPreview: true; type: 'blocked'; url: string };
