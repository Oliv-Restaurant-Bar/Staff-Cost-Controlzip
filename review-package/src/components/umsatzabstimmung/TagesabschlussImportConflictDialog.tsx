/**
 * TagesabschlussImportConflictDialog.tsx — Abgleich nach Z-Bericht-Import.
 * ============================================================================
 * Erscheint nach einem Tages-Import (period_from === period_to), wenn für
 * importierte Tage manuelle Korrekturen (Overrides) im Tagesabschluss
 * existieren, deren Wert vom neu importierten Auto-Wert abweicht.
 *
 * Pro Konflikt (Tag × Kennzahl) entscheidet der Benutzer:
 *  - „Behalten"   = manuelle Korrektur bleibt wirksam (Default, No-op)
 *  - „Übernehmen" = Korrektur wird ENTFERNT, der Importwert gilt wieder
 * Massenaktionen setzen alle offenen Entscheidungen auf einmal.
 *
 * Abgeschlossene (gesperrte) Tage sind fix auf „Behalten" — Übernehmen
 * erfordert eine Wiederöffnung des Tages auf der Tagesabschluss-Seite
 * (applyImportConflictResolutions fasst gesperrte Tage ohnehin nie an).
 *
 * Der Dialog ist rein präsentational: Erkennung und Persistenz übernimmt
 * die aufrufende Seite (detectTagesabschlussImportConflicts /
 * applyImportConflictResolutions in src/lib/tagesabschluss.ts).
 */

import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type {
  TagesabschlussImportConflict,
  TagesabschlussImportConflictAction,
  TagesabschlussImportConflictResolution,
} from '@/lib/tagesabschluss';
import { fmtChf } from './adyen-ui';

interface TagesabschlussImportConflictDialogProps {
  /** null = Dialog geschlossen. */
  conflicts: TagesabschlussImportConflict[] | null;
  /** Schließen ohne Änderung (= alle behalten). */
  onCancel: () => void;
  /** Entscheidungen anwenden (gesperrte Tage sind bereits auf „behalten" fixiert). */
  onConfirm: (resolutions: TagesabschlussImportConflictResolution[]) => void;
  saving?: boolean;
}

const conflictKey = (c: Pick<TagesabschlussImportConflict, 'date' | 'field'>): string =>
  `${c.date}:${c.field}`;

/** dd.mm.yyyy aus yyyy-MM-dd (reine Anzeige). */
function fdate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso;
}

