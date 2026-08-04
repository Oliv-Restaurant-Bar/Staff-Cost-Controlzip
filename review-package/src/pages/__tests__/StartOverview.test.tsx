// @vitest-environment happy-dom
/**
 * Tests für das Executive Cockpit (StartOverview). Der Lade-Hook und der
 * Finanz-Kompositions-Hook werden gemockt (Fetch/Gating stecken im Hook bzw.
 * in der Route); die Registry-Werte werden über getFinancialMetricValues
 * kontrolliert gemockt (die Registry selbst hat eigene Tests).
 * Fixiert:
 *   - Bereiche: Finanzen (oben) / Heute / Risiken / Diese Woche / Datenstand /
 *     Als Nächstes / Schnellaktionen — keine „Warnungen"-Sektion, keine
 *     Monatsübersichts-Karte mehr
 *   - Finanzblock: 5 Kennzahlen IST/Budget/VJ/Abw. NUR aus der Registry;
 *     fehlend = «—», Berechnungsfehler = sichtbarer Leerzustand (nie operative
 *     Ersatzwerte)
 *   - Risiken: rot/orange NUR aus bestehenden Regeln (buildExecutiveWarnings)
 *   - «Als Nächstes»: max. 3 Aufgaben mit Deep-Link, positiver Leer-Zustand
 *   - Datenstand kompakt mit fehlenden Tagen; Teilfehler sichtbar, Karten bleiben
 *   - Gast-Sessions sehen keine schreib-orientierten Aktionen/Checklisten-Links
 *   - sichtbarer Fehlerzustand statt stiller Anzeige
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { format, startOfWeek } from 'date-fns';
import type { StartOverviewState } from '@/hooks/useStartOverview';
import type { PrioritizedTask, TypeCompletion } from '@/lib/import-tasks-priority';
import type { StartOverviewResult } from '@/lib/start-overview-utils';
import type { CockpitFinancials } from '@/hooks/useCockpitFinancials';
import type { FinancialMetricValues } from '@/lib/financial-metrics';

const mockState: { value: StartOverviewState } = { value: { status: 'loading' } };
const mockPerms = { isAdmin: true };

const EMPTY_VALUES: FinancialMetricValues = { actual: null, budget: null, priorYear: null };
/** Kontrollierbare Registry-Werte je Kennzahl (Default: alles fehlend). */
const mockMetricValues: { value: Record<string, FinancialMetricValues> } = { value: {} };

function defaultFin(): CockpitFinancials {
  return {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    financialInput: null,
    personnelRatioTarget: null,
    dailyBudgets: {},
  };
}
const mockFin: { value: CockpitFinancials } = { value: defaultFin() };

vi.mock('@/hooks/useStartOverview', () => ({
  useStartOverview: () => ({ state: mockState.value, refresh: vi.fn() }),
}));
vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => mockPerms,
}));
vi.mock('@/hooks/useCockpitFinancials', () => ({
  useCockpitFinancials: () => mockFin.value,
}));
// Personalisierungs-/Widget-Hooks: hier gemockt (IO steckt in den Hooks) —
// die Seite erhält Default-Prefs und leere Info-Widget-Daten («—», nie 0).
vi.mock('@/hooks/useStartPrefs', async () => {
  const { defaultStartPrefs } = await import('@/lib/start-prefs');
  return {
    START_PREFS_UPDATED_EVENT: 'start-prefs-updated',
    useStartPrefs: () => ({
      prefs: defaultStartPrefs(),
      canCustomize: true,
      savePrefs: vi.fn(),
    }),
  };
});
vi.mock('@/hooks/useHeuteWidgets', () => ({
  useHeuteWidgets: () => ({
    reservationenHeute: { data: null, error: null },
    personalausfaelle: { data: null, error: null },
    warenrechnungen: { data: null, error: null },
    kreditoren: { data: null, error: null },
    loading: false,
  }),
}));
// IO-Grenzen von useManagementKpis (Sektion rendert real): Tenant/Auth-Kontexte
// plus Supabase-Leser gemockt — keine Netzwerkzugriffe im Test.
vi.mock('@/contexts/TenantContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/contexts/TenantContext')>();
  return {
    ...actual,
    useTenant: () => ({
      tenantId: 'oliv' as const,
      tenant: actual.TENANTS.oliv,
      setTenant: vi.fn(),
      tenantKey: (key: string) => key,
      lockTenant: vi.fn(),
      unlockTenant: vi.fn(),
      tenantLocked: false,
      resetTenant: vi.fn(),
    }),
  };
});
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'test-user', email: 'test@example.com' } }),
}));
vi.mock('@/lib/gn-personen-db', () => ({
  getGuestsForPeriod: async () => null,
  getAvgReceiptForPeriod: async () => null,
}));
vi.mock('@/lib/kpi-comments-db', () => ({
  loadKpiCommentsLocal: () => ({}),
  loadKpiComments: async () => ({}),
  saveKpiComments: async () => {},
}));
vi.mock('@/lib/kpi-targets-db', () => ({
  loadKpiTargetsLocal: () => ({}),
  loadKpiTargets: async () => ({}),
  saveKpiTargets: async () => {},
}));
vi.mock('@/lib/financial-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/financial-metrics')>();
  return {
    ...actual,
    getFinancialMetricValues: (id: string) => mockMetricValues.value[id] ?? EMPTY_VALUES,
    // Dependency-Gate hat eigene Unit-Tests — hier Pass-through auf die
    // kontrollierten Registry-Werte (interner Modul-Aufruf umgeht den Mock).
    getGatedFinancialMetricValues: (id: string) => mockMetricValues.value[id] ?? EMPTY_VALUES,
    getFinancialMetricMissingDependencies: () => [],
  };
});

