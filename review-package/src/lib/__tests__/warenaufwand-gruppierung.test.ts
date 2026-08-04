// @vitest-environment node
/**
 * Spez-Tests Warenaufwand-Zwischentotale — numerische Range-Zuordnung (SSoT).
 * Direkter Warenaufwand: 4000–4070 inkl. · Übriger Warenaufwand: 4071–4900 inkl.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyWarenaufwandKonto,
  normalizeWarenKonto,
  gruppiereWarenaufwandKonten,
  sumOrNull,
  WARENAUFWAND_GRUPPE_LABEL,
  WARENAUFWAND_DIRECT_MIN,
  WARENAUFWAND_DIRECT_MAX,
  WARENAUFWAND_UEBRIG_MIN,
  WARENAUFWAND_UEBRIG_MAX,
} from '../warenaufwand-gruppierung';

describe('classifyWarenaufwandKonto — Bereichsgrenzen', () => {
  it('1. Untergrenze 4000 → direct', () => {
    expect(classifyWarenaufwandKonto('4000')).toBe('direct');
    expect(classifyWarenaufwandKonto(4000)).toBe('direct');
  });

  it('2. Obergrenze 4070 → direct (inklusive)', () => {
    expect(classifyWarenaufwandKonto('4070')).toBe('direct');
    expect(classifyWarenaufwandKonto(4070)).toBe('direct');
  });

  it('3. Grenzwechsel 4071 → uebrig (inklusive Untergrenze)', () => {
    expect(classifyWarenaufwandKonto('4071')).toBe('uebrig');
    expect(classifyWarenaufwandKonto(4071)).toBe('uebrig');
  });

  it('4. Obergrenze 4899 → uebrig (inklusive); 4900 = Lagerveränderung, eigene Zeile', () => {
    expect(classifyWarenaufwandKonto('4899')).toBe('uebrig');
    expect(classifyWarenaufwandKonto(4899)).toBe('uebrig');
    expect(classifyWarenaufwandKonto('4900')).toBeNull();
    expect(classifyWarenaufwandKonto(4900)).toBeNull();
  });

  it('5. 4901 und höher → null (nie stillschweigend zuordnen)', () => {
    expect(classifyWarenaufwandKonto('4901')).toBeNull();
    expect(classifyWarenaufwandKonto('4999')).toBeNull();
    expect(classifyWarenaufwandKonto('5000')).toBeNull();
  });

  it('6. Unter 4000 → null (3999 ist Ertrag, kein Warenaufwand)', () => {
    expect(classifyWarenaufwandKonto('3999')).toBeNull();
    expect(classifyWarenaufwandKonto('3000')).toBeNull();
  });
});

describe('classifyWarenaufwandKonto — Normalisierung & Robustheit', () => {
  it('7. Whitespace wird toleriert (« 4070 » → direct)', () => {
    expect(classifyWarenaufwandKonto(' 4070 ')).toBe('direct');
    expect(classifyWarenaufwandKonto(' 4071 ')).toBe('uebrig');
  });

  it('8. 5-stellige Konten → erste 4 Stellen (App-Konvention)', () => {
    expect(classifyWarenaufwandKonto('40201')).toBe('direct'); // → 4020
    expect(classifyWarenaufwandKonto('47019')).toBe('uebrig'); // → 4701
    expect(normalizeWarenKonto('40201')).toBe(4020);
    expect(normalizeWarenKonto(40201)).toBe(4020);
  });

  it('9. Ungültige Werte → null (leer, Text, Dezimal, negativ, null/undefined)', () => {
    expect(classifyWarenaufwandKonto('')).toBeNull();
    expect(classifyWarenaufwandKonto('abc')).toBeNull();
    expect(classifyWarenaufwandKonto('40a0')).toBeNull();
    expect(classifyWarenaufwandKonto(4000.5)).toBeNull();
    expect(classifyWarenaufwandKonto(-4000)).toBeNull();
    expect(classifyWarenaufwandKonto(null)).toBeNull();
    expect(classifyWarenaufwandKonto(undefined)).toBeNull();
    expect(classifyWarenaufwandKonto(NaN)).toBeNull();
    expect(classifyWarenaufwandKonto(Infinity)).toBeNull();
  });

  it('10. Regressionsset Kontenplan: 4000/4020/4030/4040/4050/4060/4070 → direct', () => {
    for (const k of ['4000', '4020', '4030', '4040', '4050', '4060', '4070']) {
      expect(classifyWarenaufwandKonto(k), `Konto ${k}`).toBe('direct');
    }
  });

  it('11. Regressionsset Kontenplan: 4090/4701/4800 → uebrig', () => {
    for (const k of ['4090', '4701', '4800']) {
      expect(classifyWarenaufwandKonto(k), `Konto ${k}`).toBe('uebrig');
    }
  });

  it('12. Bereichs-Konstanten decken lückenlos 4000–4899 ab (4900 = Lagerveränderung, separat)', () => {
    expect(WARENAUFWAND_DIRECT_MIN).toBe(4000);
    expect(WARENAUFWAND_DIRECT_MAX).toBe(4070);
    expect(WARENAUFWAND_UEBRIG_MIN).toBe(4071);
    expect(WARENAUFWAND_UEBRIG_MAX).toBe(4899);
    expect(WARENAUFWAND_UEBRIG_MIN).toBe(WARENAUFWAND_DIRECT_MAX + 1);
    // jedes Konto im Gesamtbereich landet in genau einer Gruppe
    for (let n = 4000; n <= 4899; n++) {
      const g = classifyWarenaufwandKonto(n);
      expect(g === 'direct' || g === 'uebrig', `Konto ${n}`).toBe(true);
    }
  });
});

describe('gruppiereWarenaufwandKonten', () => {
  const rows = [
    { konto: '4020', amount: 100 },
    { konto: '4800', amount: 50 },
    { konto: '4000', amount: 30 },
    { konto: '4071', amount: 20 },
    { konto: '4950', amount: 10 },
    { konto: 'xxx', amount: 5 },
  ];

  it('13. teilt Zeilen korrekt in direct/uebrig/unzugeordnet', () => {
    const g = gruppiereWarenaufwandKonten(rows, r => r.konto);
    expect(g.direct.map(r => r.konto)).toEqual(['4020', '4000']);
    expect(g.uebrig.map(r => r.konto)).toEqual(['4800', '4071']);
    expect(g.unzugeordnet.map(r => r.konto)).toEqual(['4950', 'xxx']);
  });

  it('14. Eingabereihenfolge bleibt innerhalb der Gruppen erhalten', () => {
    const g = gruppiereWarenaufwandKonten(rows, r => r.konto);
    expect(g.direct[0].konto).toBe('4020'); // kam vor 4000
  });

  it('15. leere Eingabe → drei leere Gruppen (kein erfundenes CHF 0)', () => {
    const g = gruppiereWarenaufwandKonten([], () => '4000');
    expect(g.direct).toEqual([]);
    expect(g.uebrig).toEqual([]);
    expect(g.unzugeordnet).toEqual([]);
  });

  it('16. Zuordnung erfolgt rein numerisch — Label/Reihenfolge irrelevant', () => {
    const withLabels = [
      { konto: '4800', label: 'Einkauf Speisen (falsches Label)' },
      { konto: '4020', label: 'Sonstiger Aufwand (falsches Label)' },
    ];
    const g = gruppiereWarenaufwandKonten(withLabels, r => r.konto);
    expect(g.uebrig[0].konto).toBe('4800');
    expect(g.direct[0].konto).toBe('4020');
  });
});

describe('sumOrNull — fehlend ≠ 0', () => {
  it('17. alle Werte fehlend → null (kein erfundenes CHF 0)', () => {
    expect(sumOrNull([])).toBeNull();
    expect(sumOrNull([undefined, null])).toBeNull();
  });

  it('18. vorhandene Werte werden summiert, fehlende ignoriert', () => {
    expect(sumOrNull([100, undefined, 50.5, null])).toBeCloseTo(150.5, 10);
    expect(sumOrNull([0])).toBe(0); // echte 0 bleibt 0, nicht null
  });

  it('19. negative Werte (Gutschriften) werden korrekt verrechnet', () => {
    expect(sumOrNull([100, -30])).toBe(70);
  });
});

describe('Labels', () => {
  it('20. Zwischentotal-Labels sind exakt die Spez-Bezeichnungen (UI = PDF = Excel)', () => {
    expect(WARENAUFWAND_GRUPPE_LABEL.direct).toBe('Direkter Warenaufwand');
    expect(WARENAUFWAND_GRUPPE_LABEL.uebrig).toBe('Übriger Warenaufwand');
  });
});
