import { useState } from 'react';
import type { CliDefinition, PermissionLevel, PermissionPreference } from '../../shared/model';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

type LaunchedCli = Pick<CliDefinition, 'id' | 'name' | 'adapter'>;

type Props = {
  agentCount: number;
  /** The CLIs about to be launched: each level is described for each of them. */
  clis: LaunchedCli[];
  onConfirm: (choice: PermissionPreference) => void;
  onCancel: () => void;
};

const LEVELS: { level: PermissionLevel; name: string }[] = [
  { level: 'always-allow', name: 'Toujours autoriser' },
  { level: 'ask-sensitive', name: 'Demander pour les actions sensibles' },
  { level: 'always-ask', name: 'Toujours demander' },
];

const SCOPES: [PermissionPreference['scope'], string][] = [
  ['project', 'Ce projet'],
  ['global', 'Tous les projets'],
];

/**
 * What each level really lets a CLI do (research.md R5). Claude Code enforces PACT's `ask`
 * rules; Codex only has its sandbox and asks when the model judges it needed. Other CLIs keep
 * their own settings, so PACT promises nothing for them.
 */
const describe = (cli: LaunchedCli, level: PermissionLevel): string => {
  if (cli.adapter === 'claude-code') {
    return {
      'always-allow':
        'modifie les fichiers et lance des commandes sans vous demander, y compris hors de son worktree.',
      'ask-sensitive':
        'suppressions (rm), accès réseau (curl, wget, pages web) et git push attendent votre accord ; le reste passe sans demander.',
      'always-ask': 'chaque modification de fichier ou commande attend votre accord.',
    }[level];
  }
  if (cli.adapter === 'codex') {
    return {
      'always-allow':
        'ne demande jamais ; son sandbox limite les écritures au worktree et coupe le réseau.',
      'ask-sensitive':
        'écrit dans le worktree, réseau coupé par le sandbox ; demande votre accord quand il juge une action risquée ou bloquée.',
      'always-ask': 'sandbox en lecture seule ; demande votre accord avant toute écriture.',
    }[level];
  }
  return 'applique ses propres réglages d’autorisation ; PACT ne peut rien garantir.';
};

/** Screen 1m — asked once, on the first launch (FR-012, FR-035). */
export function PermissionsDialog({ agentCount, clis, onConfirm, onCancel }: Props) {
  const [level, setLevel] = useState<PermissionLevel>('always-allow');
  const [scope, setScope] = useState<PermissionPreference['scope']>('global');
  const [autoResume, setAutoResume] = useState(true);

  const confirm = () => {
    onConfirm({ level, autoResume, scope });
  };

  return (
    <Dialog open onOpenChange={onCancel}>
      <DialogContent className="w-[min(480px,calc(100vw-32px))]" onEnter={confirm}>
        <DialogBody className="gap-2.5 px-[18px] py-4">
          <DialogTitle className="font-sans text-[16px] font-semibold tracking-normal text-foreground normal-case">
            Autorisations des agents
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px]">
            Demandé une seule fois, au premier lancement
          </DialogDescription>
          <div role="radiogroup" aria-label="Que peuvent faire les agents ?" className="contents">
            {LEVELS.map((option) => (
              <label
                key={option.level}
                className="flex cursor-pointer gap-2.5 rounded-[7px] border border-white/8 px-3 py-2.5 has-checked:border-primary has-checked:bg-primary/8 has-focus-visible:ring-2 has-focus-visible:ring-ring/60"
              >
                <input
                  type="radio"
                  name="level"
                  className="peer sr-only"
                  checked={level === option.level}
                  onChange={() => {
                    setLevel(option.level);
                  }}
                />
                <span
                  aria-hidden
                  className="text-[14px] text-muted-foreground peer-checked:text-primary"
                >
                  {level === option.level ? '◉' : '○'}
                </span>
                <span className="flex flex-col gap-[3px]">
                  <span className="flex items-center gap-2 text-[13.5px] font-semibold">
                    {option.name}
                    {option.level === 'always-allow' && (
                      <span className="rounded-[3px] bg-primary px-1.5 py-px font-mono text-[10px] font-normal text-primary-foreground">
                        défaut
                      </span>
                    )}
                  </span>
                  {clis.map((cli) => (
                    <span key={cli.id} className="text-[12px] leading-[1.4] text-muted-foreground">
                      {cli.name} : {describe(cli, option.level)}
                    </span>
                  ))}
                </span>
              </label>
            ))}
          </div>
          <div className="mt-1 flex items-center gap-2.5">
            <span id="permission-scope" className="flex-1 text-[12.5px] text-muted-foreground">
              S’applique à
            </span>
            <div
              role="radiogroup"
              aria-labelledby="permission-scope"
              className="flex overflow-hidden rounded-lg border border-white/8 text-[11.5px] font-medium"
            >
              {SCOPES.map(([value, name]) => (
                <label
                  key={value}
                  className="cursor-pointer px-[9px] py-[3px] not-first:border-l not-first:border-white/8 has-checked:bg-white/8 has-checked:text-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring/60 has-focus-visible:ring-inset"
                >
                  <input
                    type="radio"
                    name="scope"
                    className="sr-only"
                    checked={scope === value}
                    onChange={() => {
                      setScope(value);
                    }}
                  />
                  {name}
                </label>
              ))}
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
            <input
              type="checkbox"
              className="size-3.5 accent-(--action)"
              checked={autoResume}
              onChange={(event) => {
                setAutoResume(event.target.checked);
              }}
            />
            Reprendre automatiquement après une limite de débit
          </label>
        </DialogBody>
        <DialogFooter className="px-[18px]">
          <span className="font-mono text-[10.5px] text-dim">Entrée = choix par défaut</span>
          <span className="flex-1" />
          <Button variant="ghost" size="md" onClick={onCancel}>
            Annuler
          </Button>
          <Button variant="primary" size="md" onClick={confirm}>
            Lancer {agentCount} agent{agentCount > 1 ? 's' : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
