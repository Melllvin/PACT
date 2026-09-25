import { useState } from 'react';
import type { CliDefinition, PermissionLevel, PermissionPreference } from '../../shared/model';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

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
          <RadioGroup
            aria-label="Que peuvent faire les agents ?"
            value={level}
            onValueChange={(value) => {
              const chosen = LEVELS.find((option) => option.level === value);
              if (chosen) setLevel(chosen.level);
            }}
          >
            {LEVELS.map((option) => (
              <label
                key={option.level}
                className="flex cursor-pointer gap-2.5 rounded-xl border border-white/8 px-3 py-2.5 transition-[background-color,border-color] duration-200 has-data-[state=checked]:border-primary/60 has-data-[state=checked]:bg-primary/6"
              >
                <RadioGroupItem value={option.level} />
                <span className="flex flex-col gap-[3px]">
                  <span className="flex items-center gap-2 text-[13.5px] font-medium">
                    {option.name}
                    {option.level === 'always-allow' && <Badge variant="primary">défaut</Badge>}
                  </span>
                  {clis.map((cli) => (
                    <span key={cli.id} className="text-[12px] leading-[1.4] text-muted-foreground">
                      {cli.name} : {describe(cli, option.level)}
                    </span>
                  ))}
                </span>
              </label>
            ))}
          </RadioGroup>
          <div className="mt-1 flex items-center gap-2.5">
            <span id="permission-scope" className="flex-1 text-[12.5px] text-muted-foreground">
              S’applique à
            </span>
            <ToggleGroup
              type="single"
              variant="strip"
              aria-labelledby="permission-scope"
              value={scope}
              onValueChange={(value) => {
                const chosen = SCOPES.find(([scopeValue]) => scopeValue === value);
                if (chosen) setScope(chosen[0]);
              }}
              className="overflow-hidden rounded-lg border border-white/8"
            >
              {SCOPES.map(([value, name]) => (
                <ToggleGroupItem key={value} value={value}>
                  {name}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
            <Checkbox
              checked={autoResume}
              onCheckedChange={(value) => {
                setAutoResume(value === true);
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
