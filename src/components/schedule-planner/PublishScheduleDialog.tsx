import { useCallback, useEffect, useMemo, useState } from 'react';
import { addDays, addWeeks, format, getISOWeek, startOfWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { Check, Copy, FileDown, Loader2, MessageCircle, RefreshCw, Send } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { isEmployeeActiveInMonth } from '@/lib/personnel-utils';
import { loadScheduleForMonth } from '@/lib/supabase-db';
import type { TenantId } from '@/contexts/TenantContext';
import { getPublicBaseUrl } from '@/lib/public-url';
import {
  SHARE_DEPARTMENT_LABEL,
  buildPublicScheduleLink,
  buildWeekPayload,
  buildWhatsAppMessage,
  buildWhatsAppUrl,
  computeStatus,
  formatKwRuns,
  type PublishStatus,
  type ShareDepartment,
  type ShareSourceDay,
  type ShareSourceEmployee,
  type WeekPayload,
} from '@/lib/schedule-publish-payload';
import {
  getPublishedWeek,
  getShareToken,
  publishWeek,
  rotateShareToken,
  type PublishedWeekRecord,
} from '@/lib/schedule-publish-db';

type PublishEmployee = ShareSourceEmployee & {
  employmentEndDate?: string | null;
  contractStart?: string | null;
  isActive?: boolean;
};

interface PublishScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: TenantId;
  /** Rollen-gefilterte Mitarbeiterliste des Planers */
  employees: PublishEmployee[];
  scheduleData: Record<string, ShareSourceDay | undefined>;
  /** Aktuell im Planer sichtbare Tage — bestimmt nur, ab welcher Woche die Liste beginnt */
  displayDays: Date[];
  /** Monat (yyyy-MM), dessen Plan in scheduleData geladen ist; andere Monate lädt der Dialog selbst */
  plannerMonth: string;
  /** Abteilungen, die die Rolle veröffentlichen darf */
  allowedDepartments: ShareDepartment[];
  /** true, solange Änderungen im Planer noch nicht (bestätigt) gespeichert sind */
  hasUnsavedChanges: boolean;
  /** Speichert den Dienstplan; liefert true bei Erfolg */
  onSaveNow: () => Promise<boolean>;
}

interface WeekRow {
  weekStart: Date;
  weekKey: string;
  kw: number;
  record: PublishedWeekRecord | null;
  payload: WeekPayload;
  status: PublishStatus;
  changedDays: number;
  shiftCount: number;
}

/** So viele kommende Wochen prüft der Dialog auf Schichten */
const WEEKS_LISTED = 9; // = Veröffentlichungsfenster der DB (heute + 60 Tage)
/** Davon zeigt die Liste zunächst so viele Wochen (nur mit Schichten oder bereits veröffentlicht) */
const PAGE_SIZE = 5;

const STATUS_LABEL: Record<PublishStatus, string> = {
  draft: 'Nicht veröffentlicht',
  published: 'Veröffentlicht',
  changed: 'Geändert seit Veröffentlichung',
};

function activeInWeek(e: PublishEmployee, weekStart: Date): boolean {
  const weekEnd = addDays(weekStart, 6);
  return (
    isEmployeeActiveInMonth(e, weekStart.getFullYear(), weekStart.getMonth() + 1) ||
    isEmployeeActiveInMonth(e, weekEnd.getFullYear(), weekEnd.getMonth() + 1)
  );
}

function countShifts(p: WeekPayload): number {
  return p.employees.reduce(
    (sum, e) => sum + e.days.filter(d => d.früh || d.spät || d.frühAbsence || d.spätAbsence).length,
    0,
  );
}

