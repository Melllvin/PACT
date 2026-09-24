import { useState } from 'react';
import type { CliDefinition, PermissionLevel, PermissionPreference } from '../../shared/model';
import styles from './launch.module.css';
import { useDialogKeys } from './use-dialog-keys';

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
              {clis.map((cli) => (
                <span key={cli.id} className={styles.detail}>
                  {cli.name} : {describe(cli, option.level)}
                </span>
              ))}
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
