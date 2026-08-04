/**
 * FIBU-Übernahme: fehlende Lieferanten-Rechnungen direkt aus der Buchhaltung
 * ==========================================================================
 * Warenkonto-Buchungen ohne erfasste Rechnung (Status 'nur-gebucht' und
 * nichtZugeordnet im Warenkosten-Abgleich) werden als Kandidaten aufbereitet
 * und können — mit Vorschau — als provisorische Warenrechnungen übernommen
 * werden (quelle 'fibu_uebernahme', final=false: eine spätere Monatsrechnung/
 * Lieferschein darf die Werte gemäss Dual-Modell noch finalisieren).
 *
 * Reine Logik, kein React/Supabase: testbar und von der Seite aus aufrufbar.
 * Beträge werden NIE verändert — amountNet entspricht exakt Soll−Haben der
 * Buchung (vatIncluded=false).
 */

import type { SageJournalEntry } from '@/types/reporting';
import type { WarenAbgleich } from '@/lib/waren-abgleich';
import type { FibuMatchState } from '@/lib/waren-fibu-matches';
import { buchungKey, buchungKeysMitIndex, buchungBetrag } from '@/lib/waren-fibu-matches';
import type { InvoiceEntry } from '@/lib/waren-db';
import { buildAliasResolver } from '@/lib/waren-alias-gruppen';
import { kategorieFromKonto, type WarenKategorie } from '@/lib/warenkosten-quote';

export interface UebernahmeKandidat {
  /**
   * Stabiler Schlüssel der Buchung MIT Duplikat-Index (`…#0`, `…#1`) — exakt
   * derselbe Schlüsselraum wie im FIBU-Match-Drilldown (buchungKeysMitIndex
   * über die Buchungsliste der Zeile), damit Matches beider UIs sich
   * gegenseitig sehen und identische Doppel-Buchungen unterscheidbar bleiben.
   */
  key: string;
  /** Buchungsdatum DD.MM.YYYY (Original). */
  datum: string;
  /** Buchungsdatum als ISO YYYY-MM-DD (null wenn nicht parsbar). */
  datumIso: string | null;
  /** Buchungstext (Original). */
  text: string;
  /** Aufgelöster Lieferant (Alias-Auflösung) — null bei nichtZugeordnet. */
  lieferant: string | null;
  accountNumber: string;
  accountName: string;
  /** Netto-Betrag = Soll − Haben (exakt wie gebucht). */
  betrag: number;
  belegNr?: string;
}