import StartOverviewPage from '@/pages/StartOverview';
import { TooltipProvider } from '@/components/ui/tooltip';

const READY_OK: StartOverviewResult = {
  cards: [
    { id: 'umsatz', title: 'Umsatzimport', status: 'ok', statusLabel: 'Aktuell', detail: 'Aktuell – Ist-Daten bis 07.07.2026', route: '/gastronovi-import' },
    { id: 'reservationen', title: 'Reservationen', status: 'ok', statusLabel: 'Aktuell', detail: 'Aktuell – Ist-Daten bis 08.07.2026', route: '/foratable-import' },
    { id: 'dienstplan', title: 'Dienstplan', status: 'ok', statusLabel: 'Aktuell', detail: 'Geplant bis 20.07.2026', route: '/personal' },
    { id: 'tagesabschluss', title: 'Tagesabschluss', status: 'ok', statusLabel: 'Aktuell', detail: 'Gestern (07.07.2026) bestätigt', route: '/tagesabschluesse' },
  ],
  warnings: [],
};

const DONE_COMPLETIONS: TypeCompletion[] = [
  { type: 'zbericht', label: 'Z-Bericht', status: 'done', detail: null },
  { type: 'reservationen', label: 'Foratable / Reservationen', status: 'done', detail: null },
  { type: 'erfolgsrechnung', label: 'Erfolgsrechnung / Kontoblätter', status: 'later', detail: null },
];

const OPEN_TASK: PrioritizedTask = {
  task: {
    id: 'zbericht:2026-07-10',
    type: 'zbericht',
    frequency: 'daily',
    label: 'Z-Bericht 10.07.2026',
    from: '2026-07-10',
    to: '2026-07-10',
    status: 'open',
  },
  due: { urgency: 'overdue', dueLabel: '4 Tage überfällig', daysOverdue: 4 },
};

const OPEN_COMPLETIONS: TypeCompletion[] = [
  {
    type: 'zbericht',
    label: 'Z-Bericht',
    status: 'open',
    detail: '10.07.–12.07.2026',
    openRanges: [{ from: '2026-07-10', to: '2026-07-12' }],
    openDayCount: 3,
  },
  { type: 'reservationen', label: 'Foratable / Reservationen', status: 'done', detail: null },
];

function ready(over: Partial<Extract<StartOverviewState, { status: 'ready' }>> = {}): StartOverviewState {
  return {
    status: 'ready',
    data: READY_OK,
    todayTasks: [],
    typeCompletions: DONE_COMPLETIONS,
    coverageError: null,
    loadedAt: new Date(),
    ...over,
  };
}

