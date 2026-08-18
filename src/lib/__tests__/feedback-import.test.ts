// @vitest-environment node
/**
 * feedback-import — Feedback-CSV (Lunchgate): Parser (BOM, «;», mehrzeilige
 * Quotes), kaufmännische Sterne-Rundung, Upsert-Schlüssel und die Vorschau
 * «X neu · Y aktualisiert · Z unverändert» (Ersetzen statt Duplikat).
 */
import { describe, it, expect } from 'vitest';
import {
  parseCsvRecords, parseFeedbackCsv, parseFeedbackDate, roundToStars,
  feedbackImportKey, buildFeedbackPreview, FEEDBACK_PLATFORM,
} from '../feedback-import';
import type { SingleReview } from '../reviews-store';

const HEAD = 'Publish Date;Pax;Guest;Reservation Date;Average;Service;Kitchen;Atmosphere;Performance;Comment';

describe('parseCsvRecords', () => {
  it('BOM, «;», Quotes mit «""»-Escape und mehrzeilige Felder', () => {
    const txt = '\uFEFFa;b\r\n"x;y";"Zeile 1\nZeile 2 ""zitiert"""\n';
    const rec = parseCsvRecords(txt);
    expect(rec).toEqual([['a', 'b'], ['x;y', 'Zeile 1\nZeile 2 "zitiert"']]);
  });
});

describe('parseFeedbackDate / roundToStars', () => {
  it('dd.MM.yyyy und yyyy-MM-dd (mit Uhrzeit) → yyyy-MM-dd', () => {
    expect(parseFeedbackDate('28.07.2026')).toBe('2026-07-28');
    expect(parseFeedbackDate('2026-07-28 18:30')).toBe('2026-07-28');
    expect(parseFeedbackDate('quatsch')).toBeNull();
  });
  it('echtes Lunchgate-Format «31 Jul 2026 09:47» (EN/DE Monatsnamen)', () => {
    expect(parseFeedbackDate('31 Jul 2026 09:47')).toBe('2026-07-31');
    expect(parseFeedbackDate('29 Jul 2026 14:36')).toBe('2026-07-29');
    expect(parseFeedbackDate('1 Dec 2025')).toBe('2025-12-01');
    expect(parseFeedbackDate('5 Mär 2026 12:00')).toBe('2026-03-05');
    expect(parseFeedbackDate('5 Okt. 2026')).toBe('2026-10-05');
    expect(parseFeedbackDate('31 Xyz 2026 09:47')).toBeNull();
  });
  it('kalender-validiert: 31 Feb / 29 Feb im Nicht-Schaltjahr ⇒ null; 29 Feb Schaltjahr OK', () => {
    expect(parseFeedbackDate('31 Feb 2026')).toBeNull();
    expect(parseFeedbackDate('29 Feb 2026')).toBeNull();   // 2026 kein Schaltjahr
    expect(parseFeedbackDate('29 Feb 2028')).toBe('2028-02-29'); // Schaltjahr
    expect(parseFeedbackDate('31.02.2026')).toBeNull();    // numerischer Pfad ebenfalls
    expect(parseFeedbackDate('2026-02-31')).toBeNull();
  });
  it('kaufmännisch: 4.5→5, 3.8→4, 2.3→2; 0/ungültig → null', () => {
    expect(roundToStars(4.5)).toBe(5);
    expect(roundToStars(3.8)).toBe(4);
    expect(roundToStars(2.3)).toBe(2);
    // halbeAbrunden (Beaulieu): exakte Halbwerte werden ABgerundet
    expect(roundToStars(4.5, true)).toBe(4);
    expect(roundToStars(3.5, true)).toBe(3);
    expect(roundToStars(0.5, true)).toBe(1); // Klemme auf 1
    expect(roundToStars(3.8, true)).toBe(4); // nur .5 betroffen
    expect(roundToStars(4, true)).toBe(4);
    expect(roundToStars(0)).toBeNull();
    expect(roundToStars(6)).toBeNull();
  });
});

