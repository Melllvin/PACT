/** Screen 1b: empty on purpose, one action that opens the same launcher as « + Agents ». */
export function EmptyWorkspace({ onAddAgents }: { onAddAgents?: (() => void) | undefined }) {
  return (
    <button
      className="group flex min-h-0 w-full flex-1 cursor-pointer flex-col items-center justify-center gap-[22px] text-[15px] font-medium text-foreground disabled:cursor-default"
      onClick={onAddAgents}
      disabled={!onAddAgents}
    >
      <span
        aria-hidden
        data-orb-anchor
        className="flex size-28 animate-enter items-center justify-center rounded-3xl border border-dashed border-white/16 text-[34px] font-extralight text-[#a1a1aa] transition-[border-color,color,transform,background-color] duration-300 ease-out-soft group-enabled:group-hover:scale-[1.04] group-enabled:group-hover:border-white/35 group-enabled:group-hover:bg-white/2 group-enabled:group-hover:text-white motion-reduce:animate-none motion-reduce:transition-none"
      >
        +
      </span>
      <span className="animate-enter [--enter-index:1] motion-reduce:animate-none">
        Ajouter des agents
      </span>
    </button>
  );
}
