/**
 * RhythmOverview — Import-Center nach Rhythmus (Wöchentlich / Monatlich / Einmalig)
 * =================================================================================
 * 1. «Cockpit-Bereitschaft»: pro Wochenquelle «vollständig bis TT.MM.JJJJ»
 *    (= letztes Datum MIT Daten, nicht der Import-Zeitstempel) mit Ampel und
 *    Import-Button direkt in der Zeile.
 * 2. «Monatlich»: Ist-Kosten Buchhaltung, Warenrechnungen (laufend).
 * 3. «Einmalig / selten» (eingeklappt): Jahres-Nachträge (Kosten/Personal),
 *    «Jahre abschliessen» (Jahres-Schreibschutz, Admin), Budget, Stammdaten.
 *
 * Mandantengetrennt: zeigt immer den Stand des aktiven Mandanten. Die
 * eigentliche Import-Logik (Vorschau, Upsert, Backup, Undo) bleibt in den
 * bestehenden Sektionen/Seiten — die Buttons springen nur dorthin.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Upload, RefreshCw, Loader2, CalendarCheck2, CalendarClock, Archive,
  ChevronDown, ChevronRight, Lock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import {
  loadWeeklyFreshness, summarizeReadiness, fmtIsoShort,
  type SourceFreshness, type WeeklySourceId,
} from '@/lib/import-freshness';
import { getLockState, lockYear, unlockYear, formatLockedAt, type PriorYearLockState } from '@/lib/prior-year-lock';
import { usePermissions } from '@/hooks/usePermissions';
import { IMPORT_SECTION_OPEN_EVENT } from '@/components/import-center/ImportGroupCards';

/** Sektion aufklappen + hinscrollen (gleicher Mechanismus wie die Gruppen-Karten). */
function openSection(anchor: string) {
  window.dispatchEvent(new CustomEvent(IMPORT_SECTION_OPEN_EVENT, { detail: anchor }));
  setTimeout(() => {
    document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}

/** Ziel eines Zeilen-Buttons: Anker auf der Seite ODER eigene Route. */
type RowAction = { anchor: string } | { route: string };

const WEEKLY_ACTIONS: Record<WeeklySourceId, RowAction> = {
  umsatz:        { anchor: 'umsatz-ist' },
  gaeste:        { anchor: 'umsatz-ist' },
  avgcheck:      { anchor: 'umsatz-ist' },
  verkauf:       { route: '/sales-upload' },
  mirus:         { anchor: 'ist-stunden' },
  reservationen: { route: '/foratable-import' },
  rezensionen:   { route: '/rezensionen' },
};

function ActionButton({ action, label = 'Import' }: { action: RowAction; label?: string }) {
  if ('route' in action) {
    return (
      <Link to={action.route}>
        <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px] gap-1">
          <Upload className="h-3 w-3" />
          {label}
        </Button>
      </Link>
    );
  }
  return (
    <Button
      size="sm" variant="outline" className="h-7 px-2.5 text-[11px] gap-1"
      onClick={() => openSection(action.anchor)}
    >
      <Upload className="h-3 w-3" />
      {label}
    </Button>
  );
}

function AmpelDot({ status }: { status: SourceFreshness['status'] }) {
  return (
    <span
      className={cn(
        'inline-block h-2.5 w-2.5 rounded-full shrink-0',
        status === 'green'  && 'bg-emerald-500',
        status === 'orange' && 'bg-amber-500',
        status === 'gray'   && 'bg-muted-foreground/40',
      )}
      aria-hidden
    />
  );
}

// ── Block 1: Wöchentlich = Cockpit-Bereitschaft ────────────────────────────

export function CockpitReadinessCard() {
  const { tenantId } = useTenant();
  const [rows, setRows] = useState<SourceFreshness[] | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      setRows(await loadWeeklyFreshness(tenantId, todayIso));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { setRows(null); void reload(); }, [reload]);

  const summary = rows ? summarizeReadiness(rows) : null;

  return (
    <Card className="border-border bg-card shadow-sm" data-testid="cockpit-readiness-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <CalendarCheck2 className="h-4 w-4 text-primary" />
            Wöchentlich — Cockpit-Bereitschaft
          </CardTitle>
          <Button
            size="sm" variant="ghost" className="h-7 px-2 text-[11px] gap-1"
            onClick={() => void reload()} disabled={loading}
            data-testid="readiness-refresh"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Aktualisieren
          </Button>
        </div>
        {/* Kopfzeile: Gesamtstatus über alle Wochenquellen. */}
        {summary && (
          <p className="text-xs" data-testid="readiness-summary">
            {summary.allCurrent ? (
              <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                Alle Wochenquellen aktuell bis {fmtIsoShort(summary.currentUntil, false)}
              </span>
            ) : summary.behind.length > 0 ? (
              <span className="text-amber-700 dark:text-amber-400 font-medium">
                Rückstand bei: {summary.behind.join(', ')}
              </span>
            ) : (
              <span className="text-muted-foreground">Noch keine Daten importiert.</span>
            )}
            {summary.never.length > 0 && summary.behind.length > 0 && (
              <span className="text-muted-foreground"> · Noch nie: {summary.never.join(', ')}</span>
            )}
          </p>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        {!rows ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Datenstand wird geladen …
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {rows.map(r => (
              <div key={r.id} className="flex items-center gap-2.5 py-1.5" data-testid={`readiness-row-${r.id}`}>
                <AmpelDot status={r.status} />
                <span className="text-xs font-medium flex-1 min-w-0 truncate">{r.label}</span>
                <span className="text-[11px] tabular-nums text-right" data-testid={`readiness-until-${r.id}`}>
                  {r.status === 'gray' ? (
                    <span className="text-muted-foreground">noch nie importiert</span>
                  ) : (
                    <>
                      <span className="text-muted-foreground">vollständig bis </span>
                      <span className="font-medium">{fmtIsoShort(r.completeUntil)}</span>
                      {r.status === 'orange' && r.missingDays > 0 && (
                        <span className="text-amber-700 dark:text-amber-400"> · es {r.missingDays === 1 ? 'fehlt 1 Tag' : `fehlen ${r.missingDays} Tage`}</span>
                      )}
                    </>
                  )}
                </span>
                <ActionButton action={WEEKLY_ACTIONS[r.id]} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Block 2: Monatlich ─────────────────────────────────────────────────────

export function MonthlyBlockCard() {
  const rows: Array<{ id: string; label: string; hint: string; action: RowAction }> = [
    { id: 'ist-kosten',      label: 'Kosten Buchhaltung', hint: 'monatlich nach Abschluss', action: { anchor: 'ist-kosten-buchhaltung' } },
    { id: 'warenrechnungen', label: 'Warenrechnungen',        hint: 'laufend erfassen',          action: { route: '/warenrechnungen' } },
  ];
  return (
    <Card className="border-border bg-card shadow-sm" data-testid="monthly-block-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-primary" />
          Monatlich
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="divide-y divide-border/60">
          {rows.map(r => (
            <div key={r.id} className="flex items-center gap-2.5 py-1.5" data-testid={`monthly-row-${r.id}`}>
              <span className="text-xs font-medium flex-1 min-w-0 truncate">{r.label}</span>
              <span className="text-[11px] text-muted-foreground">{r.hint}</span>
              <ActionButton action={r.action} />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Block 3: Einmalig / selten (eingeklappt) ───────────────────────────────

export function RareBlockCard() {
  const { tenantId } = useTenant();
  const { isAdmin } = usePermissions();
  const darfAbschliessen = isAdmin;
  const [open, setOpen] = useState(false);
  // Jahres-Abschluss (prior_year_locked:<tenant>:<jahr>): EIN gemeinsamer Lock
  // pro Jahr — ein abgeschlossenes Jahr ist in ALLEN Import-Pfaden
  // schreibgeschützt (Tagesdaten-Import, Jahres-Sektionen, commitGastronoviDays).
  const currentYear = new Date().getFullYear();
  // Abschliessbar: die letzten 4 Jahre vor dem laufenden Jahr.
  const lockYears = Array.from({ length: 4 }, (_, i) => currentYear - 1 - i);
  const [locks, setLocks] = useState<Record<number, PriorYearLockState>>({});
  const [busyYear, setBusyYear] = useState<number | null>(null);

  const refreshLocks = useCallback(() => {
    let alive = true;
    void Promise.all(lockYears.map(async y => [y, await getLockState(tenantId, y)] as const))
      .then(entries => { if (alive) setLocks(Object.fromEntries(entries)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, currentYear]);

  // Sperr-Status erst beim Aufklappen laden (Block ist standardmässig zu).
  useEffect(() => {
    if (!open) return;
    return refreshLocks();
  }, [open, refreshLocks]);

  /** Jahr abschliessen/entsperren (nur Admin, mit Bestätigung). */
  const toggleYear = async (jahr: number, locked: boolean) => {
    const frage = locked
      ? `Jahr ${jahr} wieder entsperren? Importe in dieses Jahr sind danach wieder möglich.`
      : `Jahr ${jahr} abschliessen (festschreiben)? Alle Importe in dieses Jahr werden danach blockiert, bis ein Admin es wieder entsperrt.`;
    if (!window.confirm(frage)) return;
    setBusyYear(jahr);
    try {
      const ok = locked ? await unlockYear(tenantId, jahr) : await lockYear(tenantId, jahr);
      if (!ok) throw new Error('Speichern fehlgeschlagen');
      setLocks(prev => ({ ...prev, [jahr]: { ...prev[jahr], locked: !locked } }));
      refreshLocks();
    } catch (err) {
      console.error('[JAHR-ABSCHLUSS] Umschalten fehlgeschlagen:', err);
      window.alert(`Jahr ${jahr}: Änderung fehlgeschlagen — bitte erneut versuchen.`);
    } finally {
      setBusyYear(null);
    }
  };

  // Jahr-neutrale Nachtrags-Importe (Sektionen unterstützen jedes Jahr per
  // Dropdown/Erkennung); der frühere separate «Vorjahr-Umsatz»-Einstieg
  // entfällt — Tagesumsätze laufen über den Tagesdaten-Import (Jahr-Dropdown).
  // «Kosten Buchhaltung» ist EIN Import (monatlich + ganzes Jahr als Option).
  const jahresRows: Array<{ source: string; label: string; anchor: string }> = [
    { source: 'kosten',   label: 'Kosten Buchhaltung (Monat oder ganzes Jahr)', anchor: 'ist-kosten-buchhaltung' },
    { source: 'personal', label: 'Personalkosten je Jahr (ohne laufendes Jahr)', anchor: 'personalkosten-vorjahr' },
  ];
  const otherRows: Array<{ id: string; label: string; action: RowAction }> = [
    { id: 'budget', label: 'Budget', action: tenantId === 'beaulieu' ? { anchor: 'beaulieu-budget' } : { route: '/budget' } },
    {
      id: 'mitarbeiter', label: 'Mitarbeiter-Stammdaten',
      action: tenantId === 'beaulieu' ? { anchor: 'beaulieu-mitarbeiter' } : { route: '/personal-stamm' },
    },
  ];

  return (
    <Card className="border-border bg-card shadow-sm" data-testid="rare-block-card">
      <CardHeader className="pb-2 cursor-pointer select-none" onClick={() => setOpen(o => !o)}>
        <CardTitle className="text-sm flex items-center gap-2" data-testid="rare-block-toggle">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <Archive className="h-4 w-4 text-primary" />
          Einmalig / selten
          <span className="text-[11px] font-normal text-muted-foreground">Jahres-Nachträge · Jahresabschluss · Budget · Stammdaten</span>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="pt-0">
          {/* Jahres-Importe (Jahr-Dropdown in den Sektionen) */}
          <div className="text-[11px] font-medium text-muted-foreground mb-1">Jahres-Importe</div>
          <div className="divide-y divide-border/60">
            {jahresRows.map(r => (
              <div key={r.source} className="flex items-center gap-2.5 py-1.5" data-testid={`rare-row-${r.source}`}>
                <span className="text-xs font-medium flex-1 min-w-0 truncate">{r.label}</span>
                <ActionButton action={{ anchor: r.anchor }} label="Import" />
              </div>
            ))}
          </div>

          {/* Einmalig / Stammdaten */}
          <div className="mt-3 pt-2 border-t border-border/60">
            <div className="text-[11px] font-medium text-muted-foreground mb-1">Einmalig / Stammdaten</div>
            <div className="divide-y divide-border/60">
              {otherRows.map(r => (
                <div key={r.id} className="flex items-center gap-2.5 py-1.5" data-testid={`rare-row-${r.id}`}>
                  <span className="text-xs font-medium flex-1 min-w-0 truncate">{r.label}</span>
                  <ActionButton action={r.action} label="Öffnen" />
                </div>
              ))}
            </div>
          </div>

          {/* Selten / CRM */}
          <div className="mt-3 pt-2 border-t border-border/60" data-testid="rare-crm-block">
            <div className="text-[11px] font-medium text-muted-foreground mb-1">Selten / CRM</div>
            <div className="flex items-center gap-2.5 py-1.5" data-testid="rare-row-foratable-gaeste">
              <div className="flex-1 min-w-0">
                <span className="text-xs font-medium block truncate">Foratable Gästeexport (CRM)</span>
                <span className="text-[10px] text-muted-foreground block">
                  Befüllt das Gäste-CRM — KEINE Cockpit-Kennzahlen-Quelle (nicht der Reservations-Import)
                </span>
              </div>
              <ActionButton action={{ anchor: 'foratable-gaesteexport' }} label="Öffnen" />
            </div>
          </div>

          {/* ── Jahre abschliessen (festschreiben) ── */}
          <div className="mt-3 pt-2 border-t border-border/60" data-testid="year-close-block">
            <div className="text-[11px] font-medium text-muted-foreground mb-1">
              Jahre abschliessen — ein abgeschlossenes Jahr ist für ALLE Importe schreibgeschützt
            </div>
            <div className="divide-y divide-border/60">
              {lockYears.map(jahr => {
                const st = locks[jahr];
                const locked = !!st?.locked;
                return (
                  <div key={jahr} className="flex items-center gap-2.5 py-1.5" data-testid={`year-close-row-${jahr}`}>
                    <span className="text-xs font-medium w-12">{jahr}</span>
                    {locked ? (
                      <Badge
                        variant="outline"
                        className="h-5 px-1.5 text-[10px] gap-1 border-amber-400 text-amber-700 dark:text-amber-300"
                        data-testid={`year-close-badge-${jahr}`}
                      >
                        <Lock className="h-2.5 w-2.5" />
                        festgeschrieben{st?.lockedAt ? ` · ${formatLockedAt(st.lockedAt)}` : ''}
                      </Badge>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">offen</span>
                    )}
                    <span className="flex-1" />
                    {darfAbschliessen && (
                      <Button
                        size="sm" variant="outline"
                        className="h-7 px-2.5 text-[11px]"
                        disabled={busyYear === jahr || !st}
                        onClick={() => void toggleYear(jahr, locked)}
                        data-testid={`year-close-toggle-${jahr}`}
                      >
                        {busyYear === jahr
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : locked ? 'Entsperren' : 'Abschliessen'}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
