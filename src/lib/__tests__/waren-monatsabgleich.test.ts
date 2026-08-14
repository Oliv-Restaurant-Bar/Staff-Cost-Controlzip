// @vitest-environment node
/**
 * Tests waren-monatsabgleich: Lieferschein→Monatsrechnung Abgleich & Ersetzen.
 * Kernszenario = die frühere Terravigna-Verdopplung (Monatsrechnung 7'013.37
 * + 9 Lieferscheine 7'035.93): nach «übernehmen» ist Σ = Monatsrechnung.
 */
import { describe, it, expect } from 'vitest';
import {
  istProvisorischerLieferschein, baueMonatsAbgleich, wendeMonatsrechnungAn,
  markiereDifferenzOffen, lieferantStatus,
} from '../waren-monatsabgleich';
import type { InvoiceEntry } from '../waren-db';

let seq = 0;
function inv(p: Partial<InvoiceEntry>): InvoiceEntry {
  return {
    id: p.id ?? `e${++seq}`, date: '2026-07-10', supplierName: 'Terravigna',
    amountGross: 108.1, amountNet: 100, vatIncluded: true, vatRate: 8.1,
    createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
    ...p,
  } as InvoiceEntry;
}
const NOW = '2026-08-10T00:00:00Z';
const matchtTerra = (n: string) => n.startsWith('Terravigna');

describe('istProvisorischerLieferschein', () => {
  it('ohne quelle / AB = provisorisch; Übernahmen & finale nicht', () => {
    expect(istProvisorischerLieferschein(inv({}))).toBe(true);
    expect(istProvisorischerLieferschein(inv({ quelle: 'auftragsbestaetigung' }))).toBe(true);
    expect(istProvisorischerLieferschein(inv({ quelle: 'kreditoren_uebernahme' }))).toBe(false);
    expect(istProvisorischerLieferschein(inv({ quelle: 'fibu_uebernahme' }))).toBe(false);
    expect(istProvisorischerLieferschein(inv({ quelle: 'monatsrechnung' }))).toBe(false);
    expect(istProvisorischerLieferschein(inv({ final: true }))).toBe(false);
  });
});

describe('baueMonatsAbgleich', () => {
  it('Σ, Differenz und %; fremde Lieferanten/Monate/Quellen bleiben draussen', () => {
    const bestand = [
      inv({ id: 'l1', amountNet: 4000, amountGross: 4324 }),
      inv({ id: 'l2', amountNet: 3035.93, amountGross: 3281.84 }),
      inv({ id: 'x1', supplierName: 'Caporaso' }),
      inv({ id: 'x2', date: '2026-06-30' }),
      inv({ id: 'x3', quelle: 'kreditoren_uebernahme' }),
    ];
    const v = baueMonatsAbgleich({ bestand, monat: '2026-07', totalNet: 7013.37, totalGross: 7581.45, matcht: matchtTerra });
    expect(v.lieferscheine.map(e => e.id)).toEqual(['l1', 'l2']);
    expect(v.sigmaNet).toBe(7035.93);
    expect(v.differenzNet).toBe(-22.56);
    expect(v.differenzPct).toBeCloseTo(-0.3206, 3);
  });
  it('keine Lieferscheine → Σ 0, differenzPct null (nie ÷0)', () => {
    const v = baueMonatsAbgleich({ bestand: [], monat: '2026-07', totalNet: 100, totalGross: 108, matcht: () => true });
    expect(v.sigmaNet).toBe(0);
    expect(v.differenzPct).toBeNull();
  });
});

