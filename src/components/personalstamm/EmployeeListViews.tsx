/**
 * EmployeeListViews — Präsentations-Ansichten der Personalstamm-Liste.
 * ─────────────────────────────────────────────────────────────────────────────
 * Drei Darstellungen aus DENSELBEN Row-View-Models (personalstamm-list):
 *  - EmployeeTable       volle Breite, 7 Spalten (kein Mitarbeiter ausgewählt)
 *  - EmployeeTiles       Kachel-Ansicht (max. 4 pro Reihe, kompakt)
 *  - EmployeeCompactList schmale Spalte (Detail geöffnet)
 *
 * Strikt präsentational: Rows + Callbacks rein, KEINE Fachlogik, keine Löhne,
 * keine Selektion-abhängigen Fremdzustände in der Zeile (hasContractFile ist
 * Teil des Row-View-Models). Ganze Zeile/Kachel ist klickbar und per Tastatur
 * bedienbar (Button-Semantik bzw. Enter/Leertaste auf der Tabellenzeile).
 */

import { ChevronRight, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EmployeeListRow, EmployeeListStatus } from '@/lib/personalstamm-list';
import type { Department, EmploymentType } from '@/types/personnel';

// ── Gemeinsame Bausteine ────────────────────────────────────────────────────

const DEPT_AVATAR: Record<Department, string> = {
  service: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50',
  'küche': 'bg-orange-100 text-orange-700 dark:bg-orange-950/50',
};

const TYPE_BADGE: Record<EmploymentType, string> = {
  vollzeit: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30',
  teilzeit: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30',
  minijob: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30',
  aushilfe: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30',
};

/** Zentrale Statusfarben: grün=aktiv, blau=geplant, grau=ausgetreten/inaktiv. */
const STATUS_BADGE: Record<EmployeeListStatus, string> = {
  aktiv: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30',
  eintritt_geplant: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30',
  ausgetreten: 'bg-slate-100 text-slate-500 border-slate-300 dark:bg-slate-900/40',
  inaktiv: 'bg-slate-100 text-slate-500 border-slate-300 dark:bg-slate-900/40',
};

function StatusBadge({ row }: { row: EmployeeListRow }) {
  return (
    <span
      data-testid={`status-${row.id}`}
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border whitespace-nowrap',
        STATUS_BADGE[row.status],
      )}
    >
      {row.statusLabel}
    </span>
  );
}

function Avatar({ row, size = 'md' }: { row: EmployeeListRow; size?: 'sm' | 'md' }) {
  return (
    <div
      className={cn(
        'rounded-full flex-shrink-0 flex items-center justify-center font-bold',
        size === 'md' ? 'w-8 h-8 text-sm' : 'w-7 h-7 text-xs',
        DEPT_AVATAR[row.department],
      )}
    >
      {row.name.charAt(0).toUpperCase()}
    </div>
  );
}

/** Abteilung · Position (Position nur wenn hinterlegt). */
function deptPosition(row: EmployeeListRow): string {
  return row.positionLabel ? `${row.deptLabel} · ${row.positionLabel}` : row.deptLabel;
}

const dimmed = (row: EmployeeListRow) =>
  row.status === 'ausgetreten' || row.status === 'inaktiv';