export function TagesabschlussImportConflictDialog({
  conflicts, onCancel, onConfirm, saving = false,
}: TagesabschlussImportConflictDialogProps) {
  const open = conflicts !== null && conflicts.length > 0;
  const [actions, setActions] = useState<Record<string, TagesabschlussImportConflictAction>>({});

  // Bei neuem Konflikt-Set: alle Entscheidungen auf „behalten" zurücksetzen.
  useEffect(() => {
    if (!conflicts) { setActions({}); return; }
    const init: Record<string, TagesabschlussImportConflictAction> = {};
    for (const c of conflicts) init[conflictKey(c)] = 'behalten';
    setActions(init);
  }, [conflicts]);

  if (!open || !conflicts) return null;

  const lockedCount = conflicts.filter(c => c.dayLocked).length;
  const setAll = (action: TagesabschlussImportConflictAction) => {
    setActions(prev => {
      const next = { ...prev };
      for (const c of conflicts) {
        if (c.dayLocked) continue; // gesperrt bleibt „behalten"
        next[conflictKey(c)] = action;
      }
      return next;
    });
  };

  const handleConfirm = () => {
    onConfirm(conflicts.map(c => ({
      date: c.date,
      field: c.field,
      action: c.dayLocked ? 'behalten' : (actions[conflictKey(c)] ?? 'behalten'),
    })));
  };

  const takeCount = conflicts.filter(c => !c.dayLocked && actions[conflictKey(c)] === 'uebernehmen').length;

  return (
    <Dialog open onOpenChange={o => { if (!o && !saving) onCancel(); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto" data-testid="ta-conflict-dialog">
        <DialogHeader>
          <DialogTitle>Import-Abgleich: manuelle Korrekturen prüfen</DialogTitle>
          <DialogDescription>
            Für importierte Tage existieren manuelle Korrekturen im Tagesabschluss,
            die vom neuen Importwert abweichen. Entscheide pro Kennzahl, ob die
            Korrektur bestehen bleibt („Behalten") oder der Importwert wieder
            gilt („Übernehmen" entfernt die Korrektur).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={saving}
            onClick={() => setAll('behalten')} data-testid="ta-conflict-all-keep">
            Alle behalten
          </Button>
          <Button variant="outline" size="sm" disabled={saving}
            onClick={() => setAll('uebernehmen')} data-testid="ta-conflict-all-take">
            Alle Importwerte übernehmen
          </Button>
          {lockedCount > 0 && (
            <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
              <Lock className="h-3 w-3" aria-hidden="true" />
              {lockedCount} Konflikt{lockedCount === 1 ? '' : 'e'} an abgeschlossenen Tagen —
              zum Übernehmen zuerst den Tag wieder öffnen.
            </span>
          )}
        </div>

        <div className="border border-border rounded-md overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/50 text-muted-foreground">
                <th className="px-2 py-1.5 text-left font-medium">Datum</th>
                <th className="px-2 py-1.5 text-left font-medium">Kennzahl</th>
                <th className="px-2 py-1.5 text-right font-medium">Manuell (aktuell)</th>
                <th className="px-2 py-1.5 text-right font-medium">Import (neu)</th>
                <th className="px-2 py-1.5 text-right font-medium">Ursprüngliches Original</th>
                <th className="px-2 py-1.5 text-left font-medium">Entscheidung</th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map(c => {
                const key = conflictKey(c);
                const action = c.dayLocked ? 'behalten' : (actions[key] ?? 'behalten');
                return (
                  <tr key={key} className="border-t border-border" data-testid={`ta-conflict-${c.date}-${c.field}`}>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1">
                        {fdate(c.date)}
                        {c.dayLocked && (
                          <span title="Tag abgeschlossen — Übernehmen erfordert Wiederöffnung.">
                            <Lock className="h-3 w-3 text-muted-foreground" aria-label="Tag gesperrt" />
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{c.label}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap bg-amber-50 dark:bg-amber-900/20 font-medium">
                      {fmtChf(c.manualValue)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap font-medium">
                      {fmtChf(c.importValue)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">
                      {fmtChf(c.originalValue)}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <div className="inline-flex rounded-md border border-border overflow-hidden">
                        <button
                          type="button"
                          disabled={saving}
                          className={`px-2 py-0.5 text-[11px] font-medium cursor-pointer disabled:cursor-not-allowed ${action === 'behalten'
                            ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200'
                            : 'bg-background text-muted-foreground hover:bg-accent'}`}
                          onClick={() => setActions(prev => ({ ...prev, [key]: 'behalten' }))}
                          data-testid={`ta-conflict-keep-${c.date}-${c.field}`}
                        >
                          Behalten
                        </button>
                        <button
                          type="button"
                          disabled={saving || c.dayLocked}
                          title={c.dayLocked ? 'Tag abgeschlossen — zuerst wieder öffnen.' : undefined}
                          className={`px-2 py-0.5 text-[11px] font-medium border-l border-border cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${action === 'uebernehmen'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-background text-muted-foreground hover:bg-accent'}`}
                          onClick={() => setActions(prev => ({ ...prev, [key]: 'uebernehmen' }))}
                          data-testid={`ta-conflict-take-${c.date}-${c.field}`}
                        >
                          Übernehmen
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={saving} onClick={onCancel} data-testid="ta-conflict-cancel">
            Abbrechen (alle behalten)
          </Button>
          <Button disabled={saving} onClick={handleConfirm} data-testid="ta-conflict-save">
            {takeCount > 0
              ? `Anwenden (${takeCount} Korrektur${takeCount === 1 ? '' : 'en'} entfernen)`
              : 'Anwenden (alle behalten)'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
