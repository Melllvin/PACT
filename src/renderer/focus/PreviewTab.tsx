import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { IpcInput } from '../../shared/ipc';
import { previewUrl, type PreviewFile, type PreviewMessage } from '../../shared/preview';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** What the Aperçu needs from the main process (`preview:*`). */
export type PreviewApi = {
  list: (agentId: string) => Promise<PreviewFile[]>;
  decide: (input: IpcInput<'preview:decide'>) => Promise<void>;
  onChanged: (listener: (event: { agentId: string; path: string }) => void) => () => void;
};

type Props = { agentId: string; api: PreviewApi };

const KIND_LABELS: Record<PreviewFile['kind'], string> = {
  recap: 'Recap',
  mockup: 'Maquette',
  issue: 'Issue',
  other: 'Fichier',
};

const reason = (error: unknown) =>
  (error as { message?: string } | null)?.message ?? 'Erreur inattendue.';

/**
 * « Aperçu » of the Focus (004 FR-025…FR-028): the mockups, recap and issues of the agent's
 * worktree, rendered in a frame with no network nor access to PACT, refreshed as they change at
 * the same reading position; a mockup takes the user's decision to the orchestrator.
 */
export function PreviewTab({ agentId, api }: Props) {
  const [files, setFiles] = useState<PreviewFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState<'validated' | 'refused' | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const scroll = useRef(0);

  const shown = files?.find((f) => f.path === chosen) ?? files?.[0] ?? null;
  const shownPath = useRef<string | null>(null);
  useLayoutEffect(() => {
    shownPath.current = shown?.path ?? null;
  });

  const load = useCallback(
    () =>
      api.list(agentId).then(setFiles, (e: unknown) => {
        setError(reason(e));
      }),
    [api, agentId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  // FR-027: the file shown is reloaded; a file added or removed changes the list.
  useEffect(
    () =>
      api.onChanged(({ agentId: id, path }) => {
        if (id !== agentId) return;
        if (path === shownPath.current) setVersion((v) => v + 1);
        void load();
      }),
    [api, agentId, load],
  );

  // What PACT's script in the page tells: the reading position, what was blocked (FR-026).
  useEffect(() => {
    const onMessage = (event: MessageEvent<PreviewMessage | undefined>) => {
      const page = frame.current?.contentWindow;
      if (!page || event.source !== page || event.data?.pactPreview !== true) return;
      const message = event.data;
      if (message.type === 'scroll') scroll.current = message.y;
      else if (message.type === 'blocked') {
        const { url } = message;
        setBlocked((list) => (list.includes(url) ? list : [...list, url]));
      } else page.postMessage({ pactScrollTo: scroll.current }, '*');
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, []);

  const choose = (path: string) => {
    if (path === shown?.path) return;
    scroll.current = 0;
    setChosen(path);
    setBlocked([]);
    setComment('');
    setSent(null);
  };

  const decide = (path: string, decision: 'validated' | 'refused') => {
    const said = comment.trim();
    api.decide({ agentId, path, decision, ...(said ? { comment: said } : {}) }).then(
      () => {
        setSent(decision);
        setError(null);
      },
      (e: unknown) => {
        setError(reason(e));
      },
    );
  };

  if (files !== null && files.length === 0) {
    return (
      <p className="m-0 flex-1 px-4 py-3 text-[12.5px] text-dim">
        Aucune maquette, recap ni issue dans ce worktree.
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-1">
      <ul
        aria-label="Fichiers de l’Aperçu"
        className="m-0 w-56 flex-none list-none overflow-auto border-r border-white/6 p-2"
      >
        {(files ?? []).map((file) => (
          <li key={file.path}>
            <button
              aria-current={file.path === shown?.path}
              onClick={() => {
                choose(file.path);
              }}
              className={cn(
                'flex w-full cursor-pointer flex-col items-start rounded-lg px-2.5 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-white/4',
                file.path === shown?.path && 'bg-white/6 text-foreground',
              )}
            >
              <span className="text-[10.5px] tracking-wide text-dim uppercase">
                {KIND_LABELS[file.kind]}
              </span>
              <span className="w-full truncate font-mono">{file.path}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex min-w-0 flex-1 flex-col">
        {error && (
          <p role="alert" className="m-0 px-4 py-2 text-[12px] text-destructive">
            {error}
          </p>
        )}
        {blocked.length > 0 && (
          <p
            role="status"
            className="m-0 border-b border-white/6 px-4 py-2 text-[12px] text-waiting"
          >
            Ressource externe bloquée : {blocked.join(', ')}
          </p>
        )}
        {shown && (
          <iframe
            key={`${shown.path}:${String(version)}`}
            ref={frame}
            title={`Aperçu : ${shown.path}`}
            src={previewUrl(agentId, shown.path)}
            // Scripts of the page only, in an opaque origin: no access to PACT (FR-026).
            sandbox="allow-scripts"
            className="min-h-0 w-full flex-1 border-0 bg-white"
          />
        )}
        {shown?.kind === 'mockup' && (
          <div className="flex flex-none flex-col gap-2 border-t border-white/6 p-3">
            {sent ? (
              <p role="status" className="m-0 text-[12.5px] text-foreground">
                {sent === 'validated' ? '✓ Maquette validée' : '✕ Maquette refusée'} — transmis à
                l’orchestrateur.
              </p>
            ) : (
              <>
                <textarea
                  aria-label="Commentaire sur la maquette"
                  rows={2}
                  value={comment}
                  placeholder="Commentaire (facultatif)"
                  onChange={(event) => {
                    setComment(event.target.value);
                  }}
                  className="resize-none rounded-[10px] border border-white/8 bg-white/2 px-2.5 py-2 text-[12px] text-foreground outline-none focus-visible:border-primary/50"
                />
                <div className="flex gap-1.5">
                  <Button
                    variant="accept"
                    onClick={() => {
                      decide(shown.path, 'validated');
                    }}
                  >
                    ✓ Valider
                  </Button>
                  <Button
                    onClick={() => {
                      decide(shown.path, 'refused');
                    }}
                  >
                    ✕ Refuser
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
