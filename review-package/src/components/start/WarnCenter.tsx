/**
 * WarnCenter — Risiken-Sektion des Executive Cockpits (Startseite).
 * =================================================================
 * REINE Anzeige der Warnliste aus buildExecutiveWarnings (bestehende
 * Status- und Schwellenregeln, KEINE eigene Statuslogik hier). Rot vor
 * orange; grüner Sammelzustand, wenn keine Warnung vorliegt.
 * Gast-Sessions sehen die Texte, aber keine Links auf gesperrte Flächen.
 */

import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { TONE_DOT } from '@/components/ui/tones';
import type { ExecutiveWarningsResult } from '@/lib/executive-warnings';
import { cn } from '@/lib/utils';

export function WarnCenter({
  result,
}: {
  /** Warnliste aus buildExecutiveWarnings — null solange nicht geladen. */
  result: ExecutiveWarningsResult | null;
}) {
  return (
    <section aria-labelledby="cockpit-risiken" className="space-y-2" data-testid="warncenter">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="cockpit-risiken" className="text-base font-semibold">
          Risiken
        </h2>
        {result !== null && !result.allGood && (
          <span className="text-[11px] text-muted-foreground">
            {result.criticalCount} kritisch · {result.warnCount} Achtung
          </span>
        )}
      </div>

      {result === null && (
        <p className="text-sm text-muted-foreground">Risiken erscheinen nach dem Laden.</p>
      )}

      {result !== null && result.allGood && (
        <div
          data-testid="warncenter-allgood"
          className="flex items-center gap-2 rounded-lg border p-3 text-sm text-muted-foreground"
        >
          <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
          Keine Warnungen — alle überwachten Bereiche sind im grünen Bereich.
        </div>
      )}

      {result !== null && !result.allGood && (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y">
              {result.warnings.map(w => {
                const rowClass =
                  'flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-sm';
                const content = (
                  <>
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          'h-2 w-2 rounded-full flex-shrink-0',
                          TONE_DOT[w.tone === 'critical' ? 'critical' : 'warn'],
                        )}
                      />
                      <span className="min-w-0">{w.text}</span>
                    </span>
                    {w.route && (
                      <ArrowRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    )}
                  </>
                );
                return (
                  <li key={w.id} data-testid={`warncenter-item-${w.id}`}>
                    {w.route ? (
                      <Link
                        to={w.route}
                        className={cn(
                          rowClass,
                          'transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                        )}
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
      )}
    </section>
  );
}
