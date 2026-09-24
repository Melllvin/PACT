import styles from './shell.module.css';

/** Statuses are icons (FR-041); this legend explains each of them. */
export function Legend() {
  return (
    <p role="note" aria-label="Légende" className={styles.legend}>
      <span className={styles.waiting}>◆ attend</span> · <span>✓ prêt</span> ·{' '}
      <span className={styles.danger}>✕ erreur</span> · <span>⎇ branche</span>
    </p>
  );
}
