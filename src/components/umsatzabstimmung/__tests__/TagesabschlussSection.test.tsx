// @vitest-environment happy-dom
/**
 * TagesabschlussSection.test.tsx — kompakte UX der Monatsübersicht.
 * ==============================================================================
 * Prüft die UX-Verdichtung (keine Fachlogik — die liegt in lib/tagesabschluss):
 *   - Kompakte Toolbar: Monatsnav + „Heute" + Excel/Buchhaltung + „+ Tagesabschluss",
 *     Beschreibung nur noch als Info-Tooltip.
 *   - KPI-Chips (Abgeschlossen/Offen/Differenzen/Kassensaldo Ende) + Aufklapp-
 *     bereich „Weitere Kennzahlen" (Detail-KPIs inkl. Anfangsbestand-ändern).
 *   - Anfangsbestand-Warnung: eine Zeile + „Erfassen" klappt die Eingabe auf.
 * DB-Layer, Export und Dialoge sind gemockt; lib/tagesabschluss läuft echt.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { emptyTagesabschlussBlob } from '@/lib/tagesabschluss';
import { emptyAdyenBlob } from '@/lib/adyen-abstimmung';

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({ isAdmin: true, isGuest: false, isBeaulieuManager: false }),
}));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'admin@oliv.ch' } }),
}));
vi.mock('@/lib/tagesabschluss-db', () => ({
  loadTagesabschluss: vi.fn(async () => emptyTagesabschlussBlob()),
  saveTagesabschluss: vi.fn(async (_t: string, b: unknown) => b),
}));
vi.mock('@/lib/adyen-abstimmung-db', () => ({
  ADYEN_ABSTIMMUNG_UPDATED_EVENT: 'adyen-abstimmung-updated',
  loadAdyenAbstimmung: vi.fn(async () => emptyAdyenBlob()),
  loadAdyenAbstimmungLocal: vi.fn(() => emptyAdyenBlob()),
  saveAdyenAbstimmung: vi.fn(async (_t: string, b: unknown) => b),
}));
vi.mock('@/lib/gn-zbericht-db', () => ({
  loadGnDayClosingsForMonth: vi.fn(async () => ({})),
}));
vi.mock('@/lib/tagesabschluss-excel-export', () => ({
  exportTagesabschlussExcel: vi.fn(),
}));
vi.mock('../BuchhaltungsExportSection', () => ({
  BuchhaltungsExportSection: () => null,
}));
vi.mock('../TagesabschlussDayDialog', () => ({
  TagesabschlussDayDialog: ({ row }: { row: { date: string } | null }) =>
    row ? <div data-testid="mock-day-dialog">{row.date}</div> : null,
}));
vi.mock('../TagesabschlussExpenseDialog', () => ({ TagesabschlussExpenseDialog: () => null }));
vi.mock('../TagesabschlussExportDialog', () => ({ TagesabschlussExportDialog: () => null }));
vi.mock('../TagesabschlussReasonDialog', () => ({ TagesabschlussReasonDialog: () => null }));
vi.mock('../TagesabschlussOverrideDialog', () => ({ TagesabschlussOverrideDialog: () => null }));
vi.mock('../TagesabschlussVoucherDialog', () => ({ TagesabschlussVoucherDialog: () => null }));

import { TagesabschlussSection } from '../TagesabschlussSection';

afterEach(cleanup);

const YEAR = new Date().getFullYear();
const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

async function renderSection() {
  render(<TagesabschlussSection tenantId="oliv" year={YEAR} />);
  // Warten, bis die Blobs geladen sind (Lade-Hinweis verschwunden).
  await waitFor(() => expect(screen.queryByText('Lade Tagesabschlüsse…')).toBeNull());
}

describe('TagesabschlussSection — kompakte Toolbar', () => {
  it('zeigt Monatsnav mit „Heute", Exporte und „+ Tagesabschluss"; Beschreibung nur als Tooltip', async () => {
    await renderSection();
    expect(screen.getByTestId('ta-heute')).toBeInTheDocument();
    expect(screen.getByTestId('ta-export')).toBeInTheDocument();
    // Leerer Monat (Mock ohne Tagesdaten) → Export korrekt deaktiviert.
    expect(screen.getByTestId('ta-export')).toBeDisabled();
    expect(screen.getByTestId('ta-open-export')).toBeInTheDocument();
    expect(screen.getByTestId('ta-add-abschluss')).toBeInTheDocument();
    // Langer Erklärtext steht NICHT mehr im Fliesstext, nur im Info-Tooltip.
    expect(screen.queryByText(/Buchhaltungs-Export analog Excel/)).toBeNull();
    expect(screen.getByTestId('ta-section-info').getAttribute('title')).toMatch(/Tagesdetail/);
  });

  it('„Heute" ist im aktuellen Monat deaktiviert und springt nach Monatswechsel zurück', async () => {
    await renderSection();
    const now = new Date();
    expect(screen.getByTestId('ta-heute')).toBeDisabled();
    // Einen Monat zurück (im Januar vorwärts, dort ist „Vormonat" deaktiviert).
    const dir = now.getMonth() === 0 ? 'Folgemonat' : 'Vormonat';
    fireEvent.click(screen.getByLabelText(dir));
    expect(screen.getByTestId('ta-heute')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('ta-heute'));
    expect(screen.getByText(`${MONTH_NAMES[now.getMonth()]} ${YEAR}`)).toBeInTheDocument();
    expect(screen.getByTestId('ta-heute')).toBeDisabled();
  });

  it('„+ Tagesabschluss" öffnet das Tagesdetail für heute', async () => {
    await renderSection();
    fireEvent.click(screen.getByTestId('ta-add-abschluss'));
    const p = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    expect(screen.getByTestId('mock-day-dialog').textContent).toBe(
      `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`,
    );
  });
});

describe('TagesabschlussSection — KPI-Chips + „Weitere Kennzahlen"', () => {
  it('zeigt 4 Chips; Detail-KPIs erst nach Aufklappen (inkl. Anfangsbestand-ändern)', async () => {
    await renderSection();
    for (const id of ['ta-kpi-confirmed', 'ta-kpi-open', 'ta-kpi-diff', 'ta-kpi-saldo-ende']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    // Detail-KPIs standardmässig zu.
    expect(screen.queryByTestId('ta-kpi-more')).toBeNull();
    expect(screen.queryByTestId('ta-kpi-in-bearbeitung')).toBeNull();
    expect(screen.queryByTestId('ta-anfangsbestand-edit')).toBeNull();

    fireEvent.click(screen.getByTestId('ta-kpi-more-toggle'));
    expect(screen.getByTestId('ta-kpi-more')).toBeInTheDocument();
    for (const id of [
      'ta-kpi-in-bearbeitung', 'ta-kpi-wieder-geoeffnet', 'ta-kpi-begruendet',
      'ta-kpi-unbegruendet', 'ta-kpi-needs-review', 'ta-kpi-saldo-anfang',
      'ta-kpi-bargeld', 'ta-kpi-barausgaben', 'ta-kpi-einzahlung',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.getByTestId('ta-anfangsbestand-edit')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ta-kpi-more-toggle'));
    expect(screen.queryByTestId('ta-kpi-more')).toBeNull();
  });
});

describe('TagesabschlussSection — kompakte Anfangsbestand-Warnung', () => {
  it('eine Zeile + „Erfassen" klappt Eingabe auf; „Abbrechen" klappt zu', async () => {
    await renderSection();
    // Banner erscheint erst nach der (async) Kassensaldo-Anker-Auflösung.
    const banner = await screen.findByTestId('ta-anfangsbestand-banner');
    expect(banner.textContent).toContain('Anfangsbestand fehlt');
    // Kompakt: keine Eingabe sichtbar.
    expect(screen.queryByTestId('ta-anfangsbestand-input')).toBeNull();

    fireEvent.click(screen.getByTestId('ta-anfangsbestand-erfassen'));
    expect(screen.getByTestId('ta-anfangsbestand-input')).toBeInTheDocument();
    expect(screen.getByTestId('ta-anfangsbestand-save')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ta-anfangsbestand-cancel'));
    expect(screen.queryByTestId('ta-anfangsbestand-input')).toBeNull();
    expect(screen.getByTestId('ta-anfangsbestand-banner')).toBeInTheDocument();
  });
});
