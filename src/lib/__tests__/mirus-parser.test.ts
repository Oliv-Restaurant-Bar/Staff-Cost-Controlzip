// @vitest-environment node
//
// Robustheits-Tests für den Mirus «Tägliche Stunden»-Parser (Ist-Stunden).
// Getestet wird der reine Kern `parseMirusRows(rows, fileName)` — kein XLSX/IO,
// daher kein Mock nötig. Beweist die Spec-Punkte:
//   1) Datum = Tageszahl aus Kopfzeile + Monat/Jahr aus Titel (NICHT Spaltenposition)
//   2) Wochentags-Gegenprobe stoppt den Import bei Off-by-one
//   3) Debug + failureReason auf allen Pfaden
import { describe, it, expect } from 'vitest';
import { parseMirusRows, checkWeekdays } from '@/lib/mirus-parser';

// Titelzeile wie im echten Export.
const title = (von: string, bis: string) =>
  [`Tägliche Stunden von ${von} bis ${bis}`];

describe('parseMirusRows — Teil-Export (nur 27.–28.07.2025)', () => {
  // Kopfzeile: Wochentag-Zeile ÜBER der Tageszahl-Zeile (wie echte Datei).
  // 27.07.2025 = So, 28.07.2025 = Mo.
  // WICHTIG: Die Stundenspalten stehen an Spaltenindex 3/4 (nicht 0/1) —
  // ein Parser, der «Spaltenposition = Tag» annimmt, würde auf Tag 1/2 landen.
  const rows: unknown[][] = [
    title('27.07.2025', '28.07.2025'),
    ['', '', '', 'So', 'Mo', 'Total'],
    ['', '', '', 27, 28, ''],
    ['1 Küche'],
    ['Momand Sajed', '', '', 7.7833, 8.0, 15.7833],
    ['2 Service'],
    ['Krauss Marion', '', '', 5.5, 0, 5.5], // 0 = kein Einsatz → nicht importieren
    ['Total Stunden', '', '', 13.28, 8.0, 21.28],
    ['Anzahl Mitarbeiter', '', '', 2, 1, ''],
  ];

  it('mappt Stunden auf 27./28.07. (Tageszahl), NICHT auf Tag 1/2 (Spaltenposition)', () => {
    const r = parseMirusRows(rows, 'Taegliche_Stunden.xls');
    expect(r.failureReason).toBeNull();
    const sajed = r.entries.filter(e => e.name === 'Momand Sajed');
    expect(sajed.map(e => e.date).sort()).toEqual(['2025-07-27', '2025-07-28']);
    // 7.7833 → auf 2 Dezimalen gerundet
    expect(sajed.find(e => e.date === '2025-07-27')!.hours).toBeCloseTo(7.78, 2);
    expect(sajed.find(e => e.date === '2025-07-28')!.hours).toBe(8);
    // KEIN Eintrag auf Januar/Tag-1-2:
    expect(r.entries.some(e => e.date === '2025-07-01' || e.date === '2025-07-02')).toBe(false);
  });

  it('Nullstunden erzwingen keinen Eintrag (nur Tage mit Einsatz)', () => {
    const r = parseMirusRows(rows, 'x.xls');
    const marion = r.entries.filter(e => e.name === 'Krauss Marion');
    expect(marion.map(e => e.date)).toEqual(['2025-07-27']); // 28. war 0 → kein Eintrag
  });

  it('überspringt Kostenstellen-/Summen-/Anzahl-Zeilen', () => {
    const r = parseMirusRows(rows, 'x.xls');
    const names = new Set(r.entries.map(e => e.name));
    expect(names.has('1 Küche')).toBe(false);
    expect(names.has('Total Stunden')).toBe(false);
    expect(names.has('Anzahl Mitarbeiter')).toBe(false);
    expect(names).toEqual(new Set(['Momand Sajed', 'Krauss Marion']));
  });

  it('dateRange = erkannte Tage (von–bis)', () => {
    const r = parseMirusRows(rows, 'x.xls');
    expect(r.dateRange).toEqual(['2025-07-27', '2025-07-28']);
    expect(r.debug.detectedRange).toEqual({ startIso: '2025-07-27', endIso: '2025-07-28' });
    expect(r.debug.columnStrategy).toBe('day-number-header');
  });
});

