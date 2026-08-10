// @vitest-environment node
/**
 * Kontrollwerte aus den Beispiel-PDFs (Beaulieu) — die Vorschau muss exakt
 * diese Netto-/MwSt-Beträge ergeben. Fixtures = Textextraktion der PDFs.
 */
import { describe, it, expect, vi } from 'vitest';

// lieferanten-profile importiert supabase-kv (Browser-Client) — hier mocken.
vi.mock('@/lib/supabase-kv', () => ({
  kvGet: vi.fn(async () => null),
  kvGetStrict: vi.fn(async () => null),
  kvSet: vi.fn(async () => {}),
  kvRemove: vi.fn(async () => {}),
}));
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProfilPdf, parseBetrag, parseDatumCH, erkenneDokumenttyp, erkenneBelegart } from '@/lib/profil-pdf-parse';
import { DEFAULT_PROFILE_BEAULIEU, findeProfilImText } from '@/lib/lieferanten-profile';

const fx = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', 'beaulieu-pdf', name), 'utf8');

const P = DEFAULT_PROFILE_BEAULIEU;
const parse = (name: string) => parseProfilPdf(fx(name), P);

describe('parseBetrag', () => {
  it('versteht CH- und DE-Formate', () => {
    expect(parseBetrag("3'796.25")).toBe(3796.25);
    expect(parseBetrag('2’339.69')).toBe(2339.69);
    expect(parseBetrag('3.416,45')).toBe(3416.45);
    expect(parseBetrag('88,85')).toBe(88.85);
    expect(parseBetrag('584.40')).toBe(584.4);
    expect(parseBetrag("-41,20")).toBe(-41.2);
  });
  it('Datum dd.mm.yy(yy)', () => {
    expect(parseDatumCH('19.06.26')).toBe('2026-06-19');
    expect(parseDatumCH('01.07.2026')).toBe('2026-07-01');
  });
});

