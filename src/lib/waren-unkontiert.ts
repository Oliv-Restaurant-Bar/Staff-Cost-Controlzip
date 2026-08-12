/**
 * Unkontierte Warenkosten-Positionen — Auflistung & direkte Kontierung.
 * =====================================================================
 * «Unkontiert» ist EXAKT dieselbe Definition wie `zaehleUnkontierte`
 * (warenkosten-quote): Einträge bzw. Splits ohne numerisches Warenkonto
 * («offen»/leer, nicht Depot). Invariante: `listeUnkontierte(entries).length
 * === zaehleUnkontierte(entries)` — der klickbare Hinweis und die Liste
 * zeigen garantiert dieselbe Zahl.
 *
 * `weiseKontoZu` ist pur (kein IO): liefert den aktualisierten Eintrag,
 * Persistenz/State macht der Aufrufer. Es wird NIE geraten — eine Position
 * bleibt unkontiert, bis der User ein Konto zuweist.
 */

import type { InvoiceEntry } from '@/lib/waren-db';
import { normalisiereKontoNummer } from '@/lib/warenkosten-quote';

export interface UnkontiertePosition {
  entryId: string;
  /** null = ganzer Eintrag ohne Konto; Zahl = Index des offenen Splits. */
  splitIndex: number | null;
  lieferant: string;
  beleg: string | null;
  datum: string;
  /** Artikelbezeichnung/Warengruppe soweit bekannt (Notiz) — sonst null («leer statt 0»). */
  bezeichnung: string | null;
  betragNet: number;
}

const istOffen = (konto: string | undefined): boolean =>
  konto !== 'Depot' && normalisiereKontoNummer(konto) === null;

/** Alle unkontierten Positionen (Eintrags- und Split-Ebene) einer Liste. */
export function listeUnkontierte(entries: InvoiceEntry[]): UnkontiertePosition[] {
  const out: UnkontiertePosition[] = [];
  for (const e of entries) {
    const basis = {
      entryId: e.id,
      lieferant: e.supplierName,
      beleg: e.reference?.trim() ? e.reference.trim() : null,
      datum: e.date,
      bezeichnung: e.note?.trim() ? e.note.trim() : null,
    };
    if (e.kontoSplits && e.kontoSplits.length > 0) {
      e.kontoSplits.forEach((s, i) => {
        if (istOffen(s.warenkonto)) out.push({ ...basis, splitIndex: i, betragNet: s.amountNet });
      });
      continue;
    }
    if (istOffen(e.warenkonto)) out.push({ ...basis, splitIndex: null, betragNet: e.amountNet });
  }
  return out.sort((a, b) => a.datum.localeCompare(b.datum) || b.betragNet - a.betragNet);
}

/**
 * Konto zuweisen (pur): splitIndex null → Eintrags-Konto setzen; Zahl →
 * genau diesen Split kontieren. Beträge bleiben unverändert; die Kategorie
 * (Food/Beverage) leitet sich danach autoritativ aus dem Konto ab
 * (kategorieOf), deshalb wird `kategorie` nicht angefasst.
 */
export function weiseKontoZu(
  entry: InvoiceEntry, splitIndex: number | null, konto: string,
): InvoiceEntry {
  if (splitIndex === null) return { ...entry, warenkonto: konto };
  const splits = (entry.kontoSplits ?? []).map((s, i) =>
    i === splitIndex ? { ...s, warenkonto: konto } : s);
  return { ...entry, kontoSplits: splits };
}
