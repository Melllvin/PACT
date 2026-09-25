import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
      className={cn(
        'flex flex-col items-center gap-2.5 rounded-[14px] border border-dashed border-white/12 bg-white/2 px-5 py-6 text-center transition-[border-color,background-color] duration-300 animate-enter motion-reduce:animate-none',
        over && 'border-primary/60 bg-primary/6',
      )}
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
      <h3 className="m-0 text-[14px] font-medium">Autre dépôt</h3>
      <p className="m-0 text-[13px] text-muted-foreground">Déposez un dossier Git ici</p>
      <p className="m-0 font-mono text-[11px] text-dim">ou</p>
      <Button variant="contrast" size="md" className="w-full" onClick={onPick}>
        Choisir un dépôt Git…
      </Button>
      <Button size="md" className="w-full" onClick={onClone}>
        Cloner depuis une URL…
      </Button>
    </div>
  );
}
