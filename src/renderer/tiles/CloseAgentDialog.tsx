import { useState } from 'react';
import dialogs from '../launch/launch.module.css';
import { useDialogKeys } from '../launch/use-dialog-keys';

type Props = {
  name: string;
  branch: string;
  onConfirm: (removeWorktree: boolean) => void;
  onCancel: () => void;
};

/** FR-037: closing an agent asks whether its worktree and branch stay. Keeping is the default. */
export function CloseAgentDialog({ name, branch, onConfirm, onCancel }: Props) {
  const [remove, setRemove] = useState(false);
  const confirm = () => {
    onConfirm(remove);
  };
  useDialogKeys({ onEscape: onCancel, onEnter: confirm });

  return (
    <div role="dialog" aria-label={`Fermer ${name}`} className={dialogs.dialog}>
      <h2>Fermer {name}</h2>
      <fieldset className={dialogs.choices}>
        <legend>Son worktree et sa branche</legend>
        <label className={dialogs.choice}>
          <input
            type="radio"
            name="worktree"
            checked={!remove}
            onChange={() => {
              setRemove(false);
            }}
          />
          <span>
            <strong>Conserver</strong>
            <span className={dialogs.detail}>Le travail reste disponible dans le dépôt.</span>
          </span>
        </label>
        <label className={dialogs.choice}>
          <input
            type="radio"
            name="worktree"
            checked={remove}
            onChange={() => {
              setRemove(true);
            }}
          />
          <span>
            <strong>Supprimer</strong>
            <span className={dialogs.detail}>
              Le worktree et la branche {branch} sont effacés, modifications non commitées
              comprises.
            </span>
          </span>
        </label>
      </fieldset>
      <div className={dialogs.actions}>
        <span className={dialogs.spacer} />
        <button onClick={onCancel}>Annuler</button>
        <button className={dialogs.primary} onClick={confirm}>
          Fermer l’agent
        </button>
      </div>
    </div>
  );
}
