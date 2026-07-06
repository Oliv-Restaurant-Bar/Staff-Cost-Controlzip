/**
 * CockpitDetailDrawer — Detail-Ansicht einer Cockpit-Zeile (Import ODER Kontrolle).
 * ================================================================================
 * Read-only Drawer, der aus allen drei Tabs geöffnet wird. Zeigt je nach
 * `section` die passenden Felder: Import-Zeilen mit „Was hochladen?", Datenständen
 * und Lücken; Kontroll-Zeilen mit Verantwortlich / Warum wichtig / Ablauf.
 * KEINE Schreibaktionen — nur Anzeige + Link zur zuständigen Seite.
 */

import { Link } from 'react-router-dom';
import { ArrowRight, CalendarClock, Globe, Info, UploadCloud, ShieldCheck } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  formatCockpitDate,
  INTERVAL_LABEL,
  IMPORT_TYPE_LABEL,
  type CockpitRow,
} from '@/lib/import-cockpit';
import { computeControlStatus, TAB_CATEGORY_LABEL } from '@/lib/import-cockpit-tabs';
import {
  StatusBadge,
  ControlStatusBadge,
  ImportTypeBadge,
  DetailRow,
  formatDateTime,
  dataUntilOf,
  COMPLETENESS_NOTE,
} from './cockpit-ui';

interface Props {
  row: CockpitRow | null;
  today: string;
  onClose: () => void;
}