describe('wendeMonatsrechnungAn', () => {
  const bestand = [
    inv({ id: 'l1', amountNet: 4000, amountGross: 4324 }),
    inv({ id: 'l2', amountNet: 3035.93, amountGross: 3281.84, note: 'LS 287229' }),
    inv({ id: 'fremd', supplierName: 'Caporaso' }),
  ];
  const vorschau = baueMonatsAbgleich({ bestand, monat: '2026-07', totalNet: 7013.37, totalGross: 7581.45, matcht: matchtTerra });
  const rechnung = { datum: '2026-07-31', referenz: '211363', totalNet: 7013.37, totalGross: 7581.45, warenkonto: '4020' };

  it('anteilig: Σ exakt = Monatsrechnung, Daten bleiben, abgeglichen+final, kein Zusatz-Eintrag', () => {
    const out = wendeMonatsrechnungAn({ bestand, vorschau, rechnung, modus: 'anteilig', now: NOW });
    expect(out).toHaveLength(3); // NICHT addiert — ersetzt
    const l = out.filter(e => e.id === 'l1' || e.id === 'l2');
    expect(l.reduce((s, e) => s + e.amountNet, 0)).toBeCloseTo(7013.37, 2);
    expect(l.reduce((s, e) => s + e.amountGross, 0)).toBeCloseTo(7581.45, 2);
    expect(l.every(e => e.final === true && e.abgleichStatus === 'abgeglichen')).toBe(true);
    expect(l.map(e => e.date)).toEqual(['2026-07-10', '2026-07-10']); // Lieferwochen bleiben
    expect(out.find(e => e.id === 'l2')!.note).toContain('Monatsabgleich Rg. 211363');
    expect(out.find(e => e.id === 'fremd')!.amountNet).toBe(100); // unberührt
  });

  it('rechnungsdatum: Lieferscheine unverändert + Differenz-Eintrag am Rechnungsdatum', () => {
    const out = wendeMonatsrechnungAn({ bestand, vorschau, rechnung, modus: 'rechnungsdatum', now: NOW });
    expect(out).toHaveLength(4);
    const diff = out.find(e => e.id.startsWith('mabgl_'))!;
    expect(diff.date).toBe('2026-07-31');
    expect(diff.amountNet).toBe(-22.56);
    expect(diff.warenkonto).toBe('4020');
    expect(diff.final).toBe(true);
    expect(out.find(e => e.id === 'l1')!.amountNet).toBe(4000);
    expect(out.filter(e => matchtTerra(e.supplierName)).reduce((s, e) => s + e.amountNet, 0))
      .toBeCloseTo(7013.37, 2);
  });

  it('rechnungsdatum ohne Differenz: kein Korrektur-Eintrag', () => {
    const v0 = baueMonatsAbgleich({ bestand, monat: '2026-07', totalNet: 7035.93, totalGross: 7605.84, matcht: matchtTerra });
    const out = wendeMonatsrechnungAn({
      bestand, vorschau: v0, modus: 'rechnungsdatum', now: NOW,
      rechnung: { ...rechnung, totalNet: 7035.93, totalGross: 7605.84 },
    });
    expect(out).toHaveLength(3);
  });

  it('keine Lieferscheine → Bestand unverändert (Aufrufer speichert regulär)', () => {
    const leer = baueMonatsAbgleich({ bestand, monat: '2026-07', totalNet: 500, totalGross: 540, matcht: () => false });
    expect(wendeMonatsrechnungAn({ bestand, vorschau: leer, rechnung, modus: 'anteilig', now: NOW })).toHaveLength(3);
  });
});

describe('Manuelle Buchungen (CSV/Text) im Dual-Modell', () => {
  it('manuell erfasste Belege (id manuell-*, kein quelle/final) werden wie PDF-Lieferscheine abgeglichen & ersetzt', () => {
    // Struktur exakt wie sie ManuelleBuchungenImport schreibt.
    const manuell = (id: string, net: number) => inv({
      id: `manuell-${id}`, supplierName: 'Fideco', date: '2026-08-05',
      amountNet: net, amountGross: Math.round(net * 1.081 * 100) / 100,
      vatIncluded: false, reference: `77460${id}`,
      warenkonto: '4060', kategorie: 'Food',
    });
    const bestand = [manuell('26', 200), manuell('27', 167.7)];
    const matchtFideco = (n: string) => n.trim().toLowerCase() === 'fideco';

    expect(bestand.every(istProvisorischerLieferschein)).toBe(true);
    const v = baueMonatsAbgleich({ bestand, monat: '2026-08', totalNet: 380, totalGross: 410.78, matcht: matchtFideco });
    expect(v.lieferscheine).toHaveLength(2);
    expect(v.sigmaNet).toBe(367.7);
    expect(v.differenzNet).toBe(12.3); // Differenz sichtbar, kein Doppelzählen

    const out = wendeMonatsrechnungAn({
      bestand, vorschau: v, modus: 'anteilig', now: NOW,
      rechnung: { datum: '2026-08-31', referenz: 'MR-08', totalNet: 380, totalGross: 410.78 },
    });
    expect(out).toHaveLength(2); // ersetzt, NIE addiert
    expect(out.every(e => e.final === true && e.abgleichStatus === 'abgeglichen')).toBe(true);
    expect(Math.round(out.reduce((s, e) => s + e.amountNet, 0) * 100) / 100).toBe(380);
    // Beleg-Nr & Konto bleiben für Rückverfolgung/WKQ erhalten.
    expect(out.map(e => e.reference)).toEqual(['7746026', '7746027']);
    expect(out.every(e => e.warenkonto === '4060')).toBe(true);
  });
});

describe('markiereDifferenzOffen / lieferantStatus', () => {
  it('markiert nur die Lieferscheine; Status-Priorität differenz_offen > provisorisch > abgeglichen', () => {
    const bestand = [inv({ id: 'l1' }), inv({ id: 'fremd', supplierName: 'Caporaso' })];
    const out = markiereDifferenzOffen(bestand, [bestand[0]], NOW);
    expect(out[0].abgleichStatus).toBe('differenz_offen');
    expect(out[1].abgleichStatus).toBeUndefined();
    expect(out[0].amountNet).toBe(100); // Beträge unangetastet
    expect(lieferantStatus(out)).toBe('differenz_offen');
    expect(lieferantStatus([inv({})])).toBe('provisorisch');
    expect(lieferantStatus([inv({ final: true, abgleichStatus: 'abgeglichen' })])).toBe('abgeglichen');
    expect(lieferantStatus([inv({ quelle: 'kreditoren_uebernahme' })])).toBe('abgeglichen');
  });
});
