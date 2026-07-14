/**
 * GuestProfileLink — einheitlicher, anklickbarer Gästename
 * =========================================================
 * Rendert den Gästenamen als Link (→ Gästeprofil), wenn ein `onSelect`-Handler
 * UND eine `guestId` vorhanden sind — sonst als reinen Text (z. B. nicht
 * zugeordnete Reservation).  Sorgt für konsistente Link-Optik (Cursor, Hover,
 * Fokus) über alle CRM-Listen hinweg.
 *
 * `stopPropagation` verhindert in Tabellen mit zeilenweitem Klick, dass der
 * Klick auf den Namen zusätzlich den Zeilen-Handler auslöst (Doppel-Navigation).
 */

import { cn } from '@/lib/utils';

export function GuestProfileLink({ name, guestId, onSelect, stopPropagation, className }: {
  name: string;
  guestId: string | null;
  onSelect?: (guestId: string) => void;
  stopPropagation?: boolean;
  className?: string;
}) {
  if (onSelect && guestId) {
    return (
      <button
        type="button"
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          onSelect(guestId);
        }}
        className={cn(
          'cursor-pointer text-left font-medium text-primary underline-offset-2 hover:underline focus:underline focus:outline-none',
          className,
        )}
        title="Zum Gästeprofil"
      >
        {name}
      </button>
    );
  }
  return <span className={cn('font-medium text-foreground', className)}>{name}</span>;
}
