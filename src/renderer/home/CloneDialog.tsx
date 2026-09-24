import { useState } from 'react';
import styles from './home.module.css';

type Props = {
  onPickDestination: () => Promise<string | null>;
  onClone: (url: string, destination: string) => void;
  onCancel: () => void;
};

/** « Cloner depuis une URL… »: URL and destination folder, then the clone runs in the main process. */
export function CloneDialog({ onPickDestination, onClone, onCancel }: Props) {
  const [url, setUrl] = useState('');
  const [destination, setDestination] = useState('');
  const ready = url.trim() !== '' && destination !== '';

  return (
    <div role="dialog" aria-label="Cloner un dépôt" className={styles.dialog}>
      <label>
        URL du dépôt
        <input
          value={url}
          placeholder="git@github.com:equipe/depot.git"
          onChange={(event) => {
            setUrl(event.target.value);
          }}
        />
      </label>
      <label>
        Destination
        <input value={destination} readOnly />
      </label>
      <div className={styles.actions}>
        <button
          onClick={() => {
            void onPickDestination().then((picked) => {
              if (picked) setDestination(picked);
            });
          }}
        >
          Choisir…
        </button>
        <span className={styles.spacer} />
        <button onClick={onCancel}>Annuler</button>
        <button
          className={styles.primary}
          disabled={!ready}
          onClick={() => {
            onClone(url.trim(), destination);
          }}
        >
          Cloner
        </button>
      </div>
    </div>
  );
}