describe('Kontrollwerte Stufe 1 (Kopf)', () => {
  it('Spahni 8646158: netto 3796.25 / MwSt 98.70 (2.6%)', () => {
    const r = parse('spahni-8646158.txt');
    expect(r.profil?.id).toBe('spahni');
    expect(r.rechnungsNr).toBe('8646158');
    expect(r.netto).toBe(3796.25);
    expect(r.mwst).toBe(98.7);
    expect(r.mwstSatz).toBe(2.6);
  });
  it('Terravigna AB 145095: AB = Lieferschein → buchbar als provisorische Lieferung', () => {
    const r = parse('terravigna-ab-145095.txt');
    expect(r.belegart).toBe('auftragsbestaetigung');
    expect(r.profil?.id).toBe('terravigna');
    expect(r.profil?.abAlsLieferschein).toBe(true);
    expect(r.rechnungsNr).toBe('145095');
    expect(r.netto).toBe(828.39);
    expect(r.hinweise[0]).toContain('provisorische Lieferung');
    expect(r.hinweise.join(' ')).not.toContain('wird nicht gebucht');
  });
  it('Belegart-Sperre bleibt für Profile OHNE AB-als-Lieferschein', () => {
    // Gleicher AB-Text, aber ohne Terravigna-MWST-Nr ⇒ Profil ohne Ausnahme.
    const text = fx('terravigna-ab-145095.txt').replace(/108\.008\.709/g, '219.630.115');
    const r = parseProfilPdf(text, P);
    expect(r.profil?.id).toBe('obrist');
    expect(r.belegart).toBe('auftragsbestaetigung');
    expect(r.hinweise[0]).toContain('wird nicht gebucht');
  });
  it('Belegart: echte Rechnungen bleiben «rechnung» (alle Fixtures)', () => {
    for (const f of ['spahni-8646158.txt', 'fideco-5356149.txt', 'terravigna-211343.txt',
      'gourmador-92051534.txt', 'gasser-f0122084.txt',
      'obrist-326269.txt', 'rutishauser-91091909.txt', 'blaser-1088741.txt',
      'hofamstutz-1063.txt', 'spahni-ls-5210840.txt']) {
      expect(parse(f).belegart, f).toBe('rechnung');
    }
  });
  it('Spahni Einzel-Lieferschein 5210840: netto 284.90 / MwSt 7.40 (2.6%), Lieferdatum 04.08.26', () => {
    const r = parse('spahni-ls-5210840.txt');
    expect(r.profil?.id).toBe('spahni');
    expect(r.rechnungsNr).toBe('5210840');
    expect(r.netto).toBe(284.9);
    expect(r.mwst).toBe(7.4);
    expect(r.mwstSatz).toBe(2.6);
    expect(r.lieferdatum).toBe('2026-08-04');
    // Stufe 2: EIN Block mit LS-Nr als Rechnungs-Nr, Positionssumme = Netto
    expect(r.positionenErkannt).toBe(true);
    expect(r.lieferungen).toHaveLength(1);
    expect(r.lieferungen[0].rechnungsNr).toBe('5210840');
    expect(r.lieferungen[0].datum).toBe('2026-08-04');
    expect(r.lieferungen[0].positionen).toHaveLength(2);
    expect(r.lieferungen[0].nettoTotal).toBe(284.9);
  });
  it('Fideco 5356149: netto 3416.45 / MwSt 88.85 (2.6%)', () => {
    const r = parse('fideco-5356149.txt');
    expect(r.profil?.id).toBe('fideco');
    expect(r.rechnungsNr).toBe('5356149');
    expect(r.netto).toBe(3416.45);
    expect(r.mwst).toBe(88.85);
    expect(r.mwstSatz).toBe(2.6);
  });
  it('Gourmador 92051534: netto 2822.15 / MwSt 73.38 (2.6%)', () => {
    const r = parse('gourmador-92051534.txt');
    expect(r.profil?.id).toBe('gourmador');
    expect(r.rechnungsNr).toBe('92051534');
    expect(r.netto).toBe(2822.15);
    expect(r.mwst).toBe(73.38);
  });
  it('Terravigna 211343: netto 2339.69 / MwSt 189.51 (8.1%)', () => {
    const r = parse('terravigna-211343.txt');
    expect(r.profil?.id).toBe('terravigna');
    expect(r.rechnungsNr).toBe('211343');
    expect(r.netto).toBe(2339.69);
    expect(r.mwst).toBe(189.51);
    expect(r.mwstSatz).toBe(8.1);
    expect(r.rechnungsdatum).toBe('2026-07-31');
  });
  it('Obrist 326269: netto 415.20 / MwSt 33.63 (8.1%)', () => {
    const r = parse('obrist-326269.txt');
    expect(r.profil?.id).toBe('obrist');
    expect(r.rechnungsNr).toBe('326269');
    expect(r.netto).toBe(415.2);
    expect(r.mwst).toBe(33.63);
  });
  it('Rutishauser 91091909: netto 584.40 / MwSt 47.34 (8.1%)', () => {
    const r = parse('rutishauser-91091909.txt');
    expect(r.profil?.id).toBe('rutishauser');
    expect(r.rechnungsNr).toBe('91091909');
    expect(r.netto).toBe(584.4);
    expect(r.mwst).toBe(47.34);
    expect(r.lieferdatum).toBe('2026-07-13');
  });
  it('Bohnenblust ist ausgeschlossen: 49415 wird keinem Profil zugeordnet', () => {
    const r = parse('bohnenblust-49415.txt');
    expect(r.profil).toBeNull();
  });
  it('Hof am Stutz 1063 (ohne MWST-Nr, via Name): netto 148.50 (0%)', () => {
    const r = parse('hofamstutz-1063.txt');
    expect(r.profil?.id).toBe('hofamstutz');
    expect(r.rechnungsNr).toBe('1063');
    expect(r.netto).toBe(148.5);
    expect(r.mwst).toBe(0);
    expect(r.mwstSatz).toBe(0);
  });
  it('Gasser F0122084: Belegbetrag netto 1419.90 / MwSt 36.90', () => {
    const r = parse('gasser-f0122084.txt');
    expect(r.profil?.id).toBe('gasser');
    expect(r.netto).toBe(1419.9);
    expect(r.mwst).toBe(36.9);
    expect(r.rechnungsdatum).toBe('2026-06-30');
  });
  it('Blaser 1088741: netto 399.50 / MwSt 10.40', () => {
    const r = parse('blaser-1088741.txt');
    expect(r.profil?.id).toBe('blaser');
    expect(r.rechnungsNr).toBe('1088741');
    expect(r.netto).toBe(399.5);
    expect(r.mwst).toBe(10.4);
  });
});

describe('Stufe 2 (Positionen & Lieferdatum je Lieferung)', () => {
  it('Spahni: LS-Blöcke mit LS-Datum, Positionssumme = Netto', () => {
    const r = parse('spahni-8646158.txt');
    expect(r.positionenErkannt).toBe(true);
    expect(r.lieferungen.length).toBeGreaterThan(5);
    expect(r.lieferungen[0].datum).toBe('2026-06-16');
    const summe = Math.round(r.lieferungen.reduce((s, l) => s + l.nettoTotal, 0) * 100) / 100;
    expect(Math.abs(summe - 3796.25)).toBeLessThanOrEqual(0.05);
    expect(r.hinweise.join(' ')).not.toMatch(/Positionssumme/);
  });
  it('Fideco: LIEFERSCHEIN-Blöcke, Gutschrift eingerechnet, Summe = Netto', () => {
    const r = parse('fideco-5356149.txt');
    expect(r.positionenErkannt).toBe(true);
    expect(r.lieferungen.length).toBeGreaterThanOrEqual(7);
    const summe = Math.round(r.lieferungen.reduce((s, l) => s + l.nettoTotal, 0) * 100) / 100;
    expect(Math.abs(summe - 3416.45)).toBeLessThanOrEqual(0.05);
  });
  it('Terravigna: Lieferungsnr-Blöcke, effektiver Stückpreis, Summe = Netto', () => {
    const r = parse('terravigna-211343.txt');
    expect(r.positionenErkannt).toBe(true);
    expect(r.lieferungen.length).toBeGreaterThanOrEqual(3);
    expect(r.lieferungen[0].datum).toBe('2026-07-09');
    const erste = r.lieferungen[0].positionen[0];
    expect(erste.artNr).toBe('21111-24-075');
    expect(erste.preis).toBeCloseTo(147.9 / 12, 2);
    const summe = Math.round(r.lieferungen.reduce((s, l) => s + l.nettoTotal, 0) * 100) / 100;
    expect(Math.abs(summe - 2339.69)).toBeLessThanOrEqual(0.05);
  });
});

