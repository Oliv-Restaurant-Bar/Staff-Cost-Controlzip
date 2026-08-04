// @vitest-environment node
// Umsatz-Abgleich Tagesumsätze-Import ↔ Z-Bericht (Tagesabschluss-Übersicht):
// Anzeige = Import (massgeblich), Z-Bericht nur Hintergrund-Kontrolle,
// rot NUR wenn beide Quellen vorliegen und |Import − Z| > Schwelle.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_UMSATZ_DIFF_SCHWELLE, emptyTagesabschlussBlob,
  mergeTagesabschlussBlobs, normalizeTagesabschlussBlob,
  setUmsatzDiffSchwelle, umsatzAbgleich, umsatzDiffSchwelle,
} from '@/lib/tagesabschluss';

describe('umsatzAbgleich', () => {
  it('Anzeige = Import (massgeblich); Differenz = Import − Z-Bericht', () => {
    const a = umsatzAbgleich(1015.5, 1000, 10);
    expect(a).toMatchObject({ anzeige: 1015.5, quelle: 'import', diff: 15.5, rot: true });
    // Innerhalb der Schwelle: nicht rot (Grenzwert exakt = Schwelle bleibt ok).
    expect(umsatzAbgleich(1010, 1000, 10)).toMatchObject({ diff: 10, rot: false });
    expect(umsatzAbgleich(989.99, 1000, 10)).toMatchObject({ diff: -10.01, rot: true });
  });

  it('fehlende Quelle: nur vorhandenen Wert zeigen, NIE rot, keine Differenz', () => {
    expect(umsatzAbgleich(500, null, 10)).toMatchObject({ anzeige: 500, quelle: 'import', diff: null, rot: false });
    expect(umsatzAbgleich(null, 800, 10)).toMatchObject({ anzeige: 800, quelle: 'zbericht', diff: null, rot: false });
    expect(umsatzAbgleich(null, null, 10)).toMatchObject({ anzeige: null, quelle: null, diff: null, rot: false });
  });
});

describe('Schwelle (konfigurierbar, Standard 10.00)', () => {
  it('Default ohne Konfiguration; Setzen/Zurücksetzen ohne Key-Löschung', () => {
    const blob = emptyTagesabschlussBlob();
    expect(DEFAULT_UMSATZ_DIFF_SCHWELLE).toBe(10);
    expect(umsatzDiffSchwelle(blob)).toBe(10);
    const b2 = setUmsatzDiffSchwelle(blob, 25.5, '2026-08-04T10:00:00Z');
    expect(umsatzDiffSchwelle(b2)).toBe(25.5);
    // null = Standard EXPLIZIT setzen (kein Key-Löschen → keine merge-Resurrection):
    const b3 = setUmsatzDiffSchwelle(b2, null, '2026-08-04T11:00:00Z');
    expect(b3.umsatzDiffSchwelle).toEqual({ value: 10, updatedAt: '2026-08-04T11:00:00Z' });
  });

  it('merge: jüngerer updatedAt gewinnt; normalize verwirft Ungültiges', () => {
    const a = setUmsatzDiffSchwelle(emptyTagesabschlussBlob(), 20, '2026-08-04T10:00:00Z');
    const b = setUmsatzDiffSchwelle(emptyTagesabschlussBlob(), 30, '2026-08-04T12:00:00Z');
    expect(mergeTagesabschlussBlobs(a, b).umsatzDiffSchwelle?.value).toBe(30);
    expect(mergeTagesabschlussBlobs(b, a).umsatzDiffSchwelle?.value).toBe(30);
    // Roundtrip + defensive Normalisierung:
    expect(normalizeTagesabschlussBlob(JSON.parse(JSON.stringify(b))).umsatzDiffSchwelle?.value).toBe(30);
    expect(normalizeTagesabschlussBlob({ umsatzDiffSchwelle: { value: -5 } }).umsatzDiffSchwelle).toBeNull();
    expect(normalizeTagesabschlussBlob({ umsatzDiffSchwelle: { value: 'x' } }).umsatzDiffSchwelle).toBeNull();
    expect(normalizeTagesabschlussBlob({}).umsatzDiffSchwelle).toBeNull();
  });
});
