/** Screen 1b: empty on purpose, one action that opens the same launcher as « + Agents ». */
export function EmptyWorkspace({ onAddAgents }: { onAddAgents?: (() => void) | undefined }) {
  return (
    <button
      className="group flex min-h-0 w-full flex-1 cursor-pointer flex-col items-center justify-center gap-2.5 rounded-md border-[1.5px] border-dashed border-border bg-[rgb(13_17_23/60%)] text-[12.5px] text-muted-foreground transition-colors enabled:hover:border-primary/60 enabled:hover:text-foreground disabled:cursor-default"
      onClick={onAddAgents}
      disabled={!onAddAgents}
    >
      <span
        aria-hidden
        className="flex size-14 items-center justify-center rounded-full border-[1.5px] border-primary text-[28px] text-primary"
      >
        +
      </span>
      Ajouter des agents
    </button>
  );
}