export function CockpitDetailDrawer({ row, today, onClose }: Props) {
  const isControl = row?.def.section === 'control';

  return (
    <Sheet open={!!row} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {row && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                {row.def.label}
                {row.def.tenantNeutral && <Globe className="h-4 w-4 text-muted-foreground" />}
              </SheetTitle>
              <SheetDescription>{row.def.description}</SheetDescription>
            </SheetHeader>

            <div className="mt-5 space-y-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Status</span>
                {isControl ? (
                  <ControlStatusBadge status={computeControlStatus(row.def, row.result, today)} />
                ) : (
                  <StatusBadge status={row.result.status} />
                )}
              </div>
              {row.result.reason && (
                <p className="rounded-md bg-muted/60 p-2.5 text-xs text-muted-foreground">{row.result.reason}</p>
              )}

              {/* Kontrollen: Was ist zu tun / warum / wie */}
              {isControl ? (
                <div className="space-y-3">
                  <div className="rounded-md border border-border bg-muted/40 p-3">
                    <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <ShieldCheck className="h-4 w-4" />
                      Was ist zu tun?
                    </div>
                    <p className="text-sm text-muted-foreground">{row.def.uploadLabel}</p>
                  </div>
                  {row.def.importance && (
                    <div>
                      <div className="mb-1 text-xs font-semibold text-foreground">Warum wichtig?</div>
                      <p className="text-xs leading-snug text-muted-foreground">{row.def.importance}</p>
                    </div>
                  )}
                  {row.def.procedure && (
                    <div>
                      <div className="mb-1 text-xs font-semibold text-foreground">Empfohlener Ablauf</div>
                      <p className="text-xs leading-snug text-muted-foreground">{row.def.procedure}</p>
                    </div>
                  )}
                </div>
              ) : (
                /* Importe: Was hochladen? — prominent hervorgehoben */
                <div className="rounded-md border border-border bg-muted/40 p-3">
                  <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    {row.def.importType === 'file_upload' ? (
                      <UploadCloud className="h-4 w-4" />
                    ) : (
                      <Info className="h-4 w-4" />
                    )}
                    Was hochladen?
                  </div>
                  <p className="text-sm text-muted-foreground">{row.def.uploadLabel}</p>
                  <div className="mt-2">
                    <ImportTypeBadge type={row.def.importType} />
                  </div>
                </div>
              )}

              <dl className="divide-y divide-border rounded-md border border-border">
                <DetailRow label="Bereich" value={TAB_CATEGORY_LABEL[row.def.tabCategory]} />
                <DetailRow label="Modul" value={row.def.module} />
                {isControl ? (
                  <>
                    {row.def.responsible && <DetailRow label="Verantwortlich" value={row.def.responsible} />}
                    <DetailRow label="Rhythmus" value={INTERVAL_LABEL[row.def.interval]} />
                    <DetailRow
                      label="Nächste Fälligkeit"
                      value={row.result.nextDue ? formatCockpitDate(row.result.nextDue) : '—'}
                    />
                  </>
                ) : (
                  <>
                    <DetailRow label="Import-Art" value={IMPORT_TYPE_LABEL[row.def.importType]} />
                    {row.def.sourceHint && <DetailRow label="Quelle" value={row.def.sourceHint} />}
                    {row.def.exampleFormat && <DetailRow label="Beispiel-Format" value={row.def.exampleFormat} />}
                    <DetailRow label="Empfohlener Rhythmus" value={INTERVAL_LABEL[row.def.interval]} />
                    <DetailRow label="Letzter Import" value={formatDateTime(row.signal.lastImport?.at)} />
                    {row.signal.fileName && <DetailRow label="Datei" value={row.signal.fileName} />}
                    <DetailRow label="Daten von" value={formatCockpitDate(row.signal.dataFrom)} />
                    <DetailRow label="Ist-Daten bis" value={formatCockpitDate(dataUntilOf(row.signal))} />
                    {row.signal.latestRecordDate && row.signal.latestRecordDate !== dataUntilOf(row.signal) && (
                      <DetailRow
                        label="Letzter gefundener Tagesdatensatz"
                        value={formatCockpitDate(row.signal.latestRecordDate)}
                      />
                    )}
                    {row.def.detectGaps && (
                      <DetailRow
                        label="Vollständig importiert bis"
                        value={formatCockpitDate(row.result.completeUntil)}
                      />
                    )}
                    <DetailRow
                      label="Nächste Fälligkeit"
                      value={row.result.nextDue ? formatCockpitDate(row.result.nextDue) : '—'}
                    />
                    {typeof row.signal.recordCount === 'number' && (
                      <DetailRow label="Datensätze" value={String(row.signal.recordCount)} />
                    )}
                    {typeof row.result.daysBehind === 'number' && (
                      <DetailRow label="Tage hinter Plan" value={String(row.result.daysBehind)} />
                    )}
                  </>
                )}
              </dl>

              {!isControl && row.result.missingDays.length > 0 && (
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                    <CalendarClock className="h-4 w-4" />
                    Fehlende Tage ({row.result.missingDays.length})
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {row.result.missingDays.map((d) => (
                      <span
                        key={d}
                        className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                      >
                        {formatCockpitDate(d)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {!isControl && row.result.ignoredFutureDate && (
                <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Zukunftszeilen bis {formatCockpitDate(row.result.ignoredFutureDate)} gefunden — diese werden für
                    die Vollständigkeit nicht berücksichtigt.
                  </span>
                </p>
              )}

              {!isControl &&
                row.signal.latestRecordDate &&
                dataUntilOf(row.signal) &&
                row.signal.latestRecordDate > dataUntilOf(row.signal)! && (
                  <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                    <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Es wurden spätere Tagesdatensätze bis {formatCockpitDate(row.signal.latestRecordDate)} gefunden,
                      die über das Ende der zuletzt importierten Periode ({formatCockpitDate(dataUntilOf(row.signal))})
                      hinausgehen — diese gelten NICHT als vollständig importierte Periode.
                    </span>
                  </p>
                )}

              {!isControl && COMPLETENESS_NOTE[row.def.id] && (
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {COMPLETENESS_NOTE[row.def.id]}
                </p>
              )}

              {row.def.tenantNeutral && (
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Diese Datenquelle ist mandantenübergreifend — die Frische gilt nicht mandantenspezifisch.
                </p>
              )}

              {row.def.route && (
                <Button asChild className="w-full">
                  <Link to={row.def.route}>
                    {row.def.actionLabel ?? (isControl ? 'Zur Kontrolle' : 'Zur Importseite')}
                    <ArrowRight className="ml-1.5 h-4 w-4" />
                  </Link>
                </Button>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
