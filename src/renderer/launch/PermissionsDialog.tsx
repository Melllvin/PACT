import { useState } from 'react';
import type { PermissionLevel, PermissionPreference } from '../../shared/model';
import styles from './launch.module.css';
import { useDialogKeys } from './use-dialog-keys';

type Props = {
  agentCount: number;
  onConfirm: (choice: PermissionPreference) => void;
  onCancel: () => void;
};

/** What each level really lets the CLI do: the worktree is no sandbox (research.md). */
const LEVELS: { level: PermissionLevel; name: string; detail: string }[] = [
  {
    level: 'always-allow',
    name: 'Toujours autoriser',
    detail:
      'Les agents modifient les fichiers et lancent des commandes sans vous demander, y compris hors de leur worktree.',
  },
  {
    level: 'ask-sensitive',
    name: 'Demander pour les actions sensibles',
    detail:
      'Suppressions (rm), accès réseau (curl, wget, pages web) et git push attendent votre accord ; le reste passe sans demander.',
  },
  {
    level: 'always-ask',
    name: 'Toujours demander',
    detail: 'Chaque modification de fichier ou commande attend votre accord.',
  },
];

/** Screen 1m — asked once, on the first launch (FR-012, FR-035). */
export function PermissionsDialog({ agentCount, onConfirm, onCancel }: Props) {
  const [level, setLevel] = useState<PermissionLevel>('always-allow');
  const [scope, setScope] = useState<PermissionPreference['scope']>('global');
  const [autoResume, setAutoResume] = useState(true);

  const confirm = () => {
    onConfirm({ level, autoResume, scope });
  };
  useDialogKeys({ onEscape: onCancel, onEnter: confirm });

  return (
    <div role="dialog" aria-label="Autorisations des agents" className={styles.dialog}>
      <h2>Autorisations des agents</h2>
      <fieldset className={styles.choices}>
        <legend>Que peuvent faire les agents ?</legend>
        {LEVELS.map((option) => (
          <label key={option.level} className={styles.choice}>
            <input
              type="radio"
              name="level"
              checked={level === option.level}
              onChange={() => {
                setLevel(option.level);
              }}
            />
            <span>
              <strong>{option.name}</strong>
              <span className={styles.detail}>{option.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className={styles.choices}>
        <legend>Pour</legend>
        <label className={styles.inline}>
          <input
            type="radio"
            name="scope"
            checked={scope === 'global'}
            onChange={() => {
              setScope('global');
            }}
          />
          Tous les projets
        </label>
        <label className={styles.inline}>
          <input
            type="radio"
            name="scope"
            checked={scope === 'project'}
            onChange={() => {
              setScope('project');
            }}
          />
          Ce projet
        </label>
      </fieldset>
      <label className={styles.inline}>
        <input
          type="checkbox"
          checked={autoResume}
          onChange={(event) => {
            setAutoResume(event.target.checked);
          }}
        />
        Reprendre automatiquement après une limite de débit
      </label>
      <div className={styles.actions}>
        <span className={styles.spacer} />
        <button onClick={onCancel}>Annuler</button>
        <button className={styles.primary} onClick={confirm}>
          Lancer {agentCount} agent{agentCount > 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
}