/** DD.MM.YYYY → YYYY-MM-DD (null wenn nicht parsbar). */
export function parseFibuDatum(d: string): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec((d ?? '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const day = Number(dd), mon = Number(mm);
  if (day < 1 || day > 31 || mon < 1 || mon > 12) return null;
  return `${yyyy}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** MwSt-Satz aus dem Warenkonto: Getränke 8.1, sonst (Food) 2.6. */
export function vatRateForKonto(accountNumber: string): number {
  return kategorieFromKonto(accountNumber) === 'Beverage' ? 8.1 : 2.6;
}

/**
 * Kandidatenliste: alle Warenkonto-Buchungen ohne erfasste Rechnung.
 * - Zeilen mit Status 'nur-gebucht' (Lieferant erkannt, aber keine Rechnung)
 * - nichtZugeordnet (kein Lieferant im Buchungstext erkennbar)
 * - MINUS Buchungen, die bereits in einer FIBU-Match-Gruppe stecken
 *   (manuell/auto einer Rechnung zugeordnet) — die sind ja erfasst.
 *
 * Schlüssel: indiziert (`…#n`) pro Buchungsliste, exakt wie das Match-
 * Drilldown — ein Match auf EINE von zwei identischen Buchungen entfernt
 * nur genau diese aus den Kandidaten. Alt-/Fremd-Einträge mit unindizierten
 * Schlüsseln werden defensiv als `#0` interpretiert.
 *
 * BARAUSGABEN-Zeilen («Barausgaben <Laden>») werden zusätzlich AUF
 * BUCHUNGS-EBENE geprüft: hat ein Laden sowohl erfasste als auch nicht
 * erfasste Bareinkäufe (Zeile 'ok'/'abweichung'), bleiben die einzelnen
 * Buchungen ohne Datum+Betrag-Gegenstück (±5 Rp.) in den erfassten
 * Rechnungen übernehmbar — dafür MUSS `invoices` (Monatsliste) übergeben
 * werden; jede Rechnung deckt höchstens EINE Buchung.
 */
export function buildUebernahmeKandidaten(
  abgleich: WarenAbgleich | null,
  matchState: FibuMatchState,
  invoices?: InvoiceEntry[],
): UebernahmeKandidat[] {
  if (!abgleich || abgleich.mode !== 'lieferanten') return [];
  const gematcht = new Set<string>();
  for (const g of matchState.gruppen) {
    for (const k of g.buchungKeys) {
      gematcht.add(k.includes('#') ? k : `${k}#0`); // bare Alt-Keys = #0
    }
  }
  const out: UebernahmeKandidat[] = [];
  const pushListe = (buchungen: SageJournalEntry[], lieferant: string | null, skipKeys?: Set<string>) => {
    const keys = buchungKeysMitIndex(buchungen);
    buchungen.forEach((e, i) => {
      const key = keys[i];
      if (gematcht.has(key)) return;
      if (skipKeys?.has(key)) return;
      out.push({
        key,
        datum: e.date,
        datumIso: parseFibuDatum(e.date),
        text: e.text ?? '',
        lieferant,
        accountNumber: String(e.accountNumber),
        accountName: e.accountName ?? '',
        betrag: buchungBetrag(e),
        ...(e.belegNr ? { belegNr: e.belegNr } : {}),
      });
    });
  };
  // Rechnungen je kanonischem Lieferanten (für den Buchungs-Ebenen-Check der
  // Barausgaben-Zeilen) — Resolver aus den EFFEKTIVEN Gruppen des Abgleichs,
  // damit «Migros» der Zeile «Barausgaben Migros» zugeordnet wird.
  const resolve = buildAliasResolver(abgleich.effektiveAliasGruppen ?? []);
  // Rechnungen, die bereits in einer FIBU-Match-Gruppe stecken, sind durch
  // ihre gematchte Buchung «verbraucht» — sie dürfen im Datum+Betrag-Check
  // keine ZWEITE (ungematchte) Buchung decken, sonst verschwindet deren
  // Übernahme-Kandidat (Fall: identische Doppel-Buchung, eine manuell
  // gematcht). gesperrt.invoiceIds bleiben drin: sie sind erfasst, nur vom
  // Auto-Match ausgenommen.
  const verbrauchteInvoiceIds = new Set(matchState.gruppen.flatMap(g => g.invoiceIds));
  const invByCanon = new Map<string, InvoiceEntry[]>();
  for (const inv of invoices ?? []) {
    if (verbrauchteInvoiceIds.has(inv.id)) continue;
    const canon = resolve(inv.supplierName);
    const list = invByCanon.get(canon) ?? [];
    list.push(inv);
    invByCanon.set(canon, list);
  }
  const istBarausgabenZeile = (name: string) => /^barausgaben(\s|$)/i.test(name.trim());
  for (const z of abgleich.zeilen) {
    if (z.status === 'nur-gebucht') {
      pushListe(z.buchungen, z.lieferant);
      continue;
    }
    if ((z.status === 'ok' || z.status === 'abweichung') && istBarausgabenZeile(z.lieferant) && invoices) {
      // Buchungs-Ebene: Buchungen mit erfasstem Datum+Betrag-Gegenstück
      // (±5 Rp., jede Rechnung deckt genau eine Buchung) überspringen.
      const keys = buchungKeysMitIndex(z.buchungen);
      const frei = [...(invByCanon.get(z.lieferant) ?? [])];
      const gedeckt = new Set<string>();
      z.buchungen.forEach((e, i) => {
        const iso = parseFibuDatum(e.date);
        const betrag = buchungBetrag(e);
        const idx = frei.findIndex(inv =>
          inv.date === iso && Math.abs(inv.amountNet - betrag) <= DUBLETTE_TOLERANZ_CHF);
        if (idx >= 0) {
          frei.splice(idx, 1);
          gedeckt.add(keys[i]);
        }
      });
      pushListe(z.buchungen, z.lieferant, gedeckt);
    }
  }
  pushListe(abgleich.nichtZugeordnet, null);
  // Chronologisch (ISO sortierbar; unparsebare Daten ans Ende)
  return out.sort((a, b) => (a.datumIso ?? '9999').localeCompare(b.datumIso ?? '9999'));
}

/** Editierbarer Vorschau-Entwurf einer Übernahme. */
export interface UebernahmeDraft {
  kandidat: UebernahmeKandidat;
  date: string;          // YYYY-MM-DD (editierbar)
  supplierName: string;  // editierbar
  vatRate: number;       // editierbar
  kategorie: WarenKategorie;
  warenkonto: string;
  reference: string;
  note: string;
}

export function kandidatToDraft(k: UebernahmeKandidat): UebernahmeDraft {
  // Barausgaben (Bar-/Kasseneinkäufe) bekommen eine sprechende Bemerkung.
  const istBarausgabe = /^barausgaben?\b/i.test((k.lieferant ?? '').trim());
  return {
    kandidat: k,
    date: k.datumIso ?? '',
    supplierName: (k.lieferant ?? k.text ?? '').trim(),
    vatRate: vatRateForKonto(k.accountNumber),
    kategorie: kategorieFromKonto(k.accountNumber),
    warenkonto: k.accountNumber,
    reference: k.belegNr ?? '',
    note: istBarausgabe
      ? 'Barausgabe aus FIBU übernommen'
      : `aus FIBU-Abgleich übernommen · ${k.accountName}`.trim(),
  };
}

/** Toleranz für die Dubletten-Erkennung (CHF). */
export const DUBLETTE_TOLERANZ_CHF = 0.05;

const normName = (s: string) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Dublette: existiert bereits eine erfasste Rechnung mit gleichem Lieferant
 * + Datum + Betrag (±Toleranz)? Dann Übernahme sperren statt doppelt anlegen.
 */
export function findeDublette(
  draft: Pick<UebernahmeDraft, 'date' | 'supplierName'> & { betrag: number },
  invoices: InvoiceEntry[],
  toleranz: number = DUBLETTE_TOLERANZ_CHF,
): InvoiceEntry | null {
  const name = normName(draft.supplierName);
  for (const inv of invoices) {
    if (inv.date !== draft.date) continue;
    if (normName(inv.supplierName) !== name) continue;
    if (Math.abs(inv.amountNet - draft.betrag) <= toleranz) return inv;
  }
  return null;
}

/** Fertiger InvoiceEntry aus dem (ggf. editierten) Vorschau-Entwurf. */
export function draftToInvoiceEntry(
  d: UebernahmeDraft,
  id: string,
  nowIso: string,
): InvoiceEntry {
  return {
    id,
    date: d.date,
    supplierName: d.supplierName.trim(),
    amountNet: d.kandidat.betrag, // exakt wie gebucht — nie verändern
    amountGross: d.kandidat.betrag * (1 + d.vatRate / 100),
    vatIncluded: false,
    vatRate: d.vatRate,
    ...(d.reference.trim() ? { reference: d.reference.trim() } : {}),
    ...(d.note.trim() ? { note: d.note.trim() } : {}),
    ...(d.warenkonto.trim() ? { warenkonto: d.warenkonto.trim() } : {}),
    kategorie: d.kategorie,
    quelle: 'fibu_uebernahme',
    final: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}