describe('parseFeedbackCsv', () => {
  it('parst Zeilen inkl. Teilnoten, Komma-Dezimal und mehrzeiligem Kommentar', () => {
    const csv = `\uFEFF${HEAD}\n28.07.2026;4;Anna Muster;27.07.2026;4,5;5;4;5;4;"Super!\nGerne wieder."`;
    const res = parseFeedbackCsv(csv);
    expect(res.failureReason).toBeNull();
    expect(res.rows).toHaveLength(1);
    const r = res.rows[0];
    expect(r).toMatchObject({
      publishDate: '2026-07-28', visitDate: '2026-07-27', guest: 'Anna Muster',
      pax: 4, average: 4.5, stars: 5, comment: 'Super!\nGerne wieder.',
      subRatings: { service: 5, kitchen: 4, atmosphere: 5, performance: 4 },
    });
  });
  it('fehlende Pflichtspalten → failureReason mit gefundenen Headern (Diagnose)', () => {
    const res = parseFeedbackCsv('Datum;Note\n1.1.2026;5');
    expect(res.rows).toHaveLength(0);
    expect(res.failureReason).toContain('Publish Date');
    expect(res.debug.headers).toEqual(['Datum', 'Note']);
  });
  it('ungültige Zeilen werden mit Grund übersprungen, Rest bleibt', () => {
    const csv = `${HEAD}\nkaputt;;X;;4;;;;;ok\n28.07.2026;;Y;;3.8;;;;;ok`;
    const res = parseFeedbackCsv(csv);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].stars).toBe(4);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toContain('Publish Date');
  });
  it('datei-interne Dubletten (gleicher Schlüssel): letzte Zeile gewinnt, nur 1 Eintrag', () => {
    const csv = `${HEAD}\n28.07.2026;2;Anna;27.07.2026;4;;;;;alt\n28.07.2026;2;Anna;27.07.2026;5;;;;;neu`;
    const res = parseFeedbackCsv(csv);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].comment).toBe('neu');
    expect(res.rows[0].stars).toBe(5);
  });
});

describe('feedbackImportKey', () => {
  it('Publish Date + Gast (normalisiert) + Reservationsdatum', () => {
    expect(feedbackImportKey('2026-07-28', '  Anna  Muster ', '2026-07-27', 'raw'))
      .toBe('fb|2026-07-28|anna muster|2026-07-27');
  });
  it('ohne Gast (auch MIT Besuchsdatum) → Zeilen-Hash, keine Kollision anonymer Feedbacks', () => {
    const a = feedbackImportKey('2026-07-28', '', '2026-07-27', 'zeile;a;Kommentar 1');
    const b = feedbackImportKey('2026-07-28', '', '2026-07-27', 'zeile;b;Kommentar 2');
    expect(a).toMatch(/^fb\|hash\|/);
    expect(b).not.toBe(a);
  });
  it('ohne Gast und Besuchsdatum → stabiler Zeilen-Hash', () => {
    const a = feedbackImportKey('2026-07-28', '', undefined, 'zeile;x');
    expect(a).toMatch(/^fb\|hash\|/);
    expect(feedbackImportKey('2026-07-28', '', undefined, 'zeile;x')).toBe(a);
    expect(feedbackImportKey('2026-07-28', '', undefined, 'zeile;y')).not.toBe(a);
  });
});

