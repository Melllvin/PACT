/** Statuses are icons (FR-041); this legend explains each of them. */
export function Legend() {
  return (
    <p
      role="note"
      aria-label="Légende"
      className="m-0 px-1 font-mono text-[10.5px] text-muted-foreground"
    >
      <span className="text-waiting">◆ attend</span> · <span>✓ prêt</span> ·{' '}
      <span className="text-destructive">✕ erreur</span> · <span>⎇ branche</span>
    </p>
  );
}
