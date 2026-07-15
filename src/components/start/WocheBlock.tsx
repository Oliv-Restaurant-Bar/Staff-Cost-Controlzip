/**
 * WocheBlock — «Diese Woche» im Executive Cockpit (Startseite).
 * =============================================================
 * REIN LESEND, nur BESTEHENDE Werte — keine neue Berechnung:
 *  - Wochenumsatz = Summe der erfassten Tagesumsätze (sumDailyRevenue,
 *    verbatim Dashboard-Logik) über Montag…heute. Keine erfassten Tage
 *    ⇒ «—» (fehlend ≠ 0, nie 0 erfinden).
 *  - Dienstplan-Stand = Detailtext der bestehenden Dienstplan-Statuskarte
 *    (buildStartOverview) — keine Zweitlogik.
 *  - Offene Importe = Anzahl offener/fehlerhafter Importtypen aus dem
 *    bestehenden Datenstand (summarizeTypeCompletion).
 */

import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

const DASH = '—';

function fmtCHF(v: number): string {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency',
    currency: 'CHF',
    maximumFractionDigits: 0,
  }).format(v);
}

export function WocheBlock({
  weekLabel,
  weekRevenue,
  dienstplanDetail,
  openImports,
  isGuest,
}: {
  /** Anzeige-Label, z. B. «KW 29 · 13.–19.07.». */
  weekLabel: string;
  /** Summe erfasster Tagesumsätze Mo…heute — null = keine erfassten Tage. */
  weekRevenue: number | null;
  /** Detailtext der Dienstplan-Statuskarte — null solange nicht geladen. */
  dienstplanDetail: string | null;
  /** Anzahl offener/fehlerhafter Importtypen — null = Datenstand unbekannt. */
  openImports: number | null;
  isGuest: boolean;
}) {
  const rows: Array<{ id: string; label: string; value: string; route: string | null }> = [
    {
      id: 'umsatz',
      label: 'Umsatz bisher (erfasste Tage)',
      value: weekRevenue === null ? DASH : fmtCHF(weekRevenue),
      route: '/tagesabschluesse',
    },
    {
      id: 'dienstplan',
      label: 'Dienstplan',
      value: dienstplanDetail ?? DASH,
      route: '/personal',
    },
    {
      id: 'importe',
      label: 'Offene Importe',
      value: openImports === null ? DASH : openImports === 0 ? 'Keine' : String(openImports),
      route: openImports !== null && openImports > 0 ? '/import' : null,
    },
  ];

  return (
    <section aria-labelledby="cockpit-woche" className="space-y-2" data-testid="woche-block">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="cockpit-woche" className="text-base font-semibold">
          Diese Woche
        </h2>
        <span className="text-[11px] text-muted-foreground">{weekLabel}</span>
      </div>
      <Card>
        <CardContent className="p-0">
          <ul className="divide-y">
            {rows.map(row => {
              const rowClass =
                'flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-sm';
              const content = (
                <>
                  <span className="text-muted-foreground">{row.label}</span>
                  <span className="flex items-center gap-2 font-medium tabular-nums">
                    {row.value}
                    {!isGuest && row.route && (
                      <ArrowRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    )}
                  </span>
                </>
              );
              return (
                <li key={row.id} data-testid={`woche-${row.id}`}>
                  {!isGuest && row.route ? (
                    <Link
                      to={row.route}
                      className={`${rowClass} transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset`}
                    >
                      {content}
                    </Link>
                  ) : (
                    <div className={rowClass}>{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
