import { useState } from 'react';
import type { CliDefinition } from '../../shared/model';
import { cn } from '@/lib/utils';
import { AddCliDialog } from './AddCliDialog';
import { LABEL } from './styles';

type Props = {
  clis: CliDefinition[];
  onRedetect: () => void;
  /** Resolves with why the CLI was refused, or null once it is added. */
  onAdd: (name: string, command: string) => Promise<string | null>;
};

const ICONS = { installed: '✓', 'unsupported-version': '!', missing: '○' } as const;
const ICON_COLORS = {
  installed: 'text-accept',
  'unsupported-version': 'text-waiting',
  missing: 'text-dim',
} as const;

function describe(cli: CliDefinition) {
  switch (cli.status) {
    case 'installed':
      return cli.version ?? '';
    case 'unsupported-version':
      return `${cli.version ?? ''} : trop ancien pour PACT, mettez-le à jour`;
    case 'missing':
      return cli.origin === 'custom'
        ? `commande « ${cli.command} » introuvable, vérifiez-la ou installez-la`
        : 'absent';
  }
}

const LINK =
  'cursor-pointer text-[12.5px] text-primary underline underline-offset-3 hover:text-primary/80';

/** « Agents détectés » on the home tab (FR-007). */
export function DetectedClis({ clis, onRedetect, onAdd }: Props) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section
      aria-label="Agents détectés"
      className="flex flex-col gap-2.5 rounded-[14px] border border-white/6 bg-surface px-4 py-3.5 animate-enter motion-reduce:animate-none"
    >
      <h3 className={LABEL}>Agents détectés</h3>
      {clis.length === 0 && (
        <p className="m-0 text-[12px] text-muted-foreground">
          Aucun CLI d’agent détecté. Installez Claude Code ou Codex, puis détectez à nouveau.
        </p>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {clis.map((cli) => (
          <li key={cli.id} aria-label={cli.name} className="flex flex-col gap-0.5">
            <span className="flex items-baseline gap-1.5">
              <span className={ICON_COLORS[cli.status]}>{ICONS[cli.status]}</span>{' '}
              <span
                className={cn('text-[12.5px]', cli.status === 'missing' && 'text-muted-foreground')}
              >
                {cli.name}
              </span>{' '}
              <span className="font-mono text-[11px] text-muted-foreground">{describe(cli)}</span>
            </span>
            {cli.adapter === 'codex' && cli.status === 'installed' && (
              <span className="pl-4 text-[11.5px] text-muted-foreground">
                Au premier lancement, approuvez les hooks de PACT dans Codex avec « Trust all ».
              </span>
            )}
          </li>
        ))}
      </ul>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="text-dim">
          ○
        </span>
        <button
          className={LINK}
          onClick={() => {
            setError(null);
            setAdding(true);
          }}
        >
          Autre CLI — ajouter
        </button>
      </span>
      <button className={cn(LINK, 'self-start text-muted-foreground')} onClick={onRedetect}>
        Détecter à nouveau
      </button>
      {adding && (
        <AddCliDialog
          error={error}
          onAdd={(name, command) => {
            void onAdd(name, command).then((refused) => {
              setError(refused);
              if (!refused) setAdding(false);
            });
          }}
          onCancel={() => {
            setAdding(false);
          }}
        />
      )}
    </section>
  );
}
