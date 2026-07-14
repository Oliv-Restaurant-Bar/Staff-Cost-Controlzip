/**
 * ZahlungsartenBreakdown.tsx — kompakte Aufschlüsselung von Zahlungsarten
 * (Zahlungsart links, Betrag rechts, Total fett unten).
 * ===========================================================================
 * GEMEINSAMER Renderer für das KK-Popover, das KK-Adyen-Popover UND das
 * Tagesdetail — bewusst kein zweiter Renderer. Weicht das übergebene Total
 * von der Summe der Posten ab (manuelle Korrektur/Override), erscheint
 * automatisch ein Posten „Korrektur (manuell)", damit das angezeigte Total
 * immer der Spalte der Übersicht entspricht.
 */

import type { ZahlungsartPosten } from '@/lib/tagesabschluss';
import { fmtChf } from './adyen-ui';

interface ZahlungsartenBreakdownProps {
  items: ZahlungsartPosten[];
  /** Angezeigtes Total (z. B. effektiver KK-Wert der Übersicht). */
  total: number;
  totalLabel: string;
  /** Hinweistext unterhalb der Liste (z. B. Adyen-Erklärung). */
  hinweis?: string;
  /** Zusätzliche Sektion „Nicht über Adyen" (nur KK-Adyen-Popover). */
  nichtAdyen?: ZahlungsartPosten[];
  /** Präfix für data-testids (z. B. `ta-kk-breakdown`). */
  testidPrefix: string;
}

const amountClass = (v: number): string =>
  `tabular-nums ${v < 0 ? 'text-red-600 dark:text-red-400 font-medium' : ''}`;

export function ZahlungsartenBreakdown({
  items, total, totalLabel, hinweis, nichtAdyen, testidPrefix,
}: ZahlungsartenBreakdownProps) {
  const sum = Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  const korrektur = Math.round((total - sum) * 100) / 100;
  const hasKorrektur = Math.abs(korrektur) >= 0.005;

  return (
    <div className="space-y-1 text-xs" data-testid={testidPrefix}>
      <div className="space-y-0.5">
        {items.map(z => (
          <div key={z.key} className="flex justify-between gap-6">
            <span className="text-muted-foreground">{z.label}</span>
            <span className={amountClass(z.amount)} data-testid={`${testidPrefix}-${z.key}`}>
              {fmtChf(z.amount)}
            </span>
          </div>
        ))}
        {hasKorrektur && (
          <div className="flex justify-between gap-6">
            <span className="text-muted-foreground">Korrektur (manuell)</span>
            <span className={amountClass(korrektur)} data-testid={`${testidPrefix}-korrektur`}>
              {fmtChf(korrektur)}
            </span>
          </div>
        )}
      </div>
      <div className="flex justify-between gap-6 border-t border-border pt-1 font-bold">
        <span>{totalLabel}</span>
        <span className={amountClass(total)} data-testid={`${testidPrefix}-total`}>{fmtChf(total)}</span>
      </div>
      {nichtAdyen && nichtAdyen.length > 0 && (
        <div className="border-t border-border pt-1 space-y-0.5" data-testid={`${testidPrefix}-nicht-adyen`}>
          <p className="font-semibold text-muted-foreground">Nicht über Adyen:</p>
          {nichtAdyen.map(z => (
            <div key={z.key} className="flex justify-between gap-6">
              <span className="text-muted-foreground">{z.label}</span>
              <span className={amountClass(z.amount)} data-testid={`${testidPrefix}-nicht-adyen-${z.key}`}>
                {fmtChf(z.amount)}
              </span>
            </div>
          ))}
        </div>
      )}
      {hinweis && (
        <p className="border-t border-border pt-1 text-[10px] text-muted-foreground max-w-[240px]"
          data-testid={`${testidPrefix}-hinweis`}>
          {hinweis}
        </p>
      )}
    </div>
  );
}

/** Fester Hinweistext des KK-Adyen-Popovers (auch im Tagesdetail verwendet). */
export const ADYEN_HINWEIS =
  'Hinweis: KK Adyen enthält nur Zahlungsarten, die über Adyen verarbeitet werden. '
  + 'PostCard, Lunch-Check, Stripe und weitere nicht über Adyen abgewickelte '
  + 'Zahlungsarten werden hier bewusst nicht berücksichtigt.';