interface ViewProps {
  rows: EmployeeListRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

// ── Tabellen-Ansicht (volle Breite) ─────────────────────────────────────────

export function EmployeeTable({ rows, selectedId, onSelect }: ViewProps) {
  return (
    <div className="overflow-x-auto" data-testid="employee-table">
      <table className="w-full text-sm border-collapse">
        <thead className="sticky top-0 z-10">
          <tr className="bg-card border-b border-border text-left">
            <th className="px-4 py-2 text-xs font-semibold text-muted-foreground">Mitarbeiter</th>
            <th className="px-3 py-2 text-xs font-semibold text-muted-foreground">Abteilung / Position</th>
            <th className="px-3 py-2 text-xs font-semibold text-muted-foreground">Anstellung</th>
            <th className="px-3 py-2 text-xs font-semibold text-muted-foreground">Eintritt</th>
            <th className="px-3 py-2 text-xs font-semibold text-muted-foreground text-right">Pensum</th>
            <th className="px-3 py-2 text-xs font-semibold text-muted-foreground">Status</th>
            <th className="px-3 py-2 w-8" aria-label="Öffnen" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => {
            const isSelected = selectedId === row.id;
            return (
              <tr
                key={row.id}
                data-testid={`employee-row-${row.id}`}
                tabIndex={0}
                role="button"
                aria-label={`${row.name} öffnen`}
                onClick={() => onSelect(row.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(row.id);
                  }
                }}
                className={cn(
                  'cursor-pointer transition-colors hover:bg-muted/50',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  isSelected && 'bg-primary/5',
                  dimmed(row) && 'opacity-60',
                )}
              >
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Avatar row={row} size="sm" />
                    <span className="font-semibold truncate">{row.name}</span>
                    {row.hasContractFile && <FileText className="h-3 w-3 text-muted-foreground shrink-0" />}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">{deptPosition(row)}</td>
                <td className="px-3 py-2.5">
                  <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border', TYPE_BADGE[row.employmentType])}>
                    {row.typeLabel}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-xs tabular-nums whitespace-nowrap">{row.eintrittLabel}</td>
                <td className="px-3 py-2.5 text-xs tabular-nums text-right whitespace-nowrap">{row.pensumLabel}</td>
                <td className="px-3 py-2.5"><StatusBadge row={row} /></td>
                <td className="px-3 py-2.5 text-right">
                  <ChevronRight className="h-4 w-4 text-muted-foreground inline-block" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Kachel-Ansicht ──────────────────────────────────────────────────────────

export function EmployeeTiles({ rows, selectedId, onSelect }: ViewProps) {
  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5 p-4"
      data-testid="employee-tiles"
    >
      {rows.map((row) => {
        const isSelected = selectedId === row.id;
        return (
          <button
            key={row.id}
            type="button"
            data-testid={`employee-tile-${row.id}`}
            onClick={() => onSelect(row.id)}
            className={cn(
              'text-left rounded-lg border border-border bg-card p-3 flex flex-col gap-1.5 transition-colors hover:bg-muted/50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isSelected && 'border-primary bg-primary/5',
              dimmed(row) && 'opacity-60',
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Avatar row={row} size="sm" />
              <span className="text-sm font-semibold truncate flex-1">{row.name}</span>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            </div>
            <p className="text-xs text-muted-foreground truncate">{deptPosition(row)}</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border', TYPE_BADGE[row.employmentType])}>
                {row.typeLabel}
              </span>
              <StatusBadge row={row} />
            </div>
            <p className="text-[11px] text-muted-foreground tabular-nums">
              Eintritt {row.eintrittLabel} · Pensum {row.pensumLabel}
            </p>
          </button>
        );
      })}
    </div>
  );
}

// ── Kompakt-Liste (schmale Spalte bei geöffnetem Detail) ────────────────────

export function EmployeeCompactList({ rows, selectedId, onSelect }: ViewProps) {
  return (
    <ul className="divide-y divide-border" data-testid="employee-compact-list">
      {rows.map((row) => {
        const isSelected = selectedId === row.id;
        return (
          <li key={row.id}>
            <button
              type="button"
              data-testid={`employee-compact-${row.id}`}
              onClick={() => onSelect(row.id)}
              className={cn(
                'w-full text-left px-4 py-2.5 hover:bg-muted/50 transition-colors flex items-center gap-2.5',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                isSelected && 'bg-primary/5 border-l-2 border-primary',
                dimmed(row) && 'opacity-60',
              )}
            >
              <Avatar row={row} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate flex items-center gap-1.5">
                  <span className="truncate">{row.name}</span>
                  {row.hasContractFile && <FileText className="h-3 w-3 text-muted-foreground shrink-0" />}
                </p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {deptPosition(row)} · {row.typeLabel}
                </p>
              </div>
              <StatusBadge row={row} />
              <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
