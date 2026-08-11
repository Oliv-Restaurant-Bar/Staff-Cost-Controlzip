// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { journalZeilenKey, dedupeJournalZeilen, analysiereJournalDubletten } from '@/lib/journal-dedupe';
import type { SageJournalEntry } from '@/types/reporting';

const je = (p: Partial<SageJournalEntry> & { text: string; soll?: number; haben?: number }): SageJournalEntry => ({
  date: '15.07.2026', accountNumber: '4060', accountName: '', soll: 0, haben: 0,
  amount: Math.abs((p.soll ?? 0) - (p.haben ?? 0)),
  ...p,
} as SageJournalEntry);

// Juli-Kontrollwerte aus dem Build-Befehl (je Lieferant 1× nach Bereinigung).
const JULI: SageJournalEntry[] = [
  je({ text: 'Ambro', soll: 8568.39, belegNr: '101' }),
  je({ text: 'Terravigna', soll: 7013.37, belegNr: '102', accountNumber: '4020' }),
  je({ text: 'Caporaso', soll: 5802.43, belegNr: '103' }),
  je({ text: 'Metzgerei Spahni', soll: 4702.54, belegNr: '104', accountNumber: '4010' }),
  je({ text: 'Blaser', soll: 1487.96, belegNr: '105' }),
  je({ text: 'Camille', soll: 1000.00, belegNr: '106' }),
  je({ text: 'Paul Ullrich', soll: 769.50, belegNr: '107', accountNumber: '4040' }),
  je({ text: 'Asia', soll: 500.00, belegNr: '108' }),
  je({ text: 'Umb. gemäss Webapp', haben: 1830.00, belegNr: '109', accountNumber: '4030' }),
];
// 3× importiert = jede Zeile 3× vorhanden.
const JULI_3X = [...JULI, ...JULI.map(e => ({ ...e })), ...JULI.map(e => ({ ...e }))];

describe('journalZeilenKey', () => {
  it('gleiche Zeile = gleicher Schlüssel (Whitespace-tolerant)', () => {
    expect(journalZeilenKey(je({ text: ' Ambro  AG ', soll: 100 })))
      .toBe(journalZeilenKey(je({ text: 'Ambro AG', soll: 100 })));
  });
  it('unterscheidet Beleg, Konto, Betrag, Text und Datum', () => {
    const base = je({ text: 'Ambro', soll: 100, belegNr: '1' });
    expect(journalZeilenKey(base)).not.toBe(journalZeilenKey({ ...base, belegNr: '2' }));
    expect(journalZeilenKey(base)).not.toBe(journalZeilenKey({ ...base, accountNumber: '4020' }));
    expect(journalZeilenKey(base)).not.toBe(journalZeilenKey({ ...base, soll: 100.01 }));
    expect(journalZeilenKey(base)).not.toBe(journalZeilenKey({ ...base, text: 'Ambro 2' }));
    expect(journalZeilenKey(base)).not.toBe(journalZeilenKey({ ...base, date: '16.07.2026' }));
  });
});