function renderPage() {
  // KPI-Tabelle («Alle Management-KPIs») ist standardmässig eingeklappt —
  // für die Zeilen-Assertions aufgeklappt starten (persistierter Zustand).
  localStorage.setItem('mgmtKpiTableOpen', '1');
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <StartOverviewPage />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

/** Zahlvergleiche robust gegen de-CH-Gruppierung/NBSP (’ ' NBSP Leerraum). */
function digits(text: string | null | undefined): string {
  return (text ?? '').replace(/[\u2019'\u00A0\s]/g, '');
}

afterEach(() => {
  cleanup();
  mockState.value = { status: 'loading' };
  mockFin.value = defaultFin();
  mockMetricValues.value = {};
});

describe('StartOverview — Struktur (Executive Cockpit)', () => {
  it('zeigt die Cockpit-Bereiche Finanzen / Heute / Risiken / Diese Woche / Datenstand / Als Nächstes / Schnellaktionen', () => {
    mockState.value = ready();
    renderPage();
    expect(screen.getByRole('heading', { name: 'Management-KPIs' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Heute' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Risiken' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Diese Woche' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Datenstand' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Als Nächstes' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Schnellaktionen' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Warnungen' })).toBeNull();
    // Die frühere Monatsübersichts-Karte existiert auf der Startseite nicht mehr.
    expect(screen.queryByRole('heading', { name: 'Monatsübersicht' })).toBeNull();
  });

  it('rendert 4 Statuskarten mit deutschen Labels und Detailtext', () => {
    mockState.value = ready();
    renderPage();
    for (const id of ['umsatz', 'reservationen', 'dienstplan', 'tagesabschluss']) {
      expect(screen.getByTestId(`start-card-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId('start-card-dienstplan').textContent).toContain('Geplant bis 20.07.2026');
  });

  it('verlinkt auf das ausführliche Dashboard (/dashboard)', () => {
    mockState.value = ready();
    renderPage();
    const link = screen.getByRole('link', { name: /Ausführliches Dashboard/ });
    expect(link.getAttribute('href')).toBe('/dashboard');
  });
});

describe('StartOverview — Management-KPIs (NUR Registry)', () => {
  it('kein Registry-Input (financialInput=null) → P&L-KPIs überall «—», KEINE operativen Ersatzwerte', () => {
    mockState.value = ready();
    mockFin.value = { ...defaultFin(), financialInput: null };
    // Registry-Mock liefert Werte — sie DÜRFEN ohne financialInput nicht erscheinen.
    mockMetricValues.value = {
      net_revenue: { actual: 120000, budget: 110000, priorYear: 100000 },
    };
    renderPage();
    expect(screen.getByTestId('mgmt-kpi-umsatz-actual').textContent).toBe('—');
    expect(screen.getByTestId('mgmt-kpi-card-umsatz').textContent).toContain('—');
  });

  it('zeigt die 5 P&L-Kennzahlen mit IST/Budget/Abw. aus der Registry; fehlend = «—»', () => {
    mockState.value = ready();
    mockFin.value = {
      ...defaultFin(),
      financialInput: {} as CockpitFinancials['financialInput'],
    };
    mockMetricValues.value = {
      net_revenue: { actual: 120000, budget: 110000, priorYear: 100000 },
      cogs_ratio: { actual: 29.54, budget: 28, priorYear: null },
      ebit: { actual: null, budget: 5000, priorYear: null },
    };
    renderPage();
    for (const id of ['umsatz', 'warenquote', 'personalquote', 'ebitda', 'ebit']) {
      expect(screen.getByTestId(`mgmt-kpi-row-${id}`)).toBeTruthy();
    }
    // Beträge: IST aus der Registry; Abw. = IST − Budget in CHF (Zeilentext)
    expect(digits(screen.getByTestId('mgmt-kpi-umsatz-actual').textContent)).toContain('120000');
    expect(digits(screen.getByTestId('mgmt-kpi-row-umsatz').textContent)).toContain('+CHF10000');
    // Quoten: eine Nachkommastelle, Abw. in Prozentpunkten
    expect(screen.getByTestId('mgmt-kpi-warenquote-actual').textContent).toBe('29.5 %');
    expect(screen.getByTestId('mgmt-kpi-row-warenquote').textContent).toContain('+1.5 pp');
    // IST fehlt ⇒ «—» (fehlend ≠ 0); Kennzahl ganz ohne Werte bleibt «—»
    expect(screen.getByTestId('mgmt-kpi-ebit-actual').textContent).toBe('—');
    expect(screen.getByTestId('mgmt-kpi-ebitda-actual').textContent).toBe('—');
  });

  it('Drilldown-Links: Monat als ?monat=; Gäste-CRM bleibt verlinkt', () => {
    mockState.value = ready();
    mockFin.value = { ...defaultFin(), financialInput: {} as CockpitFinancials['financialInput'] };
    renderPage();
    const monat = format(new Date(), 'yyyy-MM');
    const umsatzLink = screen.getByTestId('mgmt-kpi-row-umsatz').querySelector('a');
    expect(umsatzLink!.getAttribute('href')).toBe(`/erfolgsrechnung?monat=${monat}`);
    expect(screen.getByTestId('mgmt-kpi-row-gaeste').querySelector('a')).toBeTruthy();
  });
});

describe('StartOverview — Risiken (Warncenter)', () => {
  it('alles im grünen Bereich → positiver Sammelzustand', () => {
    mockState.value = ready();
    renderPage();
    expect(screen.getByTestId('warncenter-allgood')).toBeTruthy();
  });

  it('action-Karte → roter Eintrag mit Deep-Link (bestehende Regel)', () => {
    mockState.value = ready({
      data: {
        ...READY_OK,
        cards: READY_OK.cards.map((c) =>
          c.id === 'tagesabschluss'
            ? { ...c, status: 'action' as const, statusLabel: 'Handeln', detail: 'Gestern nicht bestätigt' }
            : c,
        ),
      },
    });
    renderPage();
    const item = screen.getByTestId('warncenter-item-card-tagesabschluss');
    expect(item.textContent).toContain('Tagesabschluss: Gestern nicht bestätigt');
    expect(item.querySelector('a')!.getAttribute('href')).toBe('/tagesabschluesse');
    expect(screen.queryByTestId('warncenter-allgood')).toBeNull();
  });

  it('Registry-Warenquote über Schwelle → Warnung aus bestehender Ampel (warenPctTone)', () => {
    mockState.value = ready();
    mockFin.value = { ...defaultFin(), financialInput: {} as CockpitFinancials['financialInput'] };
    mockMetricValues.value = { cogs_ratio: { actual: 34.2, budget: null, priorYear: null } };
    renderPage();
    expect(screen.getByTestId('warncenter-item-kpi-warenquote').textContent).toContain('Warenquote 34.2 %');
  });

  it('offener Import → oranger Eintrag mit Link', () => {
    mockState.value = ready({ todayTasks: [OPEN_TASK], typeCompletions: OPEN_COMPLETIONS });
    renderPage();
    const item = screen.getByTestId('warncenter-item-import-zbericht');
    expect(item.textContent).toContain('Z-Bericht');
    expect(item.querySelector('a')).toBeTruthy();
  });
});

describe('StartOverview — Diese Woche', () => {
  it('keine erfassten Tagesumsätze → «—» (fehlend ≠ 0), offene Importe = Keine', () => {
    mockState.value = ready();
    renderPage();
    expect(screen.getByTestId('woche-umsatz').textContent).toContain('—');
    expect(screen.getByTestId('woche-importe').textContent).toContain('Keine');
    expect(screen.getByTestId('woche-dienstplan').textContent).toContain('Geplant bis 20.07.2026');
  });

  it('summiert NUR erfasste Tageswerte der laufenden Woche (Mo…heute)', () => {
    const monday = format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd');
    const today = format(new Date(), 'yyyy-MM-dd');
    mockState.value = ready({ todayTasks: [OPEN_TASK], typeCompletions: OPEN_COMPLETIONS });
    mockFin.value = {
      ...defaultFin(),
      dailyBudgets: {
        [monday]: { actualRevenue: 4000 } as never,
        [today]: { actualRevenue: 2500 } as never,
        '2020-01-01': { actualRevenue: 99999 } as never, // ausserhalb der Woche — zählt nie
      },
    };
    renderPage();
    expect(digits(screen.getByTestId('woche-umsatz').textContent)).toContain(monday === today ? '2500' : '6500');
    // offene Importe aus dem Datenstand (1 offener Typ)
    expect(screen.getByTestId('woche-importe').textContent).toContain('1');
  });
});

describe('StartOverview — Als Nächstes', () => {
  it('(4) keine fälligen Aufgaben → positiver Leer-Zustand', () => {
    mockState.value = ready();
    renderPage();
    expect(screen.getByTestId('start-next-empty').textContent).toContain('keine dringenden Aufgaben');
    expect(screen.queryByTestId('start-next-actions')).toBeNull();
  });

  it('(5) offene Aufgabe → Zeile mit Titel, Begründung, Urgenz-Badge und Deep-Link', () => {
    mockState.value = ready({ todayTasks: [OPEN_TASK], typeCompletions: OPEN_COMPLETIONS });
    renderPage();
    const row = screen.getByTestId('start-next-task-zbericht');
    expect(row.textContent).toContain('Z-Bericht importieren');
    expect(row.textContent).toContain('Fehlend: 10.–12.07.');
    expect(row.textContent).toContain('4 Tage überfällig');
    const link = row.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/gastronovi-import?from=2026-07-10&to=2026-07-10&scope=day');
    expect(screen.queryByTestId('start-next-empty')).toBeNull();
  });
});

describe('StartOverview — Datenstand', () => {
  it('zeigt kompakte Zeilen pro Importtyp inkl. fehlender Tage', () => {
    mockState.value = ready({ todayTasks: [OPEN_TASK], typeCompletions: OPEN_COMPLETIONS });
    renderPage();
    expect(screen.getByTestId('start-datenstand-zbericht').textContent).toContain('Fehlend: 10.–12.07.');
    expect(screen.getByTestId('start-datenstand-reservationen').textContent).toContain('Vollständig');
  });

  it('(13) monatlicher Typ im laufenden Monat → „Noch nicht fällig" (Monatsstatus)', () => {
    mockState.value = ready();
    renderPage();
    expect(screen.getByTestId('start-datenstand-erfolgsrechnung').textContent).toContain('Noch nicht fällig');
  });

  it('Admin sieht den Link zur Import-Checkliste', () => {
    mockState.value = ready();
    renderPage();
    expect(screen.getByRole('link', { name: /Import-Checkliste öffnen/ })).toBeTruthy();
  });

  it('(14) Teilfehler: coverageError → sichtbarer Hinweis mit Retry, Karten bleiben, roter Risiken-Eintrag', () => {
    mockState.value = ready({ todayTasks: null, typeCompletions: null, coverageError: 'Netzwerkfehler' });
    renderPage();
    expect(screen.getByTestId('start-coverage-error').textContent).toContain('konnten nicht geladen werden');
    expect(screen.getByTestId('start-card-umsatz')).toBeTruthy();
    expect(screen.queryByTestId('start-datenstand')).toBeNull();
    expect(screen.queryByTestId('start-next-empty')).toBeNull();
    // Coverage-Fehler erscheint auch im Warncenter — nie stilles Grün
    expect(screen.getByTestId('warncenter-item-coverage-error')).toBeTruthy();
  });
});

describe('StartOverview — Zustände', () => {
  it('loading → sichtbarer Ladezustand', () => {
    mockState.value = { status: 'loading' };
    renderPage();
    expect(screen.getByTestId('start-loading')).toBeTruthy();
  });

  it('error → sichtbare Fehlermeldung mit Retry (kein stiller Fallback)', () => {
    mockState.value = { status: 'error', message: 'Netzwerkfehler' };
    renderPage();
    expect(screen.getByTestId('start-error').textContent).toContain('Netzwerkfehler');
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeTruthy();
  });
});

describe('StartOverview — Schnellaktionen', () => {
  it('Admin sieht alle 4 Schnellaktionen', () => {
    mockState.value = ready();
    renderPage();
    const actions = screen.getByTestId('start-actions');
    expect(actions.textContent).toContain('Umsatz importieren');
    expect(actions.textContent).toContain('Tagesabschluss erfassen');
    expect(actions.textContent).toContain('Reservationen ansehen');
    expect(actions.textContent).toContain('Dienstplan öffnen');
  });
});
