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
import { positionenAusRechnung, kontoSplitsAusPositionen } from '@/lib/waren-positionen';
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
  it('Terravigna AB 145313: Positionen, MwSt je Position, Lieferdatum 02.08.26', () => {
    const r = parse('terravigna-ab-145313.txt');
    expect(r.belegart).toBe('auftragsbestaetigung');
    expect(r.profil?.id).toBe('terravigna');
    expect(r.rechnungsNr).toBe('145313');
    expect(r.netto).toBe(2746.8);
    expect(r.brutto).toBe(2963.4);
    expect(r.mwst).toBe(216.6);
    expect(r.lieferdatum).toBe('2026-08-02');
    expect(r.dokumenttyp).toBe('lieferschein');
    // Stufe 2: EINE Lieferung, AB-Nr = Identität, Positionen für die Historie.
    expect(r.positionenErkannt).toBe(true);
    expect(r.lieferungen).toHaveLength(1);
    expect(r.lieferungen[0].rechnungsNr).toBe('145313');
    expect(r.lieferungen[0].datum).toBe('2026-08-02');
    expect(r.lieferungen[0].positionen).toHaveLength(4);
    expect(r.lieferungen[0].nettoTotal).toBe(2746.8);
    // Keine Summen-Warnung (Positionssumme = Netto).
    expect(r.hinweise.join(' ')).not.toContain('Positionssumme');
    const p1 = r.lieferungen[0].positionen[0];
    expect(p1.artNr).toBe('21111-24-075');
    expect(p1.menge).toBe(60);
    expect(p1.einheit).toBe('75 cl');
    expect(p1.bezeichnung).toBe('Chardonnay Réserve');
    expect(p1.preis).toBe(24);
    expect(p1.positionspreis).toBe(1440);
    // MwSt je Position: 8.1 % Wein, 2.6 % alkoholfrei.
    expect(p1.mwstBetrag).toBeCloseTo(116.64, 2);
    const mineral = r.lieferungen[0].positionen[3];
    expect(mineral.mwstBetrag).toBeCloseTo(2.78, 2);
  });
  it('Terravigna AB 145536: Feld «Lieferdatum» leer → Fallback Belegdatum 08.08.26', () => {
    const r = parse('terravigna-ab-145536.txt');
    expect(r.rechnungsNr).toBe('145536');
    expect(r.netto).toBe(430.4);
    expect(r.brutto).toBe(465.25);
    expect(r.lieferdatum).toBe('2026-08-08');
    expect(r.lieferungen).toHaveLength(1);
    expect(r.lieferungen[0].datum).toBe('2026-08-08');
    expect(r.lieferungen[0].positionen).toHaveLength(2);
    expect(r.lieferungen[0].nettoTotal).toBe(430.4);
  });
  it('Terravigna AB 145095 (altes Layout ohne MwSt-Spalte): Stufe 2 weiterhin ok', () => {
    const r = parse('terravigna-ab-145095.txt');
    expect(r.lieferungen).toHaveLength(1);
    expect(r.lieferungen[0].rechnungsNr).toBe('145095');
    expect(r.lieferungen[0].datum).toBe('2026-07-28'); // Belegdatum-Fallback
    expect(r.lieferungen[0].positionen).toHaveLength(3);
    expect(r.lieferungen[0].nettoTotal).toBe(828.39);
    expect(r.lieferungen[0].positionen[0].bezeichnung).toBe('Chardonnay Réserve');
  });
  it('Terravigna RECHNUNG ohne Lieferungsnr.-Blöcke: referenzierte AB-Nr erzeugt KEINE Lieferung', () => {
    // Rechnung, deren «Lieferungsnr.»-Blöcke nicht erkannt werden, aber eine
    // AB-Nr referenziert — darf NIE als AB-Lieferung geparst werden.
    const text = [
      'TERRAVIGNA AG', 'CHE-108.008.709 MWST', '',
      'Rechnung 211999', 'Belegdatum 31.08.26',
      'Gemäss Auftragsbestätigung 145313',
      'Pos  Artikel        Menge          Bezeichnung        Preis   Betrag',
      '1    21111-24-075   12 75 cl       Chardonnay         14.50   174.00',
      "Total CHF ohne MwSt.  174.00", 'Total CHF inkl. MwSt.  188.09',
    ].join('\n');
    const r = parseProfilPdf(text, P);
    expect(r.belegart).toBe('rechnung');
    expect(r.lieferungen).toHaveLength(0);
    expect(r.rechnungsNr).toBe('211999');
  });
  it('Terravigna AB: Rabatt-% UND MwSt-Spalte kombiniert', () => {
    const text = [
      'TERRAVIGNA AG', 'CHE-108.008.709 MWST', '',
      'Verkauf Auftragsbestätigung 145600',
      'Belegdatum 10.08.26', 'Lieferdatum 12.08.26',
      '1    21111-24-075   12 75 cl   Chardonnay Réserve   17.06   15   8.1   174.00',
      "Total CHF ohne MwSt.  174.00", 'Total CHF inkl. MwSt.  188.09',
    ].join('\n');
    const r = parseProfilPdf(text, P);
    expect(r.lieferungen).toHaveLength(1);
    const p = r.lieferungen[0].positionen[0];
    expect(p.positionspreis).toBe(174);
    expect(p.preis).toBe(14.5); // effektiver Stückpreis nach Rabatt
    expect(p.mwstBetrag).toBeCloseTo(14.09, 2);
    expect(r.lieferungen[0].datum).toBe('2026-08-12');
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
      'obrist-326269.txt', 'blaser-1088741.txt',
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
  it('Gourmador Stufe 2: 12 «Beleg-Nr.»-Lieferungen, Summe = Rechnungs-Netto (mehrseitensicher)', () => {
    const r = parse('gourmador-92051534.txt');
    expect(r.positionenErkannt).toBe(true);
    expect(r.lieferungen).toHaveLength(12);
    expect(r.lieferungen[0].rechnungsNr).toBe('53878917');
    expect(r.lieferungen[0].datum).toBe('2026-06-01');
    expect(r.lieferungen[0].nettoTotal).toBe(266.00);
    // Block über Seitenumbruch (13.06.: 4 Positionen)
    const l13 = r.lieferungen.find(l => l.datum === '2026-06-13')!;
    expect(l13.positionen).toHaveLength(4);
    expect(l13.nettoTotal).toBe(311.60);
    const summe = r.lieferungen.reduce((s, l) => s + l.nettoTotal, 0);
    expect(Math.round(summe * 100) / 100).toBe(2822.15);
    // Letzte Lieferung 30.06. = 40.95 (einzelne Position nach Seitenkopf)
    expect(r.lieferungen[11].datum).toBe('2026-06-30');
    expect(r.lieferungen[11].nettoTotal).toBe(40.95);
  });
  it('Gourmador 91886189: ALLE 15 Belege inkl. Tagesdopplungen, 3-stellige Art-Nrn und IFCO-Retouren — Summe = «Gesamtbetrag exkl. MwSt.»', () => {
    const r = parse('gourmador-91886189.txt');
    expect(r.profil?.id).toBe('gourmador');
    expect(r.netto).toBe(1461.75); // Total Warenwert 1'458.55 + Total Gebindewert 3.20
    expect(r.lieferungen).toHaveLength(15);
    // Zeilensumme MUSS auf das exkl.-MwSt-Total reconcilen → kein Prüf-Hinweis.
    const summe = r.lieferungen.reduce((s, l) => s + l.nettoTotal, 0);
    expect(Math.round(summe * 100) / 100).toBe(1461.75);
    expect(r.hinweise.some(h => /Positionssumme/.test(h))).toBe(false);
    // Tagesdopplung 13.01.: DREI eigenständige Belege (kein Zusammenfassen).
    const jan13 = r.lieferungen.filter(l => l.datum === '2026-01-13');
    expect(jan13.map(l => l.rechnungsNr).sort()).toEqual(['53532089', '53532090', '53532091']);
    // 3-stellige Art-Nrn («131 Salat», «834 Peperoni») werden erfasst:
    expect(jan13.find(l => l.rechnungsNr === '53532089')!.nettoTotal).toBe(104.32);
    expect(jan13.find(l => l.rechnungsNr === '53532091')!.nettoTotal).toBe(20.10);
    // Tagesdopplung 21.01.: ZWEI Belege.
    expect(r.lieferungen.filter(l => l.datum === '2026-01-21')).toHaveLength(2);
    // IFCO-Retourzeilen (negativ) neutralisieren die Lieferzeile im Beleg;
    // der offene Gebinde-Saldo (24.01., +3.20) bleibt stehen.
    const l24 = r.lieferungen.find(l => l.datum === '2026-01-24')!;
    expect(l24.nettoTotal).toBe(38.84); // 35.64 Ware + 3.20 IFCO-Saldo
  });
  it('IFCO-Gebinde-Position → Pfand-Regel (Konto 4800), Ware bleibt auf dem Warenkonto', () => {
    const r = parse('gourmador-91886189.txt');
    const l24 = r.lieferungen.find(l => l.datum === '2026-01-24')!;
    const gespeichert = positionenAusRechnung(l24, []);
    const ifco = gespeichert.find(p => /IFCO/i.test(p.bezeichnung))!;
    expect(ifco.status).toBe('pfand');
    const splits = kontoSplitsAusPositionen(gespeichert.map(p => ({
      ...p, konto: p.status === 'zugeordnet' ? p.konto : null,
    })));
    expect(splits.find(s => s.warenkonto === '4800')?.amountNet).toBe(3.20);
  });
  it('Bohnenblust 49415: 29 Belege (inkl. 2 Nachlieferungen), Summe = Zwischentotal 823.37, MwSt 2.6%', () => {
    const r = parse('bohnenblust-49415.txt');
    expect(r.profil?.id).toBe('bohnenblust');
    expect(r.rechnungsNr).toBe('49415');
    expect(r.rechnungsdatum).toBe('2026-07-31');
    expect(r.netto).toBe(823.37);
    expect(r.mwst).toBe(21.41);
    expect(r.dokumenttyp).toBe('monatsrechnung');
    expect(r.lieferungen).toHaveLength(29);
    const summe = r.lieferungen.reduce((s, l) => s + l.nettoTotal, 0);
    expect(Math.round(summe * 100) / 100).toBe(823.37);
    expect(r.hinweise).toHaveLength(0);
    // Nachlieferungen sind EIGENSTÄNDIGE Belege (Identität = Beleg-Nr) — auch
    // am selben Tag wie ein Lieferschein (08.07.: 497327 + Nachlieferung 497337).
    const nach = r.lieferungen.find(l => l.rechnungsNr === '497337')!;
    expect(nach.datum).toBe('2026-07-08');
    expect(nach.nettoTotal).toBe(77.00); // 50× Brioches — umgebrochene Zeile («Sesam») ist KEINE Position
    expect(nach.positionen).toHaveLength(1);
    expect(r.lieferungen.filter(l => l.datum === '2026-07-08')).toHaveLength(2);
    expect(r.lieferungen.find(l => l.rechnungsNr === '498125')!.nettoTotal).toBe(61.60);
    // Beleg-Kopf-«Total 84.59» ist die Beleg-Summe, keine Position:
    const erste = r.lieferungen.find(l => l.rechnungsNr === '496561')!;
    expect(erste.nettoTotal).toBe(84.59);
    expect(erste.positionen).toHaveLength(4);
  });
  it('Bohnenblust 49300 (produktive Zeilenrekonstruktion, Einzel-Leerzeichen): 2 Belege, 277.20', () => {
    const r = parse('bohnenblust-49300.txt');
    expect(r.profil?.id).toBe('bohnenblust');
    expect(r.netto).toBe(277.20);
    expect(r.dokumenttyp).toBe('monatsrechnung');
    expect(r.lieferungen).toHaveLength(2);
    const summe = r.lieferungen.reduce((s, l) => s + l.nettoTotal, 0);
    expect(Math.round(summe * 100) / 100).toBe(277.20);
    expect(r.hinweise).toHaveLength(0);
  });
  it('Bohnenblust Einzel-Lieferschein (ohne «Rechnungsnummer:») bleibt lieferschein — Override greift nicht', () => {
    const text = [
      'Abs: Bäckerei Bohnenblust AG, Moserstrasse 50, 3014 Bern',
      'CHE-472.136.586 MWST',
      'Lieferschein Nr. 499999 vom 05.08.2026  Total 18.33',
      '1  Baslerbrot 1000g Teiggewicht  BW.08.06  6.42  6.42',
      '1  Halbweissbrot lang 500g  BW.02.10  2.59  2.59',
      '2  Halbweissbrot 1000g  BW.02.05  4.66  9.32',
    ].join('\n');
    const r = parseProfilPdf(text, P);
    expect(r.profil?.id).toBe('bohnenblust');
    expect(r.dokumenttyp).not.toBe('monatsrechnung');
    expect(r.lieferungen).toHaveLength(1);
    expect(r.lieferungen[0].nettoTotal).toBe(18.33);
  });
  it('Bohnenblust 4-teilige Artikelnummer (BW.90.00.3, Rechnung 48162/LS 489707): Position wird erkannt', () => {
    const text = [
      'Abs: Bäckerei Bohnenblust AG, Moserstrasse 50, 3014 Bern',
      'Restaurant Beaulieu AG',
      'CHE-472.136.586 MWST',
      'Rechnungsnummer: 48162  30.04.2026',
      'Kunden-Nr. 9865.2',
      'Lieferschein Nr. 489707 vom 24.04.2026  Total 96.35',
      '1  Baslerbrot 1000g Teiggewicht  BW.08.06  6.42  6.42',
      '40  Brioches Hamburger 14cm mit  BW.90.00.3  1.79  71.60',
      'Sesam',
      '2  Zopf 500g  BW.30.05  9.17  18.33',
      'Zwischentotal CHF  96.35',
      '2.6% MwSt. aus Betrag von CHF 96.35  CHF 2.51',
    ].join('\n');
    const r = parseProfilPdf(text, P);
    expect(r.profil?.id).toBe('bohnenblust');
    expect(r.dokumenttyp).toBe('monatsrechnung');
    expect(r.lieferungen).toHaveLength(1);
    const ls = r.lieferungen[0];
    expect(ls.rechnungsNr).toBe('489707');
    expect(ls.positionen).toHaveLength(3);
    const brioches = ls.positionen.find(p => p.artNr === 'BW.90.00.3')!;
    expect(brioches.positionspreis).toBe(71.60);
    expect(ls.nettoTotal).toBe(96.35);
    expect(r.hinweise).toHaveLength(0);
  });
  it('Profil Bohnenblust: dual + monatsrechnung + parser, Konto 4060, MWST-Nr 472136586', () => {
    const bb = P.find(p => p.id === 'bohnenblust')!;
    expect(bb.mwstNr).toBe('472136586');
    expect(bb.konto).toBe('4060');
    expect(bb.parser).toBe('bohnenblust');
    expect(bb.belegtyp).toBe('dual');
    expect(bb.monatsrechnung).toBe(true);
  });
  it('Gourmador-Faktura ist IMMER Monatsrechnung — auch mit nur EINER Beleg-Nr-Lieferung', () => {
    const voll = fx('gourmador-92051534.txt');
    // Kunstfall: nur der erste Beleg-Block bleibt übrig (eine Lieferung).
    const einzel = voll.slice(0, voll.indexOf('Beleg-Nr.         53881846'))
      + voll.slice(voll.indexOf('Total aller Warengruppen'));
    const r = parseProfilPdf(einzel, P);
    expect(r.profil?.id).toBe('gourmador');
    expect(r.belegart).toBe('rechnung');
    expect(r.lieferungen).toHaveLength(1);
    expect(r.dokumenttyp).toBe('monatsrechnung');
  });
  it('Profil Gourmador: dual + monatsrechnung + parser (4060), Terravigna 4020 ohne Split', () => {
    const gourmador = P.find(p => p.id === 'gourmador')!;
    expect(gourmador.belegtyp).toBe('dual');
    expect(gourmador.monatsrechnung).toBe(true);
    expect(gourmador.parser).toBe('gourmador');
    expect(gourmador.konto).toBe('4060');
    const terravigna = P.find(p => p.id === 'terravigna')!;
    expect(terravigna.belegtyp).toBe('dual');
    expect(terravigna.konto).toBe('4020');
    const spahni = P.find(p => p.id === 'spahni')!;
    expect(spahni.belegtyp).toBe('dual');
    expect(spahni.monatsrechnung).toBe(true);
    expect(spahni.konto).toBe('4060');
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
  it('Obrist 327503 (Kontrolle): netto 267.75 / brutto 289.44, Lieferdatum aus «vom», Beleg 13.07.', () => {
    const r = parse('obrist-327503.txt');
    expect(r.profil?.id).toBe('obrist');
    expect(r.rechnungsNr).toBe('327503');
    expect(r.netto).toBe(267.75);
    expect(r.brutto).toBe(289.44);
    expect(r.mwstSatz).toBe(8.1);
    expect(r.lieferdatum).toBe('2026-07-10');
    expect(r.rechnungsdatum).toBe('2026-07-13');
    // Gebinde 0.00 ⇒ kein Depot-Hinweis
    expect(r.hinweise.join(' ')).not.toContain('Gebinde');
  });
  it('Obrist: «Total Gebinde CHF» > 0 ⇒ Depot-Hinweis, Netto bleibt ohne Gebinde', () => {
    const text = fx('obrist-327503.txt').replace('Total Gebinde CHF  0.00', 'Total Gebinde CHF  24.00');
    const r = parseProfilPdf(text, P);
    expect(r.netto).toBe(267.75);
    expect(r.hinweise.join(' ')).toContain('Gebinde CHF 24.00');
  });
  it('The Asia Company 297454 (Kontrolle): netto 866.50 / brutto 889.05 (2.6%), Kontierung 420xx ok', () => {
    const r = parse('asia-297454.txt');
    expect(r.profil?.id).toBe('asia');
    expect(r.rechnungsNr).toBe('297454');
    expect(r.netto).toBe(866.5);
    expect(r.mwst).toBe(22.55);
    expect(r.brutto).toBe(889.05);
    expect(r.mwstSatz).toBe(2.6);
    expect(r.rechnungsdatum).toBe('2026-05-15'); // «Münchenstein, 15. Mai 2026»
    expect(r.lieferdatum).toBe('2026-05-07');    // «Lieferung Nr. VW108357 vom 07.05.26»
    expect(r.belegart).toBe('rechnung');
    // Alle Kontierungscodes 420xx (Küche) ⇒ keine Konto-Warnung
    expect(r.hinweise.join(' ')).not.toContain('Konto prüfen');
    expect(r.hinweise.join(' ')).not.toContain('Summe Kontierung');
  });
  it('The Asia Company: fremder Kontierungscode wird gemeldet', () => {
    const text = fx('asia-297454.txt').replace(
      '42020  Fleisch, Comestibles, Wurstwaren  2.6 %  160.00  4.16  164.16',
      '42880  Non-Food  2.6 %  160.00  4.16  164.16');
    const r = parseProfilPdf(text, P);
    expect(r.hinweise.join(' ')).toContain('42880');
    expect(r.hinweise.join(' ')).toContain('Konto prüfen');
  });
  it('Rutishauser ist wieder aktiv (08/2026): 91091909 → Profil rutishauser/4020', () => {
    const r = parse('rutishauser-91091909.txt');
    expect(r.profil?.id).toBe('rutishauser');
    expect(r.profil?.konto).toBe('4020');
  });
  it('Bohnenblust wird via MWST-Nr 472136586 erkannt (seit 08/2026 PDF-Import statt nur manuell)', () => {
    const r = parse('bohnenblust-49415.txt');
    expect(r.profil?.id).toBe('bohnenblust');
    expect(r.profil?.konto).toBe('4060');
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

describe('Gasser Stufe 2 (Sammelrechnung, LS-Blöcke je Tag)', () => {
  it('F0122084: 6 Lieferungen, Σ Positionen = Belegbetrag 1419.90', () => {
    const r = parse('gasser-f0122084.txt');
    expect(r.profil?.id).toBe('gasser');
    expect(r.positionenErkannt).toBe(true);
    expect(r.lieferungen).toHaveLength(6);
    expect(r.lieferungen[0].rechnungsNr).toBe('2184897');
    expect(r.lieferungen[0].datum).toBe('2026-06-01');
    expect(r.lieferungen[0].nettoTotal).toBe(119.7);
    const summe = Math.round(r.lieferungen.reduce((s, l) => s + l.nettoTotal, 0) * 100) / 100;
    expect(Math.abs(summe - 1419.9)).toBeLessThanOrEqual(0.05);
  });
  it('F0122536: 8 Lieferungen über 2 Seiten (Übertrag), Σ = 1635.00; letzter LS 30.07. = 239.90', () => {
    const r = parse('gasser-f0122536.txt');
    expect(r.positionenErkannt).toBe(true);
    expect(r.lieferungen).toHaveLength(8);
    const letzte = r.lieferungen[r.lieferungen.length - 1];
    expect(letzte.rechnungsNr).toBe('2187766');
    expect(letzte.datum).toBe('2026-07-30');
    expect(letzte.nettoTotal).toBe(239.9);
    const summe = Math.round(r.lieferungen.reduce((s, l) => s + l.nettoTotal, 0) * 100) / 100;
    expect(Math.abs(summe - 1635.0)).toBeLessThanOrEqual(0.05);
  });
});

describe('Neue/reaktivierte Profile (08/2026)', () => {
  it('Rutishauser-DiVino wieder aktiv: MWST 116319519 → Wein/4020/8.1', () => {
    const p = P.find(x => x.id === 'rutishauser');
    expect(p?.mwstNr).toBe('116319519');
    expect(p?.konto).toBe('4020');
    expect(p?.mwstSatz).toBe(8.1);
  });
  it('Schenk Suisse via MWST 219630115 → 4020 (Profil obrist)', () => {
    const p = P.find(x => x.mwstNr === '219630115');
    expect(p?.id).toBe('obrist');
    expect(p?.konto).toBe('4020');
  });
  it('Gasser: Sammelrechnungs-Parser + dual', () => {
    const p = P.find(x => x.id === 'gasser');
    expect(p?.parser).toBe('gasser');
    expect(p?.belegtyp).toBe('dual');
    expect(p?.konto).toBe('4060');
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
  it('Spahni-Kopf-Fallback: LS ohne MWST-Nr via Kd.-Nr. XBEA erkannt', () => {
    const text = 'LIEFERSCHEIN\nLiefersch./Kd.-Nr. : 5210840 / XBEA\nLieferdatum : 04.08.26\n'
      + 'Restaurant Beaulieu AG\nErlachstrasse 3\n3012 Bern\n'
      + 'Art.Nr. Bezeichnung\n01250 Rindsentrecôte 4.500 KG 43.90 197.55 1\nTotal CHF 197.55';
    const { profil } = findeProfilImText(text, P);
    expect(profil?.id).toBe('spahni');
  });
  it('Spahni-Kopf-Fallback: Firmenname «Metzgerei Spahni AG» im Kopf erkannt', () => {
    const { profil } = findeProfilImText('Metzgerei Spahni AG\nLIEFERSCHEIN 5212687\nRestaurant Beaulieu AG', P);
    expect(profil?.id).toBe('spahni');
  });
  it('Kopf-Fallback greift NICHT für Fusstext (Token ausserhalb der Kopfzone)', () => {
    const zeilen = Array.from({ length: 30 }, (_, i) => `Zeile ${i + 1} irgendein Inhalt`);
    const { profil } = findeProfilImText(zeilen.join('\n') + '\nFusszeile: Kd.-Nr. XBEA', P);
    expect(profil).toBeNull();
  });
  it('völlig unbekannter Lieferant ohne MWST-Nr bleibt offen (kein Raten)', () => {
    const { profil } = findeProfilImText('LIEFERSCHEIN\nIrgendeine Firma GmbH\nKd.-Nr. : 12345\nTotal CHF 50.00', P);
    expect(profil).toBeNull();
  });
  it('MWST-Nr hat Vorrang: fremde bekannte Nr gewinnt trotz XBEA im Kopf', () => {
    const { profil } = findeProfilImText('Rechnung 999\nCHE-112.839.932 MWST\nKd.-Nr. XBEA', P);
    expect(profil?.id).toBe('fideco');
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

describe('Espro/Amarx (Deko → 4701): Monats-Sammelrechnung mit Tageslieferungen', () => {
  it('125854 (Jan): Profil erkannt via MWST-Nr, Kopf netto 400.00 / MwSt 10.40', () => {
    const r = parse('espro-125854.txt');
    expect(r.profil?.id).toBe('espro');
    expect(r.profil?.konto).toBe('4701');
    expect(r.rechnungsNr).toBe('125854');
    expect(r.rechnungsdatum).toBe('2026-01-31');
    expect(r.netto).toBe(400.00);
    expect(r.mwst).toBe(10.40);
    expect(r.mwstSatz).toBe(2.6);
  });
  it('125854: 8 Tageslieferungen, Σ = Rechnungsnetto, mehrseitensicher', () => {
    const r = parse('espro-125854.txt');
    expect(r.lieferungen).toHaveLength(8);
    const summe = Math.round(r.lieferungen.reduce((s, l) => s + l.nettoTotal, 0) * 100) / 100;
    expect(summe).toBe(400.00);
    // Block über Seitenumbruch (177361.1 vom 19.01.): vollständig mit 50.00.
    const l19 = r.lieferungen.find(l => l.rechnungsNr === '177361.1')!;
    expect(l19.datum).toBe('2026-01-19');
    expect(l19.nettoTotal).toBe(50.00);
    // Alle Positionen in der Deko-Warengruppe (→ 4701 via Profil-Mapping).
    for (const l of r.lieferungen) for (const p of l.positionen) expect(p.warengruppe).toBe('Deko');
  });
  it('126580 (April): netto 232.65, Σ Lieferungen = Rechnungsnetto', () => {
    const r = parse('espro-126580.txt');
    expect(r.profil?.id).toBe('espro');
    expect(r.rechnungsNr).toBe('126580');
    const summe = Math.round(r.lieferungen.reduce((s, l) => s + l.nettoTotal, 0) * 100) / 100;
    expect(summe).toBe(r.netto);
    expect(Math.round(((r.netto ?? 0) + (r.mwst ?? 0)) * 100) / 100).toBe(238.70);
  });
});
