/**
 * journal-dedupe – Dublettensicherung für FIBU-Buchungszeilen (Lieferanten-Journal)
 * ==================================================================================
 * Problem: Mehrfach-Importe desselben Kostenblatts haben Buchungszeilen ADDIERT
 * statt ERSETZT — jeder Lieferant erschien 3×. Der Schlüssel je Zeile ist
 * (Mandant + Monat sind im Storage-Key) Datum + Beleg-Nr + Konto + Soll + Haben
 * + Buchungstext: gleicher Schlüssel = gleiche Zeile → nur 1× behalten.
 *
 * Rein & deterministisch — Orchestrierung (Laden/Speichern/Undo) macht der Aufrufer.
 */

import type { SageJournalEntry } from '@/types/reporting';

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

/**
 * Robuster Dubletten-Schlüssel je Buchungszeile.
 * Datum ist bewusst Teil des Schlüssels (strenger als nötig — verhindert, dass
 * gleiche Beträge an verschiedenen Tagen fälschlich verschmolzen werden).
 */
export function journalZeilenKey(e: SageJournalEntry): string {
  return [
    (e.date ?? '').trim(),
    (e.belegNr ?? '').trim(),
    String(e.accountNumber ?? '').trim(),
    r2(e.soll),
    r2(e.haben),
    (e.text ?? '').trim().replace(/\s+/g, ' '),
  ].join('|');
}

/**
 * Kostenblatt-Re-Import = vollständige Wahrheit: liefert die bestehenden
 * Buchungszeilen, die im NEUEN File fehlen (Schlüssel wie Dedupe:
 * Datum+Beleg+Konto+Soll+Haben+Text) — sie werden beim Import entfernt
 * (z.B. periodenfremd umgebuchte Rechnungen). Vorschau-/Regressionsbasis.
 */
export function zeilenNichtImNeuenFile(
  prior: SageJournalEntry[],
  neu: SageJournalEntry[],
): SageJournalEntry[] {
  const neuKeys = new Set(neu.map(journalZeilenKey));
  return prior.filter(e => !neuKeys.has(journalZeilenKey(e)));
}

export interface JournalDedupeErgebnis {
  /** Bereinigte Liste: 1× je Schlüssel, Original-Reihenfolge (erstes Vorkommen). */
  zeilen: SageJournalEntry[];
  /** Anzahl entfernter Dubletten. */
  entfernt: number;
}

/** Dedupliziert Buchungszeilen auf 1× je Schlüssel (erstes Vorkommen gewinnt). */
export function dedupeJournalZeilen(entries: SageJournalEntry[]): JournalDedupeErgebnis {
  const gesehen = new Set<string>();
  const zeilen: SageJournalEntry[] = [];
  for (const e of entries) {
    const k = journalZeilenKey(e);
    if (gesehen.has(k)) continue;
    gesehen.add(k);
    zeilen.push(e);
  }
  return { zeilen, entfernt: entries.length - zeilen.length };
}

export interface JournalDublettenGruppe {
  key: string;
  /** Repräsentative Zeile (erstes Vorkommen). */
  beispiel: SageJournalEntry;
  /** Gesamtanzahl Vorkommen (≥2). */
  anzahl: number;
}

export interface JournalDublettenAnalyse {
  gruppen: JournalDublettenGruppe[];
  /** Wieviele Zeilen bei der Bereinigung entfernt würden. */
  entfernt: number;
  /** Wieviele Zeilen bleiben. */
  verbleibend: number;
}

/** Vorschau: welche Zeilen sind mehrfach vorhanden (für den Bereinigungs-Dialog). */
export function analysiereJournalDubletten(entries: SageJournalEntry[]): JournalDublettenAnalyse {
  const counts = new Map<string, { beispiel: SageJournalEntry; anzahl: number }>();
  for (const e of entries) {
    const k = journalZeilenKey(e);
    const cur = counts.get(k);
    if (cur) cur.anzahl += 1;
    else counts.set(k, { beispiel: e, anzahl: 1 });
  }
  const gruppen: JournalDublettenGruppe[] = [];
  let entfernt = 0;
  for (const [key, { beispiel, anzahl }] of counts) {
    if (anzahl < 2) continue;
    gruppen.push({ key, beispiel, anzahl });
    entfernt += anzahl - 1;
  }
  // Grösste Dubletten (nach Betrag) zuerst — relevanteste oben im Dialog.
  gruppen.sort((a, b) =>
    Math.abs(r2(b.beispiel.soll) - r2(b.beispiel.haben)) - Math.abs(r2(a.beispiel.soll) - r2(a.beispiel.haben)));
  return { gruppen, entfernt, verbleibend: entries.length - entfernt };
}

/** KV-Key (via tenantKey mandantieren) für den Undo-Snapshot der Bereinigung. */
export const JOURNAL_DEDUPE_UNDO_KEY = 'journal_dedupe_undo_v1';

export interface JournalDedupeUndoSnapshot {
  year: number;
  month: number;
  /** Vorzustand (inkl. Dubletten) — wird bei Undo 1:1 zurückgeschrieben. */
  entries: SageJournalEntry[];
  entfernt: number;
  bereinigtAm: string; // ISO
}
