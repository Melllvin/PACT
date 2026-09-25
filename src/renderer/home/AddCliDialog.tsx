import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type Props = {
  /** Why the last attempt was refused. */
  error: string | null;
  onAdd: (name: string, command: string) => void;
  onCancel: () => void;
};

const FIELD = 'flex flex-col gap-1 text-[12px] text-muted-foreground';

/** « Autre CLI — ajouter » (FR-008): a name, and the command PACT runs as is in the worktree. */
export function AddCliDialog({ error, onAdd, onCancel }: Props) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const ready = name.trim() !== '' && command.trim() !== '';

  return (
    <Dialog open onOpenChange={onCancel}>
      <DialogContent className="w-[min(420px,calc(100vw-32px))]">
        {/* Enter in a field adds the CLI, as the « Ajouter » button does. */}
        <form
          className="contents"
          onSubmit={(event) => {
            // Never sent while a field is empty: « Ajouter », the form's default button, is disabled.
            event.preventDefault();
            onAdd(name.trim(), command.trim());
          }}
        >
          <DialogBody>
            <DialogTitle>Ajouter un CLI</DialogTitle>
            <label className={FIELD}>
              Nom
              <Input
                value={name}
                placeholder="Aider"
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </label>
            <label className={FIELD}>
              Commande
              <Input
                className="font-mono"
                value={command}
                placeholder="aider --no-git"
                onChange={(event) => {
                  setCommand(event.target.value);
                }}
              />
            </label>
            <DialogDescription className="text-[12px]">
              Lancée telle quelle dans le worktree de chaque agent. PACT suit ce CLI par son
              terminal : une question en attente depuis 3 s est signalée.
            </DialogDescription>
            {error && (
              <p role="alert" className="m-0 text-[12.5px] text-destructive">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter className="justify-end">
            <Button variant="ghost" size="md" onClick={onCancel}>
              Annuler
            </Button>
            <Button type="submit" variant="primary" size="md" disabled={!ready}>
              Ajouter
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
