// @vitest-environment happy-dom
/**
 * Veröffentlichen-Dialog: Nicht gespeicherte Änderungen blockieren das Veröffentlichen.
 *  - Mit hasUnsavedChanges: Warnhinweis sichtbar, Klick auf „veröffentlichen" ruft publishWeek NICHT auf.
 *  - „Jetzt speichern" ruft onSaveNow.
 *  - Ohne offene Änderungen: kein Hinweis, publishWeek wird aufgerufen.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const db = vi.hoisted(() => ({
  getShareToken: vi.fn(),
  getPublishedWeek: vi.fn(),
  publishWeek: vi.fn(),
  rotateShareToken: vi.fn(),
}));
vi.mock('@/lib/schedule-publish-db', () => db);

// Folgemonate lädt der Dialog selbst aus der DB — hier leer.
vi.mock('@/lib/supabase-db', () => ({ loadScheduleForMonth: vi.fn(async () => ({})) }));

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

// PDF-Erzeugung bleibt „hängen“, bis der Test sie freigibt.
const pdf = vi.hoisted(() => ({ release: null as null | (() => void), download: vi.fn() }));
vi.mock('@/lib/schedule-pdf', () => ({
  PDF_THEMES: { oliv: {} },
  downloadSchedulePdf: pdf.download,
}));

import { PublishScheduleDialog } from '../PublishScheduleDialog';

const DAYS = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 19 + i));

function renderDialog(over: { hasUnsavedChanges: boolean; onSaveNow?: () => Promise<boolean> }) {
  return render(
    <PublishScheduleDialog
      open
      onOpenChange={() => {}}
      tenantId="oliv"
      employees={[{ id: 'a', name: 'Anna', department: 'service' }]}
      scheduleData={{ 'a-2026-10-19': { früh: { start: '10:00', end: '16:00' } } }}
      displayDays={DAYS}
      plannerMonth="2026-10"
      allowedDepartments={['service']}
      hasUnsavedChanges={over.hasUnsavedChanges}
      onSaveNow={over.onSaveNow ?? (async () => true)}
    />,
  );
}

beforeEach(() => {
  cleanup();
  // Der Dialog beginnt bei der aktuellen Woche: Datum fest auf KW 43/2026 setzen.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 19, 9, 0));
  vi.clearAllMocks();
  db.getShareToken.mockResolvedValue('AbCdEfGhIjKl');
  db.getPublishedWeek.mockResolvedValue(null);
  db.publishWeek.mockResolvedValue(1);
});

async function clickPublish() {
  const btn = await screen.findByRole('button', { name: /Woche veröffentlichen/ });
  fireEvent.click(btn);
  return btn;
}

describe('PublishScheduleDialog – ungespeicherte Änderungen', () => {
  it('blockiert das Veröffentlichen und zeigt den Hinweis', async () => {
    renderDialog({ hasUnsavedChanges: true });

    expect(await screen.findByText('Es gibt nicht gespeicherte Änderungen.')).toBeTruthy();
    await clickPublish();

    expect(db.publishWeek).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(String(toast.error.mock.calls[0][0])).toMatch(/nicht gespeicherte Änderungen/i);
  });

  it('„Jetzt speichern" ruft onSaveNow auf', async () => {
    const onSaveNow = vi.fn(async () => true);
    renderDialog({ hasUnsavedChanges: true, onSaveNow });

    fireEvent.click(await screen.findByRole('button', { name: /Jetzt speichern/ }));
    await waitFor(() => expect(onSaveNow).toHaveBeenCalledTimes(1));
  });

  it('veröffentlicht normal, wenn alles gespeichert ist', async () => {
    renderDialog({ hasUnsavedChanges: false });

    await clickPublish();
    await waitFor(() => expect(db.publishWeek).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Es gibt nicht gespeicherte Änderungen.')).toBeNull();
  });
});

describe('PublishScheduleDialog – Aktionen schließen sich aus', () => {
  it('während das PDF erzeugt wird, ist „veröffentlichen“ gesperrt', async () => {
    pdf.download.mockImplementation(() => new Promise<void>(res => { pdf.release = res; }));
    renderDialog({ hasUnsavedChanges: false });

    const publishBtn = await screen.findByRole('button', { name: /Woche veröffentlichen/ });
    const pdfBtn = screen.getByRole('button', { name: /PDF/ });
    expect((publishBtn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(pdfBtn);
    await waitFor(() => expect((publishBtn as HTMLButtonElement).disabled).toBe(true));
    expect((pdfBtn as HTMLButtonElement).disabled).toBe(true);

    pdf.release?.();
    await waitFor(() => expect((publishBtn as HTMLButtonElement).disabled).toBe(false));
  });

  it('während veröffentlicht wird, ist „PDF“ gesperrt', async () => {
    let release: () => void = () => {};
    db.publishWeek.mockImplementation(() => new Promise<number>(res => { release = () => res(1); }));
    renderDialog({ hasUnsavedChanges: false });

    const publishBtn = await screen.findByRole('button', { name: /Woche veröffentlichen/ });
    const pdfBtn = screen.getByRole('button', { name: /PDF/ });
    fireEvent.click(publishBtn);
    await waitFor(() => expect((pdfBtn as HTMLButtonElement).disabled).toBe(true));
    expect(pdf.download).not.toHaveBeenCalled();
    release();
  });
});
