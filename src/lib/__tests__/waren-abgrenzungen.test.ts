// @vitest-environment node
/**
 * Abgrenzungen (TP/RB — transitorische Posten): «TP RE …» / «RB TP RE …»
 * sind Monats-Abgrenzungen der Buchhaltung, KEINE Rechnungen. Sie werden im
 * Abgleich ausgeklammert (keine Lieferanten-Zeile, kein Übernahme-Kandidat,
 * nie in «Alle übernehmen»), separat ausgewiesen und TP↔RB gepaart (netto 0).
 */
import { describe, it, expect } from 'vitest';
import { buildWarenAbgleich, istAbgrenzungsBuchung, paareAbgrenzungen } from '../waren-abgleich';
import { buildUebernahmeKandidaten } from '../waren-fibu-uebernahme';
import { buildDiffAufschluesselung } from '../waren-diff';
import type { SageJournalEntry } from '@/types/reporting';

const buch = (text: string, soll: number, haben = 0, konto = '4020', date = '10.07.2026'): SageJournalEntry => ({
  date, text, accountNumber: konto, accountName: 'Warenaufwand',
  soll, haben, amount: soll - haben,
});

const BASE = {
  invoices: [],
  warenkontoNummern: ['4020', '4060'],
  supplierNames: ['Schenk Suisse'],
  aliases: {},
  buchhaltungTotal: null as number | null,
};

describe('istAbgrenzungsBuchung', () => {
  it('erkennt TP RE und RB TP RE (case-insensitive), nicht aber normale Texte', () => {
    expect(istAbgrenzungsBuchung('TP RE Schenk Suisse')).toBe(true);
    expect(istAbgrenzungsBuchung('RB TP RE Schenk Suisse')).toBe(true);
    expect(istAbgrenzungsBuchung('  tp re Obrist')).toBe(true);
    expect(istAbgrenzungsBuchung('rb tp re Obrist')).toBe(true);
    expect(istAbgrenzungsBuchung('ER Schenk Suisse')).toBe(false);
    expect(istAbgrenzungsBuchung('STOP RE Test')).toBe(false);
    expect(istAbgrenzungsBuchung('TPRE Schenk')).toBe(false);
    expect(istAbgrenzungsBuchung(null)).toBe(false);
  });
});

describe('buildWarenAbgleich — Abgrenzungen ausgeklammert', () => {
  it('TP/RB erzeugen weder Lieferanten-Zeile noch Total-Anteil, landen in abgrenzungen', () => {
    const r = buildWarenAbgleich({
      ...BASE,
      journal: [
        buch('TP RE Schenk Suisse', 2000),
        buch('RB TP RE Schenk Suisse', 0, 2000, '4020', '01.08.2026'),
        buch('ER Schenk Suisse', 500),
      ],
    });
    expect(r.abgrenzungen.length).toBe(2);
    expect(r.abgrenzungenSumme).toBe(0);
    const zeile = r.zeilen.find(z => z.lieferant === 'Schenk Suisse')!;
    expect(zeile.gebucht).toBe(500); // nur die echte ER-Buchung
    expect(r.gebuchtTotal).toBe(500);
    expect(r.nichtZugeordnet.length).toBe(0);
  });

  it('Abgrenzungen erscheinen NIE als Übernahme-Kandidaten', () => {
    const r = buildWarenAbgleich({
      ...BASE,
      journal: [buch('TP RE Schenk Suisse', 2000), buch('ER Hof am Stutz', 300)],
    });
    const kandidaten = buildUebernahmeKandidaten(r, { gruppen: [], gesperrt: { invoiceIds: [] } } as never, []);
    expect(kandidaten.some(k => /tp re/i.test(k.text))).toBe(false);
    expect(kandidaten.some(k => k.text === 'ER Hof am Stutz')).toBe(true);
  });

  it('Diff-Aufschlüsselung führt Abgrenzungen als eigene informative Gruppe', () => {
    const r = buildWarenAbgleich({
      ...BASE,
      journal: [buch('TP RE Schenk Suisse', 2000)],
    });
    const d = buildDiffAufschluesselung({ abgleich: r, invoices: [], resolve: n => n, gruppen: [] });
    const g = d.gruppen.find(x => x.kategorie === 'abgrenzung')!;
    expect(g.zeilen.length).toBe(1);
    expect(d.abgrenzungenSumme).toBe(2000);
    expect(d.lueckenSumme).toBe(0); // TP zählt NICHT als Lücke
  });
});

describe('degradierter Modus (nur Total-Vergleich)', () => {
  it('zieht Abgrenzungen wie Umbuchungen aus dem Buchhaltungs-Total heraus', () => {
    const r = buildWarenAbgleich({
      ...BASE,
      // Nur TP/RB + Umbuchung im Journal → keine echten Buchungszeilen → degradiert
      journal: [
        buch('TP RE Schenk Suisse', 2000),
        buch('Umb. Kontierung Test', 100),
      ],
      buchhaltungTotal: 5000,
    });
    expect(r.mode).toBe('nur-total');
    expect(r.gebuchtTotal).toBe(5000 - 100 - 2000);
  });
});

describe('paareAbgrenzungen', () => {
  it('paart TP mit seiner RB-Gegenbuchung (gleicher Text-Rest, Summe ≈ 0)', () => {
    const tp = buch('TP RE Schenk Suisse', 2000);
    const rb = buch('RB TP RE Schenk Suisse', 0, 2000, '4020', '01.08.2026');
    const offenTp = buch('TP RE La Marra', 800);
    const { gepaart, offen } = paareAbgrenzungen([tp, rb, offenTp]);
    expect(gepaart).toContain(tp);
    expect(gepaart).toContain(rb);
    expect(offen).toEqual([offenTp]);
  });

  it('paart NICHT bei abweichendem Betrag oder anderem Text-Rest', () => {
    const tp = buch('TP RE Schenk Suisse', 2000);
    const rbFalsch = buch('RB TP RE Schenk Suisse', 0, 1500);
    const rbAnders = buch('RB TP RE Rutishauser', 0, 2000);
    const { gepaart, offen } = paareAbgrenzungen([tp, rbFalsch, rbAnders]);
    expect(gepaart.length).toBe(0);
    expect(offen.length).toBe(3);
  });
});
