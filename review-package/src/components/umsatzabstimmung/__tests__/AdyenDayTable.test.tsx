// @vitest-environment happy-dom
/**
 * AdyenDayTable.test.tsx — Komponententests für die Adyen-Abgleich-Tabelle.
 * (happy-dom statt jsdom: jsdom lädt das native `canvas`-Paket, das im
 * Replit-Container an fehlendem libuuid scheitert — happy-dom braucht es nicht.)
 * ==============================================================================
 * Prüft UI-Verhalten über die reine Logik hinaus:
 *   - Tageszeile zeigt Totale, Differenz und Status-Badges
 *   - Aufklappen zeigt den Zahlungsarten-Abgleich + Tagesbestätigung
 *   - „Tag bestätigen" bleibt gesperrt, bis Voraussetzungen erfüllt sind
 *   - Override-Werte werden markiert und mit Original ausgewiesen
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AdyenDayTable } from '../AdyenDayTable';
import {
  buildDayComparison,
  emptyAdyenBlob,
  makeFieldKey,
  setOverride,
  setDayConfirmation,
  type AdyenAbstimmungBlob,
  type AdyenStoredDay,
  type GnDayPayment,
} from '@/lib/adyen-abstimmung';

const DAY = '2026-06-01';

const GN: GnDayPayment[] = [
  { name: 'Mastercard', count: 3, amount: 254.6 },
  { name: 'TWINT', count: 2, amount: 40.0 },
  { name: 'Bar', count: 12, amount: 830.5 },
];

function storedDay(byMethod: Record<string, number>): AdyenStoredDay {
  return {
    byMethod,
    countByMethod: Object.fromEntries(Object.keys(byMethod).map(k => [k, 1])),
    total: Object.values(byMethod).reduce((s, v) => s + v, 0),
    transactionCount: Object.keys(byMethod).length,
    fileName: 'adyen.csv',
    importedAt: '2026-06-02T08:00:00.000Z',
  };
}

function blobWith(byMethod: Record<string, number>): AdyenAbstimmungBlob {
  const blob = emptyAdyenBlob();
  blob.days[DAY] = storedDay(byMethod);
  blob.methodLabels = { mastercard: 'Mastercard', twint: 'TWINT' };
  return blob;
}

function renderTable(blob: AdyenAbstimmungBlob, gn: GnDayPayment[] | null = GN) {
  const onOverride = vi.fn();
  const onComment = vi.fn();
  const onConfirm = vi.fn();
  const cmp = buildDayComparison(DAY, gn, blob.days[DAY] ?? null, blob);
  render(
    <AdyenDayTable
      days={[cmp]}
      disabled={false}
      onOverride={onOverride}
      onComment={onComment}
      onConfirm={onConfirm}
    />,
  );
  return { onOverride, onComment, onConfirm };
}

describe('AdyenDayTable', () => {
  it('zeigt Tageszeile mit Totalen und Differenz, Detail erst nach Aufklappen', () => {
    renderTable(blobWith({ mastercard: 254.6, twint: 40.0 }));
    // Summenzeile (294.60 auf beiden Seiten):
    expect(screen.getAllByText('294.60').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Zahlungsarten-Abgleich')).toBeNull();

    fireEvent.click(screen.getByText(/01\.06\./));
    expect(screen.getByText('Zahlungsarten-Abgleich')).toBeTruthy();
    expect(screen.getByText('Mastercard')).toBeTruthy();
    expect(screen.getByText('TWINT')).toBeTruthy();
    // Nicht-Karten aus dem Z-Bericht:
    expect(screen.getByText('Weitere Zahlungsarten (Z-Bericht)')).toBeTruthy();
    expect(screen.getByText('Bar')).toBeTruthy();
  });

  it('sperrt „Tag bestätigen" bis Barbestand bestätigt ist und meldet Gründe', () => {
    const { onConfirm } = renderTable(blobWith({ mastercard: 254.6, twint: 40.0 }));
    fireEvent.click(screen.getByText(/01\.06\./));

    const btn = screen.getByRole('button', { name: /Tag bestätigen/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText('Barbestand nicht bestätigt')).toBeTruthy();

    // Barbestand-Checkbox persistiert eine unbestätigte Confirmation:
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onConfirm).toHaveBeenCalledWith(DAY, expect.objectContaining({ confirmed: false, cashCounted: true }));
  });

  it('blockiert Bestätigung bei ungeklärter Differenz', () => {
    renderTable(blobWith({ mastercard: 200.0, twint: 40.0 })); // MC-Diff 54.60 → rot
    fireEvent.click(screen.getByText(/01\.06\./));
    expect(screen.getByText(/Differenz ungeklärt/)).toBeTruthy();
    const btn = screen.getByRole('button', { name: /Tag bestätigen/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('zeigt Override mit gelber Markierung, Original und Badge', () => {
    let blob = blobWith({ mastercard: 200.0, twint: 40.0 });
    blob = setOverride(blob, makeFieldKey(DAY, 'adyen', 'mastercard'), 200, 254.6, 'Nachbuchung', '2026-06-02T09:00:00Z');
    renderTable(blob);
    expect(screen.getByText('manuell korrigiert')).toBeTruthy();

    fireEvent.click(screen.getByText(/01\.06\./));
    expect(screen.getByText('Original: CHF 200.00')).toBeTruthy();
  });

  it('bestätigter Tag zeigt Badge und „Bestätigung aufheben"', () => {
    let blob = blobWith({ mastercard: 254.6, twint: 40.0 });
    blob = setDayConfirmation(blob, DAY, {
      confirmed: true, cashCounted: true, confirmedAt: '2026-06-02T09:00:00Z', comment: 'Alles geprüft',
    });
    const { onConfirm } = renderTable(blob);
    expect(screen.getByText('bestätigt')).toBeTruthy();

    fireEvent.click(screen.getByText(/01\.06\./));
    expect(screen.getByText(/„Alles geprüft"/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Bestätigung aufheben/ }));
    expect(onConfirm).toHaveBeenCalledWith(DAY, expect.objectContaining({ confirmed: false, cashCounted: true }));
  });

  it('Tag ohne Z-Bericht zeigt Hinweis und blockiert Bestätigung', () => {
    renderTable(blobWith({ mastercard: 100 }), null);
    expect(screen.getByText('kein Z-Bericht')).toBeTruthy();
    fireEvent.click(screen.getByText(/01\.06\./));
    expect(screen.getByText('Z-Bericht fehlt')).toBeTruthy();
  });
});
