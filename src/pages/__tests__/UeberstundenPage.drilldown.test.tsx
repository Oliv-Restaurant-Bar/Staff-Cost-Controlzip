// @vitest-environment happy-dom
/**
 * Überstunden-Matrix: KW→Tage-Drilldown + Kosten-Umschalter (reiner UI-Test,
 * Daten-Layer gemockt). Deckt ab: Kosten-Spalte standardmässig verborgen und
 * per «Kosten anzeigen» einblendbar (Wochen- UND Drilldown-Ansicht), Klick auf
 * KW-Kopf → 7-Tage-Ansicht mit Titel/Zurück/Absenz-Code/Tages-Total,
 * nicht zählende Tage und fehlende MA-Wochen bleiben leer,
 * MA-Klick → Kosten-Herleitungszeile.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// WICHTIG: stabile Referenzen — neue Funktions-Identitäten pro Render würden
// den reload-Effect der Seite endlos feuern (Render-Loop → OOM im Test).
const tenantStub = { tenantId: 'oliv', tenantKey: (k: string) => k };
vi.mock('@/contexts/TenantContext', () => ({ useTenant: () => tenantStub }));
const toastStub = { toast: vi.fn() };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastStub }));
vi.mock('@/lib/mirus-open-hours-store', () => ({
  fetchOpenParkedEntries: vi.fn(async () => []),
}));

const tage1 = [
  { datum: '2026-08-03', zaehlt: true, arbeitH: 9, absenzTyp: null, gutschrift: null, soll: 8.4 },
  { datum: '2026-08-04', zaehlt: true, arbeitH: 0, absenzTyp: 'ferien', gutschrift: 8.4, soll: 8.4 },
  { datum: '2026-08-05', zaehlt: true, arbeitH: 8.4, absenzTyp: null, gutschrift: null, soll: 8.4 },
  { datum: '2026-08-06', zaehlt: true, arbeitH: 8.4, absenzTyp: null, gutschrift: null, soll: 8.4 },
  { datum: '2026-08-07', zaehlt: false, arbeitH: null, absenzTyp: null, gutschrift: null, soll: null },
  { datum: '2026-08-08', zaehlt: true, arbeitH: 0, absenzTyp: null, gutschrift: null, soll: 0 },
  { datum: '2026-08-09', zaehlt: true, arbeitH: 0, absenzTyp: null, gutschrift: null, soll: 0 },
];
const woche1 = {
  label: 'KW 32', kw: 32, kwYear: 2026, monday: '2026-08-03',
  soll: 42, ist: 34.2, saldo: -7.8, gutschrift: 8.4, hasData: true, tage: tage1,
};
const mkEmp = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, wochenSollH: 42, wochen: [woche1],
  monatsSaldo: Array.from({ length: 12 }, () => null),
  laufend: 5, ohneEintritt: false, stundensatz: 40, kosten: 200, ...extra,
});
const daten = {
  ergebnis: {
    mitarbeiter: [
      mkEmp('e1', 'Anna Muster'),
      // e2 hat KEINE Woche zur Drill-KW (Edge: fehlende MA-Woche → «–»)
      mkEmp('e2', 'Beat Ohne', { wochen: [], laufend: null, stundensatz: null, kosten: null }),
    ],
    totalLaufend: 5, totalKosten: 200,
  },
  wochenMitDaten: new Set(['2026-08-03']),
  fixEmployees: [],
  absenzen: { year: 2026, entries: {}, updatedAt: 'u1' },
  tageMitDaten: new Set(['2026-08-03']),
};

vi.mock('@/lib/ueberstunden', () => ({
  ladeUeberstundenJahr: vi.fn(async () => daten),
  ladeUeAbsenzenStrict: vi.fn(async () => daten.absenzen),
  speichereUeAbsenzen: vi.fn(async () => undefined),
  UeAbsenzenKonflikt: class extends Error {},
  UE_ABSENZ_LABELS: { ferien: 'Ferien', krank: 'Krank', unfall: 'Unfall', frei: 'Frei' },
  UEBERSTUNDEN_START: '2026-07-01',
  VOLLZEIT_WOCHE_H: 42,
}));

import UeberstundenPage from '@/pages/UeberstundenPage';

beforeEach(() => { cleanup(); });

async function renderPage() {
  render(<UeberstundenPage />);
  await waitFor(() => expect(screen.getByTestId('row-emp-e1')).toBeTruthy());
}

describe('Überstunden: Kosten-Umschalter', () => {
  it('Kosten-Spalte ist standardmässig verborgen und wird per Toggle eingeblendet', async () => {
    await renderPage();
    expect(screen.queryByTestId('kosten-e1')).toBeNull();
    expect(screen.queryByText('ÜStd-Kosten')).toBeNull();
    fireEvent.click(screen.getByTestId('button-kosten-toggle'));
    expect(screen.getByTestId('kosten-e1').textContent).toContain('200.00');
    expect(screen.getByTestId('text-total-kosten').textContent).toContain('200.00');
    fireEvent.click(screen.getByTestId('button-kosten-toggle'));
    expect(screen.queryByTestId('kosten-e1')).toBeNull();
  });
});

describe('Überstunden: KW→Tage-Drilldown', () => {
  it('KW-Kopf-Klick zeigt die 7 Tage, Titel, Absenz-Code, Total und Zurück', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('kw-kopf-2026-08-03'));
    // Titel «KW 32 · 03.–09.08.»
    expect(screen.getByTestId('text-drill-titel').textContent).toContain('KW 32');
    expect(screen.getByTestId('text-drill-titel').textContent).toContain('03.–09.08.');
    // Tageszelle Mo: Ist 9.0, Saldo +0.6; Di: Absenz-Code FE
    expect(screen.getByTestId('drill-e1-2026-08-03').textContent).toContain('9.0');
    expect(screen.getByTestId('drill-e1-2026-08-04').textContent).toContain('FE');
    // Fr zählt nicht → «–»; e2 ohne Woche → alle Tage «–»
    expect(screen.getByTestId('drill-e1-2026-08-07').textContent).toBe('–');
    expect(screen.getByTestId('drill-e2-2026-08-03').textContent).toBe('–');
    // Total-Zeile: Mo = 9.0 − 8.4 = 0.6 (nur e1 zählt)
    expect(screen.getByTestId('drill-total-2026-08-03').textContent).toContain('0.6');
    expect(screen.getByTestId('drill-total-2026-08-07').textContent).toBe('–');
    // Kosten-Spalte auch im Drilldown erst nach Toggle
    expect(screen.queryByTestId('drill-kosten-e1')).toBeNull();
    fireEvent.click(screen.getByTestId('button-kosten-toggle'));
    expect(screen.getByTestId('drill-kosten-e1').textContent).toContain('200.00');
    // Zurück → Wochen-Übersicht
    fireEvent.click(screen.getByTestId('button-drill-zurueck'));
    expect(screen.queryByTestId('text-drill-titel')).toBeNull();
    expect(screen.getByTestId('kw-kopf-2026-08-03')).toBeTruthy();
  });
});

describe('Überstunden: Kosten-Herleitung je MA', () => {
  it('MA-Klick zeigt Satz × anrechenbare Stunden = Betrag; ohne Satz erklärender Text', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('row-emp-e1'));
    const h1 = screen.getByTestId('text-kosten-herleitung').textContent ?? '';
    expect(h1).toContain('40.00 CHF/h');
    expect(h1).toContain('5.0 h');
    expect(h1).toContain('200.00 CHF');
    fireEvent.click(screen.getByTestId('row-emp-e2'));
    expect(screen.getByTestId('text-kosten-herleitung').textContent).toContain('kein AG-Stundensatz');
  });
});
