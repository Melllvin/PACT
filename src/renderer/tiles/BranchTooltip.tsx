import { useId, useState } from 'react';
import styles from './tiles.module.css';

type Props = { branch: string; port: number };

/** ⎇: the branch the agent is on now, and its port, on hover or focus (FR-021). */
export function BranchTooltip({ branch, port }: Props) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const show = () => {
    setOpen(true);
  };
  const hide = () => {
    setOpen(false);
  };
  return (
    <span className={styles.branch}>
      <button
        className={styles.icon}
        aria-label="Branche et port"
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        ⎇
      </button>
      {open && (
        <span role="tooltip" id={id} className={styles.tooltip}>
          {branch} · :{port}
        </span>
      )}
    </span>
  );
}
