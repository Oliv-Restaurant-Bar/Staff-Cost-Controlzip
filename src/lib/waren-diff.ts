/**
 * Gesamt-Aufschlüsselung der FIBU-Differenz (SSOT) — «Woraus besteht die
 * Differenz?» über ALLE Lieferanten, gebündelt nach Typ:
 *
 *  - 'luecke'     echte Rechnungs-Lücken: erfasste Rechnungen ohne Buchung
 *                 (nur_erfasst), Buchungen ohne Rechnung (nur_fibu) sowie
 *                 Warenkonten-Buchungen ohne Lieferanten-Zuordnung.
 *  - 'umbuchung'  interne Umbuchungen («Umb.»/«Umbuchung»-Präfix) — Konto-
 *                 Korrekturen, KEINE Rechnungen; bereits AUS der Differenz
 *                 ausgeklammert, hier rein informativ.
 *  - 'pfand_rest' Betrags-/Pfand-Reste innerhalb von Matches (match_rest,
 *                 Rundung, lieferantenübergreifende Gruppen) — typisch kleine
 *                 Pfand-/Non-Food-Restdifferenzen.
 *
 * INVARIANTE (mode 'lieferanten'): lueckenSumme + pfandRestSumme = diffTotal
 * (rappengenau) — die Zerlegung pro Lieferant ist exakt, nichtZugeordnet
 * kommt additiv dazu. Die Umbuchungs-Summe steht AUSSERHALB der Differenz.
 *
 * Pure Logik (node-testbar), mandantengetrennt über die Eingaben (Abgleich,
 * Rechnungen und Match-Gruppen stammen bereits aus dem Mandanten-Kontext).
 */

import type { InvoiceEntry } from '@/lib/waren-db';
import { buchungsBetrag, type WarenAbgleich } from '@/lib/waren-abgleich';
import {
  zerlegeLieferantDifferenz, buchungKeysMitIndex, buchungAnzeigeText,
  type FibuMatchGruppe,
} from '@/lib/waren-fibu-matches';

export type DiffKategorie = 'luecke' | 'umbuchung' | 'abgrenzung' | 'pfand_rest';

export interface DiffAufZeile {
  kategorie: DiffKategorie;
  konto: string | null;
  lieferant: string | null;
  beleg: string | null;
  datum: string | null;
  label: string;
  betrag: number;
}

export interface DiffGruppe {
  kategorie: DiffKategorie;
  zeilen: DiffAufZeile[];
  summe: number;
}

export interface DiffAufschluesselung {
  /** SSOT: identisch mit abgleich.diffTotal (Buchhaltung − erfasst). */
  diffTotal: number | null;
  /** Σ echte Rechnungs-Lücken (Teil der Differenz). */
  lueckenSumme: number;
  /** Σ interne Umbuchungen (NICHT Teil der Differenz — informativ). */
  umbuchungenSumme: number;
  /** Σ Abgrenzungen TP/RB (NICHT Teil der Differenz — informativ). */
  abgrenzungenSumme: number;
  /** Σ Betrags-/Pfand-Reste (Teil der Differenz). */
  pfandRestSumme: number;
  /** Gruppen in fester Reihenfolge: luecke, umbuchung, pfand_rest — leere Gruppen fehlen. */
  gruppen: DiffGruppe[];
  /** true = Journal-Modus (vollständige Zerlegung); false = degradiert (nur Umbuchungen bekannt). */
  vollstaendig: boolean;
}

const rp = (n: number) => Math.round(n * 100) / 100;