describe('buildFeedbackPreview — Upsert (Ersetzen statt Duplikat)', () => {
  const csv = `${HEAD}\n28.07.2026;2;Anna;27.07.2026;4,5;;;;;Toll\n29.07.2026;3;Beat;28.07.2026;2.3;;;;;Naja`;
  const parsed = parseFeedbackCsv(csv).rows;

  it('leerer Bestand → alles neu, Sterne-Verteilung stimmt', () => {
    const p = buildFeedbackPreview(parsed, [], () => 'id-x');
    expect(p).toMatchObject({ neu: 2, aktualisiert: 0, unveraendert: 0 });
    expect(p.starDist[5]).toBe(1);
    expect(p.starDist[2]).toBe(1);
    expect(p.toWrite).toHaveLength(2);
    expect(p.toWrite[0].platform).toBe(FEEDBACK_PLATFORM);
    expect(p.toWrite[0].source).toBe('feedback_csv');
  });

  it('Re-Import derselben Datei → alles unverändert, nichts zu schreiben (idempotent)', () => {
    const first = buildFeedbackPreview(parsed, [], () => `id-${Math.random()}`);
    const p2 = buildFeedbackPreview(parsed, first.toWrite, () => 'id-neu');
    expect(p2).toMatchObject({ neu: 0, aktualisiert: 0, unveraendert: 2 });
    expect(p2.toWrite).toHaveLength(0);
  });

  it('geänderter Wert → aktualisiert MIT DERSELBEN ID (kein zweiter Eintrag)', () => {
    const first = buildFeedbackPreview(parsed, [], () => `id-${Math.random()}`);
    const changed = parseFeedbackCsv(csv.replace(';Toll', ';Jetzt anders')).rows;
    const p2 = buildFeedbackPreview(changed, first.toWrite, () => 'id-neu');
    expect(p2).toMatchObject({ neu: 0, aktualisiert: 1, unveraendert: 1 });
    expect(p2.toWrite).toHaveLength(1);
    const orig = first.toWrite.find(r => r.text === 'Toll') as SingleReview;
    expect(p2.toWrite[0].id).toBe(orig.id); // Ersetzen, nicht duplizieren
    expect(p2.toWrite[0].text).toBe('Jetzt anders');
  });

  it('zwei anonyme Zeilen (gleiche Daten, ohne Gast) → ZWEI Einträge, Re-Import idempotent', () => {
    const anon = `${HEAD}\n28.07.2026;2;;27.07.2026;5;;;;;Kommentar A\n28.07.2026;4;;27.07.2026;3;;;;;Kommentar B`;
    const rows = parseFeedbackCsv(anon).rows;
    expect(rows).toHaveLength(2);
    const p1 = buildFeedbackPreview(rows, [], () => `id-${Math.random()}`);
    expect(p1).toMatchObject({ neu: 2, aktualisiert: 0, unveraendert: 0 });
    const p2 = buildFeedbackPreview(parseFeedbackCsv(anon).rows, p1.toWrite, () => 'id-neu');
    expect(p2).toMatchObject({ neu: 0, aktualisiert: 0, unveraendert: 2 });
  });

  it('answered/screenshotPath des Bestands bleiben beim Aktualisieren erhalten', () => {
    const first = buildFeedbackPreview(parsed, [], () => `id-${Math.random()}`);
    const existing = first.toWrite.map(r =>
      r.text === 'Toll' ? { ...r, answered: true, screenshotPath: 't/x.jpg' } : r);
    const changed = parseFeedbackCsv(csv.replace(';Toll', ';Neu')).rows;
    const p2 = buildFeedbackPreview(changed, existing, () => 'id-neu');
    expect(p2.toWrite[0].answered).toBe(true);
    expect(p2.toWrite[0].screenshotPath).toBe('t/x.jpg');
  });
});

describe('parseFeedbackCsv — echter Lunchgate-Testinhalt (Datumsformat «31 Jul 2026 09:47»)', () => {
  it('parst 3 Zeilen inkl. mehrzeiligem Kommentar; Sterne 1/5/4', () => {
    const csv = '"Publish Date";Pax;Guest;"Reservation Date";Average;Service;Kitchen;Atmosphere;Performance;Comment\n'
      + '31 Jul 2026 09:47;2;Testgast A;30 Jul 2026 18:30;1.0;1;1;1;1;\n'
      + '29 Jul 2026 14:36;2;Testgast B;29 Jul 2026 11:30;4.5;4;5;5;4;\n'
      + '29 Jul 2026 09:35;5;Testgast C;28 Jul 2026 18:30;3.8;2;5;4;4;"Kommentar mit\nZeilenumbruch"\n';
    const p = parseFeedbackCsv(csv);
    expect(p.failureReason).toBeNull();
    expect(p.rows).toHaveLength(3);
    expect(p.rows[0]).toMatchObject({ publishDate: '2026-07-31', visitDate: '2026-07-30', guest: 'Testgast A', stars: 1 });
    expect(p.rows[1]).toMatchObject({ publishDate: '2026-07-29', stars: 5 }); // 4.5 kaufmännisch → 5
    expect(p.rows[2]).toMatchObject({ publishDate: '2026-07-29', stars: 4, comment: 'Kommentar mit\nZeilenumbruch' });
  });
});
