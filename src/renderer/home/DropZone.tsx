import { useState } from 'react';
import styles from './home.module.css';

type Props = {
  /** The sandboxed renderer cannot read file paths: the preload resolves them (webUtils). */
  getPathForFile: (file: File) => string;
  onDropPath: (path: string) => void;
  onPick: () => void;
  onClone: () => void;
};

export function DropZone({ getPathForFile, onDropPath, onPick, onClone }: Props) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={[styles.drop, over && styles.dropOver].filter(Boolean).join(' ')}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files[0];
        if (file) onDropPath(getPathForFile(file));
      }}
    >
      <p className={styles.dropTitle}>Déposez un dossier Git ici</p>
      <p className={styles.meta}>ou</p>
      <button className={styles.primary} onClick={onPick}>
        Choisir un dépôt Git…
      </button>
      <button onClick={onClone}>Cloner depuis une URL…</button>
    </div>
  );
}
