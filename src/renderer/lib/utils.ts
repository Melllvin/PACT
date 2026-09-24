import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// research.md R16 — joins class names; later Tailwind classes override conflicting earlier ones.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
