import { useState } from 'react';
import {
  History, ChevronDown, ChevronUp, FileSpreadsheet,
  CheckCircle2, AlertTriangle, XCircle, RefreshCw, ExternalLink,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { MONTH_NAMES_DE, type ImportHistoryEntry } from '@/lib/timesheet-store';
import type { QualityFieldEntry } from '@/lib/import-quality';
import { computeOverallStatus } from '@/lib/import-quality';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDatetime(iso: string): string {
  return new Date(iso).toLocaleString('de-CH', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

/** 🟢 95–100 % · 🟡 80–94 % · 🔴 <80 % */
function pctColor(p: number): string {
  if (p >= 95) return 'text-emerald-600 dark:text-emerald-400';
  if (p >= 80) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}
function pctBg(p: number): string {
  if (p >= 95) return 'bg-emerald-500 dark:bg-emerald-600';
  if (p >= 80) return 'bg-amber-500 dark:bg-amber-500';
  return 'bg-red-500 dark:bg-red-600';
}
function pctDot(p: number): React.ReactNode {
  return <span className={cn('inline-block w-2 h-2 rounded-full shrink-0', pctBg(p))} />;
}
function pctBadge(p: number, label: string): React.ReactNode {
  return (
    <span className={cn('tabular-nums font-semibold', pctColor(p))}>
      {label}
    </span>
  );
}

function getQualityFields(entry: ImportHistoryEntry): QualityFieldEntry[] {
  if (!entry.parser_quality) return [];
  const pq = entry.parser_quality as Record<string, unknown>;
  if (Array.isArray(pq['qualityFields'])) return pq['qualityFields'] as QualityFieldEntry[];
  return [];
}

// ─── Status-Badge ──────────────────────────────────────────────────────────────

function OverallBadge({ status }: { status: 'ok' | 'warn' | 'error' }) {
  if (status === 'ok') return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/40 px-1.5 py-0.5 rounded">
      <CheckCircle2 className="h-3 w-3" />OK
    </span>
  );
  if (status === 'warn') return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40 px-1.5 py-0.5 rounded">
      <AlertTriangle className="h-3 w-3" />Warnung
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-950/40 px-1.5 py-0.5 rounded">
      <XCircle className="h-3 w-3" />Fehler
    </span>
  );
}

// ─── Qualitäts-Zeile (shared) ──────────────────────────────────────────────────

function QualityRow({ f }: { f: QualityFieldEntry }) {
  const [open, setOpen] = useState(false);
  const isCountOnly = f.detected === f.expected && f.percent === 100 && f.missing.length === 0;
  const hasMissing  = f.missing.length > 0 || f.warnings.length > 0;

  return (
    <>
      <tr
        className={cn(
          'transition-colors',
          hasMissing && 'cursor-pointer hover:bg-muted/20',
          f.percent < 95 && f.percent >= 80 && 'bg-amber-50/30 dark:bg-amber-950/10',
          f.percent < 80 && 'bg-red-50/30 dark:bg-red-950/10',
        )}
        onClick={() => { if (hasMissing) setOpen(v => !v); }}
      >
        <td className="px-3 py-2 font-medium text-foreground">
          <div className="flex items-center gap-1.5">
            {hasMissing
              ? (open
                ? <ChevronUp   className="h-3 w-3 text-muted-foreground shrink-0" />
                : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />)
              : pctDot(f.percent)}
            {f.label}
            {isCountOnly && (
              <span className="text-[10px] text-muted-foreground/60">(Anzahl)</span>
            )}
          </div>
        </td>
        <td className="px-3 py-2 text-right tabular-nums font-medium">{f.detected}</td>
        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{f.expected}</td>
        <td className="px-3 py-2 text-right">
          {pctBadge(f.percent, `${f.percent} %`)}
        </td>
        <td className="px-3 py-2 text-center">
          {pctDot(f.percent)}
        </td>
      </tr>
      {open && hasMissing && (
        <tr className="bg-muted/20">
          <td colSpan={5} className="px-6 py-2">
            {f.missing.length > 0 && (
              <div className="space-y-0.5 text-[11px] text-muted-foreground mb-1">
                {f.missing.slice(0, 15).map((m, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <XCircle className="h-3 w-3 text-red-400 shrink-0" />
                    {m}
                  </div>
                ))}
                {f.missing.length > 15 && (
                  <div className="text-muted-foreground/60">…und {f.missing.length - 15} weitere</div>
                )}
              </div>
            )}
            {f.warnings.map((w, i) => (
              <div key={i} className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3 shrink-0" />{w}
              </div>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Vollständiges Detail-Sheet ────────────────────────────────────────────────

function QualityDetailSheet({
  entry,
  open,
  onClose,
}: { entry: ImportHistoryEntry | null; open: boolean; onClose: () => void }) {
  if (!entry) return null;
  const qualityFields = getQualityFields(entry);
  const overall = qualityFields.length > 0 ? computeOverallStatus(qualityFields) : null;

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-xl flex flex-col p-0 gap-0">
        <SheetHeader className="px-5 py-4 border-b border-border shrink-0 bg-card">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4 text-primary shrink-0" />
            Import-Details
          </SheetTitle>
          <div className="mt-1 space-y-0.5">
            <p className="text-sm font-semibold">
              {MONTH_NAMES_DE[(entry.month ?? 1) - 1]} {entry.year}
              {entry.is_reimport && <span className="ml-2 text-[10px] text-muted-foreground">(Re-Import)</span>}
            </p>
            <p className="text-xs text-muted-foreground">
              {fmtDatetime(entry.created_at)}
              {entry.created_by && <> · {entry.created_by}</>}
            </p>
            {entry.file_name && (
              <p className="text-[11px] text-muted-foreground/70 font-mono truncate">{entry.file_name}</p>
            )}
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-auto">

          {/* Import-Statistik */}
          <div className="px-5 pt-4 pb-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Import-Statistik
            </p>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {[
                { label: 'Importiert',   value: entry.imported_count },
                { label: 'Übersprungen', value: entry.skipped_count ?? 0 },
                { label: 'Fehler',       value: entry.error_count },
                { label: 'Neu erstellt', value: entry.created_employees_count ?? 0 },
                { label: 'Manuell',      value: entry.manual_matches_count ?? 0 },
                ...(entry.is_reimport ? [{ label: 'Gelöscht', value: entry.deleted_count ?? 0 }] : []),
              ].map(s => (
                <div key={s.label} className="bg-muted/40 rounded-lg px-3 py-2">
                  <p className="text-muted-foreground mb-0.5">{s.label}</p>
                  <p className={cn('font-bold tabular-nums', s.label === 'Fehler' && s.value > 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground')}>
                    {s.value}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Qualitätsfelder */}
          {qualityFields.length > 0 ? (
            <div className="px-5 pb-4">
              <div className="flex items-center gap-2 mb-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Erkennungsgrad
                </p>
                {overall && <OverallBadge status={overall} />}
              </div>
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/40 border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 text-left font-semibold">Datenfeld</th>
                      <th className="px-3 py-2 text-right font-semibold">Erkannt</th>
                      <th className="px-3 py-2 text-right font-semibold">Erwartet</th>
                      <th className="px-3 py-2 text-right font-semibold">Qualität</th>
                      <th className="px-3 py-2 text-center font-semibold w-6">●</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {qualityFields.map(f => (
                      <QualityRow key={f.key} f={f} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="px-5 pb-4">
              <p className="text-xs text-muted-foreground italic">
                Qualitätsdaten für diesen Import nicht verfügbar (älterer Import ohne Qualitätsdaten).
              </p>
            </div>
          )}

          {/* Fehler */}
          {entry.errors && entry.errors.length > 0 && (
            <div className="px-5 pb-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Fehler ({entry.errors.length})
              </p>
              <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/20 overflow-hidden">
                <div className="max-h-48 overflow-y-auto divide-y divide-red-100 dark:divide-red-900">
                  {entry.errors.map((e, i) => (
                    <p key={i} className="px-3 py-1.5 text-xs text-red-700 dark:text-red-300 font-mono">{e}</p>
                  ))}
                </div>
              </div>
            </div>
          )}

        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Import-Auswertung Karte (permanent sichtbar) ──────────────────────────────

/**
 * Permanente Qualitätsübersicht des letzten Imports für den angezeigten Monat.
 * Zeigt die vollständige Erkennungsgrad-Tabelle mit Klick-to-expand für fehlende Werte.
 */
export function ImportQualitySummaryCard({ entry }: { entry: ImportHistoryEntry }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [tableExpanded, setTableExpanded] = useState(true);
  const qualityFields = getQualityFields(entry);
  const overall = qualityFields.length > 0 ? computeOverallStatus(qualityFields) : null;

  return (
    <>
      <div className="rounded-lg border border-border bg-card overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/20">
          <History className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold">
                Import-Auswertung — {MONTH_NAMES_DE[(entry.month ?? 1) - 1]} {entry.year}
              </span>
              {overall && <OverallBadge status={overall} />}
              {entry.is_reimport && (
                <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">Re-Import</span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {fmtDatetime(entry.created_at)}
              {entry.file_name && <> · <span className="font-mono">{entry.file_name}</span></>}
              {entry.created_by && <> · {entry.created_by}</>}
            </p>
          </div>
          <button
            onClick={() => setDetailOpen(true)}
            className="shrink-0 flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors border border-primary/30 hover:border-primary rounded px-2 py-1"
            title="Vollständige Import-Details anzeigen"
          >
            <ExternalLink className="h-3 w-3" />
            Details
          </button>
        </div>

        {/* Import-Statistik (kompakt, immer sichtbar) */}
        <div className="grid grid-cols-3 sm:grid-cols-6 divide-x divide-y sm:divide-y-0 divide-border/50 border-b border-border text-xs">
          {[
            { label: 'Importiert',   value: entry.imported_count,                 color: '' },
            { label: 'Übersprungen', value: entry.skipped_count ?? 0,             color: '' },
            { label: 'Fehler',       value: entry.error_count,                    color: entry.error_count > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400' },
            { label: 'Neu erstellt', value: entry.created_employees_count ?? 0,  color: '' },
            { label: 'Manuell',      value: entry.manual_matches_count ?? 0,     color: '' },
            { label: entry.is_reimport ? 'Gelöscht' : 'Geschützt', value: entry.is_reimport ? (entry.deleted_count ?? 0) : (entry.protected_count ?? 0), color: '' },
          ].map(s => (
            <div key={s.label} className="px-3 py-2">
              <p className="text-muted-foreground text-[10px] mb-0.5">{s.label}</p>
              <p className={cn('font-bold tabular-nums', s.color || 'text-foreground')}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Erkennungsgrad-Tabelle (aufklappbar) */}
        <button
          className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-muted/20 transition-colors border-b border-border"
          onClick={() => setTableExpanded(v => !v)}
        >
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">
            Erkennungsgrad
          </span>
          {overall && <OverallBadge status={overall} />}
          {tableExpanded
            ? <ChevronUp   className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        </button>

        {tableExpanded && (
          qualityFields.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/30 border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-1.5 text-left font-semibold">Datenfeld</th>
                    <th className="px-3 py-1.5 text-right font-semibold">Erkannt</th>
                    <th className="px-3 py-1.5 text-right font-semibold">Erwartet</th>
                    <th className="px-3 py-1.5 text-right font-semibold">Qualität</th>
                    <th className="px-3 py-1.5 text-center font-semibold w-10">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {qualityFields.map(f => <QualityRow key={f.key} f={f} />)}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-4 py-3 text-xs text-muted-foreground italic">
              Für diesen Import liegen noch keine Qualitätsdaten vor.
            </p>
          )
        )}

        {/* Footer-Hinweis */}
        <div className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground/60 flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 shrink-0" />95–100 % OK
          <span className="ml-2 inline-block w-2 h-2 rounded-full bg-amber-500 shrink-0" />80–94 % Warnung
          <span className="ml-2 inline-block w-2 h-2 rounded-full bg-red-500 shrink-0" />&lt;80 % Fehler
          <span className="ml-auto">Klick auf Zeile → fehlende Einträge</span>
        </div>
      </div>

      <QualityDetailSheet entry={entry} open={detailOpen} onClose={() => setDetailOpen(false)} />
    </>
  );
}

// ─── Import-Historie Panel ─────────────────────────────────────────────────────

interface ImportHistoryPanelProps {
  historyList:  ImportHistoryEntry[];
  loading?:     boolean;
  onRefresh?:   () => void;
}

export function ImportHistoryPanel({ historyList, loading, onRefresh }: ImportHistoryPanelProps) {
  const [collapsed, setCollapsed]           = useState(false);
  const [selectedEntry, setSelectedEntry]   = useState<ImportHistoryEntry | null>(null);
  const [detailOpen, setDetailOpen]         = useState(false);

  if (historyList.length === 0 && !loading) return null;

  function openDetail(entry: ImportHistoryEntry) {
    setSelectedEntry(entry);
    setDetailOpen(true);
  }

  return (
    <>
      <div className="border border-border rounded-lg bg-card overflow-hidden">

        {/* Header */}
        <button
          className="w-full flex items-center gap-2 px-4 py-3 hover:bg-muted/30 transition-colors text-left"
          onClick={() => setCollapsed(v => !v)}
        >
          <History className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-semibold flex-1">Import-Historie</span>
          <span className="text-xs text-muted-foreground mr-2">{historyList.length} Einträge</span>
          {loading && <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />}
          {!loading && onRefresh && (
            <button
              className="p-1 rounded hover:bg-muted transition-colors"
              onClick={e => { e.stopPropagation(); onRefresh(); }}
              title="Aktualisieren"
            >
              <RefreshCw className="h-3 w-3 text-muted-foreground" />
            </button>
          )}
          {collapsed
            ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            : <ChevronUp   className="h-4 w-4 text-muted-foreground shrink-0" />}
        </button>

        {!collapsed && (
          <div className="border-t border-border overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/40 border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Datum / Zeit</th>
                  <th className="px-3 py-2 text-left font-semibold">Monat</th>
                  <th className="px-3 py-2 text-left font-semibold max-w-[140px]">Dateiname</th>
                  <th className="px-3 py-2 text-center font-semibold">MA %</th>
                  <th className="px-3 py-2 text-center font-semibold">Stempel %</th>
                  <th className="px-3 py-2 text-center font-semibold">Ferien %</th>
                  <th className="px-3 py-2 text-center font-semibold">Feiertag %</th>
                  <th className="px-3 py-2 text-center font-semibold">Status</th>
                  <th className="px-3 py-2 text-center font-semibold">Fehler</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {historyList.map(entry => {
                  const qf = getQualityFields(entry);
                  const get = (key: string) => qf.find(f => f.key === key);
                  const empField = get('employees');
                  const blkField = get('time_blocks');
                  const vacField = get('vacation_balance');
                  const holField = get('public_holiday_balance');
                  const overall  = qf.length > 0 ? computeOverallStatus(qf) : null;

                  return (
                    <tr
                      key={entry.id}
                      className="hover:bg-muted/20 cursor-pointer transition-colors"
                      onClick={() => openDetail(entry)}
                      title="Klick für vollständige Import-Details"
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {fmtDatetime(entry.created_at)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">
                        {MONTH_NAMES_DE[(entry.month ?? 1) - 1]} {entry.year}
                        {entry.is_reimport && (
                          <span className="ml-1 text-[9px] bg-muted text-muted-foreground px-1 py-0.5 rounded">Re</span>
                        )}
                      </td>
                      <td className="px-3 py-2 max-w-[140px]">
                        {entry.file_name ? (
                          <span className="flex items-center gap-1 min-w-0">
                            <FileSpreadsheet className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span className="truncate text-muted-foreground" title={entry.file_name}>
                              {entry.file_name}
                            </span>
                          </span>
                        ) : <span className="text-muted-foreground/40">–</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {empField
                          ? pctBadge(empField.percent, `${empField.detected}/${empField.expected}`)
                          : <span className="text-muted-foreground/40">–</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {blkField
                          ? pctBadge(blkField.percent, `${blkField.percent}%`)
                          : <span className="text-muted-foreground/40">–</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {vacField
                          ? pctBadge(vacField.percent, `${vacField.percent}%`)
                          : <span className="text-muted-foreground/40">–</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {holField
                          ? pctBadge(holField.percent, `${holField.percent}%`)
                          : <span className="text-muted-foreground/40">–</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {overall
                          ? <OverallBadge status={overall} />
                          : <span className="text-muted-foreground/40">–</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {entry.error_count > 0
                          ? <span className="text-red-600 dark:text-red-400 font-semibold">{entry.error_count}</span>
                          : <span className="text-emerald-600 dark:text-emerald-400">0</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="px-3 py-2 text-[10px] text-muted-foreground/60 border-t border-border">
              Klick auf eine Zeile → vollständige Qualitätsdaten, fehlende Werte, Fehlerprotokoll
            </p>
          </div>
        )}
      </div>

      <QualityDetailSheet
        entry={selectedEntry}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      />
    </>
  );
}
