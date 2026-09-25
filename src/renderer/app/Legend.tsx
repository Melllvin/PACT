/** Statuses are icons (FR-041); this legend explains each of them. */
export function Legend() {
  return (
    <p
      role="note"
      aria-label="Légende"
      className="m-0 flex flex-wrap gap-3.5 px-1 font-mono text-[11px] text-dim"
    >
      <span>
        <span className="text-waiting">◆</span> attend
      </span>
      <span className="sr-only"> · </span>
      <span>
        <span className="text-accept">✓</span> prêt
      </span>
      <span className="sr-only"> · </span>
      <span>
        <span className="text-destructive">✕</span> erreur
      </span>
      <span className="sr-only"> · </span>
      <span>
        <span className="text-[#a1a1aa]">⎇</span> branche
      </span>
    </p>
  );
}
