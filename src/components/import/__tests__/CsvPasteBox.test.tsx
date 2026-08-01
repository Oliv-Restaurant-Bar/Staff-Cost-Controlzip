// @vitest-environment happy-dom
/**
 * CsvPasteBox — Verhalten der «CSV einfügen»-Komponente:
 *  - leerer Submit ⇒ sichtbarer Hinweis, onText wird NICHT gerufen
 *  - eingefügter Text ⇒ onText(text, 'Eingefügter CSV-Text')
 *  - File-Drop ⇒ onText(dateiInhalt, dateiname)
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CsvPasteBox } from '../CsvPasteBox';

describe('CsvPasteBox', () => {
  it('leerer Submit zeigt Hinweis und ruft onText nicht', async () => {
    const onText = vi.fn();
    render(<CsvPasteBox onText={onText} />);
    fireEvent.click(screen.getByTestId('csv-paste-submit'));
    await waitFor(() => expect(screen.getByTestId('csv-paste-hint')).toBeTruthy());
    expect(onText).not.toHaveBeenCalled();
  });

  it('eingefügter Text wird 1:1 an onText übergeben', async () => {
    const onText = vi.fn();
    render(<CsvPasteBox onText={onText} />);
    fireEvent.change(screen.getByTestId('csv-paste-textarea'), { target: { value: 'A;B\n1;2' } });
    fireEvent.click(screen.getByTestId('csv-paste-submit'));
    await waitFor(() => expect(onText).toHaveBeenCalledWith('A;B\n1;2', 'Eingefügter CSV-Text'));
  });

  it('File-Drop liest die Datei und übergibt Inhalt + Dateiname', async () => {
    const onText = vi.fn();
    render(<CsvPasteBox onText={onText} />);
    const file = new File(['X;Y\n3;4'], 'export.csv', { type: 'text/csv' });
    fireEvent.drop(screen.getByTestId('csv-paste-textarea'), {
      dataTransfer: { files: [file], types: ['Files'] },
    });
    await waitFor(() => expect(onText).toHaveBeenCalledWith('X;Y\n3;4', 'export.csv'));
  });
});
