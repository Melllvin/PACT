import { useState } from 'react';
import { useDialogKeys } from '../launch/use-dialog-keys';

type Props = {
  /** Why the last attempt was refused. */
  error: string | null;
  onAdd: (name: string, command: string) => void;
  onCancel: () => void;
};

const INPUT =
  'w-full rounded-sm border border-border bg-transparent px-2 py-1 text-sm text-foreground';
const BUTTON = 'cursor-pointer rounded-sm border border-border px-2.5 py-1 text-sm';

/** « Autre CLI — ajouter » (FR-008): a name, and the command PACT runs as is in the worktree. */
export function AddCliDialog({ error, onAdd, onCancel }: Props) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const ready = name.trim() !== '' && command.trim() !== '';
  const add = () => {
    if (ready) onAdd(name.trim(), command.trim());
  };
  useDialogKeys({ onEscape: onCancel, onEnter: add });

  return (
    <div
      role="dialog"
      aria-label="Ajouter un CLI"
      className="fixed top-16 left-1/2 z-10 grid w-[min(420px,calc(100vw-32px))] -translate-x-1/2 gap-3 rounded-md border border-border bg-card p-4 shadow-[0_12px_32px_rgb(0_0_0/45%)]"
    >
      <h2 className="text-lg">Ajouter un CLI</h2>
      <label className="grid gap-1 text-sm text-muted-foreground">
        Nom
        <input
          className={INPUT}
          value={name}
          placeholder="Aider"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      <label className="grid gap-1 text-sm text-muted-foreground">
        Commande
        <input
          className={`${INPUT} font-mono`}
          value={command}
          placeholder="aider --no-git"
          onChange={(event) => {
            setCommand(event.target.value);
          }}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Lancée telle quelle dans le worktree de chaque agent. PACT suit ce CLI par son terminal :
        une question en attente depuis 3 s est signalée.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button className={BUTTON} onClick={onCancel}>
          Annuler
        </button>
        <button
          className={`${BUTTON} border-primary bg-primary text-primary-foreground disabled:opacity-40`}
          disabled={!ready}
          onClick={add}
        >
          Ajouter
        </button>
      </div>
    </div>
  );
}
