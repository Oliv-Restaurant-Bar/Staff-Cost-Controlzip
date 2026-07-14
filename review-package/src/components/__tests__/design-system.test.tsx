// @vitest-environment happy-dom
/**
 * Tests für die Design-System-Bausteine (Phase 3.1):
 * StatusPill, KpiCard/KpiGrid/MoreKpis, HintBox, LoadingState/EmptyState,
 * PageHeader/PageShell, InfoTip.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { BarChart2 } from 'lucide-react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { StatusPill } from '@/components/ui/status-pill';
import { KpiCard, KpiGrid, MoreKpis } from '@/components/ui/kpi-card';
import { HintBox } from '@/components/ui/hint-box';
import { LoadingState, EmptyState } from '@/components/ui/page-states';
import { InfoTip } from '@/components/ui/info-tip';
import { PageShell, PAGE_WIDTH } from '@/components/layout/PageShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { TONE_DOT, TONE_PILL } from '@/components/ui/tones';

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

describe('StatusPill', () => {
  it('rendert Label mit Ton-Klassen', () => {
    const { container } = render(<StatusPill tone="good">Optimal</StatusPill>);
    expect(screen.getByText('Optimal')).toBeTruthy();
    const pill = container.querySelector('span');
    expect(pill?.className).toContain('rounded-full');
    for (const cls of TONE_PILL.good.split(' ')) {
      expect(pill?.className).toContain(cls);
    }
  });

  it('zeigt kritischen Ton mit rotem Punkt', () => {
    const { container } = render(<StatusPill tone="critical">Fehler</StatusPill>);
    const dot = container.querySelector(`.${TONE_DOT.critical.replace(/\//g, '\\/')}`);
    expect(dot).toBeTruthy();
  });
});

describe('KpiCard', () => {
  it('rendert Label, Wert und Sub-Zeile', () => {
    render(<KpiCard label="Nettoumsatz" value="CHF 12'345" sub="30 Tage" tone="good" />);
    expect(screen.getByText('Nettoumsatz')).toBeTruthy();
    expect(screen.getByText("CHF 12'345")).toBeTruthy();
    expect(screen.getByText('30 Tage')).toBeTruthy();
  });

  it('zeigt expliziten Trend mit Richtung und Ton', () => {
    render(
      <KpiCard
        label="Personalkosten"
        value="CHF 50'000"
        trend={{ direction: 'up', tone: 'critical', label: '+4.2 %' }}
      />,
    );
    expect(screen.getByText(/↑ \+4\.2 %/)).toBeTruthy();
  });
});

describe('KpiGrid', () => {
  it('rendert Kinder im 4er-Raster', () => {
    const { container } = render(
      <KpiGrid>
        <KpiCard label="A" value="1" />
        <KpiCard label="B" value="2" />
      </KpiGrid>,
    );
    expect(container.firstElementChild?.className).toContain('lg:grid-cols-4');
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
  });
});

describe('MoreKpis', () => {
  it('ist standardmässig zugeklappt und öffnet per Klick', () => {
    render(
      <MoreKpis>
        <div>Versteckter KPI</div>
      </MoreKpis>,
    );
    expect(screen.queryByText('Versteckter KPI')).toBeNull();
    fireEvent.click(screen.getByText('Weitere Kennzahlen'));
    expect(screen.getByText('Versteckter KPI')).toBeTruthy();
  });

  it('persistiert den Zustand unter storageKey', () => {
    render(
      <MoreKpis storageKey="test:moreKpis">
        <div>KPI-Inhalt</div>
      </MoreKpis>,
    );
    fireEvent.click(screen.getByText('Weitere Kennzahlen'));
    expect(localStorage.getItem('test:moreKpis')).toBe('1');

    cleanup();
    render(
      <MoreKpis storageKey="test:moreKpis">
        <div>KPI-Inhalt</div>
      </MoreKpis>,
    );
    expect(screen.getByText('KPI-Inhalt')).toBeTruthy();
  });
});

describe('HintBox', () => {
  it('rendert Titel und Inhalt mit warn-Ton als status', () => {
    render(
      <HintBox tone="warn" title="Achtung">
        Anfangsbestand fehlt.
      </HintBox>,
    );
    const box = screen.getByRole('status');
    expect(box.textContent).toContain('Achtung');
    expect(box.textContent).toContain('Anfangsbestand fehlt.');
  });

  it('nutzt role=alert bei kritischem Ton', () => {
    render(<HintBox tone="critical">Kritisch!</HintBox>);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('LoadingState / EmptyState', () => {
  it('LoadingState zeigt Label', () => {
    render(<LoadingState label="Lade Berichtsdaten…" />);
    expect(screen.getByText('Lade Berichtsdaten…')).toBeTruthy();
  });

  it('EmptyState zeigt Titel, Beschreibung und Aktion', () => {
    render(
      <EmptyState
        icon={BarChart2}
        title="Keine Daten"
        description="Zeitraum anpassen."
        action={<button>Neu laden</button>}
      />,
    );
    expect(screen.getByText('Keine Daten')).toBeTruthy();
    expect(screen.getByText('Zeitraum anpassen.')).toBeTruthy();
    expect(screen.getByText('Neu laden')).toBeTruthy();
  });
});

describe('PageShell / PageHeader', () => {
  it('PageShell rendert Header und Inhalt mit Standard-Breite', () => {
    const { container } = render(
      <PageShell header={<div>Kopf</div>}>
        <div>Inhalt</div>
      </PageShell>,
    );
    expect(screen.getByText('Kopf')).toBeTruthy();
    expect(screen.getByText('Inhalt')).toBeTruthy();
    const main = container.querySelector('main');
    expect(main?.className).toContain(PAGE_WIDTH.default);
  });

  it('PageHeader rendert Titel, Meta, Toolbar und Aktionen', () => {
    render(
      <TooltipProvider>
        <PageHeader
          icon={<BarChart2 />}
          title="Kennzahlen Bericht"
          info="Erklärung"
          meta="01.06.–30.06."
          actions={<button>PDF</button>}
        >
          <button>Umschalter</button>
        </PageHeader>
      </TooltipProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Kennzahlen Bericht' })).toBeTruthy();
    expect(screen.getByText('01.06.–30.06.')).toBeTruthy();
    expect(screen.getByText('Umschalter')).toBeTruthy();
    expect(screen.getByText('PDF')).toBeTruthy();
    expect(screen.getByLabelText('Info')).toBeTruthy();
  });
});

describe('InfoTip', () => {
  it('rendert einen fokussierbaren Info-Button', () => {
    render(
      <TooltipProvider>
        <InfoTip text="Erklärungstext" />
      </TooltipProvider>,
    );
    const btn = screen.getByLabelText('Info');
    expect(btn.tagName).toBe('BUTTON');
  });
});
