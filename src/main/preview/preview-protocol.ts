import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { Marked } from 'marked';

// 004 US4 — `pact-preview://<agentId>/<path>`: the files of an agent's worktree only, with no
// network and no script but the page's own (FR-026, research R9).

/** A mockup may run its own inline scripts; nothing comes from elsewhere. */
export const HTML_CSP =
  "default-src 'none'; img-src pact-preview: data:; style-src pact-preview: 'unsafe-inline'; " +
  "font-src pact-preview: data:; script-src pact-preview: 'unsafe-inline'";

/** Markdown runs no script at all, save PACT's own (by its nonce). */
const markdownCsp = (nonce: string) =>
  "default-src 'none'; img-src pact-preview: data:; style-src 'unsafe-inline'; " +
  `script-src 'nonce-${nonce}'`;

/** Bigger files are shown as a notice, not rendered. */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const HTML = 'text/html; charset=utf-8';
const TEXT = 'text/plain; charset=utf-8';

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * PACT's script in every page: it tells the Aperçu what was blocked and where the reader is, and
 * takes the reader back there after a refresh (FR-026, FR-027).
 */
const bridge = (nonce = '') =>
  `<script${nonce ? ` nonce="${nonce}"` : ''}>(() => {
  const send = (message) => parent.postMessage({ pactPreview: true, ...message }, '*');
  document.addEventListener('securitypolicyviolation', (event) =>
    send({ type: 'blocked', url: event.blockedURI }));
  addEventListener('scroll', () => send({ type: 'scroll', y: scrollY }), { passive: true });
  addEventListener('message', (event) => {
    if (event.source === parent && typeof event.data?.pactScrollTo === 'number') {
      scrollTo(0, event.data.pactScrollTo);
    }
  });
  addEventListener('load', () => send({ type: 'ready' }));
})();</script>`;

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

// Raw HTML in Markdown is shown as text, never run.
const markdown = new Marked({ async: false, renderer: { html: ({ text }) => escapeHtml(text) } });

/** Markdown as a static page. */
export function renderMarkdown(text: string, nonce = ''): string {
  const body = markdown.parse(text) as string;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
body { margin: 0; padding: 20px 28px; font: 14px/1.6 system-ui, sans-serif; color: #e4e4e7;
  background: #09090b; }
a { color: #a78bfa; } code, pre { font-family: ui-monospace, monospace; font-size: 12.5px; }
pre { padding: 10px 12px; overflow: auto; border-radius: 8px; background: #18181b; }
table { border-collapse: collapse; } td, th { padding: 4px 8px; border: 1px solid #27272a; }
</style>${bridge(nonce)}</head><body>${body}</body></html>`;
}

/** The file of `path` inside `worktree`, its links followed; `null` outside it or missing. */
export async function resolvePreviewFile(worktree: string, path: string): Promise<string | null> {
  const relativePath = normalize(path);
  if (path === '' || isAbsolute(relativePath) || relativePath.split(sep).includes('..')) {
    return null;
  }
  try {
    const root = await realpath(worktree);
    const file = await realpath(join(root, relativePath));
    const inside = relative(root, file);
    if (inside === '' || inside.split(sep)[0] === '..' || isAbsolute(inside)) return null;
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

const respond = (body: string | Uint8Array, type: string, csp: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      'content-type': type,
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });

/** HTML with PACT's script, Markdown rendered, known assets as such, the rest as text. */
export async function previewResponse(file: string): Promise<Response> {
  const { size } = await stat(file);
  if (size > MAX_PREVIEW_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    return respond(`Fichier trop gros pour l’Aperçu (${mb} Mo).`, TEXT, HTML_CSP);
  }
  const extension = extname(file).toLowerCase();
  if (extension === '.md') {
    const nonce = randomBytes(16).toString('base64');
    const page = renderMarkdown(await readFile(file, 'utf8'), nonce);
    return respond(page, HTML, markdownCsp(nonce));
  }
  if (extension === '.html' || extension === '.htm') {
    const page = await readFile(file, 'utf8');
    const head = /<head[^>]*>/i.exec(page);
    const at = head ? head.index + head[0].length : 0;
    return respond(page.slice(0, at) + bridge() + page.slice(at), HTML, HTML_CSP);
  }
  return respond(await readFile(file), TYPES[extension] ?? TEXT, HTML_CSP);
}

/** The `pact-preview:` handler; `worktreeOf` names the worktree of an open agent. */
export function createPreviewHandler(worktreeOf: (agentId: string) => string | null) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const worktree = worktreeOf(url.hostname);
    let path: string;
    try {
      path = decodeURIComponent(url.pathname.slice(1));
    } catch {
      path = '';
    }
    const file = worktree === null ? null : await resolvePreviewFile(worktree, path);
    if (file === null) return respond('Fichier introuvable.', TEXT, HTML_CSP, 404);
    return previewResponse(file);
  };
}