describe('Wochentags-Gegenprobe (Off-by-one-Schutz)', () => {
  it('STOPPT Import bei falschem Wochentag in der Kopfzeile', () => {
    // 27.07.2025 ist ein Sonntag; hier steht fälschlich «Mo/Di» → Mismatch.
    const rows: unknown[][] = [
      title('27.07.2025', '28.07.2025'),
      ['', '', '', 'Mo', 'Di'],  // falsch! (echt: So, Mo)
      ['', '', '', 27, 28],
      ['1 Küche'],
      ['Momand Sajed', '', '', 8.0, 8.0],
    ];
    const r = parseMirusRows(rows, 'x.xls');
    expect(r.failureReason).toBeTruthy();
    expect(r.failureReason).toMatch(/Wochentag/i);
    expect(r.entries).toHaveLength(0);
    expect(r.debug.weekdayCheck?.ok).toBe(false);
    expect(r.debug.weekdayCheck!.mismatches.length).toBeGreaterThan(0);
  });

  it('lässt Import zu, wenn Wochentage stimmen (So/Mo)', () => {
    const rows: unknown[][] = [
      title('27.07.2025', '28.07.2025'),
      ['', '', '', 'So', 'Mo'],
      ['', '', '', 27, 28],
      ['1 Küche'],
      ['Momand Sajed', '', '', 8.0, 8.0],
    ];
    const r = parseMirusRows(rows, 'x.xls');
    expect(r.failureReason).toBeNull();
    expect(r.debug.weekdayCheck?.ok).toBe(true);
    expect(r.entries).toHaveLength(2);
  });

  it('checkWeekdays: Label kann auch in der Kopfzeile selbst stehen («So 27»)', () => {
    const rows: unknown[][] = [
      ['', '', '', 'So', 'Mo'],
    ];
    const wd = checkWeekdays(rows, 0, [
      { index: 3, date: '2025-07-27' },
      { index: 4, date: '2025-07-28' },
    ]);
    expect(wd.ok).toBe(true);
    expect(wd.status).toBe('ok');
    expect(wd.checked).toBe(2);
  });

  it('checkWeekdays: keine Labels → status "none-found", ok=false', () => {
    const rows: unknown[][] = [['', '', '', 27, 28]]; // keine Wochentagszeile
    const wd = checkWeekdays(rows, 0, [
      { index: 3, date: '2025-07-27' },
      { index: 4, date: '2025-07-28' },
    ]);
    expect(wd.status).toBe('none-found');
    expect(wd.ok).toBe(false);
    expect(wd.checked).toBe(0);
  });

  it('STOPPT Import konservativ, wenn gar keine Wochentagszeile vorhanden ist', () => {
    // Tageszahlen vorhanden, aber KEINE Mo/Di-Zeile → Gegenprobe unmöglich.
    const rows: unknown[][] = [
      title('27.07.2025', '28.07.2025'),
      ['', '', '', 27, 28],
      ['1 Küche'],
      ['Momand Sajed', '', '', 8.0, 8.0],
    ];
    const r = parseMirusRows(rows, 'x.xls');
    expect(r.failureReason).toMatch(/Wochentags-Gegenprobe/i);
    expect(r.debug.weekdayCheck?.status).toBe('none-found');
    expect(r.entries).toHaveLength(0);
  });
});

describe('Diagnostik: debug + failureReason auf allen Pfaden', () => {
  it('kein Titel-Zeitraum → failureReason + debug', () => {
    const rows: unknown[][] = [['irgendein', 'unspezifischer', 'kopf'], ['Foo Bar', 3.0]];
    const r = parseMirusRows(rows, 'x.xls');
    expect(r.failureReason).toMatch(/Datumsbereich/i);
    expect(r.debug).toBeTruthy();
    expect(r.debug.sampleRows.length).toBeGreaterThan(0);
    expect(r.entries).toHaveLength(0);
  });

  it('Titel vorhanden, aber keine Tages-Spalten → failureReason', () => {
    const rows: unknown[][] = [
      title('27.07.2025', '28.07.2025'),
      ['nur', 'text', 'keine', 'zahlen'],
      ['Momand Sajed'],
    ];
    const r = parseMirusRows(rows, 'x.xls');
    expect(r.failureReason).toMatch(/Tages-Spalten/i);
    expect(r.debug.detectedRange).toEqual({ startIso: '2025-07-27', endIso: '2025-07-28' });
  });
});