export function PublishScheduleDialog({
  open, onOpenChange, tenantId, employees, scheduleData: plannerSchedule, displayDays, plannerMonth,
  allowedDepartments, hasUnsavedChanges, onSaveNow,
}: PublishScheduleDialogProps) {
  const [savingNow, setSavingNow] = useState(false);
  const [department, setDepartment] = useState<ShareDepartment>(allowedDepartments[0] ?? 'service');
  const [records, setRecords] = useState<Record<string, PublishedWeekRecord | null>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Pläne anderer Monate (Wochen über die Monatsgrenze / kommende Monate), aus der DB */
  const [otherMonths, setOtherMonths] = useState<Record<string, ShareSourceDay | undefined>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [publishing, setPublishing] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [token, setToken] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [customMessage, setCustomMessage] = useState<string | null>(null);
  /** Wochen, die in dieser Dialog-Sitzung veröffentlicht wurden (für Nachrichtentext) */
  const [justPublished, setJustPublished] = useState<{ weekKeys: string[]; wasUpdate: boolean } | null>(null);

  // Planer-Stand gewinnt (für den geladenen Monat); alle anderen Monate kommen aus der DB.
  const scheduleData = useMemo(() => ({ ...otherMonths, ...plannerSchedule }), [otherMonths, plannerSchedule]);

  // Ab der im Planer gezeigten Woche (frühestens die aktuelle) die nächsten Wochen, im
  // Veröffentlichungsfenster der DB (heute + 60 Tage). Unabhängig von Wochen-/Monatsansicht.
  const anchorKey = format(displayDays[0] ?? new Date(), 'yyyy-MM-dd');
  const weekStarts = useMemo(() => {
    const thisMonday = startOfWeek(new Date(), { weekStartsOn: 1 });
    const anchor = startOfWeek(new Date(`${anchorKey}T00:00:00`), { weekStartsOn: 1 });
    const first = anchor < thisMonday ? thisMonday : anchor;
    const limit = addDays(new Date(), 60);
    return Array.from({ length: WEEKS_LISTED }, (_, i) => addWeeks(first, i)).filter(m => m <= limit);
  }, [anchorKey]);
  const weekKeysSig = weekStarts.map(w => format(w, 'yyyy-MM-dd')).join(',');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const keys = weekKeysSig ? weekKeysSig.split(',') : [];
      // Monate der Wochen (Mo–So), die nicht im Planer geladen sind
      const months = new Set<string>();
      for (const k of keys) {
        const monday = new Date(`${k}T00:00:00`);
        for (let i = 0; i < 7; i++) months.add(format(addDays(monday, i), 'yyyy-MM'));
      }
      months.delete(plannerMonth);
      const [tok, recs, monthData] = await Promise.all([
        getShareToken(tenantId, department),
        Promise.all(keys.map(k => getPublishedWeek(tenantId, department, k))),
        Promise.all([...months].map(m => loadScheduleForMonth(new Date(`${m}-01T00:00:00`), tenantId))),
      ]);
      // Nie mit unvollständigen Daten veröffentlichen: ein Ladefehler bricht ab.
      if (monthData.some(d => d === null)) throw new Error('Plan des Folgemonats konnte nicht geladen werden');
      setOtherMonths(Object.assign({}, ...monthData.map(d => d ?? {})));
      setToken(tok);
      setRecords(Object.fromEntries(keys.map((k, i) => [k, recs[i]])));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Laden fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  }, [tenantId, department, weekKeysSig, plannerMonth]);

  useEffect(() => {
    if (!open) return;
    setJustPublished(null);
    setShown(PAGE_SIZE);
    setConfirmRotate(false);
    setCustomMessage(null);
    void load();
  }, [open, load]);

  const rows: WeekRow[] = useMemo(
    () =>
      weekStarts.map(weekStart => {
        const weekKey = format(weekStart, 'yyyy-MM-dd');
        const record = records[weekKey] ?? null;
        const { payload, changedDays } = buildWeekPayload({
          department,
          weekStart,
          employees: employees.filter(e => activeInWeek(e, weekStart)),
          scheduleData,
          previous: record?.payload ?? null,
        });
        return {
          weekStart,
          weekKey,
          kw: getISOWeek(weekStart),
          record,
          payload,
          status: computeStatus(record?.payload ?? null, payload),
          changedDays,
          shiftCount: countShifts(payload),
        };
      }),
    [weekStarts, records, department, employees, scheduleData],
  );

  // Nur Wochen mit Schichten oder bereits veröffentlichte (z. B. inzwischen geleerte) anzeigen.
  const relevantRows = useMemo(() => rows.filter(r => r.shiftCount > 0 || r.record !== null), [rows]);
  const visibleRows = relevantRows.slice(0, shown);

  // Vorauswahl: alles, was veröffentlicht werden muss und Schichten enthält.
  useEffect(() => {
    setSelected(new Set(relevantRows.slice(0, PAGE_SIZE).filter(r => r.status !== 'published' && r.shiftCount > 0).map(r => r.weekKey)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, department, weekKeysSig]);

  const link = token ? buildPublicScheduleLink(getPublicBaseUrl(), token) : null;

  const toggle = (key: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const selectable = visibleRows.filter(r => r.shiftCount > 0);
  const allSelected = selectable.length > 0 && selectable.every(r => selected.has(r.weekKey));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(selectable.map(r => r.weekKey)));

  /** PDF (A4 quer, eine Woche pro Seite) der angehakten Wochen — aktueller Planer-Stand. */
  const handlePdf = async () => {
    const chosen = rows.filter(r => selected.has(r.weekKey));
    if (chosen.length === 0 || publishing || pdfBusy) return;
    setPdfBusy(true);
    try {
      const { downloadSchedulePdf, PDF_THEMES } = await import('@/lib/schedule-pdf');
      await downloadSchedulePdf(
        chosen.map(r => ({ payload: r.payload, publishedAt: r.record?.published_at ?? null })),
        { department, theme: PDF_THEMES[tenantId] ?? PDF_THEMES.oliv },
      );
    } catch (e) {
      toast.error(`PDF konnte nicht erstellt werden: ${e instanceof Error ? e.message : 'Unbekannter Fehler'}`);
    } finally {
      setPdfBusy(false);
    }
  };

  const handleSaveNow = async () => {
    setSavingNow(true);
    try {
      await onSaveNow();
    } finally {
      setSavingNow(false);
    }
  };

  const handlePublish = async () => {
    // Nur gespeicherte Stände veröffentlichen — sonst sieht das Team etwas anderes,
    // als nach einem Neuladen im Planer steht.
    if (hasUnsavedChanges) {
      toast.error('Nicht gespeicherte Änderungen — bitte zuerst speichern, danach erneut veröffentlichen.', {
        duration: 8000,
      });
      return;
    }
    const toPublish = rows.filter(r => selected.has(r.weekKey));
    if (toPublish.length === 0 || pdfBusy) return;
    setPublishing(true);
    const done: string[] = [];
    try {
      for (const row of toPublish) {
        const revision = await publishWeek(tenantId, department, row.weekKey, row.payload);
        // Gegenprobe: Was gespeichert wurde, muss auch lesbar sein.
        const check = await getPublishedWeek(tenantId, department, row.weekKey);
        // >=: eine parallele Veröffentlichung durch eine andere Person ist kein Fehler.
        if (!check || check.revision < revision) {
          throw new Error(`KW ${row.kw}: Veröffentlichung konnte nicht bestätigt werden`);
        }
        done.push(row.weekKey);
      }
      setJustPublished({
        weekKeys: done,
        wasUpdate: toPublish.some(r => r.record !== null),
      });
      toast.success(`${done.length === 1 ? 'Woche' : `${done.length} Wochen`} veröffentlicht`);
    } catch (e) {
      toast.error(
        `Veröffentlichen fehlgeschlagen${done.length ? ` (${done.length} Woche(n) bereits gespeichert)` : ''}: ${
          e instanceof Error ? e.message : 'Unbekannter Fehler'
        }`,
        { duration: 8000 },
      );
    } finally {
      setPublishing(false);
      await load();
    }
  };

  const messageWeeks = useMemo(() => {
    const keys = justPublished
      ? justPublished.weekKeys
      : rows.filter(r => r.record !== null).map(r => r.weekKey);
    return rows.filter(r => keys.includes(r.weekKey)).map(r => ({ kw: r.kw, weekStart: r.weekStart }));
  }, [rows, justPublished]);

  const defaultMessage =
    link && messageWeeks.length > 0
      ? buildWhatsAppMessage({
          department,
          weeks: messageWeeks,
          isUpdate: justPublished ? justPublished.wasUpdate : rows.some(r => r.status === 'changed'),
          link,
        })
      : null;

  // Eigener Text überschreibt den Standardtext; null = Standardtext verwenden.
  const messageText = customMessage ?? defaultMessage ?? '';
  const linkMissing = !!link && !messageText.includes(link);

  const handleWhatsApp = () => {
    if (!messageText.trim()) return;
    window.open(buildWhatsAppUrl(messageText), '_blank', 'noopener,noreferrer');
  };

  const handleCopyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Link kopiert');
    } catch {
      toast.error('Kopieren nicht möglich — Link bitte manuell markieren');
    }
  };

  const handleRotate = async () => {
    if (!confirmRotate) {
      setConfirmRotate(true);
      return;
    }
    try {
      setToken(await rotateShareToken(tenantId, department));
      toast.success('Neuer Link erzeugt — der alte Link funktioniert nicht mehr');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Zurücksetzen fehlgeschlagen');
    } finally {
      setConfirmRotate(false);
    }
  };

  const anyPublished = rows.some(r => r.record !== null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* [&>*]:min-w-0 — das Dialog-Grid darf nicht durch den langen Link-Token breiter werden */}
      <DialogContent className="max-w-lg max-h-[92vh] overflow-y-auto overflow-x-hidden [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" /> Dienstplan veröffentlichen
          </DialogTitle>
          <DialogDescription>
            Mitarbeitende sehen nur veröffentlichte Wochen. Nach Änderungen erneut veröffentlichen —
            der Link bleibt gleich.
          </DialogDescription>
        </DialogHeader>

        {allowedDepartments.length > 1 && (
          <div className="flex gap-2">
            {allowedDepartments.map(d => (
              <Button
                key={d}
                size="sm"
                variant={d === department ? 'default' : 'outline'}
                onClick={() => { setDepartment(d); setCustomMessage(null); }}
                disabled={publishing}
              >
                {SHARE_DEPARTMENT_LABEL[d]}
              </Button>
            ))}
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Lade Veröffentlichungsstand…
          </div>
        )}

        {loadError && !loading && (
          <div className="text-sm text-destructive space-y-2">
            <p>{loadError}</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>Erneut versuchen</Button>
          </div>
        )}

        {!loading && !loadError && relevantRows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Für die nächsten Wochen sind noch keine Schichten eingetragen.
          </p>
        )}

        {!loading && !loadError && relevantRows.length > 0 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium">1 · Wochen veröffentlichen</div>
              <button
                type="button"
                className="text-xs text-muted-foreground underline hover:text-foreground"
                onClick={toggleAll}
                disabled={publishing || pdfBusy}
              >
                {allSelected ? 'Keine auswählen' : 'Alle auswählen'}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Wochen anhaken, um sie (erneut) zu veröffentlichen oder als PDF zu speichern.
              Bereits veröffentlichte Wochen sind für Mitarbeitende sichtbar — auch ohne Haken.
            </p>
          </div>
        )}

        {!loading && !loadError && relevantRows.length > 0 && (
          <ul className="space-y-2">
            {visibleRows.map(r => (
              <li key={r.weekKey} className="flex items-start gap-3 rounded-md border p-3">
                <Checkbox
                  checked={selected.has(r.weekKey)}
                  onCheckedChange={() => toggle(r.weekKey)}
                  disabled={publishing || pdfBusy || r.shiftCount === 0}
                  className="mt-0.5"
                  aria-label={`KW ${r.kw} auswählen`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">
                    KW {r.kw} · {format(r.weekStart, 'd. MMM', { locale: de })} –{' '}
                    {format(addDays(r.weekStart, 6), 'd. MMM yyyy', { locale: de })}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {r.shiftCount === 0
                      ? 'Keine Schichten eingetragen'
                      : r.status === 'changed'
                        ? `${r.changedDays} Tag(e) geändert seit der letzten Veröffentlichung`
                        : r.status === 'published'
                          ? `Für Mitarbeitende sichtbar · Revision ${r.record?.revision}`
                          : 'Noch nicht für Mitarbeitende sichtbar'}
                  </div>
                </div>
                <Badge
                  variant={r.status === 'published' ? 'secondary' : r.status === 'changed' ? 'default' : 'outline'}
                  className="shrink-0 gap-1"
                >
                  {r.status === 'published' && <Check className="h-3 w-3" />}
                  {STATUS_LABEL[r.status]}
                </Badge>
              </li>
            ))}
          </ul>
        )}

        {!loading && !loadError && relevantRows.length > visibleRows.length && (
          <Button variant="ghost" size="sm" className="self-center" onClick={() => setShown(n => n + PAGE_SIZE)}>
            Mehr laden ({relevantRows.length - visibleRows.length} weitere)
          </Button>
        )}

        {hasUnsavedChanges && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm space-y-2"
          >
            <p className="font-medium text-destructive">Es gibt nicht gespeicherte Änderungen.</p>
            <p className="text-muted-foreground">
              Bitte zuerst den Dienstplan speichern, danach erneut veröffentlichen. So sehen Mitarbeitende
              genau den Stand, der auch im Planer gespeichert ist.
            </p>
            <Button size="sm" variant="outline" onClick={handleSaveNow} disabled={savingNow}>
              {savingNow ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
              Jetzt speichern
            </Button>
          </div>
        )}

        {!loading && !loadError && relevantRows.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={handlePublish} disabled={publishing || pdfBusy || selected.size === 0} className="flex-1 min-w-[12rem]">
              {publishing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              {selected.size === 0
                ? 'Keine Woche ausgewählt'
                : `${selected.size} ${selected.size === 1 ? 'Woche' : 'Wochen'} veröffentlichen`}
            </Button>
            <Button variant="outline" onClick={handlePdf} disabled={publishing || pdfBusy || selected.size === 0}>
              {pdfBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileDown className="h-4 w-4 mr-2" />}
              PDF
            </Button>
          </div>
        )}

        {!loading && !loadError && link && anyPublished && defaultMessage && (
          <div className="space-y-3 border-t pt-4">
            <div>
              <div className="text-sm font-medium">2 · Link teilen ({SHARE_DEPARTMENT_LABEL[department]})</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Für Mitarbeitende sichtbar: {formatKwRuns(rows.filter(r => r.record !== null).map(r => ({ kw: r.kw, weekStart: r.weekStart })))}
              </p>
            </div>
            {rows.some(r => r.status === 'changed') && (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
                {formatKwRuns(rows.filter(r => r.status === 'changed').map(r => ({ kw: r.kw, weekStart: r.weekStart })))}{' '}
                {rows.filter(r => r.status === 'changed').length > 1 ? 'haben' : 'hat'} Änderungen, die noch nicht
                veröffentlicht sind — Mitarbeitende sehen dort noch die letzte Version.
              </p>
            )}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="share-message" className="text-xs text-muted-foreground">
                  Nachricht — kann vor dem Senden angepasst werden
                </label>
                {customMessage !== null && (
                  <button
                    type="button"
                    className="text-xs underline text-muted-foreground hover:text-foreground"
                    onClick={() => setCustomMessage(null)}
                  >
                    Standardtext wiederherstellen
                  </button>
                )}
              </div>
              <Textarea
                id="share-message"
                value={messageText}
                onChange={e => setCustomMessage(e.target.value)}
                rows={5}
                className="text-sm break-all"
              />
              {linkMissing && (
                <p className="text-xs text-destructive">
                  Der Link fehlt in der Nachricht — Mitarbeitende können den Dienstplan sonst nicht öffnen.
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleWhatsApp} disabled={!messageText.trim() || publishing || pdfBusy} className="bg-green-600 hover:bg-green-700 text-white">
                <MessageCircle className="h-4 w-4 mr-2" /> Per WhatsApp teilen
              </Button>
              <Button variant="outline" onClick={handleCopyLink}>
                <Copy className="h-4 w-4 mr-2" /> Link kopieren
              </Button>
              <Button variant="ghost" size="sm" onClick={handleRotate} className="text-muted-foreground">
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                {confirmRotate ? 'Wirklich zurücksetzen? Alter Link wird ungültig' : 'Link zurücksetzen'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Der Link zeigt den Dienstplan der gesamten Abteilung und kann weitergeleitet werden.
              Krankheit und Unfall erscheinen darin nur als „Abwesend“.
            </p>
            {/localhost|127\.0\.0\.1/.test(link) && (
              <p className="text-xs text-destructive">
                Achtung: Dieser Link zeigt auf eine lokale Adresse und funktioniert nicht auf Handys.
                Bitte VITE_PUBLIC_URL in Vercel setzen oder die Veröffentlichung auf der Vercel-Domain vornehmen.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