describe('dedupeJournalZeilen — 3×-Import auf 1× je Schlüssel (Juli-Regression)', () => {
  it('Kontrollwerte: jeder Lieferant 1×, Umbuchung 1× −1830 (nicht −3660/−5490)', () => {
    const { zeilen, entfernt } = dedupeJournalZeilen(JULI_3X);
    expect(entfernt).toBe(18);
    expect(zeilen).toHaveLength(9);
    const betrag = (t: string) => zeilen.filter(e => e.text === t)
      .reduce((s, e) => s + (e.soll ?? 0) - (e.haben ?? 0), 0);
    expect(zeilen.filter(e => e.text === 'Ambro')).toHaveLength(1);
    expect(betrag('Ambro')).toBeCloseTo(8568.39, 2);
    expect(betrag('Terravigna')).toBeCloseTo(7013.37, 2);
    expect(betrag('Caporaso')).toBeCloseTo(5802.43, 2);
    expect(betrag('Metzgerei Spahni')).toBeCloseTo(4702.54, 2);
    expect(betrag('Blaser')).toBeCloseTo(1487.96, 2);
    expect(betrag('Camille')).toBeCloseTo(1000.00, 2);
    expect(betrag('Paul Ullrich')).toBeCloseTo(769.50, 2);
    expect(betrag('Asia')).toBeCloseTo(500.00, 2);
    expect(betrag('Umb. gemäss Webapp')).toBeCloseTo(-1830.00, 2);
  });
  it('Reihenfolge bleibt (erstes Vorkommen), saubere Liste unverändert', () => {
    const clean = dedupeJournalZeilen(JULI);
    expect(clean.entfernt).toBe(0);
    expect(clean.zeilen).toEqual(JULI);
    expect(dedupeJournalZeilen(JULI_3X).zeilen.map(e => e.text)).toEqual(JULI.map(e => e.text));
  });
  it('echte unterschiedliche Zeilen desselben Lieferanten bleiben ALLE erhalten', () => {
    const zwei = [
      je({ text: 'Ambro', soll: 500, belegNr: '1' }),
      je({ text: 'Ambro', soll: 500, belegNr: '2' }), // andere Beleg-Nr → andere Zeile
      je({ text: 'Ambro', soll: 500, belegNr: '1', date: '16.07.2026' }), // anderer Tag
    ];
    expect(dedupeJournalZeilen(zwei).zeilen).toHaveLength(3);
  });
  it('leer bleibt leer (leer statt 0)', () => {
    expect(dedupeJournalZeilen([])).toEqual({ zeilen: [], entfernt: 0 });
  });
});

describe('analysiereJournalDubletten — Vorschau', () => {
  it('«X Dubletten entfernt, Y Zeilen bleiben» + Gruppen nach Betrag sortiert', () => {
    const a = analysiereJournalDubletten(JULI_3X);
    expect(a.entfernt).toBe(18);
    expect(a.verbleibend).toBe(9);
    expect(a.gruppen).toHaveLength(9);
    expect(a.gruppen.every(g => g.anzahl === 3)).toBe(true);
    expect(a.gruppen[0].beispiel.text).toBe('Ambro'); // grösster Betrag zuerst
  });
  it('keine Dubletten → leere Gruppen, 0 entfernt', () => {
    const a = analysiereJournalDubletten(JULI);
    expect(a.entfernt).toBe(0);
    expect(a.gruppen).toEqual([]);
    expect(a.verbleibend).toBe(9);
  });
});

describe('saveJournalEntries dedupliziert — saveJournalEntriesStrict bleibt verbatim', () => {
  it('append-Modus addiert nie doppelt; Strict schreibt Duplikate 1:1 (Undo)', async () => {
    vi.resetModules();
    // Minimaler localStorage-Stub (node-Umgebung).
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    vi.doMock('@/lib/supabase-kv', () => ({
      kvGet: async () => null,
      kvSet: async () => {},
      kvSetStrict: async () => {},
      safeUpsertReportingMonth: async () => {},
      safeDeleteReportingMonth: async () => {},
      notifyKVBackupProblem: async () => {},
    }));
    const { saveJournalEntries, loadJournalEntries, saveJournalEntriesStrict } = await import('@/lib/reporting-store');
    saveJournalEntries(2026, 7, JULI, 'replace', 'oliv');
    // Re-Import im «Ergänzen»-Modus: identische Zeilen dürfen NICHT addieren.
    saveJournalEntries(2026, 7, JULI, 'append' as never, 'oliv');
    saveJournalEntries(2026, 7, JULI, 'append' as never, 'oliv');
    expect(loadJournalEntries(2026, 7, 'oliv')).toHaveLength(9);
    // Auch replace mit intern verdreifachter Liste wird bereinigt.
    saveJournalEntries(2026, 7, JULI_3X, 'replace', 'oliv');
    expect(loadJournalEntries(2026, 7, 'oliv')).toHaveLength(9);
    // Strict (Undo/Restore) schreibt den Vorzustand EXAKT zurück — inkl. Dubletten.
    await saveJournalEntriesStrict(2026, 7, JULI_3X, 'oliv');
    expect(loadJournalEntries(2026, 7, 'oliv')).toHaveLength(27);
    vi.doUnmock('@/lib/supabase-kv');
  });
});