describe('Voll-Monat Happy-Path (31 Tage, Tag-1-Anker) — Regression', () => {
  const SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  // Juli 2025 hat 31 Tage. Kopf: Wochentagszeile + Tageszahlzeile 1..31,
  // Stunden ab Spaltenindex 2. Tag-1-Anker ist vorhanden.
  const weekdayRow: unknown[] = ['', ''];
  const dayRow: unknown[] = ['', ''];
  for (let d = 1; d <= 31; d++) {
    weekdayRow.push(SHORT[new Date(2025, 6, d).getDay()]);
    dayRow.push(d);
  }
  const empRow: unknown[] = ['Momand Sajed', ''];
  for (let d = 1; d <= 31; d++) empRow.push(d % 2 === 0 ? 8.0 : 0); // an geraden Tagen 8h

  const rows: unknown[][] = [
    title('01.07.2025', '31.07.2025'),
    weekdayRow,
    dayRow,
    ['1 Küche'],
    empRow,
  ];

  it('mappt jede der 31 Kopf-Tageszahlen exakt auf ihr Datum (identisch wie erwartet)', () => {
    const r = parseMirusRows(rows, 'Taegliche_Stunden_07.2025.xls');
    expect(r.failureReason).toBeNull();
    expect(r.debug.columnStrategy).toBe('day-number-header');
    const sajed = r.entries.filter(e => e.name === 'Momand Sajed');
    // Nur gerade Tage (8h) → 15 Einträge (2,4,…,30).
    const expectedDates = [];
    for (let d = 2; d <= 31; d += 2) expectedDates.push(`2025-07-${String(d).padStart(2, '0')}`);
    expect(sajed.map(e => e.date).sort()).toEqual(expectedDates);
    expect(sajed.every(e => e.hours === 8)).toBe(true);
    // Tag 1 (ungerade → 0h) hat KEINEN Eintrag, wird aber korrekt geankert:
    expect(r.dateRange[0]).toBe('2025-07-01');
    expect(r.dateRange[r.dateRange.length - 1]).toBe('2025-07-31');
  });
});

describe('Punkt 2: nicht-aufsteigende Kopfzeile wird HART verworfen', () => {
  it('verwirft nicht-monotone Zahlenzeile → keine falsche Zuordnung', () => {
    // «Kopfzeile» mit nicht-aufsteigenden Tageszahlen (28, 27) → kein gültiger
    // Kandidat; da es sonst keine echte Kopfzeile gibt → failureReason.
    const rows: unknown[][] = [
      title('27.07.2025', '28.07.2025'),
      ['', '', '', 28, 27], // absteigend! → verworfen
      ['1 Küche'],
      ['Momand Sajed', '', '', 8.0, 8.0],
    ];
    const r = parseMirusRows(rows, 'x.xls');
    expect(r.failureReason).toMatch(/Tages-Spalten/i);
    expect(r.entries).toHaveLength(0);
  });
});

describe('Multi-Tag Voll-Monat (Spaltenoffset spielt keine Rolle)', () => {
  it('mappt jede Kopf-Tageszahl korrekt auf ihr Datum', () => {
    // Feb 2026: 1=So, 2=Mo. Tageszahlen an Spalte 2/3.
    const rows: unknown[][] = [
      title('01.02.2026', '02.02.2026'),
      ['', '', 'So', 'Mo'],
      ['', '', 1, 2],
      ['1 Küche'],
      ['Müller Anna', '', 4.0, 6.5],
    ];
    const r = parseMirusRows(rows, 'x.xls');
    expect(r.failureReason).toBeNull();
    const anna = r.entries.filter(e => e.name === 'Müller Anna');
    expect(anna.map(e => e.date).sort()).toEqual(['2026-02-01', '2026-02-02']);
    expect(anna.find(e => e.date === '2026-02-02')!.hours).toBe(6.5);
  });
});

// ── Spec-Runde «robust für unterschiedliche Layouts» (Oliv 28T / Beaulieu 31T) ──

