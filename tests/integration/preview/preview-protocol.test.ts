import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPreviewHandler,
  HTML_CSP,
  MAX_PREVIEW_BYTES,
} from '../../../src/main/preview/preview-protocol';

// 004 T032 — `pact-preview://<agentId>/<path>`: only the agent's worktree, no network, no script
// from elsewhere (FR-025, FR-026, research R9).

let root: string;
let worktree: string;
const AGENT = '6f1c2a4e-8b3d-4e5f-9a7b-1c2d3e4f5a6b';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pact-preview-'));
  worktree = join(root, 'worktree');
  await mkdir(join(worktree, 'design', 'mockups'), { recursive: true });
  await mkdir(join(worktree, '.pact'), { recursive: true });
  await writeFile(join(root, 'secret.txt'), 'secret');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const handler = () => createPreviewHandler((id) => (id === AGENT ? worktree : null));
const get = (path: string, agent = AGENT) =>
  handler()(new Request(`pact-preview://${agent}/${path}`));

describe('pact-preview:', () => {
  it('serves a mockup with PACT’s script and a strict policy', async () => {
    await writeFile(
      join(worktree, 'design/mockups/a.html'),
      '<!doctype html><html><head><title>A</title></head><body><img src="https://x.dev/a.png"></body></html>',
    );
    const response = await get('design/mockups/a.html');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(HTML_CSP);
    expect(HTML_CSP).toContain("default-src 'none'");
    expect(HTML_CSP).not.toMatch(/https?:/);
    const page = await response.text();
    expect(page.indexOf('<script>')).toBeGreaterThan(page.indexOf('<head>'));
    expect(page).toContain("send({ type: 'blocked', url: event.blockedURI })");
    expect(page).toContain('<img src="https://x.dev/a.png">');
  });

  it('adds its script at the start of a page without <head>', async () => {
    await writeFile(join(worktree, 'design/mockups/b.htm'), '<p>b</p>');
    const page = await (await get('design/mockups/b.htm')).text();
    expect(page.startsWith('<script>')).toBe(true);
    expect(page.endsWith('<p>b</p>')).toBe(true);
  });

  it('renders Markdown statically: raw HTML is shown, never run', async () => {
    await writeFile(
      join(worktree, '.pact/recap.md'),
      '# Recap\n\n<script>alert(1)</script>\n\n- **ok**\n',
    );
    const response = await get('.pact/recap.md');
    const csp = response.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[^']+'$/);
    const page = await response.text();
    expect(page).toContain('<h1>Recap</h1>');
    expect(page).toContain('<strong>ok</strong>');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).toContain(`<script nonce="${nonce ?? 'none'}">`);
    expect(page.match(/<script/g)).toHaveLength(1);
  });

  it('serves the mockup’s styles and images as such, the rest as text', async () => {
    await writeFile(join(worktree, 'design/tokens.css'), ':root{}');
    await writeFile(join(worktree, 'notes.txt'), 'notes');
    expect((await get('design/tokens.css')).headers.get('content-type')).toBe(
      'text/css; charset=utf-8',
    );
    const text = await get('notes.txt');
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await text.text()).toBe('notes');
  });

  it('shows a notice instead of a file too big', async () => {
    await writeFile(join(worktree, 'design/mockups/big.html'), 'x'.repeat(MAX_PREVIEW_BYTES + 1));
    const response = await get('design/mockups/big.html');
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('Fichier trop gros pour l’Aperçu (2.0 Mo).');
  });

  it('serves nothing outside the worktree of an open agent', async () => {
    await symlink(join(root, 'secret.txt'), join(worktree, 'link.txt'));
    await writeFile(join(worktree, 'a b.md'), '# espace');
    const refused = [
      get('%2e%2e/secret.txt'),
      get('..%2Fsecret.txt'),
      get('link.txt'),
      get('design'),
      get(''),
      get('%E0%A4%A'),
      get('absent.html'),
      get('a b.md', '00000000-0000-4000-8000-000000000000'),
    ];
    for (const response of await Promise.all(refused)) {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Fichier introuvable.');
    }
    expect((await get('a%20b.md')).status).toBe(200);
  });
});