export function buildDiffAufschluesselung(input: {
  abgleich: WarenAbgleich;
  /** Erfasste Rechnungen des Monats (gleiche Menge wie im Abgleich). */
  invoices: InvoiceEntry[];
  /** Resolver aus den EFFEKTIVEN Alias-Gruppen des Abgleichs. */
  resolve: (name: string) => string;
  /** Match-Gruppen des Monats-Blobs (waren_fibu_matches_<YYYY-MM>_v1). */
  gruppen: FibuMatchGruppe[];
  warenkostenGrenze?: number;
}): DiffAufschluesselung {
  const { abgleich } = input;
  const zeilen: DiffAufZeile[] = [];

  // ── Interne Umbuchungen (beide Modi bekannt) ──
  for (const b of abgleich.interneUmbuchungen) {
    zeilen.push({
      kategorie: 'umbuchung',
      konto: b.accountNumber ? String(b.accountNumber) : null,
      lieferant: null,
      beleg: b.belegNr ?? null,
      datum: b.date ?? null,
      label: buchungAnzeigeText(b) || 'Umbuchung',
      betrag: rp(buchungsBetrag(b)),
    });
  }

  // ── Abgrenzungen TP/RB (beide Modi bekannt) — wie Umbuchungen NICHT Teil
  // der Differenz, rein informativ (transitorische Posten, keine Rechnungen). ──
  for (const b of abgleich.abgrenzungen) {
    zeilen.push({
      kategorie: 'abgrenzung',
      konto: b.accountNumber ? String(b.accountNumber) : null,
      lieferant: null,
      beleg: b.belegNr ?? null,
      datum: b.date ?? null,
      label: buchungAnzeigeText(b) || 'Abgrenzung',
      betrag: rp(buchungsBetrag(b)),
    });
  }

  if (abgleich.mode === 'lieferanten') {
    // ── Exakte Zerlegung je Lieferant (gleiche Logik wie das Zeilen-Drilldown) ──
    for (const z of abgleich.zeilen) {
      const inv = input.invoices.filter(e => input.resolve(e.supplierName) === z.lieferant);
      const { posten } = zerlegeLieferantDifferenz(
        inv, z.buchungen, buchungKeysMitIndex(z.buchungen), input.gruppen, input.warenkostenGrenze,
      );
      for (const p of posten) {
        zeilen.push({
          kategorie: p.typ === 'nur_erfasst' || p.typ === 'nur_fibu' ? 'luecke' : 'pfand_rest',
          konto: p.konto ?? null,
          lieferant: z.lieferant,
          beleg: p.beleg ?? null,
          datum: p.datum ?? null,
          label: p.label,
          betrag: p.betrag,
        });
      }
    }
    // ── Buchungen ohne Lieferanten-Zuordnung = ebenfalls echte Lücken ──
    for (const b of abgleich.nichtZugeordnet) {
      zeilen.push({
        kategorie: 'luecke',
        konto: b.accountNumber ? String(b.accountNumber) : null,
        lieferant: null,
        beleg: b.belegNr ?? null,
        datum: b.date ?? null,
        label: `Ohne Zuordnung: ${buchungAnzeigeText(b) || 'Buchung'}`,
        betrag: rp(buchungsBetrag(b)),
      });
    }
  }

  const sumOf = (k: DiffKategorie) => rp(zeilen.filter(z => z.kategorie === k).reduce((a, z) => a + z.betrag, 0));
  const gruppen: DiffGruppe[] = (['luecke', 'umbuchung', 'abgrenzung', 'pfand_rest'] as const)
    .map(k => ({
      kategorie: k,
      zeilen: zeilen.filter(z => z.kategorie === k)
        .sort((a, b) => Math.abs(b.betrag) - Math.abs(a.betrag)),
      summe: sumOf(k),
    }))
    .filter(g => g.zeilen.length > 0); // leer statt 0 — leere Gruppen erscheinen nicht

  return {
    diffTotal: abgleich.diffTotal,
    lueckenSumme: sumOf('luecke'),
    umbuchungenSumme: sumOf('umbuchung'),
    abgrenzungenSumme: sumOf('abgrenzung'),
    pfandRestSumme: sumOf('pfand_rest'),
    gruppen,
    vollstaendig: abgleich.mode === 'lieferanten',
  };
}
