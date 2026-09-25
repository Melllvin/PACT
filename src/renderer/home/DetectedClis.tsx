import { useState } from 'react';
import type { CliDefinition } from '../../shared/model';
import { AddCliDialog } from './AddCliDialog';
import styles from './home.module.css';

type Props = {
  clis: CliDefinition[];
  onRedetect: () => void;
  /** Resolves with why the CLI was refused, or null once it is added. */
  onAdd: (name: string, command: string) => Promise<string | null>;
};

function describe(cli: CliDefinition) {
  switch (cli.status) {
    case 'installed':
      return `✓ ${cli.name} ${cli.version ?? ''}`;
    case 'unsupported-version':
      return `! ${cli.name} ${cli.version ?? ''} : trop ancien pour PACT, mettez-le à jour`;
    case 'missing':
      return cli.origin === 'custom'
        ? `! ${cli.name} : commande « ${cli.command} » introuvable, vérifiez-la ou installez-la`
        : `○ ${cli.name} absent`;
  }
}

/** « Agents détectés » on the home tab (FR-007). */
export function DetectedClis({ clis, onRedetect, onAdd }: Props) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-label="Agents détectés" className={styles.section}>
      <h3>Agents détectés</h3>
      {clis.length === 0 && (
        <p className={styles.meta}>
          Aucun CLI d’agent détecté. Installez Claude Code ou Codex, puis détectez à nouveau.
        </p>
      )}
      <ul>
        {clis.map((cli) => (
          <li key={cli.id} aria-label={cli.name} className={styles.meta}>
            {describe(cli)}
            {cli.adapter === 'codex' && cli.status === 'installed' && (
              <span>
                {' '}
                — au premier lancement, approuvez les hooks de PACT dans Codex avec « Trust all ».
              </span>
            )}
          </li>
        ))}
      </ul>
      <button onClick={onRedetect}>Détecter à nouveau</button>{' '}
      <button
        onClick={() => {
          setError(null);
          setAdding(true);
        }}
      >
        Autre CLI — ajouter
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
