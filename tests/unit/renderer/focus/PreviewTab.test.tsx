import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createPreviewApi } from '../../../../src/renderer/focus/preview-api';
import { PreviewTab, type PreviewApi } from '../../../../src/renderer/focus/PreviewTab';
import type { PactApi } from '../../../../src/shared/ipc';
import type { PreviewFile } from '../../../../src/shared/preview';

// 004 T033 — « Aperçu » of the Focus: the files of the worktree in an isolated frame, refreshed at
// the same reading position, blocked resources told, a decision on a mockup (FR-025…FR-028).

const AGENT = '6f1c2a4e-8b3d-4e5f-9a7b-1c2d3e4f5a6b';

const FILES: PreviewFile[] = [
  { path: '.pact/recap.md', kind: 'recap' },
  { path: 'design/mockups/a.html', kind: 'mockup' },
  { path: '.pact/issues/0012.md', kind: 'issue' },
];

const setup = (files: PreviewFile[] = FILES) => {
  let changed: ((event: { agentId: string; path: string }) => void) | undefined;
  const api = {
    list: vi.fn((_agentId: string) => Promise.resolve(files)),
    decide: vi.fn((_input: unknown) => Promise.resolve()),
    onChanged: vi.fn((listener: typeof changed) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    }),
  } satisfies PreviewApi;
  const view = render(<PreviewTab agentId={AGENT} api={api} />);
  return { api, view, change: (path: string, agentId = AGENT) => changed?.({ agentId, path }) };
};

const frame = () => screen.getByTitle<HTMLIFrameElement>(/^Aperçu : /);

/** A message from the page shown, as PACT's script in it sends them. */
const fromPage = (data: unknown, source: Window | null = frame().contentWindow) => {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source }));
  });
};

describe('PreviewTab', () => {
  it('lists the files by kind and shows the first in a sandboxed frame', async () => {
    const { api } = setup();
    const list = await screen.findByRole('list', { name: 'Fichiers de l’Aperçu' });
    expect(list.textContent).toBe(
      'Recap.pact/recap.mdMaquettedesign/mockups/a.htmlIssue.pact/issues/0012.md',
    );
    expect(api.list).toHaveBeenCalledWith(AGENT);
    expect(frame().getAttribute('src')).toBe(`pact-preview://${AGENT}/.pact/recap.md`);
    expect(frame().getAttribute('sandbox')).toBe('allow-scripts');
    // No decision on a recap.
    expect(screen.queryByRole('button', { name: '✓ Valider' })).toBeNull();
  });

  it('says when the worktree has nothing to show, or why it cannot list', async () => {
    setup([]);
    expect(
      await screen.findByText('Aucune maquette, recap ni issue dans ce worktree.'),
    ).toBeTruthy();
    const api: PreviewApi = {
      list: () => Promise.reject(new Error('Cet agent n’est plus ouvert.')),
      decide: () => Promise.resolve(),
      onChanged: () => () => undefined,
    };
    render(<PreviewTab agentId={AGENT} api={api} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Cet agent n’est plus ouvert.');
  });

  it('reloads the file shown when it changes, back at the same reading position', async () => {
    const { api, change } = setup();
    await screen.findByTitle('Aperçu : .pact/recap.md');
    const before = frame();
    fromPage({ pactPreview: true, type: 'scroll', y: 420 });
    act(() => {
      change('.pact/recap.md');
    });
    await waitFor(() => {
      expect(frame()).not.toBe(before);
    });
    const page = frame().contentWindow;
    const post = vi.spyOn(page as Window, 'postMessage');
    fromPage({ pactPreview: true, type: 'ready' });
    expect(post).toHaveBeenCalledWith({ pactScrollTo: 420 }, '*');
    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(2);
    });

    // Another file, or another agent: the frame stays.
    const shown = frame();
    act(() => {
      change('.pact/issues/0012.md');
      change('.pact/recap.md', 'other');
    });
    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(3);
    });
    expect(frame()).toBe(shown);
  });

  it('tells which external resources the page tried to load, once each', async () => {
    setup();
    await screen.findByTitle('Aperçu : .pact/recap.md');
    fromPage({ pactPreview: true, type: 'blocked', url: 'https://x.dev/a.png' });
    fromPage({ pactPreview: true, type: 'blocked', url: 'https://x.dev/a.png' });
    fromPage({ pactPreview: true, type: 'blocked', url: 'https://y.dev/b.js' });
    // Not from the page shown, or not PACT's: ignored.
    fromPage({ pactPreview: true, type: 'blocked', url: 'https://z.dev' }, window);
    fromPage({ type: 'blocked', url: 'https://z.dev' });
    fromPage(undefined);
    expect(screen.getByRole('status').textContent).toBe(
      'Ressource externe bloquée : https://x.dev/a.png, https://y.dev/b.js',
    );
  });

  it('takes the decision on a mockup, with its comment, to the orchestrator', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await user.click(await screen.findByRole('button', { name: /design\/mockups\/a\.html/ }));
    expect(frame().getAttribute('src')).toBe(`pact-preview://${AGENT}/design/mockups/a.html`);
    await user.type(screen.getByLabelText('Commentaire sur la maquette'), '  Plus de marge ');
    await user.click(screen.getByRole('button', { name: '✓ Valider' }));
    expect(api.decide).toHaveBeenCalledWith({
      agentId: AGENT,
      path: 'design/mockups/a.html',
      decision: 'validated',
      comment: 'Plus de marge',
    });
    expect((await screen.findByRole('status')).textContent).toBe(
      '✓ Maquette validée — transmis à l’orchestrateur.',
    );

    // Choosing the same file keeps the decision; another one starts afresh.
    await user.click(screen.getByRole('button', { name: /design\/mockups\/a\.html/ }));
    expect(screen.getByRole('status')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /0012\.md/ }));
    await user.click(screen.getByRole('button', { name: /design\/mockups\/a\.html/ }));
    api.decide.mockRejectedValueOnce(new Error('Refusé'));
    await user.click(screen.getByRole('button', { name: '✕ Refuser' }));
    expect(api.decide).toHaveBeenLastCalledWith({
      agentId: AGENT,
      path: 'design/mockups/a.html',
      decision: 'refused',
    });
    expect((await screen.findByRole('alert')).textContent).toBe('Refusé');
    await user.click(screen.getByRole('button', { name: '✕ Refuser' }));
    expect((await screen.findByRole('status')).textContent).toBe(
      '✕ Maquette refusée — transmis à l’orchestrateur.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stops listening once closed', async () => {
    const { view, api } = setup();
    await screen.findByTitle('Aperçu : .pact/recap.md');
    view.unmount();
    expect(api.onChanged).toHaveBeenCalledTimes(1);
  });
});

describe('createPreviewApi', () => {
  it('goes through the preview channels', async () => {
    const off = () => undefined;
    const invoke = vi.fn((channel: string) =>
      Promise.resolve(channel === 'preview:list' ? { files: FILES } : undefined),
    );
    const on = vi.fn(() => off);
    const api = createPreviewApi({ invoke, on } as unknown as PactApi);
    expect(await api.list(AGENT)).toEqual(FILES);
    expect(invoke).toHaveBeenCalledWith('preview:list', { agentId: AGENT });
    const input = { agentId: AGENT, path: 'design/mockups/a.html', decision: 'refused' as const };
    await api.decide(input);
    expect(invoke).toHaveBeenCalledWith('preview:decide', input);
    const listener = vi.fn();
    expect(api.onChanged(listener)).toBe(off);
    expect(on).toHaveBeenCalledWith('preview:changed', listener);
  });
});
