// @vitest-environment happy-dom
/**
 * TagesansichtPage × daily-actuals: IST-Werte kommen aus der Kombilogik
 * (dailyBudgets > vj_daily desselben Jahres > null). Fehlend = «—», nie 0;
 * echte 0 aus vj_daily bleibt sichtbar 0. Statusleiste trennt IST-Monat
 * (angezeigtes Jahr) von den Vergleichsdaten (Jahr − 1).
 * Daten-Layer vollständig gemockt — Render-/Wiring-Test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { de } from 'date-fns/locale';

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 'oliv', tenantKey: (k: string) => k }),
}));

vi.mock('@/contexts/RevenueDisplayContext', () => ({
  useRevenueDisplay: () => ({ showNetRevenue: false }),
}));

vi.mock('@/contexts/MaisonContext', () => ({
  useMaison: () => ({ showMarketingCol: false, maisonExclude: false, setMaisonExclude: vi.fn() }),
}));

vi.mock('@/hooks/useBudgetMonth', () => ({
  useBudgetMonth: () => ({ revenueBudget: 0 }),
}));

vi.mock('@/hooks/useVj2025Import', () => ({ useVj2025Import: () => {} }));
vi.mock('@/hooks/useVj2025BeaulieuImport', () => ({ useVj2025BeaulieuImport: () => {} }));

vi.mock('@/lib/reporting-store', () => ({
  loadMonth: vi.fn(() => ({})),
}));

vi.mock('@/lib/supabase-kv', () => ({
  kvGet: vi.fn(async () => null),
  kvSet: vi.fn(async () => {}),
  safeUpsertDailyBudgets: vi.fn(async () => ({})),
}));

vi.mock('@/lib/maison-store', () => ({
  getMaisonEnabledSync:  () => false,
  getMaisonMonthlySync:  () => ({}),
  getMaisonDailySync:    () => ({}),
  loadMaisonEnabled:     async () => false,
  loadMaisonMonthly:     async () => ({}),
  loadMaisonDaily:       async () => ({}),
  saveMaisonDaily:       async () => {},
}));

const loadVjDailyMonthMock = vi.fn(async (_y: number, _m: number, _t?: string) => ({} as Record<string, unknown>));
vi.mock('@/lib/vj-daily-supabase', () => ({
  loadVjDailyMonth: (y: number, m: number, t?: string) => loadVjDailyMonthMock(y, m, t),
}));

import TagesansichtPage from '@/pages/TagesansichtPage';

const today      = new Date();
const year       = today.getFullYear();
const totalDays  = endOfMonth(today).getDate();
const monthLabel = format(startOfMonth(today), 'MMMM yyyy', { locale: de });
const vjLabel    = format(new Date(year - 1, today.getMonth(), 1), 'MMMM yyyy', { locale: de });
const ym         = format(today, 'yyyy-MM');
const NUM        = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });

function vjRec(date: string, rev: number) {
  return { date, year, actualRevenue: rev, source: 'vorjahr_import' };
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  loadVjDailyMonthMock.mockReset();
  loadVjDailyMonthMock.mockResolvedValue({});
});

describe('TagesansichtPage — effektive Tages-IST (daily-actuals)', () => {
  it('IST kommt aus vj_daily desselben Jahres; echte 0 bleibt 0; VJ fehlt ⇒ «—»', async () => {
    loadVjDailyMonthMock.mockImplementation(async (y: number) => {
      if (y === year) {
        return {
          [`${ym}-01`]: vjRec(`${ym}-01`, 1000),
          [`${ym}-02`]: vjRec(`${ym}-02`, 0),       // Schliessungstag: echte 0
          [`${ym}-03`]: vjRec(`${ym}-03`, 2500),
        };
      }
      return {}; // Jahr − 1: keine Vergleichsdaten
    });

    render(<TagesansichtPage />);

    // IST-Statuszeile: bezieht sich auf den ANGEZEIGTEN Monat
    await waitFor(() => {
      expect(
        screen.getByText(`Umsatzdaten für ${monthLabel}: 3 von ${totalDays} Tagen vorhanden`),
      ).toBeTruthy();
    });
    expect(screen.getByText('· Quelle: Tagesumsatz-Jahresimport')).toBeTruthy();

    // VJ-Statuszeile: benennt explizit den Vergleichsmonat (Jahr − 1)
    expect(
      screen.getByText(`Keine Vergleichsdaten für ${vjLabel} importiert — Vorjahresvergleich nicht möglich`),
    ).toBeTruthy();

    // Tageswerte sichtbar: 1'000, 0 (echte 0), 2'500 — Kumuliert 3'500
    expect(screen.getAllByText(NUM.format(1000)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
    expect(screen.getAllByText(NUM.format(3500)).length).toBeGreaterThan(0);

    // VJ-Spalte zeigt «—» (nie 0) für fehlende Vergleichsdaten
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('keinerlei Daten ⇒ Statuszeile amber, Kumuliert «—», nirgends künstliche 0', async () => {
    render(<TagesansichtPage />);

    await waitFor(() => {
      expect(screen.getByText(`Keine Umsatzdaten für ${monthLabel} importiert`)).toBeTruthy();
    });
    expect(
      screen.getByText(`Keine Vergleichsdaten für ${vjLabel} importiert — Vorjahresvergleich nicht möglich`),
    ).toBeTruthy();

    // Kumulierte Spalten und Gesamtzeile zeigen «—», keine 0-Werte
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('0').length).toBe(0);
  });

  it('dailyBudgets-Blob (> 0) gewinnt über vj_daily desselben Jahres', async () => {
    localStorage.setItem('dailyBudgets', JSON.stringify({
      [`${ym}-01`]: { actualRevenue: 7777 },
    }));
    loadVjDailyMonthMock.mockImplementation(async (y: number) =>
      y === year ? { [`${ym}-01`]: vjRec(`${ym}-01`, 500) } : {},
    );

    render(<TagesansichtPage />);

    await waitFor(() => {
      expect(screen.getAllByText(NUM.format(7777)).length).toBeGreaterThan(0);
    });
    // Der vj_daily-Wert 500 darf NICHT als IST des Tages erscheinen
    expect(screen.queryAllByText(NUM.format(500)).length).toBe(0);

    // Statuszeile zählt den Tag genau einmal
    expect(
      screen.getByText(`Umsatzdaten für ${monthLabel}: 1 von ${totalDays} Tagen vorhanden`),
    ).toBeTruthy();
  });

  it('Statusleiste besitzt getrennte IST- und VJ-Zeilen (Meldungen nicht vermischt)', async () => {
    render(<TagesansichtPage />);
    await waitFor(() => expect(screen.getByTestId('status-ist')).toBeTruthy());
    const istBar = screen.getByTestId('status-ist');
    const vjBar  = screen.getByTestId('status-vj');
    expect(within(istBar).queryByText(new RegExp(vjLabel))).toBeNull();
    expect(within(vjBar).getByText(new RegExp(vjLabel))).toBeTruthy();
  });
});