describe('Generische Blöcke + Aggregation über Blöcke (Beaulieu-Layout)', () => {
  const SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  // 31 Tage Juli 2026, Tag 1 in Spaltenindex 5 (Beaulieu: «Spalte 6»), Total dahinter.
  const weekdayRow: unknown[] = ['', '', '', '', ''];
  const dayRow: unknown[] = ['', '', '', '', ''];
  for (let d = 1; d <= 31; d++) {
    weekdayRow.push(SHORT[new Date(2026, 6, d).getDay()]);
    dayRow.push(d);
  }
  weekdayRow.push('Total'); dayRow.push('');

  const empRow = (name: string, perDay: number): unknown[] => {
    const r: unknown[] = [name, '', '', '', ''];
    for (let d = 1; d <= 31; d++) r.push(perDay);
    r.push(perDay * 31);
    return r;
  };

  const rows: unknown[][] = [
    ['3012 Restaurant Beaulieu AG'],
    title('01.07.2026', '31.07.2026'),
    weekdayRow,
    dayRow,
    ['1 Küche'],
    empRow('Ramadani Naip', 3.0),
    ['Total Stunden', '', '', '', '', 3.0],
    ['2 Service'],
    empRow('Krauss Marion', 5.0),
    ['3 Hilfsarbeiter'],
    empRow('Ramadani Naip', 1.5),
    ['4 Geschäftsleitung'],
    empRow('Chef Person', 2.0),
    ['Total Stunden', '', '', '', '', 2.0],
  ];

  it('liest alle 4 Blöcke inkl. Hilfsarbeiter/Geschäftsleitung (nichts übersprungen)', () => {
    const r = parseMirusRows(rows, 'beaulieu.xls');
    expect(r.failureReason).toBeNull();
    const names = new Set(r.entries.map(e => e.name));
    expect(names).toEqual(new Set(['Ramadani Naip', 'Krauss Marion', 'Chef Person']));
  });

  it('summiert denselben Mitarbeiter über Blöcke pro Tag (3.0 + 1.5 = 4.5)', () => {
    const r = parseMirusRows(rows, 'beaulieu.xls');
    const naip = r.entries.filter(e => e.name === 'Ramadani Naip');
    expect(naip).toHaveLength(31); // pro Tag genau EIN summierter Eintrag
    expect(naip.every(e => e.hours === 4.5)).toBe(true);
    const total = naip.reduce((s, e) => s + e.hours, 0);
    expect(total).toBeCloseTo(31 * 4.5, 2);
  });

  it('erkennt den Kostenträger 3012 → beaulieu', () => {
    const r = parseMirusRows(rows, 'beaulieu.xls');
    expect(r.costCenter).not.toBeNull();
    expect(r.costCenter!.number).toBe('3012');
    expect(r.costCenter!.tenant).toBe('beaulieu');
  });

  it('erkennt Kostenträger 3027 → oliv (robust gegen Zusätze)', () => {
    const olivRows = rows.map(r0 => [...r0]);
    olivRows[0] = ['3027 Restaurant OLIV'];
    const r = parseMirusRows(olivRows, 'oliv.xls');
    expect(r.costCenter!.tenant).toBe('oliv');
  });

  it('unbekannter Kostenträger → tenant null (kein Blocken)', () => {
    const xRows = rows.map(r0 => [...r0]);
    xRows[0] = ['9999 Restaurant Anderswo'];
    const r = parseMirusRows(xRows, 'x.xls');
    expect(r.costCenter!.number).toBe('9999');
    expect(r.costCenter!.tenant).toBeNull();
  });
});

describe('Spalten-Plausibilitätscheck: Anzahl Tagesspalten ≠ Zeitraum → Stopp', () => {
  it('stoppt, wenn nur ein Teil der Tagesspalten gefunden wird', () => {
    // Titel sagt 01.–31.07., Kopfzeile enthält aber nur Tage 1..10 → Abbruch.
    const weekdayRow: unknown[] = ['', ''];
    const dayRow: unknown[] = ['', ''];
    const SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    for (let d = 1; d <= 10; d++) {
      weekdayRow.push(SHORT[new Date(2026, 6, d).getDay()]);
      dayRow.push(d);
    }
    const rows: unknown[][] = [
      title('01.07.2026', '31.07.2026'),
      weekdayRow,
      dayRow,
      ['1 Küche'],
      ['Momand Sajed', '', 8, 8, 8, 8, 8, 8, 8, 8, 8, 8],
    ];
    const r = parseMirusRows(rows, 'x.xls');
    expect(r.failureReason).toMatch(/Plausibilit/i);
    expect(r.entries).toHaveLength(0);
  });
});
