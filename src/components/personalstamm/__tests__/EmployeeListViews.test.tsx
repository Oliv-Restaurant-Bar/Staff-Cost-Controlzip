// @vitest-environment happy-dom
/**
 * EmployeeListViews — Tabelle, Kacheln, Kompaktliste (rein präsentational).
 *
 * Fixiert: (1) alle drei Ansichten rendern DIESELBEN Row-View-Models,
 * (2) ganze Zeile klickbar UND per Tastatur (Enter/Leertaste) bedienbar,
 * (3) Statusfarben grün/blau/grau je Status, (4) keine Löhne in der Liste,
 * (5) Eintritt «—» bleibt «—» (nie heutiges Datum).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmployeeTable, EmployeeTiles, EmployeeCompactList } from '../EmployeeListViews';
import type { EmployeeListRow } from '@/lib/personalstamm-list';

const rows: EmployeeListRow[] = [
  {
    id: 'a1', name: 'Anna Muster', department: 'service', deptLabel: 'Service',
    positionLabel: 'Chef de Service', employmentType: 'vollzeit', typeLabel: 'Vollzeit',
    eintrittIso: '2023-05-15', eintrittLabel: '15.05.2023', pensumLabel: '100 %',
    status: 'aktiv', statusLabel: 'Aktiv', hasContractFile: true,
  },
  {
    id: 'b2', name: 'Beat Beispiel', department: 'küche', deptLabel: 'Küche',
    positionLabel: '', employmentType: 'teilzeit', typeLabel: 'Teilzeit',
    eintrittIso: undefined, eintrittLabel: '—', pensumLabel: '—',
    status: 'ausgetreten', statusLabel: 'Ausgetreten', hasContractFile: false,
  },
  {
    id: 'c3', name: 'Carla Chef', department: 'service', deptLabel: 'Service',
    positionLabel: 'Service', employmentType: 'aushilfe', typeLabel: 'Aushilfe',
    eintrittIso: '2026-09-01', eintrittLabel: '01.09.2026', pensumLabel: '20 %',
    status: 'eintritt_geplant', statusLabel: 'Eintritt geplant', hasContractFile: false,
  },
];

describe('EmployeeTable', () => {
  it('rendert 7-Spalten-Kopf und alle Zeilen; keine Lohnspalte', () => {
    render(<EmployeeTable rows={rows} selectedId={null} onSelect={() => {}} />);
    for (const h of ['Mitarbeiter', 'Abteilung / Position', 'Anstellung', 'Eintritt', 'Pensum', 'Status']) {
      expect(screen.getByText(h)).toBeTruthy();
    }
    expect(screen.queryByText(/Lohn|CHF|Stundenlohn/)).toBeNull();
    expect(screen.getAllByTestId(/^employee-row-/)).toHaveLength(3);
    expect(screen.getByText('15.05.2023')).toBeTruthy();
    // fehlender Eintritt UND fehlendes Pensum bleiben «—» (nie heutiges Datum/100 %)
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('ganze Zeile klickbar + Enter/Leertaste', () => {
    const onSelect = vi.fn();
    render(<EmployeeTable rows={rows} selectedId={null} onSelect={onSelect} />);
    const row = screen.getByTestId('employee-row-a1');
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(screen.getByTestId('employee-row-b2'), { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect.mock.calls.map(c => c[0])).toEqual(['a1', 'a1', 'b2']);
    expect(row.getAttribute('tabindex')).toBe('0');
    expect(row.getAttribute('role')).toBe('button');
  });

  it('Statusfarben: grün=aktiv, blau=geplant, grau=ausgetreten', () => {
    render(<EmployeeTable rows={rows} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByTestId('status-a1').className).toContain('green');
    expect(screen.getByTestId('status-c3').className).toContain('blue');
    expect(screen.getByTestId('status-b2').className).toContain('slate');
  });
});

describe('EmployeeTiles', () => {
  it('rendert eine Kachel pro Row mit Status und Eintritt', () => {
    const onSelect = vi.fn();
    render(<EmployeeTiles rows={rows} selectedId="a1" onSelect={onSelect} />);
    expect(screen.getAllByTestId(/^employee-tile-/)).toHaveLength(3);
    fireEvent.click(screen.getByTestId('employee-tile-c3'));
    expect(onSelect).toHaveBeenCalledWith('c3');
    expect(screen.getByText(/01\.09\.2026/)).toBeTruthy();
  });
});

describe('EmployeeCompactList', () => {
  it('rendert kompakte Buttons mit Status-Badge', () => {
    const onSelect = vi.fn();
    render(<EmployeeCompactList rows={rows} selectedId="b2" onSelect={onSelect} />);
    expect(screen.getAllByTestId(/^employee-compact-[abc]\d$/)).toHaveLength(3);
    fireEvent.click(screen.getByTestId('employee-compact-b2'));
    expect(onSelect).toHaveBeenCalledWith('b2');
    expect(screen.getByTestId('status-b2').textContent).toBe('Ausgetreten');
  });
});