describe('Erkennung', () => {
  it('eigene MWST-Nr (Beaulieu) matcht nie als Lieferant', () => {
    const { profil } = findeProfilImText('Kundennummer / MWST-Nr. 236257 / CHE336566594 MWST', P);
    expect(profil).toBeNull();
  });
  it('unbekannte MWST-Nr ⇒ Lieferant offen, Nr wird gemeldet', () => {
    const r = parseProfilPdf('Rechnung Nr. 1234 vom 01.07.2026\nCHE-999.888.777 MWST\nTotal CHF 100.00', P);
    expect(r.profil).toBeNull();
    expect(r.mwstNrn).toContain('999888777');
  });
});

describe('erkenneDokumenttyp (inhaltsbasiert, Dual-Lieferanten)', () => {
  it('Sammel-/Monatsrechnung im Kopf → monatsrechnung (auch mit nur 1 Lieferung)', () => {
    expect(erkenneDokumenttyp('Spahni AG\nSammelrechnung Nr. 4711\n...', 'rechnung')).toBe('monatsrechnung');
    expect(erkenneDokumenttyp('Fideco\nMonatsrechnung Juni 2026\n...', 'rechnung')).toBe('monatsrechnung');
  });
  it('Lieferschein-Überschrift → lieferschein (auch bei mehreren LS-Nr-Blöcken)', () => {
    expect(erkenneDokumenttyp('Gasser Getränke\nLieferschein\nLS-Nr. 111 vom 01.06.26\nLS-Nr. 112 vom 02.06.26', 'rechnung')).toBe('lieferschein');
  });
  it('Nicht-Rechnung (AB/Offerte/Bestellung) → lieferschein (provisorisch)', () => {
    expect(erkenneDokumenttyp('Terravigna\nAuftragsbestätigung 99\n...', 'auftragsbestaetigung')).toBe('lieferschein');
  });
  it('kein Kopf-Signal → null (Aufrufer nutzt Zusatzsignale)', () => {
    expect(erkenneDokumenttyp('Spahni AG\nRechnung Nr. 123\nLS-Nr. 1 vom 01.06.26\nLS-Nr. 2 vom 02.06.26', 'rechnung')).toBe(null);
  });
  it('«LS-Nr…» / «Liefersch./Kd.-Nr.» sind KEINE Lieferschein-Überschrift', () => {
    expect(erkenneDokumenttyp('Rechnung 55\nLiefersch./Kd.-Nr. : 123 / XBEA\n...', 'rechnung')).toBe(null);
  });
  it('Fusstext ausserhalb der Kopfzone bestimmt den Typ nicht', () => {
    const fuss = Array.from({ length: 40 }, (_, i) => `Zeile ${i}`).join('\n') + '\nSammelrechnung folgt separat';
    expect(erkenneDokumenttyp(`Rechnung 1\n${fuss}`, 'rechnung')).toBe(null);
  });
});

describe('erkenneBelegart: Kopfzone entscheidet', () => {
  it('AB-Überschrift + «Rechnung» nur im Fuss-/Zahltext bleibt AB (provisorisch)', () => {
    const fuss = Array.from({ length: 30 }, (_, i) => `Zeile ${i}`).join('\n');
    const text = `Terravigna\nAuftragsbestätigung Nr. 99\n${fuss}\nDie Rechnung Nr. 123456 folgt per Monatsende.`;
    expect(erkenneBelegart(text)).toBe('auftragsbestaetigung');
  });
  it('Rechnungs-Kopf gewinnt weiterhin in der Kopfzone', () => {
    expect(erkenneBelegart('Spahni AG\nRechnung Nr. 4711\n...')).toBe('rechnung');
  });
  it('ohne Kopf-Signal zählt der Gesamttext (Sperre bleibt erhalten)', () => {
    const kopf = Array.from({ length: 30 }, (_, i) => `Kopfzeile ${i}`).join('\n');
    expect(erkenneBelegart(`${kopf}\nVerkauf Auftragsbestätigung 77`)).toBe('auftragsbestaetigung');
  });
});

describe('erkenneDokumenttyp: Kombiform «Sammel-/Monatsrechnung»', () => {
  it('Slash-Kombiform im Kopf → monatsrechnung', () => {
    expect(erkenneDokumenttyp('Fideco\nSammel-/Monatsrechnung Juni\n...', 'rechnung')).toBe('monatsrechnung');
  });
});
